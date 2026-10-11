import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {run} from './fusion-state.mjs';
import {execute,consult} from './executor-bridge.mjs';
import {read,repo,atomic,snapshot} from './artifact.mjs';
import {ignoredManifest,ignoredChanges} from './acceptance.mjs';
import {ensureControl,controlPath,acquireLock} from './control-dir.mjs';
import {isMain} from './platform.mjs';
import {readInput,printError,errorRecord} from './cli.mjs';
import {SCHEMA_VERSION} from './versions.mjs';

// 정지 확인이 실패하면 이유와 남은 프로세스를 메시지에 남긴다(리드와 CI 로그에서 바로 보이게).
const proofText=q=>q?`${q.reason}${q.remaining?.length?`; remaining ${JSON.stringify(q.remaining.slice(0,5))}`:''}${q.checks?`; checks ${q.checks}`:''}`:'missing evidence';
const STOPS=new Set(['VERIFY','LEAD_DECISION_REQUIRED','DECISION_REQUIRED','BLOCKED','TAKEOVER_REQUIRED','RECOVERY_REQUIRED','CLOSE','ARCHIVED']);
const failure=(code,message)=>Object.assign(Error(message),{code});

// Uses the same controller actions as the lead. No decision, recovery, scope expansion or final verification.
export async function autopilot(root,{max_steps=64,signal}={}) {
 if(!Number.isSafeInteger(max_steps)||max_steps<1||max_steps>256)throw failure('INVALID_INPUT','max_steps must be an integer from 1 to 256');
 if(signal!==undefined&&(typeof signal?.addEventListener!=='function'||typeof signal?.removeEventListener!=='function'))throw failure('INVALID_INPUT','signal must be an AbortSignal');
 root=repo(root);const control=ensureControl(root);
 const unlock=acquireLock(path.join(control,'locks/autopilot.lock'));
 let interrupted=signal?.aborted??false;
 const interrupt=()=>{interrupted=true;};
 process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);signal?.addEventListener('abort',interrupt);
 const state=()=>read(controlPath(root,'state.json'));
 let journal,file,task,steps=0;
 const event=(action,s)=>{
  steps++;journal.events.push({step:steps,action,round:s.iteration,phase:s.phase,owner:s.owner,at:new Date().toISOString()});atomic(file,journal);
 };
 const check=()=>{
  const s=state();
  if(s.task_id!==task)throw failure('AUTOPILOT_TASK_CHANGED','The active task changed; inspect both task records');
  if(interrupted)throw failure('AUTOPILOT_INTERRUPTED','Autopilot interrupted; inspect process and lease evidence before recovery');
  if(steps>=max_steps)throw failure('AUTOPILOT_STEP_LIMIT','Autopilot step limit reached; inspect status before continuing');
  return s;
 };
 const settle=(action,input)=>{check();const out=run(root,action,input);event(action,state());return out;};
 // 위임 리뷰를 한 번 돌린다: 리뷰 브리지를 실행하고, 모든 리뷰어의 프로세스 종료를 증명한 뒤 consult-finish.
 const runReview=async descriptor=>{
  check();
  const result=await consult(root,descriptor.consult_id,{proveQuiescence:true,signal});event('consult',state());
  // Failed reviewers may be replaced within controller caps, but only after verified shutdown.
  if(result.members.some(m=>m.quiescence?.quiescent!==true))throw failure('AUTOPILOT_QUIESCENCE_REQUIRED',`Reviewer process-tree quiescence was not confirmed (${result.members.filter(m=>m.quiescence?.quiescent!==true).map(m=>`${m.executor}: ${proofText(m.quiescence)}`).join('; ')}); retain consultation evidence`);
  settle('consult-finish',{quiescent:true});
 };
 const stop=(reason,error)=>{
  const s=state();journal.finished_at=new Date().toISOString();journal.reason=reason;
  if(error)journal.error=errorRecord(error);
  atomic(file,journal);
  return {status:'NEEDS_LEAD',task_id:task,phase:s.phase,owner:s.owner,round:s.iteration,reason,steps,
   next_action:error?'Inspect the journal and status; manually settle or recover before retrying.':run(root,'status',{summary:true}).next_action,journal_file:file,...(error?{error:journal.error}:{})};
 };
 try {
  const initial=state();task=initial.task_id;
  if(initial.schema_version!==SCHEMA_VERSION)throw failure('LEGACY_STATE','Autopilot requires the current state schema');
  file=controlPath(root,'tasks',task,`autopilot-${crypto.randomUUID()}.json`);
  journal={task_id:task,started_at:new Date().toISOString(),events:[]};atomic(file,journal);
  try {
   for(;;){
    const s=state();
    if(s.task_id!==task)throw failure('AUTOPILOT_TASK_CHANGED','The active task changed');
    // 리드가 init에서 재량권(delegation)을 준 STANDARD 작업만: 컨트롤러가 조건을 전부 확인했을 때 승인하고 verify까지 이어 간다.
    // 조건이 하나라도 부족하면 승인하지 않고 이유와 함께 리드 게이트에서 멈춘다. 승인 기록은 delegated-policy로 표시된다.
    if(s.delegation&&s.phase==='LEAD_DECISION_REQUIRED'){
     // 리뷰어 자리가 비었으면(한도·장애) 컨트롤러가 다른 회사 모델로 채워 다시 리뷰한다. 못 채우면 이유와 함께 게이트에 남는다.
     if((s.review_results?.[s.iteration]??[]).some(r=>!r.ok)){
      let descriptor;
      try{descriptor=settle('auto-substitute-review',{});}
      catch(e){if(e.code==='AUTO_SUBSTITUTE_REFUSED')return stop('LEAD_DECISION_REQUIRED',e);throw e;}
      await runReview(descriptor);continue;
     }
     try{settle('policy-approve',{});}
     catch(e){if(e.code==='POLICY_NOT_ELIGIBLE')return stop('LEAD_DECISION_REQUIRED',e);throw e;}
     continue;
    }
    if(s.delegation&&s.phase==='VERIFY'&&s.lead_decision?.authority?.source==='delegated-policy'&&s.lead_decision.round===s.iteration){
     settle('verify',{acceptance_satisfied:true});continue;
    }
    if(STOPS.has(s.phase))return stop(s.phase);
    check();
    if(s.open_consult)throw failure('AUTOPILOT_EXISTING_CONSULT','An earlier consultation requires lead settlement; it will not be relaunched');
    const dir=controlPath(root,'tasks',task);
    const brief=read(path.join(dir,s.iteration?`brief-${s.iteration}.json`:'initial-brief.json'));
    if(!brief.acceptance_commands?.length)throw failure('AUTOPILOT_ACCEPTANCE_REQUIRED','Add lead-approved acceptance_commands before running autopilot');
    // adaptive 모드는 auto_apply를 판정에 쓰지 않는다(리드 게이트에서 멈춘다). 그래서 값을 요구하면 샘플 설정(auto_apply:false)으로는
    // 시작조차 못 한다. classic 모드는 위임 판정을 그대로 적용하므로 계속 요구한다.
    const adaptive=s.configuration.review.strategy==='lead-gated-adaptive';
    if(!adaptive&&s.configuration.review.auto_apply!==true)throw failure('AUTOPILOT_REVIEW_REQUIRED','Autopilot requires review.auto_apply:true (or review.strategy "lead-gated-adaptive", which always stops at the lead gate)');
    // 오토파일럿의 실질적 관문은 수용 테스트다. 처음부터 통과하는 테스트로는 엉터리 결과도 통과하므로, 기준 트리에서 실패가 확인된(red) 명령만 받는다.
    const baseline=s.acceptance_baseline;
    // 보존(preserve) 작업은 red-first 대신 "수정 전에도 통과 + 보호 경로 불변"이 증거다. 보호 경로는 컨트롤러가 finish·verify에서 지킨다.
    const preserve=read(path.join(dir,'initial-brief.json')).verification?.kind==='preserve';
    if(baseline?baseline.status!==(preserve?'green-acknowledged':'red'):(s.phase!=='PLAN'||brief.acceptance_baseline_green))
     throw failure('AUTOPILOT_ACCEPTANCE_NOT_RED',preserve?`A preserve task needs acceptance_commands recorded as already passing (baseline: ${baseline?.status??'not checked'}); the lead must review this task`:`Autopilot needs acceptance_commands proven to fail on the untouched tree (baseline: ${baseline?.status??'not checked'}); the lead must review this task`);
    if(['PLAN','REDO','ALTERNATIVE_REQUIRED'].includes(s.phase)){
     const input={...brief};delete input.executor;
     if(s.phase!=='PLAN')input.lead_feedback=s.last_auto_recovery?.round===s.iteration
      ?[`The previous attempt ended before it produced a result (${s.last_auto_recovery.reason}). Nothing was changed; start again from the brief.`]
      :'@review';
     settle('begin',input);continue;
    }
    if(s.phase==='EXECUTING'){
     if(s.owner==='lead')return stop('TAKEOVER_REQUIRED');
     if(fs.existsSync(path.join(dir,`launch-${s.iteration}.json`)))throw failure('AUTOPILOT_EXISTING_LAUNCH','A launch marker already exists; inspect quiescence and settle or recover manually');
     let result;
     try{result=await execute(root,{proveQuiescence:true,signal});}
     catch(e){
      // 재량권이 있는 작업: 결과 없이 끝난 일시 장애는 컨트롤러 증거(종료 증명, 트리 불변)가 맞으면 복구해서 다시 시도한다.
      // 사정이 맞지 않으면 지금까지처럼 쓰기 권한을 쥔 채 멈춘다.
      if(s.delegation&&e?.quiescence?.quiescent===true){
       try{settle('auto-recover',{error:e.message});continue;}
       catch(refusal){if(refusal.code!=='AUTO_RECOVER_REFUSED')throw refusal;}
      }
      throw e;
     }
     event('execute',state());
     if(result.quiescence?.quiescent!==true)throw failure('AUTOPILOT_QUIESCENCE_REQUIRED',`Supervisor could not confirm process-tree quiescence (${proofText(result.quiescence)}); retain the writer lease`);
     settle('finish',{token:s.writer.token,quiescent:true});continue;
    }
    if(s.phase==='REVIEW'){
     if(s.pending_review)throw failure('AUTOPILOT_PENDING_REVIEW','A delegated verdict requires lead review');
     const acceptance=s.acceptance?.file?read(path.join(dir,s.acceptance.file)):null;
     if(s.acceptance?.round!==s.iteration||s.acceptance.status!=='pass'||s.acceptance.quiescent!==true
       ||!acceptance?.results?.length||!acceptance.results.every(r=>r.quiescence?.quiescent===true))
      throw failure('AUTOPILOT_ACCEPTANCE_UNVERIFIED','Acceptance evidence or process shutdown proof is missing, failed or skipped; the lead must inspect it');
     const ignored=s.acceptance.ignored_after?read(path.join(dir,s.acceptance.ignored_after)):null;
     if(s.acceptance.tree_digest!==snapshot(root).digest||!ignored||ignoredChanges(ignored,ignoredManifest(root,brief.acceptance_artifacts)).length)
      throw failure('AUTOPILOT_ACCEPTANCE_UNVERIFIED','The tree or ignored inputs changed after acceptance; the lead must inspect them');
     await runReview(settle('delegate-review',{}));continue;
    }
    throw failure('INVALID_PHASE','Autopilot cannot advance '+s.phase);
   }
  }catch(e){return stop(interrupted?'AUTOPILOT_INTERRUPTED':e.code??'OPERATION_FAILED',e);}
 }finally{
  process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);signal?.removeEventListener('abort',interrupt);unlock();
 }
}

if(isMain(import.meta.url)){
 try{const [root,file]=process.argv.slice(2);console.log(JSON.stringify(await autopilot(root,readInput(file)),null,2));}
 catch(e){printError(e);}
}
