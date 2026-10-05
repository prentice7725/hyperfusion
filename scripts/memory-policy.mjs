import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {read,atomic} from './artifact.mjs';

// AnchorMind는 정본(SOT)이 아니라 에이전트들의 장기 작업기억이다.
// 이 모듈은 무엇을 기억시켜도 되는지 정하는 규칙과, 작업마다 쌓이는 후보 장부를 다룬다.

export const TYPES=['fact','decision','error','preference','procedure','relation','episode'];
// 일꾼이 제안할 수 있는 종류. 결정·선호·관계는 리드만 기록한다.
export const WORKER_TYPES=['error','procedure','episode','fact'];
// 제한적으로만 쓰는 종류. 리드가 넣을 때도 사유가 있어야 한다.
export const RESTRICTED_TYPES=['fact','relation'];
// 감쇠하지 않는 anchor는 이 키에만 허용한다. 내용은 규칙 자체가 아니라 규칙이 있는 곳을 가리킨다.
export const ANCHOR_KEYS=['PROJECT_NAME','SOT_LOCATION','GIT_REPO','NON_NEGOTIABLE_RULE','CURRENT_ENGINE'];
export const MAX_CONTENT=400;
export const MAX_PRIOR=12;

// 비밀값으로 보이면 내용과 상관없이 거절한다. 오탐은 허용, 미탐은 허용하지 않는 쪽으로 넓게 잡는다.
const SECRET=[
 /\bsk-[A-Za-z0-9_-]{16,}/,/\bsk-ant-[A-Za-z0-9_-]{8,}/,/\bxai-[A-Za-z0-9]{16,}/,/\bgh[pousr]_[A-Za-z0-9]{20,}/,/\bgithub_pat_[A-Za-z0-9_]{20,}/,
 /\bAKIA[0-9A-Z]{16}\b/,/\bAIza[0-9A-Za-z_-]{30,}/,/\bxox[abpr]-[A-Za-z0-9-]{10,}/,/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
 /\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|bearer)\b\s*[:=]\s*\S{4,}/i,/\bBearer\s+[A-Za-z0-9._-]{16,}/,
 /\b[A-Fa-f0-9]{40,}\b/,/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./
];
export const looksSecret=text=>SECRET.some(r=>r.test(text));

const str=v=>typeof v==='string'&&v.trim().length>0;

export function workspaceOf(configuration) {
 const w=configuration?.memory?.workspace;
 if(configuration?.memory?.enabled===false||w===undefined)return null;
 if(typeof w!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(w))throw Error('Invalid memory.workspace (letters, digits, . _ -; one workspace per project)');
 return w;
}

// 후보 한 건을 검사한다. role은 'worker' | 'lead' | 'protocol'.
export function checkCandidate(c,role) {
 const problems=[];
 if(!c||typeof c!=='object')return ['not an object'];
 if(!TYPES.includes(c.type))problems.push('unknown type '+c.type);
 else if(role==='worker'&&!WORKER_TYPES.includes(c.type))problems.push(`workers cannot record ${c.type}; the lead owns decisions, preferences and relations`);
 if(!str(c.content))problems.push('empty content');
 else {
  if(c.content.length>MAX_CONTENT)problems.push(`content over ${MAX_CONTENT} chars; memory holds one or two sentences, not documents`);
  if(looksSecret(c.content))problems.push('content looks like a credential; never store secrets');
 }
 if(c.keywords!==undefined&&!(Array.isArray(c.keywords)&&c.keywords.every(k=>str(k)&&k.length<=60&&!looksSecret(k))))problems.push('invalid keywords');
 if(c.anchor_key!==undefined){
  if(role!=='lead')problems.push('only the lead may set an anchor');
  else if(!ANCHOR_KEYS.includes(c.anchor_key))problems.push('anchor_key must be one of '+ANCHOR_KEYS.join(', '));
 }
 if(c.importance!==undefined&&!['low','medium','high'].includes(c.importance))problems.push('importance must be low, medium or high');
 if(role==='lead'&&RESTRICTED_TYPES.includes(c.type)&&!str(c.reason))problems.push(`${c.type} is restricted; give a reason`);
 return problems;
}

