import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {consult,execute} from '../scripts/executor-bridge.mjs';
import {read} from '../scripts/artifact.mjs';
import {config} from '../scripts/executor-config.mjs';
import {route} from '../scripts/router.mjs';
import {implementDispatch} from '../scripts/review-plan.mjs';
import {measure,refreshHostUsage} from '../scripts/metrics.mjs';
import {summarizeUsage} from '../scripts/usage-accounting.mjs';
import {modelEffort,selectAgyModel} from '../scripts/adapters/agy-model.mjs';
const write=(f,options,extra={})=>fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({executors:{antigravity:options},...extra}));
function modelCLI() {
 const bin=process.env.HF_AGY_BIN;
 fs.writeFileSync(bin,fs.readFileSync(bin,'utf8').replace('const args=process.argv.slice(2);',"const args=process.argv.slice(2);if(args.includes('--help'))console.log('--model <id>');"));
}
test('Argon family and effort resolve to one model slug, never duplicate --effort',()=>{
 assert.deepEqual(selectAgyModel({model:'gemini-4-argon',reasoning_effort:'high'}),{model:'gemini-4-argon-high',model_family:'gemini-4-argon',reasoning_effort:'high',effort_flag:null});
 assert.equal(modelEffort('gemini-4-argon-medium'),'medium');
 assert.throws(()=>selectAgyModel({model:'gemini-4-argon-medium',reasoning_effort:'high'}),/EFFORT_CONFLICT/);
 assert.throws(()=>selectAgyModel({model:'gemini-4-argon',reasoning_effort:'max'}),/EFFORT_UNSUPPORTED/);
 assert.equal(selectAgyModel({model:'custom-model',reasoning_effort:'low'}).effort_flag,'low');
 assert.equal(selectAgyModel({model:'claude-sonnet-5-5-medium',reasoning_effort:'max'}).effort_flag,'max');
});
test('pinned effort beats defaults and difficulty automation, while explicit conflicts fail',t=>{
 const f=fixture(t,{initialize:false});write(f,{model:'gemini-4-argon-medium'}, {review:{strategy:'lead-gated-adaptive'}});
 const c=config(f.root);assert.equal(c.executors.antigravity.reasoning_effort,'medium');assert.equal(c.effort_source.antigravity,'model');
 assert.equal(implementDispatch({configuration:c,routing:{difficulty:'high'}},'antigravity').options.reasoning_effort,'medium');
 write(f,{model:'gemini-4-argon-medium',reasoning_effort:'high'});assert.throws(()=>config(f.root),/EFFORT_CONFLICT/);
 write(f,{model:'gemini-4-argon-medium',reasoning_effort:null});assert.equal(config(f.root).effort_source.antigravity,'cli-default');
 assert.equal(selectAgyModel(config(f.root).executors.antigravity).reasoning_effort,'medium');
});
test('model maps are AGY-only family maps and respect separate effort selection',t=>{
 const f=fixture(t,{initialize:false}),map={low:'gemini-3.8-flash',high:'gemini-4-argon'};
 write(f,{models_by_difficulty:map},{review:{strategy:'lead-gated-adaptive'}});const c=config(f.root);
 const low=implementDispatch({configuration:c,routing:{difficulty:'low'}},'antigravity').options;
 assert.equal(low.model,'gemini-3.8-flash');assert.equal(low.reasoning_effort,'low');assert.equal(low.models_by_difficulty,undefined);
 const high=implementDispatch({configuration:c,routing:{difficulty:'high'}},'antigravity').options;
 assert.equal(selectAgyModel(high).model,'gemini-4-argon-high');
 write(f,{models_by_difficulty:map,reasoning_effort:'medium'});assert.equal(implementDispatch({configuration:config(f.root),routing:{difficulty:'high'}},'antigravity').options.reasoning_effort,'medium');
 for(const invalid of [{},{extreme:'gemini-4-argon'},{high:'gemini-4-argon-high'}]){write(f,{models_by_difficulty:invalid});assert.throws(()=>config(f.root),/configuration/);}
 fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({executors:{grok:{models_by_difficulty:map}}}));assert.throws(()=>config(f.root),/configuration/);
});
test('routing checks the chosen difficulty profile, not an unrelated fallback model',t=>{
 const f=fixture(t,{initialize:false});modelCLI();write(f,{model:'missing-model',models_by_difficulty:{high:'gemini-4-argon',low:'missing-low'}},{routing:{policy:'external-first'}});
 const c=config(f.root),high=route(f.root,c,{task_kind:'ui',difficulty:'high'});
 assert.equal(high.executor,'antigravity');assert.equal(high.unavailable.antigravity,undefined);
 assert.match(route(f.root,c,{task_kind:'ui',difficulty:'low'}).unavailable.antigravity,/MODEL_UNLISTED/);
});
test('resolved Argon model is checked before lease and retained through bridge/redo/metrics',async t=>{
 const f=fixture(t,{initialize:false});modelCLI();write(f,{model:'gemini-4-argon',reasoning_effort:'high'});
 run(f.root,'init',{...f.brief,executor:'antigravity'});const d=f.begin();
 assert.equal(d.cli.model_check.model,'gemini-4-argon-high');assert.equal(d.cli.model_check.status,'listed');
 assert.equal(d.cli.args[d.cli.args.indexOf('--model')+1],'gemini-4-argon-high');assert.ok(!d.cli.args.includes('--effort'));
 await f.bridge();f.review('redo');const redo=f.begin();assert.ok(redo.cli.resume);await f.bridge();
 const u=read(path.join(f.control,'tasks/HF-test/usage-2.json'));assert.equal(u.model_family,'gemini-4-argon');assert.equal(u.reasoning_effort,'high');
 const m=measure(f.root),key=JSON.stringify(['gemini-4-argon','high']);assert.equal(m.usage_by_model_effort[key].calls,2);assert.equal(m.usage_by_model_effort[key].tokens,40);
 const refreshed=refreshHostUsage(f.root,'HF-test',{complete:true,source_kind:'claude-transcript',lead_tokens:5,lead_model:'claude-opus-5-5'});
 assert.equal(refreshed.usage_by_model_effort[key].calls,2);
});
test('resolved unavailable Argon does not consume a lease or downgrade',t=>{
 const f=fixture(t,{initialize:false});modelCLI();write(f,{model:'gemini-4-argon',reasoning_effort:'low'});
 run(f.root,'init',{...f.brief,executor:'antigravity'});
 assert.throws(()=>f.begin(),/MODEL_UNLISTED.*gemini-4-argon-low/);assert.equal(f.state().attempts.antigravity,0);assert.equal(f.state().writer,null);
});
test('a pinned Gemini slug works without an effort flag and forged effort metadata blocks execution',async t=>{
 const f=fixture(t,{initialize:false});modelCLI();
 const binary=process.env.HF_AGY_BIN;fs.writeFileSync(binary,fs.readFileSync(binary,'utf8').replace('--effort',''));
 write(f,{model:'gemini-4-argon',reasoning_effort:'high'});run(f.root,'init',{...f.brief,executor:'antigravity'});
 const d=f.begin();assert.equal(d.cli.supports['--effort'],false);assert.equal(d.cli.model,'gemini-4-argon-high');
 const file=path.join(f.control,'tasks/HF-test/dispatch-1.json'),forged=read(file);forged.cli.reasoning_effort='medium';fs.writeFileSync(file,JSON.stringify(forged));
 await assert.rejects(()=>execute(f.root),/DISPATCH_TAMPERED/);
 assert.ok(!fs.existsSync(path.join(f.control,'tasks/HF-test/launch-1.json')));
});
test('AGY review uses the same independent family/effort metadata and read-only mode',async t=>{
 const f=fixture(t,{initialize:false});modelCLI();write(f,{model:'gemini-4-argon-medium'},{review:{by:'delegate',reviewers:['antigravity']}});
 run(f.root,'init',{...f.brief,executor:'grok'});f.begin();f.finish();const d=run(f.root,'delegate-review',{});await consult(f.root,d.consult_id);
 const usage=read(path.join(f.control,'tasks/HF-test/usage-consult-c1-m1.json'));
 assert.equal(usage.role,'review');assert.equal(usage.model_family,'gemini-4-argon');assert.equal(usage.reasoning_effort,'medium');
 const args=read(path.join(f.temp,'fake-agy-args.json'));assert.equal(args[args.indexOf('--mode')+1],'plan');assert.ok(!args.includes('--effort'));
});
test('unknown/default models remain unknown and effort pairs cannot collide',()=>{
 const row={executor:'antigravity',tokens:10,cost_usd:null,reported:true,role:'implement',model:null};
 const r=summarizeUsage([row,{...row,model_family:'custom::medium',reasoning_effort:'high'},{...row,model_family:'custom',reasoning_effort:'medium::high'}]);
 assert.equal(Object.keys(r.by_model_effort).length,3);assert.equal(r.by_model_effort['[null,null]'].model_family,null);
 assert.equal(r.by_model_effort['[null,null]'].cost_usd,null);
});
