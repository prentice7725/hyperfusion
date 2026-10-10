import {readInput,printError} from './cli.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {isMain} from './platform.mjs';
import {read,atomic,repo,hash} from './artifact.mjs';
import {safePath} from './contracts.mjs';
import {config,EXECUTORS,REVIEWERS,TASK_KINDS,DIFFICULTIES,IMAGE_EXECUTORS} from './executor-config.mjs';
import {adapter} from './adapters/index.mjs';
import {matchRule} from './router.mjs';
import {controlPath,ensureControl,acquireLock} from './control-dir.mjs';

// 프로젝트 층: 리드가 기획 문서를 읽고 팀을 꾸려 보고하고, 사용자가 승인한 팀으로 마일스톤을 진행한다.
// 승인 전에는 작업을 시작할 수 없고, 마일스톤이 끝나면 체크포인트 보고와 사용자 확인 전에는 다음으로 못 넘어간다.

// 팀원 기본 역할. 리드가 구성안을 짤 때 출발점으로 쓰고, 프로젝트마다 바꾼다.
export const CATALOG={
 sonnet:{model:'claude-sonnet-5-5',role:'핵심 구현: 중·고난도 코드, 테스트 설계, 리팩터',owns:['code:medium|high','tests','refactor']},
 grok:{model:null,role:'이미지 애셋 생성, 빠른 일반 구현',owns:['image-asset']},
 antigravity:{model:null,role:'UI·프론트엔드, 문서',owns:['ui','docs']},
 haiku:{model:'claude-haiku-5-5',role:'빠른 구현 보조: 쉬운 코드, 문서, 테스트 보강',owns:[]},
 luna:{model:'gpt-6-luna',role:'쉬운 구현·소규모 수정, 기계적 대량 편집, 이미지 애셋 보조',owns:['code:low']},
 sol:{model:'gpt-6.1-sol',role:'리뷰 전담(판정 책임), 위원회 상담',owns:[]}
};
export const MEMBERS=Object.keys(CATALOG);

const str=v=>typeof v==='string'&&v.trim().length>0;
const strs=v=>Array.isArray(v)&&v.every(str);
const file=root=>controlPath(root,'project.json');
const lockOf=root=>controlPath(root,'locks/control.lock');
export const loadProject=root=>fs.existsSync(file(root))?read(file(root)):null;
export const saveProject=(root,p)=>atomic(file(root),p);

// 'code:medium|high' → {kind:'code', difficulty:['medium','high']}
export function parseOwn(spec) {
 const [kind,d]=String(spec).split(':');
 if(!TASK_KINDS.includes(kind))throw Error(`Unknown task kind in owns: ${spec}`);
 const difficulty=d?d.split('|'):undefined;
 if(difficulty&&!difficulty.every(x=>DIFFICULTIES.includes(x)))throw Error(`Unknown difficulty in owns: ${spec}`);
 return {kind,difficulty};
}

const withLock=(root,fn)=>{
 ensureControl(root);
 const release=acquireLock(lockOf(root));
 try{return fn();}finally{release();}
};

