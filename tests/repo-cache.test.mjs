import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {fixture} from './support.mjs';
import {repo} from '../scripts/artifact.mjs';

// artifact.mjs가 부르는 execFileSync를 감싸 `rev-parse --show-toplevel` 횟수를 센다.
function countTopLevel(t) {
 const original=cp.execFileSync;let n=0;
 cp.execFileSync=function(file,args,...rest){if(file==='git'&&Array.isArray(args)&&args.includes('--show-toplevel'))n++;return original.call(this,file,args,...rest);};
 syncBuiltinESMExports();
 t.after(()=>{cp.execFileSync=original;syncBuiltinESMExports();});
 return ()=>n;
}

test('repo() asks git once per repository, then answers from the .git fingerprint',t=>{
 const f=fixture(t,{initialize:false});
 const calls=countTopLevel(t);
 const first=repo(f.root);
 assert.equal(calls(),1);
 for(let i=0;i<5;i++)assert.equal(repo(f.root),first);
 assert.equal(calls(),1,'five more checks spawned nothing');
 // git이 .git 안을 쓰면(디렉터리 mtime이 바뀌어도) 지문이 그대로라 다시 묻지 않는다.
 f.git('status');fs.writeFileSync(path.join(f.root,'b.txt'),'x');f.git('add','b.txt');
 assert.equal(repo(f.root),first);assert.equal(calls(),1);
});

test('repo() asks git again when .git is removed or replaced, and still refuses a subfolder',t=>{
 const f=fixture(t,{initialize:false});
 const calls=countTopLevel(t);
 repo(f.root);assert.equal(calls(),1);
 const sub=path.join(f.root,'sub');fs.mkdirSync(sub);
 assert.throws(()=>repo(sub),/Use repository root/);
 assert.throws(()=>repo(sub),/Use repository root/,'a refusal is never remembered');
 // .git이 사라지면 기억을 쓰지 않고 git에 묻는다. 위쪽에 저장소가 없으니 실패한다.
 fs.rmSync(path.join(f.root,'.git'),{recursive:true,force:true});
 const before=calls();
 assert.throws(()=>repo(f.root));
 assert.equal(calls(),before+1,'the missing .git was not answered from memory');
 // .git을 파일(gitdir 포인터)로 바꿔치면 종류가 달라 다시 묻는다.
 fs.writeFileSync(path.join(f.root,'.git'),'gitdir: /nonexistent\n');
 const again=calls();
 assert.throws(()=>repo(f.root));
 assert.equal(calls(),again+1);
});

test('a path that does not exist fails as before and is not cached',t=>{
 const f=fixture(t,{initialize:false});
 assert.throws(()=>repo(path.join(f.temp,'missing')));
});
