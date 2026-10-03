import path from 'node:path';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import {isMain} from './platform.mjs';
import {read,immutable,repo} from './artifact.mjs';
import {assertLease} from './writer-lease.mjs';
import {result as validateResult} from './contracts.mjs';
import {adapter} from './adapters/index.mjs';
import {isWin,killTree} from './platform.mjs';

// 리드가 넘긴 dispatch 한 건을 정확히 한 번 실행하고 결과를 검증해 남긴다.
export async function execute(root,{timeoutMs,maxBytes=8*1024*1024}={}) {
 root=repo(root);
 const state=read(path.join(root,'.fusion/state.json'));
 // 일꾼별 timeout_ms 설정이 있으면 그 값, 없으면 20분.
 timeoutMs??=state.configuration?.executors?.[state.owner]?.timeout_ms??1200000;
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1)throw Error('Invalid timeout');
 if(state.phase!=='EXECUTING'||!['grok','antigravity','sonnet'].includes(state.owner))throw Error('No active executor round');
 const dir=path.join(root,'.fusion/tasks',state.task_id),n=state.iteration;
 const request=read(path.join(dir,`dispatch-${n}.json`));
 const lease=assertLease(root,request.token);
 if(lease.owner!==state.owner||request.executor!==state.owner||lease.task_id!==state.task_id||lease.round!==n||request.task_id!==state.task_id||request.round!==n)throw Error('Executor writer provenance mismatch');
 const a=adapter(request.executor);
 // create-once 실행 표식이 크래시나 재실행에서도 중복 프로세스를 막는다.
 immutable(path.join(dir,`launch-${n}.json`),{executor:request.executor,bridge_pid:process.pid,session_id:request.cli.session_id,at:new Date().toISOString()});
 if(request.cli.prompt_file){fs.writeFileSync(request.cli.prompt_file,request.prompt,{flag:'wx',mode:0o600});}
 let stdout='',stderr='',reason=null,child,killTimer,timer,forceResolve,alive=false;
 const stop=why=>{if(reason)return;reason=why;killTree(child,{alive});killTimer=setTimeout(()=>{killTree(child,{force:true,alive});child?.stdout.destroy();child?.stderr.destroy();child?.stdin?.destroy();forceResolve?.({code:null,signal:'SUPERVISOR_ABORT'});},2000);};
 const onTerm=()=>stop('bridge interrupted');
 process.on('SIGTERM',onTerm);process.on('SIGINT',onTerm);
 let exit;
 try {
  exit=await new Promise(resolve=>{
   forceResolve=resolve;
   // Windows에는 프로세스 그룹이 없어 detached를 쓰지 않고(새 콘솔이 뜬다) taskkill /T로 트리를 정리한다.
   child=spawn(request.cli.executable,[...(request.cli.prefix_args??[]),...request.cli.args],{cwd:root,stdio:[request.stdin===undefined?'ignore':'pipe','pipe','pipe'],shell:false,detached:!isWin,windowsHide:true});
   alive=!!child.pid;child.on('exit',()=>{alive=false;});
   if(child.pid)immutable(path.join(dir,`process-${n}.json`),{executor:request.executor,pid:child.pid,process_group:isWin?null:child.pid,tree_kill:isWin?'taskkill /T /F':'process group',platform:process.platform,session_id:request.cli.session_id});
   child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
   child.on('error',e=>{reason='Executor spawn failed: '+e.message;});
   child.stdout.on('data',chunk=>{if(Buffer.byteLength(stdout)+Buffer.byteLength(chunk)>maxBytes)stop('Executor stdout limit exceeded');else stdout+=chunk;});
   child.stderr.on('data',chunk=>{if(Buffer.byteLength(stderr)+Buffer.byteLength(chunk)>maxBytes)stop('Executor stderr limit exceeded');else stderr+=chunk;});
   timer=setTimeout(()=>stop('Executor timeout'),timeoutMs);
   child.on('close',(code,signal)=>resolve({code,signal}));
   // 프롬프트를 stdin으로 받는 일꾼(Sonnet)만 파이프를 연다.
   if(request.stdin!==undefined){child.stdin.on('error',e=>{if(e.code!=='EPIPE')stop('Executor stdin failed: '+e.message);});child.stdin.end(request.stdin);}
  });
 } finally {
  clearTimeout(timer);clearTimeout(killTimer);process.off('SIGTERM',onTerm);process.off('SIGINT',onTerm);
  // 잔존 자식을 정리한다. POSIX는 그룹 전체, Windows는 일꾼이 살아 있을 때만 트리 종료.
  // 그룹 밖으로 빠져나간 자손(Windows에서는 일꾼이 먼저 끝난 뒤 남은 자손)은 리드가 확인해야 한다.
  killTree(child,{force:true,alive});
 }
 immutable(path.join(dir,`envelope-${n}.json`),{executor:request.executor,exit,reason,stdout,stderr});
 if(reason||exit.code!==0)throw Error(reason||request.executor+' exited with code '+exit.code);
 const parsed=a.parse(stdout,request);
 // Windows 일꾼은 경로를 역슬래시로 보고하기도 한다. 저장소 경로 표기(슬래시)로 맞춘 뒤 검증한다.
 for(const k of ['files_read','files_changed'])if(Array.isArray(parsed.result?.[k]))parsed.result[k]=parsed.result[k].map(p=>typeof p==='string'?p.replaceAll('\\','/'):p);
 const result=validateResult(parsed.result,request.task_id,request.round);
 immutable(path.join(dir,`session-${n}.json`),{executor:request.executor,session_id:parsed.session_id});
 immutable(path.join(dir,`usage-${n}.json`),{executor:request.executor,session_id:parsed.session_id,...parsed.usage,cost_basis:'executor client-side report, not billed cost'});
 immutable(path.join(dir,`result-${n}.json`),result);
 // 여기서 lease를 놓지 않는다. 리드가 정지 여부를 확인하고 finish 해야 한다.
 return {status:'RESULT_READY',executor:request.executor,task_id:state.task_id,round:n,result_file:path.join(dir,`result-${n}.json`),next_action:'confirm quiescence, then fusion-state finish with writer token and result'};
}
if(isMain(import.meta.url)) {
 try{console.log(JSON.stringify(await execute(process.argv[2]),null,2));}catch(e){console.error(e.message);process.exitCode=1;}
}
