import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {consult} from '../scripts/executor-bridge.mjs';
import {read,atomic} from '../scripts/artifact.mjs';
import {measure} from '../scripts/metrics.mjs';

const adaptive=(t,{executor='grok',criticality,strategy,reason,review={},executors}={})=>{
 const f=fixture(t,{initialize:false,executor});
 const body={review:{by:'delegate',strategy:'lead-gated-adaptive',...review}};
 if(executors)body.executors=executors;
 fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify(body));
 const input={...f.brief,executor};
 if(criticality)input.task_criticality=criticality;
 if(strategy)input.assignment_strategy=strategy;
 if(reason)input.assignment_reason=reason;
 run(f.root,'init',input);
 return f;
};
const delegate=async(f,input={})=>{const c=run(f.root,'delegate-review',input);await consult(f.root,c.consult_id);return {c,out:run(f.root,'consult-finish',{quiescent:true})};};
const decide=(f,extra={})=>run(f.root,'lead-decision',{decision:'APPROVE',rationale:'Read the round evidence',baseline_digest:f.state().post_digest,contract_change:false,...extra});
const task=(f,...parts)=>path.join(f.control,'tasks',f.brief.task_id,...parts);
const args=(f,name)=>read(path.join(f.temp,`fake-${name}-args.json`));

test('Grok, Antigravity and Haiku standard rounds use Sol only',async t=>{
 for(const executor of ['grok','antigravity','haiku']){
  const f=adaptive(t,{executor,review:{reviewers:['sonnet','haiku','luna']},executors:{sol:{reasoning_effort:'xhigh'}}});
  f.begin();f.finish();
  assert.throws(()=>f.review('pass'),/cannot replace/);
  assert.equal(f.state().phase,'REVIEW');
  assert.throws(()=>run(f.root,'delegate-review',{executors:['sonnet']}),/controller plan/);
  const {c,out}=await delegate(f);
  assert.deepEqual(c.members.map(m=>m.executor),['sol']);
  assert.equal(out.review.status,'lead_gate');
  assert.equal(out.review.verdict,'pass');
  assert.equal(out.review.recommendation,'APPROVE');
  assert.equal(f.state().phase,'LEAD_DECISION_REQUIRED');
  assert.equal(f.state().reviews.length,0);
  assert.equal(decide(f).phase,'VERIFY');
  assert.equal(fs.existsSync(task(f,'verification.json')),false);
  const codex=args(f,'codex');
  assert.equal(codex[codex.indexOf('--sandbox')+1],'read-only');
  assert.ok(codex.includes('model_reasoning_effort="medium"'));
  const brief=read(task(f,'initial-brief.json'));
  assert.equal(brief.task_criticality,undefined);
  assert.equal(read(task(f,'assignment.json')).criticality,'standard');
 }
});

test('an important Grok or Antigravity round needs Sol and Sonnet on one digest',async t=>{
 for(const executor of ['grok','antigravity']){
  const f=adaptive(t,{executor,criticality:'important',reason:'touches payment state'});
  f.begin();f.finish();
  const {c,out}=await delegate(f);
  assert.deepEqual(c.members.map(m=>m.executor),['sol','sonnet']);
  assert.equal(out.review.status,'lead_gate');
  assert.equal(f.state().phase,'LEAD_DECISION_REQUIRED');
  assert.equal(f.state().reviews.length,0);
  assert.equal(measure(f.root).delegated_reviews,0);
  assert.equal(decide(f).phase,'VERIFY');
  assert.equal(f.state().phase,'VERIFY');
  assert.equal(measure(f.root).delegated_reviews,0);
  const base=read(task(f,'consult-c1-base.json'));
  const panel=f.state().review_results[1];
  assert.equal(panel.length,2);
  assert.deepEqual(panel.map(r=>r.executor),['sol','sonnet']);
  assert.equal(panel.every(r=>r.verdict==='pass'&&r.digest===base.digest&&r.digest===f.state().post_digest),true);
  const prompts=['m1','m2'].map(m=>JSON.parse(read(task(f,`consult-c1-${m}.json`)).prompt));
  assert.equal(prompts[0].brief.consult.context.diff,prompts[1].brief.consult.context.diff);
  assert.equal(prompts[0].brief.consult.context.sibling_verdict,undefined);
  assert.deepEqual(prompts[1].brief.consult.context.recent_reviews,[]);
  assert.notEqual(prompts[0].brief.consult.member,prompts[1].brief.consult.member);
  const claude=args(f,'claude');
  assert.equal(claude[claude.indexOf('--effort')+1],'high');
  const tools=claude[claude.indexOf('--tools')+1];
  assert.equal(tools.includes('Edit'),false);
  assert.equal(tools.includes('Write'),false);
  const monitors=fs.readdirSync(task(f)).filter(name=>/^monitor-consult-c1-.+\.json$/.test(name)).map(name=>read(task(f,name)));
  assert.deepEqual(monitors.map(m=>m.executor).sort(),['sol','sonnet']);
  assert.equal(monitors.every(m=>m.role==='review'&&m.declares_success===false&&m.task_phase===null),true);
 }
});

