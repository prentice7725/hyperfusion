import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {hash,read,immutable,snapshot} from './artifact.mjs';
import {SCHEMA_VERSION} from './versions.mjs';
import {contractChanged} from './delegation.mjs';
import {result,consultResult} from './contracts.mjs';
import {descendants,processTable} from './process-proof.mjs';

export function takeReconciliation(input) {
 if(input.reconciliation===undefined)return null;
 const g=input.reconciliation;
 if(!g||g.policy!=='settle-complete'||typeof g.reason!=='string'||!g.reason.trim()||g.reason.length>300||Object.keys(g).some(k=>!['policy','reason'].includes(k)))throw Error('RECONCILIATION_GRANT: expected {policy:"settle-complete",reason} at init');
 delete input.reconciliation;
 return {policy:g.policy,reason:g.reason.trim(),revision:1,granted_by:'lead-at-init',set_by:'controller',auto_resume:false};
}

// These receipts bind persisted results to the tree and transport artifacts.
// They do not assert exactly-once process execution or replace shutdown proof.
export function recordCompletion(root,dir,tag,identity,names) {
 const files={};
 for(const name of names)files[name]=hash(fs.readFileSync(path.join(dir,name)));
 immutable(path.join(dir,`completion-${tag}.json`),{revision:1,host:os.hostname(),platform:process.platform,...identity,tree_digest:snapshot(root).digest,files});
}

const fail=code=>{throw Object.assign(Error('RECONCILE_STOP: '+code),{code});};
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export const controllerDigest=state=>hash(JSON.stringify(state));
function grant(c) {
 if(c.s.schema_version!==SCHEMA_VERSION)fail('LEGACY_STATE');
 const g=c.s.reconciliation;
 if(!g||g.revision!==1||g.policy!=='settle-complete'||g.auto_resume!==false||!equal(g,c.optional('reconciliation-grant.json')))fail('RECONCILIATION_NOT_GRANTED');
 return g;
}

function completion(c,tag,executor,required) {
 const r=c.optional(`completion-${tag}.json`);
 if(!r||r.revision!==1||r.task_id!==c.s.task_id||r.round!==c.s.iteration||r.executor!==executor)fail('COMPLETION_EVIDENCE_MISSING');
 if(r.host!==os.hostname()||r.platform!==process.platform)fail('PROCESS_HOST_MISMATCH');
 if(r.controller_digest!==controllerDigest(c.s))fail('CONTROLLER_STATE_CHANGED');
 if(r.tree_digest!==snapshot(c.root).digest)fail('TREE_CHANGED_AFTER_COMPLETION');
 for(const name of required){
  if(typeof r.files?.[name]!=='string')fail('COMPLETION_EVIDENCE_INCOMPLETE');
  if(r.files[name]!==hash(fs.readFileSync(path.join(c.taskdir(),name))))fail('COMPLETION_EVIDENCE_CHANGED');
 }
 const launch=c.optional(`launch-${tag}.json`),proc=c.optional(`process-${tag}.json`),env=c.optional(`envelope-${tag}.json`),proof=c.optional(`quiescence-${tag}.json`);
 if(launch?.executor!==executor||proc?.executor!==executor||env?.executor!==executor||proof?.executor!==executor)fail('TRANSPORT_IDENTITY_MISMATCH');
 if(!Number.isSafeInteger(proc.pid)||proc.pid<1||env.exit?.code!==0||env.reason||proof.quiescent!==true||!Number.isFinite(Date.parse(proof.checked_at)))fail('PROCESS_SHUTDOWN_UNPROVEN');
 return {tag,receipt:r,process:proc,envelope:env,proof};
}

