import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {read,immutable,repo} from './artifact.mjs';
import {assertLease} from './writer-lease.mjs';
import {result as validateResult} from './contracts.mjs';

export function parseEnvelope(envelope,request) {
 if(!envelope||envelope.type!=='result'||envelope.is_error===true||envelope.subtype!=='success')throw Error('Claude returned an unsuccessful result envelope');
 if(envelope.session_id!==request.cli.session_id)throw Error('Claude session provenance mismatch');
 if(envelope.permission_denials?.length)throw Error('Claude reported permission denials; inspect before recovery');
 return validateResult(envelope.structured_output,request.task_id,request.round);
}
export async function execute(root,{timeoutMs=600000,maxBytes=8*1024*1024}={}) {
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1)throw Error('Invalid timeout');
 root=repo(root);
 const state=read(path.join(root,'.fusion/state.json'));
 if(state.phase!=='EXECUTING'||state.active_sidekick!=='claude')throw Error('No active Claude round');
 const dir=path.join(root,'.fusion/tasks',state.task_id),n=state.iteration;
 const request=read(path.join(dir,`dispatch-${n}.json`));
 const lease=assertLease(root,request.token);
 if(lease.owner!=='claude'||lease.task_id!==state.task_id||lease.round!==n||request.task_id!==state.task_id||request.round!==n)throw Error('Claude writer provenance mismatch');
 // A create-once launch claim prevents duplicate processes, even on crash/replay.
 immutable(path.join(dir,`claude-launch-${n}.json`),{bridge_pid:process.pid,session_id:request.cli.session_id,at:new Date().toISOString()});
 let stdout='',stderr='',reason=null,child,killTimer,timer,forceResolve;
 const killGroup=signal=>{if(child?.pid)try{process.kill(-child.pid,signal);}catch(e){if(e.code!=='ESRCH')throw e;}};
 const stop=why=>{if(reason)return;reason=why;killGroup('SIGTERM');killTimer=setTimeout(()=>{killGroup('SIGKILL');child?.stdout.destroy();child?.stderr.destroy();child?.stdin.destroy();forceResolve?.({code:null,signal:'SUPERVISOR_ABORT'});},2000);};
 const onTerm=()=>stop('bridge interrupted');
 process.on('SIGTERM',onTerm);process.on('SIGINT',onTerm);
 let exit;
 try {
  exit=await new Promise(resolve=>{
   forceResolve=resolve;
   child=spawn(request.cli.executable,request.cli.args,{cwd:root,stdio:['pipe','pipe','pipe'],shell:false,detached:true});
   if(child.pid)immutable(path.join(dir,`claude-process-${n}.json`),{pid:child.pid,process_group:child.pid,session_id:request.cli.session_id});
   child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
   child.on('error',e=>{reason='Claude spawn failed: '+e.message;});
   child.stdin.on('error',e=>{if(e.code!=='EPIPE')stop('Claude stdin failed: '+e.message);});
   child.stdout.on('data',chunk=>{if(Buffer.byteLength(stdout)+Buffer.byteLength(chunk)>maxBytes)stop('Claude stdout limit exceeded');else stdout+=chunk.toString();});
   child.stderr.on('data',chunk=>{if(Buffer.byteLength(stderr)+Buffer.byteLength(chunk)>maxBytes)stop('Claude stderr limit exceeded');else stderr+=chunk.toString();});
   timer=setTimeout(()=>stop('Claude timeout'),timeoutMs);
   child.on('close',(code,signal)=>resolve({code,signal}));
   child.stdin.end(request.stdin);
  });
 } finally {
  clearTimeout(timer);clearTimeout(killTimer);process.off('SIGTERM',onTerm);process.off('SIGINT',onTerm);
  // Reap any surviving process-group children before handing control back.
  // Detached descendants outside this group still require lead quiescence checks.
  killGroup('SIGKILL');
 }
 immutable(path.join(dir,`claude-envelope-${n}.json`),{exit,reason,stdout,stderr});
 if(reason||exit.code!==0)throw Error(reason||'Claude exited with code '+exit.code);
 let envelope;
 try{envelope=JSON.parse(stdout);}catch{throw Error('Claude emitted invalid JSON');}
 const result=parseEnvelope(envelope,request);
 immutable(path.join(dir,`claude-usage-${n}.json`),{session_id:envelope.session_id,usage:envelope.usage??null,modelUsage:envelope.modelUsage??null,total_cost_usd:envelope.total_cost_usd??null,cost_basis:'Claude client-side estimate, not billed cost'});
 immutable(path.join(dir,`claude-result-${n}.json`),result);
 // The lead must inspect process artifacts and explicitly finish; never release here.
 return {status:'RESULT_READY',task_id:state.task_id,round:n,result_file:path.join(dir,`claude-result-${n}.json`),next_action:'confirm quiescence, then fusion-state finish with writer token and result'};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])) {
 try{console.log(JSON.stringify(await execute(process.argv[2]),null,2));}catch(e){console.error(e.message);process.exitCode=1;}
}
