import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {summarizeAutomation,aggregateAutomation} from '../scripts/automation-metrics.mjs';
import {aggregate,measure,refreshAutomationMetrics} from '../scripts/metrics.mjs';
import {fixture} from './support.mjs';
import {collectRunUsage} from '../scripts/usage-accounting.mjs';
import {CASES,comparePilot} from '../scripts/benchmark.mjs';
import {autopilot} from '../scripts/autopilot.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {startWindow,stopWindow} from '../scripts/benchmark-window.mjs';

const at=ms=>new Date(ms).toISOString();
const review=(tag,start,wall,extra={})=>({tag,role:'review',executor:'grok',model:'grok-code',reasoning_effort:'xhigh',transport_observed:true,started_at:at(start),wall_ms:wall,...extra});
const journal=(extra={})=>({started_at:at(0),initial_phase:'EXECUTING',events:[{at:at(10),phase:'REVIEW'},{at:at(30),phase:'LEAD_DECISION_REQUIRED'}],finished_at:at(40),reason:'LEAD_DECISION_REQUIRED',gate_diagnostic:{eligible:false,reason_codes:['MANDATORY_REVIEW_MISSING']},...extra});

test('parallel reviews report seat time separately from wall wait, including failed launches',()=>{
 const m=summarizeAutomation([review('one',0,100),review('two',50,100,{executor:'sol',reasoning_effort:'high',exit_code:1})]);
 assert.equal(m.review_seat_ms,200);assert.equal(m.review_wait_ms,150);
 assert.equal(m.grok_xhigh_review_seat_ms,100);assert.equal(m.transport_attempts,2);
 assert.equal(m.host_model_invocations,null);
 assert.equal(m.transport_by_role_model_effort.length,2);
});

test('incomplete timing stays unknown and usage-only artifacts do not prove transports',()=>{
 const m=summarizeAutomation([review('one',0,null),review('two',0,20,{transport_observed:false})]);
 assert.equal(m.review_seat_ms,null);assert.equal(m.review_wait_ms,null);assert.equal(m.transport_attempts,1);
 assert.equal(m.autopilot_phase_ms,null);assert.equal(m.eligibility_observed,null);
});

test('journal phases cover their window and repeated stops count events but aggregate tasks once',()=>{
 const m=summarizeAutomation([],[journal(),journal({started_at:at(100),events:[],finished_at:at(110)})]);
 assert.deepEqual(m.autopilot_phase_ms,{EXECUTING:20,REVIEW:20,LEAD_DECISION_REQUIRED:10});
 assert.equal(m.stop_events_by_reason.MANDATORY_REVIEW_MISSING,2);
 assert.equal(m.eligibility_observed,false);
 const a=aggregateAutomation([{automation:m}]);
 assert.equal(a.stopped_tasks_by_reason.MANDATORY_REVIEW_MISSING,1);
 assert.equal(a.eligibility_checked_tasks,1);assert.equal(a.actually_automated_tasks,0);
});

test('legacy, unfinished, invalid, out-of-order and overlapping journal times suppress complete phase claims',()=>{
 for(const journals of [[null],[journal({initial_phase:undefined})],[journal({finished_at:undefined})],[journal({events:[null]})],[journal({events:[{at:at(50),phase:'REVIEW'}]})],[journal(),journal()]]){
  assert.equal(summarizeAutomation([],journals).autopilot_phase_ms,null,JSON.stringify(journals));
 }
 const m=summarizeAutomation([],[journal({error:{code:'FUTURE_FAILURE'},gate_diagnostic:undefined})]);
 assert.equal(m.stop_events_by_reason.FUTURE_FAILURE,1);
});

test('policy approval proves observed eligibility while lead decisions and transport counts remain distinct',()=>{
 const m=summarizeAutomation([],[journal({reason:'CLOSE'})],[{decision:'APPROVE',authority:{source:'delegated-policy'}},{decision:'REDO',authority:{source:'lead'}}]);
 assert.equal(m.eligibility_observed,true);assert.equal(m.policy_approvals,1);assert.equal(m.lead_decisions,1);
 assert.deepEqual(m.stop_events_by_reason,{});
 const a=aggregate([{success:true,automation:m},{success:false}]);
 assert.equal(a.automation.actually_automated_tasks,1);assert.equal(a.automation.transport_attempts,null);
 assert.equal(a.lead_tokens_per_success,null);
});

