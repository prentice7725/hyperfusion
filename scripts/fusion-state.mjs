import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isMain,resolveExecutable} from './platform.mjs';
import {config,selectExecutor,CAP,CONSULT_CAP,REVIEWERS,REVIEW_RUNS_PER_ROUND} from './executor-config.mjs';
import {adapter} from './adapters/index.mjs';
import {route} from './router.mjs';
import {atomic,immutable,read,repo,snapshot,changes,git,SAFE_DIFF} from './artifact.mjs';
import {acquire,assertLease,release} from './writer-lease.mjs';
import {notify} from './notify.mjs';
import {loadProject,saveProject,teamConfig,activeMilestone,settleTask} from './project.mjs';
import {measure} from './metrics.mjs';
import {workspaceOf,propose,deriveFromState} from './memory-policy.mjs';
import * as contract from './contracts.mjs';
import {ensureControl,isLegacy,migrate,controlRoot,acquireLock} from './control-dir.mjs';

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
  c.requirePhase=(...values)=>{
    if(!values.includes(c.s.phase))throw Error(`Invalid phase ${c.s.phase} for ${c.action}`);
  };

  // 일꾼 예산과 교체 순서
  c.pool=()=>c.s.configuration.external.available;
  c.budget=owner=>c.s.attempts[owner]<CAP[owner];

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
  c.canWork=name=>c.budget(name)&&!c.installError(name);
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
const NEEDS_LEAD=['BLOCKED','TAKEOVER_REQUIRED','DECISION_REQUIRED'];

function afterTransition(c,before) {
  const s=c.s;
  if(!s||s.schema_version!==4||s.phase===before)return;
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

  const requested=selectExecutor(configuration,input.executor);
  // 예전 버전의 기록이 작업 폴더 안(.fusion)에 있으면 새 작업을 시작하지 않는다. 일꾼이 그 폴더를 고칠 수 있기 때문이다.
  if(isLegacy(c.root)){
    throw Error(`LEGACY_CONTROL_DIR: records are inside the workspace (${controlRoot(c.root)}), where workers can edit them. Run: node fusion-state.mjs migrate REPO`);
  }
  // 끝난 작업(완료, 막힘, 보관) 뒤에는 새 작업을 시작할 수 있다. 막힌 작업의 기록은 그대로 남는다.
  if(c.s&&!['CLOSE','ARCHIVED','BLOCKED'].includes(c.s.phase))throw Error('Existing unfinished task; inspect/recover');
  contract.brief(input);
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

  const executor=routing.executor;
  const base=snapshot(c.root);
  c.s={
    schema_version:4,architecture:'opus-lead-v0.3',configuration,routing,
    initial_executor:executor,active_executor:executor,owner:null,
    attempts:{grok:0,antigravity:0,sonnet:0,luna:0,lead:0},
    sessions:{grok:null,antigravity:null,sonnet:null,luna:null},
    task_id:input.task_id,phase:'PLAN',
    lead:configuration.lead,lead_target_model:configuration.lead_model,lead_model:null,
    iteration:0,base_commit:base.head,baseline_dirty:!!base.status,
    writer:null,reviews:[],escalations:[],result_failures:0,started_at:new Date().toISOString(),
    ...(projectTask?{project:{name:projectTask.project,milestone:projectTask.milestone,task:projectTask.id}}:{})
  };
  c.art('initial-brief.json',input);
  c.art('baseline.json',base);
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
  s.phase='ARCHIVED';
  c.save();
  if(s.project)settleTask(c.root,s.task_id,outcome);
  return s;
}

function status(c) {
  const s=c.s;
  return {
    ...s,
    lease_present:c.writerHeld(),
    current_digest:snapshot(c.root).digest,
    remaining:Object.fromEntries(Object.keys(CAP).map(k=>[k,CAP[k]-s.attempts[k]])),
    consult_remaining:CONSULT_CAP-(s.consult_runs??0),
    // 설정에는 있지만 이 PC에 설치되지 않았거나 플래그가 맞지 않는 일꾼. 배치와 takeover 판단에서 빠진다.
    unavailable:c.unavailable()
  };
}

// ── 상담(advisor / committee)과 위임 리뷰 ────────────────────────────

