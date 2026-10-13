import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {fixture} from './support.mjs';
import {snapshot,guardFiles} from '../scripts/artifact.mjs';

// artifact.mjs가 부르는 execFileSync를 감싸 git 하위 명령을 센다. Windows에서는 git 호출 하나가 25~32ms라 개수가 곧 시간이다.
function countGit(t) {
 const original=cp.execFileSync;const seen=[];
 cp.execFileSync=function(file,args,...rest){
  if(file==='git'&&Array.isArray(args)){
   const at=args.findIndex((a,i)=>!a.startsWith('-')&&args[i-1]!=='-c'&&args[i-1]!=='-C');
   seen.push([args[at],...args.slice(at+1).filter(a=>a.startsWith('--')||a==='HEAD')].join(' '));
  }
  return original.call(this,file,args,...rest);
 };
 syncBuiltinESMExports();
 t.after(()=>{cp.execFileSync=original;syncBuiltinESMExports();});
 return seen;
}

test('a snapshot asks git for HEAD and the common git folder in one rev-parse',t=>{
 const f=fixture(t,{initialize:false});
 snapshot(f.root); // 저장소 설정 조회(git config)는 처음 한 번만 뜨고 기억된다. 따로 세지 않으려고 먼저 한 번 부른다.
 const seen=countGit(t);
 snapshot(f.root);
 const revParse=seen.filter(s=>s.startsWith('rev-parse'));
 assert.equal(revParse.length,1,`rev-parse ran ${revParse.length} times: ${JSON.stringify(seen)}`);
 assert.match(revParse[0],/HEAD/);assert.match(revParse[0],/--git-common-dir/);
 assert.equal(seen.length,5,`a snapshot is five git calls (ls-files x3, rev-parse, status): ${JSON.stringify(seen)}`);
});

test('the combined lookup does not change what a snapshot records',t=>{
 const f=fixture(t,{initialize:false});
 const a=snapshot(f.root);
 // 따로 구하던 방식과 같은 결과: 같은 head, 같은 보호 파일 항목.
 assert.equal(a.head,f.git('rev-parse','HEAD').toString().trim());
 const separate=guardFiles(f.root);
 for(const key of Object.keys(separate))assert.deepEqual(a.files[key],separate[key],key);
 assert.ok(Object.keys(a.files).some(k=>k.startsWith('.git/')),'git control files are still watched');
 assert.equal(snapshot(f.root).digest,a.digest,'stable across calls');
 // 보호 파일이 바뀌면 여전히 다른 digest다.
 f.git('config','branch.main.remote','origin');
 assert.notEqual(snapshot(f.root).digest,a.digest);
});

test('a linked worktree still watches the shared git folder',t=>{
 const f=fixture(t,{initialize:false});
 const wt=path.join(f.temp,'linked');
 f.git('worktree','add','-q',wt,'-b','linked');
 const snap=snapshot(wt);
 assert.ok(snap.files['.git/config'],'the shared config is watched from a linked worktree');
 assert.equal(snap.head,f.git('rev-parse','HEAD').toString().trim());
});

test('a repository without commits fails the same way as before',t=>{
 const f=fixture(t,{initialize:false});
 const empty=path.join(f.temp,'empty');fs.mkdirSync(empty);
 cp.execFileSync('git',['init','-q'],{cwd:empty});
 assert.throws(()=>snapshot(empty),/HEAD/);
});
