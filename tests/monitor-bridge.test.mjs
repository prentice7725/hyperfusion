import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {execute,consult} from '../scripts/executor-bridge.mjs';
import {read} from '../scripts/artifact.mjs';

const cli=fileURLToPath(new URL('../scripts/fusion-state.mjs',import.meta.url));

const monitors=f=>fs.readdirSync(path.join(f.control,'tasks',f.brief.task_id)).filter(name=>/^monitor-.+\.json$/.test(name)).sort();
const readMon=f=>monitors(f).map(name=>read(path.join(f.control,'tasks',f.brief.task_id,name)));

test('status --summary stays free of monitor fields',t=>{
 const f=fixture(t);
 const summary=run(f.root,'status',{summary:true});
 assert.deepEqual(Object.keys(summary).sort(),['next_action','owner','phase','remaining','task_id']);
 assert.equal(Object.hasOwn(summary,'monitors'),false);
 assert.equal(Object.hasOwn(summary,'state'),false);
});

for(const executor of ['grok','antigravity','luna','haiku','sonnet']){
 test(`${executor} implementation is observed without closing the task`,async t=>{
  const f=fixture(t,{executor});
  f.begin();
  const out=await execute(f.root);
  assert.equal(out.status,'RESULT_READY');
  assert.equal(f.state().phase,'EXECUTING');
  assert.ok(f.state().writer);
  const found=readMon(f);
  assert.equal(found.length,1);
  assert.equal(found[0].executor,executor);
  assert.equal(found[0].role,'implement');
  assert.equal(found[0].state,'EXITED');
  assert.equal(found[0].declares_success,false);
  assert.equal(found[0].task_phase,null);
  assert.equal(found[0].observed_tool_calls,null);
  assert.equal(found[0].telemetry_limited,true);
  assert.equal(found[0].cli_stream_assumed,false);
  const activity=fs.readFileSync(path.join(f.control,'tasks',f.brief.task_id,'activity-1.ndjson'),'utf8');
  assert.match(activity,/"kind":"process_started"/);
  assert.match(activity,/"kind":"process_exited"/);
  assert.equal(activity.includes('"kind":"CLOSE"'),false);
  const view=run(f.root,'status',{monitor:true});
  assert.equal(view.declares_success,false);
  assert.equal(view.monitors.length,1);
  assert.equal(view.monitors[0].run_id,found[0].run_id);
 });
}

test('a non-zero exit is ERROR and still not CLOSE, and the writer lease stays',async t=>{
 const f=fixture(t);
 f.begin();f.mode('nonzero');
 await assert.rejects(()=>execute(f.root),/exited with code/);
 assert.equal(f.state().phase,'EXECUTING');
 assert.ok(f.state().writer);
 const mon=readMon(f)[0];
 assert.equal(mon.state,'ERROR');
 assert.equal(mon.declares_success,false);
});

test('timeout is observed as ERROR without releasing the writer',async t=>{
 const f=fixture(t);
 f.begin();f.mode('hang');
 await assert.rejects(()=>execute(f.root,{timeoutMs:150}),/timeout/);
 assert.equal(f.state().phase,'EXECUTING');
 assert.ok(f.state().writer);
 const mon=readMon(f)[0];
 assert.equal(mon.state,'ERROR');
 assert.equal(mon.alert_class,'attention');
 const activity=fs.readFileSync(path.join(f.control,'tasks',f.brief.task_id,'activity-1.ndjson'),'utf8');
 assert.match(activity,/"kind":"timeout"/);
});