function consult(c,input) {
  const s=c.s;
  const mode=input.mode;
  if(!['advisor','committee','review'].includes(mode))throw Error('Consult mode must be advisor, committee or review');
  if(mode==='review')c.requirePhase('REVIEW');
  else c.requirePhase('PLAN','REVIEW','REDO','ALTERNATIVE_REQUIRED','DECISION_REQUIRED');
  if(c.writerHeld())throw Error('Writer still present; recover');

  if(mode==='review'){
    input={question:`Review round ${s.iteration} by ${s.owner} against every success criterion and give the verdict.`,...input};
    if((s.review_runs?.[s.iteration]??0)>=REVIEW_RUNS_PER_ROUND){
      throw Error(`Delegated review cap reached for round ${s.iteration}; review it yourself`);
    }
  }
  if(typeof input.question!=='string'||!input.question.trim())throw Error('Consult requires a concrete question');
  if(input.focus!==undefined&&!(Array.isArray(input.focus)&&input.focus.every(x=>typeof x==='string')))throw Error('Invalid focus');
  const size=mode==='committee'?2:1;
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
  const explicit=input.executors!==undefined;
  let picks;
  if(explicit){
    if(!Array.isArray(input.executors)||input.executors.length!==size||new Set(input.executors).size!==size){
      throw Error(`${mode} needs ${size} distinct executor(s)`);
    }
    picks=input.executors.map(hire);
    // 자기 작업은 자기가 리뷰하지 않는다.
    if(mode==='review'&&picks.includes(s.owner)){
      throw Error(`${s.owner} implemented round ${s.iteration}; pick a different reviewer`);
    }
  } else if(mode==='review'){
    const failed=s.review_failed?.[s.iteration]??[];
    picks=s.configuration.review.reviewers.filter(e=>e!==s.owner&&!failed.includes(e));
  } else {
    // 기본: 방금 일한 일꾼은 뒤로. 자기 작업을 자기가 검사하지 않게 하고, 위원회는 서로 다른 모델로 꾸린다.
    const order=[...new Set([...s.routing.candidates,...c.pool()])].filter(e=>c.pool().includes(e));
    picks=[...order.filter(e=>e!==s.owner),...order.filter(e=>e===s.owner)];
  }

  const members=[];
  for(const e of picks){
    if(members.length===size)break;
    let cli;
    try{cli=adapter(e).probe(s.configuration.executors[e]??{});}
    catch(err){if(explicit)throw err;continue;}
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
      options:s.configuration.executors[m.executor]??{}
    });
    return [m.member,{transport:'executor-cli',kind:'consult',executor:m.executor,...d,task_id:s.task_id,consult_id:id,member:m.member}];
  });

  const base=snapshot(c.root);
  const roster=members.map(({member,executor})=>({member,executor}));
  c.art(`consult-${id}-base.json`,base);
  for(const [member,request] of requests)c.art(`consult-${id}-${member}.json`,request);
  c.art(`consult-${id}.json`,{id,mode,question:input.question,focus:input.focus??[],members:roster,phase:s.phase});

  if(mode==='review')s.review_runs={...(s.review_runs??{}),[n]:(s.review_runs?.[n]??0)+1};
  else s.consult_runs=(s.consult_runs??0)+size;
  s.hint=null;
  s.open_consult={id,mode,members:roster,digest:base.digest,started_at:new Date().toISOString()};
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
  if(open.mode==='review'&&!violated)applied=applyDelegatedReview(c,open,members[0],results[0]);
  c.save();
  return {...record,results,phase:s.phase,...(applied?{review:applied}:{})};
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
  const delegated={
    verdict,rationale:result.summary,blocking_criteria:blocking,
    commands_run:['delegated read-only review by '+member.executor],independent_diff_review:true,
    reviewed_by:member.executor,consult_id:open.id,confidence:result.confidence,findings:result.findings
  };
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
  c.requirePhase('PLAN','REDO','ALTERNATIVE_REQUIRED','TAKEOVER_REQUIRED');
  contract.brief(input);
  if(input.task_id!==s.task_id)throw Error('Task ID mismatch');

  let owner;
  if(s.phase==='TAKEOVER_REQUIRED'){
    owner='lead';
    if(typeof input.takeover_reason!=='string'||!input.takeover_reason.trim())throw Error('Takeover requires a recorded reason');
  } else if(s.phase==='ALTERNATIVE_REQUIRED'){
    // 지정이 없으면 배치표에서 방금 반려된 일꾼 다음 순번부터 돌아가며 예산 있는 일꾼을 투입한다.
    const pick=input.executor===undefined||input.executor==='auto';
    owner=pick
      ?c.rotation().find(e=>e!==s.owner&&c.canWork(e))
      :selectExecutor(s.configuration,input.executor);
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
      owner=selectExecutor(s.configuration,requested);
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
    const items=[...located,...unmet];
    if(!items.length)throw Error('Last review has no findings or blocking criteria to forward; write lead_feedback yourself');
    input={...input,lead_feedback:items};
  }
  if(s.phase!=='PLAN'&&owner!=='lead')contract.feedback(input.lead_feedback);
  if(!c.budget(owner))throw Error(owner+' round cap reached');

  const round=s.iteration+1;
  const a=owner==='lead'?null:adapter(owner);
  const session=a?(s.sessions[owner]??a.newSession()):null;
  const resume=!!(a&&s.sessions[owner]);
  const options=s.configuration.executors[owner]??{};
  const promptFile=path.join(c.taskdir(),`prompt-${round}.txt`);
  const brief={...input,repo_root:c.root,round};

  // 프로브와 인자 검증은 lease 획득·시도 소모 전에 끝낸다.
  // 실패해도 phase와 시도 예산을 유지해 같은 일꾼으로 다시 시작할 수 있다.
  const cli=a?a.probe(options):null;
  if(a)a.dispatch(brief,{token:'pending',owner},{session,resume,probe:cli,promptFile,options});

  const lease=acquire(c.root,s.task_id,round,owner);
  if(s.owner!==owner)s.result_failures=0;
  s.hint=null;
  s.phase='EXECUTING';
  s.writer=lease;
  s.iteration=round;
  s.owner=owner;
  s.attempts[owner]++;
  if(a){
    s.active_executor=owner;
    if(session)s.sessions[owner]=session;
  }
  c.save();
  c.art(`brief-${round}.json`,input);
  c.art(`base-${round}.json`,snapshot(c.root));

  const request=a
    ?{
      transport:'executor-cli',executor:owner,command:process.execPath,args:[BRIDGE,c.root],
      ...a.dispatch(brief,lease,{session,resume,probe:cli,promptFile,options}),
      task_id:s.task_id,round,token:lease.token
    }
    :{transport:'lead-takeover',brief,token:lease.token};
  c.art(`dispatch-${round}.json`,request);
  return request;
}

