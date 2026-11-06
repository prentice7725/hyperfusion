// 외부 보안 검토(a3ae104 기준)에서 재현된 세 문제의 회귀 시험.
// 1. 보호 파일 읽기의 정션·심볼릭 링크 탈출  2. 루트의 `__proto__` 파일이 변경 감지를 빠져나감  3. task_id 형식 검사
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {snapshot,changes,hash} from '../scripts/artifact.mjs';
import {ignoredManifest,ignoredChanges} from '../scripts/acceptance.mjs';
import {checkPreserve,acceptanceTestsContext,repoFile} from '../scripts/preserve.mjs';
import * as contract from '../scripts/contracts.mjs';

const tmp=(t,name)=>{const d=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),`hf-sec-${name}-`)));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;};
const gitRepo=t=>{
 const root=tmp(t,'repo');
 const git=(...a)=>execFileSync('git',['-C',root,'-c','user.name=t','-c','user.email=t@example.invalid','-c','commit.gpgsign=false',...a],{encoding:'utf8',windowsHide:true});
 git('init','-q');git('config','core.autocrlf','false');
 fs.writeFileSync(path.join(root,'control.txt'),'v1');
 return {root,git};
};
// Windows는 관리자 권한 없이 만들 수 있는 정션을, POSIX는 디렉터리 심볼릭 링크를 쓴다.
const linkDir=(target,at)=>fs.symlinkSync(target,at,process.platform==='win32'?'junction':'dir');

test('protected tests reached through a junction or symlinked folder are never read from outside the repository',t=>{
 const {root,git}=gitRepo(t),outside=tmp(t,'outside');
 const SECRET='OUTSIDE-SECRET-'+Date.now();
 fs.mkdirSync(path.join(root,'tests'));fs.writeFileSync(path.join(root,'tests/a.test.mjs'),'inside');
 fs.mkdirSync(path.join(root,'src'));fs.writeFileSync(path.join(root,'src/x.mjs'),'x');
 git('add','.');git('commit','-qm','init');
 const brief={verification:{kind:'preserve',protect:['tests/**']},scope:{paths:['src']},acceptance_commands:['node tests/a.test.mjs']};
 // 대조: 정상 저장소에서는 내용을 읽고 검사도 통과한다.
 assert.doesNotThrow(()=>checkPreserve(root,brief));
 assert.equal(acceptanceTestsContext(root,brief).files[0].content,'inside');
 // tests 폴더를 저장소 밖 폴더로 가는 링크로 바꾼다. Git 색인에는 tests/a.test.mjs가 그대로 남아 있다.
 fs.writeFileSync(path.join(outside,'a.test.mjs'),SECRET);
 fs.rmSync(path.join(root,'tests'),{recursive:true});
 linkDir(outside,path.join(root,'tests'));
 assert.equal(fs.readFileSync(path.join(root,'tests/a.test.mjs'),'utf8'),SECRET,'fixture: the link really leads outside');
 assert.deepEqual(repoFile(root,'tests/a.test.mjs'),{ok:false,reason:'outside_repository'});
 const ctx=acceptanceTestsContext(root,brief);
 assert.ok(!JSON.stringify(ctx).includes(SECRET),'outside content must not reach acceptance_tests');
 assert.deepEqual(ctx.files,[{path:'tests/a.test.mjs',unreadable:true,reason:'outside_repository'}]);
 assert.throws(()=>checkPreserve(root,brief),/not a regular file inside the repository.*tests\/a\.test\.mjs: outside_repository/);
});

test('a symlinked protected file that leads outside the repository is refused as well',t=>{
 const {root,git}=gitRepo(t),outside=tmp(t,'outside');
 fs.mkdirSync(path.join(root,'tests'));fs.writeFileSync(path.join(root,'tests/a.test.mjs'),'inside');
 git('add','.');git('commit','-qm','init');
 fs.writeFileSync(path.join(outside,'secret.txt'),'OUTSIDE');
 fs.rmSync(path.join(root,'tests/a.test.mjs'));
 try{fs.symlinkSync(path.join(outside,'secret.txt'),path.join(root,'tests/a.test.mjs'),'file');}
 catch(e){if(e.code==='EPERM'){t.skip('file symlinks need Developer Mode or admin on Windows');return;}throw e;}
 assert.equal(repoFile(root,'tests/a.test.mjs').ok,false);
 const ctx=acceptanceTestsContext(root,{verification:{kind:'preserve',protect:['tests/**']},acceptance_commands:['x']});
 assert.ok(!JSON.stringify(ctx).includes('OUTSIDE'));
});

