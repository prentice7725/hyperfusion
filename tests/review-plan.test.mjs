import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {planReview,takeAssignment,aggregateVerdicts} from '../scripts/review-plan.mjs';
import {config} from '../scripts/executor-config.mjs';
import {fixture} from './support.mjs';

const digest='abc';
const row=(executor,verdict,ok=true)=>({executor,ok,verdict,digest});

test('owner and criticality choose the reviewer and never the writer',()=>{
  for(const owner of ['grok','antigravity','haiku','sonnet','lead']){
    assert.deepEqual(planReview(owner).reviewers,[owner==='lead'?'sol':'sol']);
    assert.equal(planReview(owner).reviewers.includes(owner),false);
  }
  assert.deepEqual(planReview('luna').reviewers,['sonnet']);
  assert.deepEqual(planReview('sol').reviewers,['lead']);
  assert.equal(planReview('grok').effort.sol,'medium');
  assert.equal(planReview('luna').effort.sonnet,'high');
  for(const owner of ['grok','antigravity']){
    assert.deepEqual(planReview(owner,{criticality:'important'}).reviewers,['sol','sonnet']);
    assert.deepEqual(planReview(owner,{criticality:'apex'}).reviewers,['sol','sonnet']);
    assert.deepEqual(planReview(owner,{strategy:'dual_review'}).reviewers,['sol','sonnet']);
  }
  for(const owner of ['haiku','luna','sonnet']){
    const raised=planReview(owner,{criticality:'important',strategy:'dual_review'});
    assert.equal(raised.reviewers.includes(owner),false);
    assert.equal(owner==='luna'?raised.reviewers.includes('sol'):raised.reviewers.includes('sonnet'),false);
  }
});

test('a split verdict or a different digest is not a pass',()=>{
  assert.equal(aggregateVerdicts([row('sol','pass'),row('sonnet','pass')]).status,'unanimous');
  assert.equal(aggregateVerdicts([row('sol','pass'),row('sonnet','redo')]).status,'conflict');
  assert.equal(aggregateVerdicts([row('sol','pass'),{executor:'sonnet',ok:false,verdict:null,digest}]).status,'reviewer_failed');
  assert.equal(aggregateVerdicts([row('sol','pass'),{...row('sonnet','pass'),digest:'other'}]).status,'conflict');
  assert.equal(aggregateVerdicts([row('sol','pass')]).verdict,'pass');
});

test('assignment is accepted only with the opt-in strategy',t=>{
  const adaptive={review:{strategy:'lead-gated-adaptive'}};
  const input={task_criticality:'important',assignment_strategy:'dual_review',assignment_reason:'payments'};
  const got=takeAssignment(adaptive,input);
  assert.equal(got.criticality,'important');
  assert.equal(input.task_criticality,undefined);
  assert.throws(()=>takeAssignment({review:{}},{task_criticality:'important'}),/lead-gated-adaptive/);
  assert.throws(()=>takeAssignment(adaptive,{assignment_strategy:'sol_apex'}),/apex/);
  assert.throws(()=>takeAssignment(adaptive,{assignment_strategy:'explicit_repair'}),/not enabled/);
  assert.throws(()=>takeAssignment(adaptive,{task_criticality:'standard',assignment_strategy:'sonnet_implementation',assignment_reason:'no'}),/important/);
  const sol=takeAssignment(adaptive,{task_criticality:'apex',assignment_strategy:'sol_apex',assignment_reason:'schema change'});
  assert.equal(sol.authorized_implementer,'sol');
  assert.equal(sol.criticality,'apex');
  const sonnet=takeAssignment(adaptive,{task_criticality:'important',assignment_strategy:'sonnet_implementation',assignment_reason:'specialist'});
  assert.equal(sonnet.authorized_implementer,'sonnet');
  const f=fixture(t,{initialize:false});
  fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({review:{strategy:'custom'}}));
  assert.throws(()=>config(f.root),/Invalid/);
  fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({review:{strategy:'lead-gated-adaptive',by_owner:{luna:['sol']}}}));
  assert.throws(()=>config(f.root),/Invalid/);
});
