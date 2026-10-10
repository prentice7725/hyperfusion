import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {consult} from '../scripts/executor-bridge.mjs';
import {autopilot} from '../scripts/autopilot.mjs';
import {read,atomic} from '../scripts/artifact.mjs';

const adaptive=(t,{executor='grok',criticality,strategy,reason}={})=>{
 const f=fixture(t,{initialize:false,executor});
 fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({review:{by:'delegate',strategy:'lead-gated-adaptive',auto_apply:true}}));
 const input={...f.brief,executor};
 if(criticality)input.task_criticality=criticality;
 if(strategy)input.assignment_strategy=strategy;
 if(reason)input.assignment_reason=reason;
 run(f.root,'init',input);
 return f;
};
const task=(f,...parts)=>path.join(f.control,'tasks',f.brief.task_id,...parts);
const delegate=async f=>{const c=run(f.root,'delegate-review',{});await consult(f.root,c.consult_id);return run(f.root,'consult-finish',{quiescent:true});};
const decide=(f,extra={})=>run(f.root,'lead-decision',{decision:'APPROVE',rationale:'Read the round evidence',baseline_digest:f.state().post_digest,contract_change:false,...extra});

test('a unanimous delegated pass stops for a lead decision and APPROVE does not CLOSE',async t=>{
 const f=adaptive(t);
 f.begin();f.finish();
 const out=await delegate(f);
 assert.equal(out.review.status,'lead_gate');
 assert.equal(out.phase,'LEAD_DECISION_REQUIRED');
 assert.equal(f.state().reviews.length,0);
 const packet=read(task(f,'lead-packet-1.json'));
 assert.equal(packet.diff,undefined);
 assert.equal(packet.recommendation,'APPROVE');
 assert.equal(packet.evidence.includes('validation-1.json'),true);
 assert.equal(packet.evidence.includes('raw-result-1.json'),true);
 assert.equal(JSON.stringify(packet).includes('"base"'),false);
 assert.throws(()=>decide(f,{baseline_digest:'0'.repeat(64)}),/does not match/);
 assert.throws(()=>decide(f,{contract_change:true}),/contract changed/);
 assert.throws(()=>decide(f,{decision:'REASSIGN_OTHER',executor:'sol',rationale:'not a general writer'}),/grok, antigravity, haiku, or luna/);
 assert.throws(()=>decide(f,{decision:'REASSIGN_OTHER',executor:'grok',rationale:'same owner'}),/different executor/);
 assert.equal(f.state().phase,'LEAD_DECISION_REQUIRED');
 assert.equal(fs.existsSync(task(f,'lead-decision-1.json')),false);
 const saved=structuredClone(f.state().review_results);
 const tampered=f.state();
 tampered.review_results[1][0].verdict='redo';
 atomic(path.join(f.control,'state.json'),tampered);
 assert.throws(()=>decide(f),/every mandatory review/);
 const restored=f.state();
 restored.review_results=saved;
 atomic(path.join(f.control,'state.json'),restored);
 fs.writeFileSync(path.join(f.control,'locks','writer.json'),'{}');
 assert.throws(()=>decide(f),/Writer still present/);
 fs.unlinkSync(path.join(f.control,'locks','writer.json'));
 assert.equal(f.state().phase,'LEAD_DECISION_REQUIRED');
 const approved=decide(f);
 assert.equal(approved.phase,'VERIFY');
 assert.equal(approved.lead_decision.consumed_usage.recorded,false);
 assert.equal(approved.lead_decision.consumed_usage.usage,undefined);
 assert.equal(fs.existsSync(task(f,'verification.json')),false);
 assert.equal(run(f.root,'verify',{acceptance_satisfied:true,tests:[{command:'check',status:'pass'}]}).phase,'CLOSE');
});

test('tree drift before the decision is recovery, not approval',async t=>{
 const f=adaptive(t);
 f.begin();f.finish();
 await delegate(f);
 fs.writeFileSync(path.join(f.root,'a.txt'),'drifted');
 assert.throws(()=>decide(f),/Tree drift/);
 assert.equal(f.state().phase,'RECOVERY_REQUIRED');
 assert.equal(fs.existsSync(task(f,'lead-decision-1.json')),false);
});

