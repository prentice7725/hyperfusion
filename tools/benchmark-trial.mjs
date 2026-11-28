// One benchmark trial: prepare → start window → headless Claude Code lead → stop window → score with hidden tests.
// This is the runner the large-suite repetitions used (references/benchmark-pilot.md). It calls real models and costs money.
//
//   node tools/benchmark-trial.mjs run HF-L01 hyperfusion --dir ../hf-bench/rep4/L01 --source .
//   node tools/benchmark-trial.mjs run HF-L01 baseline --dir ../hf-bench/solo3/L01 --source .
//   node tools/benchmark-trial.mjs suite --dir ../hf-bench/rep4 --source . [--cases HF-L01,HF-L03] [--arm hyperfusion]
//
// The lead uses the installed skill (~/.claude/skills/hyperfusion, or --skill / HF_BENCH_ROOT), so prepare/start/stop/score
// also run from there: the controller that records the window is the one the lead drives. Keep it on the commit under test.
// Each trial writes into <dir>/<case>-<hf|base>/ plus <name>.prepare.json, .prompt.txt, .claude.json and trial.log next to it.
// `suite` skips a case whose trial already recorded a metric, so a run cut off by a reboot can be started again as is.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {isMain} from '../scripts/platform.mjs';

const ARMS={hyperfusion:'hf',baseline:'base'};
const DEFAULT_TIMEOUT_MIN=180;

// Rules both arms get. The fixture's own AGENTS.md asks for full checks, which take hours serially on Windows
// (L01 run 1), so the prompt overrides it in both arms.
const ACCEPTANCE_ONLY='Verify with the acceptance command only. Do not run the full test suite (npm test or similar); CI covers it, and this rule overrides any repository instruction to run full checks.';

export function trialPrompt(arm,caseId,prepared,brief) {
 if(arm==='baseline')return `Complete this task yourself, alone. Do not use the HyperFusion skill, subagents, or any external AI CLI.

Task brief (JSON):
${JSON.stringify(brief,null,2)}

Edit only the paths in scope. Never modify the protected acceptance files (everything under tests/, run.mjs, acceptance-case.mjs, benchmark-fixture.json). Check your work with \`${prepared.acceptance_command}\` until it passes, then stop and report briefly. ${ACCEPTANCE_ONLY}`;
 return `Use the HyperFusion skill to complete this task in this repository.

The controller brief is already written at:
${prepared.brief_file}

Initialize with task ID ${caseId} using that brief file unchanged (fusion-state.mjs init <this repo> <brief file>), then follow the skill until the task reaches CLOSE or BLOCKED. Nobody is available to answer questions: make the lead decisions yourself. Never modify the protected acceptance files. When the task is CLOSE or BLOCKED, stop and report briefly. ${ACCEPTANCE_ONLY}`;
}

const skillRoot=given=>path.resolve(given??process.env.HF_BENCH_ROOT??path.join(os.homedir(),'.claude','skills','hyperfusion'));
const recorded=log=>fs.existsSync(log)&&/ recorded success /.test(fs.readFileSync(log,'utf8'));

export function trialPaths(dir,caseId,arm) {
 const name=`${caseId.slice(3)}-${ARMS[arm]}`,base=path.resolve(dir);
 return {dir:base,repo:path.join(base,name),prefix:path.join(base,name),log:path.join(base,'trial.log')};
}