// 구성안 검사. 문제는 오류로, 애매한 점은 경고로 돌려준다(경고는 보고서에 그대로 실린다).
export function validatePlan(root,plan) {
 const warnings=[];
 if(!plan||!str(plan.name)||!str(plan.summary))throw Error('Plan needs name and summary');
 if(!Array.isArray(plan.sources)||!plan.sources.length||!plan.sources.every(p=>safePath(p)&&fs.existsSync(path.join(root,p))&&fs.statSync(path.join(root,p)).isFile()))
  throw Error('Plan needs sources: the planning documents you read (repository-relative files that exist)');
 if(!Array.isArray(plan.team)||!plan.team.length)throw Error('Plan needs a team');
 const seen=new Set();
 for(const t of plan.team){
  if(!MEMBERS.includes(t?.member))throw Error('Unknown team member '+t?.member+'; choose from '+MEMBERS.join(', '));
  if(seen.has(t.member))throw Error('Duplicate team member '+t.member);seen.add(t.member);
  if(!str(t.role)||!str(t.why))throw Error(`Team member ${t.member} needs role and why`);
  if(!Array.isArray(t.owns))throw Error(`Team member ${t.member} needs owns (task kinds, may be empty)`);
  t.owns.forEach(parseOwn);
  if(!IMAGE_EXECUTORS.includes(t.member)&&t.owns.some(o=>parseOwn(o).kind==='image-asset'))throw Error(`${t.member} cannot generate images; image-asset can be owned only by ${IMAGE_EXECUTORS.join(', ')}`);
  if(t.member==='sol'&&t.owns.length)throw Error('sol reviews and advises only; it cannot own task kinds');
  if(t.member!=='sol'&&!t.owns.length)warnings.push(`${t.member}: 담당 작업 종류가 없어 예비 인력으로만 투입됨`);
 }
 // 쓰지 않는 팀원도 이유와 함께 명시해야 한다. 빠뜨린 건지 뺀 건지 보고서에서 구분되게.
 if(!Array.isArray(plan.excluded))throw Error('Plan needs excluded (members not used, with why; may be empty)');
 for(const x of plan.excluded){
  if(!MEMBERS.includes(x?.member)||!str(x.why))throw Error('Each excluded entry needs a known member and why');
  if(seen.has(x.member))throw Error(`${x.member} is both on the team and excluded`);seen.add(x.member);
 }
 const missing=MEMBERS.filter(m=>!seen.has(m));
 if(missing.length)throw Error('Decide on every member (team or excluded with why): '+missing.join(', '));
 const implementers=plan.team.map(t=>t.member).filter(m=>EXECUTORS.includes(m));
 if(!implementers.length)throw Error('The team needs at least one implementer');
 const members=plan.team.map(t=>t.member);
 plan.review??=members.includes('sol')?{by:'delegate',reviewers:['sol',...implementers]}:{by:'lead'};
 if(!['lead','delegate'].includes(plan.review.by))throw Error('review.by must be lead or delegate');
 if(plan.review.strategy!==undefined&&plan.review.strategy!=='lead-gated-adaptive')throw Error('Unknown project review.strategy');
 if(plan.review.auto_apply!==undefined&&typeof plan.review.auto_apply!=='boolean')throw Error('Project review.auto_apply must be boolean');
 if(plan.review.strategy==='lead-gated-adaptive'){
  if(plan.review.by!=='delegate')throw Error('Adaptive project review requires delegate');
  const required=new Set(implementers.flatMap(e=>e==='luna'?['sonnet']:e==='grok'||e==='antigravity'?['sol','sonnet']:['sol']));
  if([...required].some(e=>!members.includes(e)))throw Error('Adaptive project team is missing mandatory reviewer(s): '+[...required].filter(e=>!members.includes(e)).join(', '));
  warnings.push('Sonnet implementation requires a controller grant; Sol APEX requires a task-specific grant, never owns rules.');
 }
 if(plan.review.by==='delegate'){
  plan.review.reviewers??=members;
  if(!plan.review.reviewers.length||!plan.review.reviewers.every(r=>members.includes(r)&&REVIEWERS.includes(r)))throw Error('Reviewers must be team members');
 }
 if(!Array.isArray(plan.milestones)||!plan.milestones.length)throw Error('Plan needs milestones');
 const ids=new Set(),taskIds=new Set();
 // 실제 배치와 같은 규칙으로 판단해야 보고서와 라우터가 어긋나지 않는다.
 const rules=teamRules(plan);
 for(const m of plan.milestones){
  if(!/^[A-Za-z0-9_-]{1,20}$/.test(m?.id??'')||ids.has(m.id))throw Error('Milestone ids must be unique and short (e.g. M1)');ids.add(m.id);
  if(!str(m.title)||!str(m.goal)||!strs(m.checkpoint)||!m.checkpoint.length)throw Error(`Milestone ${m.id} needs title, goal and checkpoint criteria`);
  if(!Array.isArray(m.tasks)||!m.tasks.length)throw Error(`Milestone ${m.id} needs tasks`);
  for(const t of m.tasks)checkTask(t,taskIds,rules,warnings);
 }
 for(const k of ['risks','questions'])if(plan[k]!==undefined&&!strs(plan[k]))throw Error(`${k} must be a list of strings`);
 return warnings;
}
function checkTask(t,taskIds,rules,warnings) {
 if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(t?.id??'')||taskIds.has(t.id))throw Error('Task ids must be unique valid task_ids: '+t?.id);taskIds.add(t.id);
 if(!str(t.title)||!TASK_KINDS.includes(t.kind)||(t.difficulty!==undefined&&!DIFFICULTIES.includes(t.difficulty)))throw Error(`Task ${t.id} needs title and a valid kind/difficulty`);
 // 종류가 있는 규칙에 맞지 않고 마지막 기본 규칙으로 떨어지면 담당자가 없는 작업이다.
 if(t.kind==='image-asset'&&!matchRule(rules,{task_kind:t.kind}).executors.some(e=>IMAGE_EXECUTORS.includes(e)))warnings.push(`${t.id}: 이미지 생성 가능한 일꾼(${IMAGE_EXECUTORS.join(', ')})이 팀에 없음`);
 else if(matchRule(rules,{task_kind:t.kind,difficulty:t.difficulty}).kind===undefined)warnings.push(`${t.id}: ${t.kind}${t.difficulty?'/'+t.difficulty:''} 담당자가 없어 팀 기본 순서로 배치됨`);
}

