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
test('UI goes to Antigravity; unclassified work uses fallback order',t=>{const f=fixture(t,{initialize:false});const c=config(f.root);assert.equal(route(f.root,c,{task_kind:'ui'}).executor,'antigravity');assert.deepEqual(route(f.root,c,{}).candidates,['sonnet','grok','antigravity','haiku','luna']);});
test('uninstalled worker is skipped with a recorded reason',t=>{const f=fixture(t,{initialize:false});process.env.HF_CLAUDE_BIN=path.join(f.temp,'missing');const r=route(f.root,config(f.root),{task_kind:'code',difficulty:'high'});assert.equal(r.executor,'grok');assert.ok('sonnet' in r.unavailable);assert.match(r.reason,/skipped/);});
test('no installed worker fails loudly instead of falling back to the lead',t=>{const f=fixture(t,{initialize:false});for(const k of ['HF_CLAUDE_BIN','HF_GROK_BIN','HF_AGY_BIN','HF_CODEX_BIN'])process.env[k]=path.join(f.temp,'missing');assert.throws(()=>init(f),/ADAPTER_UNAVAILABLE/);assert.ok(!fs.existsSync(path.join(f.control,'state.json')));});
test('explicit choice overrides router but keeps its order as backup',t=>{const f=fixture(t,{initialize:false});const s=run(f.root,'init',{...f.brief,executor:'antigravity',task_kind:'code',difficulty:'high'});assert.equal(s.initial_executor,'antigravity');assert.deepEqual(s.routing.candidates,['antigravity','sonnet','grok','haiku','luna']);assert.match(s.routing.reason,/router suggested sonnet/);});
test('alternative without a name sends the next worker in routing order',t=>{const f=fixture(t,{initialize:false});init(f,{task_kind:'code',difficulty:'high'});f.begin();f.finish();f.review('alternative');assert.equal(f.begin().executor,'grok');f.finish();f.review('alternative');assert.equal(f.begin().executor,'antigravity');f.finish();f.review('alternative');assert.equal(f.begin().executor,'haiku');f.finish();f.review('alternative');assert.equal(f.begin().executor,'luna');f.finish();f.review('alternative');assert.equal(f.begin().executor,'sonnet');assert.ok(f.state().attempts.sonnet===2);});
test('repeat offender is replaced by the next routed worker',t=>{const f=fixture(t,{initialize:false});init(f,{task_kind:'code',difficulty:'medium'});f.begin();f.finish();f.review('redo',['AC1']);f.begin();f.finish();assert.equal(f.review('redo',['AC1']).phase,'ALTERNATIVE_REQUIRED');assert.equal(f.begin().executor,'grok');});
test('poor track record demotes a worker for that task kind',t=>{
 const f=fixture(t,{initialize:false});
 const dir=path.join(f.control,'metrics');fs.mkdirSync(dir,{recursive:true});
 for(let i=0;i<3;i++)fs.writeFileSync(path.join(dir,`old-${i}.json`),JSON.stringify({task_kind:'code',difficulty:'high',success:false,review_outcomes:[{owner:'sonnet',verdict:'redo'},{owner:'grok',verdict:'pass'}]}));
 // 이 테스트는 강등만 본다. 4번째 작업이라 켜져 있으면 신입 우대가 먼저 나선다.
 fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({routing:{newcomer_every:0}}));
 const r=route(f.root,config(f.root),{task_kind:'code',difficulty:'high'});
 assert.equal(r.executor,'grok');assert.equal(r.candidates.at(-1),'sonnet');assert.match(r.reason,/demoted.*sonnet 0\/3/);
 assert.equal(route(f.root,config(f.root),{task_kind:'ui'}).executor,'antigravity');
});
test('learning can be switched off',t=>{const f=fixture(t,{initialize:false});fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({routing:{learn:false}}));const dir=path.join(f.control,'metrics');fs.mkdirSync(dir,{recursive:true});for(let i=0;i<3;i++)fs.writeFileSync(path.join(dir,`old-${i}.json`),JSON.stringify({task_kind:'code',review_outcomes:[{owner:'sonnet',verdict:'redo'}]}));assert.equal(route(f.root,config(f.root),{task_kind:'code',difficulty:'high'}).executor,'sonnet');});
test('custom routing rules replace the defaults',t=>{const f=fixture(t,{initialize:false});fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({routing:{rules:[{kind:'image-asset',executors:['luna']},{executors:['grok']}]}}));assert.equal(init(f,{task_kind:'image-asset'}).initial_executor,'luna');});
test('image assets never go to workers without image generation',t=>{const f=fixture(t,{initialize:false});process.env.HF_GROK_BIN=path.join(f.temp,'missing');const r=route(f.root,config(f.root),{task_kind:'image-asset'});assert.equal(r.executor,'luna');assert.deepEqual(r.candidates,['luna']);fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({routing:{rules:[{executors:['antigravity','sonnet','grok','luna']}]}}));assert.deepEqual(route(f.root,config(f.root),{task_kind:'image-asset'},{probe:false}).candidates,['grok','luna']);fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({routing:{rules:[{kind:'image-asset',executors:['grok','antigravity']},{executors:['grok']}]}}));assert.throws(()=>config(f.root),/config/i);});
test('invalid task_kind and routing rules are rejected',t=>{const f=fixture(t,{initialize:false});assert.throws(()=>init(f,{task_kind:'video'}),/task_kind/);fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({routing:{rules:[{executors:['claude']}]}}));assert.throws(()=>config(f.root),/Invalid/);});
test('metrics record routing and outcomes so the router can learn',async t=>{const f=fixture(t,{initialize:false});init(f,{task_kind:'code',difficulty:'high'});f.begin();await f.bridge();f.review('pass');const m=measure(f.root);assert.equal(m.task_kind,'code');assert.equal(m.routed_executor,'sonnet');assert.deepEqual(m.review_outcomes,[{owner:'sonnet',verdict:'pass',round:1,reviewed_by:'lead'}]);assert.equal(m.worker_rounds.sonnet,1);});

