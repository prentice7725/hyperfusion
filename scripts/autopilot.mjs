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

const STOPS=new Set(['VERIFY','DECISION_REQUIRED','BLOCKED','TAKEOVER_REQUIRED','RECOVERY_REQUIRED','CLOSE','ARCHIVED']);
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
    if(STOPS.has(s.phase))return stop(s.phase);
    check();
    if(s.open_consult)throw failure('AUTOPILOT_EXISTING_CONSULT','An earlier consultation requires lead settlement; it will not be relaunched');
    const dir=controlPath(root,'tasks',task);
    const brief=read(path.join(dir,s.iteration?`brief-${s.iteration}.json`:'initial-brief.json'));
    if(!brief.acceptance_commands?.length)throw failure('AUTOPILOT_ACCEPTANCE_REQUIRED','Add lead-approved acceptance_commands before running autopilot');
    if(s.configuration.review.auto_apply!==true)throw failure('AUTOPILOT_REVIEW_REQUIRED','Autopilot requires review.auto_apply:true');
    // 오토파일럿의 실질적 관문은 수용 테스트다. 처음부터 통과하는 테스트로는 엉터리 결과도 통과하므로, 기준 트리에서 실패가 확인된(red) 명령만 받는다.
    const baseline=s.acceptance_baseline;
    if(baseline?baseline.status!=='red':(s.phase!=='PLAN'||brief.acceptance_baseline_green))
     throw failure('AUTOPILOT_ACCEPTANCE_NOT_RED',`Autopilot needs acceptance_commands proven to fail on the untouched tree (baseline: ${baseline?.status??'not checked'}); the lead must review this task`);
    if(['PLAN','REDO','ALTERNATIVE_REQUIRED'].includes(s.phase)){
     const input={...brief};delete input.executor;
     if(s.phase!=='PLAN')input.lead_feedback='@review';
     settle('begin',input);continue;
    }
    if(s.phase==='EXECUTING'){
     if(s.owner==='lead')return stop('TAKEOVER_REQUIRED');
     if(fs.existsSync(path.join(dir,`launch-${s.iteration}.json`)))throw failure('AUTOPILOT_EXISTING_LAUNCH','A launch marker already exists; inspect quiescence and settle or recover manually');
     const result=await execute(root,{proveQuiescence:true,signal});event('execute',state());
     if(result.quiescence?.quiescent!==true)throw failure('AUTOPILOT_QUIESCENCE_REQUIRED',`Supervisor could not confirm process-tree quiescence (${result.quiescence?.reason??'missing evidence'}); retain the writer lease`);
     settle('finish',{token:s.writer.token,quiescent:true});continue;
    }
    if(s.phase==='REVIEW'){
     if(s.pending_review)throw failure('AUTOPILOT_PENDING_REVIEW','A delegated verdict requires lead review');
     if(s.acceptance?.round!==s.iteration||s.acceptance.status!=='pass')throw failure('AUTOPILOT_ACCEPTANCE_UNVERIFIED','Acceptance evidence is missing, failed or skipped; the lead must inspect it');
     const ignored=s.acceptance.ignored_after?read(path.join(dir,s.acceptance.ignored_after)):null;
     if(s.acceptance.tree_digest!==snapshot(root).digest||!ignored||ignoredChanges(ignored,ignoredManifest(root,brief.acceptance_artifacts)).length)
      throw failure('AUTOPILOT_ACCEPTANCE_UNVERIFIED','The tree or ignored inputs changed after acceptance; the lead must inspect them');
     const descriptor=settle('delegate-review',{});
     check();
     const result=await consult(root,descriptor.consult_id,{proveQuiescence:true,signal});event('consult',state());
     // Failed reviewers may be replaced within controller caps, but only after verified shutdown.
     if(result.members.some(m=>m.quiescence?.quiescent!==true))throw failure('AUTOPILOT_QUIESCENCE_REQUIRED','Reviewer process-tree quiescence was not confirmed; retain consultation evidence');
     settle('consult-finish',{quiescent:true});continue;
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
