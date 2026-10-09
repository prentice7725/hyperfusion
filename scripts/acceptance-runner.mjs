import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {hash} from './artifact.mjs';
import {isMain,isWin,killTree} from './platform.mjs';
import {processTable,watchProcessTree} from './process-proof.mjs';

const MAX_OUTPUT=64*1024*1024;
const empty=(command,code)=>({command,status:'not_run',code,exit_code:null,signal:null,timed_out:false,
 error:null,duration_ms:0,output_sha256:hash(''),output_bytes:0,output_tail:'',quiescence:{quiescent:true,reason:'Command not started'}});

async function execute(root,command,timeout_ms,deadline_ms,readTable) {
 const started=Date.now();let baseline;
 try{baseline=await readTable();}
 catch{return {...empty(command,'PROCESS_TABLE_UNAVAILABLE'),error:'Process inventory unavailable; command not started'};}
 const remaining=deadline_ms===null?Infinity:deadline_ms-Date.now();
 if(remaining<=0)return empty(command,'BUDGET_EXCEEDED');
 const timeout=Math.min(timeout_ms,remaining,2147483647);
 const monitor=watchProcessTree({baseline,readTable});
 const chunks=[];let bytes=0,timed_out=false,overflow=false,error=null,timer,forceTimer,alive=false;
 const child=spawn(command,{cwd:root,shell:true,env:process.env,windowsHide:true,detached:!isWin,stdio:['ignore','pipe','pipe']});
 const stop=()=>{
  killTree(child,{force:true,alive});
  forceTimer=setTimeout(()=>killTree(child,{force:true,alive}),250);
 };
 const capture=chunk=>{
  bytes+=chunk.length;
  if(bytes<=MAX_OUTPUT)chunks.push(chunk);
  else if(!overflow){overflow=true;stop();}
 };
 child.stdout.on('data',capture);child.stderr.on('data',capture);
 const outcome=await new Promise(resolve=>{
  child.once('spawn',()=>{alive=true;monitor.start(child.pid);timer=setTimeout(()=>{timed_out=true;stop();},timeout);});
  child.once('error',e=>{error=e.message;resolve({exit_code:null,signal:null,exited:!child.pid});});
  child.once('exit',(exit_code,signal)=>{alive=false;resolve({exit_code,signal,exited:true});});
 });
 clearTimeout(timer);clearTimeout(forceTimer);
 if(timed_out||overflow)killTree(child,{force:true,alive});
 const quiescence=child.pid?await monitor.finish({exited:outcome.exited}):{quiescent:true,reason:'Command not started'};
 // A lingering child can hold these pipes open. Exit plus tree evidence determines
 // completion; a close event alone would wait indefinitely on inherited handles.
 child.stdout.destroy();child.stderr.destroy();
 const out=Buffer.concat(chunks),text=out.toString('utf8');
 const budget_exceeded=deadline_ms!==null&&Date.now()>=deadline_ms;
 const code=!quiescence.quiescent?'ACCEPTANCE_NOT_QUIESCENT':budget_exceeded?'BUDGET_EXCEEDED':overflow?'OUTPUT_LIMIT':null;
 return {command,exit_code:outcome.exit_code,signal:outcome.signal,timed_out,error,code,quiescence,
  status:outcome.exit_code===0&&!error&&!timed_out&&!overflow&&!code?'pass':'fail',duration_ms:Date.now()-started,
  output_sha256:hash(out),output_bytes:bytes,output_tail:text.slice(-4000)};
}

export async function supervisedCommands(root,commands,{timeout_ms=600000,deadline_ms=null,readTable=processTable}={}) {
 const results=[];let stopped=null;
 for(const command of commands){
  if(!stopped&&deadline_ms!==null&&Date.now()>=deadline_ms)stopped='BUDGET_EXCEEDED';
  const result=stopped?empty(command,stopped):await execute(root,command,timeout_ms,deadline_ms,readTable);
  results.push(result);
  if(!result.quiescence.quiescent)stopped='ACCEPTANCE_NOT_QUIESCENT';
  else if(result.code==='BUDGET_EXCEEDED')stopped='BUDGET_EXCEEDED';
  else if(result.status==='not_run'||result.code==='PROCESS_TABLE_UNAVAILABLE'||result.code==='PROCESS_TABLE_TIMEOUT')stopped=result.code;
 }
 return results;
}

if(isMain(import.meta.url)){
 try{
  const {root,commands,options}=JSON.parse(fs.readFileSync(0,'utf8'));
  console.log(JSON.stringify(await supervisedCommands(root,commands,options)));
 }catch(e){console.error(e.message);process.exitCode=1;}
}
