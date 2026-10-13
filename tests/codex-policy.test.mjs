import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {execute,consult} from '../scripts/executor-bridge.mjs';
import {read} from '../scripts/artifact.mjs';
import {luna,sol,parseEvents} from '../scripts/adapters/codex.mjs';
import {sandboxArgs} from '../scripts/codex-sandbox.mjs';
import {config,EXECUTORS,DEFAULT_CAPS,CAP} from '../scripts/executor-config.mjs';
import {route} from '../scripts/router.mjs';
import {MEMBERS,vendorOf} from '../scripts/member-registry.mjs';
import {vendorAllowed,assertVendor} from '../scripts/vendor-policy.mjs';
import {CATALOG} from '../scripts/project.mjs';
import {implementDispatch} from '../scripts/review-plan.mjs';
import {verifyConsult} from '../scripts/dispatch-verify.mjs';
const sid='0199a213-81c0-7800-8aa1-bbab2a035a53';
const stream=(usage={input_tokens:20,cached_input_tokens:15,output_tokens:5})=>[
 {type:'thread.started',thread_id:sid},{type:'turn.started'},
 {type:'item.completed',item:{type:'agent_message',text:'{"task_id":"task","round":1}'}},
 {type:'turn.completed',usage}
].map(e=>JSON.stringify(e)).join('\n');
const write=(f,v)=>fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify(v));
function env(t,key,value){const old=process.env[key];if(value===undefined)delete process.env[key];else process.env[key]=value;t.after(()=>{if(old===undefined)delete process.env[key];else process.env[key]=old;});}

test('Codex JSONL reviewer decision reaches the lead gate instead of becoming a pass',async t=>{
 const f=fixture(t,{initialize:false});write(f,{review:{by:'delegate'}});
 run(f.root,'init',{...f.brief,executor:'grok'});f.begin();f.finish();f.mode('review-decision');
 const review=run(f.root,'delegate-review',{});await consult(f.root,review.consult_id);
 const out=run(f.root,'consult-finish',{quiescent:true});
 assert.equal(out.review.verdict,'decision');assert.equal(f.state().phase,'DECISION_REQUIRED');
 assert.equal(f.state().iteration,1);assert.equal(f.state().writer,null);
});

