// 일꾼 호출 조절(references/worker-pacing-draft.md). 계정은 저장소가 아니라 컴퓨터에 묶여 있으므로 기록은 이 컴퓨터 단위로 둔다.
//
// - 호출 간격: 팀 파일의 min_interval_s가 1 이상인 CLI는 이 컴퓨터에서 한 번에 하나만 띄우고, 앞 실행이 끝난 뒤 그 시간만큼 쉰다.
//   단위는 일꾼 이름이 아니라 CLI 바이너리다(Sonnet·Haiku는 claude, Terra·Luna·Sol은 codex). 같은 CLI의 값 중 가장 큰 값을 쓴다.
// - 정지 차단기: 실행 출력(stderr, CLI 오류 메시지)에 계정 정지 문구가 있으면 그 CLI를 이 컴퓨터에서 더 띄우지 않는다.
//   자동으로 풀지 않는다. 운영자가 setup-doctor --clear-suspension으로 푼다.
// - 모델 목록: agy models 결과를 6시간 넣어 두고 이 컴퓨터의 모든 작업이 같이 쓴다. 이 조회도 서버에 닿는 호출이다.
//
// 자동화를 숨기는 장치(무작위 간격, 계정 전환)는 두지 않는다. 목적은 호출을 줄이는 것이다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MEMBERS} from './member-registry.mjs';
import {redactText} from './redaction.mjs';

export const PACING_DIR_ENV='HF_PACING_DIR';
export const SEATS=['implement','review','consult'];
export const MAX_INTERVAL_S=3600;
export const MODELS_CACHE_MS=6*60*60*1000;
export const pacingDir=(env=process.env)=>env[PACING_DIR_ENV]?.trim()||path.join(os.homedir(),'.hyperfusion','pacing');
export const cliOf=executor=>MEMBERS[executor]?.binary??null;

const readJson=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}};
const writeJson=(file,v)=>{fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;fs.writeFileSync(tmp,JSON.stringify(v,null,1));fs.renameSync(tmp,file);};
const iso=ms=>new Date(ms).toISOString();
const alive=pid=>{if(!Number.isSafeInteger(pid))return false;try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};

// 팀 파일이 정한 자리. 적지 않은 일꾼은 세 자리 모두다. 설정(configuration.team)은 init 때 고정된다.
export const seatsOf=(configuration,executor)=>configuration?.team?.seats?.[executor]??SEATS;
export const seatAllowed=(configuration,executor,seat)=>seatsOf(configuration,executor).includes(seat);
export const seatRefusal=(executor,seat)=>`SEAT_POLICY: ${executor} does not take ${seat} on this machine (team file seats)`;

// 같은 CLI의 일꾼들이 적은 간격 중 가장 큰 값(ms). 없으면 0(조절하지 않음).
export function intervalMs(configuration,executor) {
 const cli=cliOf(executor),all=configuration?.team?.min_interval_s??{};
 return Math.max(0,...Object.entries(all).filter(([n])=>cliOf(n)===cli).map(([,s])=>s))*1000;
}

const abortError=()=>Object.assign(Error('PACING_ABORTED: interrupted while waiting for the worker CLI; nothing was started'),{code:'PACING_ABORTED'});
// 중단 신호가 오면 바로 깨는 sleep. 시험은 가짜 sleep을 넘긴다.
export const sleep=(ms,signal)=>new Promise((resolve,reject)=>{
 if(signal?.aborted)return reject(abortError());
 const t=setTimeout(()=>{signal?.removeEventListener('abort',stop);resolve();},ms);
 const stop=()=>{clearTimeout(t);reject(abortError());};
 signal?.addEventListener('abort',stop,{once:true});
});