// 팀의 담당(owns)을 배치 규칙으로 바꾼다. 난이도가 정해진 규칙이 같은 종류의 일반 규칙보다 먼저 맞는다.
// 보고서의 "1순위", 경고, 실제 배치가 모두 이 규칙과 router.matchRule 하나만 쓴다.
export function teamRules(plan) {
 const implementers=plan.team.map(t=>t.member).filter(m=>EXECUTORS.includes(m));
 const groups=new Map();
 for(const t of plan.team)for(const spec of t.owns){
  const o=parseOwn(spec),key=o.kind+':'+(o.difficulty?.join('|')??'*');
  if(!groups.has(key))groups.set(key,{kind:o.kind,...(o.difficulty?{difficulty:o.difficulty}:{}),members:[]});
  groups.get(key).members.push(t.member);
 }
 const rules=[...groups.values()].sort((a,b)=>(b.difficulty?1:0)-(a.difficulty?1:0))
  .map(g=>({kind:g.kind,...(g.difficulty?{difficulty:g.difficulty}:{}),executors:[...g.members,...implementers.filter(m=>!g.members.includes(m)&&(g.kind!=='image-asset'||IMAGE_EXECUTORS.includes(m)))],why:'승인된 팀 구성'}));
 // 이미지 담당이 없어도 팀에 이미지 생성 가능한 일꾼이 있으면 그쪽으로 보낸다.
 const painters=implementers.filter(m=>IMAGE_EXECUTORS.includes(m));
 if(painters.length&&!groups.has('image-asset:*'))rules.push({kind:'image-asset',executors:painters,why:'이미지 생성 가능한 일꾼'});
 rules.push({executors:implementers,why:'팀 기본 순서'});
 return rules;
}

// 승인된 팀을 작업 설정으로 옮긴다. 빠진 팀원은 이 프로젝트에서 불리지 않는다.
export function teamConfig(plan,base) {
 const implementers=plan.team.map(t=>t.member).filter(m=>EXECUTORS.includes(m));
 return {...base,external:{default:'auto',available:implementers},routing:{...base.routing,rules:teamRules(plan)},
  review:{...base.review,...plan.review},
  project:{name:plan.name,revision:plan.revision}};
}

export const activeMilestone=p=>p.milestones.find(m=>m.status==='active')??null;
const SETTLED=['closed','blocked','archived','dropped'];
const now=()=>new Date().toISOString();

