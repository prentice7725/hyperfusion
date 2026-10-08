import fs from 'node:fs';
import path from 'node:path';
import {read} from './artifact.mjs';
import {workspaceOf} from './memory-policy.mjs';

// 리드는 Claude Opus 5.5 하나로 고정. 일꾼은 Grok, Antigravity, Sonnet.
export const EXECUTORS=['grok','antigravity','sonnet'];
// 리뷰·상담만 하는 인력까지 포함한 명단. Codex는 쓰기 lease를 받지 않는다.
export const REVIEWERS=['codex',...EXECUTORS];
// 위임 리뷰는 라운드당 이 횟수까지(리뷰어가 실패하면 한 번 더). 상담 예산과 별도다.
export const REVIEW_RUNS_PER_ROUND=2;
export const CAP={grok:3,antigravity:3,sonnet:3,lead:1};
// 상담(advisor 1명, committee 2명) 위원 실행 총량. 구현 예산과 별도다.
export const CONSULT_CAP=4;
export const TASK_KINDS=['code','ui','image-asset','tests','refactor','docs'];
export const DIFFICULTIES=['low','medium','high'];

// 기본 배치표. 첫 번째로 맞는 규칙의 순서가 투입·교체 순서다.
// 실측이 아니라 출발점이다. 실적이 쌓이면 router가 성적 나쁜 일꾼을 뒤로 민다.
export const DEFAULT_RULES=[
 {kind:'image-asset',executors:['grok','antigravity'],why:'Grok Build는 CLI 안에서 이미지 생성을 지원한다고 알려져 있음(설치 버전에서 확인 필요)'},
 {kind:'code',difficulty:['medium','high'],executors:['sonnet','grok','antigravity'],why:'까다로운 구현은 Sonnet'},
 {kind:'code',difficulty:['low'],executors:['grok','antigravity','sonnet'],why:'쉬운 구현은 Grok부터'},
 {kind:'tests',executors:['sonnet','grok','antigravity'],why:'테스트 설계·디버깅은 Sonnet'},
 {kind:'refactor',executors:['sonnet','antigravity','grok'],why:'넓은 범위 리팩터는 Sonnet'},
 {kind:'ui',executors:['antigravity','sonnet','grok'],why:'프론트엔드·UI는 Antigravity부터'},
 {kind:'docs',executors:['antigravity','grok','sonnet'],why:'문서는 가벼운 일꾼부터'},
 {executors:['sonnet','grok','antigravity'],why:'분류 없는 작업의 기본 순서'}
];
export const DEFAULT_CONFIG={lead:'opus',lead_model:'claude-opus-5-5',lead_takeover:true,
 external:{default:'auto',available:['grok','antigravity','sonnet']},
 executors:{antigravity:{sandbox:true}},
 routing:{rules:DEFAULT_RULES,learn:true,min_samples:3,demote_below:0.4},
 // 리뷰 주체. lead는 Opus가 직접, delegate는 다른 모델(기본 Codex 우선)이 읽기 전용으로 판정하고 그 판정을 적용한다.
 review:{by:'lead',reviewers:['codex','sonnet','antigravity','grok'],auto_apply:true}};

const validRule=r=>r&&Array.isArray(r.executors)&&r.executors.length&&r.executors.every(x=>EXECUTORS.includes(x))&&new Set(r.executors).size===r.executors.length
 &&(r.kind===undefined||TASK_KINDS.includes(r.kind))&&(r.difficulty===undefined||(Array.isArray(r.difficulty)&&r.difficulty.every(d=>DIFFICULTIES.includes(d))));

export function config(root) {
 const file=path.join(root,'hyperfusion.config.json');
 const v=fs.existsSync(file)?read(file):structuredClone(DEFAULT_CONFIG);
 if(['sol','astra'].includes(v.lead))throw Error('Invalid HyperFusion configuration: Codex lead config belongs to the main branch; this branch is Opus-led');
 v.lead??='opus';v.lead_model??='claude-opus-5-5';v.lead_takeover??=true;v.external??=structuredClone(DEFAULT_CONFIG.external);
 v.executors??={};v.executors.antigravity??={sandbox:true};
 v.routing={...structuredClone(DEFAULT_CONFIG.routing),...(v.routing??{})};
 v.review={...structuredClone(DEFAULT_CONFIG.review),...(v.review??{})};
 const ext=v.external;
 const ok=v.lead==='opus'&&v.lead_model==='claude-opus-5-5'&&typeof v.lead_takeover==='boolean'&&ext&&Array.isArray(ext.available)&&ext.available.length&&ext.available.every(x=>EXECUTORS.includes(x))
  &&(ext.default==='auto'||ext.available.includes(ext.default))&&typeof (v.executors.antigravity.sandbox??true)==='boolean'
  &&Array.isArray(v.routing.rules)&&v.routing.rules.length&&v.routing.rules.every(validRule)&&typeof v.routing.learn==='boolean'
  &&Object.entries(v.executors).every(([k,o])=>REVIEWERS.includes(k)&&o&&typeof o==='object'&&(o.timeout_ms===undefined||(Number.isSafeInteger(o.timeout_ms)&&o.timeout_ms>0))
   &&(o.model===undefined||(typeof o.model==='string'&&/^[\w.:/-]{1,80}$/.test(o.model)))&&(o.reasoning_effort===undefined||['minimal','low','medium','high','xhigh'].includes(o.reasoning_effort)))
  &&['lead','delegate'].includes(v.review.by)&&Array.isArray(v.review.reviewers)&&v.review.reviewers.length>0&&v.review.reviewers.every(x=>REVIEWERS.includes(x))&&new Set(v.review.reviewers).size===v.review.reviewers.length&&typeof v.review.auto_apply==='boolean'
  &&Number.isInteger(v.routing.min_samples)&&v.routing.min_samples>0&&typeof v.routing.demote_below==='number'&&v.routing.demote_below>=0&&v.routing.demote_below<=1;
 if(!ok)throw Error('Invalid HyperFusion configuration');
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
 if(['claude','opus','luna'].includes(name))throw Error('Opus is the lead, not a worker. Executor must be grok, antigravity, sonnet or auto');
 if(!EXECUTORS.includes(name))throw Error('Executor must be grok, antigravity, sonnet or auto');
 if(!c.external.available.includes(name))throw Error('Executor not enabled in configuration: '+name);
 return name;
}
