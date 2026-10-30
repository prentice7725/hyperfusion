import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {isMain,isWin,killTree,assertCommandLine} from './platform.mjs';
import {read,immutable,repo,snapshot,hash} from './artifact.mjs';
import {assertLease} from './writer-lease.mjs';
import {result as validateResult,consultResult} from './contracts.mjs';
import {adapter} from './adapters/index.mjs';
import {notify} from './notify.mjs';
import {executionAllowed} from './review-plan.mjs';
import {controlPath,ensureControl,acquireLock} from './control-dir.mjs';
import {settledSlots} from './read-only-plan.mjs';
import {workerEnv} from './worker-env.mjs';
import {verifyExecute,verifyConsult} from './dispatch-verify.mjs';
import {assertBudget} from './budgets.mjs';
import {printError} from './cli.mjs';
import {maskTransport} from './redaction.mjs';
import {watchProcessTree} from './process-proof.mjs';
import {recordCompletion,controllerDigest} from './reconciliation.mjs';
import {openMonitor} from './worker-monitor.mjs';
import {attachObserverPane,herdrEnabled} from './herdr-observer.mjs';

const STATE_CLI=fileURLToPath(new URL('./fusion-state.mjs',import.meta.url));

const timeoutFor=(root,state,executor,override)=>{
 // 일꾼별 timeout_ms 설정이 있으면 그 값, 없으면 20분.
 const t=override??state.configuration?.executors?.[executor]?.timeout_ms??1200000;
 if(!Number.isSafeInteger(t)||t<1)throw Error('Invalid timeout');
 const budget=assertBudget(root,state);
 return budget.remaining_wall_ms===null?t:Math.min(t,budget.remaining_wall_ms);
};

