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

// 재개 패킷이 낼 수 있는 이유 코드 전부. 아래 처분 표가 이 목록을 모두 다뤄야 한다(테스트가 확인한다).
export const REASON_CODES=['LEGACY_STATE','PHASE_UNKNOWN','ROUND_INVALID','CONTROLLER_LOCK_PRESENT','ACCEPTANCE_PENDING',
 'INITIAL_BRIEF_UNAVAILABLE','ARTIFACT_INVALID','EXISTING_LAUNCH','EXISTING_CONSULT','PROCESS_SHUTDOWN_UNVERIFIED',
 'DISPATCH_OUTCOME_UNCERTAIN','RECOVERY_REQUIRED','VERIFICATION_OUTCOME_UNCERTAIN','TERMINAL_SETTLEMENT_INCOMPLETE'];

// 이유 코드 조합을 처분값 하나로 줄인다(HF-I09, openrig의 복원 결과 보고에서 착안). 위에서부터 먼저 맞는 것이다.
// 리드가 어느 절차로 갈지 고르는 데 쓰는 표시일 뿐이다. 컨트롤러의 어느 판단도 이 값을 읽지 않는다.
// 이름은 패킷이 증명하지 못하는 것(종료, 수용, 승인)을 말하지 않게 골랐다.
export const DISPOSITIONS=[
 ['unreadable',['LEGACY_STATE','PHASE_UNKNOWN','ROUND_INVALID','ARTIFACT_INVALID','INITIAL_BRIEF_UNAVAILABLE']],
 ['recovery_required',['RECOVERY_REQUIRED']],
 ['outcome_uncertain',['DISPATCH_OUTCOME_UNCERTAIN','VERIFICATION_OUTCOME_UNCERTAIN','TERMINAL_SETTLEMENT_INCOMPLETE']],
 ['shutdown_unverified',['PROCESS_SHUTDOWN_UNVERIFIED','CONTROLLER_LOCK_PRESENT','ACCEPTANCE_PENDING']],
 ['evidence_present',['EXISTING_LAUNCH','EXISTING_CONSULT']]
];

// 순수 함수. 표에 없는 코드가 하나라도 있으면 unreadable이다. 모르는 코드를 continue로 흘리지 않는다.
// 예외 하나: 구현자의 완료 기록(completion-N)이 있고 멈춘 이유가 남은 writer 잠금(PROCESS_SHUTDOWN_UNVERIFIED)뿐이면
// evidence_present다. 완료 기록은 브리지가 종료를 확인한 뒤 쓰므로, 정산 표대로 reconcile 미리보기에서 finish 한 번으로 간다.
// 미리보기가 다시 검증하므로 이 표시는 권한이 아니다.
export function disposition(reasons,phase,{implementerCompleted=false}={}) {
 const unknown=reasons.filter(r=>!REASON_CODES.includes(r));
 if(unknown.length)return {disposition:'unreadable',basis:unknown};
 for(const [name,codes] of DISPOSITIONS){
  const basis=reasons.filter(r=>codes.includes(r));
  if(name==='shutdown_unverified'&&implementerCompleted&&basis.length===1&&basis[0]==='PROCESS_SHUTDOWN_UNVERIFIED')continue;
  if(basis.length)return {disposition:name,basis};
 }
 return {disposition:TERMINAL_PHASES.includes(phase)?'settled':'continue',basis:[]};
}

// 참여자별 흔적. 현재 라운드의 파일 유무만으로 정한다. 파일이 있다는 것은 종료나 수용의 증거가 아니다.
const TRACES=[['invalid',files=>files.some(f=>f.status==='invalid')],
 ['completion_recorded',(files,kinds)=>kinds.completion==='present'],
 ['result_recorded',(files,kinds)=>kinds.result==='present'],
 ['launched_only',(files,kinds)=>kinds.launch==='present'],
 ['not_launched',()=>true]];
const traceOf=kinds=>{const files=Object.values(kinds).map(status=>({status}));return TRACES.find(([,test])=>test(files,kinds))[0];};
export function participants(s,artifacts) {
 const n=s.iteration,status=name=>artifacts[name]?.status??'missing',out=[];
 if(safeId(s.owner)&&Number.isSafeInteger(n)&&n>=0){
  out.push({role:'implementer',member:s.owner,trace:traceOf({launch:status(`launch-${n}.json`),result:status(`result-${n}.json`),completion:status(`completion-${n}.json`)})});
 }
 const id=s.open_consult?.id;
 if(safeId(id))for(const m of (Array.isArray(s.open_consult.members)?s.open_consult.members:[]).slice(0,6)){
  if(!safeId(m?.member))continue;
  out.push({role:'consult',member:m.member,trace:traceOf({launch:status(`launch-consult-${id}-${m.member}.json`),
   result:status(`consult-result-${id}-${m.member}.json`),completion:status(`completion-consult-${id}-${m.member}.json`)})});
 }
 return out;
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
 const people=participants(s,artifacts);
 const settled=disposition(reasons,s.phase,{implementerCompleted:people.some(p=>p.role==='implementer'&&p.trace==='completion_recorded')});
 const pick=(value,keys)=>Object.fromEntries(keys.filter(k=>value?.[k]!==undefined).map(k=>{
  const v=value[k];
  return [k,typeof v==='string'?v.slice(0,160):typeof v==='number'&&Number.isFinite(v)||typeof v==='boolean'?v:null];
 }));
 const initial=record(path.join(c.taskdir(),'initial-brief.json'));
 return {packet_revision:2,task_id:s.task_id,disposition:settled.disposition,disposition_basis:settled.basis,schema_version:Number.isSafeInteger(s.schema_version)?s.schema_version:null,
  ...pick(s,['phase','owner']),round:validRound?n:null,digest:typeof s.post_digest==='string'?s.post_digest.slice(0,128):null,
  frozen_policy:{assignment:pick(s.assignment,['criticality','strategy']),
   delegation:pick(s.delegation,['policy','revision','max_rounds','allow_preserve','granted_by']),
   redo_delegation:pick(s.redo_delegation,['policy','revision','max_redos','granted_by']),
   reconciliation:pick(s.reconciliation,['policy','revision','auto_resume','granted_by']),
   review:{...pick(s.configuration?.review,['strategy','by','auto_apply']),
    reviewers:(Array.isArray(s.configuration?.review?.reviewers)?s.configuration.review.reviewers:[]).filter(safeId).slice(0,6)},
   brief_status:initial.status,brief_ref:'initial-brief.json'},
  budgets:{attempts:pick(s.attempts,['grok','antigravity','sonnet','haiku','luna','terra','lead']),
   limits:pick(s.limits,['max_wall_ms','max_cost_usd']),apex_rounds:Number.isSafeInteger(s.apex_rounds)?s.apex_rounds:null},
  process:{lease_status:lease.status,shutdown:'unverified',launch_present:!!launch,consult_open:!!s.open_consult},
  rejection_history:{count:(Array.isArray(s.reviews)?s.reviews:[]).filter(r=>['redo','alternative'].includes(r.verdict)).length,
   source:'state.json reviews; original history retained'},
  participants:people,artifacts,reason_codes:reasons,auto_resume:false,lead_required:stopped||!TERMINAL_PHASES.includes(s.phase),
  next_action:stopped?'Inspect existing process and artifact evidence; settle through the controller after revalidation. Do not replay launches or consultations.':nextAction(s.phase,false),
  evidence_note:'Artifact presence does not establish validity, shutdown, acceptance or approval. No automatic settlement is enabled.'};
}
