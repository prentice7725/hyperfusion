import {execFile} from 'node:child_process';
import {isWin} from './platform.mjs';

const command=(file,args)=>new Promise((resolve,reject)=>execFile(file,args,{encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:8*1024*1024},(e,out)=>e?reject(e):resolve(out)));

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
export function watchProcessTree({readTable=table}={}) {
 const tracked=new Map();let pid=null,timer=null,pending=Promise.resolve(),error=null;
 const observe=async()=>{
  try{const rows=await readTable();for(const p of descendants(rows,pid,tracked)){
   if(!Number.isSafeInteger(p.pid)||p.pid<1||typeof p.created!=='string'||!p.created)throw Error('Process identity unavailable');
   tracked.set(p.pid,p.created);
  }}
  catch(e){error=e.code??'PROCESS_TABLE_UNAVAILABLE';}
 };
 return {
  start(value){pid=value;pending=observe();timer=setInterval(()=>{pending=pending.then(observe);},1000);timer.unref();},
  async finish({exited,aborted=false}){
   clearInterval(timer);await pending;
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
