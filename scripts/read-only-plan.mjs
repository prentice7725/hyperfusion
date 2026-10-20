import {safePath} from './contracts.mjs';
import {REVIEWERS} from './executor-config.mjs';

const fail=m=>{throw Error('READ_ONLY_PLAN: '+m);};
export function readOnlyPlan(value,scope) {
 if(value===undefined)return null;
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['slots','subtasks'].includes(k)))fail('expected slots and optional subtasks');
 const slots=value.slots??2,subtasks=value.subtasks??[];
 if(![1,2].includes(slots))fail('pilot slots must be 1 or 2');
 if(!Array.isArray(subtasks)||subtasks.length>4)fail('at most four subtasks per task');
 const ids=new Set();
 const normalized=subtasks.map(t=>{
  if(!t||Object.keys(t).some(k=>!['id','executor','paths','focus'].includes(k))||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(t.id??'')||ids.has(t.id))fail('subtask ids must be unique');
  ids.add(t.id);
  if(!REVIEWERS.includes(t.executor))fail('subtask needs an explicit reviewer/advisor executor');
  if(!Array.isArray(t.paths)||!t.paths.length||t.paths.length>20||t.paths.some(p=>!safePath(p)||!scope?.paths?.some(q=>p===q||p.startsWith(q+'/'))))fail('subtask paths must remain inside approved scope');
  if(!Array.isArray(t.focus)||!t.focus.length||t.focus.length>10||t.focus.some(s=>typeof s!=='string'||!s.trim()||s.length>500))fail('subtask needs bounded focus');
  return {id:t.id,executor:t.executor,paths:[...t.paths],focus:[...t.focus]};
 });
 return {revision:1,slots,subtasks:normalized};
}
export function selectReadOnly(state,input) {
 if(input.subtasks===undefined)return null;
 if(input.mode!=='committee'||input.executors!==undefined||input.focus!==undefined)fail('planned subtasks use committee mode without executor/focus overrides');
 if(!Array.isArray(input.subtasks)||!input.subtasks.length||input.subtasks.length>4||new Set(input.subtasks).size!==input.subtasks.length)fail('select distinct approved subtask ids');
 return input.subtasks.map(id=>{
  const task=state.read_only?.subtasks.find(t=>t.id===id);
  if(!task)fail('unapproved subtask '+id);
  if(state.read_only_used?.includes(id))fail('subtask already reserved: '+id);
  return task;
 });
}
export function workManifest({mode,member,scope,focus,digest,subtask,workflowDigest}) {
 return {revision:1,member,kind:mode==='review'?'mandatory-review':subtask?'planned-read-only':'consult',
  digest,workflow_digest:workflowDigest??null,subtask_id:subtask?.id??null,
  paths:subtask?.paths??scope.paths,focus:subtask?.focus??focus??[],
  shared_evidence:mode==='review'?'all cumulative task changes, all success criteria, controller acceptance and prior rejection context':'shared task context',
  allowed_actions:['read'],note:'Focus is advisory, not a waiver of required review coverage. No edits, tests, builds, dependency installs or worktree changes are authorized.'};
}

// Preserve result order and successful siblings while bounding active invocations.
export async function settledSlots(items,slots,invoke,{stopOn=()=>false}={}) {
 if(![1,2].includes(slots))fail('invalid execution slots');
 const results=new Array(items.length);let next=0,stop=null;
 async function worker(){
  while(next<items.length){
   const index=next++;
   if(stop){results[index]={status:'rejected',reason:Object.assign(Error('READ_ONLY_QUEUE_STOPPED: '+stop.message),{code:'READ_ONLY_QUEUE_STOPPED'})};continue;}
   try{results[index]={status:'fulfilled',value:await invoke(items[index],index)};}
   catch(reason){results[index]={status:'rejected',reason};if(stopOn(reason))stop=reason;}
  }
 }
 await Promise.all(Array.from({length:Math.min(slots,items.length)},worker));return results;
}
