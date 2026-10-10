import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import {isMain,isWin,killTree,assertCommandLine} from './platform.mjs';
import {read,immutable,repo} from './artifact.mjs';
import {assertLease} from './writer-lease.mjs';
import {result as validateResult,consultResult} from './contracts.mjs';
import {adapter} from './adapters/index.mjs';
import {notify} from './notify.mjs';
import {executionAllowed} from './review-plan.mjs';
import {controlPath,ensureControl} from './control-dir.mjs';
import {workerEnv} from './worker-env.mjs';
import {verifyExecute,verifyConsult} from './dispatch-verify.mjs';
import {assertBudget} from './budgets.mjs';
import {printError} from './cli.mjs';
import {maskTransport} from './redaction.mjs';
import {watchProcessTree} from './process-proof.mjs';
import {openMonitor} from './worker-monitor.mjs';

const timeoutFor=(root,state,executor,override)=>{
 // 일꾼별 timeout_ms 설정이 있으면 그 값, 없으면 20분.
 const t=override??state.configuration?.executors?.[executor]?.timeout_ms??1200000;
 if(!Number.isSafeInteger(t)||t<1)throw Error('Invalid timeout');
 const budget=assertBudget(root,state);
 return budget.remaining_wall_ms===null?t:Math.min(t,budget.remaining_wall_ms);
};