// 컨트롤러가 작업 종료를 알려 줄 때. 마일스톤의 작업이 모두 끝나면 체크포인트 보고 대기로 바꾼다.
export function settleTask(root,taskId,status) {
 const p=loadProject(root);if(!p)return null;
 const m=p.milestones.find(x=>x.tasks.some(t=>t.id===taskId));if(!m)return null;
 const t=m.tasks.find(x=>x.id===taskId);
 // 완료·막힘으로 이미 정산된 작업을 나중의 보관(archive)이 덮어쓰면 체크포인트에서 결과가 사라진다.
 if(status==='archived'&&['closed','blocked'].includes(t.status))return m.status;
 t.status=status;t.settled_at=now();
 if(m.status==='active'&&m.tasks.every(x=>SETTLED.includes(x.status)))m.status='checkpoint_due';
 saveProject(root,p);
 return m.status;
}

// 표 칸 안의 '|'는 칸 구분자로 읽히므로 이스케이프한다(예: code:medium|high).
const cell=v=>String(v??'').replace(/\|/g,'\\|').replace(/\r?\n/g,' ');
const modelOf=(c,m)=>c.executors?.[m]?.model??CATALOG[m].model??'CLI 기본 모델';
const installed=(c,m)=>{try{adapter(m).probe(c.executors?.[m]??{});return true;}catch{return false;}};

export function roster(root) {
 root=repo(root);const c=config(root);
 return MEMBERS.map(m=>({member:m,model:modelOf(c,m),implementer:EXECUTORS.includes(m),default_role:CATALOG[m].role,default_owns:CATALOG[m].owns,installed:installed(c,m)}));
}

// 팀 구성 보고서. 리드는 이걸 그대로 사용자에게 보여 주고 승인이나 변경 지시를 받는다.
export function teamReport(root,p=loadProject(root)) {
 if(!p)throw Error('No project plan; run propose first');
 const c=config(root),L=[];
 L.push(`# ${p.name} — 팀 구성안 (rev ${p.revision}, ${p.status==='PROPOSED'?'승인 대기':p.status})`,'',p.summary,'');
 L.push('## 읽은 기획 문서','',...p.sources.map(s=>`- \`${s.path}\``),'');
 L.push('## 팀','','| 팀원 | 모델 | 역할 | 담당 작업 | 이유 | 설치 |','|---|---|---|---|---|---|');
 for(const t of p.team)L.push(`| ${t.member} | ${cell(modelOf(c,t.member))} | ${cell(t.role)} | ${t.owns.length?cell(t.owns.map(o=>'`'+o+'`').join(', ')):(t.member==='sol'?'리뷰':'예비')} | ${cell(t.why)} | ${installed(c,t.member)?'✓':'✗ 설치 필요'} |`);
 L.push('','- 리드: Claude Opus 5.5 — 계획, 배치, 최종 검증(VERIFY), 설계 결정');
 L.push(`- 리뷰: ${p.review.by==='delegate'?'위임 — '+p.review.reviewers.join(' → ')+' 순서(구현자는 자기 라운드 리뷰 불가)':'리드가 직접'}`,'');
 if(p.review.strategy==='lead-gated-adaptive')L.push('- v0.3: 자동 구현은 External-First, Haiku reserve 유지. 실제 owner로 필수 리뷰를 정하며 호스트 최종 판정 전 VERIFY/CLOSE 금지. Sonnet/Sol은 작업별 controller grant만 허용.','');
 if(p.excluded.length)L.push('## 이번 프로젝트에서 쓰지 않음','','| 팀원 | 이유 |','|---|---|',...p.excluded.map(x=>`| ${x.member} | ${cell(x.why)} |`),'');
 L.push('## 마일스톤','');
 for(const m of p.milestones){
  L.push(`### ${m.id}. ${m.title}${m.status&&m.status!=='pending'?` _(${m.status})_`:''}`,'',`목표: ${m.goal}`,'','| 작업 | 종류 | 난이도 | 1순위 |','|---|---|---|---|');
  const rules=teamRules(p);
  for(const t of m.tasks){
   const r=matchRule(rules,{task_kind:t.kind,difficulty:t.difficulty});
   L.push(`| ${t.id} ${cell(t.title)}${t.added_by?' _(추가)_':''} | ${t.kind} | ${t.difficulty??'-'} | ${r.executors[0]} |`);
  }
  L.push('','체크포인트 기준:',...m.checkpoint.map(x=>`- [ ] ${x}`),'');
 }
 if(p.warnings?.length)L.push('## 확인할 점','',...p.warnings.map(w=>`- ${w}`),'');
 if(p.risks?.length)L.push('## 위험','',...p.risks.map(r=>`- ${r}`),'');
 if(p.questions?.length)L.push('## 결정이 필요한 질문','',...p.questions.map(q=>`- ${q}`),'');
 L.push('---',p.status==='PROPOSED'?'이대로 진행할지, 바꿀 점(예: "luna는 문서도 맡겨", "grok은 빼자")이 있는지 알려 주세요. 승인 전에는 작업을 시작하지 않습니다.':'');
 return L.join('\n');
}

