import test from 'node:test';
import assert from 'node:assert/strict';
import {aggregate,measure} from '../scripts/metrics.mjs';
import {fixture} from './support.mjs';

test('failed tasks contribute to Opus cost per success',()=>{const records=[{success:true,lead_takeovers:0,lead_usage:{lead_tokens:100}},{success:false,lead_takeovers:1,lead_usage:{lead_tokens:200}}];const a=aggregate(records);assert.equal(a.lead_tokens_per_success,300);assert.equal(a.lead_takeover_rate,0.5);});
test('zero successes and missing usage stay null, not zero',()=>{assert.equal(aggregate([{success:false,lead_usage:{lead_tokens:100}}]).lead_tokens_per_success,null);assert.equal(aggregate([{success:true,lead_usage:null}]).lead_tokens_per_success,null);});
test('worker rounds and cost are tracked separately from the lead',async t=>{const f=fixture(t);f.begin();await f.bridge();const v=measure(f.root,{source:'test accounting',lead_tokens:100});assert.equal(v.lead_usage.lead_tokens,100);assert.equal(v.worker_rounds.grok,1);assert.equal(v.worker_cost_estimate_usd,0.002);assert.equal(v.lead_tokens_per_success,null);});
test('lead cost is also split by difficulty, so low-difficulty overhead can be judged from data',()=>{
 const a=aggregate([
  {success:true,difficulty:'low',lead_takeovers:0,lead_usage:{lead_tokens:900},diff_lines:2},
  {success:true,difficulty:'low',lead_takeovers:0,lead_usage:{lead_tokens:1100},diff_lines:4},
  {success:true,difficulty:'high',lead_takeovers:0,lead_usage:{lead_tokens:5000},diff_lines:300},
  {success:false,lead_takeovers:0,lead_usage:{lead_tokens:100}}]);
 assert.equal(a.by_difficulty.low.lead_tokens_per_success,1000);
 assert.equal(a.by_difficulty.low.median_diff_lines,4);
 assert.equal(a.by_difficulty.high.tasks,1);
 assert.equal(a.by_difficulty.unset.successful_tasks,0);
});
test('each task records how many lines it changed',async t=>{
 const f=fixture(t);f.mode('edit');f.begin();await f.bridge();
 assert.equal(measure(f.root).diff_lines,2,'a.txt: one line removed, one added');
});