// 리드가 고른 과거 기억. 일꾼 brief에 들어가며, brief·저장소·lead_feedback보다 우선순위가 낮다.
export function checkPrior(v) {
 if(v===undefined)return;
 if(!Array.isArray(v)||v.length>MAX_PRIOR||!v.every(x=>x&&TYPES.includes(x.type)&&str(x.content)&&x.content.length<=MAX_CONTENT&&!looksSecret(x.content)&&(x.id===undefined||typeof x.id==='string'||typeof x.id==='number')&&(x.assertion===undefined||['verified','inferred'].includes(x.assertion))))
  throw Error(`Invalid prior_experience (up to ${MAX_PRIOR} recalled fragments {type, content, id?, assertion?}; rejected memories never go to workers)`);
}

const ledgerFile=(root,task)=>path.join(root,'.fusion/tasks',task,'memory-candidates.json');
export const readLedger=(root,task)=>{const f=ledgerFile(root,task);return fs.existsSync(f)?read(f):{task_id:task,candidates:[]};};
export const writeLedger=(root,task,v)=>atomic(ledgerFile(root,task),v);

// 후보를 장부에 쌓는다. 검사에 걸린 후보도 사유와 함께 남겨 리드가 볼 수 있게 한다.
export function propose(root,task,items,source) {
 const ledger=readLedger(root,task);
 for(const c of items){
  const problems=checkCandidate(c,source.role);
  const key=crypto.createHash('sha256').update(c.type+'\0'+c.content).digest('hex').slice(0,12);
  if(ledger.candidates.some(x=>x.key===key))continue;
  ledger.candidates.push({id:'m'+(ledger.candidates.length+1),key,type:c.type,content:c.content,keywords:c.keywords??[],importance:c.importance??'medium',
   anchor_key:c.anchor_key,reason:c.reason,source,status:problems.length?'invalid':'pending',problems,proposed_at:new Date().toISOString()});
 }
 writeLedger(root,task,ledger);
 return ledger;
}

const clip=(t,n)=>t.length>n?t.slice(0,n-1)+'…':t;

// 프로토콜 기록에서 실패→원인→수정→검증 흐름을 후보로 뽑는다. 리드 승인 전에는 아무것도 저장되지 않는다.
export function deriveFromState(s,dir) {
 const opt=name=>{const f=path.join(dir,name);return fs.existsSync(f)?read(f):null;};
 const brief=opt('initial-brief.json'),kind=`${s.routing?.task_kind??'task'}${s.routing?.difficulty?'/'+s.routing.difficulty:''}`;
 const tag=['hf:'+s.task_id,...(s.routing?.task_kind?['kind:'+s.routing.task_kind]:[])];
 const out=[];
 const path_=s.reviews.map(r=>`${r.owner} r${r.round} ${r.verdict}${r.blocking_criteria.length?' ['+r.blocking_criteria.join(',')+']':''}`).join(' → ');
 const verification=opt('verification.json');
 if(s.phase==='CLOSE'){
  const pass=s.reviews.findLast(r=>r.verdict==='pass');
  const fixed=pass?opt(`raw-result-${pass.round}.json`):null;
  for(const r of s.reviews.filter(r=>r.verdict!=='pass')){
   const why=clip(r.rationale,140);
   out.push({type:'error',content:clip(`${kind}: ${r.owner} round ${r.round} failed ${r.blocking_criteria.join(', ')} — ${why}. Resolved by ${pass?.owner??'?'} round ${pass?.round??'?'}: ${clip(fixed?.summary??'see task record',140)}`,MAX_CONTENT),keywords:[...tag,'by:'+r.owner],importance:'high',verified:true});
  }
  if(verification)out.push({type:'procedure',content:clip(`Verified ${kind} work in this repo with: ${verification.tests.map(t=>t.command).join('; ')}`,MAX_CONTENT),keywords:[...tag,'verification'],importance:'medium',verified:true});
  out.push({type:'episode',content:clip(`${s.task_id} (${kind}) closed: ${clip(brief?.objective??'',120)}. Path: ${path_||'first round passed'}.`,MAX_CONTENT),keywords:tag,importance:'medium',verified:true});
 } else if(s.phase==='BLOCKED'){
  const last=s.reviews.at(-1);
  out.push({type:'episode',content:clip(`${s.task_id} (${kind}) BLOCKED after ${s.iteration} rounds: ${clip(brief?.objective??'',100)}. Path: ${path_}. Last blocker: ${last?clip(last.rationale,120):'n/a'}.`,MAX_CONTENT),keywords:[...tag,'blocked'],importance:'high',verified:false});
 }
 return out;
}