export function reconciliationPlan(c) {
 const s=c.s;
 try{
  const g=grant(c);
  if(fs.existsSync(path.join(c.dir,'locks/acceptance.json')))fail('ACCEPTANCE_RECOVERY_PENDING');
  if(['CLOSE','BLOCKED'].includes(s.phase)&&!s.ended_at)fail('TERMINAL_SETTLEMENT_INCOMPLETE');
  if(s.phase==='VERIFY'&&c.optional('verification.json'))fail('VERIFICATION_OUTCOME_UNCERTAIN');
  const n=s.iteration,dir=c.taskdir();let action,consult_id,proofs=[];
  if(!Number.isSafeInteger(n)||n<1)fail('NO_COMPLETED_ROUND');
  if(s.open_consult){
   action='consult-finish';consult_id=s.open_consult.id;
   if(!/^c\d+$/.test(consult_id)||!Array.isArray(s.open_consult.members)||!s.open_consult.members.length)fail('CONSULT_IDENTITY_INVALID');
   if(c.optional(`reconcile-${n}-consult-finish-${consult_id}.json`))fail('OPERATION_OUTCOME_UNCERTAIN');
   if(c.optional(`consult-${consult_id}-finish.json`))fail('PARTIAL_SETTLEMENT');
   const recorded=c.optional(`consult-${consult_id}.json`),base=c.optional(`consult-${consult_id}-base.json`);
   if(recorded?.mode!==s.open_consult.mode||!equal(recorded.members,s.open_consult.members)||base?.digest!==s.open_consult.digest)fail('CONSULT_IDENTITY_INVALID');
   if(c.writerHeld()||s.writer)fail('WRITER_PRESENT');
   if(s.open_consult.digest!==snapshot(c.root).digest)fail('TREE_CHANGED_AFTER_COMPLETION');
   for(const m of s.open_consult.members){
    if(!/^m\d+$/.test(m.member))fail('CONSULT_IDENTITY_INVALID');
    const tag=`consult-${consult_id}-${m.member}`;
    proofs.push(completion(c,tag,m.executor,[`launch-${tag}.json`,`process-${tag}.json`,`envelope-${tag}.json`,`quiescence-${tag}.json`,`${tag}.json`,`consult-${consult_id}.json`,`consult-${consult_id}-base.json`,`consult-result-${consult_id}-${m.member}.json`]));
    consultResult(c.optional(`consult-result-${consult_id}-${m.member}.json`),s.task_id,consult_id,m.member,s.open_consult.mode);
   }
  }else if(s.phase==='EXECUTING'){
   action='finish';
   if(c.optional(`reconcile-${n}-finish.json`))fail('OPERATION_OUTCOME_UNCERTAIN');
   if(s.owner==='lead')fail('LEAD_TAKEOVER_REQUIRES_MANUAL_FINISH');
   if(!fs.existsSync(path.join(dir,`launch-${n}.json`)))fail('DISPATCH_OUTCOME_UNCERTAIN');
   const lease=read(path.join(c.dir,'locks/writer.json'));
   if(!s.writer||lease.token!==s.writer.token||lease.task_id!==s.task_id||lease.round!==n||lease.owner!==s.owner)fail('WRITER_IDENTITY_MISMATCH');
   if(contractChanged(c.optional('initial-brief.json'),c.optional(`brief-${n}.json`)).length)fail('CONTRACT_DRIFT');
   proofs=[completion(c,String(n),s.owner,[`launch-${n}.json`,`process-${n}.json`,`envelope-${n}.json`,`quiescence-${n}.json`,`dispatch-${n}.json`,`brief-${n}.json`,`base-${n}.json`,`result-${n}.json`,`session-${n}.json`])];
   const request=c.optional(`dispatch-${n}.json`);
   if(request?.task_id!==s.task_id||request.round!==n||request.executor!==s.owner||request.token!==lease.token)fail('DISPATCH_IDENTITY_MISMATCH');
   result(c.optional(`result-${n}.json`),s.task_id,n);
   // finish writes these once; a partial earlier finish must never be replayed.
   if(['raw-result','post','validation'].some(k=>fs.existsSync(path.join(dir,`${k}-${n}.json`))))fail('PARTIAL_SETTLEMENT');
  }else fail('NO_SETTLEMENT_ACTION');
  const identity=hash(JSON.stringify({task_id:s.task_id,round:n,action,consult_id,grant:g,proofs:proofs.map(p=>p.receipt)}));
  return {status:'READY_FOR_REVALIDATION',task_id:s.task_id,round:n,action,...(consult_id?{consult_id}:{}),identity,auto_resume:false,proofs};
 }catch(e){return {status:'STOPPED',task_id:s.task_id,round:s.iteration,reason_codes:[e.code??'RECONCILIATION_EVIDENCE_INVALID'],detail:e.message,auto_resume:false};}
}

export const publicPlan=plan=>{const {proofs,...out}=plan;return out;};
export const operationName=expected=>{
 if(!expected||!Number.isSafeInteger(expected.round)||expected.round<1||!['finish','consult-finish'].includes(expected.action)||typeof expected.identity!=='string'||!/^[a-f0-9]{64}$/.test(expected.identity))fail('EXPECTED_OPERATION_REQUIRED');
 if(expected.action==='consult-finish'&&!/^c\d+$/.test(expected.consult_id))fail('EXPECTED_OPERATION_REQUIRED');
 if(expected.action==='finish'&&expected.consult_id!==undefined)fail('EXPECTED_OPERATION_REQUIRED');
 return `reconcile-${expected.round}-${expected.action}${expected.consult_id?'-'+expected.consult_id:''}.json`;
};

export async function revalidateProcesses(plan,readTable=processTable) {
 let rows;
 try{rows=await readTable();}catch{fail('PROCESS_INVENTORY_UNAVAILABLE');}
 if(!Array.isArray(rows)||rows.some(r=>!r||!Number.isSafeInteger(r.pid)||!Number.isSafeInteger(r.parent)))fail('PROCESS_INVENTORY_UNAVAILABLE');
 for(const p of plan.proofs){
  const tracked=new Map((p.proof.identities??[]).map(i=>[i.pid,i.created]));
  const since=Date.parse(p.envelope.started_at);
  if(!Number.isFinite(since))fail('PROCESS_IDENTITY_UNAVAILABLE');
  if(descendants(rows,p.process.pid,tracked,{bornAfter:since-2000}).length)fail('PROCESS_STILL_PRESENT');
 }
}

export function assertReconciliationGrant(c){return grant(c);}
