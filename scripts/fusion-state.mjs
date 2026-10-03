import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isMain} from './platform.mjs';
import {config,selectExecutor,EXECUTORS,CAP} from './executor-config.mjs';
import {adapter} from './adapters/index.mjs';
import {route} from './router.mjs';
import {atomic,immutable,read,repo,snapshot,changes} from './artifact.mjs';
import {acquire,assertLease,release} from './writer-lease.mjs';
import * as contract from './contracts.mjs';

// Opus 리드 상태 기계. 원칙: 일꾼에게 예산이 남아 있는 한 리드는 코드를 만지지 않는다.
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
 const writerHeld=()=>fs.existsSync(path.join(dir,'locks/writer.json'));
 const phase=(...values)=>{if(!values.includes(s.phase))throw Error('Invalid phase '+s.phase+' for '+action);};
 try {
  s=fs.existsSync(sf)?read(sf):null;
  if(action==='init') {
   const configuration=config(root);
   const requested=selectExecutor(configuration,input.executor);
   if(s&&!['CLOSE','ARCHIVED'].includes(s.phase))throw Error('Existing unfinished task; inspect/recover');
   contract.brief(input);
   if(writerHeld())throw Error('Existing writer; recover first');
   if(fs.existsSync(path.join(dir,'tasks',input.task_id)))throw Error('Task ID already used');
   // auto면 router가 고르고, 명시 지정이면 그 일꾼을 맨 앞에 두고 router 순서를 예비로 붙인다.
   let routing;
   if(requested==='auto')routing={mode:'auto',...route(root,configuration,input)};
   else {const r=route(root,configuration,input,{probe:false});routing={mode:'explicit',...r,executor:requested,candidates:[requested,...r.candidates.filter(e=>e!==requested)],reason:'lead override; router suggested '+r.executor+' ('+r.reason+')'};}
   const executor=routing.executor;
   const base=snapshot(root);
   s={schema_version:4,architecture:'opus-lead-v0.3',configuration,routing,initial_executor:executor,active_executor:executor,owner:null,
    attempts:{grok:0,antigravity:0,sonnet:0,lead:0},sessions:{grok:null,antigravity:null,sonnet:null},task_id:input.task_id,phase:'PLAN',
    lead:configuration.lead,lead_target_model:configuration.lead_model,lead_model:null,iteration:0,base_commit:base.head,baseline_dirty:!!base.status,
    writer:null,reviews:[],escalations:[],result_failures:0,started_at:new Date().toISOString()};
   art('initial-brief.json',input);art('baseline.json',base);save();return s;
  }
  if(!s)throw Error('Initialize first');
  if(action==='archive') {
   if(input.quiescent!==true||typeof input.reason!=='string'||!input.reason.trim())throw Error('Archive requires stopped processes and a reason');
   if(writerHeld())assertLease(root,input.token);
   art(`archive-${crypto.randomUUID()}.json`,{reason:input.reason,previous:s,current:snapshot(root)});
   if(writerHeld())release(root,input.token);
   s.writer=null;s.phase='ARCHIVED';save();return s;
  }
  // 다른 스키마(main 브랜치의 Codex 리드 작업 포함)는 재해석하지 않는다.
  if(s.schema_version!==4){
   if(action==='status')return {...s,legacy:true,next_action:'Confirm all processes stopped and archive with evidence; do not reinterpret an active lease'};
   throw Error('LEGACY_STATE: inspect status; confirm stopped writers then archive with a reason before creating an Opus-led task');
  }
  const pool=()=>s.configuration.external.available;
  const budget=o=>s.attempts[o]<CAP[o];
  const idleWorkers=()=>pool().filter(e=>budget(e));
  // 일꾼이 하나라도 남아 있으면 리드 takeover는 금지.
  const takeoverOrBlocked=()=>s.configuration.lead_takeover&&budget('lead')&&!idleWorkers().length?'TAKEOVER_REQUIRED':'BLOCKED';
  // 현재 일꾼이 소진되거나 반복 실패하면: 다른 일꾼 → 같은 일꾼 재시도 → 리드 takeover → BLOCKED 순.
  const exhausted=()=>{
   if(s.owner==='lead')return 'BLOCKED';
   if(pool().some(e=>e!==s.owner&&budget(e)))return 'ALTERNATIVE_REQUIRED';
   if(budget(s.owner))return 'REDO';
   return takeoverOrBlocked();
  };
  if(action==='status')return {...s,lease_present:writerHeld(),current_digest:snapshot(root).digest,remaining:Object.fromEntries(Object.keys(CAP).map(k=>[k,CAP[k]-s.attempts[k]]))};
  if(action==='begin') {
   phase('PLAN','REDO','ALTERNATIVE_REQUIRED','TAKEOVER_REQUIRED');contract.brief(input);
   if(input.task_id!==s.task_id)throw Error('Task ID mismatch');
   let owner;
   if(s.phase==='TAKEOVER_REQUIRED'){
    owner='lead';
    if(typeof input.takeover_reason!=='string'||!input.takeover_reason.trim())throw Error('Takeover requires a recorded reason');
   } else if(s.phase==='ALTERNATIVE_REQUIRED'){
    // 지정이 없으면 배치표에서 방금 반려된 일꾼 다음 순번부터 돌아가며 예산 있는 일꾼을 투입한다.
    const pick=input.executor===undefined||input.executor==='auto';
    const order=[...new Set([...s.routing.candidates,...pool()])].filter(e=>pool().includes(e));
    const at=order.indexOf(s.owner);
    owner=pick?[...order.slice(at+1),...order.slice(0,at+1)].find(e=>e!==s.owner&&budget(e)):selectExecutor(s.configuration,input.executor);
    if(!owner)throw Error('No alternative executor with budget');
    if(owner===s.owner)throw Error('Alternative requires a different executor than the one just rejected');
   } else {
    owner=s.phase==='PLAN'?s.active_executor:s.owner;
    if(input.executor!==undefined&&input.executor!==owner)throw Error('Executor switch requires an alternative verdict');
   }
   if(s.phase!=='PLAN'&&owner!=='lead')contract.feedback(input.lead_feedback);
   if(!budget(owner))throw Error(owner+' round cap reached');
   const round=s.iteration+1;
   const a=owner==='lead'?null:adapter(owner);
   const session=a?(s.sessions[owner]??a.newSession()):null;
   const resume=!!(a&&s.sessions[owner]);
   const options=s.configuration.executors[owner]??{};
   const prompt_file=path.join(taskdir(),`prompt-${round}.txt`);
   const brief={...input,repo_root:root,round};
   // 프로브와 인자 검증은 lease 획득·시도 소모 전에 끝낸다.
   const cli=a?a.probe(options):null;
   if(a)a.dispatch(brief,{token:'pending',owner},{session,resume,probe:cli,promptFile:prompt_file,options});
   const lease=acquire(root,s.task_id,round,owner);
   if(s.owner!==owner)s.result_failures=0;
   s.phase='EXECUTING';s.writer=lease;s.iteration=round;s.owner=owner;s.attempts[owner]++;
   if(a){s.active_executor=owner;if(session)s.sessions[owner]=session;}
   save();
   art(`brief-${round}.json`,input);art(`base-${round}.json`,snapshot(root));
   const request=a?{transport:'executor-cli',executor:owner,command:process.execPath,args:[fileURLToPath(new URL('./executor-bridge.mjs',import.meta.url)),root],
     ...a.dispatch(brief,lease,{session,resume,probe:cli,promptFile:prompt_file,options}),task_id:s.task_id,round,token:lease.token}
    :{transport:'lead-takeover',brief,token:lease.token};
   art(`dispatch-${round}.json`,request);return request;
  }
  if(action==='finish') {
   phase('EXECUTING');assertLease(root,input.token);
   if(input.quiescent!==true)throw Error('Confirm worker and children stopped');
   const n=s.iteration,base=read(path.join(taskdir(),`base-${n}.json`)),post=snapshot(root);
   art(`raw-result-${n}.json`,input.result??null);art(`post-${n}.json`,post);
   // 브리지가 기록한 세션 ID를 묶는다. 이미 다른 ID가 있으면 바꾸지 않는다.
   const sessionFile=path.join(taskdir(),`session-${n}.json`);
   if(s.owner!=='lead'&&fs.existsSync(sessionFile)){
    const id=read(sessionFile).session_id;
    if(s.sessions[s.owner]&&s.sessions[s.owner]!==id)throw Error('Session rebinding requires recovery');
    s.sessions[s.owner]=id;
   }
   const changed=changes(base,post);const errors=[];
   try{contract.result(input.result,s.task_id,n);}catch(e){errors.push(e.message);}
   const brief=read(path.join(taskdir(),`brief-${n}.json`));
   const outside=changed.filter(f=>!brief.scope.paths.some(p=>f===p||f.startsWith(p+'/')));
   if(outside.length)errors.push('Out of scope: '+outside.join(', '));
   if(post.head!==base.head||post.index_hash!==base.index_hash)errors.push('HEAD/index changed');
   if(!errors.length&&JSON.stringify([...new Set(input.result.files_changed)].sort())!==JSON.stringify(changed))errors.push('Declared changes differ from snapshot');
   s.post_digest=post.digest;s.last_errors=errors;
   art(`validation-${n}.json`,{changed,errors});
   if(errors.length){s.result_failures++;s.phase='RECOVERY_REQUIRED';save();return s;}
   s.result_failures=0;s.phase='REVIEW';save();
   release(root,input.token);s.writer=null;save();return s;
  }
  if(action==='review') {
   phase('REVIEW');contract.review(input);
   if(writerHeld())throw Error('Writer still present; recover');
   if(snapshot(root).digest!==s.post_digest){s.phase='RECOVERY_REQUIRED';save();throw Error('Tree drift before review');}
   const raw=read(path.join(taskdir(),`raw-result-${s.iteration}.json`));
   if(input.verdict==='pass'&&raw.status!=='complete')throw Error('Incomplete result cannot pass');
   const verdict=input.verdict==='escalate'?'alternative':input.verdict;
   if(verdict==='takeover'&&idleWorkers().length)throw Error('Workers still have budget ('+idleWorkers().join(', ')+'); make them work instead of taking over');
   if(verdict==='alternative'&&(s.owner==='lead'||!pool().some(e=>e!==s.owner&&budget(e))))throw Error('No alternative executor with budget; redo or report');
   const record={...input,verdict,owner:s.owner,round:s.iteration};
   art(`review-${s.iteration}.json`,record);s.reviews.push(record);
   const e=contract.escalation(s.reviews.filter(r=>r.owner===s.owner),s.result_failures,input.complexity??{});
   const from=s.phase;
   if(verdict==='pass')s.phase='VERIFY';
   else if(verdict==='decision')s.phase='DECISION_REQUIRED';
   else if(verdict==='takeover')s.phase=takeoverOrBlocked();
   else if(verdict==='alternative')s.phase='ALTERNATIVE_REQUIRED';
   // 같은 반려 사유를 두 번 받은 일꾼은 다른 일꾼이 있으면 교체한다.
   else if(s.owner==='lead')s.phase='BLOCKED';
   else if(!budget(s.owner)||(e.hard&&pool().some(x=>x!==s.owner&&budget(x))))s.phase=exhausted();
   else s.phase='REDO';
   if(!['VERIFY','REDO','DECISION_REQUIRED'].includes(s.phase))s.escalations.push({...e,from:s.owner,to:s.phase,round:s.iteration,reason:input.rationale,prior_phase:from});
   s.escalation_assessment=e;save();return s;
  }
  if(action==='decide') {
   phase('DECISION_REQUIRED');
   if(typeof input.decision!=='string'||!input.decision.trim())throw Error('Record architecture decision');
   art(`decision-${s.iteration}.json`,input);s.phase=s.owner!=='lead'&&budget(s.owner)?'REDO':exhausted();save();return s;
  }
  if(action==='verify') {
   phase('VERIFY');
   if(!Array.isArray(input.tests)||!input.tests.length||!input.tests.every(t=>typeof t.command==='string'&&t.command.trim()&&t.status==='pass')||input.acceptance_satisfied!==true)throw Error('Passing verification evidence required');
   if(snapshot(root).digest!==s.post_digest){s.phase='RECOVERY_REQUIRED';save();throw Error('Tree drift during verification');}
   art('verification.json',input);s.phase='CLOSE';s.closed_at=new Date().toISOString();save();return s;
  }
  if(action==='recover') {
   if(input.quiescent!==true||typeof input.reason!=='string'||!input.reason.trim())throw Error('Recovery requires stopped writers and rationale');
   phase('PLAN','REDO','ALTERNATIVE_REQUIRED','TAKEOVER_REQUIRED','EXECUTING','RECOVERY_REQUIRED','REVIEW');
   if(['PLAN','REDO','ALTERNATIVE_REQUIRED','TAKEOVER_REQUIRED'].includes(s.phase)) {
    // 디스패치 전에 컨트롤러가 죽어 남은 고아 lease. 소모된 시도는 되돌리지 않는다.
    const orphan=assertLease(root,input.token);
    if(orphan.task_id!==s.task_id)throw Error('Orphan lease belongs to another task');
    if(orphan.round>s.iteration)s.attempts[orphan.owner]++;
    s.owner=orphan.owner;s.iteration=Math.max(s.iteration,orphan.round);
   }
   art(`recovery-${Date.now()}.json`,{...input,current:snapshot(root),prior_phase:s.phase});
   s.phase='RECOVERY_REQUIRED';save();
   if(writerHeld())release(root,input.token);
   s.writer=null;
   s.phase=s.result_failures>=2||s.owner==='lead'||!budget(s.owner)?exhausted():'REDO';
   save();return s;
  }
  throw Error('Unknown action '+action);
 } finally {fs.unlinkSync(guard);}
}
if(isMain(import.meta.url)) {
 try {
  const [action,root,file,...flags]=process.argv.slice(2);
  if(!action||!root)throw Error('Usage: node fusion-state.mjs ACTION REPO_ROOT [INPUT.json] [--executor NAME]');
  const input=file?read(file):{};
  if(flags.length){if(action!=='init'||flags.length!==2||flags[0]!=='--executor')throw Error('Only init accepts --executor NAME');input.executor=flags[1];}
  console.log(JSON.stringify(run(root,action,input),null,2));
 }catch(e){console.error(e.message);process.exitCode=1;}
}
