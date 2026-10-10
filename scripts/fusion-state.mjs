import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isMain,resolveExecutable} from './platform.mjs';
import {config,selectExecutor,CAP,APEX_ROUND_CAP,CONSULT_CAP,EXECUTORS,REVIEWERS,REVIEW_RUNS_PER_ROUND,automaticImplementer} from './executor-config.mjs';
import {adapter} from './adapters/index.mjs';
import {route} from './router.mjs';
import {atomic,immutable,read,repo,snapshot,changes,git,SAFE_DIFF} from './artifact.mjs';
import {acquire,assertLease,release} from './writer-lease.mjs';
import {notify} from './notify.mjs';
import {loadProject,saveProject,teamConfig,activeMilestone,settleTask} from './project.mjs';
import {measure} from './metrics.mjs';
import {workspaceOf,propose,deriveFromState} from './memory-policy.mjs';
import * as contract from './contracts.mjs';
import {readInput,printError} from './cli.mjs';
import {SCHEMA_VERSION,ARCHITECTURE,VERSION} from './versions.mjs';
import {assertAction,TERMINAL_PHASES,nextAction} from './state-policy.mjs';
import {report} from './report.mjs';
import {collectRunUsage} from './usage-accounting.mjs';
import {quotaReport} from './quota-policy.mjs';
import {validateLimits,assertBudget,budgetStatus} from './budgets.mjs';
import {ensureControl,isLegacy,migrate,controlRoot,controlPath,acquireLock} from './control-dir.mjs';
import {ignoredManifest,ignoredChanges,runCommands,failureFeedback} from './acceptance.mjs';
import {readRoundMonitors,formatWatch} from './worker-monitor.mjs';
import {planReview,panelSeats,reviewCoverage,takeAssignment,sameAssignment,samePlan,aggregateVerdicts,initialGrant,sameGrant,assertImplementRound,implementDispatch,makeGrant,explicitImplementation} from './review-plan.mjs';

const BRIDGE=fileURLToPath(new URL('./executor-bridge.mjs',import.meta.url));
// 상담 위원에게 직접 넣어 주는 diff의 최대 길이.
const CONTEXT_DIFF_MAX=12000;

// Opus 리드 상태 기계. 원칙: 일꾼에게 예산이 남아 있는 한 리드는 코드를 만지지 않는다.
//
// 구성
//   openControl   한 번의 호출에 필요한 상태와 보조 함수(예산, 교체 순서, 저장)를 묶는다.
//   액션 함수들    init, archive, status, consult, ... 각각 하나의 명령을 처리한다.
//   run           잠금을 잡고 알맞은 액션으로 보낸다.

function openControl(root) {
  // 제어 파일은 작업 폴더 밖에 둔다. 일꾼의 편집 도구가 닿지 않는 곳이어야 범위 검사를 믿을 수 있다.
  const dir=ensureControl(root);
  // 컨트롤러 명령끼리 겹치지 않도록 배타적으로 만든다. 이미 있으면 EEXIST로 실패한다.
  const guard=path.join(dir,'locks/control.lock');
  const releaseLock=acquireLock(guard);

  const stateFile=path.join(dir,'state.json');
  const c={root,dir,s:null,action:''};

  c.load=()=>{c.s=fs.existsSync(stateFile)?read(stateFile):null;};
  c.save=()=>atomic(stateFile,c.s);
  c.unlock=releaseLock;
  c.taskdir=()=>path.join(dir,'tasks',c.s.task_id);
  // 한 번만 쓰는 작업 산출물.
  c.art=(name,value)=>immutable(path.join(c.taskdir(),name),value);
  c.optional=name=>{
    const file=path.join(c.taskdir(),name);
    return fs.existsSync(file)?read(file):null;
  };
  c.writerHeld=()=>fs.existsSync(path.join(dir,'locks/writer.json'));

  // 일꾼 예산과 교체 순서
  c.pool=()=>c.s.configuration.external.available;
  c.budget=owner=>owner==='sol'?(c.s.apex_rounds??0)<APEX_ROUND_CAP:c.s.attempts[owner]<CAP[owner];
  // 옵트인 작업의 Sonnet/Sol은 승인 없는 자동 후보가 아니다. 예산이 남아도 구현 라운드를 열지 않는다.

  // 배치 판단은 실행 파일 존재만 확인한다. 도움말 프로브의 일시적 실패로 예산을 버리지 않는다.
  const installMemo=new Map();
  c.installError=name=>{
    if(!installMemo.has(name)){
      try{
        const a=adapter(name);
        resolveExecutable(name,a.binary());
        installMemo.set(name,null);
      } catch(err){
        installMemo.set(name,err.message);
      }
    }
    return installMemo.get(name);
  };
  // 예산이 남아 있고 설치도 돼 있어서 실제로 일을 시킬 수 있는 일꾼.
  c.canWork=name=>{
    if(c.s?.configuration?.review?.strategy==='lead-gated-adaptive'&&(name==='sonnet'||name==='sol')){
      const grant=c.s.implement_grant;
      return !!(c.budget(name)&&grant&&grant.executor===name&&grant.role==='implement'&&grant.round==null&&grant.set_by==='controller'&&!c.installError(name));
    }
    if(!automaticImplementer(c.s.configuration,name)&&!(name==='haiku'&&explicitImplementation(c.s,name)))return false;
    return c.budget(name)&&!c.installError(name);
  };
  c.unavailable=()=>Object.fromEntries(c.pool().map(e=>[e,c.installError(e)]).filter(([,message])=>message));
  c.idleWorkers=()=>c.pool().filter(c.canWork);
  // 일꾼이 하나라도 남아 있으면 리드 takeover는 금지.
  c.takeoverOrBlocked=()=>{
    const allowed=c.s.configuration.lead_takeover&&c.budget('lead')&&!c.idleWorkers().length;
    return allowed?'TAKEOVER_REQUIRED':'BLOCKED';
  };
  // 현재 일꾼이 소진되거나 반복 실패하면: 다른 일꾼 → 같은 일꾼 재시도 → 리드 takeover → BLOCKED 순.
  c.exhausted=()=>{
    if(c.s.owner==='lead')return 'BLOCKED';
    if(c.pool().some(e=>e!==c.s.owner&&c.canWork(e)))return 'ALTERNATIVE_REQUIRED';
    if(c.canWork(c.s.owner))return 'REDO';
    return c.takeoverOrBlocked();
  };
  // 작업 전체의 범위. 시작 brief와 지금까지 라운드 brief의 경로를 합친 것에 리드가 허용한 예외를 더한다.
  c.allowedPaths=()=>{
    const paths=[];
    const briefs=[c.optional('initial-brief.json'),...Array.from({length:c.s.iteration},(_,i)=>c.optional(`brief-${i+1}.json`))];
    for(const b of briefs)paths.push(...(b?.scope?.paths??[]));
    return [...paths,...(c.s.scope_exceptions??[]).map(e=>e.path)];
  };
  c.inScope=(file,paths)=>paths.some(p=>file===p||file.startsWith(p+'/'));
  // 최초 기준선(init 시점)과 비교해 허용 범위 밖에 있는 변경 파일.
  c.outsideBaseline=snap=>{
    const baseline=read(path.join(c.taskdir(),'baseline.json'));
    const allowed=c.allowedPaths();
    return changes(baseline,snap).filter(f=>!c.inScope(f,allowed));
  };
  // 배치 순서에서 방금 반려된 일꾼 다음부터 돌아가며 후보를 늘어놓는다(자기 자신은 맨 끝).
  c.rotation=()=>{
    const order=[...new Set([...c.s.routing.candidates,...c.pool()])].filter(e=>c.pool().includes(e));
    const at=order.indexOf(c.s.owner);
    return [...order.slice(at+1),...order.slice(0,at+1)];
  };
  return c;
}

const memoryOn=c=>!!workspaceOf(c.s.configuration);

// 작업이 끝나면(CLOSE/BLOCKED) 실패→원인→수정→검증 흐름을 기억 후보로 뽑아 장부에 올린다.
function harvest(c) {
  if(!memoryOn(c))return;
  for(const candidate of deriveFromState(c.s,c.taskdir())){
    propose(c.root,c.s.task_id,[candidate],{role:'protocol',verified:candidate.verified});
  }
}

// 작업이 CLOSE나 BLOCKED가 된 순간 한 번 하는 정산. 어떤 경로로 끝났든(review, decide, recover, verify) 똑같이 부른다.
// 지표, 프로젝트 마일스톤, 기억 후보 순서로 하고, 하나가 실패해도 나머지는 계속한다. 실패는 숨기지 않고 상태에 남긴다.
function finalizeTask(c,outcome) {
  const s=c.s;
  let dirty=false;
  // router가 일꾼 실적을 배우는 재료다. 빠지면 학습이 조용히 멈추므로 실패를 기록한다.
  try{
    measure(c.root);
  } catch(e){
    s.metrics_error=`metrics not recorded: ${e.message}`;
    dirty=true;
  }
  if(s.project){
    try{
      if(settleTask(c.root,s.task_id,outcome)==='checkpoint_due'){
        notify(`HyperFusion ${s.project.name}`,`milestone ${s.project.milestone} finished; checkpoint report due`,{priority:'high'});
      }
    } catch(e){
      s.project_error=`project milestone not updated: ${e.message}`;
      dirty=true;
    }
  }
  // 선택 기능이라 마지막에 한다. 실패해도 위 정산에는 영향이 없다.
  try{
    harvest(c);
  } catch(e){
    s.memory_error=`memory candidates not extracted: ${e.message}`;
    dirty=true;
  }
  if(dirty)c.save();
}

// 리드가 판단해야 하는 단계로 넘어갈 때 알린다.
const NEEDS_LEAD=['BLOCKED','TAKEOVER_REQUIRED','DECISION_REQUIRED','LEAD_DECISION_REQUIRED'];

function afterTransition(c,before) {
  const s=c.s;
  if(!s||s.schema_version!==SCHEMA_VERSION||s.phase===before)return;
  if(['CLOSE','BLOCKED'].includes(s.phase)){s.ended_at=new Date().toISOString();c.save();}
  if(s.phase==='CLOSE')finalizeTask(c,'closed');
  if(s.phase==='BLOCKED')finalizeTask(c,'blocked');
  if(NEEDS_LEAD.includes(s.phase)){
    notify(`HyperFusion ${s.task_id}`,`needs the lead: ${s.phase} after ${s.owner} round ${s.iteration}`,{priority:'high'});
  }
}

// ── init ────────────────────────────────────────────────────────────