test('dual_review on a standard Grok round is still both reviewers',async t=>{
 const f=adaptive(t,{strategy:'dual_review',reason:'operator asked for both'});
 f.begin();f.finish();
 const {c}=await delegate(f);
 assert.deepEqual(c.members.map(m=>m.executor),['sol','sonnet']);
});

test('Luna stays with Sonnet and Haiku stays with Sol when the grade is raised',async t=>{
 const luna=adaptive(t,{executor:'luna',criticality:'important',strategy:'dual_review',executors:{sonnet:{reasoning_effort:'low'}}});
 luna.begin();luna.finish();
 assert.throws(()=>run(luna.root,'delegate-review',{executors:['sol']}),/controller plan/);
 const lunad=await delegate(luna);
 assert.deepEqual(lunad.c.members.map(m=>m.executor),['sonnet']);
 const claude=args(luna,'claude');
 assert.equal(claude[claude.indexOf('--effort')+1],'high');
 const haiku=adaptive(t,{executor:'haiku',criticality:'apex',strategy:'dual_review'});
 haiku.begin();haiku.finish();
 assert.throws(()=>run(haiku.root,'delegate-review',{executors:['sonnet']}),/controller plan/);
 const haikud=await delegate(haiku);
 assert.deepEqual(haikud.c.members.map(m=>m.executor),['sol']);
});

test('a missing Sol is not replaced',async t=>{
 const f=adaptive(t,{executor:'haiku'});
 f.begin();f.finish();
 process.env.HF_CODEX_BIN=path.join(f.temp,'missing-codex.mjs');
 assert.throws(()=>run(f.root,'delegate-review',{}),/ADAPTER_UNAVAILABLE/);
 assert.equal(f.state().phase,'REVIEW');
 assert.equal(f.state().open_consult??null,null);
 assert.equal(fs.existsSync(task(f,'review-plan-1.json')),false);
});

test('repo config and a rewritten state assignment cannot shrink the panel',async t=>{
 const f=adaptive(t,{criticality:'important',reason:'frozen'});
 f.begin();f.finish();
 fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({review:{by:'delegate',strategy:'lead-gated-adaptive',reviewers:['haiku']}}));
 const s=f.state();
 s.assignment={...s.assignment,criticality:'standard'};
 atomic(path.join(f.control,'state.json'),s);
 assert.throws(()=>run(f.root,'delegate-review',{}),/controller record/);
 assert.equal(read(task(f,'assignment.json')).criticality,'important');
});

