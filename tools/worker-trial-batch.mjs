// 일꾼 역량 시험 묶음(references/worker-capability-trial.md). 두 단계로 돈다.
//
// 1. 실행: 일꾼 라운드만 돌리고(worker-trial --defer-settle) 기록을 executed.jsonl에 남긴다. --parallel이면 회사별 줄
//    (openai, xai, anthropic, google)을 동시에 돌리고, 한 줄 안에서는 하나씩 돈다. 같은 회사 모델은 한도를 같이 쓰므로
//    겹치지 않는다.
// 2. 마무리: 실행이 모두 끝난 뒤 finish(수용 테스트)와 숨김 시험 채점을 하나씩 돌려 trials.jsonl에 남긴다. 테스트가
//    서로 CPU를 빼앗지 않게 동시에 돌리지 않는다.
//
// - 이어 돌리기: trials.jsonl에 있는 시험은 끝난 것, executed.jsonl에만 있는 시험은 마무리만 남은 것이다. 폴더만 남고
//   기록이 없는 시험은 일꾼 탓이 아니므로 다음 이름(…-1b, …-1c)으로 다시 돌리고 batch-events.jsonl에 남긴다.
//   작업 상태 폴더가 저장소 경로로 정해지므로 같은 폴더를 다시 쓰지 않는다.
// - 응답 없음: 실행은 (시간 제한 + 여유), 마무리는 --settle-min을 넘기면 프로세스 트리를 끊고 WATCHDOG_TIMEOUT을 남긴다.
// - 기록 파일은 이 프로세스만 쓴다. 같은 폴더에 묶음 두 개가 돌지 않게 batch.lock을 잡는다.
//
//   node tools/worker-trial-batch.mjs run ../hf-trials [--parallel] [--reps 2] [--timeout-min 60] [--grace-min 20] [--settle-min 30]
//   node tools/worker-trial-batch.mjs status ../hf-trials
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {printError} from '../scripts/cli.mjs';
import {isMain,isWin,killTree} from '../scripts/platform.mjs';
import {readRecords,summarize} from './worker-trial.mjs';

export const ARMS=[
 {label:'terra',vendor:'openai',args:['--worker','terra']},
 {label:'grok',vendor:'xai',args:['--worker','grok']},
 {label:'sonnet',vendor:'anthropic',args:['--worker','sonnet']},
 {label:'flash38',vendor:'google',args:['--worker','antigravity','--model','gemini-3.8-flash','--effort','high']},
 {label:'hydrogen',vendor:'google',args:['--worker','antigravity','--model','gemini-4-hydrogen','--effort','high']},
];
export const CASES=['HF-L01','HF-L02','HF-L03','HF-L04','HF-L05'];
const TRIAL_SCRIPT=fileURLToPath(new URL('./worker-trial.mjs',import.meta.url));

// 계획 문서의 순서: 회차 1을 다 돈 뒤 회차 2, 과제마다 대상 순서를 한 칸씩 돌린다.
export function schedule({reps=2,cases=CASES,arms=ARMS}={}) {
 const list=[];
 for(let rep=1;rep<=reps;rep++)for(let c=0;c<cases.length;c++)for(let i=0;i<arms.length;i++){
  const arm=arms[(i+c+rep)%arms.length];
  list.push({trial_id:`${cases[c].toLowerCase()}-${arm.label}-${rep}`,case_id:cases[c],rep,arm});
 }
 return list;
}

// 예전 묶음(셸 반복문)이 남긴 기록에는 trial_id가 없어 폴더 이름에서 얻는다(…-1, …-1b → …-1).
export const trialIdOf=r=>r.trial_id??(r.repo?path.basename(r.repo).replace(/^(.*-\d+)[a-z]?$/,'$1'):null);
const attemptName=(id,n)=>n===0?id:id+String.fromCharCode(97+n);   // id, idb, idc, …
const now=()=>new Date().toISOString();
const load=file=>fs.existsSync(file)?readRecords(file):[];
const files=out=>({final:path.join(out,'trials.jsonl'),executed:path.join(out,'executed.jsonl'),events:path.join(out,'batch-events.jsonl'),pending:path.join(out,'settle-pending')});

