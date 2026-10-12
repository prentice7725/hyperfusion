// Codex가 자기 세션 기록에 남기는 사용량 한도(rate_limits)를 읽어 quota 기록 입력으로 바꾼다.
// 네트워크를 쓰지 않고 모델도 부르지 않는다. 기록의 숫자 필드만 꺼내고 대화 내용은 읽어 두지도 저장하지도 않는다.
// 이 값은 Codex를 마지막으로 대화형으로 쓴 시점의 것이다(exec 실행은 rate_limits를 null로 남긴다).
// 그래서 collected_at은 지금이 아니라 그 기록의 시각이고, TTL이 지나면 quota-policy가 stale로 본다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TAIL_BYTES=256*1024;
const MAX_FILES=8;
const TTL_MS=30*60*1000;

export const codexHome=(env=process.env)=>env.HF_CODEX_HOME||env.CODEX_HOME||path.join(os.homedir(),'.codex');

// sessions/YYYY/MM/DD/rollout-*.jsonl. 날짜 폴더를 따라 내려가며 최근 파일부터 모은다.
function newestFiles(dir,limit) {
 const out=[];
 const walk=(d,depth)=>{
  let entries;
  try{entries=fs.readdirSync(d,{withFileTypes:true});}catch{return;}
  for(const e of entries){
   const p=path.join(d,e.name);
   if(e.isSymbolicLink())continue;
   if(e.isDirectory()&&depth<5)walk(p,depth+1);
   else if(e.isFile()&&e.name.endsWith('.jsonl')){try{out.push({file:p,mtime:fs.statSync(p).mtimeMs});}catch{}}
  }
 };
 walk(dir,0);
 return out.sort((a,b)=>b.mtime-a.mtime).slice(0,limit);
}

function tailLines(file) {
 const fd=fs.openSync(file,'r');
 try{
  const {size}=fs.fstatSync(fd),start=Math.max(0,size-TAIL_BYTES);
  const buf=Buffer.alloc(size-start);
  fs.readSync(fd,buf,0,buf.length,start);
  const lines=buf.toString('utf8').split(/\r?\n/);
  if(start>0)lines.shift(); // 잘린 첫 줄
  return lines;
 }finally{fs.closeSync(fd);}
}

const finite=v=>typeof v==='number'&&Number.isFinite(v);

// 가장 최근의 rate_limits가 있는 token_count 기록. 없으면 null.
export function latestRateLimits(home=codexHome()) {
 for(const {file,mtime} of newestFiles(path.join(home,'sessions'),MAX_FILES)){
  let lines;
  try{lines=tailLines(file);}catch{continue;}
  for(let i=lines.length-1;i>=0;i--){
   if(!lines[i].includes('rate_limits'))continue;
   let row;
   try{row=JSON.parse(lines[i]);}catch{continue;}
   const p=row?.payload??row;
   if(p?.type!=='token_count'||!p.rate_limits||typeof p.rate_limits!=='object')continue;
   const at=Date.parse(row.timestamp??p.timestamp);
   return {rate_limits:p.rate_limits,at:Number.isFinite(at)?at:mtime};
  }
 }
 return null;
}

// quota-policy.recordQuota에 넘길 입력. 가장 빡빡한 창(사용률이 가장 높은 창)을 기준으로 한다.
export function codexQuotaInput(home=codexHome()) {
 const found=latestRateLimits(home);
 if(!found)return {ok:false,reason:'no Codex session record with rate_limits under '+path.join(home,'sessions')+' (run Codex interactively once; codex exec leaves rate_limits null)'};
 const windows=['primary','secondary'].map(k=>({key:k,...found.rate_limits[k]})).filter(w=>finite(w.used_percent));
 if(!windows.length)return {ok:false,reason:'the newest rate_limits record has no used_percent'};
 const w=windows.reduce((a,b)=>b.used_percent>a.used_percent?b:a);
 const used=Math.min(100,Math.max(0,w.used_percent));
 const resets=finite(w.resets_at)?(w.resets_at>1e12?w.resets_at:w.resets_at*1000):null;
 return {ok:true,input:{
  provider:'openai',source:'supported_tool',collected_at:new Date(found.at).toISOString(),ttl_ms:TTL_MS,
  reset_at:resets?new Date(resets).toISOString():null,
  window:finite(w.window_minutes)?`${w.key} ${w.window_minutes}min`:w.key,
  unit:'percent',remaining:Math.round((100-used)*10)/10,limit:100,
  note:'Codex local session record; as fresh as the last interactive turn'}};
}