test('Codex JSONL collects thread and usage without counting cached input twice',()=>{
 const p=parseEvents(stream(),{cli:{session_id:sid}});
 assert.equal(p.session_id,sid);assert.equal(p.usage.usage.total_tokens,25);assert.equal(p.usage.usage.cached_input_tokens,15);
 assert.equal(parseEvents(stream(null),{}).usage.usage,null);
 assert.equal(parseEvents(stream({input_tokens:20,output_tokens:5,cached_input_tokens:30}),{}).usage.usage,null);
});
test('Codex JSONL rejects incomplete, failed, duplicate turns and wrong session',()=>{
 assert.throws(()=>parseEvents(stream()+'\n{',{}),/JSONL/);
 assert.throws(()=>parseEvents(stream(),{cli:{session_id:'wrong'}}),/provenance/);
 assert.throws(()=>parseEvents(stream()+'\n{"type":"turn.failed"}',{}),/unsuccessful/);
 assert.throws(()=>parseEvents(stream()+'\n{"type":"turn.completed"}',{}),/multiple/);
 assert.throws(()=>parseEvents(stream().split('\n').slice(0,-1).join('\n'),{}),/incomplete/);
});
test('Luna redo binds one task-scoped thread and records each turn usage',async t=>{
 const f=fixture(t,{executor:'luna'});const first=f.begin();assert.ok(first.cli.args.includes('--json'));assert.ok(!first.cli.args.includes('--ephemeral'));
 await f.bridge();assert.equal(f.state().sessions.luna,sid);
 assert.equal(read(path.join(f.control,'tasks/HF-test/usage-1.json')).usage.total_tokens,25);
 f.review('redo');const next=f.begin();assert.equal(next.cli.session_id,sid);assert.ok(next.cli.resume);
 assert.equal(next.cli.args[next.cli.args.indexOf('resume')+1],sid);assert.ok(!next.cli.args.includes('--last'));
 await f.bridge();assert.equal(f.state().phase,'REVIEW');
});
test('Codex review stays ephemeral/read-only and unsupported resume stays stateless',t=>{
 const f=fixture(t,{executor:'luna'}),probe=luna.probe(),brief={...f.brief,repo_root:f.root,round:1,consult:{id:'c1',member:'m1',mode:'advisor'}};
 const r=sol.dispatch(brief,{owner:'sol'},{probe,promptFile:path.join(f.temp,'prompt.txt')});
 assert.equal(r.cli.args[r.cli.args.indexOf('--sandbox')+1],'read-only');assert.ok(r.cli.args.includes('--ephemeral'));assert.equal(r.cli.persistence,'ephemeral');
 assert.equal(parseEvents(stream(),{cli:r.cli}).session_id,null);
 const cli={...probe,supports:{...probe.supports,resume:false}};
 const implementation=luna.dispatch({...brief,consult:undefined},{owner:'luna'},{probe:cli,promptFile:path.join(f.temp,'prompt.txt')});
 assert.equal(implementation.cli.persistence,'ephemeral');
 assert.throws(()=>luna.dispatch({...brief,consult:undefined},{owner:'luna'},{probe:cli,session:sid,resume:true,promptFile:path.join(f.temp,'prompt.txt')}),/RESUME_UNSUPPORTED/);
});
test('Codex writable cache/network options are operator-only, implementation-only and bounded',t=>{
 const f=fixture(t,{initialize:false});const e={HF_CODEX_WRITABLE_ROOTS:JSON.stringify([f.temp]),HF_CODEX_NETWORK_ACCESS:'1'};
 assert.match(sandboxArgs({},e).join(' '),/network_access=true/);assert.match(sandboxArgs({},e).join(' '),/writable_roots/);
 assert.deepEqual(sandboxArgs({consult:true},e),[]);
 assert.throws(()=>sandboxArgs({}, {HF_CODEX_WRITABLE_ROOTS:'["/"]'}),/root cannot/);
 assert.throws(()=>sandboxArgs({}, {HF_CODEX_NETWORK_ACCESS:'true'}),/0 or 1/);
 write(f,{executors:{luna:{writable_roots:[f.temp],network_access:true}}});
 const options=config(f.root).executors.luna;
 const d=luna.dispatch({...f.brief,repo_root:f.root,round:1},{owner:'luna'},{probe:luna.probe(),options,promptFile:path.join(f.temp,'prompt.txt')});
 assert.doesNotMatch(d.cli.args.join(' '),/writable_roots|network_access/);
});
test('vendor policy narrows routing and explicit selection before a writer exists',t=>{
 const f=fixture(t,{initialize:false});write(f,{allowed_vendors:['openai']});
 const c=config(f.root);assert.deepEqual(route(f.root,c,{task_kind:'code',difficulty:'low'}).candidates,['luna']);
 assert.throws(()=>run(f.root,'init',{...f.brief,executor:'grok'}),/VENDOR_POLICY/);
 assert.ok(!fs.existsSync(path.join(f.control,'locks/writer.json')));
 assert.throws(()=>assertVendor(c,'sonnet'),/VENDOR_POLICY/);
});
test('operator vendor policy cannot be widened by repository configuration',t=>{
 env(t,'HF_ALLOWED_VENDORS','openai,anthropic');
 assert.equal(vendorAllowed({allowed_vendors:['xai','openai']},'grok'),false);
 assert.equal(vendorAllowed({allowed_vendors:['openai']},'sonnet'),false);
 assert.equal(vendorAllowed({allowed_vendors:['openai']},'luna'),true);
 assert.throws(()=>vendorAllowed({allowed_vendors:['typo']},'luna'),/known vendors/);
});
test('vendor policy blocks consult/review and a newly denied bridge before spawning',async t=>{
 const f=fixture(t,{executor:'grok'});f.begin();await f.bridge();
 env(t,'HF_ALLOWED_VENDORS','xai');
 assert.throws(()=>run(f.root,'consult',{mode:'advisor',question:'check',executors:['sonnet']}),/VENDOR_POLICY/);
 assert.throws(()=>verifyConsult(f.root,{configuration:{allowed_vendors:['openai']}},f.control,{}, {executor:'sonnet'}),/VENDOR_POLICY/);
 f.review('redo');f.begin();process.env.HF_ALLOWED_VENDORS='openai';
 await assert.rejects(()=>execute(f.root),/VENDOR_POLICY/);
 assert.ok(!fs.existsSync(path.join(f.control,'tasks/HF-test/launch-2.json')));
});
test('built-in registry is the source for roles, capabilities, vendors and budgets',()=>{
 assert.equal(Object.keys(MEMBERS).length,6);
 for(const n of EXECUTORS){assert.deepEqual(CATALOG[n].owns,MEMBERS[n].owns);assert.deepEqual(DEFAULT_CAPS[n],MEMBERS[n].caps);assert.equal(CAP[n],MEMBERS[n].rounds);assert.ok(vendorOf(n));}
 assert.equal(EXECUTORS.includes('sol'),false);
});
test('turn ceilings are configurable per difficulty with explicit override precedence',t=>{
 const f=fixture(t,{initialize:false});write(f,{executors:{grok:{max_turns_by_difficulty:{low:20,high:80}},sonnet:{max_turns:60,max_turns_by_difficulty:{high:90}}}});
 const c=config(f.root);
 assert.equal(implementDispatch({configuration:c,routing:{difficulty:'high'}},'grok').options.max_turns,80);
 assert.equal(implementDispatch({configuration:c,routing:{difficulty:'high'}},'sonnet').options.max_turns,60);
 write(f,{executors:{luna:{max_turns:80}}});assert.throws(()=>config(f.root),/TURN_LIMIT_UNSUPPORTED/);
 write(f,{executors:{grok:{max_turns_by_difficulty:{high:0}}}});assert.throws(()=>config(f.root),/configuration/);
});
