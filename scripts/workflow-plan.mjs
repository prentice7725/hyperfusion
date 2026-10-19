import fs from 'node:fs';
import path from 'node:path';
import {read,hash,immutable,snapshot,changes} from './artifact.mjs';
import {controlPath} from './control-dir.mjs';
import {brief,safePath} from './contracts.mjs';
import {validateLimits} from './budgets.mjs';
import {criterionIds} from './ac-trace.mjs';
import {ignoredManifest,ignoredChanges} from './acceptance.mjs';

const fail=message=>{throw Error('WORKFLOW: '+message);};
const tasks=p=>p.milestones.flatMap((m,index)=>m.tasks.map(t=>({...t,milestone:m.id,milestone_index:index})));
const fields=['id','kind','difficulty','depends_on','workspace','integrates','scope','success_criteria','acceptance_commands','acceptance_map','acceptance_timeout_ms','acceptance_artifacts','verification','acceptance_baseline_green','limits'];
export const workflowEnabled=p=>p.milestones.some(m=>m.tasks.some(t=>t.depends_on!==undefined||t.integrates!==undefined||t.workspace!==undefined));
const spec=t=>Object.fromEntries(fields.filter(k=>t[k]!==undefined).map(k=>[k,t[k]]));
export const workflowDefinition=p=>p.milestones.map(m=>({id:m.id,tasks:m.tasks.map(spec)}));
const canonical=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
export const workflowDigest=p=>hash(canonical(workflowDefinition(p)));

export function validateWorkflow(p) {
 if(!workflowEnabled(p))return null;
 const list=tasks(p),byId=new Map();
 if(list.length>200)fail('at most 200 static tasks');
 for(const t of list){
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(t.id??'')||byId.has(t.id))fail('duplicate or invalid task id');
  byId.set(t.id,t);
  if(!Array.isArray(t.depends_on??[])||(t.depends_on??[]).length>200||new Set(t.depends_on??[]).size!==(t.depends_on??[]).length)fail(t.id+' invalid dependencies');
  if(!['shared','isolated'].includes(t.workspace??'shared'))fail(t.id+' invalid workspace');
  if(!t.scope?.paths?.length||!t.scope.paths.every(safePath))fail(t.id+' needs bounded scope');
  brief({task_id:t.id,objective:t.title,scope:t.scope,constraints:[],allowed_actions:['read','edit','test'],...spec(t)});
  if(!t.acceptance_commands?.length||!criterionIds(t.success_criteria).length||criterionIds(t.success_criteria).some(id=>!t.acceptance_map?.[id]?.length))fail(t.id+' needs command evidence for every AC');
  validateLimits(t.limits);
  if(!Number.isSafeInteger(t.limits?.max_wall_ms)||t.limits.max_wall_ms>86400000)fail(t.id+' needs max_wall_ms <= 86400000');
 }
 const edges=t=>[...(t.depends_on??[]),...(t.integrates?[t.integrates]:[])];
 for(const t of list){
  for(const id of edges(t)){
   const parent=byId.get(id);
   if(!parent||id===t.id||parent.milestone_index>t.milestone_index)fail(t.id+' missing, self or later-milestone dependency: '+id);
  }
  if(t.integrates){
   const child=byId.get(t.integrates);
   if((t.workspace??'shared')!=='shared'||child.workspace!=='isolated'||child.milestone!==t.milestone||(t.depends_on??[]).includes(child.id))fail(t.id+' invalid integration edge (integration must share the child milestone)');
   if(child.scope.paths.some(p=>!t.scope.paths.some(q=>p===q||p.startsWith(q+'/')))||child.acceptance_commands.some(c=>!t.acceptance_commands.includes(c)))fail(t.id+' integration must cover child scope and acceptance commands');
  }
 }
 for(const t of list)if(t.workspace==='isolated'&&list.filter(i=>i.integrates===t.id).length!==1)fail(t.id+' needs exactly one integration task in the same milestone');
 const seen=new Set(),active=new Set(),order=[];
 function visit(t){if(active.has(t.id))fail('cyclic dependencies');if(seen.has(t.id))return;active.add(t.id);edges(t).forEach(id=>visit(byId.get(id)));active.delete(t.id);seen.add(t.id);order.push(t.id);}
 list.forEach(visit);
 return {revision:1,digest:workflowDigest(p),order,definition:workflowDefinition(p)};
}