// 일꾼 프로세스 하나를 감독하며 실행한다. tag는 산출물 이름(launch-<tag>.json 등)에 붙는다.
// marker: 이 프로세스가 컨트롤러가 띄운 일꾼임을 리드 가드가 알아보게 하는 값(lease 토큰의 해시나 상담 ID).
// 호스트 훅을 끌 수 없는 환경(Codex 관리형 훅, agy)에서 일꾼이 리드용 가드에 막히지 않게 한다.
async function supervise(root,dir,tag,request,{timeoutMs,maxBytes,proveQuiescence=false,signal,monitorQuietMs=120000,monitorIntervalMs=1000,marker={}}) {
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
 // 일꾼이 끝난 뒤 남은 자손 중 감독 중에 관측한 바로 그 프로세스는 컨트롤러가 정리한다(그룹 밖으로 빠져나간 agy 도구 자식 등).
 const monitor=proveQuiescence?watchProcessTree({reap:true}):null;
 // create-once 실행 표식이 크래시나 재실행에서도 중복 프로세스를 막는다.
 immutable(path.join(dir,`launch-${tag}.json`),{executor:request.executor,bridge_pid:process.pid,session_id:request.cli.session_id,at:new Date().toISOString()});
 if(request.cli.prompt_file)fs.writeFileSync(request.cli.prompt_file,request.prompt,{flag:'wx',mode:0o600});
 // 스키마처럼 CLI가 파일 경로로 받는 입력. 컨트롤러가 정한 경로에 한 번만 쓴다.
 for(const f of request.cli.extra_files??[])fs.writeFileSync(f.path,f.content,{flag:'wx',mode:0o600});
 let stdout='',stderr='',reason=null,child,killTimer,timer,activityTimer,forceResolve,alive=false,exited=false,observer=null;
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
   // PWD를 작업 폴더로 고정한다. agy는 cwd나 --add-dir이 아니라 PWD로 workspace를 정하기도 하는데, 환경 정리에서 PWD가 빠지면 엉뚱한 곳을 본다.
   child=spawn(request.cli.executable,[...(request.cli.prefix_args??[]),...request.cli.args],{cwd:root,stdio:[request.stdin===undefined?'ignore':'pipe','pipe','pipe'],shell:false,env:{...workerEnv(request.executor),...marker,PWD:root},detached:!isWin,windowsHide:true});
   alive=!!child.pid;child.on('exit',()=>{alive=false;exited=true;});
   if(child.pid)monitor?.start(child.pid);
   if(child.pid)guard(()=>activity.started());
   // 선택 기능: Herdr 안이면 이 작업자의 모니터 화면을 별도 pane으로 연다. 실패해도 라운드에는 영향이 없다.
   // HYPERFUSION_HERDR가 없으면 자동 감지라 Herdr 밖에서는 아무것도 하지 않고 기록도 남기지 않는다. 1(강제)일 때만 건너뛴 사유를 남긴다.
   const herdr=herdrEnabled();
   if(child.pid&&activity&&(herdr.enabled||herdr.forced))observer=attachObserverPane({dir,tag:String(tag)}).then(r=>guard(()=>activity.noteUntrusted('bridge',r.attached?`herdr pane ${r.pane_id} attached`:`herdr pane skipped: ${r.reason}`)),()=>{});
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
  // 그룹 밖으로 빠져나간 자손(Windows에서는 일꾼이 먼저 끝난 뒤 남은 자손)은 정지 증명 단계에서 감독 중 관측한 것만 정리하고, 그래도 남으면 리드가 확인한다.
  killTree(child,{force:true,alive});
 }
 await observer;
 const proof=monitor?await monitor.finish({exited,aborted:exit.signal==='SUPERVISOR_ABORT'}):null;
 if(proof)immutable(path.join(dir,`quiescence-${tag}.json`),{...proof,executor:request.executor});
 let observation=null;
 guard(()=>{observation=activity.exit({code:exit?.code??null,signal:exit?.signal??''});});
 const seen=observation??{run_id:null,state:'UNKNOWN',telemetry_limited:true};
 immutable(path.join(dir,`envelope-${tag}.json`),{executor:request.executor,exit,reason,stdout,stderr,started_at:new Date(started).toISOString(),ended_at:new Date().toISOString(),wall_ms:Date.now()-started,observation:{run_id:seen.run_id??null,state:seen.state??'UNKNOWN',telemetry_limited:seen.telemetry_limited===true,declares_success:false}});
 // 어댑터가 출력에서 원인을 알아보면(로그인 필요 등) 오류 문구에 조치를 덧붙인다. 실패 분류와 리드의 안내가 같은 문장을 본다.
 const fail=e=>{
  try{const hint=adapter(request.executor).diagnose?.(stdout,stderr);if(hint&&!e.message.includes(hint.slice(0,24)))e.message+=' — '+hint;}catch{}
  e.quiescence=proof;throw e;
 };
 if(reason||exit.code!==0)fail(Error(reason||request.executor+' exited with code '+exit.code));
 let parsed;
 try{parsed=adapter(request.executor).parse(stdout,request);}catch(e){fail(e);}
 // Windows 일꾼은 경로를 역슬래시로 보고하기도 한다. 저장소 경로 표기(슬래시)로 맞춘 뒤 검증한다.
 // 역슬래시와 앞의 './'를 걷어 내 저장소 경로 표기로 맞춘다.
 const slash=p=>typeof p==='string'?p.replaceAll('\\','/').replace(/^(\.\/)+/,''):p;
 for(const k of ['files_read','files_changed'])if(Array.isArray(parsed.result?.[k]))parsed.result[k]=parsed.result[k].map(slash);
 if(Array.isArray(parsed.result?.findings))for(const f of parsed.result.findings)if(f)f.file=slash(f.file);
 immutable(path.join(dir,`usage-${tag}.json`),{executor:request.executor,session_id:parsed.session_id,role,round,run_id:seen.run_id,model:request.cli.model??null,model_family:request.cli.model_family??null,reasoning_effort:request.cli.reasoning_effort??null,started_at:new Date(started).toISOString(),wall_ms:Date.now()-started,...parsed.usage,cost_basis:'executor client-side report, not billed cost'});
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
  parsed=await supervise(root,dir,n,{...request,...verified,role:'implement',round:n,task_id:state.task_id,executor:state.owner},{timeoutMs:timeoutFor(root,state,state.owner,timeoutMs),maxBytes,proveQuiescence,signal,monitorQuietMs,monitorIntervalMs,marker:{HF_WORKER_LEASE:hash(lease.token)}});
  result=validateResult(parsed.result,request.task_id,request.round);
 }catch(e){
  await notify(`HyperFusion ${state.task_id}`,`${request.executor} round ${n} failed`,{priority:'high'});
  throw e;
 }
 immutable(path.join(dir,`session-${n}.json`),{executor:request.executor,session_id:parsed.session_id});
 immutable(path.join(dir,`result-${n}.json`),result);
 if(state.reconciliation&&parsed.quiescence?.quiescent===true)recordCompletion(root,dir,String(n),{task_id:state.task_id,round:n,executor:request.executor,controller_digest:controllerDigest(state)},['launch','process','envelope','quiescence','dispatch','brief','base','result','session'].map(k=>`${k}-${n}.json`));
 await notify(`HyperFusion ${state.task_id}`,`${request.executor} round ${n} done (${result.status})`);
 // 여기서 lease를 놓지 않는다. 리드가 finish 해야 한다. 정지가 증명됐으면 리드가 따로 확인하지 않도록 칠 명령을 그대로 준다.
 const stopped=parsed.quiescence?.quiescent===true;
 return {status:'RESULT_READY',executor:request.executor,task_id:state.task_id,round:n,result_file:path.join(dir,`result-${n}.json`),quiescence:parsed.quiescence,
  next_action:stopped?'Worker processes are proven stopped; run finish_command (the result is read automatically)'
   :parsed.quiescence?'Process shutdown was not proven; stop the remaining processes yourself, then finish with the writer token and quiescent:true'
   :'confirm quiescence, then fusion-state finish with writer token; result is read automatically',
  ...(stopped?{finish_command:`node "${STATE_CLI}" finish "${root}" --token ${request.token} --quiescent`}:{})};
}