export function propose(root,plan) {
 root=repo(root);
 return withLock(root,()=>{
  const old=loadProject(root);
  if(old&&old.status==='ACTIVE')throw Error('Project is ACTIVE; use amend (team changes need re-approval)');
  const warnings=validatePlan(root,plan);
  const p={version:1,status:'PROPOSED',revision:(old?.revision??0)+1,name:plan.name,summary:plan.summary,
   sources:plan.sources.map(s=>({path:s,sha256:hash(fs.readFileSync(path.join(root,s)))})),
   team:plan.team,excluded:plan.excluded,review:plan.review,
   milestones:plan.milestones.map(m=>({...m,status:'pending',tasks:m.tasks.map(t=>({...t,status:'planned'}))})),
   risks:plan.risks??[],questions:plan.questions??[],warnings,history:[...(old?.history??[]),{at:now(),event:'proposed',by:'lead',revision:(old?.revision??0)+1}]};
  saveProject(root,p);
  return {status:p.status,revision:p.revision,warnings,report:teamReport(root,p)};
 });
}

// 사용자 승인 기록. 리드는 사용자가 실제로 승인한 뒤에만 부르고, 그 말을 그대로 남긴다.
export function approve(root,{user_message}={}) {
 root=repo(root);
 return withLock(root,()=>{
  const p=loadProject(root);
  if(!p||p.status!=='PROPOSED')throw Error('Nothing to approve; propose or amend a plan first');
  if(!str(user_message))throw Error('Record the user\'s own approval words in user_message');
  p.status='ACTIVE';p.history.push({at:now(),event:'approved',by:'user',message:user_message,revision:p.revision});
  if(!p.milestones.some(m=>['active','checkpoint_due','reported'].includes(m.status))){const next=p.milestones.find(m=>m.status==='pending');if(next)next.status='active';}
  saveProject(root,p);
  return {status:p.status,active_milestone:activeMilestone(p)?.id??null};
 });
}

