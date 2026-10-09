import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {execute} from '../scripts/executor-bridge.mjs';
import {brief,safePath} from '../scripts/contracts.mjs';
import {read} from '../scripts/artifact.mjs';
import {config} from '../scripts/executor-config.mjs';
import {adapter} from '../scripts/adapters/index.mjs';
import {hasOption} from '../scripts/adapters/common.mjs';
import {ACTION_PHASES,PHASES,TERMINAL_PHASES,assertAction,phaseTable} from '../scripts/state-policy.mjs';
import {aggregateRepo,measure} from '../scripts/metrics.mjs';
import {route,history} from '../scripts/router.mjs';
import {acquireLock} from '../scripts/lock.mjs';
import {budgetStatus} from '../scripts/budgets.mjs';
import {createWorktree,listWorktrees,removeWorktree} from '../scripts/worktree.mjs';
import {controlPath} from '../scripts/control-dir.mjs';
import {errorRecord} from '../scripts/cli.mjs';

const cli=file=>fileURLToPath(new URL('../scripts/'+file,import.meta.url));
const configure=(f,value)=>fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify(value));
const lean=f=>{const {forbidden_actions,evidence_required,...rest}=f.brief;return {...rest,scope:{paths:f.brief.scope.paths}};};

test('omitted brief constants are materialized without relaxing explicit restrictions',t=>{
 const f=fixture(t,{initialize:false}),input=lean(f),normalized=brief(input);
 assert.equal(normalized.scope.allowed_expansion,'ask-lead');assert.ok(normalized.forbidden_actions.includes('push'));
 assert.equal(input.forbidden_actions,undefined);
 assert.throws(()=>brief({...input,forbidden_actions:[]}),/forbidden/);
 run(f.root,'init',input);run(f.root,'begin',input);
 assert.ok(read(controlPath(f.root,'tasks',input.task_id,'brief-1.json')).evidence_required.includes('files_changed'));
});

test('finish reads bridge results with provenance checks and still requires quiescence and token',async t=>{
 const f=fixture(t);f.begin();await execute(f.root);
 assert.throws(()=>run(f.root,'finish',{token:'wrong',quiescent:true}),/token/);
 assert.throws(()=>run(f.root,'finish',{token:f.state().writer.token}),/stopped/);
 assert.equal(run(f.root,'finish',{token:f.state().writer.token,quiescent:true}).phase,'REVIEW');
});

test('a saved result for a different round cannot pass finish',t=>{
 const f=fixture(t);f.begin();
 fs.writeFileSync(controlPath(f.root,'tasks',f.brief.task_id,'result-1.json'),JSON.stringify({...f.result(),round:2}));
 const s=run(f.root,'finish',{token:f.state().writer.token,quiescent:true});
 assert.equal(s.phase,'RECOVERY_REQUIRED');assert.match(s.last_errors.join(),/provenance/);
});

test('controller accepts stdin, emits compact status, and produces JSON errors',t=>{
 const f=fixture(t,{initialize:false});
 const call=(args,input)=>spawnSync(process.execPath,[cli('fusion-state.mjs'),...args],{input,encoding:'utf8'});
 const init=call(['init',f.root,'-'],JSON.stringify(lean(f)));assert.equal(init.status,0,init.stderr);
 const status=call(['status',f.root,'--summary']);assert.equal(status.status,0,status.stderr);
 assert.deepEqual(Object.keys(JSON.parse(status.stdout)).sort(),['task_id','phase','owner','remaining','next_action'].sort());
 const error=call(['review',f.root,'-'],'{}');assert.equal(error.status,1);
 assert.equal(JSON.parse(error.stderr).code,'INVALID_PHASE');
 assert.equal(errorRecord(Error('plain error')).code,'OPERATION_FAILED');
});

