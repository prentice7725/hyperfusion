import fs from 'node:fs';
import path from 'node:path';
import {read} from './artifact.mjs';
import {workspaceOf} from './memory-policy.mjs';
import {validateLimits} from './budgets.mjs';
import {MEMBERS} from './member-registry.mjs';
import {validateVendors,assertVendor,vendorAllowed} from './vendor-policy.mjs';
import {modelEffort,supportedAgyEfforts,selectAgyModel} from './adapters/agy-model.mjs';
import {validCodingPolicy} from './coding-policy.mjs';
import {grantOnlyMembers,reservedMembers,excludedMembers} from './team-roles.mjs';
import {MEMBER_PROFILES} from './model-registry.mjs';
import {loadTeam,applyTeam,teamFilePath} from './team-file.mjs';

// 구현 일꾼 명단(A급 Terra·Grok·Sonnet, B급 Luna·Haiku·Antigravity). 누가 grant 없이 자동 구현하는지는 리드 계열에 따른 역할(team-roles)이 정한다.
export const EXECUTORS=Object.keys(MEMBERS).filter(n=>MEMBERS[n].implement);
// 리뷰·상담까지 포함한 명단. Sol과 Opus는 이 구현 명단에 넣지 않는다. 둘의 구현은 라운드 승인으로만 연다.
export const REVIEWERS=['sol',...EXECUTORS,'opus'];
// 위임 리뷰는 라운드당 이 횟수까지(리뷰어가 실패하면 한 번 더). 상담 예산과 별도다.
export const REVIEW_RUNS_PER_ROUND=2;
// 위임 리뷰가 앞선 라운드에서 같은 수용 기준을 이 횟수만큼 반려했으면, 그 기준의 다음 반려는 자동 적용하지 않고 리드에게 넘긴다.
export const REVIEW_CONVERGENCE_LIMIT=2;
export const CAP={...Object.fromEntries(EXECUTORS.map(n=>[n,MEMBERS[n].rounds])),lead:1};
export const APEX_ROUND_CAP=3;
// 상담(advisor 1명, committee 2명) 위원 실행 총량. 구현 예산과 별도다.
export const CONSULT_CAP=4;
// 추론 강도(reasoning_effort)로 받는 값. CLI마다 다르다(각 CLI --help 기준).
// Codex: codex exec -c model_reasoning_effort=…, Claude Code·agy: --effort, Grok: --reasoning-effort(Grok 4.7은 high·xhigh).
// 기본 추론 강도. 설정에 reasoning_effort가 없으면 이 값을 쓰고, null이면 플래그를 넘기지 않는다(CLI 기본값).
export const DEFAULT_EFFORT=Object.fromEntries(Object.entries(MEMBERS).map(([n,m])=>[n,m.effort]));
export const EFFORT_LEVELS=Object.fromEntries(Object.entries(MEMBERS).map(([n,m])=>[n,m.efforts]));
export const TASK_KINDS=['code','ui','image-asset','tests','refactor','docs'];
export const DIFFICULTIES=['low','medium','high'];
// 능력(caps): 배치는 이름이 아니라 능력으로 후보를 거른다. 작업 종류마다 필요한 능력이 하나 있다.
// 기본값은 여기, 바꾸거나 새 모델의 능력을 적을 때는 설정의 executors.<이름>.caps로 덮어쓴다.
export const CAPABILITIES=['code','tests','refactor','ui','docs','image-gen'];
export const KIND_NEEDS={code:'code',tests:'tests',refactor:'refactor',ui:'ui',docs:'docs','image-asset':'image-gen'};
// Antigravity CLI와 Claude Code에는 이미지 생성 기능이 없다.
export const DEFAULT_CAPS=Object.fromEntries(EXECUTORS.map(n=>[n,MEMBERS[n].caps]));
export const capsOf=(c,e)=>c?.executors?.[e]?.caps??DEFAULT_CAPS[e]??[];
// 작업 종류가 없으면(분류 안 된 작업) 능력으로 거르지 않는다.
export const canDo=(c,e,kind)=>!kind||capsOf(c,e).includes(KIND_NEEDS[kind]);
// 기본 능력 기준 이미지 생성 일꾼(설정이 없을 때의 참고용).
export const IMAGE_EXECUTORS=EXECUTORS.filter(e=>DEFAULT_CAPS[e].includes('image-gen'));

