import fs from 'node:fs';
import path from 'node:path';
import {hash,read,atomic,git,snapshot} from './artifact.mjs';
import {controlPath,ensureControl,acquireLock} from './control-dir.mjs';
import {collectHostUsage} from './lead-usage.mjs';
import {summarizeUsage,collectRunUsage} from './usage-accounting.mjs';
import {runCommands} from './acceptance.mjs';
import {weightedUsage} from './usage-weights.mjs';

const optional=f=>fs.existsSync(f)?read(f):null;
function assertProtected(root,window) {
 for(const [name,digest] of Object.entries(window.benchmark.protected_files??{})){
  const file=path.join(root,name);
  if(!fs.existsSync(file)||fs.lstatSync(file).isSymbolicLink()||hash(fs.readFileSync(file))!==digest)throw Error('BENCHMARK: protected acceptance fixture changed: '+name);
 }
}
export function startWindow(caseId,root,{arm='baseline',sessionId}={}) {
 if(!['baseline','hyperfusion'].includes(arm))throw Error('BENCHMARK: arm must be baseline or hyperfusion');
 ensureControl(root);const unlock=acquireLock(controlPath(root,'locks/control.lock'));
 try{
  if(fs.existsSync(controlPath(root,'locks/acceptance.json')))throw Error('BENCHMARK: acceptance recovery required');
  if(fs.existsSync(controlPath(root,'locks/writer.json')))throw Error('BENCHMARK: writer active');
  const state=optional(controlPath(root,'state.json'));
  if(state&&!['CLOSE','BLOCKED','ARCHIVED'].includes(state.phase))throw Error('BENCHMARK: finish the active task first');
  const manifest=read(controlPath(root,'benchmark-fixture.json'));
  if(manifest.case_id!==caseId)throw Error('BENCHMARK: fixture case mismatch');
  const tree=git(root,['rev-parse','HEAD^{tree}']).trim();
  if(tree!==manifest.initial_tree||git(root,['status','--porcelain']).trim())throw Error('BENCHMARK: start from the clean canonical fixture tree');
  const context=optional(controlPath(root,'host-session.json'));
  const session=sessionId?hash(sessionId):context?.session;
  if(!session)throw Error('BENCHMARK: provide --session or bind the host through the usage hook');
  const file=controlPath(root,'tasks',caseId,'host-usage-window.json');
  if(fs.existsSync(file))throw Error('BENCHMARK: this case already has a window; prepare a fresh fixture');
  const now=new Date().toISOString();
  const window={task_id:caseId,session,sessions:[session],started_at:now,controller_started_at:now,ended_at:null,
   scope:'benchmark-window',benchmark:{case_id:caseId,arm,initial_tree:tree,fixture_id:manifest.fixture_id,acceptance_command:manifest.acceptance_command,protected_files:manifest.protected_files}};
  atomic(file,window);return window;
 }finally{unlock();}
}
export function stopWindow(caseId,root,{success,sessionId,transcriptPath}={}) {
 if(typeof success!=='boolean')throw Error('BENCHMARK: --success or --failed required');
 ensureControl(root);const unlock=acquireLock(controlPath(root,'locks/control.lock'));
 try{
  if(fs.existsSync(controlPath(root,'locks/acceptance.json')))throw Error('BENCHMARK: acceptance recovery required');
  if(fs.existsSync(controlPath(root,'locks/writer.json')))throw Error('BENCHMARK: worker must stop before ending the window');
  const file=controlPath(root,'tasks',caseId,'host-usage-window.json'),window=read(file);
  if(!window.benchmark)throw Error('BENCHMARK: no benchmark window');
  if(window.ended_at)throw Error('BENCHMARK: window already stopped');
  assertProtected(root,window);
  const state=optional(controlPath(root,'state.json'));
  if(window.benchmark.arm==='hyperfusion'&&(!state||state.task_id!==caseId||!['CLOSE','BLOCKED'].includes(state.phase)||success!==(state.phase==='CLOSE')))throw Error('BENCHMARK: HyperFusion result must match CLOSE/BLOCKED for this case');
  if(window.benchmark.arm==='hyperfusion'&&success){
   const evidence=state.acceptance?.file?optional(controlPath(root,'tasks',caseId,state.acceptance.file)):null;
   if(state.acceptance?.status!=='pass'||state.acceptance?.quiescent!==true||!evidence?.results?.some(r=>r.command===window.benchmark.acceptance_command&&r.status==='pass'&&r.quiescence?.quiescent))throw Error('BENCHMARK: canonical controller acceptance evidence is missing');
   const digest=snapshot(root).digest;
   if(state.post_digest!==digest||state.acceptance.tree_digest!==digest)throw Error('BENCHMARK: tree drift after canonical acceptance');
  }
  let acceptance=null;
  if(window.benchmark.arm==='baseline'&&success){
   acceptance=runCommands(root,[window.benchmark.acceptance_command],{timeout_ms:120000});
   atomic(controlPath(root,'tasks',caseId,'benchmark-acceptance.json'),acceptance);
   if(acceptance.some(r=>!r.quiescence?.quiescent)){
    atomic(controlPath(root,'locks/acceptance.json'),{task_id:caseId,source:'benchmark',results:acceptance});
    throw Error('BENCHMARK: acceptance process shutdown unknown; confirm quiescence before recovery');
   }
   if(acceptance.some(r=>r.status!=='pass'))throw Error('BENCHMARK: baseline acceptance did not pass; record --failed');
   assertProtected(root,window);
  }
  const ended_at=new Date().toISOString();atomic(file,{...window,ended_at});
  const runs=window.benchmark.arm==='hyperfusion'?collectRunUsage(root,state):[];
  const metric={task_id:caseId,...window.benchmark,success,started_at:window.started_at,ended_at,run_usage:runs,
   lead_usage:null,acceptance,lead_takeovers:state?.attempts?.lead??0};
  atomic(controlPath(root,'metrics',caseId+'.json'),metric);
  if(sessionId&&transcriptPath)collectHostUsage(root,{hook_event_name:'Stop',session_id:sessionId,transcript_path:transcriptPath});
  const observation=optional(controlPath(root,'tasks',caseId,'lead-usage.json'));
  if(observation?.complete===true){
   const accounting=summarizeUsage(runs,observation,observation.lead_model);
   Object.assign(metric,{lead_weighted_usage:weightedUsage(observation),lead_usage:observation,claude_usage:accounting.claude,claude_total_tokens:accounting.claude_total_tokens});
   atomic(controlPath(root,'metrics',caseId+'.json'),metric);
  }
  return {...metric,note:'Baseline success requires controller acceptance. Final host Stop can refresh usage after the closing summary.'};
 }finally{unlock();}
}
export function recoverWindow(caseId,root,{quiescent=false,reason}={}) {
 if(quiescent!==true||typeof reason!=='string'||!reason.trim())throw Error('BENCHMARK: recovery requires explicit --quiescent and --reason after confirming process shutdown');
 const unlock=acquireLock(controlPath(root,'locks/control.lock'));
 try{
  const file=controlPath(root,'locks/acceptance.json'),lock=read(file);
  if(lock.source!=='benchmark'||lock.task_id!==caseId||fs.existsSync(controlPath(root,'locks/writer.json')))throw Error('BENCHMARK: unrelated lock or active writer; use controller recovery');
  const recovered_at=new Date().toISOString();
  atomic(controlPath(root,'tasks',caseId,'benchmark-recovery-'+Date.now()+'.json'),{lock,reason,recovered_at,quiescence_basis:'explicit operator confirmation'});
  fs.unlinkSync(file);return {case_id:caseId,recovered_at,next:'Repeat stop explicitly; no automatic execution'};
 }finally{unlock();}
}