function init(c,input) {
  let configuration=config(c.root);

  // 프로젝트가 있으면 사용자가 승인한 팀으로, 현재 마일스톤에 계획된 작업만 시작한다.
  const project=loadProject(c.root);
  let projectTask=null;
  if(project&&project.status!=='COMPLETE'){
    if(project.status!=='ACTIVE'){
      throw Error('PROJECT_NOT_APPROVED: show the team report to the user and record their approval (project.mjs approve)');
    }
    const milestone=activeMilestone(project);
    if(!milestone){
      const due=project.milestones.find(m=>['checkpoint_due','reported'].includes(m.status));
      throw Error(due
        ?`PROJECT_CHECKPOINT_PENDING: ${due.id} is finished; report the checkpoint and record the user's ack`
        :'No active milestone');
    }
    const planned=milestone.tasks.find(t=>t.id===input.task_id);
    if(!planned){
      const open=milestone.tasks.filter(t=>t.status==='planned').map(t=>t.id).join(', ')||'none';
      throw Error(`Task ${input.task_id} is not in milestone ${milestone.id}; planned: ${open} (add tasks with project.mjs amend)`);
    }
    if(planned.status!=='planned')throw Error(`Project task ${planned.id} is ${planned.status}`);
    configuration=teamConfig(project,configuration);
    input={task_kind:planned.kind,...(planned.difficulty?{difficulty:planned.difficulty}:{}),...input};
    projectTask={...planned,milestone:milestone.id,project:project.name};
  }

  const adaptive=configuration.review?.strategy==='lead-gated-adaptive';
  // Sol은 일반 구현 명단에 없다. APEX 승인 작업에서만 init이 이 이름을 받는다.
  const requested=adaptive&&input.executor==='sol'?'sol':selectExecutor(configuration,input.executor);
  // 예전 버전의 기록이 작업 폴더 안(.fusion)에 있으면 새 작업을 시작하지 않는다. 일꾼이 그 폴더를 고칠 수 있기 때문이다.
  if(isLegacy(c.root)){
    throw Error(`LEGACY_CONTROL_DIR: records are inside the workspace (${controlRoot(c.root)}), where workers can edit them. Run: node fusion-state.mjs migrate REPO`);
  }
  // 끝난 작업(완료, 막힘, 보관) 뒤에는 새 작업을 시작할 수 있다. 막힌 작업의 기록은 그대로 남는다.
  if(c.s&&!TERMINAL_PHASES.includes(c.s.phase))throw Error('Existing unfinished task; inspect/recover');
  const assignment=takeAssignment(configuration,input);
  const grant=initialGrant(assignment);
  if(grant?.executor==='sol'&&requested!=='sol'&&requested!=='auto')throw Error('ROLE_GATE: sol_apex starts with Sol');
  if(grant?.executor==='sonnet'&&requested!=='sonnet'&&requested!=='auto')throw Error('ROLE_GATE: sonnet_implementation starts with Sonnet');
  if(adaptive&&requested==='sonnet'&&grant?.executor!=='sonnet')throw Error('ROLE_GATE: Sonnet needs an unconsumed controller implement grant');
  if(adaptive&&requested==='sol'&&grant?.executor!=='sol')throw Error('ROLE_GATE: Sol implements only an APEX round');
  if(requested==='sonnet'&&!grant&&!automaticImplementer(configuration,requested))throw Error('ROLE_GATE: Sonnet requires adaptive controller authorization');
  input=contract.brief(input);
  const limits=validateLimits({...configuration.limits,...validateLimits(input.limits)});
  if(c.writerHeld())throw Error('Existing writer; recover first');
  if(fs.existsSync(path.join(c.dir,'tasks',input.task_id)))throw Error('Task ID already used');

  // auto면 router가 고르고, 명시 지정이면 그 일꾼을 맨 앞에 두고 router 순서를 예비로 붙인다.
  let routing;
  if(requested==='auto'){
    routing={mode:'auto',...route(c.root,configuration,input)};
  } else {
    const suggestion=route(c.root,configuration,input,{probe:false});
    routing={
      mode:'explicit',...suggestion,executor:requested,
      candidates:[requested,...suggestion.candidates.filter(e=>e!==requested)],
      reason:`lead override; router suggested ${suggestion.executor} (${suggestion.reason})`
    };
  }

  if(grant){
    const rest=routing.candidates.filter(e=>e!==grant.executor&&e!=='sonnet'&&e!=='sol');
    routing={...routing,mode:'authorized',executor:grant.executor,candidates:[grant.executor,...rest],reason:`controller implement grant for ${grant.executor}; ${routing.reason}`};
  } else if(adaptive){
    const candidates=routing.candidates.filter(e=>e!=='sonnet'&&e!=='sol');
    const executor=candidates.includes(routing.executor)?routing.executor:candidates[0];
    if(!executor)throw Error('ADAPTER_UNAVAILABLE: no routed executor is installed');
    routing={...routing,executor,candidates,reason:routing.executor==='sonnet'||routing.executor==='sol'?`${routing.reason}; sonnet and sol are not automatic implementers`:routing.reason};
  }
  const executor=routing.executor;
  const base=snapshot(c.root);
  c.s={
    schema_version:SCHEMA_VERSION,architecture:ARCHITECTURE,package_version:VERSION,configuration,routing,limits,
    initial_executor:executor,active_executor:executor,owner:null,
    attempts:Object.fromEntries([...EXECUTORS,'lead'].map(e=>[e,0])),
    sessions:Object.fromEntries(EXECUTORS.map(e=>[e,null])),
    task_id:input.task_id,phase:'PLAN',
    ...(assignment?{assignment}:{}),
    ...(grant?{implement_grant:grant}:{}),
    lead:configuration.lead,lead_target_model:configuration.lead_model,lead_model:null,
    iteration:0,base_commit:base.head,baseline_dirty:!!base.status,
    writer:null,reviews:[],escalations:[],result_failures:0,started_at:new Date().toISOString(),
    ...(projectTask?{project:{name:projectTask.project,milestone:projectTask.milestone,task:projectTask.id}}:{})
  };
  if(acceptanceBaseline(c,input)===false)return c.s;
  c.art('initial-brief.json',input);
  c.art('baseline.json',base);
  if(assignment)c.art('assignment.json',assignment);
  if(grant)c.art(`implement-grant-${grant.revision}.json`,grant);
  c.save();

  if(projectTask){
    const p=loadProject(c.root);
    const task=p.milestones.flatMap(m=>m.tasks).find(t=>t.id===projectTask.id);
    task.status='active';
    task.started_at=c.s.started_at;
    saveProject(c.root,p);
  }
  return c.s;
}

// ── archive / status ────────────────────────────────────────────────

function archive(c,input) {
  const s=c.s;
  if(input.quiescent!==true||typeof input.reason!=='string'||!input.reason.trim()){
    throw Error('Archive requires stopped processes and a reason');
  }
  if(c.writerHeld())assertLease(c.root,input.token);
  // 막혔거나 끝난 작업을 정리하는 것이면 프로젝트에는 그 결과를 그대로 남긴다.
  const outcome={BLOCKED:'blocked',CLOSE:'closed'}[s.phase]??'archived';
  c.art(`archive-${crypto.randomUUID()}.json`,{reason:input.reason,previous:s,current:snapshot(c.root)});
  if(c.writerHeld())release(c.root,input.token);
  s.writer=null;
  fs.rmSync(acceptanceMarker(c),{force:true});
  s.phase='ARCHIVED';
  c.save();
  if(s.project)settleTask(c.root,s.task_id,outcome);
  return s;
}

function status(c,input={}) {
  const s=c.s;
  const remaining=Object.fromEntries(Object.keys(CAP).map(k=>[k,CAP[k]-s.attempts[k]]));
  if(input.summary===true&&input.monitor===true)throw Error('status summary and monitor are separate views');
  // 감시는 작업 단계와 별개다. 성공을 선언하지 않고, summary 계약에도 필드를 넣지 않는다.
  if(input.monitor===true)return {task_id:s.task_id,monitors:readRoundMonitors(c.taskdir()),declares_success:false};
  if(input.summary===true)return {task_id:s.task_id,phase:s.phase,owner:s.owner,remaining,next_action:nextAction(s.phase,!!s.open_consult),
    ...(s.acceptance?{acceptance:{round:s.acceptance.round,stage:s.acceptance.stage,status:s.acceptance.status}}:{})};
  return {
    ...s,
    lease_present:c.writerHeld(),
    current_digest:snapshot(c.root).digest,
    remaining:Object.fromEntries(Object.keys(CAP).map(k=>[k,CAP[k]-s.attempts[k]])),
    consult_remaining:CONSULT_CAP-(s.consult_runs??0),
    // 설정에는 있지만 이 PC에 설치되지 않았거나 플래그가 맞지 않는 일꾼. 배치와 takeover 판단에서 빠진다.
    unavailable:c.unavailable(),budget:budgetStatus(c.root,s)
  };
}

// ── 상담(advisor / committee)과 위임 리뷰 ────────────────────────────

