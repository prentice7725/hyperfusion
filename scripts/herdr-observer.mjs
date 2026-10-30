// Herdr 관측 pane. 작업자는 여전히 컨트롤러가 헤드리스로 띄우고, Herdr에는 그 작업자의 모니터 파일을 보여 주는 pane만 연다.
// 실행·종료 증명·결과 검증은 건드리지 않는다. pane은 읽기 전용 화면이고, 만들지 못해도 라운드는 그대로 진행된다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {isMain} from './platform.mjs';
import {stateHome} from './control-dir.mjs';

const SELF=fileURLToPath(import.meta.url);
const PANE_ID=/^[\w:.-]{1,64}$/;
const TAG=/^[\w-]+$/;
const TERMINAL=new Set(['EXITED','ERROR']);
// ERROR는 권한·한도 경고로도 생길 수 있으니 프로세스 종료가 관측된 때만 끝으로 본다.
const finished=(view,exited)=>!!view&&(view.state==='EXITED'||(view.state==='ERROR'&&exited===true));
const HERDR_TIMEOUT_MS=5000;
const SHELL_POLLS=20;
const SHELL_POLL_MS=150;
// pane 하나를 붙이는 데 쓰는 전체 시간. 브리지는 종료 증명 전에 이것을 기다리므로 Herdr가 느려도 라운드가 이 이상 늦지 않는다.
const ATTACH_BUDGET_MS=10000;
const CLOSE_TIMEOUT_MS=2000;
const MAX_PANES=16;
// 작업자 출력은 비신뢰 문자열이다. 터미널에 그대로 쓰면 ESC 시퀀스로 화면 제목, 클립보드(OSC 52), 링크를 조작할 수 있어
// C0·C1 제어 문자와 양방향 텍스트 제어 문자를 '?'로 바꾼다.
export const clean=v=>String(v??'').replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g,'?');

// HYPERFUSION_HERDR 3상태. 없으면 자동(Herdr pane 안일 때만 켠다), 0이면 항상 끈다, 1이면 강제로 켠다.
// 강제인데 Herdr 밖이면 켜지지 않고 사유를 남기도록 forced를 돌려준다. 자동으로 꺼진 경우는 조용히 넘어간다.
export function herdrEnabled(env=process.env) {
 const mode=env.HYPERFUSION_HERDR;
 if(mode==='0')return {enabled:false,forced:false,reason:'HYPERFUSION_HERDR=0'};
 if(mode!==undefined&&mode!==''&&mode!=='1')return {enabled:false,forced:false,reason:'HYPERFUSION_HERDR must be 0 or 1 (or unset)'};
 if(env.HERDR_PANE_ID)return {enabled:true,forced:mode==='1',reason:null};
 if(mode==='1')return {enabled:false,forced:true,reason:'HYPERFUSION_HERDR=1 but not running inside a Herdr pane (HERDR_PANE_ID missing)'};
 return {enabled:false,forced:false,reason:'not running inside a Herdr pane (auto)'};
}