// 띄우기 직전에 부른다. 잠금을 잡고, 앞 실행이 끝난 뒤 간격이 지날 때까지 기다린 다음 시작 시각을 적는다.
// 돌려준 release()는 프로세스가 끝난 뒤 부른다(끝난 시각을 적고 잠금을 놓는다). 간격이 0이면 아무것도 하지 않는다.
// deadline(ms 시각)을 넘겨야 띄울 수 있으면 기다리지 않고 PACING_DEADLINE으로 멈춘다(작업 경과 시간 상한).
export async function acquirePacing(cli,{interval=0,meta={},dir=pacingDir(),now=()=>Date.now(),wait=sleep,signal=null,deadline=null,pollMs=2000,onWait=()=>{}}={}) {
 if(!cli||!(interval>0))return {paced_ms:0,release:()=>{}};
 const lock=path.join(dir,`${cli}.lock`),record=path.join(dir,`${cli}.json`),host=os.hostname(),started=now();
 fs.mkdirSync(dir,{recursive:true});
 const past=ms=>deadline!==null&&now()+ms>deadline;
 const overDeadline=ms=>Object.assign(Error(`PACING_DEADLINE: ${cli} may launch only after ${Math.ceil(ms/1000)}s more, past this task's wall-time limit; nothing was started`),{code:'PACING_DEADLINE'});
 for(;;){
  if(signal?.aborted)throw abortError();
  try{fs.writeFileSync(lock,JSON.stringify({pid:process.pid,host,at:iso(now()),...meta}),{flag:'wx'});}
  catch(e){
   if(e.code!=='EEXIST')throw e;
   const held=readJson(lock);
   if(held?.host&&held.host!==host)throw Object.assign(Error(`PACING_LOCK_FOREIGN: ${lock} is held by host ${held.host}; confirm that host is not running ${cli}, then remove the file`),{code:'PACING_LOCK_FOREIGN'});
   // 주인이 죽은 잠금은 치운다. 끝난 시각이 없으면 치운 시각을 끝난 시각으로 본다.
   if(held&&!alive(held.pid)){
    const r=readJson(record);
    if(r&&!r.ended_at)writeJson(record,{...r,ended_at:iso(now()),ended_by:'stale-lock-cleanup'});
    fs.rmSync(lock,{force:true});continue;
   }
   if(past(pollMs))throw overDeadline(pollMs);
   onWait({cli,reason:'busy',ms:pollMs});
   await wait(pollMs,signal);continue;
  }
  const unlock=()=>fs.rmSync(lock,{force:true});
  try{
   const last=readJson(record),ended=last?.ended_at?Date.parse(last.ended_at):NaN;
   const left=Number.isFinite(ended)?Math.max(0,ended+interval-now()):0;
   if(left>0){
    if(past(left))throw overDeadline(left);
    onWait({cli,reason:'interval',ms:left});
    await wait(left,signal);
   }
   writeJson(record,{cli,pid:process.pid,host,started_at:iso(now()),ended_at:null,...meta});
  }catch(e){unlock();throw e;}
  let released=false;
  return {paced_ms:now()-started,release:()=>{
   if(released)return;released=true;
   try{const r=readJson(record);writeJson(record,{...(r??{cli}),ended_at:iso(now())});}finally{unlock();}
  }};
 }
}

// 마지막 실행 기록(doctor 보고용).
export const lastRun=(cli,{dir=pacingDir()}={})=>readJson(path.join(dir,`${cli}.json`));

// 계정 정지 문구. CLI마다 따로 두고 같은 코드로 본다. 지금은 구글 문구만 확인됐다.
export const SUSPENSION_TEXT={
 agy:/disabled in this account for violation of Terms of Service|\bTOS_VIOLATION\b/i,
};
// 정지 문구가 있는 첫 줄(비밀 가림, 200자까지). 없으면 null.
export function suspensionHit(cli,text) {
 const re=SUSPENSION_TEXT[cli];
 if(!re)return null;
 const line=String(text??'').split(/\r?\n/).find(l=>re.test(l));
 return line?redactText(line.trim()).slice(0,200):null;
}
const suspensionFile=(cli,dir)=>path.join(dir,`${cli}-suspended.json`);
export const suspension=(cli,{dir=pacingDir()}={})=>cli?readJson(suspensionFile(cli,dir)):null;
// 처음 본 정지만 남긴다(뒤 기록이 앞 기록을 덮지 않는다).
export function recordSuspension(cli,line,meta={},{dir=pacingDir(),now=()=>Date.now()}={}) {
 const file=suspensionFile(cli,dir),had=readJson(file);
 if(had)return had;
 const r={cli,at:iso(now()),line,host:os.hostname(),...meta};
 writeJson(file,r);
 return r;
}
export function clearSuspension(cli,{dir=pacingDir()}={}) {
 const file=suspensionFile(cli,dir);
 if(!fs.existsSync(file))return false;
 fs.rmSync(file);return true;
}
export const suspensionMessage=(cli,r)=>`ADAPTER_UNAVAILABLE: ACCOUNT_SUSPENDED: ${cli} reported a Terms of Service suspension at ${r.at}; it will not be launched again on this machine until an operator clears it (node scripts/setup-doctor.mjs REPO --clear-suspension ${cli})`;
// 정지 기록이 있으면 띄우지 않는다.
export function assertNotSuspended(cli,opts) {
 const r=suspension(cli,opts);
 if(r)throw Object.assign(Error(suspensionMessage(cli,r)),{code:'ACCOUNT_SUSPENDED'});
}

// agy models 목록. 넣어 둔 지 6시간이 지나면 없는 것으로 본다.
const modelsFile=(cli,dir)=>path.join(dir,`${cli}-models.json`);
export function cachedModels(cli,{dir=pacingDir(),now=()=>Date.now(),maxAgeMs=MODELS_CACHE_MS}={}) {
 const r=readJson(modelsFile(cli,dir));
 if(!r||typeof r.stdout!=='string'||!Number.isFinite(Date.parse(r.at)))return null;
 return now()-Date.parse(r.at)<=maxAgeMs?r:null;
}
export function cacheModels(cli,stdout,{dir=pacingDir(),now=()=>Date.now()}={}) {
 writeJson(modelsFile(cli,dir),{cli,at:iso(now()),stdout:String(stdout)});
}