// 기본 배치표: 능력으로 거른 후보의 처음 순서(선호)다. 규칙에 없는 일꾼도 능력이 있으면 뒤에 붙는다.
// 실측이 아니라 출발점이다. 실적이 쌓이면 router가 성적 나쁜 일꾼을 뒤로 밀고, 새 일꾼은 가끔 먼저 시켜 본다.
// 등급제: 중·고난도 코드·테스트·리팩터는 A급(구독형 Terra → Grok → API 비용이 드는 Sonnet), 쉬운 코드·문서·UI는 B급부터 맡긴다.
// B급이 반려되면 같은 B급에게 다시 맡기지 않고 A급으로 넘긴다(fusion-state의 승급 규칙).
const A_TIER=['terra','grok','sonnet'];
export const DEFAULT_RULES=[
 {kind:'image-asset',executors:['grok','luna'],why:'이미지 생성 능력(image-gen)이 있는 일꾼'},
 {kind:'code',difficulty:['medium','high'],executors:A_TIER,why:'중·고난도 구현은 A급'},
 {kind:'code',difficulty:['low'],executors:['luna','haiku','antigravity',...A_TIER],why:'쉬운 구현은 B급부터'},
 {kind:'tests',executors:A_TIER,why:'테스트 설계·디버깅은 A급'},
 {kind:'refactor',executors:A_TIER,why:'넓은 범위 리팩터는 A급'},
 {kind:'ui',executors:['antigravity',...A_TIER],why:'프론트엔드·UI는 Antigravity(B급)부터'},
 {kind:'docs',executors:['antigravity','haiku','luna',...A_TIER],why:'문서는 B급부터'},
 {executors:A_TIER,why:'분류 없는 작업은 A급'}
];
// External-First 배치표도 같은 등급제다. Sol은 리뷰 전담이라 자동 구현 후보가 아니다.
export const EXTERNAL_FIRST_RULES=structuredClone(DEFAULT_RULES);
export const ROUTING_POLICIES=['classic','external-first'];
// 승인 없이는 자동 구현자가 될 수 없는 일꾼. 승인은 lead-gated-adaptive의 컨트롤러 grant뿐이다.
// 외부 최상위만 든다(Opus 리드면 Sol). A급 Sonnet·Terra는 승인 없이 구현한다.
export const grantOnly=c=>grantOnlyMembers(c);
// 난이도별 시작 강도(작업지시서 v0.3 §5). 운영자가 reasoning_effort를 직접 적은 일꾼에는 적용하지 않는다.
// Grok 4.7 implements at high across difficulties; xhigh is the review seat's effort.
export const DIFFICULTY_EFFORT={grok:{low:'high',medium:'high',high:'high'},antigravity:{low:'low',medium:'medium',high:'high'}};
// Routing preflight and controller dispatch must inspect the same task profile.
export function taskExecutorOptions(configuration,owner,difficulty) {
 const options={...(configuration?.executors?.[owner]??{})};
 if(owner==='antigravity'&&options.models_by_difficulty?.[difficulty])options.model=options.models_by_difficulty[difficulty];
 delete options.models_by_difficulty;
 if(options.max_turns===undefined&&options.max_turns_by_difficulty?.[difficulty]!==undefined)options.max_turns=options.max_turns_by_difficulty[difficulty];
 // Grok counts model loops, not tool calls: a fresh Grok session on a redo spent all 40 loops (67 tools) without a result.
 // 60 loops fit the 40-minute implementation wall cap at the observed pace. Configured limits still take precedence.
 if(options.max_turns===undefined&&MEMBER_PROFILES[owner]?.implement_max_turns)options.max_turns=MEMBER_PROFILES[owner].implement_max_turns;
 const table=DIFFICULTY_EFFORT[owner];
 if(externalFirst(configuration)&&table?.[difficulty]&&configuration?.effort_source?.[owner]==='default')options.reasoning_effort=table[difficulty];
 return options;
}
// 상담·리뷰(읽기 전용) 실행의 옵션. consult_max_turns가 있으면 그 값이 리뷰 실행의 턴 상한이다.
// 리뷰어는 바뀐 파일을 모두 읽느라 구현보다 턴이 더 들 수 있다(KF3: stop_reason tool_use로 끝난 Sonnet·Haiku·Grok 리뷰).
// effort는 적응형 리뷰 계획이 정한 강도다. 브리지 검증도 같은 함수로 같은 값을 다시 만든다.
// 계획이 없는 리뷰(클래식 위임 리뷰)는 리뷰 자리 강도(Sol xhigh, Sonnet max, Grok xhigh)를 쓴다. 운영자가 직접 적은 강도는 그대로 둔다.
export function consultExecutorOptions(configuration,executor,{reasoning_effort,mode}={}) {
 const options={...(configuration?.executors?.[executor]??{})};
 if(options.consult_max_turns!==undefined)options.max_turns=options.consult_max_turns;
 if(reasoning_effort)options.reasoning_effort=reasoning_effort;
 else if(mode==='review'&&configuration?.effort_source?.[executor]==='default'&&MEMBER_PROFILES[executor]?.review_effort)options.reasoning_effort=MEMBER_PROFILES[executor].review_effort;
 return options;
}
// 설정에 policy가 없으면 adaptive 리뷰 전략일 때만 External-First다. 둘 다 없으면 이전 동작 그대로.
export const routingPolicy=c=>c?.routing?.policy??(c?.review?.strategy==='lead-gated-adaptive'?'external-first':'classic');
export const externalFirst=c=>routingPolicy(c)==='external-first';
// claude_reserve는 운영자가 true로 켰을 때만: 리드 계열의 일반 일꾼(Opus 리드면 Haiku)을 자동으로 고르지 않는다(명시 지정은 허용, 기록됨).
// 등급제에서 Haiku는 B급 일꾼이라 기본으로는 자동 후보다.
export const claudeReserve=c=>externalFirst(c)&&c?.routing?.claude_reserve===true;
// The same eligibility applies before routing, fallback and lease acquisition.
export function automaticImplementer(c,name) {
 if(!vendorAllowed(c,name))return false;
 if(!EXECUTORS.includes(name))return false;
 if(excludedMembers(c).includes(name))return false;
 if((externalFirst(c)||c?.review?.strategy==='lead-gated-adaptive')&&grantOnly(c).includes(name))return false;
 return !(claudeReserve(c)&&reservedMembers(c).includes(name));
}
// 바뀌면 리드가 직접 확인해야 하는 경로. 라운드의 변경 파일이 하나라도 맞으면 그 라운드는 중요 작업처럼 리뷰한다.
// 설정 review.risk_paths로 바꾸고, []이면 끈다.
export const RISK_PATHS=['**/auth/**','**/migrations/**','**/*.sql','**/security/**','.github/workflows/**'];
const validGlob=g=>typeof g==='string'&&g.length>0&&g.length<=200&&!g.startsWith('/')&&!g.includes('\\')&&!g.split('/').includes('..')&&!/^(?:\*\*\/)*\*{1,2}$/.test(g);