function consult(c,input) {
  const s=c.s;
  const mode=input.mode;
  if(!['advisor','committee','review'].includes(mode))throw Error('Consult mode must be advisor, committee or review');
  if(c.writerHeld())throw Error('Writer still present; recover');

  assertBudget(c.root,s);
  if(mode==='review'){
    input={question:`Review round ${s.iteration} by ${s.owner} against every success criterion and give the verdict.`,...input};
    if((s.review_runs?.[s.iteration]??0)>=REVIEW_RUNS_PER_ROUND){
      throw Error(`Delegated review cap reached for round ${s.iteration}; review it yourself`);
    }
  }
  if(typeof input.question!=='string'||!input.question.trim())throw Error('Consult requires a concrete question');
  if(input.focus!==undefined&&!(Array.isArray(input.focus)&&input.focus.every(x=>typeof x==='string')))throw Error('Invalid focus');
  const adaptive=mode==='review'&&s.configuration.review.strategy==='lead-gated-adaptive';
  let adaptivePlan=null;
  let size=mode==='committee'?2:1;
  const explicit=input.executors!==undefined;
  let picks,panel=null;
  if(s.phase==='LEAD_DECISION_REQUIRED'){
    // 게이트에서 다시 위임할 수 있는 건 리뷰어가 끝내지 못한 라운드뿐이다(한도·장애). 판정이 난 패널은 다시 돌리지 않는다.
    if(!adaptive||!(s.review_results?.[s.iteration]??[]).some(r=>!r.ok))throw Error('Invalid phase LEAD_DECISION_REQUIRED for delegate-review: no mandatory reviewer failed this round');
  }
  if(adaptive){
    const recorded=c.optional('assignment.json');
    if(!sameAssignment(recorded,s.assignment))throw Error('ADAPTIVE_REVIEW: assignment does not match the controller record');
    adaptivePlan=planReview(s.owner,s.assignment);
    if(adaptivePlan.reviewers.length===1&&adaptivePlan.reviewers[0]==='lead'){
      throw Error('ADAPTIVE_REVIEW: this round requires a direct lead review; delegated reviewers are refused');
    }
    if(adaptivePlan.reviewers.includes(s.owner))throw Error('ADAPTIVE_REVIEW: self-review is refused');
    // 끝난 리뷰는 남기고, 빈 자리만 기본 리뷰어나 리드가 고른 다른 모델로 채운다.
    const kept=(s.review_results?.[s.iteration]??[]).filter(r=>r.ok).map(r=>r.executor);
    panel=panelSeats(adaptivePlan,{asked:explicit?input.executors:undefined,kept,failed:s.review_failed?.[s.iteration]??[],reason:input.substitution_reason});
    for(const e of panel.reviewers)if(!REVIEWERS.includes(e))throw Error('Consult executors must be named from '+REVIEWERS.join(', '));
    picks=panel.reviewers;
    size=picks.length;
  }
  if(mode!=='review'&&(s.consult_runs??0)+size>CONSULT_CAP){
    throw Error(`Consult cap reached (${CONSULT_CAP} member runs per task)`);
  }

  // 상담·리뷰에는 구현 일꾼 외에 리뷰 전용 인력(Sol)도 부를 수 있다.
  const hire=e=>{
    if(e==='auto'||!REVIEWERS.includes(e))throw Error('Consult executors must be named from '+REVIEWERS.join(', '));
    if(!c.pool().includes(e)&&!s.configuration.review.reviewers.includes(e)){
      throw Error('Not enabled in external.available or review.reviewers: '+e);
    }
    return e;
  };
  // adaptive는 위에서 필수 리뷰어를 정했다. 설정 목록으로 빼거나 순서를 바꾸지 않는다.
  if(!adaptive&&explicit){
    if(!Array.isArray(input.executors)||input.executors.length!==size||new Set(input.executors).size!==size){
      throw Error(`${mode} needs ${size} distinct executor(s)`);
    }
    picks=input.executors.map(hire);
    // 자기 작업은 자기가 리뷰하지 않는다.
    if(mode==='review'&&picks.includes(s.owner)){
      throw Error(`${s.owner} implemented round ${s.iteration}; pick a different reviewer`);
    }
  } else if(!adaptive&&mode==='review'){
    const failed=s.review_failed?.[s.iteration]??[];
    picks=s.configuration.review.reviewers.filter(e=>e!==s.owner&&!failed.includes(e));
  } else if(!adaptive){
    // 기본: 방금 일한 일꾼은 뒤로. 자기 작업을 자기가 검사하지 않게 하고, 위원회는 서로 다른 모델로 꾸린다.
    const order=[...new Set([...s.routing.candidates,...c.pool()])].filter(e=>c.pool().includes(e));
    picks=[...order.filter(e=>e!==s.owner),...order.filter(e=>e===s.owner)];
  }

  const members=[];
  for(const e of picks){
    if(members.length===size)break;
    let cli;
    try{cli=adapter(e).probe(s.configuration.executors[e]??{});}
    catch(err){if(explicit||adaptive)throw err;continue;}
    members.push({member:'m'+(members.length+1),executor:e,cli});
  }
  if(members.length<size){
    const who=mode==='review'?`reviewer other than ${s.owner}`:'worker(s)';
    throw Error(`ADAPTER_UNAVAILABLE: ${mode} needs ${size} installed ${who}`);
  }

  const id='c'+((s.consults?.length??0)+1);
  const n=s.iteration;
  const latest=c.optional(`brief-${n}.json`)??c.optional('initial-brief.json');
  const changed=n?(c.optional(`validation-${n}.json`)?.changed??[]):[];
  // 읽기 전용 위원(Sonnet은 Bash도 없다)이 diff를 볼 수 있게 직접 넣어 준다. 새 파일은 목록만 있으므로 직접 읽어야 한다.
  const diff=changed.length?git(c.root,['diff',...SAFE_DIFF,'HEAD','--',...changed]):'';
  const context={
    round:n,last_worker:s.owner,last_result:n?c.optional(`raw-result-${n}.json`):null,changed_files:changed,
    diff:diff.slice(0,CONTEXT_DIFF_MAX),diff_truncated:diff.length>CONTEXT_DIFF_MAX,
    diff_note:'git diff HEAD of changed files; untracked new files are not shown, read them directly',
    recent_reviews:s.reviews.slice(-3).map(r=>({owner:r.owner,round:r.round,verdict:r.verdict,blocking_criteria:r.blocking_criteria,rationale:r.rationale}))
  };

  // 모든 위원의 dispatch를 먼저 만든다. 하나라도 실패하면(예: Windows 명령줄 길이) 상태를 바꾸지 않는다.
  const requests=members.map(m=>{
    const a=adapter(m.executor);
    const brief={
      task_id:s.task_id,round:n,repo_root:c.root,objective:latest.objective,scope:latest.scope,
      constraints:latest.constraints,success_criteria:latest.success_criteria,allowed_actions:['read'],
      ...(latest.prior_experience?{prior_experience:latest.prior_experience}:{}),
      consult:{id,mode,member:m.member,question:input.question,focus:input.focus??[],context}
    };
    const d=a.dispatch(brief,{token:'consult',owner:m.executor},{
      session:a.newSession(),resume:false,probe:m.cli,
      promptFile:path.join(c.taskdir(),`prompt-consult-${id}-${m.member}.txt`),
      options:{...(s.configuration.executors[m.executor]??{}),...(panel?.effort?.[m.executor]?{reasoning_effort:panel.effort[m.executor]}:{})}
    });
    return [m.member,{transport:'executor-cli',kind:'consult',executor:m.executor,...d,task_id:s.task_id,consult_id:id,member:m.member}];
  });

  const base=snapshot(c.root);
  let storedPlan=null;
  if(adaptive){
    storedPlan={version:1,task_id:s.task_id,round:n,owner:s.owner,criticality:adaptivePlan.criticality,strategy:adaptivePlan.strategy,reviewers:[...adaptivePlan.reviewers],effort:adaptivePlan.effort,revision:s.assignment.revision,baseline_digest:base.digest};
    const prior=c.optional(`review-plan-${n}.json`);
    if(prior){
      if(!samePlan(prior,storedPlan)||prior.baseline_digest!==base.digest)throw Error('ADAPTIVE_REVIEW: frozen review plan does not match this round snapshot');
    }else c.art(`review-plan-${n}.json`,storedPlan);
    // 파일의 계획은 기본 리뷰어로 고정하고, 이번 위임에서 실제로 앉힌 리뷰어는 따로 남긴다.
    storedPlan={...storedPlan,reviewers:[...panel.reviewers],effort:panel.effort,planned:[...adaptivePlan.reviewers],kept:panel.kept,substitutes:panel.substitutes,substitution_reason:panel.substitution_reason};
  }
  const roster=members.map(({member,executor})=>({member,executor}));
  c.art(`consult-${id}-base.json`,base);
  for(const [member,request] of requests)c.art(`consult-${id}-${member}.json`,request);
  c.art(`consult-${id}.json`,{id,mode,question:input.question,focus:input.focus??[],members:roster,phase:s.phase,
    ...(panel?{planned:storedPlan.planned,substitutes:panel.substitutes,substitution_reason:panel.substitution_reason}:{})});

  if(mode==='review')s.review_runs={...(s.review_runs??{}),[n]:(s.review_runs?.[n]??0)+1};
  else s.consult_runs=(s.consult_runs??0)+size;
  s.hint=null;
  s.open_consult={id,mode,members:roster,digest:base.digest,started_at:new Date().toISOString(),...(storedPlan?{adaptive:true,plan:storedPlan}:{})};
  c.save();
  return {
    consult_id:id,mode,members:roster,command:process.execPath,args:[BRIDGE,c.root,'--consult',id],
    next_action:'run command once, then consult-finish with quiescent:true'
  };
}

function consultFinish(c,input) {
  const s=c.s;
  const open=s.open_consult;
  if(!open)throw Error('No open consult');
  if(input.quiescent!==true)throw Error('Confirm consult workers and children stopped');

  const base=read(path.join(c.taskdir(),`consult-${open.id}-base.json`));
  const now=snapshot(c.root);
  // 읽기 전용 약속을 실제로 지켰는지 전후 스냅샷으로 확인한다. 어기면 그 답변은 버린다.
  const violated=now.digest!==base.digest;
  const touched=changes(base,now);
  const results=[];
  const members=open.members.map(m=>{
    const file=path.join(c.taskdir(),`consult-result-${open.id}-${m.member}.json`);
    if(!fs.existsSync(file))return {...m,ok:false};
    const r=read(file);
    if(!violated)results.push({...r,executor:m.executor});
    return {
      ...m,ok:!violated,recommended_verdict:r.recommended_verdict,confidence:r.confidence,
      findings:r.findings.length,blockers:r.findings.filter(x=>x.severity==='blocker').length
    };
  });
  const record={id:open.id,mode:open.mode,members,violated,touched,finished_at:new Date().toISOString()};
  c.art(`consult-${open.id}-finish.json`,record);
  s.consults=[...(s.consults??[]),record];
  s.open_consult=null;
  if(violated){
    s.phase='RECOVERY_REQUIRED';
    s.last_errors=['Consult modified the tree: '+(touched.join(', ')||'HEAD/index')];
  }

  let applied=null;
  if(open.mode==='review'&&!violated)applied=open.adaptive?applyAdaptiveReview(c,open,results):applyDelegatedReview(c,open,members[0],results[0]);
  c.save();
  return {...record,results,phase:s.phase,...(applied?{review:applied}:{})};
}

// 옵트인 리뷰. 합의·불일치·누락 모두 리드 게이트에서 멈춘다. auto_apply와 adopt는 이 판정을 적용하지 않는다.
function applyAdaptiveReview(c,open,results) {
  const s=c.s;
  const plan=open.plan;
  const raw=read(path.join(c.taskdir(),`raw-result-${s.iteration}.json`));
  const byExecutor=new Map(results.filter(Boolean).map(r=>[r.executor,r]));
  // 앞선 위임에서 끝난 리뷰는 그대로 두고, 이번 자리의 결과를 붙인다.
  const kept=(s.review_results?.[s.iteration]??[]).filter(r=>r.ok);
  const fresh=plan.reviewers.map(executor=>{
    const result=byExecutor.get(executor);
    if(!result)return {executor,ok:false,verdict:null,digest:open.digest,consult_id:open.id};
    let verdict=result.recommended_verdict;
    let blocking=Array.isArray(result.blocking_criteria)?result.blocking_criteria:[];
    let evidence=contract.rejectionEvidence(verdict,result.findings);
    if(verdict==='pass'&&raw.status!=='complete'){
      verdict='redo';
      blocking=['worker reported '+raw.status];
      evidence=true;
    }
    return {executor,ok:true,verdict,evidence,blocking_criteria:blocking,summary:result.summary,confidence:result.confidence,findings:result.findings??[],digest:open.digest,consult_id:open.id,
      ...((plan.substitutes??[]).includes(executor)?{substitute:true,substitution_reason:plan.substitution_reason}:{})};
  });
  const records=[...kept,...fresh];
  s.review_results={...(s.review_results??{}),[s.iteration]:records};
  const decision=aggregateVerdicts(records);
  const listed=records.map(r=>({executor:r.executor,verdict:r.verdict,digest:r.digest}));
  let recommendation=null,pass_forbidden=true,note;
  if(decision.status==='reviewer_failed'){
    const missing=records.filter(r=>!r.ok).map(r=>r.executor);
    s.review_failed={...(s.review_failed??{}),[s.iteration]:[...new Set([...(s.review_failed?.[s.iteration]??[]),...missing])]};
    note=`mandatory reviewer did not finish (${missing.join(', ')}); delegate-review again with executors other than ${s.owner} and a substitution_reason, or decide with your own diff review`;
  } else if(decision.status!=='unanimous'||records.some(r=>r.digest!==s.post_digest)){
    note='mandatory reviews disagree or the digest does not match the round; a pass is not synthesized';
  } else {
    recommendation={pass:'APPROVE',redo:'REDO',alternative:'REASSIGN_OTHER',decision:'ESCALATE'}[decision.verdict]??null;
    pass_forbidden=decision.verdict!=='pass';
    note=pass_forbidden?'the panel is not a unanimous pass; APPROVE is refused':'unanimous pass on the round digest; a lead-decision is required and APPROVE does not CLOSE';
  }
  // 위치가 있는 blocker·major 지적이 없는 반려는 추천으로 올리지 않는다. 리드가 읽고 REDO하거나 직접 리뷰 후 overrule한다.
  const unsupported=records.filter(r=>r.ok&&r.evidence===false).map(r=>r.executor);
  if(unsupported.length){
    if(records.filter(r=>r.ok&&r.verdict!=='pass').every(r=>r.evidence===false))recommendation=null;
    note+=`; rejection without file:line blocker/major evidence from ${unsupported.join(', ')} is advisory: read it, then REDO or overrule after your own diff review`;
  }
  return openLeadGate(c,{recommendation,pass_forbidden,reviewers:listed,panel_status:decision.status,verdict:decision.status==='unanimous'?decision.verdict:null,consult_id:open.id,note});
}

