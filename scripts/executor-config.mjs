import fs from 'node:fs';
import path from 'node:path';
import {read} from './artifact.mjs';

// 리드는 Claude Opus 5.5 하나로 고정. 일꾼은 Grok, Antigravity, Sonnet.
export const EXECUTORS=['grok','antigravity','sonnet'];
export const CAP={grok:3,antigravity:3,sonnet:3,lead:1};
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
 routing:{rules:DEFAULT_RULES,learn:true,min_samples:3,demote_below:0.4}};

const validRule=r=>r&&Array.isArray(r.executors)&&r.executors.length&&r.executors.every(x=>EXECUTORS.includes(x))&&new Set(r.executors).size===r.executors.length
 &&(r.kind===undefined||TASK_KINDS.includes(r.kind))&&(r.difficulty===undefined||(Array.isArray(r.difficulty)&&r.difficulty.every(d=>DIFFICULTIES.includes(d))));

export function config(root) {
 const file=path.join(root,'hyperfusion.config.json');
 const v=fs.existsSync(file)?read(file):structuredClone(DEFAULT_CONFIG);
 if(['sol','astra'].includes(v.lead))throw Error('Invalid HyperFusion configuration: Codex lead config belongs to the main branch; this branch is Opus-led');
 v.lead??='opus';v.lead_model??='claude-opus-5-5';v.lead_takeover??=true;v.external??=structuredClone(DEFAULT_CONFIG.external);
 v.executors??={};v.executors.antigravity??={sandbox:true};
 v.routing={...structuredClone(DEFAULT_CONFIG.routing),...(v.routing??{})};
 const ext=v.external;
 const ok=v.lead==='opus'&&v.lead_model==='claude-opus-5-5'&&typeof v.lead_takeover==='boolean'&&ext&&Array.isArray(ext.available)&&ext.available.length&&ext.available.every(x=>EXECUTORS.includes(x))
  &&(ext.default==='auto'||ext.available.includes(ext.default))&&typeof (v.executors.antigravity.sandbox??true)==='boolean'
  &&Array.isArray(v.routing.rules)&&v.routing.rules.length&&v.routing.rules.every(validRule)&&typeof v.routing.learn==='boolean'
  &&Object.entries(v.executors).every(([k,o])=>EXECUTORS.includes(k)&&o&&typeof o==='object'&&(o.timeout_ms===undefined||(Number.isSafeInteger(o.timeout_ms)&&o.timeout_ms>0)))
  &&Number.isInteger(v.routing.min_samples)&&v.routing.min_samples>0&&typeof v.routing.demote_below==='number'&&v.routing.demote_below>=0&&v.routing.demote_below<=1;
 if(!ok)throw Error('Invalid HyperFusion configuration');
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
