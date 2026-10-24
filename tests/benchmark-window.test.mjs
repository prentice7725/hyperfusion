import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fixture} from './support.mjs';
import {prepareFixture} from '../scripts/benchmark-fixtures.mjs';
import {startWindow,stopWindow,recoverWindow} from '../scripts/benchmark-window.mjs';
import {collectHostUsage} from '../scripts/lead-usage.mjs';
import {read,atomic} from '../scripts/artifact.mjs';
import {controlPath} from '../scripts/control-dir.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {CASES,comparePilot} from '../scripts/benchmark.mjs';
import {weightedUsage} from '../scripts/usage-weights.mjs';

const row=(sessionId,at,id='one')=>({type:'assistant',sessionId,timestamp:new Date(at).toISOString(),message:{id,model:'claude-opus-5-5',usage:{input_tokens:10,output_tokens:5,cache_read_input_tokens:100,cache_creation_input_tokens:4}}});
test('every fixture has deterministic clean trees and JS baselines fail assertions',t=>{
 const f=fixture(t,{initialize:false});
 for(const c of CASES){
  const a=prepareFixture(c.case_id,path.join(f.temp,c.case_id+'-a'));
  const b=prepareFixture(c.case_id,path.join(f.temp,c.case_id+'-b'));
  assert.equal(a.initial_tree,b.initial_tree);assert.equal(a.fixture_id,b.fixture_id);
  if(!['HF-B02','HF-B04','HF-B09'].includes(c.case_id))assert.equal(a.baseline_status,'red',c.case_id);
  assert.throws(()=>prepareFixture(c.case_id,a.root),/must not exist/);
 }
});

test('baseline window collects with no HF task and a late hook refreshes the metric',t=>{
 const f=fixture(t,{initialize:false}),p=prepareFixture('HF-B01',path.join(f.temp,'baseline'));
 const window=startWindow('HF-B01',p.root,{sessionId:'baseline-host'});
 assert.throws(()=>startWindow('HF-B01',p.root,{sessionId:'baseline-host'}),/already/);
 assert.equal(fs.existsSync(controlPath(p.root,'state.json')),false);
 const result=stopWindow('HF-B01',p.root,{success:false});assert.equal(result.lead_usage,null);
 const transcript=path.join(f.temp,'baseline.jsonl');
 fs.writeFileSync(transcript,JSON.stringify(row('baseline-host',Date.parse(window.started_at)+1))+'\n'+JSON.stringify(row('baseline-host',Date.now()+50,'after-stop'))+'\n');
 collectHostUsage(p.root,{hook_event_name:'Stop',session_id:'baseline-host',transcript_path:transcript},{at:Date.now()+100});
 const metric=read(controlPath(p.root,'metrics','HF-B01.json'));
 assert.equal(metric.case_id,'HF-B01');assert.equal(metric.initial_tree,p.initial_tree);
 assert.equal(metric.lead_usage.scope,'benchmark-window');assert.equal(metric.lead_usage.lead_tokens,119);
 assert.equal(metric.lead_weighted_usage.input_equivalent,50);
 assert.throws(()=>stopWindow('HF-B01',p.root,{success:false}),/already stopped/);
});

test('benchmark start rejects changed trees and stop rejects modified acceptance tests',t=>{
 const f=fixture(t,{initialize:false}),p=prepareFixture('HF-B01',path.join(f.temp,'baseline'));
 const original=fs.readFileSync(path.join(p.root,'task.mjs'),'utf8');
 fs.appendFileSync(path.join(p.root,'task.mjs'),'\n');
 assert.throws(()=>startWindow('HF-B01',p.root,{sessionId:'host'}),/clean canonical/);
 fs.writeFileSync(path.join(p.root,'task.mjs'),original);
 startWindow('HF-B01',p.root,{sessionId:'host'});fs.writeFileSync(path.join(p.root,'acceptance-case.mjs'),'');
 assert.throws(()=>stopWindow('HF-B01',p.root,{success:false}),/protected acceptance/);
});

test('HF init keeps the same benchmark measurement window and prevents premature stop',t=>{
 const f=fixture(t,{initialize:false}),p=prepareFixture('HF-B01',path.join(f.temp,'hf'));
 const window=startWindow('HF-B01',p.root,{arm:'hyperfusion',sessionId:'hf-host'});
 run(p.root,'init',{...f.brief,task_id:'HF-B01',scope:{paths:['task.mjs']},executor:'grok'});
 const persisted=read(controlPath(p.root,'tasks/HF-B01/host-usage-window.json'));
 assert.equal(persisted.started_at,window.started_at);assert.equal(persisted.scope,'benchmark-window');
 assert.throws(()=>stopWindow('HF-B01',p.root,{success:false}),/CLOSE\/BLOCKED/);
});

test('every generated benchmark brief is accepted by controller init unchanged',t=>{
 for(const id of ['HF-B01','HF-B02']){
  const f=fixture(t,{initialize:false}),p=prepareFixture(id,path.join(f.temp,id));
  run(p.root,'init',{...read(p.brief_file),executor:'grok'});
  assert.equal(read(controlPath(p.root,'state.json')).task_id,id);
 }
});