// 상담(advisor/committee) 한 건의 위원을 병렬로 실행한다. writer lease 없이 읽기 전용으로 돈다.
export async function consult(root,id,{timeoutMs,maxBytes=8*1024*1024,proveQuiescence=false,signal}={}) {
 root=repo(root);
 ensureControl(root);
 const unlock=acquireLock(controlPath(root,'locks/consult-execution.lock'));
 try{
 const state=read(controlPath(root,'state.json'));
 const open=state.open_consult;
 if(!open||open.id!==id)throw Error('No open consult '+id);
 const dir=controlPath(root,'tasks',state.task_id);
 const slots=open.execution?.slots??2;
 const proofRequired=open.execution?.revision===1||open.members.length>slots||proveQuiescence;
 const runs=await settledSlots(open.members,slots,async m=>{
  const current=read(controlPath(root,'state.json'));
  if(signal?.aborted)throw Error('READ_ONLY_QUEUE_INTERRUPTED');
  if(controllerDigest(current)!==controllerDigest(state))throw Error('READ_ONLY_STATE_CHANGED');
  if(fs.existsSync(controlPath(root,'locks/writer.json'))||fs.existsSync(controlPath(root,'locks/acceptance.json')))throw Error('READ_ONLY_WRITER_OR_ACCEPTANCE_PRESENT');
  if(snapshot(root).digest!==open.digest)throw Error('READ_ONLY_TREE_CHANGED');
  const sent=read(path.join(dir,`consult-${id}-${m.member}.json`));
  const request={...sent,...verifyConsult(root,state,dir,sent,{id,member:m.member,executor:m.executor})};
  const parsed=await supervise(root,dir,`consult-${id}-${m.member}`,{...request,role:open.mode==='review'?'review':'consult',round:state.iteration,task_id:state.task_id,executor:m.executor},{timeoutMs:timeoutFor(root,state,m.executor,timeoutMs),maxBytes,proveQuiescence:proofRequired,signal,marker:{HF_WORKER_CONSULT:String(id)}});
  let result;try{result=consultResult(parsed.result,state.task_id,id,m.member,open.mode);}catch(error){error.quiescence=parsed.quiescence;throw error;}
  const file=path.join(dir,`consult-result-${id}-${m.member}.json`);
  immutable(file,result);
  if(proofRequired&&parsed.quiescence?.quiescent!==true)throw Object.assign(Error('READ_ONLY_SHUTDOWN_UNPROVEN'),{quiescence:parsed.quiescence});
  if(state.reconciliation&&parsed.quiescence?.quiescent===true){
   const tag=`consult-${id}-${m.member}`;
   recordCompletion(root,dir,tag,{task_id:state.task_id,round:state.iteration,executor:m.executor,controller_digest:controllerDigest(state)},[`launch-${tag}.json`,`process-${tag}.json`,`envelope-${tag}.json`,`quiescence-${tag}.json`,`${tag}.json`,`consult-${id}.json`,`consult-${id}-base.json`,`consult-result-${id}-${m.member}.json`]);
  }
  return {member:m.member,executor:m.executor,ok:true,recommended_verdict:result.recommended_verdict,findings:result.findings.length,result_file:file,quiescence:parsed.quiescence};
 },{stopOn:error=>error.quiescence?.quiescent!==true});
 const members=runs.map((r,i)=>r.status==='fulfilled'?r.value:{member:open.members[i].member,executor:open.members[i].executor,ok:false,error:r.reason.message,quiescence:r.reason.quiescence??null});
 await notify(`HyperFusion ${state.task_id}`,`${open.mode} ${id} done: `+members.map(m=>`${m.executor} ${m.ok?m.recommended_verdict:'failed'}`).join(', '));
 const stopped=members.every(m=>m.quiescence?.quiescent===true);
 return {status:'CONSULT_READY',consult_id:id,mode:open.mode,members,
  next_action:stopped?'Reviewer processes are proven stopped; run finish_command':'confirm quiescence, then fusion-state consult-finish',
  ...(stopped?{finish_command:`node "${STATE_CLI}" consult-finish "${root}" --quiescent`}:{})};
 }finally{unlock();}
}

if(isMain(import.meta.url)) {
 try{
  const [root,flag,id]=process.argv.slice(2);
  // 명령줄 실행은 리드가 부른다. 프로세스 트리 정지를 여기서 증명해 리드가 직접 확인하지 않게 한다(오토파일럿과 같은 증명).
  const out=flag==='--consult'?await consult(root,id,{proveQuiescence:true}):await execute(root,{proveQuiescence:true});
  console.log(JSON.stringify(out,null,2));
 }catch(e){printError(e);}
}
