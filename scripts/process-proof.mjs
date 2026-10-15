import {execFile} from 'node:child_process';
import {isWin} from './platform.mjs';

// Cold CIM startup can take over 10 seconds on a busy Windows CI runner.
// Keep a bounded timeout, without interpreting a timeout as proof of shutdown.
const command=(file,args)=>new Promise((resolve,reject)=>{
 const child=execFile(file,args,{encoding:'utf8',windowsHide:true,timeout:isWin?30000:10000,maxBuffer:8*1024*1024},(e,out)=>{
  if(e){if(e.killed)e.code='PROCESS_TABLE_TIMEOUT';reject(e);}else resolve({out,pid:child.pid});
 });
 // The inventory query has no input. Windows PowerShell can wait on an open
 // redirected stdin even with -NonInteractive when launched from a pipe-fed helper.
 child.stdin.end();
});

export async function processTable() {
 let rows,query;
 if(isWin){
  // Load the system module explicitly: automatic module discovery can stall in
  // a filtered environment on hosted Windows runners. Do not resolve a repo module.
  query=await command('powershell.exe',['-NoProfile','-NonInteractive','-Command',"Import-Module (Join-Path $PSHOME 'Modules\\CimCmdlets\\CimCmdlets.psd1') -ErrorAction Stop; CimCmdlets\\Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,@{n='created';e={if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}}} | ConvertTo-Json -Compress"]);
  const parsed=JSON.parse(query.out);rows=(Array.isArray(parsed)?parsed:[parsed]).map(p=>({pid:p.ProcessId,parent:p.ParentProcessId,created:p.created,...(typeof p.Name==='string'?{name:p.Name}:{})}));
 } else {
  query=await command('ps',['-eo','pid=,ppid=,stat=,lstart=']);
  rows=query.out.trim().split('\n').filter(Boolean).map(line=>{
   const m=line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
   if(!m)throw Error('Unrecognized process table');
   return {pid:Number(m[1]),parent:Number(m[2]),zombie:m[3].startsWith('Z'),created:m[4]};
  }).filter(p=>!p.zombie);
 }
 // The inventory query is our child, but is not part of the command being supervised.
 const queryIds=new Set(descendants(rows,query.pid).map(p=>p.pid));
 return rows.filter(p=>!queryIds.has(p.pid));
}

// Windows keeps a dead parent's PID in ParentProcessId and reuses PIDs quickly, so an unrelated older
// process can look like our child. A real child cannot be created before its parent.
const born=p=>{const t=Date.parse(p?.created);return Number.isFinite(t)?t:null;};
const olderThanParent=(child,parent)=>{const c=born(child),p=born(parent);return c!==null&&p!==null&&c<p;};
// 뿌리(감독하는 프로세스)가 이미 끝나 표에 없어도 "자손은 부모보다 먼저 태어날 수 없다"를 지켜야 한다.
// 뿌리의 생성 시각은 표에 있으면 그 값, 없으면 처음 관측한 값(tracked), 그것도 없으면 감독을 시작한 시각(bornAfter)이다.
// 이 제약이 없으면 Windows에서 이런 일이 생긴다: 부팅 때 죽은 프로세스의 PID를 우리 뿌리가 재사용하고, csrss·wininit 같은
// 시스템 프로세스의 ParentProcessId가 아직 그 옛 PID를 가리킨다. 뿌리가 끝나 표에서 사라지면 부모의 생성 시각을 알 수 없어
// 시스템 전체(svchost 수십 개 포함)가 우리 자손으로 잡히고, 수용 테스트가 "프로세스가 남았다"며 RECOVERY_REQUIRED로 멈춘다.
export function descendants(rows,pid,tracked=new Map(),{bornAfter=null}={}) {
 const ids=new Set([pid]);
 for(const p of rows)if(tracked.get(p.pid)===p.created)ids.add(p.pid);
 const byPid=new Map(rows.map(p=>[p.pid,p]));
 const rootBorn=born(byPid.get(pid))??born({created:tracked.get(pid)})??bornAfter;
 const parentBorn=parent=>{
  const row=byPid.get(parent);
  if(row)return born(row);
  return parent===pid?rootBorn:null;
 };
 const impossible=p=>{const c=born(p),b=parentBorn(p.parent);return c!==null&&b!==null&&c<b;};
 let changed=true;
 while(changed){changed=false;for(const p of rows)if(ids.has(p.parent)&&!ids.has(p.pid)&&!impossible(p)){ids.add(p.pid);changed=true;}}
 return rows.filter(p=>ids.has(p.pid));
}