export function runTrial({caseId,arm,dir,source,skill,timeoutMin=DEFAULT_TIMEOUT_MIN,model='claude-opus-5-5',claude='claude'}) {
 if(!/^HF-[BL]\d\d$/.test(caseId??''))throw Error('benchmark-trial: case must look like HF-L01 or HF-B01');
 if(!ARMS[arm])throw Error('benchmark-trial: arm must be hyperfusion or baseline');
 if(!dir)throw Error('benchmark-trial: --dir is required');
 const root=skillRoot(skill),bench=path.join(root,'scripts','benchmark.mjs');
 if(!fs.existsSync(bench))throw Error(`benchmark-trial: ${bench} not found; install the skill or pass --skill`);
 const p=trialPaths(dir,caseId,arm);fs.mkdirSync(p.dir,{recursive:true});
 const log=(...a)=>{const line=`[${new Date().toISOString()}] ${caseId} ${arm}: ${a.join(' ')}`;console.log(line);fs.appendFileSync(p.log,line+'\n');};
 const benchmark=(...args)=>{const r=spawnSync(process.execPath,[bench,...args],{encoding:'utf8',windowsHide:true,maxBuffer:64*1024*1024});return {ok:r.status===0,out:(r.stdout||'')+(r.stderr||'')};};
 const skillHead=spawnSync('git',['-C',root,'rev-parse','--short','HEAD'],{encoding:'utf8',windowsHide:true}).stdout?.trim()||'unknown';

 const prep=benchmark('prepare',caseId,p.repo,...(source?['--source',path.resolve(source)]:[]));
 if(!prep.ok){log('PREPARE FAILED:',prep.out.trim().slice(0,600));return {status:'prepare_failed',error:prep.out.trim()};}
 fs.writeFileSync(p.prefix+'.prepare.json',prep.out);
 const prepared=JSON.parse(prep.out),control=path.dirname(prepared.brief_file);
 const brief=JSON.parse(fs.readFileSync(prepared.brief_file,'utf8'));
 log('prepared',prepared.initial_tree,'baseline',prepared.baseline_status,'skill',skillHead);

 const session=crypto.randomUUID();
 const started=benchmark('start',caseId,p.repo,'--arm',arm,'--session',session);
 if(!started.ok){log('START FAILED:',started.out.trim().slice(0,600));return {status:'start_failed',error:started.out.trim()};}
 log('window started, session',session);

 const prompt=trialPrompt(arm,caseId,prepared,brief);
 fs.writeFileSync(p.prefix+'.prompt.txt',prompt);
 const t0=Date.now();
 const lead=spawnSync(claude,['-p','--model',model,'--session-id',session,'--permission-mode','bypassPermissions','--output-format','json',prompt],
  {cwd:p.repo,encoding:'utf8',windowsHide:true,shell:false,timeout:timeoutMin*60*1000,maxBuffer:64*1024*1024});
 fs.writeFileSync(p.prefix+'.claude.json',(lead.stdout||'')+(lead.stderr?'\n--- stderr\n'+lead.stderr:''));
 log('claude exited',lead.status,lead.error?.code??'','after',Math.round((Date.now()-t0)/1000)+'s');

 const projects=path.join(os.homedir(),'.claude','projects');
 const transcript=fs.existsSync(projects)?fs.readdirSync(projects).map(d=>path.join(projects,d,session+'.jsonl')).find(f=>fs.existsSync(f)):undefined;
 log('transcript',transcript??'NOT FOUND');

 let success=true;
 if(arm==='hyperfusion'){
  let phase=null;try{phase=JSON.parse(fs.readFileSync(path.join(control,'state.json'),'utf8')).phase;}catch{}
  log('controller phase',phase);
  // The window stays open: a later `benchmark.mjs stop` can still close it once the lead finishes by hand.
  if(phase!=='CLOSE'&&phase!=='BLOCKED'){log('UNFINISHED: window left open, no metric');return {status:'unfinished',phase,repo:p.repo};}
  success=phase==='CLOSE';
 }
 const sessionArgs=transcript?['--session',session,'--transcript',transcript]:[];
 let stopped=benchmark('stop',caseId,p.repo,success?'--success':'--failed',...sessionArgs);
 if(!stopped.ok&&arm==='baseline'&&/did not pass/.test(stopped.out)){log('baseline acceptance failed, recording --failed');stopped=benchmark('stop',caseId,p.repo,'--failed',...sessionArgs);}
 if(!stopped.ok){log('STOP FAILED:',stopped.out.trim().slice(0,600));return {status:'stop_failed',error:stopped.out.trim()};}
 const metric=JSON.parse(fs.readFileSync(path.join(control,'metrics',caseId+'.json'),'utf8'));
 log('recorded success',metric.success,'lead_tokens',metric.lead_usage?.lead_tokens??'unknown','claude_total',metric.claude_total_tokens??'unknown');

 // Hidden tests only exist for the large suite.
 if(/^HF-L/.test(caseId)){
  const score=benchmark('score',caseId,p.repo,'--record');
  fs.writeFileSync(p.prefix+'.score.json',score.out);
  log(score.ok?'scored':'SCORE FAILED:',score.ok?'':score.out.trim().slice(0,400));
 }
 return {status:'recorded',success:metric.success,repo:p.repo};
}

export function runSuite({dir,cases,arm='hyperfusion',...rest}) {
 const out=[];
 for(const caseId of cases){
  const caseDir=path.join(path.resolve(dir),caseId.slice(3));
  if(recorded(trialPaths(caseDir,caseId,arm).log)){console.log(`${caseId} ${arm}: already recorded, skipped`);out.push({case_id:caseId,status:'skipped'});continue;}
  // A cut-off trial keeps its folder and control dir; the next attempt goes to a fresh path beside it.
  let target=caseDir;
  for(let i=2;fs.existsSync(trialPaths(target,caseId,arm).repo);i++)target=`${caseDir}-attempt${i}`;
  out.push({case_id:caseId,...runTrial({caseId,arm,dir:target,...rest})});
 }
 return out;
}

function parseArgs(argv) {
 const flags={},positional=[];
 for(let i=0;i<argv.length;i++){
  if(argv[i].startsWith('--')){const key=argv[i].slice(2);flags[key]=argv[i+1]?.startsWith('--')||argv[i+1]===undefined?true:argv[++i];}
  else positional.push(argv[i]);
 }
 return {flags,positional};
}

if(isMain(import.meta.url)){
 const [cmd,...rest]=process.argv.slice(2);
 const {flags,positional}=parseArgs(rest);
 const common={dir:flags.dir,source:flags.source,skill:flags.skill,timeoutMin:flags['timeout-min']?Number(flags['timeout-min']):undefined,model:flags.model};
 for(const k of Object.keys(common))if(common[k]===undefined)delete common[k];
 if(cmd==='run'&&positional.length===2){
  const r=runTrial({caseId:positional[0],arm:positional[1],...common});
  process.exitCode=r.status==='recorded'?0:1;
 }else if(cmd==='suite'){
  const cases=typeof flags.cases==='string'?flags.cases.split(','):['HF-L01','HF-L02','HF-L03','HF-L04','HF-L05'];
  const results=runSuite({cases,arm:typeof flags.arm==='string'?flags.arm:'hyperfusion',...common});
  console.log(JSON.stringify(results,null,2));
  process.exitCode=results.every(r=>['recorded','skipped'].includes(r.status))?0:1;
 }else{
  console.error('Usage: benchmark-trial.mjs run CASE hyperfusion|baseline --dir DIR [--source CLONE] [--skill DIR] [--timeout-min 180] [--model ID]\n       benchmark-trial.mjs suite --dir DIR [--cases HF-L01,...] [--arm hyperfusion|baseline] [--source CLONE] [--skill DIR]');
  process.exitCode=2;
 }
}
