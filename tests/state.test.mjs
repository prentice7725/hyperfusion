
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {acquire,release} from '../scripts/writer-lease.mjs';
import {snapshot,changes} from '../scripts/artifact.mjs';
import {config,selectExecutor} from '../scripts/executor-config.mjs';

test('default starts Claude without any Luna attempt',t=>{const f=fixture(t);assert.equal(f.state().initial_executor,'claude');assert.equal(f.begin().transport,'claude-code');assert.deepEqual(f.state().attempts,{claude:1,luna:0,astra:0});});
test('CLI --executor claude persists explicit selection',t=>{const f=fixture(t,{initialize:false});const input=path.join(f.temp,'brief.json');fs.writeFileSync(input,JSON.stringify(f.brief));execFileSync(process.execPath,[new URL('../scripts/fusion-state.mjs',import.meta.url).pathname,'init',f.root,input,'--executor','claude']);assert.equal(f.state().initial_executor,'claude');});
test('unimplemented executor and auto never fall back',t=>{const f=fixture(t,{initialize:false});for(const executor of ['grok','antigravity','auto'])assert.throws(()=>run(f.root,'init',{...f.brief,executor}),/ADAPTER_UNAVAILABLE/);assert.ok(!fs.existsSync(path.join(f.root,'.fusion/state.json')));});
test('configured default is honored rather than forced to Claude',t=>{const f=fixture(t,{initialize:false});fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({lead:'astra',internal_helper:{provider:'luna'},external:{default:'grok',available:['claude','grok','antigravity']}}));assert.equal(config(f.root).external.default,'grok');assert.throws(()=>run(f.root,'init',f.brief),/grok is planned/);assert.equal(selectExecutor(config(f.root),'claude'),'claude');});
test('Luna cannot be selected as initial executor',t=>{const f=fixture(t,{initialize:false});assert.throws(()=>run(f.root,'init',{...f.brief,executor:'luna'}));assert.throws(()=>run(f.root,'init',{...f.brief,sidekick:'luna'}),/helper/);});
test('exclusive lease rejects other writers and wrong release',t=>{const f=fixture(t);f.begin();assert.throws(()=>acquire(f.root,'other',1,'astra'),/EEXIST/);assert.throws(()=>release(f.root,'wrong'),/mismatch/);});
test('independent verification gates CLOSE',t=>{const f=fixture(t);f.begin();f.finish();assert.throws(()=>run(f.root,'verify',{}),/Invalid phase/);f.review();assert.throws(()=>run(f.root,'verify',{acceptance_satisfied:true,tests:[{command:'false',status:'fail'}]}));assert.equal(run(f.root,'verify',{acceptance_satisfied:true,tests:[{command:'check',status:'pass'}]}).phase,'CLOSE');});
test('two external failures hand off; takeover owns exactly one attempt',t=>{const f=fixture(t);for(let i=0;i<2;i++){f.begin();f.finish();f.review('redo');}assert.equal(f.state().phase,'ALTERNATIVE_REQUIRED');assert.throws(()=>f.begin({executor:'grok'}),/ADAPTER_UNAVAILABLE/);run(f.root,'takeover',{reason:'Core issue after external attempts'});assert.equal(f.begin({takeover_reason:'Lead resolves core issue'}).transport,'lead-takeover');assert.equal(f.state().writer.owner,'astra');f.finish();assert.equal(f.review('redo').phase,'BLOCKED');assert.throws(()=>f.begin());});
test('Luna helper appears only after review, external session retained',t=>{const f=fixture(t);f.begin();const external=f.state().claude_session;f.finish();f.review('helper');const request=f.begin();assert.equal(request.tool,'collaboration.spawn_agent');run(f.root,'bind',{token:f.state().writer.token,session_id:'helper'});f.finish();f.review('redo');assert.equal(f.begin().arguments.target,'helper');f.finish();f.review('resume');assert.equal(f.begin().cli.session_id,external);assert.equal(f.state().attempts.claude,2);});
test('decision needed remains with lead',t=>{const f=fixture(t);f.begin();const r=f.result();r.status='needs_decision';r.needs_lead_decision=true;f.finish(r);assert.throws(()=>f.review(),/Incomplete/);f.review('decision');assert.equal(run(f.root,'decide',{decision:'Preserve public API'}).phase,'REDO');});
test('invalid result keeps writer until explicit recovery',t=>{const f=fixture(t);f.begin();const token=f.state().writer.token;assert.equal(f.finish({}).phase,'RECOVERY_REQUIRED');assert.ok(fs.existsSync(path.join(f.root,'.fusion/locks/writer.json')));assert.throws(()=>run(f.root,'recover',{token,reason:'inspect'}));assert.equal(run(f.root,'recover',{token,quiescent:true,reason:'Worker and commands stopped; diff inspected'}).phase,'REDO');});
test('scope and index changes cannot pass',t=>{const f=fixture(t);f.begin();fs.writeFileSync(path.join(f.root,'outside.txt'),'bad');f.git('add','outside.txt');const s=f.finish(f.result(['outside.txt']));assert.equal(s.phase,'RECOVERY_REQUIRED');assert.ok(s.last_errors.some(e=>e.includes('Out of scope')));assert.ok(s.last_errors.includes('HEAD/index changed'));});
test('dirty user changes included in baseline and preserved',t=>{const f=fixture(t);fs.writeFileSync(path.join(f.root,'user.txt'),'user');const base=snapshot(f.root);f.begin();fs.writeFileSync(path.join(f.root,'a.txt'),'fixed');f.finish(f.result(['a.txt']));assert.deepEqual(changes(base,snapshot(f.root)),['a.txt']);assert.equal(fs.readFileSync(path.join(f.root,'user.txt'),'utf8'),'user');});
test('tree drift blocks review and verification',t=>{const f=fixture(t);f.begin();f.finish();fs.writeFileSync(path.join(f.root,'a.txt'),'late');assert.throws(()=>f.review(),/drift/);assert.equal(f.state().phase,'RECOVERY_REQUIRED');});
test('control lock rejects overlapping controller commands',t=>{const f=fixture(t);fs.writeFileSync(path.join(f.root,'.fusion/locks/control.lock'),'');assert.throws(()=>f.begin(),/EEXIST/);assert.equal(f.state().iteration,0);});
test('orphan lease recovery preserves consumed budget',t=>{const f=fixture(t),lease=acquire(f.root,f.brief.task_id,1,'claude');run(f.root,'recover',{token:lease.token,quiescent:true,reason:'Controller stopped before dispatch'});assert.equal(f.state().attempts.claude,1);f.begin();assert.equal(f.state().attempts.claude,2);});
test('unavailable CLI preflight consumes no attempt or lease',t=>{const f=fixture(t);process.env.HF_CLAUDE_BIN=path.join(f.temp,'missing');assert.throws(()=>f.begin(),/ADAPTER_UNAVAILABLE/);assert.equal(f.state().iteration,0);assert.ok(!fs.existsSync(path.join(f.root,'.fusion/locks/writer.json')));});
test('path traversal rejected before mutation',t=>{const f=fixture(t);assert.throws(()=>f.begin({scope:{paths:['../oops'],allowed_expansion:'ask-lead'}}));assert.equal(f.state().iteration,0);});
test('legacy active state requires explicit archive and preserves source',t=>{
 const f=fixture(t);f.begin();const old=f.state(),token=old.writer.token;old.schema_version=1;
 fs.writeFileSync(path.join(f.root,'.fusion/state.json'),JSON.stringify(old));
 assert.equal(run(f.root,'status').legacy,true);assert.throws(()=>f.begin(),/LEGACY_STATE/);
 assert.throws(()=>run(f.root,'archive',{reason:'not enough'}));
 assert.equal(run(f.root,'archive',{token,quiescent:true,reason:'No process launched; preserve legacy state'}).phase,'ARCHIVED');
 assert.equal(fs.readFileSync(path.join(f.root,'a.txt'),'utf8'),'base');
 assert.ok(!fs.existsSync(path.join(f.root,'.fusion/locks/writer.json')));
 assert.equal(run(f.root,'init',{...f.brief,task_id:'HF-new'}).schema_version,3);
});
test('new tasks request Sol 6.1 high without claiming verified host selection',t=>{
 const f=fixture(t);const s=f.state();
 assert.equal(s.lead,'sol');assert.equal(s.lead_target_model,'gpt-6.1-sol');
 assert.equal(s.lead_target_reasoning_effort,'high');assert.equal(s.lead_model,null);
 assert.equal(s.lead_reasoning_effort,null);
});
test('legacy Astra config normalizes to Sol high and preserves executor pool',t=>{
 const f=fixture(t,{initialize:false});
 fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({lead:'astra',internal_helper:{provider:'luna'},external:{default:'claude',available:['claude','grok']}}));
 const c=config(f.root);assert.equal(c.lead,'sol');assert.equal(c.lead_model,'gpt-6.1-sol');
 assert.equal(c.lead_reasoning_effort,'high');assert.deepEqual(c.external.available,['claude','grok']);
});