// This is supervised process-tree evidence, not an OS sandbox: escaped/reparented children
// between observations cannot be guaranteed absent. Unknown process-table errors fail closed.
// A process that has just exited can stay in the Windows process table for a moment
// (open handles, its conhost.exe child). Re-check a few times before reporting survivors;
// survivors after the last check still fail closed.
const SETTLE=isWin?{tries:20,delayMs:500}:{tries:3,delayMs:200};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// 시작 시각 앞의 여유: Linux의 lstart는 초 단위로 잘리고, 시계 해상도도 플랫폼마다 다르다. 이 여유 안에서 태어난 프로세스는
// 자손으로 인정하는 쪽(실패를 닫는 쪽)으로 기운다.
const START_SLACK_MS=2000;
// reap: 일꾼이 끝난 뒤에도 남은 자손 중 "감독 중에 관측한 바로 그 프로세스"(PID와 생성 시각이 모두 같은 것)만 죽인다.
// agy의 도구 자식은 저마다 자기 프로세스 그룹을 만들어서, 그룹 kill로는 agy만 죽고 자식은 init 밑에 고아로 남는다.
// 부모가 죽으면 부모 연결이 끊기므로, 감독 중 폴링으로 모아 둔 (PID, 생성 시각) 목록이 그 자식을 알아보는 유일한 근거다.
// 생성 시각이 다르면 재사용된 PID이므로 건드리지 않는다. 폴링 사이에 태어나 바로 빠져나간 자손은 목록에 없어 죽이지 못하지만,
// 그런 것도 아래 정지 증명이 그대로 잡아낸다(정리는 증명을 대신하지 않는다).
export function watchProcessTree({readTable=processTable,pollMs=1000,settle=SETTLE,baseline=null,reap=false,kill=(pid)=>process.kill(pid,'SIGKILL')}={}) {
 const tracked=new Map();let pid=null,timer=null,pending=Promise.resolve(),error=null,querying=false,stopped=false,bornAfter=null;
 const observe=async()=>{
  try{const rows=await readTable();for(const p of descendants(rows,pid,tracked,{bornAfter})){
   if(!Number.isSafeInteger(p.pid)||p.pid<1||typeof p.created!=='string'||!p.created)throw Object.assign(Error('Process identity unavailable'),{code:'PROCESS_IDENTITY_UNAVAILABLE'});
   tracked.set(p.pid,p.created);
  }}
  catch(e){error=e.code??'PROCESS_TABLE_UNAVAILABLE';}
 };
 // Do not queue observations behind a slow CIM call: that creates a growing
 // backlog precisely when the process-table service is overloaded.
 const poll=()=>{
  if(querying||stopped)return;
  querying=true;pending=observe().finally(()=>{querying=false;});
 };
 return {
  start(value){pid=value;bornAfter=Date.now()-START_SLACK_MS;poll();timer=setInterval(poll,pollMs);timer.unref();},
  async finish({exited,aborted=false}){
   stopped=true;clearInterval(timer);await pending;
   if(!pid||!exited||aborted)return {quiescent:false,reason:'Executor termination was not confirmed'};
   try{
    if(error)return {quiescent:false,reason:error};
    let remaining=[],checks=0,owned=[];const reaped=[];
    for(;;){
     const rows=await readTable(),live=descendants(rows,pid,tracked,{bornAfter});checks++;owned=live;
     // Same PID with a different creation time is a reused PID, not our process.
     remaining=live.filter(p=>p.pid!==pid||!tracked.has(pid)||tracked.get(pid)===p.created);
     // 첫 확인에서 한 번만 정리한다. 정리한 뒤에도 남은 것은 다음 확인이 그대로 보고한다.
     if(reap&&checks===1){
      for(const p of remaining){
       if(p.pid<=1||p.pid===process.pid||tracked.get(p.pid)!==p.created)continue;
       try{kill(p.pid);reaped.push({pid:p.pid,parent:p.parent,created:p.created,...(p.name?{name:p.name}:{})});}catch(e){if(e.code!=='ESRCH')reaped.push({pid:p.pid,error:e.code??e.message});}
      }
      if(reaped.length){await sleep(settle.delayMs);continue;}
     }
     if(baseline){
      const ids=new Set(remaining.map(p=>p.pid));
      for(const p of unattributedProcesses(rows,baseline,process.pid))if(!ids.has(p.pid)){remaining.push(p);ids.add(p.pid);}
     }
     if(!remaining.length||checks>=settle.tries)break;
     await sleep(settle.delayMs);
    }
    return {quiescent:remaining.length===0,reason:remaining.length?'Supervised processes remain':'Supervised process tree stopped',
     tracked:tracked.size,checks,...(reaped.length?{reaped}:{}),// 실패 원인을 남긴 쪽이 우리 명령의 자손인지, 출처를 알 수 없는 새 프로세스인지 보이게 한다.
     remaining:remaining.map(p=>({pid:p.pid,parent:p.parent,created:p.created,...(p.name?{name:p.name}:{}),orphan_check:!owned.some(x=>x.pid===p.pid)})),checked_at:new Date().toISOString(),platform:process.platform};
   }catch(e){return {quiescent:false,reason:e.code??'PROCESS_TABLE_UNAVAILABLE'};}
  }
 };
}

// Acceptance commands may exit before the first observation. A newly live orphan
// cannot be attributed safely to another process: fail closed instead of losing it.
// New descendants of an unrelated, pre-existing process are allowed (concurrent CI).
export function unattributedProcesses(rows,baseline,supervisorPid) {
 const old=new Map(baseline.map(p=>[p.pid,p.created])),byPid=new Map(rows.map(p=>[p.pid,p]));
 return rows.filter(p=>{
  if(p.pid===supervisorPid||old.get(p.pid)===p.created)return false;
  const seen=new Set([p.pid]);let current=p;
  for(;;){
   const parent=byPid.get(current.parent);
   if(!parent||parent.pid===1||seen.has(parent.pid)||olderThanParent(current,parent))return true;
   if(parent.pid===supervisorPid)return true;
   if(old.get(parent.pid)===parent.created)return false;
   seen.add(parent.pid);current=parent;
  }
 });
}
