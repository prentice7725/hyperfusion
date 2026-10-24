import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {fixture} from './support.mjs';
import {git,snapshot,guardFiles} from '../scripts/artifact.mjs';

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
 snapshot(f.root);
 const seen=countGit(t);
 snapshot(f.root);
 const revParse=seen.filter(s=>s.startsWith('rev-parse'));
 assert.equal(revParse.length,1,`rev-parse ran ${revParse.length} times: ${JSON.stringify(seen)}`);
 assert.match(revParse[0],/HEAD/);assert.match(revParse[0],/--git-common-dir/);assert.match(revParse[0],/--git-dir/);
 const lookups=seen.filter(s=>s.startsWith('config'));
 assert.equal(lookups.length,1,'a snapshot reads the effective config once for its own Git calls');
 assert.equal(seen.length-lookups.length,5,`snapshot keeps five operational calls: ${JSON.stringify(seen)}`);
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

// 설정은 snapshot 안에서만 같이 쓰고 끝나면 버린다. 중간에 실패해도 남기지 않는다.
test('Git calls outside a snapshot read the configuration again, also after a snapshot failed part way',t=>{
 const f=fixture(t,{initialize:false});
 const seen=countGit(t),reads=()=>seen.filter(s=>s.startsWith('config')).length;
 snapshot(f.root);
 git(f.root,['status','--porcelain']);
 assert.equal(reads(),2,JSON.stringify(seen));
 const original=cp.execFileSync;
 cp.execFileSync=function(file,args,...rest){if(file==='git'&&args.includes('--stage'))throw Error('injected git failure');return original.call(this,file,args,...rest);};
 syncBuiltinESMExports();
 try{assert.throws(()=>snapshot(f.root),/injected git failure/);}finally{cp.execFileSync=original;syncBuiltinESMExports();}
 const before=reads();
 git(f.root,['status','--porcelain']);
 assert.equal(reads(),before+1,'the failed snapshot left no configuration behind');
});

// 같은 동작 안에서 방금 찍은 스냅샷을 수용 명령의 '실행 전'으로 다시 쓴다. 그 사이에는 컨트롤러 코드만 돈다.
import {run} from '../scripts/fusion-state.mjs';
import {execute} from '../scripts/executor-bridge.mjs';
test('init and finish reuse their own snapshot as the tree before the acceptance commands',async t=>{
 const f=fixture(t,{initialize:false});
 const seen=countGit(t),snapshots=()=>seen.filter(s=>s.startsWith('status')).length;
 const acceptance={acceptance_commands:['node -e "process.exit(1)"']};
 run(f.root,'init',{...f.brief,executor:'grok',...acceptance});
 assert.equal(snapshots(),2,'init: the base snapshot, then the tree after the baseline run');
 f.mode('edit');f.begin(acceptance);await execute(f.root);
 const before=snapshots();
 const s=run(f.root,'finish',{token:f.state().writer.token,quiescent:true});
 assert.ok(s.acceptance?.file,JSON.stringify(s.last_errors));
 assert.equal(snapshots()-before,2,'finish: the post snapshot, then the tree after the acceptance run');
});
