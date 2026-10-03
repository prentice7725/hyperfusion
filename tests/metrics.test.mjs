
import test from 'node:test';
import assert from 'node:assert/strict';
import {aggregate,measure} from '../scripts/metrics.mjs';
import {fixture} from './support.mjs';
test('failed tasks contribute to Codex cost per success',()=>{const records=[{success:true,codex_usage:{lead_tokens:100,total_tokens:120}},{success:false,codex_usage:{lead_tokens:200,total_tokens:250}}];assert.equal(aggregate(records).codex_tokens_per_success,370);assert.equal(aggregate(records).astra_tokens_per_success,300);});
test('zero successes and missing usage stay undefined, not zero',()=>{assert.equal(aggregate([{success:false,codex_usage:{lead_tokens:100,total_tokens:100}}]).codex_tokens_per_success,null);assert.equal(aggregate([{success:true,codex_usage:null}]).codex_tokens_per_success,null);});
test('usage counts both Astra and Luna but does not guess external cost',t=>{const f=fixture(t);const v=measure(f.root,{source:'test accounting',lead_tokens:100,luna_tokens:50});assert.equal(v.codex_usage.total_tokens,150);assert.equal(v.external_cost_estimate_usd,null);assert.equal(v.codex_tokens_per_success,null);});