export const shQuote=s=>"'"+String(s).replaceAll("'","'\\''")+"'";
// PowerShell은 작은따옴표뿐 아니라 곡선 따옴표도 문자열 경계로 본다. 모두 두 번 써서 이스케이프한다.
export const psQuote=s=>"'"+String(s).replace(/['‘’‚‛]/g,c=>c+c)+"'";
// cmd.exe는 큰따옴표 안에서도 %VAR%를 풀기 때문에 그런 경로는 받지 않는다.
export function cmdQuote(s) {
 const text=String(s);
 if(/["%\r\n]/.test(text))throw Error('Path cannot be quoted safely for cmd.exe');
 return '"'+text+'"';
}

// pane 안에서 도는 셸 종류. 알 수 없으면 null이라 pane을 열지 않는다.
export function shellKind(name) {
 const base=String(name??'').toLowerCase().replace(/^.*[\\/]/,'').replace(/\.exe$/,'');
 if(base==='pwsh'||base==='powershell')return 'powershell';
 if(base==='cmd')return 'cmd';
 if(['bash','sh','zsh','fish','dash','ash'].includes(base))return 'posix';
 return null;
}

// owner는 작업자를 띄운 컨트롤러 프로세스다. 화면은 그 프로세스가 최종 상태 없이 사라지면 멈춘다.
export function viewCommand({dir,tag,owner=null,node=process.execPath,script=SELF,shell='posix'}) {
 if(!TAG.test(tag))throw Error('Invalid monitor tag');
 if(owner!==null&&!(Number.isSafeInteger(owner)&&owner>0))throw Error('Invalid owner pid');
 const args=[node,script,'view',dir,tag,...(owner===null?[]:[String(owner)])];
 if(shell==='powershell')return '& '+args.map((a,i)=>i===2?a:psQuote(a)).join(' ');
 if(shell==='cmd')return args.map((a,i)=>i===2?a:cmdQuote(a)).join(' ');
 if(shell==='posix')return args.map((a,i)=>i===2?a:shQuote(a)).join(' ');
 throw Error('Unsupported pane shell');
}

const defaultRunner=(bin,args,env=process.env,timeout=HERDR_TIMEOUT_MS)=>new Promise((resolve,reject)=>{
 execFile(bin,args,{env,timeout,windowsHide:true,shell:false,maxBuffer:1024*1024},(error,stdout,stderr)=>{
  if(error)reject(Object.assign(error,{stderr:String(stderr??'').slice(0,240)}));else resolve(String(stdout));
 });
});
let runner=defaultRunner;
// 시험에서 가짜 herdr를 끼우는 자리다.
export function setHerdrRunner(fn) {runner=fn??defaultRunner;}

// 한 프로세스 안에서 pane 생성을 순서대로 처리한다. claimed는 이 프로세스가 화면을 띄운 pane과 그 작업자다.
let chain=Promise.resolve();
const claimed=new Map();
export function resetHerdrLayout() {chain=Promise.resolve();claimed.clear();}

// 브리지는 라운드마다 새 프로세스라 메모리만으로는 매번 리드 pane을 다시 나눈다. 리드 pane마다 관측 pane 목록을 상태 폴더에 남긴다.
// 목록은 편의 기록이다. 쓸 때마다 Herdr에 살아 있는지 다시 묻고, 읽거나 쓰지 못하면 새로 나눈다.
export function layoutFile(env) {
 const key=crypto.createHash('sha256').update(`${env.HERDR_SOCKET_PATH??''}\0${env.HERDR_PANE_ID??''}`).digest('hex').slice(0,32);
 return path.join(stateHome(),'herdr',key+'.json');
}
function loadLayout(file,lead) {
 const text=readBounded(file,64*1024);
 try{const data=JSON.parse(text??'null');return data?.lead===lead&&Array.isArray(data.panes)?data.panes.filter(p=>typeof p==='string'&&PANE_ID.test(p)&&p!==lead).slice(0,MAX_PANES):[];}
 catch{return [];}
}
function saveLayout(file,lead,panes) {
 try{
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const tmp=`${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp,JSON.stringify({version:1,lead,panes:panes.slice(-MAX_PANES)}),{mode:0o600});
  fs.renameSync(tmp,file);
 }catch{/* 배치 기록을 못 남겨도 관측은 계속한다 */}
}

const foreground=info=>Array.isArray(info?.foreground_processes)?info.foreground_processes:[];
// 셸만 전면에 있으면 프롬프트에서 쉬는 중이다. 화면이 돌고 있거나 사용자가 무언가 실행 중이면 다시 쓰지 않는다.
const idle=info=>{const procs=foreground(info);return procs.length>0&&procs.every(p=>p?.pid===info.shell_pid);};

function kindOf(info) {
 const procs=foreground(info);
 const proc=procs.find(p=>p?.pid===info?.shell_pid)??procs[0];
 const kind=shellKind(proc?.name??proc?.argv0);
 if(!kind)throw Error('unsupported pane shell: '+clean(proc?.name??'unknown').slice(0,40));
 return kind;
}

async function open({dir,tag,owner},env,platform,deadline) {
 if(!TAG.test(tag))throw Error('Invalid monitor tag');
 // pane 안에는 HERDR_BIN_PATH가 들어 있어 PATH에 herdr가 없어도 찾는다.
 const bin=env.HYPERFUSION_HERDR_BIN||env.HERDR_BIN_PATH||'herdr';
 // 전체 예산을 넘기지 않게 호출마다 남은 시간만큼만 기다린다. 브리지는 이 작업을 기다린 뒤 종료 증명으로 넘어간다.
 const call=(args,ms=HERDR_TIMEOUT_MS)=>{
  const left=deadline-Date.now();
  if(left<=0)return Promise.reject(Error('herdr observer time budget exceeded'));
  return runner(bin,args,env,Math.min(ms,left));
 };
 const info=async id=>JSON.parse(await call(['pane','process-info','--pane',id]))?.result?.process_info;
 const lead=env.HERDR_PANE_ID;
 // 물려받은 환경 변수만 남고 Herdr는 이미 닫혔거나 pane이 사라진 경우를 거른다.
 if(!PANE_ID.test(lead??''))throw Error('HERDR_PANE_ID is not a usable pane id');
 const current=JSON.parse(await call(['pane','get',lead]));
 if(current?.error||current?.result?.pane?.pane_id!==lead)throw Error('current herdr pane is not alive');
 const file=layoutFile(env);
 const panes=[];
 for(const id of new Set([...loadLayout(file,lead),...claimed.keys()])){
  try{const r=JSON.parse(await call(['pane','get',id]));if(!r?.error&&r?.result?.pane?.pane_id===id)panes.push(id);else claimed.delete(id);}
  catch(e){if(Date.now()>=deadline)throw e;claimed.delete(id);}
 }
 const launch=async(id,kind)=>{
  await call(['pane','run',id,viewCommand({dir,tag,owner,shell:kind})]);
  claimed.set(id,{dir,tag});
 };
 // 끝난 관측 pane은 셸 프롬프트로 돌아와 있으므로 새 작업자 화면을 그 자리에 띄운다. 그래서 pane 수는 동시에 도는 작업자 수를 넘지 않는다.
 for(const id of panes){
  const mine=claimed.get(id);
  if(mine&&!readWorkerView(mine.dir,mine.tag).done)continue;
  let state;
  try{state=await info(id);}catch(e){if(Date.now()>=deadline)throw e;continue;}
  if(!idle(state))continue;
  let kind='posix';
  if(platform==='win32'){try{kind=kindOf(state);}catch{continue;}}
  await launch(id,kind);
  saveLayout(file,lead,panes);
  return id;
 }
 // 쉬는 pane이 없으면 마지막 관측 pane 아래로 쌓고, 하나도 없으면 리드 pane 오른쪽에 첫 pane을 만든다.
 const split=panes.length
  ?['pane','split',panes.at(-1),'--direction','down','--no-focus']
  :['pane','split','--current','--direction','right','--no-focus'];
 const created=JSON.parse(await call(split));
 const pane=created?.result?.pane?.pane_id;
 if(typeof pane!=='string'||!PANE_ID.test(pane)||pane===lead)throw Error('herdr pane split returned no usable pane id');
 try{
  let kind='posix';
  if(platform==='win32'){
   // 방금 나눈 pane은 셸이 뜨기 전이라 foreground_processes가 비어 있을 수 있어 잠시 기다린다.
   let state;
   for(let i=0;i<SHELL_POLLS;i++){
    state=await info(pane);
    if(foreground(state).length)break;
    await new Promise(r=>setTimeout(r,SHELL_POLL_MS));
   }
   kind=kindOf(state);
  }
  await launch(pane,kind);
 }catch(e){
  // 빈 pane을 남기지 않는다. 예산이 끝났어도 닫기는 짧게 한 번 시도하고, 실패해도 원래 오류를 보고한다.
  try{await runner(bin,['pane','close',pane],env,CLOSE_TIMEOUT_MS);}catch{/* best effort */}
  throw e;
 }
 panes.push(pane);
 saveLayout(file,lead,panes);
 return pane;
}

// 실패해도 던지지 않고 사유를 돌려준다. 호출한 쪽은 관측 기록에만 남긴다.
export function attachObserverPane({dir,tag,env=process.env,platform=process.platform,owner=process.pid,budgetMs=ATTACH_BUDGET_MS}) {
 const gate=herdrEnabled(env);
 if(!gate.enabled)return Promise.resolve({attached:false,reason:gate.reason});
 const run=chain.then(async()=>{
  try{return {attached:true,pane_id:await open({dir,tag,owner},env,platform,Date.now()+budgetMs)};}
  catch(e){return {attached:false,reason:'herdr: '+clean(e.stderr||e.message).slice(0,200)};}
 });
 chain=run;
 return run;
}

// ── pane 안에서 도는 화면 ──
function readBounded(file,maxBytes) {
 try{
  const st=fs.lstatSync(file);
  if(st.isSymbolicLink()||!st.isFile()||st.size>maxBytes)return null;
  return fs.readFileSync(file,'utf8');
 }catch{return null;}
}

// 신호 0은 존재 확인만 한다. 다른 사용자의 프로세스면 EPERM이 나지만 살아 있는 것이다.
export function ownerAlive(pid) {
 try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}
}

export function readWorkerView(dir,tag) {
 if(!TAG.test(tag))throw Error('Invalid monitor tag');
 let view=null;
 const text=readBounded(path.join(dir,`monitor-${tag}.json`),512*1024);
 let exited=false;
 if(text){try{const {checkpoint,...rest}=JSON.parse(text);view=rest;exited=checkpoint?.reduced?.exited===true;}catch{view={state:'UNKNOWN',parse_error:true};}}
 const raw=readBounded(path.join(dir,`activity-${tag}.ndjson`),256*1024);
 const events=(raw??'').split(/\r?\n/).filter(Boolean).slice(-8).map(l=>{try{return JSON.parse(l);}catch{return null;}}).filter(Boolean);
 return {view,events,done:finished(view,exited)};
}

export function formatWorkerView({view,events},tag,now=Date.now()) {
 if(!view)return `HyperFusion ${clean(tag)}\nwaiting for the worker to start...\n`;
 const age=view.last_activity_at&&!TERMINAL.has(view.state)?Math.max(0,now-Date.parse(view.last_activity_at)):view.last_activity_age_ms;
 const lines=[
  `HyperFusion  ${clean(view.executor??'?')} · ${clean(view.role??'?')} · task ${clean(view.task_id??'?')} round ${clean(view.round??'?')}`,
  `state: ${clean(view.state)}   elapsed: ${Math.round((Number(view.elapsed_ms)||0)/1000)}s   quiet: ${age==null||!Number.isFinite(Number(age))?'n/a':Math.round(Number(age)/1000)+'s'}`,
  `alert: ${clean(view.alert_class??'none')}   telemetry_limited: ${view.telemetry_limited===true}`,
  'observation only — this is not an acceptance or success verdict',
  ''
 ];
 for(const e of events)lines.push(clean(`${String(e.at??'').slice(11,19)}  ${e.kind}  ${e.detail??''}`).trimEnd());
 return lines.join('\n')+'\n';
}

if(isMain(import.meta.url)){
 const [mode,dir,tag,ownerArg]=process.argv.slice(2);
 const owner=ownerArg===undefined?null:Number(ownerArg);
 if(mode!=='view'||!dir||!tag||!TAG.test(tag)||(owner!==null&&!(Number.isSafeInteger(owner)&&owner>0))){
  console.error('Usage: node scripts/herdr-observer.mjs view DIR TAG [OWNER_PID]');
  process.exitCode=1;
 }else{
  let last='';
  const draw=()=>{
   const data=readWorkerView(dir,tag);
   const text=formatWorkerView(data,tag);
   if(text!==last){last=text;process.stdout.write('\x1b[2J\x1b[H'+text);}
   if(data.done)return true;
   // 컨트롤러가 강제로 끝나 최종 상태를 쓰지 못하면 화면이 영원히 돌지 않게 여기서 멈춘다.
   if(owner!==null&&!ownerAlive(owner)){process.stdout.write('\ncontroller process ended without a final worker state; view stopped\n');return true;}
   return false;
  };
  const timer=setInterval(()=>{if(draw()){clearInterval(timer);}},1000);
  if(draw())clearInterval(timer);
  process.on('SIGINT',()=>process.exit(0));process.on('SIGTERM',()=>process.exit(0));
 }
}