test('measurement and terminal refresh collect durable evidence without changing task state',t=>{
 const f=fixture(t),dir=path.join(f.control,'tasks',f.brief.task_id);
 const put=(name,value)=>fs.writeFileSync(path.join(dir,name),JSON.stringify(value));
 put('launch-consult-c1-m1.json',{executor:'grok'});
 put('consult-c1.json',{mode:'review'});
 put('envelope-consult-c1-m1.json',{wall_ms:100,started_at:at(0),exit:{code:1}});
 put('consult-c1-m1.json',{cli:{model:'grok-code',reasoning_effort:'xhigh'}});
 put('autopilot-test.json',journal({finished_at:undefined}));
 const before=fs.readFileSync(path.join(f.control,'state.json'),'utf8');
 const runs=collectRunUsage(f.root,f.state());assert.equal(runs[0].transport_observed,true);
 const first=measure(f.root);assert.equal(first.automation.review_seat_ms,100);
 assert.equal(first.automation.autopilot_phase_ms,null);
 put('autopilot-test.json',journal());refreshAutomationMetrics(f.root,f.state());
 const final=JSON.parse(fs.readFileSync(path.join(f.control,'metrics',f.brief.task_id+'.json')));
 assert.equal(final.automation.autopilot_phase_ms.REVIEW,20);
 assert.equal(final.lead_usage,null);assert.equal(final.worker_cost_estimate_usd,null);
 assert.equal(fs.readFileSync(path.join(f.control,'state.json'),'utf8'),before);
});

test('paired benchmark summaries expose observation coverage and keep failed trial usage in numerators',()=>{
 const rows=CASES.map(c=>({case_id:c.case_id,success:true,lead_usage:{lead_tokens:10},automation:summarizeAutomation([])}));
 rows[0].success=false;
 const out=comparePilot(rows,rows);
 assert.equal(out.baseline.lead_tokens_per_success,100/9);
 assert.equal(out.baseline.automation.observed_tasks,10);
 assert.equal(out.baseline.automation.eligibility_checked_tasks,0);
 assert.equal(out.primary_reduction,null);
});

test('autopilot persists phase origin and stop code without consuming a worker attempt',async t=>{
 const f=fixture(t),before=f.state().attempts;
 const stop=await autopilot(f.root);
 assert.equal(stop.reason,'AUTOPILOT_ACCEPTANCE_REQUIRED');
 const stored=JSON.parse(fs.readFileSync(stop.journal_file));
 assert.equal(stored.initial_phase,'PLAN');assert.ok(stored.finished_at);
 const m=measure(f.root).automation;
 assert.equal(m.stop_events_by_reason.AUTOPILOT_ACCEPTANCE_REQUIRED,1);
 assert.ok(m.autopilot_phase_ms.PLAN>=0);assert.equal(m.transport_attempts,0);
 assert.deepEqual(f.state().attempts,before);
});

test('failed diagnostic evaluation does not count as observed eligibility',()=>{
 const m=summarizeAutomation([],[journal({gate_diagnostic:{eligible:false,reason_codes:['DIAGNOSTIC_ERROR']}})]);
 assert.equal(m.eligibility_observed,null);assert.equal(m.stop_events_by_reason.DIAGNOSTIC_ERROR,1);
});

test('benchmark stop persists automation evidence without changing the measurement window',t=>{
 const f=fixture(t,{initialize:false});
 fs.mkdirSync(f.control,{recursive:true});
 const tree=f.git('rev-parse','HEAD^{tree}').toString().trim();
 fs.writeFileSync(path.join(f.control,'benchmark-fixture.json'),JSON.stringify({case_id:'HF-B01',initial_tree:tree,fixture_id:'test-fixture',protected_files:{}}));
 const window=startWindow('HF-B01',f.root,{arm:'hyperfusion',sessionId:'test-host'});
 run(f.root,'init',{...f.brief,task_id:'HF-B01',executor:'grok'});
 const state=f.state();state.phase='BLOCKED';
 fs.writeFileSync(path.join(f.control,'state.json'),JSON.stringify(state));
 const metric=stopWindow('HF-B01',f.root,{success:false});
 assert.equal(metric.started_at,window.started_at);assert.equal(metric.arm,'hyperfusion');
 assert.equal(metric.automation.revision,1);assert.equal(metric.automation.eligibility_observed,null);
 assert.equal(metric.lead_usage,null);assert.equal(metric.success,false);
});

test('a lead gate with no grant returns and records the missing-grant stop without authority changes',async t=>{
 const f=fixture(t),s=f.state();s.phase='LEAD_DECISION_REQUIRED';
 fs.writeFileSync(path.join(f.control,'state.json'),JSON.stringify(s));
 const before=fs.readFileSync(path.join(f.control,'state.json'),'utf8');
 const out=await autopilot(f.root);
 assert.deepEqual(out.diagnostic.reason_codes,['DELEGATION_MISSING']);
 const metric=measure(f.root);
 assert.equal(metric.automation.eligibility_observed,false);
 assert.equal(metric.automation.stop_events_by_reason.DELEGATION_MISSING,1);
 assert.equal(metric.automation.transport_attempts,0);
 assert.equal(fs.readFileSync(path.join(f.control,'state.json'),'utf8'),before);
});