export function freezeWorkflow(root,p) {
 const plan=validateWorkflow(p);if(!plan)return;
 const file=`workflow-plan-${p.revision}.json`;
 const target=controlPath(root,file);
 if(fs.existsSync(target)){if(canonical(read(target))!==canonical(plan))fail('existing frozen artifact differs');}
 else immutable(target,plan);
 p.workflow={revision:1,file,digest:plan.digest};
}
export function assertWorkflow(root,p) {
 if(!p)fail('project missing');
 if(!p.workflow){if(workflowEnabled(p)||fs.existsSync(controlPath(root,`workflow-plan-${p.revision}.json`)))fail('plan is not frozen; approval required');return null;}
 if(!/^workflow-plan-\d+\.json$/.test(p.workflow.file??''))fail('invalid frozen plan reference');
 const frozen=read(controlPath(root,p.workflow.file));
 if(frozen.digest!==p.workflow.digest||hash(canonical(frozen.definition))!==frozen.digest||workflowDigest(p)!==frozen.digest)fail('frozen plan drift');
 return frozen;
}
const maybe=file=>{try{return read(file);}catch{return null;}};
const closeFile=(root,id)=>controlPath(root,'workflow',`close-${id}.json`);
function closed(root,p,id) {
 const r=maybe(closeFile(root,id));
 return r?.digest===p.workflow.digest&&r.state?.task_id===id&&r.state.phase==='CLOSE'&&!!r.state.ended_at&&!r.state.open_consult&&!r.state.writer?r:null;
}
function integrated(root,p,id) {
 const r=maybe(controlPath(root,'workflow',`integration-${id}.json`));
 const task=tasks(p).find(t=>t.id===r?.integration_task_id),parent=r&&closed(root,p,r.integration_task_id);
 return r?.revision===1&&r.digest===p.workflow.digest&&r.task_id===id&&task?.integrates===id&&parent?.workspace===root&&parent.state.post_digest===r.parent_digest&&closed(root,p,id)?r:null;
}
export const workflowIntegrated=(root,p,id)=>!!integrated(root,p,id);
export function workflowReadiness(root,p) {
 const frozen=assertWorkflow(root,p);if(!frozen)return null;
 const list=tasks(p),byId=new Map(list.map(t=>[t.id,t]));
 const running=list.filter(t=>['active','reserved'].includes(t.status)).map(t=>t.id);
 // Init may have saved controller state before project metadata during a crash.
 const controller=maybe(controlPath(root,'state.json'));
 if(controller?.project?.workflow_digest===p.workflow.digest&&!['CLOSE','BLOCKED','ARCHIVED'].includes(controller.phase))running.push(controller.task_id);
 const active=p.milestones.find(m=>m.status==='active');
 const entries=list.map(t=>{
  const reasons=[];
  if(p.status!=='ACTIVE')reasons.push('PROJECT_NOT_ACTIVE');
  if(t.milestone!==active?.id)reasons.push('CHECKPOINT_PENDING');
  if(t.status!=='planned')reasons.push('TASK_'+String(t.status).toUpperCase());
  if(running.length)reasons.push('IMPLEMENTATION_RUNNING');
  for(const id of t.depends_on??[]){const dep=byId.get(id);if(!closed(root,p,id)||dep.workspace==='isolated'&&!integrated(root,p,id))reasons.push('DEPENDENCY_UNSATISFIED:'+id);}
  if(t.integrates&&!closed(root,p,t.integrates))reasons.push('ISOLATED_CLOSE_REQUIRED:'+t.integrates);
  return {id:t.id,milestone:t.milestone,workspace:t.workspace??'shared',ready:!reasons.length,reasons};
 });
 return {revision:1,digest:frozen.digest,serial:true,order:frozen.order,ready:entries.filter(t=>t.ready).map(t=>t.id),tasks:entries};
}
export function workflowInput(root,p,t,input) {
 assertWorkflow(root,p);
 if(input.task_kind!==undefined&&input.task_kind!==t.kind||input.difficulty!==undefined&&input.difficulty!==t.difficulty)fail('brief changes frozen routing');
 const result={...input};
 for(const key of fields.filter(k=>!['id','depends_on','workspace','integrates','kind','difficulty'].includes(k))){
  const normalized=v=>key==='scope'&&v?{...v,allowed_expansion:v.allowed_expansion??'ask-lead'}:v;
  if(input[key]!==undefined&&canonical(normalized(input[key]))!==canonical(normalized(t[key])))fail('brief changes frozen '+key);
  if(t[key]!==undefined)result[key]=t[key];
 }
 return result;
}
export function assertWorkflowTask(root,p,id,workspace,{reserved=false}={}) {
 const t=tasks(p).find(t=>t.id===id);if(!t)fail('unknown task');
 if(reserved){assertWorkflow(root,p);if(t.status!=='reserved'||t.workspace_root!==workspace)fail('reservation mismatch');}
 else {const row=workflowReadiness(root,p).tasks.find(t=>t.id===id);if(!row.ready)fail(row.reasons.join(', '));}
 if((t.workspace==='isolated')===(workspace===root))fail('wrong workspace');
 return t;
}
export function recordWorkflowClose(root,p,taskId,workspace) {
 assertWorkflow(root,p);
 const existing=closed(root,p,taskId);
 if(existing){if(existing.workspace!==workspace)fail('CLOSE workspace mismatch');return;}
 const s=read(controlPath(workspace,'state.json'));
 if(s.task_id!==taskId||s.phase!=='CLOSE'||!s.ended_at||s.writer||s.open_consult||s.project?.workflow_digest!==p.workflow.digest)fail('verified CLOSE required');
 const file=closeFile(root,taskId),record={revision:1,digest:p.workflow.digest,workspace,state:s};
 if(!fs.existsSync(file))immutable(file,record);
 else if(canonical(read(file))!==canonical(record))fail('CLOSE receipt mismatch');
}
export function recordIntegration(root,p,{task_id,integration_task_id,reason}={}) {
 assertWorkflow(root,p);
 const list=tasks(p),t=list.find(t=>t.id===task_id),integration=list.find(t=>t.id===integration_task_id);
 if(t?.workspace!=='isolated'||integration?.integrates!==task_id||typeof reason!=='string'||!reason.trim())fail('explicit integration task and reason required');
 const child=closed(root,p,task_id),parent=closed(root,p,integration_task_id);
 if(!child||!parent||parent.workspace!==root)fail('both tasks need controller CLOSE receipts');
 const current=read(controlPath(root,'state.json')),tree=snapshot(root);
 if(current.task_id!==integration_task_id||current.phase!=='CLOSE'||current.post_digest!==tree.digest)fail('parent acceptance is stale');
 const a=current.acceptance,proof=a?.file&&maybe(controlPath(root,'tasks',integration_task_id,a.file));
 if(a?.tree_digest!==tree.digest||a.status!=='pass'||a.quiescent!==true||!proof?.results?.length||t.acceptance_commands.some(c=>!proof.results.some(r=>r.command===c&&r.status==='pass'&&r.quiescence?.quiescent===true)))fail('parent acceptance evidence required');
 const ignored=a.ignored_after&&maybe(controlPath(root,'tasks',integration_task_id,a.ignored_after));
 if(!ignored||ignoredChanges(ignored,ignoredManifest(root,integration.acceptance_artifacts)).length)fail('parent acceptance ignored inputs changed');
 const dir=controlPath(child.workspace,'tasks',task_id),base=read(path.join(dir,'baseline.json')),post=read(path.join(dir,`post-${child.state.iteration}.json`));
 const changed=changes(base,post);
 for(const file of changed){
  if(!t.scope.paths.some(p=>file===p||file.startsWith(p+'/')))fail('child changed outside its frozen scope');
  if(canonical(tree.files[file]??null)!==canonical(post.files[file]??null))fail('integrated file differs: '+file);
 }
 const file=controlPath(root,'workflow',`integration-${task_id}.json`),record={revision:1,digest:p.workflow.digest,task_id,integration_task_id,parent_digest:tree.digest,reason:reason.trim(),changed};
 if(fs.existsSync(file)){if(canonical(read(file))!==canonical(record))fail('integration receipt already exists');}
 else immutable(file,record);
 return record;
}