// classic의 자동 교체 규칙과 같은 판정: 같은 일꾼이 직전 반려와 같은 수용 기준(AC ID)으로 또 반려되면 교체 대상이다.
function repeatedCriteria(s,blocking) {
  const prev=s.reviews.filter(r=>r.owner===s.owner&&r.verdict!=='pass').at(-1);
  if(!prev||!blocking.length)return [];
  const before=new Set((prev.blocking_criteria??[]).flatMap(contract.criterionKeys));
  return [...new Set(blocking.flatMap(contract.criterionKeys))].filter(k=>before.has(k));
}
const panelBlocking=records=>[...new Set(records.filter(r=>r.ok&&r.verdict!=='pass').flatMap(r=>r.blocking_criteria??[]).filter(x=>typeof x==='string'&&x.trim()))];
// APEX는 Sol에 남는다. 그 밖에는 REASSIGN_OTHER로 넘길 수 있는 일꾼이 있을 때만 교체를 권한다.
const swapTargets=(c,s)=>s.owner==='sol'?[]:['grok','antigravity','haiku','luna'].filter(x=>x!==s.owner&&c.pool().includes(x)&&c.canWork(x));

// 증거 파일의 위치만 넘긴다. diff 본문이나 모델 호출은 넣지 않는다.
function leadEvidence(c,consult_id) {
  const n=c.s.iteration;
  const names=[`validation-${n}.json`,`raw-result-${n}.json`,`post-${n}.json`,`brief-${n}.json`,`review-plan-${n}.json`,`assignment.json`,`usage-${n}.json`];
  if(consult_id)names.push(`consult-${consult_id}-base.json`,`consult-${consult_id}-finish.json`);
  return names.filter(name=>fs.existsSync(path.join(c.taskdir(),name)));
}

function openLeadGate(c,{recommendation,pass_forbidden,reviewers,panel_status,verdict,consult_id,note}) {
  const s=c.s,n=s.iteration;
  const dispatch=c.optional(`dispatch-${n}.json`),brief=c.optional(`brief-${n}.json`),validation=c.optional(`validation-${n}.json`);
  const runs=collectRunUsage(c.root,s).filter(r=>r.round===n||consult_id&&r.tag.startsWith(`consult-${consult_id}-`));
  const plan=planReview(s.owner,s.assignment);
  const coverage=reviewCoverage(plan,s.review_results?.[n]??[],s.post_digest);
  const repeated=repeatedCriteria(s,panelBlocking(s.review_results?.[n]??[]));
  if(repeated.length&&recommendation==='REDO'&&swapTargets(c,s).length){
    recommendation='REASSIGN_OTHER';
    note+=`; ${s.owner} was rejected again on ${repeated.join(', ')}, so another worker is recommended`;
  }
  const evidence=leadEvidence(c,consult_id);
  const acceptance=c.optional(`acceptance-${n}-finish.json`);
  if(acceptance)evidence.push(`acceptance-${n}-finish.json`);
  for(const run of runs)if(run.file)evidence.push(run.file);
  const packet={version:1,task_id:s.task_id,round:n,owner:s.owner,model:dispatch?.cli?.model??null,
    effort:implementDispatch(s,s.owner).options.reasoning_effort??null,criticality:s.assignment?.criticality??'standard',
    base_commit:s.base_commit,baseline_digest:s.post_digest,changed_files:validation?.changed??[],
    acceptance:acceptance?{status:acceptance.status,quiescent:acceptance.quiescent===true,file:`acceptance-${n}-finish.json`}:{status:'not_recorded'},
    criteria:(brief?.success_criteria??[]).slice(0,36).map(text=>String(text).slice(0,180)),panel_status,
    review_gaps:coverage.gaps,repeated_criteria:repeated,unsupported_rejections:(s.review_results?.[n]??[]).filter(r=>r.ok&&r.evidence===false).map(r=>r.executor),planned_reviewers:plan.reviewers,substitutes:coverage.substitutes,same_family_reviewers:coverage.same_family,
    quota:quotaReport(c.root),usage:runs.map(r=>({executor:r.executor,role:r.role,tokens:r.tokens,cost_usd:r.cost_usd,file:r.file})),
    decision_authority:{source:'host-controller',observed_model:s.lead_model??null,model_verified:false},
    recommendation,pass_forbidden,note,consult_id,reviewers,evidence:[...new Set(evidence)]};
  // 리뷰어를 바꿔 다시 위임하면 게이트가 다시 열린다. 앞선 패킷은 감사 기록으로 남기고 새 파일에 쓴다.
  const first=`lead-packet-${n}.json`;
  const file=fs.existsSync(path.join(c.taskdir(),first))?`lead-packet-${n}-${consult_id??'direct'}.json`:first;
  c.art(file,packet);
  s.pending_review=null;
  s.phase='LEAD_DECISION_REQUIRED';
  s.lead_packet={round:n,file,recommendation,pass_forbidden};
  c.save();
  return {status:'lead_gate',panel_status,verdict,recommendation,pass_forbidden,reviewers,phase:s.phase,next_action:'lead-decision'};
}

// 위임 리뷰어의 결과를 판정으로 바꿔 적용한다.
function applyDelegatedReview(c,open,member,result) {
  const s=c.s;
  if(!result){
    // 리뷰어가 결과를 못 냈으면 다음 리뷰어를 쓰거나 리드가 직접 본다.
    s.review_failed={...(s.review_failed??{}),[s.iteration]:[...(s.review_failed?.[s.iteration]??[]),member.executor]};
    return {status:'reviewer_failed',executor:member.executor,next_action:'delegate-review again (another reviewer) or review it yourself'};
  }
  const raw=read(path.join(c.taskdir(),`raw-result-${s.iteration}.json`));
  let verdict=result.recommended_verdict;
  let blocking=result.blocking_criteria;
  // 일꾼이 미완료라고 보고한 라운드는 리뷰어가 pass를 줘도 통과시킬 수 없다.
  if(verdict==='pass'&&raw.status!=='complete'){
    verdict='redo';
    blocking=['worker reported '+raw.status];
  }
  const evidence=blocking!==result.blocking_criteria||contract.rejectionEvidence(verdict,result.findings);
  const delegated={
    verdict,rationale:result.summary,blocking_criteria:blocking,
    commands_run:['delegated read-only review by '+member.executor],independent_diff_review:true,
    reviewed_by:member.executor,consult_id:open.id,confidence:result.confidence,findings:result.findings
  };
  // 위치가 있는 blocker·major 지적이 없는 반려는 auto_apply여도 바로 적용하지 않고 리드에게 넘긴다.
  if(!evidence){
    s.pending_review={...delegated,evidence:false};
    return {status:'pending',reason:'rejection_without_evidence',
      next_action:'read the findings; review {"adopt":true} to apply the rejection anyway, or give your own verdict'};
  }
  if(!s.configuration.review.auto_apply){
    s.pending_review=delegated;
    return {status:'pending',next_action:'review with {"adopt":true} or your own verdict'};
  }
  try{
    applyReview(c,delegated);
    return {status:'applied',verdict,reviewed_by:member.executor,phase:s.phase};
  } catch(e){
    if(s.phase!=='REVIEW'){
      // 적용하다 트리 변경이 드러나 이미 복구 단계다. 이 판정은 낡았으므로 보류하지 않고, review는 이 단계에서 받지도 않는다.
      s.pending_review=null;
      return {status:'recovery_required',error:e.message,phase:s.phase,next_action:'recover first (the tree changed since the round finished), then review the round again'};
    }
    s.pending_review=delegated;
    return {status:'needs_lead',error:e.message,next_action:'review with {"adopt":true} after fixing, or give your own verdict'};
  }
}

// ── 일꾼 투입 ───────────────────────────────────────────────────────

function begin(c,input) {
  const s=c.s;
  input=contract.brief(input);
  if(input.task_id!==s.task_id)throw Error('Task ID mismatch');
  if(c.writerHeld())throw Error('Writer still present; recover');
  try{assertBudget(c.root,s);}catch(e){if(e.code==='BUDGET_EXCEEDED'){s.phase='BLOCKED';s.budget_error=e.message;c.save();}throw e;}

  let owner;
  const adaptive=s.configuration.review?.strategy==='lead-gated-adaptive';
  if(s.phase==='TAKEOVER_REQUIRED'){
    owner='lead';
    if(typeof input.takeover_reason!=='string'||!input.takeover_reason.trim())throw Error('Takeover requires a recorded reason');
  } else if(s.phase==='ALTERNATIVE_REQUIRED'){
    // 지정이 없으면 배치표에서 방금 반려된 일꾼 다음 순번부터 돌아가며 예산 있는 일꾼을 투입한다.
    // Sol은 배치표에 없다. 승인된 재지시만 명시 이름으로 받는다.
    const pick=input.executor===undefined||input.executor==='auto';
    // 리드 결정이 이 라운드의 다음 작성자를 묶었으면 배치표가 그 결정을 바꾸지 않는다.
    const decided=s.lead_decision?.round===s.iteration?s.lead_decision.next_executor??null:null;
    if(decided&&!pick&&input.executor!==decided)throw Error('ROLE_GATE: this alternative is bound to '+decided);
    owner=decided
      ?adaptive&&decided==='sol'?'sol':selectExecutor(s.configuration,decided)
      :pick
        ?c.rotation().find(e=>e!==s.owner&&c.canWork(e))
        :adaptive&&input.executor==='sol'?'sol':selectExecutor(s.configuration,input.executor);
    if(!owner&&pick){
      // 예산이 남은 일꾼이 있어도 설치돼 있지 않으면 쓸 수 없다. 이 단계에 갇히지 않게 다음 단계(takeover 또는 BLOCKED)로 옮긴다.
      s.phase=c.exhausted();
      c.save();
      throw Error(`No installed alternative executor with budget (unavailable: ${JSON.stringify(c.unavailable())}); phase is now ${s.phase}`);
    }
    if(!owner)throw Error('No alternative executor with budget');
    if(owner===s.owner)throw Error('Alternative requires a different executor than the one just rejected');
  } else {
    owner=s.phase==='PLAN'?s.active_executor:s.owner;
    if(c.installError(owner)){
      s.phase=c.exhausted();
      c.save();
      if(s.phase!=='ALTERNATIVE_REQUIRED')throw Error(`ADAPTER_UNAVAILABLE: ${owner}; phase is now ${s.phase}`);
      const requested=input.executor;
      if(requested===undefined||requested===owner||requested==='auto'){
        throw Error(`ADAPTER_UNAVAILABLE: ${owner}; phase is now ALTERNATIVE_REQUIRED; retry begin with an available executor`);
      }
      owner=adaptive&&requested==='sol'?'sol':selectExecutor(s.configuration,requested);
    }
    if(input.executor!==undefined&&input.executor!==owner)throw Error('Executor switch requires an alternative verdict');
  }

  // "@review": 직전 리뷰의 반려 사유와 파일·줄 지적을 그대로 명령서로 쓴다. 리드가 diff를 다시 읽지 않아도 된다.
  if(input.lead_feedback==='@review'){
    const last=s.reviews.at(-1);
    const located=(last?.findings??[])
      .filter(f=>['blocker','major'].includes(f.severity))
      .map(f=>({file:f.file,...(f.line?{line:f.line}:{}),comment:`${f.issue}${f.suggestion?' → '+f.suggestion:''}`}));
    const unmet=(last?.blocking_criteria??[])
      .map(criterion=>`Unmet: ${criterion}${last.rationale?' ('+last.rationale.slice(0,200)+')':''}`);
    // 수용 테스트 실패로 컨트롤러가 되돌린 라운드는 실패 출력이 곧 명령서다.
    const items=last?.acceptance_feedback?.length?[...located,...last.acceptance_feedback]:[...located,...unmet];
    if(!items.length)throw Error('Last review has no findings or blocking criteria to forward; write lead_feedback yourself');
    input={...input,lead_feedback:items};
  }
  if(s.phase!=='PLAN'&&owner!=='lead')contract.feedback(input.lead_feedback);
  for(const key of ['task_criticality','assignment_strategy','assignment_reason','authorized_implementer','implement_grant','role_for_round']){
    if(input[key]!==undefined)throw Error('ROLE_GATE: implement grants are controller records, not brief fields');
  }
  const pending=assertImplementRound(s,owner);
  const manual=input.executor===owner||explicitImplementation(s,owner);
  if(owner!=='lead'&&!pending&&!automaticImplementer(s.configuration,owner)&&!(owner==='haiku'&&manual)){
    throw Error('ROLE_GATE: '+owner+' is not an eligible automatic implementer');
  }
  if(pending){
    const recorded=c.optional(`implement-grant-${pending.revision}.json`);
    if(!sameGrant(recorded,pending))throw Error('ROLE_GATE: implement grant does not match the controller record');
  }
  if(!c.budget(owner))throw Error(owner+' round cap reached');

  const round=s.iteration+1;
  const a=owner==='lead'?null:adapter(owner);
  const session=a?(s.sessions[owner]??a.newSession()):null;
  const resume=!!(a&&s.sessions[owner]);
  const promptFile=path.join(c.taskdir(),`prompt-${round}.txt`);
  const brief={...input,repo_root:c.root,round};
  const planned=implementDispatch(s,owner);

  // 프로브와 인자 검증은 lease 획득·시도 소모 전에 끝낸다.
  // 실패해도 phase와 시도 예산을 유지해 같은 일꾼으로 다시 시작할 수 있다.
  const cli=a?a.probe(planned.options):null;
  if(a)a.dispatch(brief,{token:'pending',owner},{session,resume,probe:cli,promptFile,options:planned.options,apexGrant:planned.apexGrant});

  if(acceptanceBaseline(c,input)===false)return s;
  const lease=acquire(c.root,s.task_id,round,owner);
  if(s.owner!==owner)s.result_failures=0;
  s.hint=null;
  s.phase='EXECUTING';
  s.writer=lease;
  s.iteration=round;
  s.owner=owner;
  s.implementation_selection={executor:owner,source:manual?'explicit':pending?'controller-grant':'automatic',round};
  if(pending)s.implement_grant={...pending,round};
  if(owner==='sol')s.apex_rounds=(s.apex_rounds??0)+1;else s.attempts[owner]++;
  if(a){
    s.active_executor=owner;
    if(session)s.sessions[owner]=session;
  }
  c.save();
  c.art(`brief-${round}.json`,input);
  c.art(`base-${round}.json`,snapshot(c.root));
  // 수용 테스트를 돌릴 라운드는 무시된 파일의 기준선도 남긴다. 일꾼이 거기 코드를 심었는지 실행 전에 비교한다.
  if(input.acceptance_commands)c.art(`ignored-base-${round}.json`,ignoredManifest(c.root,input.acceptance_artifacts));

  const request=a
    ?{
      transport:'executor-cli',executor:owner,command:process.execPath,args:[BRIDGE,c.root],
      ...a.dispatch(brief,lease,{session,resume,probe:cli,promptFile,...implementDispatch(s,owner)}),
      task_id:s.task_id,round,token:lease.token
    }
    :{transport:'lead-takeover',brief,token:lease.token};
  c.art(`dispatch-${round}.json`,request);
  return request;
}

