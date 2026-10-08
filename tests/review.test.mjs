import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {consult} from '../scripts/executor-bridge.mjs';
import {read} from '../scripts/artifact.mjs';
import {config,selectExecutor} from '../scripts/executor-config.mjs';
import {measure} from '../scripts/metrics.mjs';

// 위임 리뷰가 켜진 작업. pool로 구현 일꾼 명단, review로 리뷰 설정을 덮어쓴다.
const delegated=(t,{review={},pool,executor='grok'}={})=>{
 const f=fixture(t,{initialize:false});
 fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({review:{by:'delegate',...review},...(pool?{external:{default:pool[0],available:pool}}:{})}));
 run(f.root,'init',{...f.brief,executor});return f;
};
const delegate=async(f,input={})=>{const c=run(f.root,'delegate-review',input);await consult(f.root,c.consult_id);return {c,out:run(f.root,'consult-finish',{quiescent:true})};};
const argsOf=(f,name)=>read(path.join(f.root,`.fusion/fake-${name}-args.json`));

test('a different model reviews the round and its verdict is applied; Codex goes first',async t=>{
 const f=delegated(t);f.begin();f.finish();
 const {c,out}=await delegate(f);
 assert.equal(c.members[0].executor,'codex');
 assert.equal(out.review.status,'applied');assert.equal(out.review.verdict,'pass');assert.equal(f.state().phase,'VERIFY');
 const r=f.state().reviews[0];assert.equal(r.reviewed_by,'codex');assert.equal(r.owner,'grok');assert.equal(r.independent_diff_review,true);
 const a=argsOf(f,'codex');
 assert.equal(a[0],'exec');assert.equal(a[a.indexOf('--sandbox')+1],'read-only');assert.equal(a.at(-1),'-');
 assert.ok(fs.existsSync(a[a.indexOf('--output-schema')+1]));
 assert.equal(f.state().consult_runs??0,0);
});
test('nobody reviews their own round',async t=>{
 const f=delegated(t,{review:{reviewers:['sonnet','codex']},executor:'sonnet'});f.begin();f.finish();
 assert.throws(()=>run(f.root,'delegate-review',{executors:['sonnet']}),/pick a different reviewer/);
 const {c}=await delegate(f);assert.equal(c.members[0].executor,'codex');
});
test('a redo verdict comes with file/line findings that "@review" forwards to the next worker',async t=>{
 const f=delegated(t);f.begin();f.finish();
 f.mode('review-redo');const {out}=await delegate(f);f.mode('ok');
 assert.equal(out.review.verdict,'redo');assert.equal(f.state().phase,'REDO');
 const d=f.begin({lead_feedback:'@review'});
 const fb=JSON.parse(d.prompt).brief.lead_feedback;
 assert.deepEqual(fb[0],{file:'a.txt',line:1,comment:'AC1 not met → write fixed'});
 assert.match(fb[1],/^Unmet: AC1/);
});
test('"@review" also forwards the lead\'s own review (blocking criteria only)',t=>{
 const f=fixture(t);f.begin();f.finish();run(f.root,'review',{verdict:'redo',rationale:'r',blocking_criteria:['AC1'],commands_run:[],independent_diff_review:true});
 assert.match(JSON.stringify(JSON.parse(f.begin({lead_feedback:'@review'}).prompt).brief.lead_feedback),/Unmet: AC1/);
});
test('with auto_apply off the lead adopts or overrides, and overrides are recorded',async t=>{
 const f=delegated(t,{review:{auto_apply:false}});f.begin();f.finish();
 const {out}=await delegate(f);
 assert.equal(out.review.status,'pending');assert.equal(f.state().phase,'REVIEW');
 const s=run(f.root,'review',{verdict:'redo',rationale:'Codex missed the empty-input case',blocking_criteria:['AC1'],commands_run:['git diff'],independent_diff_review:true});
 assert.equal(s.phase,'REDO');const r=s.reviews[0];assert.equal(r.reviewed_by,'lead');assert.equal(r.overrode,'codex');assert.equal(r.overrode_verdict,'pass');
 assert.equal(measure(f.root).lead_overrides,1);
});
test('adopting a pending delegated verdict',async t=>{
 const f=delegated(t,{review:{auto_apply:false}});f.begin();f.finish();await delegate(f);
 assert.throws(()=>run(f.root,'review',{adopt:false,verdict:'pass'}),/Invalid review evidence/);
 const s=run(f.root,'review',{adopt:true});assert.equal(s.phase,'VERIFY');assert.equal(s.reviews[0].reviewed_by,'codex');assert.equal(s.reviews[0].adopted_by_lead,true);
 assert.equal(measure(f.root).delegated_reviews,1);
});
test('a crashed reviewer is replaced by the next one, then the round cap sends it back to the lead',async t=>{
 const f=delegated(t);f.begin();f.finish();
 f.mode('codex-crash');const first=await delegate(f);
 assert.equal(first.out.review.status,'reviewer_failed');assert.equal(f.state().phase,'REVIEW');
 f.mode('ok');const second=await delegate(f);
 assert.equal(second.c.members[0].executor,'sonnet');assert.equal(second.out.review.status,'applied');
});
test('round cap on delegated reviews',async t=>{
 const f=delegated(t);f.begin();f.finish();
 f.mode('codex-crash');await delegate(f);f.mode('review-bad');await delegate(f);
 assert.throws(()=>run(f.root,'delegate-review',{}),/cap reached/);
 assert.equal(f.review('pass').phase,'VERIFY');
});
test('a malformed verdict (redo without reasons) is rejected, not applied',async t=>{
 const f=delegated(t);f.begin();f.finish();
 f.mode('review-bad');const {out}=await delegate(f);
 assert.equal(out.review.status,'reviewer_failed');assert.equal(f.state().reviews.length,0);
});
test('a reviewer cannot pass a round the worker itself reported as unfinished',async t=>{
 const f=delegated(t);f.begin();const r=f.result();r.status='blocked';r.unresolved=['x'];f.finish(r);
 const {out}=await delegate(f);
 assert.equal(out.review.verdict,'redo');assert.deepEqual(f.state().reviews[0].blocking_criteria,['worker reported blocked']);
});
test('an impossible verdict waits for the lead instead of being forced',async t=>{
 const f=delegated(t,{pool:['grok']});f.begin();f.finish();
 f.mode('review-alt');const {out}=await delegate(f);
 assert.equal(out.review.status,'needs_lead');assert.match(out.review.error,/No alternative/);assert.equal(f.state().phase,'REVIEW');
 assert.equal(f.review('redo').phase,'REDO');assert.equal(f.state().pending_review,null);
});
test('a reviewer that edits the tree is voided like any consult',async t=>{
 const f=delegated(t);f.begin();f.finish();
 f.mode('edit');const {out}=await delegate(f);
 assert.equal(out.violated,true);assert.equal(out.review,undefined);assert.equal(f.state().phase,'RECOVERY_REQUIRED');
});
test('code the lead wrote during a takeover is reviewed by another model too',async t=>{
 const f=delegated(t,{pool:['grok']});
 for(let i=0;i<3;i++){f.begin();f.finish();f.review('redo',['AC'+i]);}
 assert.equal(f.state().phase,'TAKEOVER_REQUIRED');
 f.begin({takeover_reason:'three rounds failed'});f.finish();
 const {c,out}=await delegate(f);
 assert.equal(c.members[0].executor,'codex');assert.equal(out.review.status,'applied');assert.equal(f.state().reviews.at(-1).owner,'lead');
});
test('Codex reviews and advises but never implements; config is validated',t=>{
 const f=fixture(t,{initialize:false});
 assert.throws(()=>selectExecutor(config(f.root),'codex'),/Executor must be/);
 for(const bad of [{review:{by:'robot'}},{review:{reviewers:['gpt']}},{review:{reviewers:[]}},{executors:{codex:{reasoning_effort:'turbo'}}}]){
  fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify(bad));assert.throws(()=>config(f.root),/Invalid/,JSON.stringify(bad));
 }
 fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({executors:{codex:{model:'gpt-6.1-sol',reasoning_effort:'high'}}}));
 assert.equal(config(f.root).executors.codex.model,'gpt-6.1-sol');
});
test('Codex model and reasoning effort reach the CLI; Codex can sit on a committee',async t=>{
 const f=fixture(t,{initialize:false});fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({executors:{codex:{model:'gpt-6.1-sol',reasoning_effort:'high'}}}));
 run(f.root,'init',{...f.brief,executor:'grok'});
 const c=run(f.root,'consult',{mode:'committee',question:'Why?',executors:['codex','sonnet']});await consult(f.root,c.consult_id);run(f.root,'consult-finish',{quiescent:true});
 const a=argsOf(f,'codex');assert.equal(a[a.indexOf('-m')+1],'gpt-6.1-sol');assert.ok(a.includes('model_reasoning_effort="high"'));
});
test('review is the lead\'s by default; delegate-review only in REVIEW',t=>{
 const f=fixture(t);assert.equal(f.state().configuration.review.by,'lead');
 assert.throws(()=>run(f.root,'delegate-review',{}),/Invalid phase/);
});
test('doctor checks reviewers when review is delegated',t=>{
 const f=delegated(t);
 const out=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/setup-doctor.mjs',import.meta.url)),f.root,'--executor','grok'],{encoding:'utf8'});
 const j=JSON.parse(out.stdout);
 assert.equal(j.checks.find(c=>c.name==='reviewers').ok,true);assert.ok(j.reviewers.some(r=>r.name==='codex'&&r.ok));
});