export const DEFAULT_CONFIG={lead:'opus',lead_model:'claude-opus-5-5',lead_takeover:true,
 external:{default:'auto',available:['terra','grok','sonnet','luna','haiku','antigravity']},
 // B급 agy는 Gemini 3.8 Flash high로 돈다(agy는 모델 ID의 접미사가 강도다).
 executors:{antigravity:{sandbox:true,model:'gemini-3.8-flash-high'}},
 routing:{rules:DEFAULT_RULES,learn:true,min_samples:3,demote_below:0.4,half_life_days:90,explore_every:10,newcomer_every:4},
 // 리뷰 주체. lead는 Opus가 직접, delegate는 다른 모델(기본 Codex 우선)이 읽기 전용으로 판정하고 그 판정을 적용한다.
 review:{by:'lead',reviewers:['sol','sonnet','grok'],auto_apply:true,risk_paths:RISK_PATHS}};

// 규칙은 선호 순서일 뿐이고 능력이 없는 일꾼은 router가 거른다. 사용자가 직접 쓴 규칙에 능력 없는 일꾼을 적으면 실수로 보고 거절한다
// (예: 이미지 작업에 Sonnet). 기본 규칙은 능력을 좁혀도 고칠 필요가 없도록 거르기만 한다.
const validRule=(r,c,strict)=>r&&Array.isArray(r.executors)&&r.executors.length&&r.executors.every(x=>EXECUTORS.includes(x))&&new Set(r.executors).size===r.executors.length
 &&(r.kind===undefined||TASK_KINDS.includes(r.kind))&&(r.kind===undefined||(strict?r.executors.every(x=>canDo(c,x,r.kind)):r.executors.some(x=>canDo(c,x,r.kind))))&&(r.difficulty===undefined||(Array.isArray(r.difficulty)&&r.difficulty.every(d=>DIFFICULTIES.includes(d))));