function finish(c,input) {
  const s=c.s;
  assertLease(c.root,input.token);
  if(input.quiescent!==true)throw Error('Confirm worker and children stopped');

  const n=s.iteration;
  if(input.result===undefined){
    if(s.owner==='lead')throw Error('Lead takeover finish requires an explicit result');
    input={...input,result:read(path.join(c.taskdir(),`result-${n}.json`))};
  }
  const base=read(path.join(c.taskdir(),`base-${n}.json`));
  const post=snapshot(c.root);
  c.art(`raw-result-${n}.json`,input.result??null);
  c.art(`post-${n}.json`,post);

  // 브리지가 기록한 세션 ID를 묶는다. 이미 다른 ID가 있으면 바꾸지 않는다.
  const sessionFile=path.join(c.taskdir(),`session-${n}.json`);
  if(s.owner!=='lead'&&fs.existsSync(sessionFile)){
    const id=read(sessionFile).session_id;
    if(s.sessions[s.owner]&&s.sessions[s.owner]!==id)throw Error('Session rebinding requires recovery');
    s.sessions[s.owner]=id;
  }

  const changed=changes(base,post);
  const errors=[];
  try{contract.result(input.result,s.task_id,n);}catch(e){errors.push(e.message);}
  const brief=read(path.join(c.taskdir(),`brief-${n}.json`));
  const accepted=(s.scope_exceptions??[]).map(e=>e.path);
  const outside=changed.filter(f=>!c.inScope(f,[...brief.scope.paths,...accepted]));
  if(outside.length)errors.push('Out of scope: '+outside.join(', '));
  // 실패한 라운드가 남긴 범위 밖 파일은 복구해도 자동으로 되돌리지 않는다. 그래서 다음 라운드의 기준선에 섞여 들어가
  // 라운드 단위 비교만으로는 다시 걸리지 않는다. 지적된 파일을 기록해 두고 되돌려지거나 허용될 때까지 계속 막는다.
  const baseline=read(path.join(c.taskdir(),'baseline.json'));
  const stillChanged=new Set(changes(baseline,post));
  const allowed=c.allowedPaths();
  s.open_violations=[...new Set([...(s.open_violations??[]),...outside])].filter(f=>stillChanged.has(f)&&!c.inScope(f,allowed));
  const lingering=s.open_violations.filter(f=>!outside.includes(f));
  if(lingering.length){
    errors.push(`Earlier out-of-scope changes still present: ${lingering.join(', ')}; revert them, or record them with recover allow_out_of_scope [{path, reason}]`);
  }
  if(post.head!==base.head||post.index_hash!==base.index_hash)errors.push('HEAD/index changed');
  if(!errors.length&&JSON.stringify([...new Set(input.result.files_changed)].sort())!==JSON.stringify(changed)){
    errors.push('Declared changes differ from snapshot');
  }
  s.post_digest=post.digest;
  s.last_errors=errors;
  c.art(`validation-${n}.json`,{changed,errors});

  if(errors.length){
    s.result_failures++;
    s.phase='RECOVERY_REQUIRED';
    c.save();
    return s;
  }
  // 일꾼이 제안한 교훈은 장부에만 올린다. 리드가 승인해야 기억에 저장된다.
  // 기억 장부는 선택 기능이다. 실패해도 이미 검증을 통과한 라운드를 버리지 않고 사실만 남긴다.
  if(memoryOn(c)&&input.result.memory_candidates?.length){
    try{
      // 최대 3건. 객체가 아닌 항목은 propose가 건너뛰고, 모양이 틀린 항목은 invalid로 사유와 함께 장부에 남는다.
      propose(c.root,s.task_id,input.result.memory_candidates.slice(0,3),{role:'worker',executor:s.owner,round:n});
    } catch(e){
      s.memory_error=`worker lessons not recorded: ${e.message}`;
    }
  }
  const acc=brief.acceptance_commands&&input.result.status==='complete'
    ?acceptanceRun(c,brief,'finish',c.optional(`ignored-base-${n}.json`)):null;
  if(acceptanceHalt(c,acc))return s;
  s.result_failures=0;
  s.phase='REVIEW';
  c.save();
  release(c.root,input.token);
  s.writer=null;
  c.save();
  // 수용 테스트가 실패한 일꾼 라운드는 리드가 볼 필요 없이 실패 출력과 함께 같은 일꾼에게 되돌린다.
  // 일반 반려와 같은 규칙(예산, 같은 실패 반복 시 교체)을 거친다. 리드 takeover 라운드는 리드가 직접 판정한다.
  if(acc?.status==='fail'&&s.owner!=='lead'){
    const failed=acc.results.filter(r=>r.status!=='pass');
    return applyReview(c,{verdict:'redo',reviewed_by:'controller',
      rationale:`Acceptance commands failed after finish (${failed.map(r=>r.command).join(', ')}); returned to the worker without lead review`,
      blocking_criteria:failed.map(r=>'Acceptance: '+r.command),commands_run:brief.acceptance_commands,
      independent_diff_review:true,acceptance_feedback:failureFeedback(acc.results)});
  }
  // 수용 실패는 컨트롤러 재지시다. 모델 pass는 여기로 오지 않는다. Sol처럼 리뷰어가 리드뿐이면 위임 없이 게이트로 올린다.
  if(s.configuration.review?.strategy==='lead-gated-adaptive'){
    if(!sameAssignment(c.optional('assignment.json'),s.assignment))throw Error('ADAPTIVE_REVIEW: assignment does not match the controller record');
    const plan=planReview(s.owner,s.assignment);
    if(plan.reviewers.length===1&&plan.reviewers[0]==='lead'){
      openLeadGate(c,{recommendation:null,pass_forbidden:false,reviewers:[],panel_status:'direct',verdict:null,consult_id:null,
        note:'direct lead review is required; delegated reviewers are refused'});
    }
  }
  return s;
}

// red-first: 수용 테스트가 아무 변경 전에도 이미 통과한다면, 그 테스트로는 맞는 결과와 엉터리 결과를 가를 수 없다
// (필터가 아무 테스트도 잡지 않거나, 이미 통과하는 테스트를 가리킨 경우). 그래서 명령이 처음 정해질 때 기준 트리에서
// 한 번 돌려 실패하는지 확인한다. 리팩터처럼 처음부터 통과해야 정상인 작업은 acceptance_baseline_green에 이유를 적는다.
// 작업이 시작된 뒤(라운드 1 이후)에 명령이 바뀌면 기준 트리가 남아 있지 않으므로 unchecked로만 기록한다.
function acceptanceBaseline(c,brief) {
  const s=c.s,cmds=brief.acceptance_commands;
  if(!cmds)return;
  const key=crypto.createHash('sha256').update(JSON.stringify(cmds)).digest('hex').slice(0,16);
  if(s.acceptance_baseline?.key===key)return;
  if(s.iteration>0){
    s.acceptance_baseline={key,status:'unchecked',round:s.iteration,reason:'acceptance_commands changed after work started; there is no untouched tree to prove they fail'};
    return;
  }
  const before=snapshot(c.root);
  const results=supervisedAcceptance(c,brief,'baseline');
  const after=snapshot(c.root);
  const dirty=changes(before,after);
  if(results.some(r=>r.quiescence?.quiescent!==true)||results.some(r=>r.code==='BUDGET_EXCEEDED')||budgetStatus(c.root,s).reason){
    if(!c.optional('initial-brief.json'))c.art('initial-brief.json',brief);
    if(!c.optional('baseline.json'))c.art('baseline.json',before);
    c.art(`acceptance-baseline-${Date.now()}.json`,{stage:'baseline',results,tree_digest:after.digest});
    acceptanceHalt(c,{results,tree_changed:dirty});
    return false;
  }
  if(dirty.length||after.digest!==before.digest)throw Error(`ACCEPTANCE_DIRTY: running acceptance_commands on the untouched tree changed it (${dirty.join(', ')||'git status or index'}); make the commands side-effect free, restore the tree, then retry`);
  if(results.some(r=>r.status==='not_run'||r.code==='PROCESS_TABLE_UNAVAILABLE'||r.code==='PROCESS_TABLE_TIMEOUT')){
    throw Error('ACCEPTANCE_BASELINE_UNVERIFIED: acceptance commands could not be supervised or started ('
      +results.map(r=>r.inventory_error??r.code??r.error??r.status).join(', ')+'); restore process inventory access and retry');
  }
  const green=results.every(r=>r.status==='pass');
  if(green&&!brief.acceptance_baseline_green){
    throw Error('ACCEPTANCE_ALREADY_GREEN: acceptance_commands already pass before any change, so they cannot tell a correct result from a wrong one. '
      +'Point them at a failing test (write one first, or fix a filter that matches nothing), or set acceptance_baseline_green:"<why they should already pass>" for refactors');
  }
  const file=`acceptance-baseline-${Date.now()}.json`;
  c.art(file,{stage:'baseline',commands:cmds,results,tree_digest:before.digest,at:new Date().toISOString(),...(green?{green_reason:brief.acceptance_baseline_green}:{})});
  s.acceptance_baseline={key,status:green?'green-acknowledged':'red',file,...(green?{reason:brief.acceptance_baseline_green}:{})};
}