test('the phase matrix rejects every invalid action-phase pair and generates documentation',()=>{
 for(const phase of PHASES)for(const [action,allowed] of Object.entries(ACTION_PHASES)){
  if(allowed.includes(phase))assert.doesNotThrow(()=>assertAction(phase,action));
  else assert.throws(()=>assertAction(phase,action),e=>e.code==='INVALID_PHASE');
 }
 for(const phase of TERMINAL_PHASES)assert.throws(()=>assertAction(phase,'begin'));
 assert.throws(()=>assertAction('PLAN','consult',{mode:'review'}));
 assert.ok(fs.readFileSync(new URL('../references/state-actions.md',import.meta.url),'utf8').replaceAll('\r\n','\n').includes(phaseTable()));
});

test('option matching does not mistake --resume-last for --resume',()=>{
 assert.equal(hasOption('  --resume-last <id>','--resume'),false);
 for(const help of ['  --resume <id>','[--resume=ID]','--resume, -r'])assert.equal(hasOption(help,'--resume'),true);
 assert.equal(hasOption('--output-formatting','--output-format'),false);
});

test('Sonnet model overrides are dispatched and new Opus IDs are accepted',t=>{
 const f=fixture(t,{initialize:false});configure(f,{lead_model:'claude-opus-next',executors:{sonnet:{model:'claude-sonnet-next'}}});
 run(f.root,'init',{...f.brief,executor:'sonnet'});const d=f.begin();
 assert.equal(d.cli.model,'claude-sonnet-next');assert.equal(d.cli.args[d.cli.args.indexOf('--model')+1],'claude-sonnet-next');
 assert.equal(f.state().lead_target_model,'claude-opus-next');
});

test('Grok and Antigravity refuse model overrides without exact CLI support',t=>{
 fixture(t,{initialize:false});
 for(const name of ['grok','antigravity'])assert.throws(()=>adapter(name).probe({model:'custom-model'}),/missing.*--model/);
});

for(const executor of ['grok','antigravity'])test(`${executor} dispatches a configured model when the CLI advertises --model`,t=>{
 const f=fixture(t,{initialize:false}),binary=executor==='grok'?process.env.HF_GROK_BIN:process.env.HF_AGY_BIN;
 const source=fs.readFileSync(binary,'utf8').replace("const args=process.argv.slice(2);","const args=process.argv.slice(2);if(args.includes('--help'))console.log('--model <id>');");
 fs.writeFileSync(binary,source,{mode:0o755});configure(f,{executors:{[executor]:{model:'custom-model'}}});
 run(f.root,'init',{...f.brief,executor});const d=f.begin();assert.equal(d.cli.args[d.cli.args.indexOf('--model')+1],'custom-model');
});

test('doctor saves full help output without adding it to dispatch descriptors',t=>{
 const f=fixture(t),out=spawnSync(process.execPath,[cli('setup-doctor.mjs'),f.root],{encoding:'utf8'});
 assert.equal(out.status,0,out.stderr);const result=JSON.parse(out.stdout);
 const evidence=read(result.probe_file);assert.match(evidence.probes.grok.help,/--prompt-file/);
 assert.equal(f.begin().cli.help,undefined);
});

test('timeline reports round verdict, measured duration and reported cost',async t=>{
 const f=fixture(t);f.begin();await f.bridge();f.review('pass');
 const report=run(f.root,'report');assert.equal(report.rounds.length,1);
 assert.equal(report.rounds[0].verdict,'pass');assert.equal(report.rounds[0].cost_usd,0.002);assert.ok(report.rounds[0].wall_ms>=0);
 measure(f.root);assert.equal(aggregateRepo(f.root).tasks,1);
 const out=spawnSync(process.execPath,[cli('metrics.mjs'),'--aggregate',f.root],{encoding:'utf8'});
 assert.equal(out.status,0,out.stderr);assert.equal(JSON.parse(out.stdout).tasks,1);
});

