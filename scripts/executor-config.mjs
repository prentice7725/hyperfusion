import fs from 'node:fs';
import path from 'node:path';
import {read} from './artifact.mjs';
import {workspaceOf} from './memory-policy.mjs';
import {validateLimits} from './budgets.mjs';

// 리드는 Claude Opus 5.5 하나로 고정. 구현 일꾼은 Grok, Antigravity, Sonnet·Haiku(Claude Code), Luna(Codex).
export const EXECUTORS=['grok','antigravity','sonnet','haiku','luna'];
// 리뷰·상담만 하는 인력까지 포함한 명단. Sol(Codex)은 쓰기 lease를 받지 않는다.
export const REVIEWERS=['sol',...EXECUTORS];
// 위임 리뷰는 라운드당 이 횟수까지(리뷰어가 실패하면 한 번 더). 상담 예산과 별도다.
export const REVIEW_RUNS_PER_ROUND=2;
export const CAP={grok:3,antigravity:3,sonnet:3,haiku:3,luna:3,lead:1};
// 상담(advisor 1명, committee 2명) 위원 실행 총량. 구현 예산과 별도다.
export const CONSULT_CAP=4;
export const TASK_KINDS=['code','ui','image-asset','tests','refactor','docs'];
export const DIFFICULTIES=['low','medium','high'];
// 능력(caps): 배치는 이름이 아니라 능력으로 후보를 거른다. 작업 종류마다 필요한 능력이 하나 있다.
// 기본값은 여기, 바꾸거나 새 모델의 능력을 적을 때는 설정의 executors.<이름>.caps로 덮어쓴다.
export const CAPABILITIES=['code','tests','refactor','ui','docs','image-gen'];
export const KIND_NEEDS={code:'code',tests:'tests',refactor:'refactor',ui:'ui',docs:'docs','image-asset':'image-gen'};
const GENERAL=['code','tests','refactor','ui','docs'];
// Antigravity CLI와 Claude Code에는 이미지 생성 기능이 없다.
export const DEFAULT_CAPS={grok:[...GENERAL,'image-gen'],antigravity:GENERAL,sonnet:GENERAL,haiku:GENERAL,luna:[...GENERAL,'image-gen']};
export const capsOf=(c,e)=>c?.executors?.[e]?.caps??DEFAULT_CAPS[e]??[];
// 작업 종류가 없으면(분류 안 된 작업) 능력으로 거르지 않는다.
export const canDo=(c,e,kind)=>!kind||capsOf(c,e).includes(KIND_NEEDS[kind]);
// 기본 능력 기준 이미지 생성 일꾼(설정이 없을 때의 참고용).
export const IMAGE_EXECUTORS=EXECUTORS.filter(e=>DEFAULT_CAPS[e].includes('image-gen'));

// 기본 배치표: 능력으로 거른 후보의 처음 순서(선호)다. 규칙에 없는 일꾼도 능력이 있으면 뒤에 붙는다.
// 실측이 아니라 출발점이다. 실적이 쌓이면 router가 성적 나쁜 일꾼을 뒤로 밀고, 새 일꾼은 가끔 먼저 시켜 본다.
export const DEFAULT_RULES=[
 {kind:'image-asset',executors:['grok','luna'],why:'이미지 생성 능력(image-gen)이 있는 일꾼'},
 {kind:'code',difficulty:['medium','high'],executors:['sonnet','grok','antigravity'],why:'까다로운 구현은 Sonnet'},
 {kind:'code',difficulty:['low'],executors:['grok','haiku','antigravity','sonnet'],why:'쉬운 구현은 빠른 일꾼부터'},
 {kind:'tests',executors:['sonnet','grok','antigravity'],why:'테스트 설계·디버깅은 Sonnet'},
 {kind:'refactor',executors:['sonnet','antigravity','grok'],why:'넓은 범위 리팩터는 Sonnet'},
 {kind:'ui',executors:['antigravity','sonnet','grok'],why:'프론트엔드·UI는 Antigravity부터'},
 {kind:'docs',executors:['antigravity','haiku','grok','sonnet'],why:'문서는 가벼운 일꾼부터'},
 {executors:['sonnet','grok','antigravity'],why:'분류 없는 작업의 기본 순서'}
];
export const DEFAULT_CONFIG={lead:'opus',lead_model:'claude-opus-5-5',lead_takeover:true,
 external:{default:'auto',available:['grok','antigravity','sonnet','haiku','luna']},
 executors:{antigravity:{sandbox:true}},
 routing:{rules:DEFAULT_RULES,learn:true,min_samples:3,demote_below:0.4,half_life_days:90,explore_every:10,newcomer_every:4},
 // 리뷰 주체. lead는 Opus가 직접, delegate는 다른 모델(기본 Codex 우선)이 읽기 전용으로 판정하고 그 판정을 적용한다.
 review:{by:'lead',reviewers:['sol','sonnet','antigravity','grok','luna','haiku'],auto_apply:true}};