function lock(out) {
 const file=path.join(out,'batch.lock');
 try{fs.writeFileSync(file,JSON.stringify({pid:process.pid,started_at:now()}),{flag:'wx'});}
 catch(e){
  if(e.code!=='EEXIST')throw e;
  const held=(()=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return {};}})();
  const alive=(()=>{try{process.kill(held.pid,0);return true;}catch(err){return err.code==='EPERM';}})();
  if(Number.isSafeInteger(held.pid)&&alive)throw Error(`worker-trial-batch: another batch (pid ${held.pid}) is running in ${out}`);
  fs.writeFileSync(file,JSON.stringify({pid:process.pid,started_at:now(),took_over_from:held.pid??null}));
 }
 return ()=>{try{if(JSON.parse(fs.readFileSync(file,'utf8')).pid===process.pid)fs.rmSync(file);}catch{}};
}

// 자식 프로세스 하나를 기한 안에 돌리고 stdout의 JSON 기록을 돌려준다. 기한을 넘기거나 기록이 없으면 fallback으로 만든다.
function child([exe,args],limitMin,fallback) {
 return new Promise(resolve=>{
  const proc=spawn(exe,args,{stdio:['ignore','pipe','pipe'],windowsHide:true,detached:!isWin});
  let stdout='',stderr='',watchdog=false;
  proc.stdout.on('data',d=>{stdout+=d;});
  proc.stderr.on('data',d=>{stderr=(stderr+d).slice(-4000);});
  const timer=setTimeout(()=>{watchdog=true;killTree(proc,{force:true});},Math.round(limitMin*60000));
  proc.on('close',code=>{
   clearTimeout(timer);
   if(watchdog)return resolve(fallback('watchdog',`WATCHDOG_TIMEOUT: no result after ${limitMin} min; process tree killed`));
   try{resolve(JSON.parse(stdout));}
   catch{resolve(fallback('crash',`process exited with ${code} without a record: ${stderr.trim().slice(-400)}`));}
  });
 });
}

export const defaultCommands={
 execute:(trial,dir,timeoutMin)=>[process.execPath,[TRIAL_SCRIPT,'run',trial.case_id,dir,...trial.arm.args,'--label',trial.arm.label,'--timeout-min',String(timeoutMin),'--defer-settle']],
 settle:recordFile=>[process.execPath,[TRIAL_SCRIPT,'settle',recordFile]],
};

