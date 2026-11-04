import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {consult} from '../scripts/executor-bridge.mjs';
import {read} from '../scripts/artifact.mjs';
import {config,taskExecutorOptions} from '../scripts/executor-config.mjs';
import {route} from '../scripts/router.mjs';
import {gradeOf} from '../scripts/member-registry.mjs';

const adaptive=(t,executor)=>{
 const f=fixture(t,{initialize:false,executor});
 fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({review:{by:'delegate',strategy:'lead-gated-adaptive'}}));
 run(f.root,'init',{...f.brief,executor});
 return f;
};
const delegate=async f=>{const c=run(f.root,'delegate-review',{});await consult(f.root,c.consult_id);return run(f.root,'consult-finish',{quiescent:true});};
const decide=(f,extra)=>run(f.root,'lead-decision',{baseline_digest:f.state().post_digest,contract_change:false,...extra});
const task=(f,name)=>path.join(f.control,'tasks',f.brief.task_id,name);

test('workers carry a grade: Terra, Grok and Sonnet are A-tier; Luna, Haiku and Antigravity are B-tier',()=>{
 assert.deepEqual(['terra','grok','sonnet'].map(gradeOf),['A','A','A']);
 assert.deepEqual(['luna','haiku','antigravity'].map(gradeOf),['B','B','B']);
 assert.equal(gradeOf('sol'),null);
});

test('routing sends medium/high code to A-tier (Terra first) and low code, docs and UI to B-tier first',t=>{
 const f=fixture(t,{initialize:false});
 for(const policy of ['classic','external-first']){
  fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({routing:{policy}}));
  const c=config(f.root);
  const first=brief=>route(f.root,c,brief,{probe:false}).candidates;
  for(const difficulty of ['medium','high'])assert.deepEqual(first({task_kind:'code',difficulty}).slice(0,3),['terra','grok','sonnet'],policy);
  for(const task_kind of ['tests','refactor'])assert.deepEqual(first({task_kind}).slice(0,3),['terra','grok','sonnet'],policy);
  assert.deepEqual(first({task_kind:'code',difficulty:'low'}).slice(0,3),['luna','haiku','antigravity'],policy);
  assert.equal(first({task_kind:'docs'})[0],'antigravity');
  assert.equal(first({task_kind:'ui'})[0],'antigravity');
  assert.equal(first({task_kind:'code',difficulty:'high'}).includes('sol'),false);
  // 구현 강도: Terra medium, Sonnet medium, Grok high.
  assert.equal(taskExecutorOptions(c,'terra','high').reasoning_effort,'medium');
  assert.equal(taskExecutorOptions(c,'sonnet','high').reasoning_effort,'medium');
  assert.equal(taskExecutorOptions(c,'grok','high').reasoning_effort,'high');
 }
});

test('a rejected B-tier round is promoted to an A-tier worker; REDO of the same worker needs a reason',async t=>{
 const f=adaptive(t,'haiku');
 f.begin();f.finish();f.mode('review-redo');
 const out=(await delegate(f)).review;
 assert.equal(out.recommendation,'REASSIGN_OTHER');
 assert.match(read(task(f,'lead-packet-1.json')).note,/B-tier worker, so the rejected round is promoted to an A-tier worker/);
 assert.throws(()=>decide(f,{decision:'REDO',rationale:'AC1 fails'}),/B-tier worker and was rejected.*keep_owner_reason/);
 const moved=decide(f,{decision:'REASSIGN_OTHER',rationale:'promote to A-tier'});
 assert.equal(moved.phase,'ALTERNATIVE_REQUIRED');
 f.mode('ok');
 const next=f.begin({executor:'auto'});
 assert.equal(gradeOf(next.executor),'A',next.executor);
});

test('a B-tier worker may still be kept when the lead records why',async t=>{
 const f=adaptive(t,'haiku');
 f.begin();f.finish();f.mode('review-redo');
 await delegate(f);
 const kept=decide(f,{decision:'REDO',rationale:'AC1 fails',keep_owner_reason:'one-line fix, haiku has the context'});
 assert.equal(kept.phase,'REDO');
 assert.equal(kept.lead_decision.keep_owner_reason,'one-line fix, haiku has the context');
});

test('a rejected A-tier round keeps the usual REDO recommendation',async t=>{
 const f=adaptive(t,'grok');
 f.begin();f.finish();f.mode('review-redo');
 assert.equal((await delegate(f)).review.recommendation,'REDO');
 assert.equal(decide(f,{decision:'REDO',rationale:'AC1 fails'}).phase,'REDO');
});