// 규칙은 선호 순서일 뿐이고 능력이 없는 일꾼은 router가 거른다. 사용자가 직접 쓴 규칙에 능력 없는 일꾼을 적으면 실수로 보고 거절한다
// (예: 이미지 작업에 Sonnet). 기본 규칙은 능력을 좁혀도 고칠 필요가 없도록 거르기만 한다.
const validRule=(r,c,strict)=>r&&Array.isArray(r.executors)&&r.executors.length&&r.executors.every(x=>EXECUTORS.includes(x))&&new Set(r.executors).size===r.executors.length
 &&(r.kind===undefined||TASK_KINDS.includes(r.kind))&&(r.kind===undefined||(strict?r.executors.every(x=>canDo(c,x,r.kind)):r.executors.some(x=>canDo(c,x,r.kind))))&&(r.difficulty===undefined||(Array.isArray(r.difficulty)&&r.difficulty.every(d=>DIFFICULTIES.includes(d))));
const validCaps=v=>v===undefined||(Array.isArray(v)&&v.every(x=>CAPABILITIES.includes(x))&&new Set(v).size===v.length);

export function config(root) {
 const file=path.join(root,'hyperfusion.config.json');
 const v=fs.existsSync(file)?read(file):structuredClone(DEFAULT_CONFIG);
 const userRules=v.routing?.rules!==undefined;
 if(['sol','astra'].includes(v.lead))throw Error('Invalid HyperFusion configuration: Codex lead config belongs to the main branch; this branch is Opus-led');
 v.lead??='opus';v.lead_model??='claude-opus-5-5';v.lead_takeover??=true;v.external??=structuredClone(DEFAULT_CONFIG.external);
 v.executors??={};v.executors.antigravity??={sandbox:true};
 v.routing={...structuredClone(DEFAULT_CONFIG.routing),...(v.routing??{})};
 v.review={...structuredClone(DEFAULT_CONFIG.review),...(v.review??{})};
 const ext=v.external;
 const ok=v.lead==='opus'&&typeof v.lead_model==='string'&&/^claude-opus-[\w.-]{1,60}$/.test(v.lead_model)&&typeof v.lead_takeover==='boolean'&&ext&&Array.isArray(ext.available)&&ext.available.length&&ext.available.every(x=>EXECUTORS.includes(x))
  &&(ext.default==='auto'||ext.available.includes(ext.default))&&typeof (v.executors.antigravity.sandbox??true)==='boolean'
  &&Array.isArray(v.routing.rules)&&v.routing.rules.length&&v.routing.rules.every(r=>validRule(r,v,userRules))&&typeof v.routing.learn==='boolean'
  &&Object.entries(v.executors).every(([k,o])=>REVIEWERS.includes(k)&&o&&typeof o==='object'&&(o.timeout_ms===undefined||(Number.isSafeInteger(o.timeout_ms)&&o.timeout_ms>0))
   &&(o.model===undefined||(typeof o.model==='string'&&/^[\w.:/-]{1,80}$/.test(o.model)))&&(o.reasoning_effort===undefined||['minimal','low','medium','high','xhigh'].includes(o.reasoning_effort))&&validCaps(o.caps))
  &&['lead','delegate'].includes(v.review.by)&&Array.isArray(v.review.reviewers)&&v.review.reviewers.length>0&&v.review.reviewers.every(x=>REVIEWERS.includes(x))&&new Set(v.review.reviewers).size===v.review.reviewers.length&&typeof v.review.auto_apply==='boolean'
  &&Number.isInteger(v.routing.min_samples)&&v.routing.min_samples>0&&typeof v.routing.demote_below==='number'&&v.routing.demote_below>=0&&v.routing.demote_below<=1
  &&Number.isFinite(v.routing.half_life_days)&&v.routing.half_life_days>0&&Number.isInteger(v.routing.explore_every)&&v.routing.explore_every>=0&&Number.isInteger(v.routing.newcomer_every)&&v.routing.newcomer_every>=0;
 if(!ok)throw Error('Invalid HyperFusion configuration');
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
 if(['claude','opus'].includes(name))throw Error('Opus is the lead, not a worker. Executor must be grok, antigravity, sonnet, haiku, luna or auto');
 if(name==='sol')throw Error('Executor must be an implementer; sol only reviews and advises');
 if(!EXECUTORS.includes(name))throw Error('Executor must be grok, antigravity, sonnet, haiku, luna or auto');
 if(!c.external.available.includes(name))throw Error('Executor not enabled in configuration: '+name);
 return name;
}
