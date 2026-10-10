import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {execute,consult} from '../scripts/executor-bridge.mjs';
import {read,atomic} from '../scripts/artifact.mjs';
import {config,selectExecutor} from '../scripts/executor-config.mjs';

const adaptive=(t,{executor='grok',criticality,strategy,reason,executors}={})=>{
 const f=fixture(t,{initialize:false,executor});
 const body={review:{by:'delegate',strategy:'lead-gated-adaptive'}};
 if(executors)body.executors=executors;
 fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify(body));
 const input={...f.brief,...(executor?{executor}:{})};
 if(criticality)input.task_criticality=criticality;
 if(strategy)input.assignment_strategy=strategy;
 if(reason)input.assignment_reason=reason;
 run(f.root,'init',input);
 return f;
};
const task=(f,...parts)=>path.join(f.control,'tasks',f.brief.task_id,...parts);
const flag=(args,name)=>args[args.indexOf(name)+1];

test('an adaptive task does not route Sonnet or Sol by itself',t=>{
 const f=fixture(t,{initialize:false});
 fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({review:{strategy:'lead-gated-adaptive'}}));
 run(f.root,'init',f.brief);
 const s=f.state();
 assert.equal(s.initial_executor==='sonnet'||s.initial_executor==='sol',false);
 assert.equal(s.routing.candidates.includes('sonnet'),false);
 assert.equal(s.routing.candidates.includes('sol'),false);
 assert.throws(()=>run(f.root,'begin',{...f.brief,executor:'sonnet'}),/implement grant|alternative/);
});

test('plain executor sol and a repository config cannot grant implementation',t=>{
 const classic=fixture(t,{initialize:false});
 assert.throws(()=>selectExecutor(config(classic.root),'sol'),/only reviews/);
 assert.throws(()=>run(classic.root,'init',{...classic.brief,executor:'sol'}),/only reviews/);
 const adaptiveTask=adaptive(t);
 assert.throws(()=>run(adaptiveTask.root,'begin',{...adaptiveTask.brief,executor:'sol'}),/alternative|APEX|implement grant/);
 fs.writeFileSync(path.join(classic.root,'hyperfusion.config.json'),JSON.stringify({external:{default:'grok',available:['grok','sol']}}));
 assert.throws(()=>config(classic.root),/Invalid/);
});

test('IMPORTANT-IMPLEMENT gives Sonnet one round, then the grant is gone',async t=>{
 const f=adaptive(t,{executor:'sonnet',criticality:'important',strategy:'sonnet_implementation',reason:'payment rules',executors:{sonnet:{reasoning_effort:'low'}}});
 assert.equal(f.state().assignment.authorized_implementer,'sonnet');
 assert.equal(f.state().initial_executor,'sonnet');
 assert.equal(read(task(f,'initial-brief.json')).assignment_strategy,undefined);
 const started=f.begin();
 assert.equal(f.state().owner,'sonnet');
 assert.equal(f.state().writer.owner,'sonnet');
 assert.equal(f.state().implement_grant.round,1);
 assert.equal(read(task(f,'implement-grant-1.json')).round,null);
 const claude=started.cli.args;
 assert.equal(flag(claude,'--effort'),'high');
 assert.equal(flag(claude,'--tools').includes('Edit'),true);
 assert.equal(flag(claude,'--tools').includes('Write'),true);
 await execute(f.root);
 const monitor=read(task(f,'monitor-1.json'));
 assert.equal(monitor.executor,'sonnet');
 assert.equal(monitor.role,'implement');
 assert.equal(monitor.declares_success,false);
 assert.equal(monitor.task_phase,null);
 f.finish();
 assert.equal(f.state().phase,'REVIEW');
 assert.throws(()=>f.begin(),/Invalid phase|implement grant/);
 const reviewed=run(f.root,'delegate-review',{});
 await consult(f.root,reviewed.consult_id);
 const out=run(f.root,'consult-finish',{quiescent:true});
 assert.deepEqual(reviewed.members.map(m=>m.executor),['sol']);
 assert.equal(out.review.status,'lead_gate');
 assert.equal(out.review.recommendation,'APPROVE');
 const codex=read(path.join(f.temp,'fake-codex-args.json'));
 assert.equal(flag(codex,'--sandbox'),'read-only');
 assert.equal(f.state().phase,'LEAD_DECISION_REQUIRED');
 const packet=read(task(f,'lead-packet-1.json'));
 assert.equal(packet.diff,undefined);
 assert.equal(packet.evidence.includes('validation-1.json'),true);
 assert.equal(packet.evidence.includes('raw-result-1.json'),true);
 const approved=run(f.root,'lead-decision',{decision:'APPROVE',rationale:'Read the Sonnet diff and the Sol review',baseline_digest:f.state().post_digest,contract_change:false});
 assert.equal(approved.phase,'VERIFY');
 assert.equal(f.state().phase,'VERIFY');
 assert.equal(fs.existsSync(task(f,'verification.json')),false);
 const decision=read(task(f,'lead-decision-1.json'));
 assert.equal(decision.decision,'APPROVE');
 assert.equal(decision.baseline_digest,f.state().post_digest);
 assert.equal(decision.consumed_usage.recorded,true);
 assert.equal(decision.consumed_usage.usage.total_cost_usd,0.01);
});