const validCaps=v=>v===undefined||(Array.isArray(v)&&v.every(x=>CAPABILITIES.includes(x))&&new Set(v).size===v.length);
const validModelMap=v=>v===undefined||(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length>0
 &&Object.entries(v).every(([d,m])=>DIFFICULTIES.includes(d)&&typeof m==='string'&&/^[\w.:/-]{1,80}$/.test(m)&&!modelEffort(m)));

export function config(root,{teamFile=teamFilePath()}={}) {
 const file=path.join(root,'hyperfusion.config.json');
 const v=fs.existsSync(file)?read(file):structuredClone(DEFAULT_CONFIG);
 // 팀 파일보다 앞서는 값은 저장소 설정 파일이 직접 적은 값뿐이다. 내장 기본값보다는 팀 파일이 앞선다.
 const own=fs.existsSync(file)?v:{};
 const explicit={reviewers:own.review?.reviewers!==undefined,
  models:new Set(Object.keys(own.executors??{}).filter(n=>own.executors[n]?.model!==undefined)),
  efforts:new Set(Object.keys(own.executors??{}).filter(n=>own.executors[n]?.reasoning_effort!==undefined))};
 if(v.allowed_vendors!==undefined)validateVendors(v.allowed_vendors);
 validCodingPolicy(v.coding_policy);
 // Validate operator policy even if no particular executor is selected yet.
 vendorAllowed(v,'sol');
 const userRules=v.routing?.rules!==undefined;
 // 리드는 호스트(또는 운영자 HF_LEAD_MODEL)가 정한다. 저장소 설정은 기본값인 Opus만 적을 수 있고, 적었다면 그 계열이 맞는지 init이 확인한다.
 if(v.lead!==undefined&&v.lead!=='opus')throw Error('Invalid HyperFusion configuration: the lead is chosen by the host or the operator (HF_LEAD_MODEL), not by hyperfusion.config.json');
 v.lead_model_source=fs.existsSync(file)&&v.lead_model!==undefined?'config':'default';
 v.lead??='opus';v.lead_model??='claude-opus-5-5';v.lead_takeover??=true;v.external??=structuredClone(DEFAULT_CONFIG.external);
 v.executors??={};v.executors.antigravity??=structuredClone(DEFAULT_CONFIG.executors.antigravity);
 v.review={...structuredClone(DEFAULT_CONFIG.review),...(v.review??{})};
 // 이 컴퓨터의 팀 파일(scripts/team-file.mjs). 쓸 일꾼과 리뷰어를 좁히고, 저장소 설정이 적지 않은 모델·강도를 채운다.
 const team=loadTeam(teamFile);
 v.team=team?applyTeam(v,team,{file:teamFile,explicit}):null;
 const teamEfforts=new Set((v.team?.filled??[]).filter(x=>x.endsWith('.reasoning_effort')).map(x=>x.split('.')[0]));
 // 운영자가 직접 적은 강도인지 기록한다. 파일에 같은 키가 있어도 컨트롤러가 다시 계산해 덮어쓴다.
 const effortSource={};
 for(const [k,e] of Object.entries(DEFAULT_EFFORT)){
  v.executors[k]??={};const o=v.executors[k],value=o.reasoning_effort;
  const pin=k==='antigravity'?modelEffort(o.model):null;
  if(pin&&value!==undefined&&value!==null&&value!==pin)throw Error(`EFFORT_CONFLICT: AGY model ${o.model} pins ${pin} but reasoning_effort is ${value}`);
  if(value===undefined){o.reasoning_effort=pin??e;effortSource[k]=pin?'model':'default';}
  else if(value===null){delete o.reasoning_effort;effortSource[k]='cli-default';}
  else effortSource[k]=teamEfforts.has(k)?'team':'config';
 }
 v.effort_source=effortSource;
 v.routing={...structuredClone(DEFAULT_CONFIG.routing),...(v.routing??{})};
 if(v.review.strategy==='lead-gated-adaptive'&&v.routing.policy==='classic')throw Error('Adaptive review requires external-first routing');
 if(v.routing.policy!==undefined&&!ROUTING_POLICIES.includes(v.routing.policy))throw Error('Invalid HyperFusion configuration: routing.policy must be classic or external-first');
 if(v.routing.claude_reserve!==undefined&&typeof v.routing.claude_reserve!=='boolean')throw Error('Invalid HyperFusion configuration: routing.claude_reserve must be boolean');
 // 사용자가 규칙을 쓰지 않았으면 External-First 배치표로 바꾼다. 사용자가 쓴 규칙의 Sonnet/Sol은 router가 거른다.
 if(!userRules&&externalFirst(v))v.routing.rules=structuredClone(EXTERNAL_FIRST_RULES);
 const ext=v.external;
 const ok=v.lead==='opus'&&typeof v.lead_model==='string'&&/^claude-(?:opus|fable)-[\w.-]{1,60}$/.test(v.lead_model)&&typeof v.lead_takeover==='boolean'&&ext&&Array.isArray(ext.available)&&ext.available.length&&ext.available.every(x=>EXECUTORS.includes(x))
  &&(ext.default==='auto'||ext.available.includes(ext.default))&&typeof (v.executors.antigravity.sandbox??true)==='boolean'
  &&Array.isArray(v.routing.rules)&&v.routing.rules.length&&v.routing.rules.every(r=>validRule(r,v,userRules))&&typeof v.routing.learn==='boolean'
  &&Object.entries(v.executors).every(([k,o])=>REVIEWERS.includes(k)&&o&&typeof o==='object'&&(o.timeout_ms===undefined||(Number.isSafeInteger(o.timeout_ms)&&o.timeout_ms>0))
   &&(o.model===undefined||(typeof o.model==='string'&&/^[\w.:/-]{1,80}$/.test(o.model)))&&(o.reasoning_effort===undefined||typeof o.reasoning_effort==='string')&&validCaps(o.caps)
   &&(k==='antigravity'?validModelMap(o.models_by_difficulty):o.models_by_difficulty===undefined)
   &&[o.max_turns,o.consult_max_turns].every(n=>n===undefined||(Number.isSafeInteger(n)&&n>0&&n<=1000))
   &&(o.max_turns_by_difficulty===undefined||(o.max_turns_by_difficulty&&typeof o.max_turns_by_difficulty==='object'&&!Array.isArray(o.max_turns_by_difficulty)&&Object.entries(o.max_turns_by_difficulty).every(([d,n])=>DIFFICULTIES.includes(d)&&Number.isSafeInteger(n)&&n>0&&n<=1000))))
  &&['lead','delegate'].includes(v.review.by)&&Array.isArray(v.review.reviewers)&&v.review.reviewers.length>0&&v.review.reviewers.every(x=>REVIEWERS.includes(x))&&new Set(v.review.reviewers).size===v.review.reviewers.length&&typeof v.review.auto_apply==='boolean'
  &&(v.review.strategy===undefined||v.review.strategy==='lead-gated-adaptive')
  &&Array.isArray(v.review.risk_paths)&&v.review.risk_paths.length<=50&&v.review.risk_paths.every(validGlob)
  &&Object.keys(v.review).every(k=>['by','reviewers','auto_apply','strategy','risk_paths'].includes(k))
  &&Number.isInteger(v.routing.min_samples)&&v.routing.min_samples>0&&typeof v.routing.demote_below==='number'&&v.routing.demote_below>=0&&v.routing.demote_below<=1
  &&Number.isFinite(v.routing.half_life_days)&&v.routing.half_life_days>0&&Number.isInteger(v.routing.explore_every)&&v.routing.explore_every>=0&&Number.isInteger(v.routing.newcomer_every)&&v.routing.newcomer_every>=0;
 if(!ok)throw Error('Invalid HyperFusion configuration');
 // 추론 강도는 일꾼 CLI가 받는 값만 허용한다. 틀린 값을 조용히 넘기면 CLI가 실패하거나 무시하므로 여기서 막는다.
 for(const [k,o] of Object.entries(v.executors)){
  if((o.max_turns!==undefined||o.max_turns_by_difficulty!==undefined||o.consult_max_turns!==undefined)&&!['grok','sonnet','haiku'].includes(k))throw Error('TURN_LIMIT_UNSUPPORTED: '+k+' does not expose --max-turns');
  const efforts=k==='antigravity'?supportedAgyEfforts(o.model):EFFORT_LEVELS[k]??[];
  if(o.reasoning_effort!==undefined&&!efforts.includes(o.reasoning_effort))throw Error(`EFFORT_UNSUPPORTED: ${k} reasoning_effort must be one of ${efforts.join(', ')||'(none)'}`);
  if(k==='antigravity'){
   // 운영자가 직접 적은 강도만 막는다. 기본 강도(DEFAULT_EFFORT)는 모델이 없으면 selectAgyModel이 빼고 CLI 기본값으로 돈다.
   if(['config','team'].includes(v.effort_source.antigravity)&&o.model==null&&o.models_by_difficulty===undefined)throw Error('EFFORT_NEEDS_MODEL: executors.antigravity.reasoning_effort has no effect without a model; agy reads effort from the model id. Set executors.antigravity.model (e.g. gemini-4-argon with reasoning_effort, or gemini-4-argon-high), or remove reasoning_effort');
   selectAgyModel(o);
   for(const model of Object.values(o.models_by_difficulty??{}))selectAgyModel({...o,model});
  }
 }
 v.limits=validateLimits(v.limits);
 // 저장소 안의 설정 파일은 일꾼이나 복제한 저장소가 쓴 것일 수 있다. 샌드박스 해제 같은 보안 완화는 설정 파일로 켤 수 없고,
 // 운영자가 환경변수로 직접 허용해야 한다.
 if(v.executors.antigravity.sandbox===false&&process.env.HF_ALLOW_UNSANDBOXED!=='1')throw Error('executors.antigravity.sandbox=false relaxes security and cannot be enabled from a repository config; the operator must set HF_ALLOW_UNSANDBOXED=1');
 // 기억 계층(AnchorMind)은 선택 사항이다. 켜려면 프로젝트별 workspace가 반드시 있어야 한다.
 if(v.memory!==undefined){
  if(!v.memory||typeof v.memory!=='object'||(v.memory.enabled!==undefined&&typeof v.memory.enabled!=='boolean')||(v.memory.recall_limit!==undefined&&!(Number.isInteger(v.memory.recall_limit)&&v.memory.recall_limit>0&&v.memory.recall_limit<=12)))throw Error('Invalid memory configuration');
  workspaceOf(v);
 }
 return v;
}

// 명시 지정만 처리한다. 'auto'는 router가 맡는다.
export function selectExecutor(c,requested) {
 const name=requested??c.external.default;
 if(name==='auto')return 'auto';
 if(name==='claude')throw Error('Opus is the lead, not a worker. Executor must be '+EXECUTORS.join(', ')+' or auto');
 if(name==='opus')throw Error('Executor must be an implementer; opus only reviews and advises under a Fable lead, and implements only when the lead reassigns a round to it');
 if(name==='sol')throw Error('Executor must be an implementer; sol only reviews and advises');
 if(!EXECUTORS.includes(name))throw Error('Executor must be '+EXECUTORS.join(', ')+' or auto');
 if(!c.external.available.includes(name))throw Error('Executor not enabled in configuration: '+name);
 assertVendor(c,name);
 return name;
}
