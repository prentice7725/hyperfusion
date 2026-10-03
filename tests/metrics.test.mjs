import test from 'node:test';
import assert from 'node:assert/strict';
import {aggregate,measure} from '../scripts/metrics.mjs';
import {fixture} from './support.mjs';

test('failed tasks contribute to Opus cost per success',()=>{const records=[{success:true,lead_takeovers:0,lead_usage:{lead_tokens:100}},{success:false,lead_takeovers:1,lead_usage:{lead_tokens:200}}];const a=aggregate(records);assert.equal(a.lead_tokens_per_success,300);assert.equal(a.lead_takeover_rate,0.5);});
test('zero successes and missing usage stay null, not zero',()=>{assert.equal(aggregate([{success:false,lead_usage:{lead_tokens:100}}]).lead_tokens_per_success,null);assert.equal(aggregate([{success:true,lead_usage:null}]).lead_tokens_per_success,null);});
test('worker rounds and cost are tracked separately from the lead',async t=>{const f=fixture(t);f.begin();await f.bridge();const v=measure(f.root,{source:'test accounting',lead_tokens:100});assert.equal(v.lead_usage.lead_tokens,100);assert.equal(v.worker_rounds.grok,1);assert.equal(v.worker_cost_estimate_usd,0.002);assert.equal(v.lead_tokens_per_success,null);});
