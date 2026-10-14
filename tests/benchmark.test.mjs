import test from 'node:test';
import assert from 'node:assert/strict';
import {CASES,comparePilot} from '../scripts/benchmark.mjs';
const rows=(tokens,success=true)=>CASES.map(c=>({case_id:c.case_id,success,initial_tree:'tree-'+c.case_id,fixture_id:'fixture-'+c.case_id,lead_usage:{lead_tokens:tokens,scope:'benchmark-window',by_model:{'claude-opus-5-5':{components:{input_tokens:tokens,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}}}},claude_total_tokens:tokens,claude_usage:{opus:tokens,sonnet:0,haiku:0},lead_takeovers:0}));
test('a paired pilot compares actual costs and includes failed task costs',()=>{
 const base=rows(100),hf=rows(50);hf[0].success=false;
 const out=comparePilot(base,hf);assert.equal(out.status,'measured-pilot');assert.equal(out.expected_pairs,10);
 assert.equal(out.hyperfusion.lead_tokens_per_success,500/9);assert.equal(out.lead_token_reduction,1-(500/9)/100);
});
test('missing results, unknown usage and incompatible measurement windows do not imply savings',()=>{
 assert.equal(comparePilot([],[]).lead_token_reduction,null);
 const hf=rows(50);hf[0].lead_usage=null;assert.equal(comparePilot(rows(100),hf).status,'incomplete');
 delete hf[0].lead_usage;assert.equal(comparePilot(rows(100),hf).baseline.usage_coverage,1);assert.equal(comparePilot(rows(100),hf).hyperfusion.lead_tokens_per_success,null);
 hf[0].lead_usage={lead_tokens:50,scope:'controller-window'};assert.equal(comparePilot(rows(100),hf).total_claude_token_reduction,null);
});
test('no successes or duplicate case IDs cannot produce a favorable comparison',()=>{
 assert.equal(comparePilot(rows(100),rows(50,false)).lead_token_reduction,null);
 assert.throws(()=>comparePilot([rows(100)[0],rows(100)[0]],[]),/duplicate/);
});