// 수용 테스트를 실행하고 기록한다. reference는 비교할 무시된 파일 목록(라운드 시작 또는 직전 실행 후).
// 그 뒤로 무시된 파일이 바뀌었으면 trust 없이는 실행하지 않는다. 실행이 트리를 바꿨으면 tree_changed에 남긴다.
function acceptanceRun(c,brief,stage,reference,{trust=false}={}) {
  const s=c.s,n=s.iteration;
  const ignoredNow=ignoredManifest(c.root,brief.acceptance_artifacts);
  const touched=reference?ignoredChanges(reference,ignoredNow):['(no ignored-file baseline for this round)'];
  const record={stage,round:n,at:new Date().toISOString(),commands:brief.acceptance_commands};
  const name=`acceptance-${n}-${stage}${stage==='finish'?'':'-'+Date.now()}`;
  if(touched.length&&!trust){
    Object.assign(record,{status:'skipped',ignored_changes:touched.slice(0,50),
      reason:'gitignored files changed since the reference point, so repository code may not be what the snapshot shows; inspect them, then verify with acceptance_trust_ignored:true'});
  } else {
    const before=snapshot(c.root);
    record.results=supervisedAcceptance(c,brief,stage);
    record.quiescent=record.results.every(r=>r.quiescence?.quiescent===true);
    record.status=record.results.every(r=>r.status==='pass')?'pass':'fail';
    if(touched.length)record.trusted_ignored_changes=touched.slice(0,50);
    const after=snapshot(c.root);
    record.tree_changed=changes(before,after);
    if(!record.tree_changed.length&&after.digest!==before.digest)record.tree_changed=['(git status or index)'];
    record.tree_digest=after.digest;
    c.art(`${name}-ignored.json`,ignoredManifest(c.root,brief.acceptance_artifacts));
    record.ignored_after=`${name}-ignored.json`;
  }
  c.art(`${name}.json`,record);
  s.acceptance={round:n,stage,status:record.status,quiescent:record.quiescent===true,file:`${name}.json`,tree_digest:record.tree_digest??null,ignored_after:record.ignored_after??null};
  return record;
}

// A durable marker prevents a controller crash from converting an unfinished test
// into reusable evidence. Only proven shutdown or explicit lead recovery clears it.
const acceptanceMarker=c=>path.join(c.dir,'locks/acceptance.json');
function supervisedAcceptance(c,brief,stage) {
  const s=c.s,budget=budgetStatus(c.root,s);
  const deadline_ms=s.limits?.max_wall_ms===undefined?null:Date.parse(s.started_at)+s.limits.max_wall_ms;
  if(budget.reason)return brief.acceptance_commands.map(command=>({command,status:'not_run',code:'BUDGET_EXCEEDED',
    output_tail:'',quiescence:{quiescent:true,reason:'Budget exhausted; command not started'}}));
  atomic(acceptanceMarker(c),{state:s,brief,baseline:c.optional('baseline.json')??snapshot(c.root),stage,at:new Date().toISOString()});
  const results=runCommands(c.root,brief.acceptance_commands,{timeout_ms:brief.acceptance_timeout_ms,deadline_ms});
  if(results.every(r=>r.quiescence?.quiescent===true))fs.unlinkSync(acceptanceMarker(c));
  return results;
}

function acceptanceHalt(c,evidence) {
  const s=c.s,unsafe=evidence?.results?.find(r=>r.quiescence?.quiescent!==true);
  const unavailable=evidence?.results?.some(r=>r.code==='PROCESS_TABLE_UNAVAILABLE'||r.code==='PROCESS_TABLE_TIMEOUT');
  const budget=budgetStatus(c.root,s);
  if(unsafe||unavailable||evidence?.tree_changed?.length){
    s.last_errors=[unsafe?`ACCEPTANCE_NOT_QUIESCENT: ${unsafe.quiescence?.reason??'Missing termination evidence'}; stop the processes before recovery`
      :unavailable?'ACCEPTANCE_UNAVAILABLE: process inventory unavailable; restore inventory access before recovery'
      :'Acceptance commands changed the tree: '+evidence.tree_changed.join(', ')+'; restore the tree before recovery'];
    s.phase='RECOVERY_REQUIRED';c.save();return true;
  }
  if(budget.reason||evidence?.results?.some(r=>r.code==='BUDGET_EXCEEDED')){
    s.last_errors=[`BUDGET_EXCEEDED: ${budget.reason??'max_wall_ms'}`];
    // Worker shutdown was already confirmed by finish, and acceptance is quiescent.
    if(s.writer){release(c.root,s.writer.token);s.writer=null;}
    s.phase='BLOCKED';c.save();return true;
  }
  return false;
}

// ── 리뷰 ────────────────────────────────────────────────────────────

// 소모된 Sonnet/Sol 승인은 자동 교체로 넘어가지 않는다. 같은 작성자의 다음 라운드는 새 승인이 있어야 시작한다.
const consumedSpecialist=s=>s.configuration.review?.strategy==='lead-gated-adaptive'
  &&(s.owner==='sol'||s.owner==='sonnet')
  &&s.implement_grant?.executor===s.owner&&s.implement_grant.round!=null;

// 판정을 적용한다. 리드가 직접 내린 판정이든 위임 리뷰어의 판정이든 같은 규칙을 거친다.
function applyReview(c,input) {
  const s=c.s;
  contract.review(input);
  if(snapshot(c.root).digest!==s.post_digest){
    s.phase='RECOVERY_REQUIRED';
    c.save();
    throw Error('Tree drift before review');
  }
  const raw=read(path.join(c.taskdir(),`raw-result-${s.iteration}.json`));
  if(input.verdict==='pass'&&raw.status!=='complete')throw Error('Incomplete result cannot pass');

  const verdict=input.verdict==='escalate'?'alternative':input.verdict;
  if(verdict==='takeover'&&input.reviewed_by!=='lead')throw Error('Only the lead can order a takeover');
  if(verdict==='takeover'&&c.idleWorkers().length){
    throw Error('Workers still have budget ('+c.idleWorkers().join(', ')+'); make them work instead of taking over');
  }
  if(verdict==='alternative'&&(s.owner==='lead'||!c.pool().some(e=>e!==s.owner&&c.canWork(e)))){
    throw Error('No alternative executor with budget; redo or report');
  }

  const record={...input,verdict,owner:s.owner,round:s.iteration};
  // VERIFY에서 수용 테스트가 되돌린 경우 같은 라운드에 리드의 pass 기록이 이미 있다.
  c.art(fs.existsSync(path.join(c.taskdir(),`review-${s.iteration}.json`))?`review-${s.iteration}-verify.json`:`review-${s.iteration}.json`,record);
  s.reviews.push(record);
  s.pending_review=null;
  const assessment=contract.escalation(s.reviews.filter(r=>r.owner===s.owner),s.result_failures,input.complexity??{});
  const from=s.phase;

  if(verdict==='pass')s.phase='VERIFY';
  else if(verdict==='decision')s.phase='DECISION_REQUIRED';
  else if(verdict==='takeover')s.phase=c.takeoverOrBlocked();
  else if(verdict==='alternative')s.phase='ALTERNATIVE_REQUIRED';
  else if(s.owner==='lead')s.phase='BLOCKED';
  // 같은 반려 사유를 두 번 받은 일꾼은 다른 일꾼이 있으면 교체한다.
  else if(consumedSpecialist(s))s.phase='REDO';
  else if(!c.canWork(s.owner)||(assessment.hard&&c.pool().some(x=>x!==s.owner&&c.canWork(x))))s.phase=c.exhausted();
  else s.phase='REDO';

  if(!['VERIFY','REDO','DECISION_REQUIRED'].includes(s.phase)){
    s.escalations.push({...assessment,from:s.owner,to:s.phase,round:s.iteration,reason:input.rationale,prior_phase:from});
  }
  // 같은 실수가 반복돼 교체할 때는 바로 다음 일꾼에게 넘기기 전에 위원회로 원인부터 보라고 권한다.
  const committeeFits=(s.consult_runs??0)+2<=CONSULT_CAP;
  s.hint=assessment.hard&&s.phase==='ALTERNATIVE_REQUIRED'&&committeeFits
    ?{suggest:'consult',mode:'committee',reason:'repeated failure; get a root cause and plan before the next worker'}
    :null;
  s.escalation_assessment=assessment;
  c.save();
  return s;
}

function review(c,input) {
  if(c.writerHeld())throw Error('Writer still present; recover');
  const s=c.s;
  // 옵트인 작업의 출구는 review()가 아니다. 게이트에 있으면 액션 자체가 거부되고, REVIEW에 있어도 채택으로 VERIFY에 닿지 않는다.
  if(s.configuration.review?.strategy==='lead-gated-adaptive'){
    throw Error('ADAPTIVE_REVIEW: the lead cannot replace a missing independent review; record a lead-decision');
  }
  // adopt: 보류된 위임 판정을 그대로 채택. 아니면 리드 자신의 판정(위임 판정이 있었다면 덮어쓴 것으로 기록).
  if(input.adopt===true){
    if(!c.s.pending_review)throw Error('No pending delegated review to adopt');
    return applyReview(c,{...c.s.pending_review,adopted_by_lead:true});
  }
  const overridden=c.s.pending_review
    ?{overrode:c.s.pending_review.reviewed_by,overrode_verdict:c.s.pending_review.verdict}
    :{};
  return applyReview(c,{...input,reviewed_by:'lead',...overridden});
}

function decide(c,input) {
  const s=c.s;
  if(typeof input.decision!=='string'||!input.decision.trim())throw Error('Record architecture decision');
  c.art(`decision-${s.iteration}.json`,input);
  s.phase=s.owner!=='lead'&&(c.canWork(s.owner)||consumedSpecialist(s))?'REDO':c.exhausted();
  c.save();
  return s;
}