test('Sol and Sonnet reviews share the same supervisor and stay read-only',async t=>{
 const f=fixture(t,{initialize:false});
 fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({review:{by:'delegate',reviewers:['sol','sonnet'],auto_apply:false}}));
 run(f.root,'init',{...f.brief,executor:'grok'});
 f.begin();f.finish();
 const beforeHead=String(f.git('rev-parse','HEAD'));
 const beforeStatus=String(f.git('status','--porcelain'));
 const sol=run(f.root,'delegate-review',{executors:['sol']});
 await consult(f.root,sol.consult_id);
 run(f.root,'consult-finish',{quiescent:true});
 const sonnet=run(f.root,'delegate-review',{executors:['sonnet']});
 await consult(f.root,sonnet.consult_id);
 assert.equal(String(f.git('rev-parse','HEAD')),beforeHead);
 assert.equal(String(f.git('status','--porcelain')),beforeStatus);
 assert.equal(f.state().phase,'REVIEW');
 const found=readMon(f);
 const reviews=found.filter(m=>m.role==='review');
 assert.deepEqual(reviews.map(m=>m.executor).sort(),['sol','sonnet']);
 assert.equal(reviews.every(m=>m.state==='EXITED'&&m.declares_success===false),true);
 const claude=read(path.join(f.temp,'fake-claude-args.json'));
 const tools=claude[claude.indexOf('--tools')+1];
 assert.equal(tools.includes('Edit'),false);
 assert.equal(tools.includes('Write'),false);
 const codex=read(path.join(f.temp,'fake-codex-args.json'));
 assert.equal(codex[codex.indexOf('--sandbox')+1],'read-only');
});

test('a dispatch file cannot relabel an implementation run as a review',async t=>{
 const f=fixture(t);
 f.begin();
 const file=path.join(f.control,'tasks',f.brief.task_id,'dispatch-1.json');
 const dispatch=read(file);
 dispatch.role='review';
 fs.writeFileSync(file,JSON.stringify(dispatch));
 await execute(f.root);
 const mon=readMon(f)[0];
 assert.equal(mon.role,'implement');
 assert.equal(mon.executor,'grok');
 assert.equal(mon.task_id,'HF-test');
 assert.equal(f.state().phase,'EXECUTING');
 assert.equal(f.state().writer.owner,'grok');
});

test('monitor CLI is read-only, separate from summary, and does not hold the control lock',async t=>{
 const f=fixture(t);
 f.begin();
 await execute(f.root);
 const call=(args)=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8'});
 const summary=call(['status',f.root,'--summary']);
 assert.equal(summary.status,0,summary.stderr);
 assert.deepEqual(Object.keys(JSON.parse(summary.stdout)).sort(),['next_action','owner','phase','remaining','task_id']);
 const view=JSON.parse(call(['status',f.root,'--monitor']).stdout);
 assert.equal(view.declares_success,false);
 assert.equal(view.monitors[0].role,'implement');
 assert.equal(view.monitors[0].state,'EXITED');
 const mixed=call(['status',f.root,'--summary','--monitor']);
 assert.notEqual(mixed.status,0);
 assert.match(mixed.stderr,/separate views/);
 assert.throws(()=>run(f.root,'status',{summary:true,monitor:true}),/separate views/);
 const once=call(['monitor',f.root,'--once']);
 assert.equal(once.status,0,once.stderr);
 assert.match(once.stdout,/executor: grok role: implement state: EXITED/);
 assert.match(once.stdout,/telemetry_limited: true/);
 assert.equal(once.stdout.includes('%'),false);
 assert.equal(fs.existsSync(path.join(f.control,'locks','control.lock')),false);
 const child=spawn(process.execPath,[cli,'monitor',f.root,'--watch'],{stdio:['ignore','pipe','pipe']});
 let watched='',errors='';
 child.stderr.on('data',chunk=>{errors+=chunk;});
 const ready=new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('watch produced no output: '+errors)),4000);
  child.stdout.on('data',chunk=>{
   watched+=chunk;
   if(watched.includes('telemetry_limited')){clearTimeout(timer);resolve();}
  });
  child.on('exit',code=>{clearTimeout(timer);reject(Error('watch exited '+code+' '+errors+' '+watched));});
 });
 await ready;
 assert.equal(fs.existsSync(path.join(f.control,'locks','control.lock')),false);
 assert.match(watched,/telemetry_limited: true/);
 assert.equal(watched.includes('%'),false);
 child.kill('SIGTERM');
 await new Promise(resolve=>{
  const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},2000);
  child.on('exit',()=>{clearTimeout(timer);resolve();});
 });
});
