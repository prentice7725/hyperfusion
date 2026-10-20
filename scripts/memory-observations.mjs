import fs from 'node:fs';
import crypto from 'node:crypto';
import {read,atomic} from './artifact.mjs';
import {controlPath,acquireLock,assertPlainDir} from './control-dir.mjs';
import {looksSecret} from './memory-policy.mjs';

const fingerprint=item=>crypto.createHash('sha256').update(JSON.stringify([item.type,item.content])).digest('hex');
const taskDir=(root,task)=>{
 if(typeof task!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(task))throw Error('Invalid memory observation task_id');
 const dir=controlPath(root,'tasks',task);assertPlainDir(dir);
 if(!fs.existsSync(dir))throw Error('Unknown memory observation task');
 return dir;
};
const file=(root,task)=>{taskDir(root,task);return controlPath(root,'tasks',task,'memory-observations.json');};
const load=f=>fs.existsSync(f)?read(f):{revision:1,retrievals:[],assessments:[]};
function mutate(root,task,fn) {
 const f=file(root,task),release=acquireLock(controlPath(root,'locks','memory-observations.lock'));
 try{const ledger=load(f),out=fn(ledger);atomic(f,ledger);return out;}finally{release();}
}

export function recordRetrieval(root,task,workspace,hits) {
 return mutate(root,task,ledger=>{
  if(ledger.retrievals.length>=1000)throw Error('MEMORY_OBSERVATION_LIMIT: at most 1000 retrievals per task');
  const event={id:crypto.randomUUID(),workspace,at:new Date().toISOString(),items:hits.map(h=>({id:h.id,fingerprint:fingerprint(h)}))};
  ledger.retrievals.push(event);return event.id;
 });
}

// Inclusion means present in a saved implementation brief, not merely recalled,
// and not evidence that an executor used the advice or that it caused success.
export function collectMemory(root,state) {
 const ledger=load(file(root,state.task_id)),inclusions=[];
 for(let round=1;round<=state.iteration;round++){
  const f=controlPath(root,'tasks',state.task_id,`brief-${round}.json`);
  if(!fs.existsSync(f))continue;
  for(const item of read(f).prior_experience??[])inclusions.push({round,id:item.id??null,fingerprint:fingerprint(item)});
 }
 return {retrieval_tracking:ledger.retrievals.length?'opt-in observations':'unobserved',retrieval_events:ledger.retrievals.length||null,
  retrieved_items:ledger.retrievals.length?ledger.retrievals.reduce((n,e)=>n+e.items.length,0):null,
  brief_inclusions:inclusions.length,inclusions,
  assessments:ledger.assessments,helpful:ledger.assessments.filter(a=>a.outcome==='helpful').length,
  unhelpful:ledger.assessments.filter(a=>a.outcome==='unhelpful').length,
  usefulness:ledger.assessments.length?'lead-reported; not causal evidence':'unknown'};
}

export function assessMemory(root,input,workspace) {
 const {task,retrieval_id,id,round,outcome,evidence}=input;
 if(!Number.isInteger(round)||round<1||!['helpful','unhelpful','unknown'].includes(outcome)||typeof evidence!=='string'||!evidence.trim()||evidence.length>400||looksSecret(evidence))throw Error('Invalid memory assessment: round, outcome and non-secret evidence required');
 return mutate(root,task,ledger=>{
  const event=ledger.retrievals.find(e=>e.id===retrieval_id&&e.workspace===workspace),item=event?.items.find(i=>i.id===id);
  if(!item)throw Error('MEMORY_ASSESSMENT_UNRETRIEVED: use an observed retrieval ID and fragment ID');
  const brief=controlPath(root,'tasks',task,`brief-${round}.json`);
  if(!fs.existsSync(brief)||!read(brief).prior_experience?.some(i=>i.id===id&&fingerprint(i)===item.fingerprint))throw Error('MEMORY_ASSESSMENT_NOT_INCLUDED: exact retrieved content must appear in the saved round brief');
  const assessment={retrieval_id,id,round,outcome,evidence,at:new Date().toISOString(),source:'lead-report'};
  const prior=ledger.assessments.findIndex(a=>a.retrieval_id===retrieval_id&&a.id===id&&a.round===round);
  if(prior>=0)ledger.assessments[prior]=assessment;else{
   if(ledger.assessments.length>=1000)throw Error('MEMORY_OBSERVATION_LIMIT: at most 1000 assessments per task');
   ledger.assessments.push(assessment);
  }
  return assessment;
 });
}
