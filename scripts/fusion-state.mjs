import fs from 'node:fs';
import crypto from 'node:crypto';
import {config,selectExecutor} from './executor-config.mjs';
import {probeClaude,claudeDispatch} from './claude-adapter.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {atomic,immutable,read,repo,snapshot,changes} from './artifact.mjs';
import {acquire,assertLease,release} from './writer-lease.mjs';
import {dispatch} from './luna-adapter.mjs';
import * as contract from './contracts.mjs';
export function run(root,action,input={}) {
 root=repo(root);
 const dir=path.join(root,'.fusion');fs.mkdirSync(path.join(dir,'locks'),{recursive:true});
 if(fs.lstatSync(dir).isSymbolicLink()||fs.lstatSync(path.join(dir,'locks')).isSymbolicLink())throw Error('Symlink protocol directory forbidden');
 const guard=path.join(dir,'locks/control.lock');
 const fd=fs.openSync(guard,'wx',0o600);fs.closeSync(fd);
 let s;
 const sf=path.join(dir,'state.json');
 const save=()=>atomic(sf,s);
 const taskdir=()=>path.join(dir,'tasks',s.task_id);
 const art=(name,v)=>immutable(path.join(taskdir(),name),v);
 const phase=(...values)=>{if(!values.includes(s.phase))throw Error('Invalid phase '+s.phase+' for '+action);};
 try {
  s=fs.existsSync(sf)?read(sf):null;
  if(action==='init') {
   const configuration=config(root);
   if(input.sidekick!==undefined&&input.sidekick!=='claude')throw Error('Luna is a review helper; use --executor for initial execution');
   const executor=selectExecutor(configuration,input.executor??input.sidekick);
   if(s&&!['CLOSE','ARCHIVED'].includes(s.phase))throw Error('Existing unfinished task; inspect/recover');
   contract.brief(input);
   if(fs.existsSync(path.join(dir,'locks/writer.json')))throw Error('Existing writer; recover first');
   if(fs.existsSync(path.join(dir,'tasks',input.task_id)))throw Error('Task ID already used');
   const base=snapshot(root);
   s={schema_version:3,architecture:'external-v0.2',configuration,initial_executor:executor,active_executor:executor,attempts:{claude:0,luna:0,astra:0},task_id:input.task_id,phase:'PLAN',lead:configuration.lead,lead_target_model:configuration.lead_model,lead_target_reasoning_effort:configuration.lead_reasoning_effort,lead_model:null,lead_reasoning_effort:null,active_sidekick:null,iteration:0,base_commit:base.head,baseline_dirty:!!base.status,writer:null,luna_session:null,claude_session:null,reviews:[],escalations:[],result_failures:0,started_at:new Date().toISOString()};
   art('initial-brief.json',input);art('baseline.json',base);save();return s;
  }
  if(!s)throw Error('Initialize first');
  if(action==='archive') {
   if(input.quiescent!==true||typeof input.reason!=='string'||!input.reason.trim())throw Error('Archive requires stopped processes and a reason');
   const token=input.token;
   if(fs.existsSync(path.join(dir,'locks/writer.json')))assertLease(root,token);
   art(`archive-${crypto.randomUUID()}.json`,{reason:input.reason,previous:s,current:snapshot(root)});
   if(fs.existsSync(path.join(dir,'locks/writer.json')))release(root,token);
   s.writer=null;s.phase='ARCHIVED';save();return s;
  }
  // Existing completed M0 tasks remain readable; new tasks always use external execution.
  if(s.schema_version!==3){
   if(action==='status')return {...s,legacy:true,next_action:'Confirm all processes stopped and archive with evidence; do not reinterpret an active lease'};
   throw Error('LEGACY_STATE: inspect status; confirm stopped writers then archive with a reason before creating a v0.2 task');
  }
  const cap=owner=>owner==='astra'?1:2;
  const remaining=()=>s.attempts[s.active_sidekick??s.active_executor]<cap(s.active_sidekick??s.active_executor);
  const exhaustedPhase=()=>s.active_sidekick==='astra'?'BLOCKED':s.active_sidekick==='luna'?(s.attempts[s.active_executor]<2?'EXTERNAL_REQUIRED':'TAKEOVER_REQUIRED'):'ALTERNATIVE_REQUIRED';
  if(action==='status') return {...s,lease_present:fs.existsSync(path.join(dir,'locks/writer.json')),current_digest:snapshot(root).digest};
  if(action==='begin') {
   phase('PLAN','REDO','HELPER_REQUIRED','EXTERNAL_REQUIRED','ALTERNATIVE_REQUIRED','TAKEOVER_REQUIRED');contract.brief(input);
   if(input.task_id!==s.task_id)throw Error('Task ID mismatch');
   let owner=s.phase==='HELPER_REQUIRED'?'luna':s.phase==='TAKEOVER_REQUIRED'?'astra':s.phase==='EXTERNAL_REQUIRED'?s.active_executor:s.active_sidekick??s.active_executor;
   if(s.phase==='ALTERNATIVE_REQUIRED'){owner=selectExecutor(s.configuration,input.executor);if(owner===s.active_executor)throw Error('Alternative requires a different executor; resume or take over explicitly');}
   else if(input.executor!==undefined&&input.executor!==s.active_executor)throw Error('Executor switch requires alternative review');
   if(owner==='astra'&&(typeof input.takeover_reason!=='string'||!input.takeover_reason.trim()))throw Error('Takeover requires a recorded reason');
   if(s.attempts[owner]>=cap(owner))throw Error(owner+' round cap reached');
   const round=s.iteration+1;
   const session=owner==='claude'?(s.claude_session??crypto.randomUUID()):s.luna_session;
   // Probe and validate transport before acquiring a writer or consuming an attempt.
   const prepared=owner==='claude'?claudeDispatch({...input,repo_root:root,round},{token:'pending',owner},session,s.attempts.claude>0,probeClaude()):null;
   const lease=acquire(root,s.task_id,round,owner);
   if(s.active_sidekick!==owner)s.result_failures=0;
   s.phase='EXECUTING';s.writer=lease;s.iteration=round;s.active_sidekick=owner;s.attempts[owner]++;
   if(owner==='claude')s.claude_session=session;
   save();
   art(`brief-${round}.json`,input);art(`base-${round}.json`,snapshot(root));
   if(!['luna','astra'].includes(owner))s.active_executor=owner;save();
   const request=owner==='astra'?{transport:'lead-takeover',brief:{...input,round,repo_root:root},token:lease.token}:owner==='claude'?claudeDispatch({...input,repo_root:root,round},lease,session,prepared.cli.resume,prepared.cli):dispatch({...input,repo_root:root,round},lease,s.luna_session);
   art(`dispatch-${round}.json`,request);return request;
  }
  if(action==='bind') {
   phase('EXECUTING');assertLease(root,input.token);
   if(typeof input.session_id!=='string'||!input.session_id.trim())throw Error('Missing session');
   const sessionKey=s.active_sidekick+'_session';
   if(s[sessionKey]&&s[sessionKey]!==input.session_id)throw Error('Session rebinding requires recovery');
   s[sessionKey]=input.session_id;save();return s;
  }
  if(action==='finish') {
   phase('EXECUTING');assertLease(root,input.token);
   if(input.quiescent!==true)throw Error('Confirm sidekick and children stopped');
   const n=s.iteration,base=read(path.join(taskdir(),`base-${n}.json`)),post=snapshot(root);
   art(`raw-result-${n}.json`,input.result);art(`post-${n}.json`,post);
   const changed=changes(base,post);let errors=[];
   try {contract.result(input.result,s.task_id,n);}catch(e){errors.push(e.message);}
   const brief=read(path.join(taskdir(),`brief-${n}.json`));
   const outside=changed.filter(f=>!brief.scope.paths.some(p=>f===p||f.startsWith(p+'/')));
   if(outside.length)errors.push('Out of scope: '+outside.join(', '));
   if(post.head!==base.head||post.index_hash!==base.index_hash)errors.push('HEAD/index changed');
   if(!errors.length&&JSON.stringify([...new Set(input.result.files_changed)].sort())!==JSON.stringify(changed))errors.push('Declared changes differ from snapshot');
   s.post_digest=post.digest;s.last_errors=errors;
   art(`validation-${n}.json`,{changed,errors});
   if(errors.length) {
    s.result_failures++;s.phase='RECOVERY_REQUIRED';save();return s;
   }
   s.result_failures=0;s.phase='REVIEW';save();
   release(root,input.token);s.writer=null;save();return s;
  }
  if(action==='review') {
   phase('REVIEW');contract.review(input);
   if(fs.existsSync(path.join(dir,'locks/writer.json')))throw Error('Writer still present; recover');
   if(snapshot(root).digest!==s.post_digest){s.phase='RECOVERY_REQUIRED';save();throw Error('Tree drift before review');}
   const r=read(path.join(taskdir(),`raw-result-${s.iteration}.json`));
   if(input.verdict==='pass'&&r.status!=='complete')throw Error('Incomplete result cannot pass');
   input={...input,sidekick:s.active_sidekick};art(`review-${s.iteration}.json`,input);s.reviews.push(input);
   const prior=s.reviews.filter(r=>r.sidekick===s.active_sidekick||(!r.sidekick&&s.active_sidekick==='luna'));
   const e=contract.escalation(prior,s.result_failures,input.complexity??{});
   if(input.verdict==='pass')s.phase='VERIFY';
   else if(input.verdict==='decision')s.phase='DECISION_REQUIRED';
   else if(input.verdict==='takeover')s.phase=s.attempts.astra<1?'TAKEOVER_REQUIRED':'BLOCKED';
   else if(input.verdict==='helper')s.phase=s.attempts.luna<2?'HELPER_REQUIRED':exhaustedPhase();
   else if(input.verdict==='resume')s.phase=s.attempts[s.active_executor]<2?'EXTERNAL_REQUIRED':'ALTERNATIVE_REQUIRED';
   else if(['escalate','alternative'].includes(input.verdict)||!remaining()){s.phase=['escalate','alternative'].includes(input.verdict)?(s.active_sidekick==='astra'?'BLOCKED':'ALTERNATIVE_REQUIRED'):exhaustedPhase();s.escalations.push({...e,from:s.active_sidekick,to:s.phase,round:s.iteration,reason:input.rationale});}
   else s.phase='REDO';
   s.escalation_assessment=e;save();return s;
  }
  if(action==='takeover') {
   phase('ALTERNATIVE_REQUIRED','EXTERNAL_REQUIRED','DECISION_REQUIRED','REDO');
   if(fs.existsSync(path.join(dir,'locks/writer.json')))throw Error('Writer still present; recover');
   if(s.attempts.astra>=1)throw Error('Takeover cap reached');
   if(typeof input.reason!=='string'||!input.reason.trim())throw Error('Takeover reason required');
   art(`takeover-decision-${s.iteration}.json`,input);s.phase='TAKEOVER_REQUIRED';save();return s;
  }
  if(action==='decide') {
   phase('DECISION_REQUIRED');
   if(typeof input.decision!=='string'||!input.decision.trim())throw Error('Record architecture decision');
   art(`decision-${s.iteration}.json`,input);s.phase=remaining()?'REDO':exhaustedPhase();save();return s;
  }
  if(action==='verify') {
   phase('VERIFY');
   if(!Array.isArray(input.tests)||!input.tests.length||!input.tests.every(t=>typeof t.command==='string'&&t.command.trim()&&t.status==='pass')||input.acceptance_satisfied!==true)throw Error('Passing verification evidence required');
   if(snapshot(root).digest!==s.post_digest){s.phase='RECOVERY_REQUIRED';save();throw Error('Tree drift during verification');}
   art('verification.json',input);s.phase='CLOSE';s.closed_at=new Date().toISOString();save();return s;
  }
  if(action==='recover') {
   if(input.quiescent!==true||typeof input.reason!=='string'||!input.reason.trim())throw Error('Recovery requires stopped writers and rationale');
   phase('PLAN','REDO','HELPER_REQUIRED','EXTERNAL_REQUIRED','ALTERNATIVE_REQUIRED','TAKEOVER_REQUIRED','EXECUTING','RECOVERY_REQUIRED','REVIEW');
   if(['PLAN','REDO','HELPER_REQUIRED','EXTERNAL_REQUIRED','ALTERNATIVE_REQUIRED','TAKEOVER_REQUIRED'].includes(s.phase)) {
    const orphan=assertLease(root,input.token);
    if(orphan.task_id!==s.task_id)throw Error('Orphan lease belongs to another task');
    if(orphan.round>s.iteration)s.attempts[orphan.owner]++;
    s.active_sidekick=orphan.owner;s.iteration=Math.max(s.iteration,orphan.round);
   }
   const current=snapshot(root);
   art(`recovery-${Date.now()}.json`,{...input,current,prior_phase:s.phase});
   s.phase='RECOVERY_REQUIRED';save();
   if(fs.existsSync(path.join(dir,'locks/writer.json')))release(root,input.token);
   s.writer=null;s.phase=s.result_failures>=2||!remaining()?exhaustedPhase():'REDO';save();return s;
  }
  throw Error('Unknown action '+action);
 } finally {fs.unlinkSync(guard);}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])) {
 try {
  const [action,root,file,...flags]=process.argv.slice(2);
  if(!action||!root)throw Error('Usage: node fusion-state.mjs ACTION REPO_ROOT [INPUT.json]');
  const input=file?read(file):{};
  if(flags.length){if(action!=='init'||flags.length!==2||!['--executor','--sidekick'].includes(flags[0]))throw Error('Only init accepts --executor NAME (--sidekick claude is a legacy alias)');input[flags[0]==='--executor'?'executor':'sidekick']=flags[1];}
  console.log(JSON.stringify(run(root,action,input),null,2));
 }catch(e){console.error(e.message);process.exitCode=1;}
}