function verify(c,input) {
  const s=c.s;
  const brief=read(path.join(c.taskdir(),`brief-${s.iteration}.json`));
  const auto=!!brief.acceptance_commands;
  // brief에 acceptance_commands가 있으면 컨트롤러가 직접 돌린 결과가 증거다. 리드가 적는 tests는 그때 선택 사항이다.
  const manual=Array.isArray(input.tests)&&input.tests.length>0;
  const passing=input.acceptance_satisfied===true&&(manual||auto)
    &&(!manual||input.tests.every(t=>typeof t.command==='string'&&t.command.trim()&&t.status==='pass'));
  if(!passing)throw Error(auto?'acceptance_satisfied:true required (the controller runs acceptance_commands itself)':'Passing verification evidence required');
  const accepted=input.allow_out_of_scope===undefined?[]:parseScopeExceptions(input.allow_out_of_scope);
  const now=snapshot(c.root);
  if(now.digest!==s.post_digest){
    s.phase='RECOVERY_REQUIRED';
    c.save();
    throw Error('Tree drift during verification');
  }
  // 마지막 관문: 라운드 단위 검사를 다 통과했어도, 최초 기준선과 비교해 허용 범위 밖 변경이 남아 있으면 닫지 않는다.
  const before=s.scope_exceptions;
  s.scope_exceptions=[...(before??[]),...stampExceptions(accepted,s.iteration)];
  const stray=c.outsideBaseline(now);
  if(stray.length){
    s.scope_exceptions=before;
    throw Error(`Out-of-scope changes since the baseline: ${stray.join(', ')}; revert them (the task will need another round), or pass allow_out_of_scope [{path, reason}] to accept them knowingly`);
  }
  if(acceptanceHalt(c,null)){s.scope_exceptions=before;c.save();return s;}
  let evidence=null;
  if(auto){
    // finish 직후 실행이 통과했고 그 뒤로 트리와 무시된 파일이 그대로면 같은 상태에 대한 같은 증거이므로 다시 돌리지 않는다.
    const prev=s.acceptance?.round===s.iteration?s.acceptance:null;
    const after=prev?.ignored_after?c.optional(prev.ignored_after):null;
    const priorEvidence=prev?.file?c.optional(prev.file):null;
    const proven=prev?.quiescent===true&&priorEvidence?.results?.every(r=>r.quiescence?.quiescent===true);
    const ignoredNow=after&&proven&&prev.status==='pass'&&prev.tree_digest===now.digest?ignoredManifest(c.root,brief.acceptance_artifacts):null;
    if(ignoredNow&&!ignoredChanges(after,ignoredNow).length)evidence={status:'pass',reused:prev.file};
    else {
      evidence=acceptanceRun(c,brief,'verify',after??c.optional(`ignored-base-${s.iteration}.json`),{trust:input.acceptance_trust_ignored===true});
      if(acceptanceHalt(c,evidence)){s.scope_exceptions=before;c.save();return s;}
      if(evidence.status==='skipped'){
        s.scope_exceptions=before;
        c.save();
        throw Error(`Acceptance commands not run: ${evidence.reason}. Changed: ${evidence.ignored_changes.join(', ')}`);
      }
      // VERIFY에서 실패하면 닫지 않고 finish 때와 같은 규칙으로 되돌린다(리드 라운드는 BLOCKED).
      if(evidence.status==='fail'){
        s.scope_exceptions=before;
        const failed=evidence.results.filter(r=>r.status!=='pass');
        return applyReview(c,{verdict:'redo',reviewed_by:'controller',
          rationale:`Acceptance commands failed during verification (${failed.map(r=>r.command).join(', ')})`,
          blocking_criteria:failed.map(r=>'Acceptance: '+r.command),commands_run:brief.acceptance_commands,
          independent_diff_review:true,acceptance_feedback:failureFeedback(evidence.results)});
      }
    }
  }
  if(acceptanceHalt(c,null))return s;
  c.art('verification.json',{...input,...(evidence?{acceptance:evidence.reused?evidence:{file:s.acceptance.file,status:evidence.status}}:{})});
  s.phase='CLOSE';
  s.closed_at=new Date().toISOString();
  c.save();
  return s;
}

// ── 복구 ────────────────────────────────────────────────────────────

function recover(c,input) {
  const s=c.s;
  if(input.quiescent!==true||typeof input.reason!=='string'||!input.reason.trim()){
    throw Error('Recovery requires stopped writers and rationale');
  }
  // 범위 밖에 남은 파일을 리드가 알고 받아들이는 경우. 상태를 바꾸기 전에 입력부터 검사한다.
  const accepted=input.allow_out_of_scope===undefined?[]:parseScopeExceptions(input.allow_out_of_scope);
  if(['PLAN','REDO','ALTERNATIVE_REQUIRED','TAKEOVER_REQUIRED'].includes(s.phase)){
    // 디스패치 전에 컨트롤러가 죽어 남은 고아 lease. 소모된 시도는 되돌리지 않는다.
    const orphan=assertLease(c.root,input.token);
    if(orphan.task_id!==s.task_id)throw Error('Orphan lease belongs to another task');
    if(orphan.round>s.iteration)s.attempts[orphan.owner]++;
    s.owner=orphan.owner;
    s.iteration=Math.max(s.iteration,orphan.round);
  }
  s.scope_exceptions=[...(s.scope_exceptions??[]),...stampExceptions(accepted,s.iteration)];
  c.art(`recovery-${Date.now()}.json`,{...input,current:snapshot(c.root),prior_phase:s.phase});
  s.phase='RECOVERY_REQUIRED';
  c.save();
  if(c.writerHeld())release(c.root,input.token);
  s.writer=null;
  fs.rmSync(acceptanceMarker(c),{force:true});
  s.phase=s.iteration===0?'PLAN':s.result_failures>=2||s.owner==='lead'||(!c.canWork(s.owner)&&!consumedSpecialist(s))?c.exhausted():'REDO';
  c.save();
  return s;
}

// allow_out_of_scope: [{path, reason}]. 범위 밖 변경을 알고 받아들일 때 남기는 기록이다.
function parseScopeExceptions(list) {
  const valid=Array.isArray(list)&&list.every(e=>e&&contract.safePath(e.path)&&typeof e.reason==='string'&&e.reason.trim());
  if(!valid)throw Error('Invalid allow_out_of_scope: a list of {path, reason} with a repository-relative path and a reason');
  return list.map(e=>({path:e.path,reason:e.reason}));
}
const stampExceptions=(list,round)=>list.map(e=>({...e,round,at:new Date().toISOString()}));

// ── 진입점 ──────────────────────────────────────────────────────────

const LEAD_DECISIONS=['APPROVE','REDO','REASSIGN_TO_SONNET','REASSIGN_OTHER','ESCALATE','BLOCK'];
const namedEvidence=v=>typeof v==='string'?v.trim().length>0:Array.isArray(v)&&v.length>0&&v.every(x=>typeof x==='string'&&x.trim());

function roundUsage(c) {
  const file=`usage-${c.s.iteration}.json`;
  const usage=c.optional(file);
  return usage?{recorded:true,file,usage}:{recorded:false};
}

function nextGrant(s,executor,strategy,criticality,reason) {
  if(executor==='sol'&&(s.apex_rounds??0)>=APEX_ROUND_CAP)throw Error('ROLE_GATE: Sol APEX round cap reached; BLOCK or approve verified work');
  if(s.implement_grant&&s.implement_grant.round==null)throw Error('ROLE_GATE: an implement grant is already open');
  return makeGrant({executor,strategy,criticality,reason,revision:(s.implement_grant?.revision??0)+1});
}

// 옵트인 작업의 최종 판정. 모델 호출은 하지 않고, APPROVE도 CLOSE로 가지 않는다.
function leadDecision(c,input) {
  const s=c.s;
  if(s.configuration.review?.strategy!=='lead-gated-adaptive')throw Error('LEAD_DECISION: the lead gate is only for lead-gated-adaptive');
  if(c.writerHeld())throw Error('Writer still present; recover');
  if(!sameAssignment(c.optional('assignment.json'),s.assignment))throw Error('ADAPTIVE_REVIEW: assignment does not match the controller record');
  const requested=input.decision;
  const normalized=requested==='REDO_SAME_OWNER'?'REDO':requested;
  if(!LEAD_DECISIONS.includes(normalized))throw Error('LEAD_DECISION: decision must be APPROVE, REDO, REDO_SAME_OWNER, REASSIGN_TO_SONNET, REASSIGN_OTHER, ESCALATE, or BLOCK');
  const rationale=typeof input.rationale==='string'?input.rationale.trim():'';
  if(!rationale)throw Error('LEAD_DECISION: rationale must be text');
  if(input.decision_usage!==undefined){
    const u=input.decision_usage;
    if(!u||typeof u.source!=='string'||!u.source.trim()||u.source.length>120||!Number.isFinite(u.total_tokens)||u.total_tokens<0||Object.keys(u).some(k=>!['source','total_tokens'].includes(k)))throw Error('LEAD_DECISION: decision_usage requires source and nonnegative total_tokens');
  }
  if(typeof input.contract_change!=='boolean')throw Error('LEAD_DECISION: contract_change must be boolean');
  if(input.baseline_digest!==s.post_digest)throw Error('LEAD_DECISION: baseline_digest does not match the round digest');
  if(snapshot(c.root).digest!==s.post_digest){
    s.phase='RECOVERY_REQUIRED';
    c.save();
    throw Error('Tree drift before lead decision');
  }
  const plan=planReview(s.owner,s.assignment);
  const direct=plan.reviewers.length===1&&plan.reviewers[0]==='lead';
  const records=s.review_results?.[s.iteration]??[];
  let grant=null,next_executor=null,required_reviewer=null,phase,lead_filled=null,keep_owner=null,overruled=null;
  if(normalized==='APPROVE'){
    if(input.contract_change===true)throw Error('LEAD_DECISION: APPROVE is refused when the contract changed');
    const raw=read(path.join(c.taskdir(),`raw-result-${s.iteration}.json`));
    if(raw.status!=='complete')throw Error('LEAD_DECISION: an incomplete result cannot be approved');
    if(direct){
      if(input.diff_reviewed!==true)throw Error('LEAD_DECISION: APPROVE requires diff_reviewed:true after reading the diff');
      if(!namedEvidence(input.tests_checked))throw Error('LEAD_DECISION: APPROVE requires tests_checked naming the tests that were read');
      if(!namedEvidence(input.changed_scope))throw Error('LEAD_DECISION: APPROVE requires changed_scope naming the change that was read');
    } else {
      // 끝낸 리뷰어 중 하나라도 pass가 아니면 승인하지 않는다. 자리가 비었으면(한도·장애) 리드가 직접 diff를 읽고 채울 수 있다.
      // 근거 없는 반려(evidence:false)만은 리드가 직접 diff를 읽고 overrule_reason을 남겨 뒤집을 수 있다. 뒤집힌 자리는 리드가 채운 것으로 센다.
      const finished=records.filter(r=>r.ok);
      const leadReviewed=s.owner!=='lead'&&input.diff_reviewed===true&&namedEvidence(input.tests_checked)&&namedEvidence(input.changed_scope);
      const against=finished.filter(r=>r.verdict!=='pass'||r.digest!==s.post_digest);
      if(against.length){
        const reason=typeof input.overrule_reason==='string'?input.overrule_reason.trim():'';
        const overrulable=against.every(r=>r.evidence===false&&r.digest===s.post_digest);
        if(!(overrulable&&reason&&leadReviewed)){
          throw Error('LEAD_DECISION: APPROVE is refused unless every mandatory review passed on the round digest'
            +(overrulable?'; a rejection without file:line evidence can be overruled with overrule_reason, diff_reviewed, tests_checked and changed_scope':''));
        }
        overruled={executors:against.map(r=>r.executor),reason};
      }
      const coverage=reviewCoverage(plan,records.filter(r=>!overruled?.executors.includes(r.executor)),s.post_digest);
      if(!coverage.covered){
        const direct_fill=leadReviewed;
        if(!direct_fill)throw Error('LEAD_DECISION: APPROVE is refused unless every mandatory review passed on the round digest; '
          +'for a missing reviewer ('+coverage.gaps.join(', ')+') delegate-review a substitute or name diff_reviewed, tests_checked and changed_scope');
        lead_filled=coverage.gaps;
      }
    }
    phase='VERIFY';
  } else if(normalized==='REDO'){
    // 같은 실수를 세 번 시키지 않는다. 그래도 같은 일꾼에게 맡기려면 리드가 이유를 남긴다.
    const repeated=repeatedCriteria(s,panelBlocking(records));
    if(repeated.length&&swapTargets(c,s).length){
      keep_owner=typeof input.keep_owner_reason==='string'?input.keep_owner_reason.trim():'';
      if(!keep_owner)throw Error(`LEAD_DECISION: ${s.owner} was rejected again on ${repeated.join(', ')}; REASSIGN_OTHER (${swapTargets(c,s).join(', ')}) or give keep_owner_reason to REDO`);
    }
    if(s.owner==='sol'){
      if(s.assignment?.strategy!=='sol_apex'||s.assignment?.criticality!=='apex')throw Error('ROLE_GATE: Sol implements only an APEX round');
      grant=nextGrant(s,'sol','sol_apex','apex',rationale);
    } else if(s.owner==='sonnet'){
      grant=nextGrant(s,'sonnet','reassign_to_sonnet',s.assignment.criticality,rationale);
    }
    phase='REDO';
  } else if(normalized==='REASSIGN_TO_SONNET'){
    if(s.assignment?.strategy==='sol_apex')throw Error('ROLE_GATE: an APEX task stays with Sol');
    if(s.owner==='sonnet')throw Error('LEAD_DECISION: REASSIGN_TO_SONNET requires a different executor; use REDO for the same owner');
    grant=nextGrant(s,'sonnet','reassign_to_sonnet',s.assignment.criticality,rationale);
    next_executor='sonnet';
    required_reviewer='sol';
    phase='ALTERNATIVE_REQUIRED';
  } else if(normalized==='REASSIGN_OTHER'){
    const allowed=['grok','antigravity','haiku','luna'];
    if(input.executor!==undefined){
      if(!allowed.includes(input.executor))throw Error('LEAD_DECISION: REASSIGN_OTHER executor must be grok, antigravity, haiku, or luna');
      if(input.executor===s.owner)throw Error('LEAD_DECISION: REASSIGN_OTHER requires a different executor');
    }
    next_executor=input.executor??null;
    phase='ALTERNATIVE_REQUIRED';
  } else if(normalized==='ESCALATE'){
    phase='DECISION_REQUIRED';
  } else {
    phase='BLOCKED';
  }
  const record={
    decision:normalized,requested_decision:requested,rationale,baseline_digest:s.post_digest,contract_change:input.contract_change,
    round:s.iteration,owner:s.owner,required_reviewer,next_executor,consumed_usage:roundUsage(c),
    implementation_usage:roundUsage(c),decision_usage:input.decision_usage??null,
    authority:{source:'controller-command',observed_model:s.lead_model??null,model_verified:false},
    ...(input.diff_reviewed!==undefined?{diff_reviewed:input.diff_reviewed===true}:{}),
    ...(input.tests_checked!==undefined?{tests_checked:input.tests_checked}:{}),
    ...(input.changed_scope!==undefined?{changed_scope:input.changed_scope}:{}),
    ...(grant?{implement_grant_revision:grant.revision}:{}),
    ...(lead_filled?{lead_filled_seats:lead_filled}:{}),
    ...(keep_owner?{keep_owner_reason:keep_owner}:{}),
    ...(overruled?{overruled_reviews:overruled}:{})
  };
  const file=`lead-decision-${s.iteration}.json`;
  if(grant){
    s.implement_grant=grant;
    c.art(`implement-grant-${grant.revision}.json`,grant);
  }
  c.art(file,record);
  s.lead_decision={...record,file};
  if(normalized!=='APPROVE'){
    const blocking=[...new Set(records.flatMap(r=>r.blocking_criteria??[]).filter(x=>typeof x==='string'&&x.trim()))];
    s.reviews.push({
      verdict:normalized==='REDO'?'redo':normalized==='ESCALATE'||normalized==='BLOCK'?'decision':'alternative',
      rationale,blocking_criteria:blocking.length?blocking:[rationale],commands_run:['lead-decision'],
      independent_diff_review:direct?input.diff_reviewed===true:true,reviewed_by:'lead',lead_decision:normalized,
      owner:s.owner,round:s.iteration,findings:records.flatMap(r=>Array.isArray(r.findings)?r.findings:[])
    });
  }
  s.pending_review=null;
  s.phase=phase;
  c.save();
  return {status:'decided',decision:normalized,phase:s.phase,lead_decision:s.lead_decision};
}

