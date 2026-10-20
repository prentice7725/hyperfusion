import test from 'node:test';
import assert from 'node:assert/strict';
import {CASES,compareRepeated} from '../scripts/benchmark.mjs';

const rows=(arm,tokens)=>Array.from({length:3},(_,n)=>CASES.map(c=>({case_id:c.case_id,success:true,initial_tree:'tree-'+c.case_id,fixture_id:'fixture-'+c.case_id,
 lead_usage:{lead_tokens:tokens,scope:'benchmark-window',by_model:{'claude-opus-5-5':{components:{input_tokens:tokens,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}}}},
 claude_total_tokens:tokens,claude_usage:{opus:tokens,sonnet:0,haiku:0},wall_ms:100,provider_cost_usd:tokens/1000,wrong_closes:0,escaped_regressions:0,scope_violations:0,
 comparison:{arm,repetition:n+1,order:arm==='current'?1:2,implementation_ref:arm==='current'?'v0.26.0':'candidate-commit',protocol_digest:'a'.repeat(64),cli_versions:'pinned CLI inventory',cache_conditions:'cold',quota_timeouts:'none',human_help:'none'}}))).flat();

test('thirty paired repetitions retain failed costs and raw conditions without authorizing rollout',()=>{
 const a=rows('current',100),b=rows('candidate',50);b[0].success=false;
 const result=compareRepeated(a,b);
 assert.equal(result.status,'recorded-repeated-comparison');assert.equal(result.recorded_pairs,30);
 assert.equal(result.candidate.lead_weighted_per_success,1500/29);
 assert.equal(result.candidate.provider_cost_per_success,b.reduce((n,r)=>n+r.provider_cost_usd,0)/29);
 assert.equal(result.trials[0].candidate_conditions.human_help,'none');assert.equal(result.rollout,'not_authorized');
 assert.equal(result.p95_wall_ratio,1);
});

test('missing pairs, protocol changes, implementation drift and unknown usage suppress reduction claims',()=>{
 const a=rows('current',100),b=rows('candidate',50);
 for(const change of [r=>r.pop(),r=>r[0].comparison.protocol_digest='b'.repeat(64),r=>r[0].comparison.implementation_ref='other',r=>r[0].comparison.human_help='',r=>r[0].comparison.order=1,r=>r[0].lead_usage=null]){
  const candidate=structuredClone(b);change(candidate);
  const result=compareRepeated(a,candidate);
  assert.equal(result.status,'incomplete');assert.equal(result.lead_weighted_reduction,null);assert.equal(result.provider_cost_reduction,null);assert.equal(result.p95_wall_ratio,null);
 }
});

test('unknown provider costs, wall time and independent quality remain unknown',()=>{
 const b=rows('candidate',50);delete b[0].provider_cost_usd;delete b[1].wall_ms;delete b[2].wrong_closes;
 const result=compareRepeated(rows('current',100),b);
 assert.equal(result.candidate.provider_cost_per_success,null);assert.equal(result.provider_cost_reduction,null);
 assert.equal(result.candidate.p95_wall_ms,null);assert.equal(result.candidate.quality,null);
});

test('zero observed costs are complete evidence while fractional defect counts are not',()=>{
 const a=rows('current',100),b=rows('candidate',50);
 for(const r of [...a,...b])r.provider_cost_usd=0;
 assert.equal(compareRepeated(a,b).guardrails_complete,true);
 assert.equal(compareRepeated(a,b).provider_cost_reduction,null);
 b[0].wrong_closes=0.5;
 assert.equal(compareRepeated(a,b).candidate.quality,null);
 assert.equal(compareRepeated(a,b).guardrails_complete,false);
});

test('duplicates, unknown cases, wrong arms and invalid repetition counts are rejected',()=>{
 const a=rows('current',100),b=rows('candidate',50);
 assert.throws(()=>compareRepeated([...a,a[0]],b),/Duplicate/);
 const unknown=structuredClone(a);unknown[0].case_id='unknown';assert.throws(()=>compareRepeated(unknown,b),/Unknown/);
 assert.throws(()=>compareRepeated(b,a),/arm/);
 for(const repetitions of [0,1.5,11,NaN])assert.throws(()=>compareRepeated(a,b,null,{repetitions}),/repetitions/);
});