test('a rejected external round reaches Sonnet only through reassign_to_sonnet',async t=>{
 const f=adaptive(t);
 f.begin();f.finish();f.mode('review-alt');
 const first=run(f.root,'delegate-review',{});
 await consult(f.root,first.consult_id);
 run(f.root,'consult-finish',{quiescent:true});
 f.mode('ok');
 assert.equal(f.state().phase,'LEAD_DECISION_REQUIRED');
 assert.throws(()=>f.begin({executor:'sonnet'}),/Invalid phase/);
 const reassigned=run(f.root,'lead-decision',{decision:'REASSIGN_TO_SONNET',rationale:'specialist repair',baseline_digest:f.state().post_digest,contract_change:false});
 assert.equal(reassigned.phase,'ALTERNATIVE_REQUIRED');
 assert.equal(reassigned.lead_decision.required_reviewer,'sol');
 assert.equal(reassigned.lead_decision.next_executor,'sonnet');
 assert.equal(f.state().writer,null);
 assert.throws(()=>f.begin({executor:'antigravity'}),/bound to sonnet/);
 const started=f.begin({executor:'sonnet'});
 assert.equal(started.executor,'sonnet');
 assert.equal(f.state().implement_grant.round,2);
});

test('APEX Sol writes once, reviews stay read-only, and a second round needs a new grant',async t=>{
 const f=adaptive(t,{executor:'sol',criticality:'apex',strategy:'sol_apex',reason:'schema migration',executors:{sol:{reasoning_effort:'xhigh'}}});
 assert.equal(f.state().assignment.authorized_implementer,'sol');
 assert.equal(f.state().attempts.sol,undefined);
 const open=f.begin();
 assert.equal(open.executor,'sol');
 assert.equal(f.state().writer.owner,'sol');
 assert.equal(flag(open.cli.args,'--sandbox'),'workspace-write');
 assert.ok(open.cli.args.includes('model_reasoning_effort="medium"'));
 await execute(f.root);
 const monitor=read(task(f,'monitor-1.json'));
 assert.equal(monitor.role,'implement');
 assert.equal(monitor.executor,'sol');
 assert.equal(monitor.declares_success,false);
 f.finish();
 assert.equal(f.state().phase,'LEAD_DECISION_REQUIRED');
 assert.throws(()=>run(f.root,'delegate-review',{}),/Invalid phase/);
 assert.match(read(task(f,'lead-packet-1.json')).note,/delegated reviewers are refused/);
 assert.throws(()=>run(f.root,'lead-decision',{decision:'APPROVE',rationale:'looked at the name only',baseline_digest:f.state().post_digest,contract_change:false,diff_reviewed:true}),/tests_checked/);
 assert.throws(()=>run(f.root,'lead-decision',{decision:'APPROVE',rationale:'boolean is not a test name',baseline_digest:f.state().post_digest,contract_change:false,diff_reviewed:true,tests_checked:true,changed_scope:'scripts/a.js'}),/tests_checked/);
 assert.throws(()=>run(f.root,'lead-decision',{decision:'REASSIGN_TO_SONNET',rationale:'switch',baseline_digest:f.state().post_digest,contract_change:false}),/APEX task stays with Sol/);
 assert.equal(f.state().phase,'LEAD_DECISION_REQUIRED');
 const again=run(f.root,'lead-decision',{decision:'REDO',rationale:'second apex pass',baseline_digest:f.state().post_digest,contract_change:false});
 assert.equal(again.phase,'REDO');
 assert.equal(f.state().writer,null);
 assert.equal(again.lead_decision.implement_grant_revision,2);
 assert.equal(f.state().implement_grant.revision,2);
 assert.equal(f.state().implement_grant.round,null);
 assert.equal(f.state().implement_grant.sandbox,'workspace-write');
 assert.throws(()=>run(f.root,'grant-implement',{executor:'sol',strategy:'sol_apex',reason:'duplicate'}),/already open/);
 const second=f.begin({executor:'sol'});
 assert.equal(second.executor,'sol');
 assert.equal(flag(second.cli.args,'--sandbox'),'workspace-write');
 assert.equal(f.state().implement_grant.round,2);
 assert.equal(read(task(f,'implement-grant-1.json')).round,null);
 assert.equal(read(task(f,'implement-grant-2.json')).round,null);
});