test('routing separates difficulty, decays old failures, and lets demoted workers lead again',t=>{
 const f=fixture(t,{initialize:false}),dir=controlPath(f.root,'metrics');fs.mkdirSync(dir,{recursive:true});
 const write=(id,difficulty,ended_at)=>fs.writeFileSync(path.join(dir,id+'.json'),JSON.stringify({task_kind:'code',difficulty,ended_at,initial_executor:'sonnet',review_outcomes:[{owner:'sonnet',verdict:'redo'}]}));
 for(let i=0;i<3;i++)write('old'+i,'high','2020-01-01T00:00:00Z');
 // 이 테스트는 감쇠와 재탐색만 본다(신입 우대는 따로 테스트한다).
 const c=config(f.root);c.routing.newcomer_every=0;assert.equal(route(f.root,c,{task_kind:'code',difficulty:'high'},{probe:false}).executor,'sonnet');
 for(let i=0;i<3;i++)write('new'+i,'low',new Date().toISOString());
 assert.equal(history(f.root,'code',{difficulty:'high'}).sonnet.tasks,3);
 assert.equal(route(f.root,c,{task_kind:'code',difficulty:'high'},{probe:false}).executor,'sonnet');
 for(let i=0;i<9;i++)write('hard'+i,'high',new Date().toISOString());
 c.routing.explore_every=13;
 const exploratory=route(f.root,c,{task_kind:'code',difficulty:'high'},{probe:false});
 assert.equal(exploratory.executor,'sonnet');assert.match(exploratory.reason,/exploration/);
 c.routing.explore_every=0;assert.equal(route(f.root,c,{task_kind:'code',difficulty:'high'},{probe:false}).executor,'grok');
});

test('routing score rewards fewer rounds and discounts inherited failed tasks',t=>{
 const f=fixture(t,{initialize:false}),dir=controlPath(f.root,'metrics');fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,'sample.json'),JSON.stringify({task_kind:'code',difficulty:'high',review_outcomes:[{owner:'sonnet',verdict:'redo'},{owner:'sonnet',verdict:'pass'},{owner:'grok',verdict:'pass'}]}));
 const h=history(f.root,'code',{difficulty:'high'});assert.equal(h.sonnet.weighted_score,0.5);assert.equal(h.grok.weighted_tasks,0.5);
});

test('metadata locks retry short contention and recover only proven dead local owners',async t=>{
 const f=fixture(t,{initialize:false}),lock=path.join(f.temp,'shared.lock'),ready=path.join(f.temp,'ready');
 const script=`const fs=require('fs');fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,host:require('os').hostname(),at:new Date().toISOString()}));fs.writeFileSync(process.argv[2],'ready');setTimeout(()=>fs.unlinkSync(process.argv[1]),150);`;
 const child=spawn(process.execPath,['-e',script,lock,ready],{stdio:'ignore',windowsHide:true});
 const exited=new Promise(resolve=>child.on('exit',resolve));
 const deadline=Date.now()+3000;while(!fs.existsSync(ready)&&Date.now()<deadline)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
 assert.ok(fs.existsSync(ready));const release=acquireLock(lock,{timeoutMs:1000});release();await exited;
 fs.writeFileSync(lock,JSON.stringify({pid:2147483646,host:os.hostname(),at:'2020-01-01'}));acquireLock(lock)();
 const held=acquireLock(lock);assert.throws(()=>acquireLock(lock,{timeoutMs:10}),e=>e.code==='LOCK_BUSY');held();
});

