import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './support.mjs';
import {config} from '../scripts/executor-config.mjs';
import {route} from '../scripts/router.mjs';
import {MEMBERS} from '../scripts/member-registry.mjs';

// 2026-11-05 L01 runs 5-7: the router picked Terra first every time, and Terra never ran a test on this host because
// the Codex sandbox blocked child processes. When the host check says so, Codex workers go last instead.
const codex=e=>MEMBERS[e]?.binary==='codex';
const brief={task_kind:'code',difficulty:'high'};
const blocked=e=>codex(e)?{status:'ok',child_spawn:{status:'blocked',code:'EPERM'}}:undefined;

test('Codex workers go last when their sandbox cannot start child processes on this host',t=>{
 const f=fixture(t,{initialize:false}),c=config(f.root);
 const before=route(f.root,c,brief,{preflight:()=>undefined});
 const after=route(f.root,c,brief,{preflight:blocked});
 assert.deepEqual([...after.candidates].sort(),[...before.candidates].sort(),'nobody is removed');
 const firstCodex=after.candidates.findIndex(codex);
 assert.ok(firstCodex>0,'a non-Codex worker is picked first');
 assert.ok(after.candidates.slice(firstCodex).every(codex),'every Codex worker is behind every other worker');
 assert.equal(codex(after.executor),false);
 assert.match(after.reason,/sandbox blocks child processes on this host .*moved last/);
});

test('an unverified or failing host check leaves the order alone',t=>{
 const f=fixture(t,{initialize:false}),c=config(f.root);
 const base=route(f.root,c,brief,{preflight:()=>undefined}).candidates;
 assert.deepEqual(route(f.root,c,brief,{preflight:e=>codex(e)?{status:'ok',child_spawn:{status:'unverified'}}:undefined}).candidates,base);
 assert.deepEqual(route(f.root,c,brief,{preflight:e=>{if(codex(e))throw Error('ADAPTER_UNAVAILABLE');}}).candidates,base);
 assert.deepEqual(route(f.root,c,brief,{probe:false,preflight:blocked}).candidates,route(f.root,c,brief,{probe:false}).candidates,'no probing, no host check');
});

test('when only Codex workers are left they are still used',t=>{
 const f=fixture(t,{initialize:false});
 const c={...config(f.root),allowed_vendors:['openai']};
 const r=route(f.root,c,{task_kind:'code',difficulty:'low'},{preflight:blocked});
 assert.ok(r.candidates.length>0&&r.candidates.every(codex));
 assert.doesNotMatch(r.reason,/moved last/);
});
