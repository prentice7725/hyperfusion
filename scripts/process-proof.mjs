import {execFile} from 'node:child_process';
import {isWin} from './platform.mjs';

// Cold CIM startup can take over 10 seconds on a busy Windows CI runner.
// Keep a bounded timeout, without interpreting a timeout as proof of shutdown.
const command=(file,args)=>new Promise((resolve,reject)=>{
 const child=execFile(file,args,{encoding:'utf8',windowsHide:true,timeout:isWin?30000:10000,maxBuffer:8*1024*1024},(e,out)=>{
  if(e){if(e.killed)e.code='PROCESS_TABLE_TIMEOUT';reject(e);}else resolve({out,pid:child.pid});
 });
});

export async function processTable() {
 let rows,query;
 if(isWin){
  query=await command('powershell.exe',['-NoProfile','-NonInteractive','-Command',"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{n='created';e={if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}}} | ConvertTo-Json -Compress"]);
  const parsed=JSON.parse(query.out);rows=(Array.isArray(parsed)?parsed:[parsed]).map(p=>({pid:p.ProcessId,parent:p.ParentProcessId,created:p.created}));
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
export function descendants(rows,pid,tracked=new Map()) {
 const ids=new Set([pid]);
 for(const p of rows)if(tracked.get(p.pid)===p.created)ids.add(p.pid);
 const byPid=new Map(rows.map(p=>[p.pid,p]));
 let changed=true;
 while(changed){changed=false;for(const p of rows)if(ids.has(p.parent)&&!ids.has(p.pid)&&!olderThanParent(p,byPid.get(p.parent))){ids.add(p.pid);changed=true;}}
 return rows.filter(p=>ids.has(p.pid));
}

// This is supervised process-tree evidence, not an OS sandbox: escaped/reparented children
// between observations cannot be guaranteed absent. Unknown process-table errors fail closed.
// A process that has just exited can stay in the Windows process table for a moment
// (open handles, its conhost.exe child). Re-check a few times before reporting survivors;
// survivors after the last check still fail closed.
const SETTLE=isWin?{tries:20,delayMs:500}:{tries:3,delayMs:200};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export function watchProcessTree({readTable=processTable,pollMs=1000,settle=SETTLE,baseline=null}={}) {
 const tracked=new Map();let pid=null,timer=null,pending=Promise.resolve(),error=null,querying=false,stopped=false;
 const observe=async()=>{
  try{const rows=await readTable();for(const p of descendants(rows,pid,tracked)){
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
  start(value){pid=value;poll();timer=setInterval(poll,pollMs);timer.unref();},
  async finish({exited,aborted=false}){
   stopped=true;clearInterval(timer);await pending;
   if(!pid||!exited||aborted)return {quiescent:false,reason:'Executor termination was not confirmed'};
   try{
    if(error)return {quiescent:false,reason:error};
    let remaining=[],checks=0;
    for(;;){
     const rows=await readTable(),live=descendants(rows,pid,tracked);checks++;
     // Same PID with a different creation time is a reused PID, not our process.
     remaining=live.filter(p=>p.pid!==pid||!tracked.has(pid)||tracked.get(pid)===p.created);
     if(baseline){
      const ids=new Set(remaining.map(p=>p.pid));
      for(const p of unattributedProcesses(rows,baseline,process.pid))if(!ids.has(p.pid)){remaining.push(p);ids.add(p.pid);}
     }
     if(!remaining.length||checks>=settle.tries)break;
     await sleep(settle.delayMs);
    }
    return {quiescent:remaining.length===0,reason:remaining.length?'Supervised processes remain':'Supervised process tree stopped',
     tracked:tracked.size,checks,remaining:remaining.map(p=>({pid:p.pid,created:p.created})),checked_at:new Date().toISOString(),platform:process.platform};
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
