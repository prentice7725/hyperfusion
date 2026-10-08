import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {read,atomic} from './artifact.mjs';
import {controlPath} from './control-dir.mjs';

// 기억 계층(AnchorMind 설계를 들여온 것)은 정본(SOT)이 아니라 에이전트들의 장기 작업기억이다.
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
 // 알려진 서비스의 토큰 모양
 /\bsk-[A-Za-z0-9_-]{16,}/,/\bsk-ant-[A-Za-z0-9_-]{8,}/,/\b[sr]k_(?:live|test)_[A-Za-z0-9]{12,}/,/\bxai-[A-Za-z0-9]{16,}/,/\bgh[pousr]_[A-Za-z0-9]{20,}/,/\bgithub_pat_[A-Za-z0-9_]{20,}/,
 /\bglpat-[A-Za-z0-9_-]{16,}/,/\bnpm_[A-Za-z0-9]{30,}/,/\bhf_[A-Za-z0-9]{30,}/,/\bya29\.[A-Za-z0-9_-]{16,}/,
 /\bAKIA[0-9A-Z]{16}\b/,/\bASIA[0-9A-Z]{16}\b/,/\bAIza[0-9A-Za-z_-]{30,}/,/\bxox[abpr]-[A-Za-z0-9-]{10,}/,/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
 // 개인 키, 헤더, 접속 문자열
 /-----BEGIN [A-Z ]*PRIVATE KEY-----/,/-----BEGIN (?:PGP|OPENSSH|RSA|EC|DSA)/,/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,/\bBasic\s+[A-Za-z0-9+/=]{16,}/,
 /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]{3,}@/i,
 // "이름 = 값", "이름은 값" 형태
 /\b\w*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)\w*\b["']?\s*[:=]\s*\S{4,}/i,
 /\b(?:password|passwd|passphrase|secret|token|api key|credential)s?\s+(?:is|was|are|=|:)\s*\S{4,}/i,
 /(?:비밀번호|암호|패스워드|토큰|시크릿)\s*(?:은|는|이|가|:|=)?\s*[A-Za-z0-9!@#$%^&*._-]{6,}/,
 // 길고 무작위로 보이는 문자열: 16진 40자 이상
 /\b[A-Fa-f0-9]{40,}\b/
];
// 공백이나 보이지 않는 글자를 끼워 넣어 필터를 피하는 경우를 막으려고 정규화한 문장도 함께 본다.
const squeeze=text=>String(text).normalize('NFKC').replace(/[\u200b-\u200f\u2060\ufeff\u00ad]/g,'');
// 영문 대소문자와 숫자가 섞인 32자 이상 토큰(base64 비밀값 등). 경로나 일반 단어는 걸리지 않게 슬래시가 많은 토큰은 제외한다.
const randomLooking=token=>token.length>=32&&/[A-Z]/.test(token)&&/[a-z]/.test(token)&&/\d/.test(token)&&(token.match(/\//g)??[]).length<3;
export function looksSecret(text) {
 const t=squeeze(text);
 if(SECRET.some(r=>r.test(t)||r.test(String(text))))return true;
 return t.split(/\s+/).some(w=>/^[A-Za-z0-9+/_=-]+$/.test(w)&&randomLooking(w))||t.split(/[\s:=,]+/).some(w=>/^[A-Za-z0-9+/_=-]+$/.test(w)&&randomLooking(w)&&!w.includes('/'));
}

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
 if(c.ttl_days!==undefined&&!(Number.isInteger(c.ttl_days)&&c.ttl_days>0&&c.ttl_days<=3650))problems.push('ttl_days must be 1..3650');
 if(c.ttl_days!==undefined&&c.anchor_key)problems.push('anchors do not expire');
 if(role==='lead'&&RESTRICTED_TYPES.includes(c.type)&&!str(c.reason))problems.push(`${c.type} is restricted; give a reason`);
 if(c.reason!==undefined&&(typeof c.reason!=='string'||looksSecret(c.reason)))problems.push('reason must be plain text and must not contain a credential');
 return problems;
}

// 리드가 고른 과거 기억. 일꾼 brief에 들어가며, brief·저장소·lead_feedback보다 우선순위가 낮다.
export function checkPrior(v) {
 if(v===undefined)return;
 if(!Array.isArray(v)||v.length>MAX_PRIOR||!v.every(x=>x&&TYPES.includes(x.type)&&str(x.content)&&x.content.length<=MAX_CONTENT&&!looksSecret(x.content)&&(x.id===undefined||typeof x.id==='string'||typeof x.id==='number')&&(x.assertion===undefined||['verified','inferred'].includes(x.assertion))))
  throw Error(`Invalid prior_experience (up to ${MAX_PRIOR} recalled fragments {type, content, id?, assertion?}; rejected memories never go to workers)`);
}

const ledgerFile=(root,task)=>controlPath(root,'tasks',task,'memory-candidates.json');
export const readLedger=(root,task)=>{const f=ledgerFile(root,task);return fs.existsSync(f)?read(f):{task_id:task,candidates:[]};};
export const writeLedger=(root,task,v)=>atomic(ledgerFile(root,task),v);

// 후보를 장부에 쌓는다. 검사에 걸린 후보도 사유와 함께 남겨 리드가 볼 수 있게 한다.
export function propose(root,task,items,source) {
 const ledger=readLedger(root,task);
 for(const c of items){
  if(!c||typeof c!=='object')continue;
  const problems=checkCandidate(c,source.role);
  const key=crypto.createHash('sha256').update(String(c.type)+'\0'+String(c.content)).digest('hex').slice(0,12);
  if(ledger.candidates.some(x=>x.key===key))continue;
  // 비밀값으로 보이는 후보는 사유만 남기고 내용과 키워드는 장부에 쓰지 않는다. 거절한 내용을 디스크에 남기면 거절의 의미가 없다.
  const withheld=problems.some(p=>/credential/.test(p));
  const text=typeof c.content==='string'?c.content:'';
  ledger.candidates.push({id:'m'+(ledger.candidates.length+1),key,type:c.type,content:withheld?'[withheld: looked like a credential]':text.slice(0,MAX_CONTENT*2),keywords:withheld?[]:(Array.isArray(c.keywords)?c.keywords.filter(k=>typeof k==='string'&&!looksSecret(k)).slice(0,10):[]),importance:c.importance??'medium',
   anchor_key:c.anchor_key,reason:c.reason,ttl_days:c.ttl_days,source,status:problems.length?'invalid':'pending',problems,proposed_at:new Date().toISOString()});
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

