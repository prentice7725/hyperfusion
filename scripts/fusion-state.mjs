import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isMain} from './platform.mjs';
import {config,selectExecutor,EXECUTORS,CAP,CONSULT_CAP,REVIEWERS,REVIEW_RUNS_PER_ROUND} from './executor-config.mjs';
import {adapter} from './adapters/index.mjs';
import {route} from './router.mjs';
import {atomic,immutable,read,repo,snapshot,changes,git} from './artifact.mjs';
import {notify} from './notify.mjs';
import {workspaceOf,propose,deriveFromState} from './memory-policy.mjs';

const BRIDGE=fileURLToPath(new URL('./executor-bridge.mjs',import.meta.url));
const CONTEXT_DIFF_MAX=12000;
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
  const memoryOn=()=>!!workspaceOf(s.configuration);
  // 작업이 끝나면(CLOSE/BLOCKED) 실패→원인→수정→검증 흐름을 기억 후보로 뽑아 장부에 올린다.
  const harvest=()=>{if(memoryOn())for(const c of deriveFromState(s,taskdir()))propose(root,s.task_id,[c],{role:'protocol',verified:c.verified});};
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
  if(action==='status')return {...s,lease_present:writerHeld(),current_digest:snapshot(root).digest,remaining:Object.fromEntries(Object.keys(CAP).map(k=>[k,CAP[k]-s.attempts[k]])),consult_remaining:CONSULT_CAP-(s.consult_runs??0)};
  // 상담 중에는 다음 수를 두지 않는다. 결과를 보고 판단한다.
  if(s.open_consult&&action!=='consult-finish')throw Error('Consult '+s.open_consult.id+' in progress; run its bridge, then consult-finish');
  // 위임 리뷰: 이번 라운드를 구현하지 않은 다른 모델이 읽기 전용으로 판정한다. 상담 장치를 그대로 쓴다.
  if(action==='delegate-review'){action='consult';input={...input,mode:'review'};}
  if(action==='consult') {
   const mode=input.mode;
   if(!['advisor','committee','review'].includes(mode))throw Error('Consult mode must be advisor, committee or review');
   if(mode==='review')phase('REVIEW');else phase('PLAN','REVIEW','REDO','ALTERNATIVE_REQUIRED','DECISION_REQUIRED');
   if(writerHeld())throw Error('Writer still present; recover');
   if(mode==='review'){
    input={question:`Review round ${s.iteration} by ${s.owner} against every success criterion and give the verdict.`,...input};
    if((s.review_runs?.[s.iteration]??0)>=REVIEW_RUNS_PER_ROUND)throw Error(`Delegated review cap reached for round ${s.iteration}; review it yourself`);
   }
   if(typeof input.question!=='string'||!input.question.trim())throw Error('Consult requires a concrete question');
   if(input.focus!==undefined&&!(Array.isArray(input.focus)&&input.focus.every(x=>typeof x==='string')))throw Error('Invalid focus');
   const size=mode==='committee'?2:1;
   if(mode!=='review'&&(s.consult_runs??0)+size>CONSULT_CAP)throw Error(`Consult cap reached (${CONSULT_CAP} member runs per task)`);
   // 상담·리뷰에는 구현 일꾼 외에 리뷰 전용 인력(Codex)도 부를 수 있다.
   const hire=e=>{
    if(e==='auto'||!REVIEWERS.includes(e))throw Error('Consult executors must be named from '+REVIEWERS.join(', '));
    if(!pool().includes(e)&&!s.configuration.review.reviewers.includes(e))throw Error('Not enabled in external.available or review.reviewers: '+e);
    return e;
   };
   let picks,explicit=input.executors!==undefined;
   if(explicit){
    if(!Array.isArray(input.executors)||input.executors.length!==size||new Set(input.executors).size!==size)throw Error(`${mode} needs ${size} distinct executor(s)`);
    picks=input.executors.map(hire);
    // 자기 작업은 자기가 리뷰하지 않는다.
    if(mode==='review'&&picks.includes(s.owner))throw Error(`${s.owner} implemented round ${s.iteration}; pick a different reviewer`);
   } else if(mode==='review'){
    picks=s.configuration.review.reviewers.filter(e=>e!==s.owner&&!(s.review_failed?.[s.iteration]??[]).includes(e));
   } else {
    // 기본: 방금 일한 일꾼은 뒤로. 자기 작업을 자기가 검사하지 않게 하고, 위원회는 서로 다른 모델로 꾸린다.
    const order=[...new Set([...s.routing.candidates,...pool()])].filter(e=>pool().includes(e));
    picks=[...order.filter(e=>e!==s.owner),...order.filter(e=>e===s.owner)];
   }
   const members=[];
   for(const e of picks){
    if(members.length===size)break;
    let cli;try{cli=adapter(e).probe(s.configuration.executors[e]??{});}catch(err){if(explicit)throw err;continue;}
    members.push({member:'m'+(members.length+1),executor:e,cli});
   }
   if(members.length<size)throw Error(`ADAPTER_UNAVAILABLE: ${mode} needs ${size} installed ${mode==='review'?'reviewer other than '+s.owner:'worker(s)'}`);
   const id='c'+((s.consults?.length??0)+1);
   const n=s.iteration,opt=name=>{const f=path.join(taskdir(),name);return fs.existsSync(f)?read(f):null;};
   const latest=opt(`brief-${n}.json`)??opt('initial-brief.json');
   const changed=n?(opt(`validation-${n}.json`)?.changed??[]):[];
   // 읽기 전용 위원(Sonnet은 Bash도 없다)이 diff를 볼 수 있게 직접 넣어 준다. 새 파일은 목록만 있으므로 직접 읽어야 한다.
   const diff=changed.length?git(root,['diff','HEAD','--',...changed]):'';
   const context={round:n,last_worker:s.owner,last_result:n?opt(`raw-result-${n}.json`):null,changed_files:changed,
    diff:diff.slice(0,CONTEXT_DIFF_MAX),diff_truncated:diff.length>CONTEXT_DIFF_MAX,diff_note:'git diff HEAD of changed files; untracked new files are not shown, read them directly',
    recent_reviews:s.reviews.slice(-3).map(r=>({owner:r.owner,round:r.round,verdict:r.verdict,blocking_criteria:r.blocking_criteria,rationale:r.rationale}))};
   // 모든 위원의 dispatch를 먼저 만든다. 하나라도 실패하면(예: Windows 명령줄 길이) 상태를 바꾸지 않는다.
   const requests=members.map(m=>{
    const a=adapter(m.executor);
    const brief={task_id:s.task_id,round:n,repo_root:root,objective:latest.objective,scope:latest.scope,constraints:latest.constraints,success_criteria:latest.success_criteria,allowed_actions:['read'],...(latest.prior_experience?{prior_experience:latest.prior_experience}:{}),
     consult:{id,mode,member:m.member,question:input.question,focus:input.focus??[],context}};
    const d=a.dispatch(brief,{token:'consult',owner:m.executor},{session:a.newSession(),resume:false,probe:m.cli,promptFile:path.join(taskdir(),`prompt-consult-${id}-${m.member}.txt`),options:s.configuration.executors[m.executor]??{}});
    return [m.member,{transport:'executor-cli',kind:'consult',executor:m.executor,...d,task_id:s.task_id,consult_id:id,member:m.member}];
   });
   const base=snapshot(root),roster=members.map(({member,executor})=>({member,executor}));
   art(`consult-${id}-base.json`,base);
   for(const [member,request] of requests)art(`consult-${id}-${member}.json`,request);
   art(`consult-${id}.json`,{id,mode,question:input.question,focus:input.focus??[],members:roster,phase:s.phase});
   if(mode==='review')s.review_runs={...(s.review_runs??{}),[n]:(s.review_runs?.[n]??0)+1};
   else s.consult_runs=(s.consult_runs??0)+size;
   s.hint=null;
   s.open_consult={id,mode,members:roster,digest:base.digest,started_at:new Date().toISOString()};
   save();
   return {consult_id:id,mode,members:roster,command:process.execPath,args:[BRIDGE,root,'--consult',id],next_action:'run command once, then consult-finish with quiescent:true'};
  }
  if(action==='consult-finish') {
   const open=s.open_consult;
   if(!open)throw Error('No open consult');
   if(input.quiescent!==true)throw Error('Confirm consult workers and children stopped');
   const base=read(path.join(taskdir(),`consult-${open.id}-base.json`)),now=snapshot(root);
   // 읽기 전용 약속을 실제로 지켰는지 전후 스냅샷으로 확인한다. 어기면 그 답변은 버린다.
   const violated=now.digest!==base.digest,touched=changes(base,now);
   const results=[];
   const members=open.members.map(m=>{
    const f=path.join(taskdir(),`consult-result-${open.id}-${m.member}.json`);
    if(!fs.existsSync(f))return {...m,ok:false};
    const r=read(f);if(!violated)results.push({...r,executor:m.executor});
    return {...m,ok:!violated,recommended_verdict:r.recommended_verdict,confidence:r.confidence,findings:r.findings.length,blockers:r.findings.filter(x=>x.severity==='blocker').length};
   });
   const record={id:open.id,mode:open.mode,members,violated,touched,finished_at:new Date().toISOString()};
   art(`consult-${open.id}-finish.json`,record);
   s.consults=[...(s.consults??[]),record];s.open_consult=null;
   if(violated){s.phase='RECOVERY_REQUIRED';s.last_errors=['Consult modified the tree: '+(touched.join(', ')||'HEAD/index')];}
   let applied=null;
   if(open.mode==='review'&&!violated){
    const m=members[0],r=results[0];
    if(!r){
     // 리뷰어가 결과를 못 냈으면 다음 리뷰어를 쓰거나 리드가 직접 본다.
     s.review_failed={...(s.review_failed??{}),[s.iteration]:[...(s.review_failed?.[s.iteration]??[]),m.executor]};
     applied={status:'reviewer_failed',executor:m.executor,next_action:'delegate-review again (another reviewer) or review it yourself'};
    } else {
     const raw=read(path.join(taskdir(),`raw-result-${s.iteration}.json`));
     let verdict=r.recommended_verdict,blocking=r.blocking_criteria;
     // 일꾼이 미완료라고 보고한 라운드는 리뷰어가 pass를 줘도 통과시킬 수 없다.
     if(verdict==='pass'&&raw.status!=='complete'){verdict='redo';blocking=['worker reported '+raw.status];}
     const delegated={verdict,rationale:r.summary,blocking_criteria:blocking,commands_run:['delegated read-only review by '+m.executor],independent_diff_review:true,
      reviewed_by:m.executor,consult_id:open.id,confidence:r.confidence,findings:r.findings};
     if(s.configuration.review.auto_apply){
      try{applyReview(delegated);applied={status:'applied',verdict,reviewed_by:m.executor,phase:s.phase};}
      catch(e){s.pending_review=delegated;applied={status:'needs_lead',error:e.message,next_action:'review with {"adopt":true} after fixing, or give your own verdict'};}
     } else {s.pending_review=delegated;applied={status:'pending',next_action:'review with {"adopt":true} or your own verdict'};}
    }
   }
   save();
   return {...record,results,phase:s.phase,...(applied?{review:applied}:{})};
  }
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
   // "@review": 직전 리뷰의 반려 사유와 파일·줄 지적을 그대로 명령서로 쓴다. 리드가 diff를 다시 읽지 않아도 된다.
   if(input.lead_feedback==='@review'){
    const last=s.reviews.at(-1);
    const items=[...(last?.findings??[]).filter(f=>['blocker','major'].includes(f.severity)).map(f=>({file:f.file,...(f.line?{line:f.line}:{}),comment:`${f.issue}${f.suggestion?' → '+f.suggestion:''}`})),
     ...(last?.blocking_criteria??[]).map(c=>`Unmet: ${c}${last.rationale?' ('+last.rationale.slice(0,200)+')':''}`)];
    if(!items.length)throw Error('Last review has no findings or blocking criteria to forward; write lead_feedback yourself');
    input={...input,lead_feedback:items};
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
   s.hint=null;
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
   // 일꾼이 제안한 교훈은 장부에만 올린다. 리드가 승인해야 AnchorMind에 저장된다.
   if(memoryOn()&&input.result.memory_candidates?.length)propose(root,s.task_id,input.result.memory_candidates,{role:'worker',executor:s.owner,round:n});
   s.result_failures=0;s.phase='REVIEW';save();
   release(root,input.token);s.writer=null;save();return s;
  }
  // 판정을 적용한다. 리드가 직접 내린 판정이든 위임 리뷰어의 판정이든 같은 규칙을 거친다.
  function applyReview(input) {
   contract.review(input);
   if(snapshot(root).digest!==s.post_digest){s.phase='RECOVERY_REQUIRED';save();throw Error('Tree drift before review');}
   const raw=read(path.join(taskdir(),`raw-result-${s.iteration}.json`));
   if(input.verdict==='pass'&&raw.status!=='complete')throw Error('Incomplete result cannot pass');
   const verdict=input.verdict==='escalate'?'alternative':input.verdict;
   if(verdict==='takeover'&&input.reviewed_by!=='lead')throw Error('Only the lead can order a takeover');
   if(verdict==='takeover'&&idleWorkers().length)throw Error('Workers still have budget ('+idleWorkers().join(', ')+'); make them work instead of taking over');
   if(verdict==='alternative'&&(s.owner==='lead'||!pool().some(e=>e!==s.owner&&budget(e))))throw Error('No alternative executor with budget; redo or report');
   const record={...input,verdict,owner:s.owner,round:s.iteration};
   art(`review-${s.iteration}.json`,record);s.reviews.push(record);s.pending_review=null;
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
   // 같은 실수가 반복돼 교체할 때는 바로 다음 일꾼에게 넘기기 전에 위원회로 원인부터 보라고 권한다.
   s.hint=e.hard&&s.phase==='ALTERNATIVE_REQUIRED'&&(s.consult_runs??0)+2<=CONSULT_CAP?{suggest:'consult',mode:'committee',reason:'repeated failure; get a root cause and plan before the next worker'}:null;
   if(s.phase==='BLOCKED')harvest();
   if(['BLOCKED','TAKEOVER_REQUIRED','DECISION_REQUIRED'].includes(s.phase))notify(`HyperFusion ${s.task_id}`,`needs the lead: ${s.phase} after ${s.owner} round ${s.iteration}`,{priority:'high'});
   s.escalation_assessment=e;save();return s;
  }
  if(action==='review') {
   phase('REVIEW');
   if(writerHeld())throw Error('Writer still present; recover');
   // adopt: 보류된 위임 판정을 그대로 채택. 아니면 리드 자신의 판정(위임 판정이 있었다면 덮어쓴 것으로 기록).
   if(input.adopt===true){
    if(!s.pending_review)throw Error('No pending delegated review to adopt');
    return applyReview({...s.pending_review,adopted_by_lead:true});
   }
   const overridden=s.pending_review?{overrode:s.pending_review.reviewed_by,overrode_verdict:s.pending_review.verdict}:{};
   return applyReview({...input,reviewed_by:'lead',...overridden});
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
   art('verification.json',input);s.phase='CLOSE';s.closed_at=new Date().toISOString();save();
   harvest();return s;
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