// 일꾼 프로세스 하나를 감독하며 실행한다. tag는 산출물 이름(launch-<tag>.json 등)에 붙는다.
async function supervise(root,dir,tag,request,{timeoutMs,maxBytes,proveQuiescence=false,signal,monitorQuietMs=120000,monitorIntervalMs=1000}) {
 if(!Number.isSafeInteger(monitorQuietMs)||monitorQuietMs<1||!Number.isSafeInteger(monitorIntervalMs)||monitorIntervalMs<1)throw Error('Invalid monitor interval');
 const started=Date.now();
 if(signal?.aborted)throw Object.assign(Error('Bridge interrupted before launch'),{code:'AUTOPILOT_INTERRUPTED'});
 const masked=maskTransport(request);
 request=masked.request;
 assertCommandLine(request.cli.executable,[...(request.cli.prefix_args??[]),...request.cli.args]);
 immutable(path.join(dir,`redaction-${tag}.json`),masked.audit);
 const role=['implement','review','consult'].includes(request.role)?request.role:'implement';
 const round=Number.isSafeInteger(request.round)?request.round:0;
 let activity=null;
 try{
  activity=openMonitor({dir,tag:String(tag),quietMs:monitorQuietMs,identity:{task_id:String(request.task_id??''),round,run_id:crypto.randomUUID(),executor:String(request.executor??''),role}});
 }catch{activity=null;}
 // 감시 기록 실패가 라운드의 성공·실패나 lease 처리를 바꾸면 안 된다.
 const guard=fn=>{try{if(activity)fn();}catch{/* observation only */}};
 const monitor=proveQuiescence?watchProcessTree():null;
 // create-once 실행 표식이 크래시나 재실행에서도 중복 프로세스를 막는다.
 immutable(path.join(dir,`launch-${tag}.json`),{executor:request.executor,bridge_pid:process.pid,session_id:request.cli.session_id,at:new Date().toISOString()});
 if(request.cli.prompt_file)fs.writeFileSync(request.cli.prompt_file,request.prompt,{flag:'wx',mode:0o600});
 // 스키마처럼 CLI가 파일 경로로 받는 입력. 컨트롤러가 정한 경로에 한 번만 쓴다.
 for(const f of request.cli.extra_files??[])fs.writeFileSync(f.path,f.content,{flag:'wx',mode:0o600});
 let stdout='',stderr='',reason=null,child,killTimer,timer,activityTimer,forceResolve,alive=false,exited=false;
 const stop=(why,kind='timeout')=>{
  if(reason)return;
  reason=why;
  if(kind==='interrupted')guard(()=>activity.interrupt(why));
  else guard(()=>activity.timeout(why));
  killTree(child,{alive});
  killTimer=setTimeout(()=>{killTree(child,{force:true,alive});child?.stdout.destroy();child?.stderr.destroy();child?.stdin?.destroy();forceResolve?.({code:null,signal:'SUPERVISOR_ABORT'});},2000);
 };
 const onTerm=()=>stop('bridge interrupted','interrupted');
 process.on('SIGTERM',onTerm);process.on('SIGINT',onTerm);
 signal?.addEventListener('abort',onTerm);
 let exit;
 try {
  exit=await new Promise(resolve=>{
   forceResolve=resolve;
   // Windows에는 프로세스 그룹이 없어 detached를 쓰지 않고(새 콘솔이 뜬다) taskkill /T로 트리를 정리한다.
   child=spawn(request.cli.executable,[...(request.cli.prefix_args??[]),...request.cli.args],{cwd:root,stdio:[request.stdin===undefined?'ignore':'pipe','pipe','pipe'],shell:false,env:workerEnv(request.executor),detached:!isWin,windowsHide:true});
   alive=!!child.pid;child.on('exit',()=>{alive=false;exited=true;});
   if(child.pid)monitor?.start(child.pid);
   if(child.pid)guard(()=>activity.started());
   if(child.pid)activityTimer=setInterval(()=>guard(()=>activity.tick()),monitorIntervalMs);
   if(child.pid)immutable(path.join(dir,`process-${tag}.json`),{executor:request.executor,pid:child.pid,process_group:isWin?null:child.pid,tree_kill:isWin?'taskkill /T /F':'process group',platform:process.platform,session_id:request.cli.session_id});
   child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
   child.on('error',e=>{reason='Executor spawn failed: '+e.message;});
   child.stdout.on('data',chunk=>{if(Buffer.byteLength(stdout)+Buffer.byteLength(chunk)>maxBytes)stop('Executor stdout limit exceeded');else{stdout+=chunk;guard(()=>activity.output('stdout',chunk));}});
   child.stderr.on('data',chunk=>{if(Buffer.byteLength(stderr)+Buffer.byteLength(chunk)>maxBytes)stop('Executor stderr limit exceeded');else{stderr+=chunk;guard(()=>activity.output('stderr',chunk));}});
   timer=setTimeout(()=>stop('Executor timeout'),timeoutMs);
   child.on('close',(code,signal)=>resolve({code,signal}));
   // 프롬프트를 stdin으로 받는 일꾼(Sonnet)만 파이프를 연다.
   if(request.stdin!==undefined){child.stdin.on('error',e=>{if(e.code!=='EPIPE')stop('Executor stdin failed: '+e.message);});child.stdin.end(request.stdin);}
  });
 } finally {
  clearTimeout(timer);clearTimeout(killTimer);clearInterval(activityTimer);process.off('SIGTERM',onTerm);process.off('SIGINT',onTerm);
  signal?.removeEventListener('abort',onTerm);
  // 잔존 자식을 정리한다. POSIX는 그룹 전체, Windows는 일꾼이 살아 있을 때만 트리 종료.
  // 그룹 밖으로 빠져나간 자손(Windows에서는 일꾼이 먼저 끝난 뒤 남은 자손)은 리드가 확인해야 한다.
  killTree(child,{force:true,alive});
 }
 const proof=monitor?await monitor.finish({exited,aborted:exit.signal==='SUPERVISOR_ABORT'}):null;
 if(proof)immutable(path.join(dir,`quiescence-${tag}.json`),{...proof,executor:request.executor});
 let observation=null;
 guard(()=>{observation=activity.exit({code:exit?.code??null,signal:exit?.signal??''});});
 const seen=observation??{run_id:null,state:'UNKNOWN',telemetry_limited:true};
 immutable(path.join(dir,`envelope-${tag}.json`),{executor:request.executor,exit,reason,stdout,stderr,started_at:new Date(started).toISOString(),ended_at:new Date().toISOString(),wall_ms:Date.now()-started,observation:{run_id:seen.run_id??null,state:seen.state??'UNKNOWN',telemetry_limited:seen.telemetry_limited===true,declares_success:false}});
 const fail=e=>{e.quiescence=proof;throw e;};
 if(reason||exit.code!==0)fail(Error(reason||request.executor+' exited with code '+exit.code));
 let parsed;
 try{parsed=adapter(request.executor).parse(stdout,request);}catch(e){fail(e);}
 // Windows 일꾼은 경로를 역슬래시로 보고하기도 한다. 저장소 경로 표기(슬래시)로 맞춘 뒤 검증한다.
 // 역슬래시와 앞의 './'를 걷어 내 저장소 경로 표기로 맞춘다.
 const slash=p=>typeof p==='string'?p.replaceAll('\\','/').replace(/^(\.\/)+/,''):p;
 for(const k of ['files_read','files_changed'])if(Array.isArray(parsed.result?.[k]))parsed.result[k]=parsed.result[k].map(slash);
 if(Array.isArray(parsed.result?.findings))for(const f of parsed.result.findings)if(f)f.file=slash(f.file);
 immutable(path.join(dir,`usage-${tag}.json`),{executor:request.executor,session_id:parsed.session_id,role,round,run_id:seen.run_id,model:request.cli.model??null,started_at:new Date(started).toISOString(),wall_ms:Date.now()-started,...parsed.usage,cost_basis:'executor client-side report, not billed cost'});
 return {...parsed,quiescence:proof};
}