test('both redos are applied once, and a Sol crash does not promote Sonnet',async t=>{
 const redo=adaptive(t,{criticality:'important',reason:'two reviewers'});
 redo.begin();redo.finish();redo.mode('review-redo');
 const redone=await delegate(redo);
 assert.equal(redone.out.review.status,'lead_gate');
 assert.equal(redone.out.review.verdict,'redo');
 assert.equal(redone.out.review.pass_forbidden,true);
 assert.equal(redo.state().phase,'LEAD_DECISION_REQUIRED');
 assert.equal(redo.state().reviews.length,0);
 assert.throws(()=>decide(redo),/every mandatory review/);
 assert.equal(redo.state().phase,'LEAD_DECISION_REQUIRED');
 decide(redo,{decision:'REDO',rationale:'Both reviewers rejected AC1'});
 assert.equal(redo.state().phase,'REDO');
 assert.equal(redo.state().reviews.length,1);
 assert.equal(redo.state().reviews[0].reviewed_by,'lead');
 assert.deepEqual(redo.state().review_results[1].map(r=>r.verdict),['redo','redo']);
 const crashed=adaptive(t,{criticality:'important',reason:'sol down'});
 crashed.begin();crashed.finish();crashed.mode('codex-crash');
 const first=await delegate(crashed);
 assert.equal(first.out.review.status,'lead_gate');
 assert.equal(first.out.review.panel_status,'reviewer_failed');
 assert.equal(first.out.review.pass_forbidden,true);
 assert.equal(crashed.state().phase,'LEAD_DECISION_REQUIRED');
 assert.equal(crashed.state().reviews.length,0);
 assert.equal(crashed.state().review_results[1].find(r=>r.executor==='sonnet').verdict,'pass');
 assert.equal(crashed.state().review_results[1].find(r=>r.executor==='sol').ok,false);
 assert.throws(()=>run(crashed.root,'delegate-review',{}),/Invalid phase/);
 assert.throws(()=>crashed.review('pass'),/Invalid phase/);
 assert.throws(()=>decide(crashed),/every mandatory review/);
 decide(crashed,{decision:'REDO',rationale:'Sol did not finish'});
 assert.equal(crashed.state().phase,'REDO');
 assert.equal(crashed.state().owner,'grok');
 assert.equal(crashed.state().implement_grant??null,null);
});

test('after Grok is replaced by Sonnet, the new round is reviewed by Sol',async t=>{
 const f=adaptive(t);
 f.begin();f.finish();
 f.mode('review-alt');
 const first=await delegate(f);
 assert.equal(first.out.review.status,'lead_gate');
 assert.equal(first.out.review.verdict,'alternative');
 assert.equal(f.state().phase,'LEAD_DECISION_REQUIRED');
 f.mode('ok');
 assert.throws(()=>f.begin({executor:'sonnet'}),/Invalid phase/);
 const reassigned=decide(f,{decision:'REASSIGN_TO_SONNET',rationale:'specialist repair'});
 assert.equal(reassigned.phase,'ALTERNATIVE_REQUIRED');
 assert.equal(reassigned.lead_decision.required_reviewer,'sol');
 assert.equal(f.state().writer,null);
 assert.equal(f.state().implement_grant.executor,'sonnet');
 assert.equal(f.state().implement_grant.round,null);
 f.begin({executor:'sonnet'});
 f.finish();
 assert.equal(f.state().owner,'sonnet');
 assert.throws(()=>run(f.root,'delegate-review',{executors:['sonnet']}),/controller plan/);
 const second=await delegate(f);
 assert.deepEqual(second.c.members.map(m=>m.executor),['sol']);
 const plan=read(task(f,'review-plan-2.json'));
 assert.equal(plan.owner,'sonnet');
 assert.deepEqual(plan.reviewers,['sol']);
 assert.equal(second.out.review.status,'lead_gate');
 assert.equal(f.state().phase,'LEAD_DECISION_REQUIRED');
 assert.equal(f.state().owner,'sonnet');
});

test('auto_apply off still stops at the lead gate and adopt cannot apply the panel',async t=>{
 const f=adaptive(t,{review:{auto_apply:false}});
 f.begin();f.finish();
 const {out}=await delegate(f);
 assert.equal(out.review.status,'lead_gate');
 assert.equal(f.state().phase,'LEAD_DECISION_REQUIRED');
 assert.equal(f.state().pending_review??null,null);
 assert.throws(()=>f.review('pass'),/Invalid phase/);
 assert.throws(()=>run(f.root,'review',{adopt:true}),/Invalid phase/);
 const s=decide(f);
 assert.equal(s.phase,'VERIFY');
 assert.equal(f.state().reviews.length,0);
 assert.equal(read(task(f,'lead-decision-1.json')).baseline_digest,f.state().post_digest);
 assert.equal(read(task(f,'lead-packet-1.json')).diff,undefined);
});