test('Java fixtures assert behavior when a JDK exists',t=>{
 if(spawnSync('javac',['-version']).error){t.skip('JDK unavailable');return;}
 const f=fixture(t,{initialize:false});
 for(const id of ['HF-B02','HF-B04','HF-B09'])assert.equal(prepareFixture(id,path.join(f.temp,id)).baseline_status,'red',id);
});

test('reference weights can reverse raw-token ranking; configured prices include failed-task cost',()=>{
 const observation=(input,cache)=>({by_model:{'claude-opus-5-5':{components:{input_tokens:input,output_tokens:0,cache_read_input_tokens:cache,cache_creation_input_tokens:0}}}});
 assert.equal(weightedUsage(observation(0,100)).input_equivalent,10);assert.equal(weightedUsage(observation(20,0)).input_equivalent,20);
 const records=n=>CASES.map(c=>({case_id:c.case_id,initial_tree:'tree',fixture_id:'fixture',success:true,lead_usage:{...observation(n,0),lead_tokens:n,scope:'benchmark-window'},claude_total_tokens:n,claude_usage:{opus:n,sonnet:0,haiku:0},run_usage:[]}));
 const base=records(100),hf=records(50);hf[0].success=false;
 const pricing={source:'test rates, not actual prices',as_of:'2026-10-14',models:{'claude-opus-5-5':{input_tokens:10,output_tokens:50,cache_read_input_tokens:1,cache_creation_input_tokens:12.5}}};
 const out=comparePilot(base,hf,pricing);assert.equal(out.status,'measured-pilot');assert.equal(out.primary_metric,'estimated_total_claude_usd_per_success');
 assert.ok(Math.abs(out.hyperfusion.weighted_usage_per_success-0.005/9)<1e-12);
 hf[0].initial_tree='different';assert.equal(comparePilot(base,hf,pricing).primary_reduction,null);
 delete pricing.models['claude-opus-5-5'].input_tokens;assert.throws(()=>comparePilot(base,hf,pricing),/PRICING/);
});

test('Spring MVC fixture can pass its real HTTP regression after the service is repaired',t=>{
 const mvn=process.platform==='win32'?'mvn.cmd':'mvn';
 // With shell:true a missing mvn.cmd reports a nonzero exit status instead of a spawn error.
 const maven=spawnSync(mvn,['-version'],{shell:process.platform==='win32'});
 if(spawnSync('javac',['-version']).error||maven.error||maven.status!==0){t.skip('JDK/Maven unavailable');return;}
 const f=fixture(t,{initialize:false}),p=prepareFixture('HF-B09',path.join(f.temp,'spring'));
 assert.equal(p.baseline_status,'red');
 fs.writeFileSync(path.join(p.root,'Task.java'),`public class Task {
 private String state="NEW";private int attempts=0;
 public boolean transition(String next){boolean valid=(state.equals("NEW")&&next.equals("RUNNING"))
  ||(state.equals("RUNNING")&&(next.equals("RECOVERY_REQUIRED")||next.equals("CLOSED")))
  ||(state.equals("RECOVERY_REQUIRED")&&next.equals("RECOVERED"))||(state.equals("RECOVERED")&&next.equals("RUNNING"));
  if(!valid)return false;state=next;attempts++;return true;}
 public String state(){return state;}public int attempts(){return attempts;}}
`);
 const result=spawnSync(process.execPath,['run.mjs'],{cwd:p.root,encoding:'utf8',timeout:120000});
 assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
});

test('a reserved benchmark does not allow reuse of task IDs with implementation artifacts',t=>{
 const f=fixture(t,{initialize:false}),p=prepareFixture('HF-B01',path.join(f.temp,'reserved'));
 startWindow('HF-B01',p.root,{arm:'hyperfusion',sessionId:'hf-host'});
 fs.writeFileSync(controlPath(p.root,'tasks/HF-B01/brief-1.json'),'{}');
 assert.throws(()=>run(p.root,'init',{...f.brief,task_id:'HF-B01',scope:{paths:['task.mjs']},executor:'grok'}),/already used/);
});


test('benchmark recovery requires explicit quiescence and never clears another controller lock',t=>{
 const f=fixture(t,{initialize:false}),p=prepareFixture('HF-B01',path.join(f.temp,'recovery'));
 startWindow('HF-B01',p.root,{sessionId:'host'});
 const file=controlPath(p.root,'locks/acceptance.json');atomic(file,{source:'benchmark',task_id:'HF-B01'});
 assert.throws(()=>recoverWindow('HF-B01',p.root,{}),/quiescent/);assert.ok(fs.existsSync(file));
 assert.throws(()=>recoverWindow('HF-B02',p.root,{quiescent:true,reason:'confirmed stopped'}),/unrelated/);
 recoverWindow('HF-B01',p.root,{quiescent:true,reason:'confirmed stopped'});assert.equal(fs.existsSync(file),false);
});

test('CLOSE alone cannot fabricate a passing benchmark without canonical acceptance',t=>{
 const f=fixture(t,{initialize:false}),p=prepareFixture('HF-B01',path.join(f.temp,'no-acceptance'));
 startWindow('HF-B01',p.root,{arm:'hyperfusion',sessionId:'host'});
 atomic(controlPath(p.root,'state.json'),{task_id:'HF-B01',phase:'CLOSE'});
 assert.throws(()=>stopWindow('HF-B01',p.root,{success:true}),/canonical controller acceptance/);
});
