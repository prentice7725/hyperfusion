import {execFile} from 'node:child_process';
import {isWin} from './platform.mjs';

// Cold CIM startup can take over 10 seconds on a busy Windows CI runner.
// Keep a bounded timeout, without interpreting a timeout as proof of shutdown.
const command=(file,args)=>new Promise((resolve,reject)=>execFile(file,args,{encoding:'utf8',windowsHide:true,timeout:isWin?30000:10000,maxBuffer:8*1024*1024},(e,out)=>{
 if(e){if(e.killed)e.code='PROCESS_TABLE_TIMEOUT';reject(e);}else resolve(out);
}));

async function table() {
 if(isWin){
  const out=await command('powershell.exe',['-NoProfile','-NonInteractive','-Command',"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{n='created';e={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress"]);
  const rows=JSON.parse(out);return (Array.isArray(rows)?rows:[rows]).map(p=>({pid:p.ProcessId,parent:p.ParentProcessId,created:p.created}));
 }
 const out=await command('ps',['-eo','pid=,ppid=,lstart=']);
 return out.trim().split('\n').filter(Boolean).map(line=>{
  const m=line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
  if(!m)throw Error('Unrecognized process table');
  return {pid:Number(m[1]),parent:Number(m[2]),created:m[3]};
 });
}

export function descendants(rows,pid,tracked=new Map()) {
 const ids=new Set([pid]);
 for(const p of rows)if(tracked.get(p.pid)===p.created)ids.add(p.pid);
 let changed=true;
 while(changed){changed=false;for(const p of rows)if(ids.has(p.parent)&&!ids.has(p.pid)){ids.add(p.pid);changed=true;}}
 return rows.filter(p=>ids.has(p.pid));
}

// This is supervised process-tree evidence, not an OS sandbox: escaped/reparented children
// between observations cannot be guaranteed absent. Unknown process-table errors fail closed.
export function watchProcessTree({readTable=table,pollMs=1000}={}) {
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
    const rows=await readTable(),live=descendants(rows,pid,tracked);
    if(error)return {quiescent:false,reason:error};
    // Same PID with a different creation time is a reused PID, not our process.
    const remaining=live.filter(p=>p.pid!==pid||!tracked.has(pid)||tracked.get(pid)===p.created);
    return {quiescent:remaining.length===0,reason:remaining.length?'Supervised processes remain':'Supervised process tree stopped',
     tracked:tracked.size,remaining:remaining.map(p=>({pid:p.pid,created:p.created})),checked_at:new Date().toISOString(),platform:process.platform};
   }catch(e){return {quiescent:false,reason:e.code??'PROCESS_TABLE_UNAVAILABLE'};}
  }
 };
}
