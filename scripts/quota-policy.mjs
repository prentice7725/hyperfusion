// 사용량(quota) 관측 기록. 모델을 호출하지 않고, 잔량을 추정하지 않는다.
// 출처·수집 시각·TTL·리셋 시각이 없거나 지난 값은 '모름'이다. 0이나 100으로 바꾸지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import {read,atomic} from './artifact.mjs';
import {readInput,printError} from './cli.mjs';
import {isMain} from './platform.mjs';
import {controlPath,ensureControl,assertPlainDir} from './control-dir.mjs';
import {redactText} from './redaction.mjs';

export const PROVIDERS=['anthropic','openai','xai','google'];
export const QUOTA_SOURCES=['user_manual','supported_tool','unknown'];
// 일꾼 → 공급자. Opus 리드도 anthropic이다. 잔량은 공급자 단위로만 본다.
export const PROVIDER_OF={opus:'anthropic',lead:'anthropic',sonnet:'anthropic',haiku:'anthropic',sol:'openai',luna:'openai',grok:'xai',antigravity:'google'};
// Grok은 공식 잔량 조회 근거가 없으므로 자동(supported_tool) 기록을 받지 않는다.
const MANUAL_ONLY=new Set(['xai']);
const MAX_TTL_MS=7*86400000;

const iso=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const num=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;

// 기록 하나를 검증한다. 모르는 값은 null로 남기고, 지어내지 않는다.
export function validateQuota(input) {
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('QUOTA_INVALID: record must be an object');
 const {provider,source,collected_at,ttl_ms,reset_at=null,window=null,unit=null,remaining=null,limit=null,note=null}=input;
 if(!PROVIDERS.includes(provider))throw Error('QUOTA_INVALID: provider must be one of '+PROVIDERS.join(', '));
 if(!QUOTA_SOURCES.includes(source))throw Error('QUOTA_INVALID: source must be user_manual, supported_tool, or unknown');
 if(MANUAL_ONLY.has(provider)&&source==='supported_tool')throw Error('QUOTA_INVALID: '+provider+' has no verified quota tool; record it as user_manual');
 if(!iso(collected_at))throw Error('QUOTA_INVALID: collected_at must be an ISO time');
 if(!(Number.isSafeInteger(ttl_ms)&&ttl_ms>0&&ttl_ms<=MAX_TTL_MS))throw Error('QUOTA_INVALID: ttl_ms must be a positive integer up to 7 days');
 if(reset_at!==null&&!iso(reset_at))throw Error('QUOTA_INVALID: reset_at must be an ISO time or null');
 if(window!==null&&!(typeof window==='string'&&/^[\w .:/-]{1,40}$/.test(window)))throw Error('QUOTA_INVALID: window must be short text or null');
 if(unit!==null&&!(typeof unit==='string'&&/^[\w .:/-]{1,40}$/.test(unit)))throw Error('QUOTA_INVALID: unit must be short text or null');
 if(remaining!==null&&!num(remaining))throw Error('QUOTA_INVALID: remaining must be a nonnegative number or null');
 if(limit!==null&&!num(limit))throw Error('QUOTA_INVALID: limit must be a nonnegative number or null');
 if(remaining!==null&&limit!==null&&remaining>limit)throw Error('QUOTA_INVALID: remaining exceeds limit');
 if(note!==null&&!(typeof note==='string'&&note.length<=200))throw Error('QUOTA_INVALID: note must be up to 200 characters');
 if(remaining!==null&&unit===null)throw Error('QUOTA_INVALID: a remaining value needs its unit');
 return {version:1,provider,source,collected_at,ttl_ms,reset_at,window,unit,remaining,limit,note:note===null?null:redactText(note,{})};
}

// 신선도: fresh(TTL 안, 리셋 전), stale(TTL 지남 또는 리셋 지남), unknown(기록 없음·출처 unknown).
export function quotaStatus(record,now=Date.now()) {
 if(!record)return {state:'unknown',remaining:null,reason:'no record'};
 if(record.source==='unknown')return {state:'unknown',remaining:null,reason:'source unknown',provider:record.provider};
 const t=typeof now==='number'?now:Date.parse(now);
 const collected=Date.parse(record.collected_at);
 if(collected>t+60000)return {state:'unknown',remaining:null,reason:'collected_at is in the future',provider:record.provider};
 if(t-collected>=record.ttl_ms)return {state:'stale',remaining:null,reason:'ttl expired',provider:record.provider,collected_at:record.collected_at};
 if(record.reset_at&&Date.parse(record.reset_at)<=t)return {state:'stale',remaining:null,reason:'reset window passed',provider:record.provider,reset_at:record.reset_at};
 if(record.remaining===null)return {state:'unknown',remaining:null,reason:'remaining not reported',provider:record.provider};
 return {state:'fresh',remaining:record.remaining,limit:record.limit,unit:record.unit,window:record.window,reset_at:record.reset_at,source:record.source,provider:record.provider,collected_at:record.collected_at,
  exhausted:record.remaining===0};
}

const quotaDir=root=>controlPath(root,'quota');

export function recordQuota(root,input) {
 const record=validateQuota(input);
 ensureControl(root);assertPlainDir(quotaDir(root));
 fs.mkdirSync(quotaDir(root),{recursive:true,mode:0o700});
 atomic(path.join(quotaDir(root),record.provider+'.json'),record);
 return record;
}

export function loadQuota(root) {
 const out={};
 const dir=quotaDir(root);
 if(!fs.existsSync(dir))return out;
 for(const provider of PROVIDERS){
  const file=path.join(dir,provider+'.json');
  if(!fs.existsSync(file))continue;
  // 제어 폴더 밖에서 바뀐 값일 수 있으니 다시 검증한다. 깨졌으면 '모름'으로 둔다.
  try{
   const st=fs.lstatSync(file);if(st.isSymbolicLink()||!st.isFile()||st.size>16384)continue;
   const record=validateQuota(read(file));
   if(record.provider===provider)out[provider]=record;
  }catch{/* 무효 기록은 무시. 잔량을 0/100으로 만들지 않는다. */}
 }
 return out;
}

// 모든 공급자의 현재 판단. 기록이 없는 공급자도 unknown으로 나온다.
export function quotaReport(root,now=Date.now()) {
 const records=loadQuota(root);
 return Object.fromEntries(PROVIDERS.map(p=>[p,quotaStatus(records[p],now)]));
}

// 확정된(fresh) 소진만 근거로 쓴다. stale/unknown은 아무 것도 바꾸지 않는다.
export function exhaustedExecutors(report,executors) {
 return executors.filter(e=>{
  const st=report?.[PROVIDER_OF[e]];
  return st?.state==='fresh'&&st.exhausted===true;
 });
}

if(isMain(import.meta.url)){
 try{
  const [root,action,file]=process.argv.slice(2);
  if(!root||!['record','status'].includes(action))throw Error('Usage: quota-policy.mjs REPO record QUOTA.json | REPO status');
  const out=action==='record'?recordQuota(root,readInput(file)):quotaReport(root);
  console.log(JSON.stringify(out,null,2));
 }catch(e){printError(e);}
}