// 리드가 넘긴 구현 라운드 dispatch 한 건을 정확히 한 번 실행하고 결과를 검증해 남긴다.
export async function execute(root,{timeoutMs,maxBytes=8*1024*1024,proveQuiescence=false,signal,monitorQuietMs,monitorIntervalMs}={}) {
 root=repo(root);
 ensureControl(root);
 const state=read(controlPath(root,'state.json'));
 if(!executionAllowed(state))throw Error('No active executor round');
 timeoutMs=timeoutFor(root,state,state.owner,timeoutMs);
 const dir=controlPath(root,'tasks',state.task_id),n=state.iteration;
 const request=read(path.join(dir,`dispatch-${n}.json`));
 const lease=assertLease(root,request.token);
 if(lease.owner!==state.owner||request.executor!==state.owner||lease.task_id!==state.task_id||lease.round!==n||request.task_id!==state.task_id||request.round!==n)throw Error('Executor writer provenance mismatch');
 let result,parsed;
 try{
  // 파일이 아니라 컨트롤러가 다시 만든 요청으로 실행한다. 달라졌으면 여기서 멈춘다.
  const verified=verifyExecute(root,state,dir,request,lease);
  parsed=await supervise(root,dir,n,{...request,...verified,role:'implement',round:n,task_id:state.task_id,executor:state.owner},{timeoutMs:timeoutFor(root,state,state.owner,timeoutMs),maxBytes,proveQuiescence,signal,monitorQuietMs,monitorIntervalMs});
  result=validateResult(parsed.result,request.task_id,request.round);
 }catch(e){
  await notify(`HyperFusion ${state.task_id}`,`${request.executor} round ${n} failed`,{priority:'high'});
  throw e;
 }
 immutable(path.join(dir,`session-${n}.json`),{executor:request.executor,session_id:parsed.session_id});
 immutable(path.join(dir,`result-${n}.json`),result);
 await notify(`HyperFusion ${state.task_id}`,`${request.executor} round ${n} done (${result.status})`);
 // 여기서 lease를 놓지 않는다. 리드가 정지 여부를 확인하고 finish 해야 한다.
 return {status:'RESULT_READY',executor:request.executor,task_id:state.task_id,round:n,result_file:path.join(dir,`result-${n}.json`),quiescence:parsed.quiescence,next_action:'confirm quiescence, then fusion-state finish with writer token; result is read automatically'};
}

// 상담(advisor/committee) 한 건의 위원을 병렬로 실행한다. writer lease 없이 읽기 전용으로 돈다.
export async function consult(root,id,{timeoutMs,maxBytes=8*1024*1024,proveQuiescence=false,signal}={}) {
 root=repo(root);
 ensureControl(root);
 const state=read(controlPath(root,'state.json'));
 const open=state.open_consult;
 if(!open||open.id!==id)throw Error('No open consult '+id);
 const dir=controlPath(root,'tasks',state.task_id);
 const runs=await Promise.allSettled(open.members.map(async m=>{
  const sent=read(path.join(dir,`consult-${id}-${m.member}.json`));
  const request={...sent,...verifyConsult(root,state,dir,sent,{id,member:m.member,executor:m.executor})};
  const parsed=await supervise(root,dir,`consult-${id}-${m.member}`,{...request,role:open.mode==='review'?'review':'consult',round:state.iteration,task_id:state.task_id,executor:m.executor},{timeoutMs:timeoutFor(root,state,m.executor,timeoutMs),maxBytes,proveQuiescence,signal});
  const result=consultResult(parsed.result,state.task_id,id,m.member,open.mode);
  const file=path.join(dir,`consult-result-${id}-${m.member}.json`);
  immutable(file,result);
  return {member:m.member,executor:m.executor,ok:true,recommended_verdict:result.recommended_verdict,findings:result.findings.length,result_file:file,quiescence:parsed.quiescence};
 }));
 const members=runs.map((r,i)=>r.status==='fulfilled'?r.value:{member:open.members[i].member,executor:open.members[i].executor,ok:false,error:r.reason.message,quiescence:r.reason.quiescence??null});
 await notify(`HyperFusion ${state.task_id}`,`${open.mode} ${id} done: `+members.map(m=>`${m.executor} ${m.ok?m.recommended_verdict:'failed'}`).join(', '));
 return {status:'CONSULT_READY',consult_id:id,mode:open.mode,members,next_action:'confirm quiescence, then fusion-state consult-finish'};
}

if(isMain(import.meta.url)) {
 try{
  const [root,flag,id]=process.argv.slice(2);
  const out=flag==='--consult'?await consult(root,id):await execute(root);
  console.log(JSON.stringify(out,null,2));
 }catch(e){printError(e);}
}