test('Sonnet round runs Claude Code with the Sonnet model and stdin prompt',async t=>{const f=fixture(t,{executor:'sonnet'});const d=f.begin();assert.equal(d.cli.model,'claude-sonnet-5-5');f.mode('edit');const out=await execute(f.root);f.finish(read(out.result_file));assert.equal(f.state().phase,'REVIEW');const a=read(path.join(f.temp,'fake-claude-args.json'));assert.equal(a[a.indexOf('--model')+1],'claude-sonnet-5-5');assert.ok(a.includes('--safe-mode'));assert.equal(a[a.indexOf('--permission-mode')+1],'dontAsk');});
test('Sonnet redo resumes its session',async t=>{const f=fixture(t,{executor:'sonnet'});const first=f.begin();await f.bridge();f.review('redo');const second=f.begin();assert.equal(second.cli.session_id,first.cli.session_id);assert.ok(second.cli.resume);await f.bridge();assert.equal(f.state().phase,'REVIEW');});
test('Sonnet permission denial is never success',async t=>{const f=fixture(t,{executor:'sonnet'});f.begin();f.mode('denied');await assert.rejects(()=>execute(f.root),/permission denials/);assert.ok(f.state().writer);});

// ── Haiku 일꾼, 능력(caps) 기반 배치, 신입 우대 ───────────────────────────

test('Haiku runs through the same Claude Code CLI with the Haiku model and its own session',async t=>{
 const f=fixture(t,{executor:'haiku'});const d=f.begin();assert.equal(d.cli.model,'claude-haiku-5-5');
 f.mode('edit');const out=await execute(f.root);f.finish(read(out.result_file));assert.equal(f.state().phase,'REVIEW');
 const a=read(path.join(f.temp,'fake-claude-args.json'));assert.equal(a[a.indexOf('--model')+1],'claude-haiku-5-5');
 assert.equal(f.state().sessions.haiku,d.cli.session_id);assert.equal(f.state().sessions.sonnet,null);
});

test('easy code and docs list Haiku right after the first pick',t=>{
 const f=fixture(t,{initialize:false});const c=config(f.root);
 assert.deepEqual(route(f.root,c,{task_kind:'code',difficulty:'low'}).candidates.slice(0,2),['grok','haiku']);
 assert.deepEqual(route(f.root,c,{task_kind:'docs'}).candidates.slice(0,2),['antigravity','haiku']);
});

