import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
const sleep=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
const holderOf=file=>{try{const h=JSON.parse(fs.readFileSync(file,'utf8'));return h&&Number.isInteger(h.pid)&&h.pid>0&&typeof h.host==='string'?h:null;}catch{return null;}};

// Short metadata locks only. Writer leases are never reclaimed by this helper.
export function acquireLock(file,{timeoutMs=500,retryMs=25}={}) {
 const deadline=Date.now()+timeoutMs,token=crypto.randomUUID();
 for(;;){
  try{
   try{if(fs.lstatSync(file).isSymbolicLink())throw Error('Symlink lock forbidden: '+file);}catch(e){if(e.code!=='ENOENT')throw e;}
   const fd=fs.openSync(file,'wx',0o600);
   try{fs.writeSync(fd,JSON.stringify({pid:process.pid,host:os.hostname(),at:new Date().toISOString(),token}));}finally{fs.closeSync(fd);}
   return ()=>{if(holderOf(file)?.token===token)fs.unlinkSync(file);};
  }catch(e){
   if(e.code!=='EEXIST')throw e;
   const holder=holderOf(file);
   if(holder&&holder.host===os.hostname()&&!alive(holder.pid)){
    const grave=`${file}.stale-${token}`;
    try{
     fs.renameSync(file,grave);
     const taken=holderOf(grave);
     if(taken&&taken.pid===holder.pid&&taken.at===holder.at&&taken.token===holder.token){fs.rmSync(grave,{force:true});continue;}
     try{fs.linkSync(grave,file);}catch{}
     fs.rmSync(grave,{force:true});
    }catch{if(Date.now()<deadline)continue;}
   }
   if(Date.now()<deadline){sleep(Math.min(retryMs,Math.max(1,deadline-Date.now())));continue;}
   const who=holder?`by pid ${holder.pid} on ${holder.host} since ${holder.at}`:'by an unknown owner';
   const error=Error(`EEXIST: ${path.basename(file)} is held ${who}; retry or inspect references/recovery-protocol.md`);
   error.code='LOCK_BUSY';throw error;
  }
 }
}