test('a rewritten grant or a brief field cannot widen the role',t=>{
 const f=adaptive(t,{executor:'sol',criticality:'apex',strategy:'sol_apex',reason:'frozen'});
 const s=f.state();
 s.implement_grant={...s.implement_grant,reason:'worker rewrote the grant'};
 atomic(path.join(f.control,'state.json'),s);
 assert.throws(()=>f.begin(),/controller record/);
 const other=adaptive(t);
 assert.throws(()=>other.begin({assignment_strategy:'sonnet_implementation',task_criticality:'important',assignment_reason:'from the worker'}),/controller records/);
 assert.throws(()=>adaptive(t,{executor:'grok',criticality:'important',strategy:'sonnet_implementation',reason:'must start as sonnet'}),/starts with Sonnet/);
 assert.throws(()=>adaptive(t,{executor:'luna',criticality:'apex',strategy:'sol_apex',reason:'must start as sol'}),/starts with Sol/);
});

test('a consumed grant is rechecked against controller evidence before bridge launch',async t=>{
 const f=adaptive(t,{executor:'sol',criticality:'apex',strategy:'sol_apex',reason:'frozen'});
 f.begin();const s=f.state();s.implement_grant.reason='changed after lease';
 atomic(path.join(f.control,'state.json'),s);
 await assert.rejects(()=>execute(f.root),/active grant differs/);
 assert.equal(fs.existsSync(task(f,'launch-1.json')),false);
});

test('APEX redo cannot issue unbounded Sol grants',t=>{
 const f=adaptive(t,{executor:'sol',criticality:'apex',strategy:'sol_apex',reason:'bounded'});
 for(let round=1;round<=3;round++){
  f.begin();f.finish();assert.equal(f.state().apex_rounds,round);
  const input={decision:'REDO',rationale:'bounded repair',baseline_digest:f.state().post_digest,contract_change:false};
  if(round<3)run(f.root,'lead-decision',input);
  else assert.throws(()=>run(f.root,'lead-decision',input),/round cap/);
 }
 assert.equal(f.state().writer,null);
});