test('a content change to a root file named __proto__ is detected, tracked or not',t=>{
 const {root,git}=gitRepo(t);
 git('add','.');git('commit','-qm','init');
 fs.writeFileSync(path.join(root,'__proto__'),'one');
 const a=snapshot(root);
 assert.ok(Object.hasOwn(a.files,'__proto__'),'__proto__ is an own key of the snapshot');
 fs.writeFileSync(path.join(root,'__proto__'),'two');
 const b=snapshot(root);
 assert.deepEqual(changes(a,b),['__proto__']);
 assert.notEqual(a.digest,b.digest);
 // 제어 파일(.fusion)에 저장했다가 다시 읽은 스냅샷끼리도 같다.
 const saved=x=>JSON.parse(JSON.stringify(x));
 assert.deepEqual(changes(saved(a),saved(b)),['__proto__']);
 // 저장된 스냅샷에 __proto__가 없으면 Object.prototype이 아니라 "없음"으로 본다.
 fs.rmSync(path.join(root,'__proto__'));
 const c=snapshot(root),d=snapshot(root);
 assert.deepEqual(changes(saved(c),saved(d)),[]);
 assert.deepEqual(changes(saved(b),saved(c)),['__proto__']);
 // 대조: 일반 파일의 변경도 그대로 잡힌다.
 fs.writeFileSync(path.join(root,'control.txt'),'v2');
 assert.deepEqual(changes(d,snapshot(root)),['control.txt']);
});

test('the snapshot digest of ordinary names is unchanged by the prototype-free map',t=>{
 const {root,git}=gitRepo(t);
 fs.writeFileSync(path.join(root,'b.txt'),'b');
 git('add','.');git('commit','-qm','init');
 const s=snapshot(root),plain={...s.files};
 assert.equal(JSON.stringify(s.files),JSON.stringify(plain));
 assert.equal(s.digest,hash(JSON.stringify({head:s.head,status:s.status,index_hash:s.index_hash,files:plain})));
});

test('a change to a gitignored root file named __proto__ is detected',t=>{
 const {root,git}=gitRepo(t);
 fs.writeFileSync(path.join(root,'.gitignore'),'__proto__\ncontrol.dat\n');
 git('add','.');git('commit','-qm','init');
 fs.writeFileSync(path.join(root,'__proto__'),'one');fs.writeFileSync(path.join(root,'control.dat'),'one');
 const a=ignoredManifest(root);
 assert.ok(Object.hasOwn(a.files,'__proto__'));
 fs.writeFileSync(path.join(root,'__proto__'),'changed content');
 assert.deepEqual(ignoredChanges(a,ignoredManifest(root)),['__proto__']);
 const saved=x=>JSON.parse(JSON.stringify(x));
 assert.deepEqual(ignoredChanges(saved(a),saved(ignoredManifest(root))),['__proto__']);
 // 대조
 const b=ignoredManifest(root);
 fs.writeFileSync(path.join(root,'control.dat'),'changed content');
 assert.deepEqual(ignoredChanges(b,ignoredManifest(root)),['control.dat']);
});

test('task_id must be a string before its format is checked',()=>{
 const ok={task_id:'task-1',objective:'o',scope:{paths:['a.txt']},constraints:[],success_criteria:['c'],allowed_actions:['edit']};
 assert.doesNotThrow(()=>contract.brief(ok));
 const {task_id:_,...missing}=ok;
 assert.throws(()=>contract.brief(missing),/Invalid task_id/,'missing');
 for(const task_id of [null,42,['task']])assert.throws(()=>contract.brief({...ok,task_id}),/Invalid task_id/,JSON.stringify(task_id));
});
