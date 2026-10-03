import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {route} from '../scripts/router.mjs';
import {config} from '../scripts/executor-config.mjs';
import {execute} from '../scripts/executor-bridge.mjs';
import {measure} from '../scripts/metrics.mjs';
import {read} from '../scripts/artifact.mjs';

const init=(f,extra)=>run(f.root,'init',{...f.brief,executor:'auto',...extra});

test('image assets go to Grok',t=>{const f=fixture(t,{initialize:false});const s=init(f,{task_kind:'image-asset'});assert.equal(s.initial_executor,'grok');assert.equal(s.routing.mode,'auto');assert.match(s.routing.reason,/image-asset/);});
test('medium and hard code goes to Sonnet, easy code to Grok',t=>{const f=fixture(t,{initialize:false});const c=config(f.root);assert.equal(route(f.root,c,{task_kind:'code',difficulty:'high'}).executor,'sonnet');assert.equal(route(f.root,c,{task_kind:'code',difficulty:'medium'}).executor,'sonnet');assert.equal(route(f.root,c,{task_kind:'code',difficulty:'low'}).executor,'grok');});
test('UI goes to Antigravity; unclassified work uses fallback order',t=>{const f=fixture(t,{initialize:false});const c=config(f.root);assert.equal(route(f.root,c,{task_kind:'ui'}).executor,'antigravity');assert.deepEqual(route(f.root,c,{}).candidates,['sonnet','grok','antigravity']);});
test('uninstalled worker is skipped with a recorded reason',t=>{const f=fixture(t,{initialize:false});process.env.HF_CLAUDE_BIN=path.join(f.temp,'missing');const r=route(f.root,config(f.root),{task_kind:'code',difficulty:'high'});assert.equal(r.executor,'grok');assert.ok('sonnet' in r.unavailable);assert.match(r.reason,/skipped/);});
test('no installed worker fails loudly instead of falling back to the lead',t=>{const f=fixture(t,{initialize:false});for(const k of ['HF_CLAUDE_BIN','HF_GROK_BIN','HF_AGY_BIN'])process.env[k]=path.join(f.temp,'missing');assert.throws(()=>init(f),/ADAPTER_UNAVAILABLE/);assert.ok(!fs.existsSync(path.join(f.root,'.fusion/state.json')));});
test('explicit choice overrides router but keeps its order as backup',t=>{const f=fixture(t,{initialize:false});const s=run(f.root,'init',{...f.brief,executor:'antigravity',task_kind:'code',difficulty:'high'});assert.equal(s.initial_executor,'antigravity');assert.deepEqual(s.routing.candidates,['antigravity','sonnet','grok']);assert.match(s.routing.reason,/router suggested sonnet/);});
test('alternative without a name sends the next worker in routing order',t=>{const f=fixture(t,{initialize:false});init(f,{task_kind:'code',difficulty:'high'});f.begin();f.finish();f.review('alternative');assert.equal(f.begin().executor,'grok');f.finish();f.review('alternative');assert.equal(f.begin().executor,'antigravity');f.finish();f.review('alternative');assert.equal(f.begin().executor,'sonnet');assert.ok(f.state().attempts.sonnet===2);});
test('repeat offender is replaced by the next routed worker',t=>{const f=fixture(t,{initialize:false});init(f,{task_kind:'code',difficulty:'medium'});f.begin();f.finish();f.review('redo',['AC1']);f.begin();f.finish();assert.equal(f.review('redo',['AC1']).phase,'ALTERNATIVE_REQUIRED');assert.equal(f.begin().executor,'grok');});
test('poor track record demotes a worker for that task kind',t=>{
 const f=fixture(t,{initialize:false});
 const dir=path.join(f.root,'.fusion/metrics');fs.mkdirSync(dir,{recursive:true});
 for(let i=0;i<3;i++)fs.writeFileSync(path.join(dir,`old-${i}.json`),JSON.stringify({task_kind:'code',success:false,review_outcomes:[{owner:'sonnet',verdict:'redo'},{owner:'grok',verdict:'pass'}]}));
 const r=route(f.root,config(f.root),{task_kind:'code',difficulty:'high'});
 assert.equal(r.executor,'grok');assert.equal(r.candidates.at(-1),'sonnet');assert.match(r.reason,/demoted.*sonnet 0\/3/);
 assert.equal(route(f.root,config(f.root),{task_kind:'ui'}).executor,'antigravity');
});
test('learning can be switched off',t=>{const f=fixture(t,{initialize:false});fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({routing:{learn:false}}));const dir=path.join(f.root,'.fusion/metrics');fs.mkdirSync(dir,{recursive:true});for(let i=0;i<3;i++)fs.writeFileSync(path.join(dir,`old-${i}.json`),JSON.stringify({task_kind:'code',review_outcomes:[{owner:'sonnet',verdict:'redo'}]}));assert.equal(route(f.root,config(f.root),{task_kind:'code',difficulty:'high'}).executor,'sonnet');});
test('custom routing rules replace the defaults',t=>{const f=fixture(t,{initialize:false});fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({routing:{rules:[{kind:'image-asset',executors:['antigravity']},{executors:['grok']}]}}));assert.equal(init(f,{task_kind:'image-asset'}).initial_executor,'antigravity');});
test('invalid task_kind and routing rules are rejected',t=>{const f=fixture(t,{initialize:false});assert.throws(()=>init(f,{task_kind:'video'}),/task_kind/);fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({routing:{rules:[{executors:['claude']}]}}));assert.throws(()=>config(f.root),/Invalid/);});
test('metrics record routing and outcomes so the router can learn',async t=>{const f=fixture(t,{initialize:false});init(f,{task_kind:'code',difficulty:'high'});f.begin();await f.bridge();f.review('pass');const m=measure(f.root);assert.equal(m.task_kind,'code');assert.equal(m.routed_executor,'sonnet');assert.deepEqual(m.review_outcomes,[{owner:'sonnet',verdict:'pass',round:1}]);assert.equal(m.worker_rounds.sonnet,1);});

test('Sonnet round runs Claude Code with the Sonnet model and stdin prompt',async t=>{const f=fixture(t,{executor:'sonnet'});const d=f.begin();assert.equal(d.cli.model,'claude-sonnet-5-5');f.mode('edit');const out=await execute(f.root);f.finish(read(out.result_file));assert.equal(f.state().phase,'REVIEW');const a=read(path.join(f.root,'.fusion/fake-claude-args.json'));assert.equal(a[a.indexOf('--model')+1],'claude-sonnet-5-5');assert.ok(a.includes('--safe-mode'));assert.equal(a[a.indexOf('--permission-mode')+1],'dontAsk');});
test('Sonnet redo resumes its session',async t=>{const f=fixture(t,{executor:'sonnet'});const first=f.begin();await f.bridge();f.review('redo');const second=f.begin();assert.equal(second.cli.session_id,first.cli.session_id);assert.ok(second.cli.resume);await f.bridge();assert.equal(f.state().phase,'REVIEW');});
test('Sonnet permission denial is never success',async t=>{const f=fixture(t,{executor:'sonnet'});f.begin();f.mode('denied');await assert.rejects(()=>execute(f.root),/permission denials/);assert.ok(f.state().writer);});