export async function runBatch({out,reps=2,cases=CASES,arms=ARMS,parallel=false,timeoutMin=60,graceMin=20,settleMin=30,commands=defaultCommands,log=()=>{}}) {
 fs.mkdirSync(out,{recursive:true});
 const f=files(out),unlock=lock(out);
 const event=e=>{fs.appendFileSync(f.events,JSON.stringify({at:now(),...e})+'\n');log(e);};
 const finished=[];
 try{
  const plan=schedule({reps,cases,arms});
  const final=new Set(load(f.final).map(trialIdOf)),executed=new Set(load(f.executed).map(trialIdOf));
  const todo=plan.filter(t=>!final.has(t.trial_id)&&!executed.has(t.trial_id));
  // 1. 실행. 줄마다 하나씩, 줄끼리는 동시에.
  const lanes=new Map();
  for(const t of todo){const key=parallel?t.arm.vendor??t.arm.label:'all';lanes.set(key,[...(lanes.get(key)??[]),t]);}
  if(todo.length)event({event:'execute-phase',trials:todo.length,lanes:[...lanes.keys()]});
  await Promise.all([...lanes.values()].map(async lane=>{
   for(const trial of lane){
    let n=0;
    while(fs.existsSync(path.join(out,attemptName(trial.trial_id,n)))){
     event({event:'interrupted',trial_id:trial.trial_id,dir:attemptName(trial.trial_id,n),note:'folder without a record; rerun under a new name'});
     n++;
    }
    const dir=path.join(out,attemptName(trial.trial_id,n));
    event({event:'start',trial_id:trial.trial_id,dir:path.basename(dir)});
    const started=Date.now();
    const result=await child(commands.execute(trial,dir,timeoutMin),timeoutMin+graceMin,
     (stage,error)=>({case_id:trial.case_id,label:trial.arm.label,repo:path.resolve(dir),stage,error,score:null,usage:null,settled:false}));
    const record={...result,trial_id:trial.trial_id,rep:trial.rep,attempt:path.basename(dir),concurrent_lanes:lanes.size};
    fs.appendFileSync(f.executed,JSON.stringify(record)+'\n');
    event({event:'executed',trial_id:trial.trial_id,minutes:Math.round((Date.now()-started)/6000)/10,stage:record.stage,error:record.error?.slice(0,120)??null});
   }
  }));
  // 2. 마무리. 하나씩.
  const done=new Set(load(f.final).map(trialIdOf));
  const waiting=load(f.executed).filter(r=>!done.has(trialIdOf(r)));
  const order=new Map(plan.map((t,i)=>[t.trial_id,i]));
  waiting.sort((a,b)=>(order.get(trialIdOf(a))??1e9)-(order.get(trialIdOf(b))??1e9));
  if(waiting.length)event({event:'settle-phase',trials:waiting.length});
  fs.mkdirSync(f.pending,{recursive:true});
  for(const r of waiting){
   const id=trialIdOf(r),recordFile=path.join(f.pending,`${id}.json`);
   fs.writeFileSync(recordFile,JSON.stringify(r));
   const result=await child(commands.settle(recordFile),settleMin,(stage,error)=>({...r,settled:true,settle_error:`${stage}: ${error}`}));
   const record={...result,trial_id:id,rep:r.rep,attempt:r.attempt,concurrent_lanes:r.concurrent_lanes};
   fs.appendFileSync(f.final,JSON.stringify(record)+'\n');
   fs.rmSync(recordFile,{force:true});
   event({event:'settled',trial_id:id,stage:record.stage,error:record.error?.slice(0,120)??null,
    hidden:record.score?`${record.score.hidden_passed}/${record.score.hidden_passed+record.score.hidden_failed}`:null});
   finished.push(record);
  }
 }finally{unlock();}
 return finished;
}

export function status(out,{reps=2,cases=CASES,arms=ARMS}={}) {
 const f=files(out),records=load(f.final);
 const done=new Set(records.map(trialIdOf)),executed=new Set(load(f.executed).map(trialIdOf));
 const all=schedule({reps,cases,arms});
 return {done:all.filter(t=>done.has(t.trial_id)).length,awaiting_settle:all.filter(t=>executed.has(t.trial_id)&&!done.has(t.trial_id)).length,
  total:all.length,not_started:all.filter(t=>!done.has(t.trial_id)&&!executed.has(t.trial_id)).map(t=>t.trial_id),summary:summarize(records)};
}

if(isMain(import.meta.url)){
 try{
  const [cmd,out,...rest]=process.argv.slice(2);
  const flag=(name,fallback)=>{const i=rest.indexOf(name);return i>=0?Number(rest[i+1]):fallback;};
  const opts={reps:flag('--reps',2),timeoutMin:flag('--timeout-min',60),graceMin:flag('--grace-min',20),settleMin:flag('--settle-min',30)};
  if(!Object.values(opts).every(n=>Number.isFinite(n)&&n>0))throw Error('worker-trial-batch: --reps, --timeout-min, --grace-min and --settle-min must be positive numbers');
  if(cmd==='run'&&out){
   await runBatch({out,...opts,parallel:rest.includes('--parallel'),log:e=>console.log(JSON.stringify(e))});
   console.log(JSON.stringify(status(out,opts),null,2));
  }else if(cmd==='status'&&out)console.log(JSON.stringify(status(out,opts),null,2));
  else throw Error('Usage: worker-trial-batch.mjs run OUT_DIR [--parallel] [--reps 2] [--timeout-min 60] [--grace-min 20] [--settle-min 30] | status OUT_DIR [--reps 2]');
 }catch(e){printError(e);}
}