// 구성 변경. 팀·리뷰·마일스톤 추가는 재승인이 필요하고, 진행 중 마일스톤의 작업 추가·제외는 기록만 한다.
export function amend(root,changes={}) {
 root=repo(root);
 return withLock(root,()=>{
  const p=loadProject(root);if(!p)throw Error('No project plan');
  const plan={name:p.name,summary:changes.summary??p.summary,sources:changes.sources??p.sources.map(s=>s.path),team:changes.team??p.team,excluded:changes.excluded??p.excluded,
   review:changes.review??(changes.team?undefined:p.review),milestones:[...p.milestones,...(changes.add_milestones??[]).map(m=>({...m}))],risks:changes.risks??p.risks,questions:changes.questions??p.questions};
  const structural=['team','excluded','review','add_milestones','sources'].some(k=>changes[k]!==undefined);
  for(const a of changes.add_tasks??[]){
   const m=plan.milestones.find(x=>x.id===a.milestone);
   if(!m||['done'].includes(m.status))throw Error('Cannot add tasks to milestone '+a.milestone);
   m.tasks=[...m.tasks,{...a.task,status:'planned',added_by:'lead'}];
   if(m.status==='checkpoint_due')m.status='active';
  }
  for(const d of changes.drop_tasks??[]){
   const t=plan.milestones.flatMap(m=>m.tasks).find(x=>x.id===d.id);
   if(!t||t.status!=='planned'||!str(d.why))throw Error('Only planned tasks can be dropped, with why: '+d.id);
   t.status='dropped';t.drop_reason=d.why;
  }
  const warnings=validatePlan(root,plan);
  Object.assign(p,{summary:plan.summary,team:plan.team,excluded:plan.excluded,review:plan.review,risks:plan.risks??[],questions:plan.questions??[],warnings,
   sources:changes.sources?changes.sources.map(s=>({path:s,sha256:hash(fs.readFileSync(path.join(root,s)))})):p.sources,
   milestones:plan.milestones.map(m=>({...m,status:m.status??'pending',tasks:m.tasks.map(t=>({...t,status:t.status??'planned'}))}))});
  for(const m of p.milestones)if(m.status==='active'&&m.tasks.every(x=>SETTLED.includes(x.status)))m.status='checkpoint_due';
  if(structural){p.status='PROPOSED';p.revision++;}
  p.history.push({at:now(),event:'amended',by:changes.user_message?'user':'lead',message:changes.user_message,structural,revision:p.revision});
  saveProject(root,p);
  return {status:p.status,revision:p.revision,warnings,needs_approval:structural,report:teamReport(root,p)};
 });
}

// 체크포인트 보고서. 마일스톤의 모든 작업이 끝났을 때만 만든다.
export function checkpoint(root) {
 root=repo(root);
 return withLock(root,()=>{
  const p=loadProject(root);if(!p)throw Error('No project plan');
  const m=p.milestones.find(x=>['checkpoint_due','reported'].includes(x.status));
  if(!m){const a=activeMilestone(p);throw Error(a?`Milestone ${a.id} still has open tasks: `+a.tasks.filter(t=>!SETTLED.includes(t.status)).map(t=>t.id).join(', '):'No milestone is due for a checkpoint');}
  const metric=id=>{const f=controlPath(root,'metrics',id+'.json');return fs.existsSync(f)?read(f):null;};
  const L=[`# ${p.name} — 체크포인트 ${m.id}: ${m.title}`,'',`목표: ${m.goal}`,'','## 작업 결과','','| 작업 | 결과 | 투입 | 라운드 | 리뷰 | takeover |','|---|---|---|---|---|---|'];
  const perf={};
  for(const t of m.tasks){
   // 투입은 시도 횟수로 센다. 일꾼이 실패해 사용량 기록이 없는 라운드도 들어간다.
   const x=metric(t.id),used=x?Object.entries(x.attempts??{}).filter(([,n])=>n).map(([e,n])=>`${e==='lead'?'리드':e}×${n}`).join(', '):'-';
   for(const r of x?.review_outcomes??[]){if(r.owner==='lead')continue;perf[r.owner]??={rounds:0,pass:0};perf[r.owner].rounds++;if(r.verdict==='pass')perf[r.owner].pass++;}
   const label={closed:'✅ 완료',blocked:'⛔ 막힘',archived:'보관',dropped:'제외'}[t.status]??t.status;
   L.push(`| ${t.id} ${cell(t.title)} | ${label}${t.drop_reason?' — '+cell(t.drop_reason):''} | ${used||'-'} | ${x?.delegation_count??'-'} | ${x?`${x.review_rounds}회${x.delegated_reviews?` (위임 ${x.delegated_reviews}, 리드 덮어씀 ${x.lead_overrides})`:''}`:'-'} | ${x?.lead_takeovers?'있음':'-'} |`);
  }
  L.push('','## 팀원 성적 (이번 마일스톤)','','| 팀원 | 리뷰받은 라운드 | 통과 |','|---|---|---|',...Object.entries(perf).map(([e,v])=>`| ${e} | ${v.rounds} | ${v.pass} |`));
  const weak=Object.entries(perf).filter(([,v])=>v.rounds>=2&&v.pass/v.rounds<0.5).map(([e])=>e);
  L.push('','## 체크포인트 기준','',...m.checkpoint.map(c=>`- [ ] ${c}`),'','리드가 위 기준을 직접 확인한 결과를 보고와 함께 전한다.','');
  if(weak.length)L.push('## 구성 조정 제안','',...weak.map(e=>`- ${e}: 통과율이 낮음. 담당 작업을 다른 팀원에게 넘기거나 역할 축소 검토`),'');
  const blocked=m.tasks.filter(t=>t.status==='blocked');
  if(blocked.length)L.push('## 막힌 작업','',...blocked.map(t=>`- ${t.id} ${t.title}: 다음 마일스톤에 다시 넣을지, 범위를 바꿀지 결정 필요`),'');
  const next=p.milestones.find(x=>x.status==='pending');
  L.push('## 다음',next?`${next.id}. ${next.title} — ${next.goal} (작업 ${next.tasks.length}개)`:'남은 마일스톤 없음. 확인하시면 프로젝트를 종료합니다.','','---','이대로 다음 마일스톤으로 갈지, 팀이나 계획을 바꿀지 알려 주세요.');
  m.status='reported';m.reported_at=now();p.history.push({at:now(),event:'checkpoint',by:'lead',milestone:m.id});
  saveProject(root,p);
  return {milestone:m.id,report:L.join('\n')};
 });
}

