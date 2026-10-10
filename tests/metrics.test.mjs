import test from 'node:test';
import assert from 'node:assert/strict';
import {aggregate,measure} from '../scripts/metrics.mjs';
import {fixture} from './support.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {collectRunUsage,summarizeUsage,reportedTokens} from '../scripts/usage-accounting.mjs';

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

test('review and failed calls, cache tokens, and Sol implementations are included without guessing',t=>{
 const f=fixture(t);const dir=path.join(f.control,'tasks',f.brief.task_id);
 const put=(name,body)=>fs.writeFileSync(path.join(dir,name),JSON.stringify(body));
 put('usage-1.json',{executor:'sol',role:'implement',model:'gpt-6.1-sol',usage:{total_tokens:10},total_cost_usd:null});
 put('usage-consult-c1-m1.json',{executor:'sonnet',role:'review',model:'claude-sonnet-5-5',usage:{input_tokens:10,output_tokens:5,cache_read_input_tokens:20,cache_creation_input_tokens:2},total_cost_usd:0.1});
 put('launch-consult-c2-m1.json',{executor:'haiku'});
 let v=measure(f.root,{source:'host test ledger',lead_tokens:100,lead_model:'claude-opus-5-5'});
 assert.equal(v.worker_rounds.sol,1);assert.equal(v.review_calls,1);
 assert.equal(v.usage_by_executor.sonnet.tokens,37);assert.equal(v.usage_by_executor.haiku.tokens,null);
 assert.equal(v.claude_usage.opus,null,'unknown failed Claude model prevents a complete family total');assert.equal(v.claude_total_tokens,null);
 assert.equal(v.worker_cost_estimate_usd,null);assert.equal(v.unreported_calls,1);
 put('usage-consult-c2-m1.json',{executor:'haiku',role:'consult',model:'claude-haiku-5-5',usage:{total_tokens:3},total_cost_usd:0.01});
 v=measure(f.root);
 assert.equal(v.lead_usage.lead_tokens,100,'automatic settlement preserves host observations');
 assert.equal(v.claude_total_tokens,140);assert.equal(v.claude_tokens_per_success,null);
 assert.equal(collectRunUsage(f.root,f.state()).length,3,'launch and usage are one call');
});

test('host identity is unknown until observed and failed Claude tasks remain in the numerator',()=>{
 assert.equal(summarizeUsage([],{lead_tokens:100}).claude.opus,null);
 assert.equal(reportedTokens({usage:{input_tokens:4}}),null);
 assert.equal(reportedTokens({usage:{input_tokens:4,output_tokens:5}}),9);
 const a=aggregate([{success:true,lead_usage:null,claude_total_tokens:100,claude_usage:{opus:50,sonnet:40,haiku:10}},{success:false,lead_usage:null,claude_total_tokens:200,claude_usage:{opus:100,sonnet:80,haiku:20}}]);
 assert.equal(a.claude_tokens_per_success,300);
 assert.deepEqual(a.claude_usage_per_success,{opus:150,sonnet:120,haiku:30});
 assert.equal(aggregate([{success:true,lead_usage:null}]).claude_tokens_per_success,null);
});

test('actual vendor model usage overrides the executor label and includes worker Opus',t=>{
 const f=fixture(t),dir=path.join(f.control,'tasks',f.brief.task_id);
 fs.writeFileSync(path.join(dir,'usage-1.json'),JSON.stringify({executor:'sonnet',model:'claude-sonnet-5-5',usage:{total_tokens:12},modelUsage:{'claude-opus-5-5':{inputTokens:2,outputTokens:3,costUSD:0.1},'claude-haiku-5-5':{inputTokens:3,outputTokens:4,costUSD:0.01}}}));
 const runs=collectRunUsage(f.root,f.state()),v=summarizeUsage(runs,{lead_tokens:100},'claude-opus-5-5');
 assert.equal(v.by_executor.sonnet.tokens,12);
 assert.equal(v.by_model['claude-opus-5-5'].tokens,5);
 assert.deepEqual(v.claude,{opus:105,sonnet:0,haiku:7});
 assert.equal(v.claude_total_tokens,112);
 assert.equal(summarizeUsage([{executor:'sonnet',model:null,tokens:12,reported:true}],{lead_tokens:100},'claude-opus-5-5').claude_total_tokens,null);
});