const writeConfig=(f,v)=>fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify(v));

test('capabilities, not names, decide who may take a task kind',t=>{
 const f=fixture(t,{initialize:false});
 // Haiku를 이미지 작업에 넣을 수 없다(기본 능력에 image-gen 없음).
 assert.ok(!route(f.root,config(f.root),{task_kind:'image-asset'}).candidates.includes('haiku'));
 // 설정으로 능력을 선언하면 규칙을 고치지 않아도 후보가 된다(예: 이미지 생성이 되는 새 모델).
 writeConfig(f,{executors:{haiku:{caps:['code','image-gen']}}});
 const r=route(f.root,config(f.root),{task_kind:'image-asset'});
 assert.deepEqual(r.candidates,['grok','luna','haiku']);
 // 능력을 빼면 그 종류의 작업에서 빠지고, 이유가 남는다.
 writeConfig(f,{executors:{antigravity:{caps:['code']}},routing:{rules:[{executors:['sonnet','grok','antigravity']}]}});
 const ui=route(f.root,config(f.root),{task_kind:'ui'});
 assert.ok(!ui.candidates.includes('antigravity'));assert.match(ui.reason,/lacks ui: antigravity/);
});

test('rules and caps are validated together',t=>{
 const f=fixture(t,{initialize:false});
 writeConfig(f,{executors:{haiku:{caps:['code','telepathy']}}});assert.throws(()=>config(f.root),/Invalid HyperFusion configuration/);
 writeConfig(f,{routing:{rules:[{kind:'image-asset',executors:['haiku']},{executors:['sonnet']}]}});assert.throws(()=>config(f.root),/Invalid HyperFusion configuration/,'a rule nobody on it can serve');
 writeConfig(f,{executors:{haiku:{caps:['code']}}});assert.doesNotThrow(()=>config(f.root),'narrowing caps does not require editing the rule table');
 writeConfig(f,{executors:{haiku:{caps:['image-gen']}},routing:{rules:[{kind:'image-asset',executors:['haiku']},{executors:['sonnet']}]}});assert.doesNotThrow(()=>config(f.root));
});

// 지표 파일 하나: 이 일꾼이 같은 종류·난이도 작업을 첫 라운드에 통과했다.
const passed=(f,name,executor,kind='code',difficulty='low')=>{
 const dir=path.join(f.control,'metrics');fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,name+'.json'),JSON.stringify({task_kind:kind,difficulty,initial_executor:executor,ended_at:new Date().toISOString(),review_outcomes:[{owner:executor,verdict:'pass',round:1}]}));
};

test('a newcomer without a track record gets an occasional first pick (cold start)',t=>{
 const f=fixture(t,{initialize:false});const c=config(f.root);
 // grok에게 실적 3건. 다음(4번째) 작업은 newcomer_every=4라 표본이 가장 적은 신입이 먼저 나선다.
 for(let i=0;i<3;i++)passed(f,'g'+i,'grok');
 const r=route(f.root,c,{task_kind:'code',difficulty:'low'});
 assert.equal(r.executor,'haiku');assert.match(r.reason,/newcomer trial first pick: haiku/);assert.equal(r.candidates[1],'grok');
 // 그 밖의 작업에서는 평소 순서다.
 passed(f,'g3','grok');
 assert.equal(route(f.root,c,{task_kind:'code',difficulty:'low'}).executor,'grok');
 // 끄면 신입 우대도 없다.
 writeConfig(f,{routing:{newcomer_every:0}});for(let i=4;i<7;i++)passed(f,'g'+i,'grok');
 assert.equal(route(f.root,config(f.root),{task_kind:'code',difficulty:'low'}).executor,'grok');
});

test('a fresh install, where nobody has a record yet, keeps the rule order',t=>{
 const f=fixture(t,{initialize:false});
 for(let i=0;i<3;i++)passed(f,'other'+i,'sonnet','tests',null);
 assert.equal(route(f.root,config(f.root),{task_kind:'code',difficulty:'low'}).executor,'grok');
});