test('REDO_SAME_OWNER forwards the panel and does not start a writer',async t=>{
 const f=adaptive(t);
 f.begin();f.finish();f.mode('review-redo');
 await delegate(f);
 const out=decide(f,{decision:'REDO_SAME_OWNER',rationale:'AC1 still fails'});
 assert.equal(out.decision,'REDO');
 assert.equal(out.phase,'REDO');
 assert.equal(out.lead_decision.requested_decision,'REDO_SAME_OWNER');
 assert.equal(f.state().writer,null);
 assert.equal(f.state().implement_grant??null,null);
 f.begin({lead_feedback:'@review'});
 const brief=read(task(f,'brief-2.json'));
 assert.equal(brief.lead_feedback.some(item=>item.file==='a.txt'&&item.comment.includes('AC1')),true);
});

test('REASSIGN_OTHER without an executor uses rotation and skips Sonnet and Sol',async t=>{
 const f=adaptive(t);
 f.begin();f.finish();f.mode('review-alt');
 await delegate(f);
 const out=decide(f,{decision:'REASSIGN_OTHER',rationale:'try another external worker'});
 assert.equal(out.phase,'ALTERNATIVE_REQUIRED');
 assert.equal(out.lead_decision.next_executor,null);
 const started=f.begin();
 assert.equal(started.executor==='sonnet',false);
 assert.equal(started.executor==='sol',false);
 assert.notEqual(started.executor,'grok');
});

test('ESCALATE and BLOCK stay with the lead and do not verify',async t=>{
 const escalate=adaptive(t);
 escalate.begin();escalate.finish();
 await delegate(escalate);
 assert.equal(decide(escalate,{decision:'ESCALATE',rationale:'the design is unresolved'}).phase,'DECISION_REQUIRED');
 assert.equal(fs.existsSync(task(escalate,'verification.json')),false);
 const block=adaptive(t);
 block.begin();block.finish();
 await delegate(block);
 assert.equal(decide(block,{decision:'BLOCK',rationale:'the contract cannot be met'}).phase,'BLOCKED');
 assert.equal(block.state().writer,null);
 assert.equal(fs.existsSync(task(block,'verification.json')),false);
});

test('a Sol round is approved only after the diff, tests, and scope are named',t=>{
 const f=adaptive(t,{executor:'sol',criticality:'apex',strategy:'sol_apex',reason:'schema migration'});
 f.begin();f.finish();
 assert.equal(f.state().phase,'LEAD_DECISION_REQUIRED');
 assert.throws(()=>run(f.root,'delegate-review',{}),/Invalid phase/);
 assert.throws(()=>decide(f,{diff_reviewed:true,tests_checked:['tests/schema.test.mjs']}),/changed_scope/);
 assert.throws(()=>decide(f,{diff_reviewed:false,tests_checked:['tests/schema.test.mjs'],changed_scope:['a.txt']}),/diff_reviewed/);
 const approved=decide(f,{diff_reviewed:true,tests_checked:['tests/schema.test.mjs'],changed_scope:['a.txt']});
 assert.equal(approved.phase,'VERIFY');
 assert.equal(f.state().phase,'VERIFY');
 const decision=read(task(f,'lead-decision-1.json'));
 assert.equal(decision.consumed_usage.recorded,false);
 assert.equal(decision.diff_reviewed,true);
 assert.deepEqual(decision.tests_checked,['tests/schema.test.mjs']);
 assert.deepEqual(decision.changed_scope,['a.txt']);
 assert.equal(JSON.stringify(decision).includes('"total_cost_usd":0'),false);
 assert.equal(fs.existsSync(task(f,'verification.json')),false);
});

test('classic review still applies a pass without a lead decision',t=>{
 const f=fixture(t);
 f.begin();f.finish();
 assert.equal(f.review('pass').phase,'VERIFY');
 assert.equal(fs.existsSync(task(f,'lead-decision-1.json')),false);
});

test('adaptive autopilot stops at the lead gate',async t=>{
 const f=fixture(t,{initialize:false});
 const mark=path.join(f.temp,'green');
 const cmd=`node -e "process.exit(require('fs').existsSync(process.argv[1])?0:1)" "${mark}"`;
 f.brief.acceptance_commands=[cmd];
 fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({review:{strategy:'lead-gated-adaptive',auto_apply:true}}));
 run(f.root,'init',{...f.brief,executor:'grok'});
 fs.writeFileSync(mark,'1');
 const out=await autopilot(f.root);
 assert.equal(out.phase,'LEAD_DECISION_REQUIRED',JSON.stringify(out));
 assert.equal(out.reason,'LEAD_DECISION_REQUIRED');
 assert.equal(f.state().writer,null);
 assert.equal(f.state().reviews.length,0);
 assert.equal(fs.existsSync(task(f,'verification.json')),false);
 assert.equal(read(task(f,'lead-packet-1.json')).recommendation,'APPROVE');
});