function finish(c,input) {
  const s=c.s;
  c.requirePhase('EXECUTING');
  assertLease(c.root,input.token);
  if(input.quiescent!==true)throw Error('Confirm worker and children stopped');

  const n=s.iteration;
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
  s.result_failures=0;
  s.phase='REVIEW';
  c.save();
  release(c.root,input.token);
  s.writer=null;
  c.save();
  return s;
}

// ── 리뷰 ────────────────────────────────────────────────────────────

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
  c.art(`review-${s.iteration}.json`,record);
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
  c.requirePhase('REVIEW');
  if(c.writerHeld())throw Error('Writer still present; recover');
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
  c.requirePhase('DECISION_REQUIRED');
  if(typeof input.decision!=='string'||!input.decision.trim())throw Error('Record architecture decision');
  c.art(`decision-${s.iteration}.json`,input);
  s.phase=s.owner!=='lead'&&c.canWork(s.owner)?'REDO':c.exhausted();
  c.save();
  return s;
}

function verify(c,input) {
  const s=c.s;
  c.requirePhase('VERIFY');
  const passing=Array.isArray(input.tests)&&input.tests.length
    &&input.tests.every(t=>typeof t.command==='string'&&t.command.trim()&&t.status==='pass')
    &&input.acceptance_satisfied===true;
  if(!passing)throw Error('Passing verification evidence required');
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
  c.art('verification.json',input);
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
  c.requirePhase('PLAN','REDO','ALTERNATIVE_REQUIRED','TAKEOVER_REQUIRED','EXECUTING','RECOVERY_REQUIRED','REVIEW');
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
  s.phase=s.result_failures>=2||s.owner==='lead'||!c.canWork(s.owner)?c.exhausted():'REDO';
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

const ACTIONS={consult,'consult-finish':consultFinish,begin,finish,review,decide,verify,recover};

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
  if(action==='init')return init(c,input);
  if(!c.s)throw Error('Initialize first');
  if(action==='archive')return archive(c,input);

  // 다른 스키마(main 브랜치의 Codex 리드 작업 포함)는 재해석하지 않는다.
  if(c.s.schema_version!==4){
    if(action==='status'){
      return {...c.s,legacy:true,next_action:'Confirm all processes stopped and archive with evidence; do not reinterpret an active lease'};
    }
    throw Error('LEGACY_STATE: inspect status; confirm stopped writers then archive with a reason before creating an Opus-led task');
  }
  if(action==='status')return status(c);

  // 상담 중에는 다음 수를 두지 않는다. 결과를 보고 판단한다.
  if(c.s.open_consult&&action!=='consult-finish'){
    throw Error('Consult '+c.s.open_consult.id+' in progress; run its bridge, then consult-finish');
  }
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
    const [action,root,file,...flags]=process.argv.slice(2);
    if(!action||!root)throw Error('Usage: node fusion-state.mjs ACTION REPO_ROOT [INPUT.json] [--executor NAME]');
    // migrate는 상태가 없어도 되고 컨트롤러 잠금도 쓰지 않는다(옮기는 대상이 잠금 폴더 자체이기 때문).
    if(action==='migrate'){
      console.log(JSON.stringify(migrate(repo(root)),null,2));
      process.exit(0);
    }
    const input=file?read(file):{};
    if(flags.length){
      if(action!=='init'||flags.length!==2||flags[0]!=='--executor')throw Error('Only init accepts --executor NAME');
      input.executor=flags[1];
    }
    console.log(JSON.stringify(run(root,action,input),null,2));
  } catch(e){
    console.error(e.message);
    process.exitCode=1;
  }
}