// 체크포인트에 대한 사용자 확인. 변경 지시가 있으면 함께 반영한다(팀 변경은 재승인 필요).
export function ack(root,{milestone,user_message,changes}={}) {
 root=repo(root);
 const out=withLock(root,()=>{
  const p=loadProject(root);if(!p)throw Error('No project plan');
  const m=p.milestones.find(x=>x.id===milestone);
  if(!m||m.status!=='reported')throw Error('Only a reported checkpoint can be acknowledged; run checkpoint first');
  if(!str(user_message))throw Error('Record the user\'s own words in user_message');
  m.status='done';m.acked_at=now();m.ack_message=user_message;
  const next=p.milestones.find(x=>x.status==='pending');
  if(next)next.status='active';else p.status='COMPLETE';
  p.history.push({at:now(),event:'acked',by:'user',milestone,message:user_message});
  saveProject(root,p);
  return {status:p.status,active_milestone:next?.id??null};
 });
 if(changes)return {...out,amend:amend(root,{...changes,user_message})};
 return out;
}

export function status(root) {
 root=repo(root);const p=loadProject(root);
 if(!p)return {project:null};
 const a=activeMilestone(p);
 return {name:p.name,status:p.status,revision:p.revision,active_milestone:a?.id??null,open_tasks:a?a.tasks.filter(t=>t.status==='planned').map(t=>t.id):[],
  checkpoint_due:p.milestones.filter(m=>m.status==='checkpoint_due').map(m=>m.id),milestones:p.milestones.map(m=>({id:m.id,status:m.status,tasks:m.tasks.map(t=>`${t.id}:${t.status}`)}))};
}

if(isMain(import.meta.url)) {
 try{
  const [cmd,root,arg]=process.argv.slice(2);
  const input=()=>readInput(arg);
  const out={roster:()=>roster(root),propose:()=>propose(root,input()),report:()=>({report:teamReport(repo(root))}),approve:()=>approve(root,input()),
   amend:()=>amend(root,input()),checkpoint:()=>checkpoint(root),ack:()=>ack(root,input()),status:()=>status(root)}[cmd];
  if(!out)throw Error('Usage: project.mjs roster|propose PLAN.json|report|approve INPUT.json|amend CHANGES.json|checkpoint|ack INPUT.json|status  (each takes REPO first)');
  const r=out();
  // 보고서는 사람이 읽을 수 있게 그대로 출력하고, 나머지는 JSON으로.
  if(r?.report&&Object.keys(r).length<=6){const {report,...rest}=r;console.log(JSON.stringify(rest,null,2));console.log('\n'+report);}
  else console.log(JSON.stringify(r,null,2));
 }catch(e){printError(e);}
}