// 한 라운드짜리 구현 승인. 워커를 띄우지 않고, 기존 writer가 있으면 거절한다.
function grantImplement(c,input) {
  const s=c.s;
  if(s.configuration.review?.strategy!=='lead-gated-adaptive')throw Error('ROLE_GATE: implement grants require review.strategy lead-gated-adaptive');
  if(!sameAssignment(c.optional('assignment.json'),s.assignment))throw Error('ADAPTIVE_REVIEW: assignment does not match the controller record');
  if(c.writerHeld())throw Error('Writer still present; recover');
  if(s.implement_grant&&s.implement_grant.round==null)throw Error('ROLE_GATE: an implement grant is already open');
  const reason=typeof input.reason==='string'?input.reason.trim():'';
  if(!reason)throw Error('ROLE_GATE: grant reason must be text');
  const revision=(s.implement_grant?.revision??0)+1;
  let grant;
  if(input.executor==='sonnet'){
    if(input.strategy!=='reassign_to_sonnet')throw Error('ROLE_GATE: Sonnet reassignment requires strategy reassign_to_sonnet');
    if(s.assignment?.strategy==='sol_apex')throw Error('ROLE_GATE: an APEX task stays with Sol');
    grant=makeGrant({executor:'sonnet',strategy:'reassign_to_sonnet',criticality:s.assignment.criticality,reason,revision});
  } else if(input.executor==='sol'){
    if(input.strategy!=='sol_apex')throw Error('ROLE_GATE: Sol implement grant requires strategy sol_apex');
    if(s.assignment?.strategy!=='sol_apex'||s.assignment?.criticality!=='apex')throw Error('ROLE_GATE: Sol implements only an APEX round');
    grant=makeGrant({executor:'sol',strategy:'sol_apex',criticality:'apex',reason,revision});
  } else throw Error('ROLE_GATE: only sonnet or sol can receive an implement grant');
  s.implement_grant=grant;
  c.art(`implement-grant-${grant.revision}.json`,grant);
  c.save();
  return {status:'granted',grant};
}

const ACTIONS={consult,'consult-finish':consultFinish,begin,finish,review,decide,verify,recover,'grant-implement':grantImplement,'lead-decision':leadDecision};

export function run(root,action,input={}) {
  root=repo(root);
  const c=openControl(root);
  try {
    c.action=action;
    c.load();
    const before=c.s?.phase;
    let result;
    try{
      result=dispatch(c,action,input);
    } catch(e){
      // 액션이 상태를 저장한 뒤 예외를 던져도 종료 정산은 빠뜨리지 않는다.
      c.load();
      afterTransition(c,before);
      throw e;
    }
    afterTransition(c,before);
    return result;
  } finally {
    c.unlock();
  }
}

function dispatch(c,action,input) {
  if(fs.existsSync(acceptanceMarker(c))){
    const pending=read(acceptanceMarker(c));
    if(!c.s||c.s.task_id!==pending.state.task_id)c.s=pending.state;
    if(!c.optional('initial-brief.json'))c.art('initial-brief.json',pending.brief);
    if(!c.optional('baseline.json'))c.art('baseline.json',pending.baseline);
    c.s.phase='RECOVERY_REQUIRED';
    c.s.last_errors=['ACCEPTANCE_NOT_QUIESCENT: interrupted or unproven acceptance run; confirm stopped processes before recovery'];
    c.save();
    if(!['recover','archive','status','report'].includes(action))throw Error(c.s.last_errors[0]);
  }
  if(action==='init')return init(c,input);
  if(!c.s)throw Error('Initialize first');
  if(action==='archive')return archive(c,input);

  // 다른 스키마(main 브랜치의 Codex 리드 작업 포함)는 재해석하지 않는다.
  if(c.s.schema_version!==SCHEMA_VERSION){
    if(action==='status'){
      return {...c.s,legacy:true,next_action:'Confirm all processes stopped and archive with evidence; do not reinterpret an active lease'};
    }
    throw Error('LEGACY_STATE: inspect status; confirm stopped writers then archive with a reason before creating an Opus-led task');
  }
  if(action==='status')return status(c,input);
  if(action==='report')return report(c.root,input.task_id??c.s.task_id);

  // 상담 중에는 다음 수를 두지 않는다. 결과를 보고 판단한다.
  if(c.s.open_consult&&action!=='consult-finish'){
    throw Error('Consult '+c.s.open_consult.id+' in progress; run its bridge, then consult-finish');
  }
  assertAction(c.s.phase,action,input);
  // 위임 리뷰: 이번 라운드를 구현하지 않은 다른 모델이 읽기 전용으로 판정한다. 상담 장치를 그대로 쓴다.
  if(action==='delegate-review'){
    action='consult';
    input={...input,mode:'review'};
    c.action=action;
  }
  const handler=ACTIONS[action];
  if(!handler)throw Error('Unknown action '+action);
  return handler(c,input);
}

if(isMain(import.meta.url)) {
  try {
    const [action,root,...rest]=process.argv.slice(2);
    const file=rest[0]&&!rest[0].startsWith('--')?rest.shift():undefined;
    const flags=rest;
    if(!action||!root)throw Error('Usage: node fusion-state.mjs ACTION REPO_ROOT [INPUT.json] [--executor NAME]');
    // migrate는 상태가 없어도 되고 컨트롤러 잠금도 쓰지 않는다(옮기는 대상이 잠금 폴더 자체이기 때문).
    if(action==='migrate'){
      console.log(JSON.stringify(migrate(repo(root)),null,2));
      process.exit(0);
    }
    // 감시는 읽기 전용이다. --watch가 컨트롤러 잠금을 잡고 있으면 라운드가 멈춘다.
    if(action==='monitor'){
      const resolved=repo(root);
      if(file)throw Error('monitor reads the task directory; it does not take an input file');
      const watch=flags.includes('--watch');
      if(watch&&flags.includes('--once'))throw Error('monitor accepts only one of --once or --watch');
      if(flags.some(flag=>flag!=='--watch'&&flag!=='--once'))throw Error('monitor accepts --once or --watch');
      const stateFile=controlPath(resolved,'state.json');
      if(!fs.existsSync(stateFile))throw Error('Initialize first');
      const state=read(stateFile);
      if(!state?.task_id)throw Error('Initialize first');
      const taskdir=controlPath(resolved,'tasks',state.task_id);
      const text=()=>formatWatch(readRoundMonitors(taskdir));
      process.stdout.write(text());
      if(watch){
        let last=text();
        const timer=setInterval(()=>{
          const next=text();
          if(next!==last){last=next;process.stdout.write(next);}
        },1000);
        const stop=()=>{clearInterval(timer);process.exit(0);};
        process.on('SIGINT',stop);process.on('SIGTERM',stop);
      }
    } else {
    const input=readInput(file);
    if(action==='status'&&flags.includes('--summary')&&flags.includes('--monitor'))throw Error('status summary and monitor are separate views');
    if(action==='status'&&flags.length===1&&(flags[0]==='--summary'||flags[0]==='--monitor')){
      input[flags[0]==='--summary'?'summary':'monitor']=true;
      flags.length=0;
    }
    if(flags.length){
      if(action!=='init'||flags.length!==2||flags[0]!=='--executor')throw Error('Only init accepts --executor NAME');
      input.executor=flags[1];
    }
    const out=action==='autopilot'?await (await import('./autopilot.mjs')).autopilot(root,input):run(root,action,input);
    console.log(JSON.stringify(out,null,2));
    }
  } catch(e){
    printError(e);
  }
}
