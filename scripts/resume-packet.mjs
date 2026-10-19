import fs from 'node:fs';
import path from 'node:path';
import {controlRoot} from './control-dir.mjs';
import {SCHEMA_VERSION} from './versions.mjs';
import {nextAction,TERMINAL_PHASES,PHASES} from './state-policy.mjs';

const MAX_RECORD_BYTES=1024*1024;
const safeId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value)&&value!=='.'&&value!=='..';
function record(file) {
 try{
  const st=fs.lstatSync(file);
  if(!st.isFile()||st.isSymbolicLink()||st.size>MAX_RECORD_BYTES)return {status:'invalid'};
  return {status:'present',value:JSON.parse(fs.readFileSync(file,'utf8'))};
 }catch(e){return {status:e.code==='ENOENT'?'missing':'invalid'};}
}

// No ensureControl, lock, transition hooks, probes or writes on this path.
export function inspectionControl(root) {
 const dir=controlRoot(root),state=record(path.join(dir,'state.json'));
 if(state.status!=='present'||!state.value||!safeId(state.value.task_id))throw Error('INSPECTION_STATE_INVALID: missing or invalid task state');
 const s=state.value,taskdir=()=>path.join(dir,'tasks',s.task_id);
 return {root,dir,s,taskdir,writerHeld:()=>fs.existsSync(path.join(dir,'locks/writer.json')),
  optional:name=>{
   if(typeof name!=='string'||path.basename(name)!==name)throw Error('INSPECTION_ARTIFACT_INVALID');
   const r=record(path.join(taskdir(),name));
   if(r.status==='invalid')throw Error('INSPECTION_ARTIFACT_INVALID: '+name);
   return r.value??null;
  }};
}

// A reconstruction aid, never a shutdown proof or an authorization to settle.
export function resumePacket(root) {
 const c=inspectionControl(root),s=c.s,n=s.iteration;
 const validRound=Number.isSafeInteger(n)&&n>=0;
 const names=['initial-brief.json','assignment.json','delegation.json','redo-delegation.json','reconciliation-grant.json','verification.json'];
 if(validRound){
  names.push(...['brief','dispatch','launch','process','envelope','raw-result','result','quiescence','completion','review-plan','lead-decision'].map(k=>`${k}-${n}.json`));
  names.push(`acceptance-${n}-finish.json`);
  names.push(`reconcile-${n}-finish.json`);
 }
 for(const name of [s.acceptance?.file,s.lead_packet?.file]){
  if(typeof name==='string'&&/^[A-Za-z0-9_-]+\.json$/.test(name)&&name.length<160&&!names.includes(name))names.push(name);
 }
 if(s.open_consult&&safeId(s.open_consult.id)){
  names.push(`consult-${s.open_consult.id}.json`);
  if(validRound)names.push(`reconcile-${n}-consult-finish-${s.open_consult.id}.json`);
  for(const member of (Array.isArray(s.open_consult.members)?s.open_consult.members:[]).slice(0,6)){
   if(safeId(member.member))for(const kind of ['launch','process','envelope','quiescence','completion','consult-result']){
    names.push(kind==='consult-result'?`consult-result-${s.open_consult.id}-${member.member}.json`:`${kind}-consult-${s.open_consult.id}-${member.member}.json`);
   }
  }
 }
 const artifacts=Object.fromEntries(names.map(name=>[name,{status:record(path.join(c.taskdir(),name)).status}]));
 const lease=record(path.join(c.dir,'locks/writer.json'));
 const reasons=[];
 if(s.schema_version!==SCHEMA_VERSION)reasons.push('LEGACY_STATE');
 if(!PHASES.includes(s.phase))reasons.push('PHASE_UNKNOWN');
 if(!validRound)reasons.push('ROUND_INVALID');
 if(fs.existsSync(path.join(c.dir,'locks/control.lock')))reasons.push('CONTROLLER_LOCK_PRESENT');
 if(fs.existsSync(path.join(c.dir,'locks/acceptance.json')))reasons.push('ACCEPTANCE_PENDING');
 if(artifacts['initial-brief.json'].status!=='present')reasons.push('INITIAL_BRIEF_UNAVAILABLE');
 if(Object.values(artifacts).some(a=>a.status==='invalid'))reasons.push('ARTIFACT_INVALID');
 const launch=validRound&&artifacts[`launch-${n}.json`]?.status!=='missing';
 if(launch)reasons.push('EXISTING_LAUNCH');
 if(s.open_consult)reasons.push('EXISTING_CONSULT');
 if(lease.status!=='missing'||s.writer)reasons.push('PROCESS_SHUTDOWN_UNVERIFIED');
 if(s.phase==='EXECUTING'&&!launch)reasons.push('DISPATCH_OUTCOME_UNCERTAIN');
 if(s.phase==='RECOVERY_REQUIRED')reasons.push('RECOVERY_REQUIRED');
 if(s.phase==='VERIFY'&&artifacts['verification.json'].status!=='missing')reasons.push('VERIFICATION_OUTCOME_UNCERTAIN');
 if(s.schema_version===SCHEMA_VERSION&&['CLOSE','BLOCKED'].includes(s.phase)&&!s.ended_at)reasons.push('TERMINAL_SETTLEMENT_INCOMPLETE');
 const stopped=reasons.length>0;
 const pick=(value,keys)=>Object.fromEntries(keys.filter(k=>value?.[k]!==undefined).map(k=>{
  const v=value[k];
  return [k,typeof v==='string'?v.slice(0,160):typeof v==='number'&&Number.isFinite(v)||typeof v==='boolean'?v:null];
 }));
 const initial=record(path.join(c.taskdir(),'initial-brief.json'));
 return {packet_revision:1,task_id:s.task_id,schema_version:Number.isSafeInteger(s.schema_version)?s.schema_version:null,
  ...pick(s,['phase','owner']),round:validRound?n:null,digest:typeof s.post_digest==='string'?s.post_digest.slice(0,128):null,
  frozen_policy:{assignment:pick(s.assignment,['criticality','strategy']),
   delegation:pick(s.delegation,['policy','revision','max_rounds','allow_preserve','granted_by']),
   redo_delegation:pick(s.redo_delegation,['policy','revision','max_redos','granted_by']),
   reconciliation:pick(s.reconciliation,['policy','revision','auto_resume','granted_by']),
   review:{...pick(s.configuration?.review,['strategy','by','auto_apply']),
    reviewers:(Array.isArray(s.configuration?.review?.reviewers)?s.configuration.review.reviewers:[]).filter(safeId).slice(0,6)},
   brief_status:initial.status,brief_ref:'initial-brief.json'},
  budgets:{attempts:pick(s.attempts,['grok','antigravity','sonnet','haiku','luna','lead']),
   limits:pick(s.limits,['max_wall_ms','max_cost_usd']),apex_rounds:Number.isSafeInteger(s.apex_rounds)?s.apex_rounds:null},
  process:{lease_status:lease.status,shutdown:'unverified',launch_present:!!launch,consult_open:!!s.open_consult},
  rejection_history:{count:(Array.isArray(s.reviews)?s.reviews:[]).filter(r=>['redo','alternative'].includes(r.verdict)).length,
   source:'state.json reviews; original history retained'},
  artifacts,reason_codes:reasons,auto_resume:false,lead_required:stopped||!TERMINAL_PHASES.includes(s.phase),
  next_action:stopped?'Inspect existing process and artifact evidence; settle through the controller after revalidation. Do not replay launches or consultations.':nextAction(s.phase,false),
  evidence_note:'Artifact presence does not establish validity, shutdown, acceptance or approval. No automatic settlement is enabled.'};
}