test('task wall and cost limits block new launches and preserve unknown cost',t=>{
 const f=fixture(t,{initialize:false});configure(f,{limits:{max_wall_ms:10,max_cost_usd:0.01}});run(f.root,'init',f.brief);
 const state=f.state();state.started_at=new Date(Date.now()-100).toISOString();fs.writeFileSync(controlPath(f.root,'state.json'),JSON.stringify(state));
 assert.throws(()=>f.begin(),/BUDGET_EXCEEDED/);assert.equal(f.state().phase,'BLOCKED');assert.equal(f.state().iteration,0);
 assert.ok(fs.existsSync(controlPath(f.root,'metrics',f.brief.task_id+'.json')));
 state.limits={max_cost_usd:0.01};
 fs.writeFileSync(controlPath(f.root,'tasks',f.brief.task_id,'usage-1.json'),JSON.stringify({total_cost_usd:0.02}));
 fs.writeFileSync(controlPath(f.root,'tasks',f.brief.task_id,'usage-2.json'),JSON.stringify({total_cost_usd:null}));
 const budget=budgetStatus(f.root,state);assert.equal(budget.reason,'max_cost_usd');assert.equal(budget.cost_complete,false);
 fs.unlinkSync(controlPath(f.root,'tasks',f.brief.task_id,'usage-2.json'));
 fs.writeFileSync(controlPath(f.root,'tasks',f.brief.task_id,'launch-3.json'),'{}');
 assert.equal(budgetStatus(f.root,state).cost_complete,false,'a launched call without usage is unmeasured');
});

test('wall deadline also bounds an already launched bridge process',async t=>{
 const f=fixture(t,{initialize:false});configure(f,{limits:{max_wall_ms:5000}});run(f.root,'init',{...f.brief,executor:'grok'});f.begin();f.mode('hang');
 const state=f.state();state.started_at=new Date(Date.now()-4000).toISOString();fs.writeFileSync(controlPath(f.root,'state.json'),JSON.stringify(state));
 await assert.rejects(()=>execute(f.root),/timeout|BUDGET_EXCEEDED/);
 assert.ok(f.state().writer);
});

test('isolated worktrees can execute two tasks concurrently with separate state and leases',async t=>{
 const f=fixture(t,{initialize:false});
 const a=createWorktree(f.root,'parallel-A'),b=createWorktree(f.root,'parallel-B');
 assert.notEqual(controlPath(a.workspace,'state.json'),controlPath(b.workspace,'state.json'));
 for(const item of [a,b]){const input={...f.brief,task_id:item.task_id,executor:'grok'};run(item.workspace,'init',input);run(item.workspace,'begin',input);}
 await Promise.all([execute(a.workspace),execute(b.workspace)]);
 for(const item of [a,b]){
  const state=read(controlPath(item.workspace,'state.json'));
  run(item.workspace,'finish',{token:state.writer.token,quiescent:true});
  run(item.workspace,'review',{verdict:'pass',rationale:'Inspected unchanged tree',blocking_criteria:[],commands_run:[],independent_diff_review:true});
  run(item.workspace,'verify',{acceptance_satisfied:true,tests:[{command:'protocol check',status:'pass'}]});
 }
 assert.deepEqual(listWorktrees(f.root).map(x=>x.phase),['CLOSE','CLOSE']);
 assert.throws(()=>removeWorktree(f.root,a.task_id),/quiescent/);
 fs.writeFileSync(path.join(a.workspace,'untracked.txt'),'preserve');
 assert.throws(()=>removeWorktree(f.root,a.task_id,{quiescent:true}));
 assert.ok(fs.existsSync(path.join(a.workspace,'untracked.txt')));
 fs.unlinkSync(path.join(a.workspace,'untracked.txt'));
 removeWorktree(f.root,a.task_id,{quiescent:true});removeWorktree(f.root,b.task_id,{quiescent:true});
 assert.deepEqual(listWorktrees(f.root),[]);
});

test('safePath rejects Windows device aliases and traversal boundaries',()=>{
 for(const value of ['', '/', 'src/', 'src//x','src/../x','.git/x','.GIT./x','GIT~1/x','src:x','C:/x','~x','a\nb','a\\b','a.','a ','CON','src/NUL.txt','COM1','LPT1.log'])assert.equal(safePath(value),false,value);
 for(const value of ['src/parser.mjs','src/my file.mjs','한글/코드.mjs'])assert.equal(safePath(value),true,value);
});
