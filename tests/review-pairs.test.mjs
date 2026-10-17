import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {read} from '../scripts/artifact.mjs';
import {consult} from '../scripts/executor-bridge.mjs';
import {config} from '../scripts/executor-config.mjs';
import {planReview,panelSeats,sameAssignment,samePlan,PAIRED_REVIEW_POLICY,LEGACY_REVIEW_POLICY} from '../scripts/review-plan.mjs';

const paired={review_policy:PAIRED_REVIEW_POLICY};
const table={grok:['sol','sonnet'],antigravity:['sol','grok'],haiku:['sol','grok'],luna:['sonnet','grok'],sonnet:['sol','grok']};
const task=(f,name)=>path.join(f.control,'tasks',f.brief.task_id,name);
function setup(t,owner,extra={}){
 const f=fixture(t,{initialize:false});
 fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({review:{by:'delegate',strategy:'lead-gated-adaptive'},...extra}));
 const input={...f.brief,executor:owner,task_criticality:'important',assignment_reason:'Independent deep review',...(owner==='sonnet'?{assignment_strategy:'sonnet_implementation'}:{})};
 const s=run(f.root,'init',input);return {f,s};
}

test('important, explicit dual and risk-raised reviews use the agreed independent pairs',()=>{
 for(const [owner,reviewers] of Object.entries(table))for(const [assignment,options] of [
  [{...paired,criticality:'important'},{}],[{...paired,strategy:'dual_review'},{}],[paired,{risk:['src/auth/login.js']}]
 ]){
  const p=planReview(owner,assignment,options);assert.deepEqual(p.reviewers,reviewers);
  assert.ok(!p.reviewers.includes(owner));
  assert.equal(p.effort.grok,owner==='grok'?undefined:'xhigh');
 }
 assert.deepEqual(planReview('sol',{...paired,criticality:'apex',strategy:'sol_apex'}).reviewers,['lead']);
 for(const owner of ['grok','antigravity','haiku','sonnet'])assert.deepEqual(planReview(owner,paired).reviewers,['sol']);
 assert.deepEqual(planReview('luna',paired).reviewers,['sonnet']);
});

test('historical assignments and Grok-free approved teams keep their old plan',t=>{
 const legacy={criticality:'important',strategy:'external_primary'};
 assert.deepEqual(planReview('antigravity',legacy).reviewers,['sol','sonnet']);
 assert.deepEqual(planReview('luna',legacy).reviewers,['sonnet']);
 assert.equal(samePlan({...planReview('antigravity',legacy),review_policy:undefined},planReview('antigravity',legacy)),true);
 const {f,s}=setup(t,'sonnet',{external:{default:'sonnet',available:['sonnet','luna']},review:{by:'delegate',strategy:'lead-gated-adaptive',reviewers:['sol','sonnet']}});
 assert.equal(s.assignment.review_policy,LEGACY_REVIEW_POLICY);
 assert.deepEqual(s.review_preview.reviewers,['sol']);
 assert.equal(sameAssignment(s.assignment,{...s.assignment,review_policy:PAIRED_REVIEW_POLICY}),false);
 assert.throws(()=>run(f.root,'begin',{...f.brief,review_policy:PAIRED_REVIEW_POLICY}),/controller|brief/);
});

test('independent seats cannot be replaced by the writer, its vendor, or two same-vendor reviewers',()=>{
 const p=planReview('luna',{...paired,criticality:'important'});
 assert.throws(()=>panelSeats(p,{asked:['sonnet','luna'],reason:'replacement'}),/self-review/);
 assert.throws(()=>panelSeats(p,{asked:['sonnet','sol'],reason:'replacement'}),/same-vendor/);
 assert.throws(()=>panelSeats(p,{asked:['sonnet','haiku'],reason:'replacement'}),/distinct vendors/);
 const fill=panelSeats(p,{asked:['grok'],kept:['sonnet']});assert.equal(fill.effort.grok,'xhigh');
 assert.equal(panelSeats(planReview('haiku',paired),{asked:['grok'],reason:'Sol unavailable'}).effort.grok,undefined);
});

for(const owner of ['antigravity','haiku','luna','sonnet'])test(`${owner} pair runs read-only on one digest; Grok review is xhigh without changing its medium default`,async t=>{
 const {f,s}=setup(t,owner);
 assert.equal(s.assignment.review_policy,PAIRED_REVIEW_POLICY);
 assert.deepEqual(s.review_preview.reviewers,table[owner]);
 assert.equal(config(f.root).executors.grok.reasoning_effort,'medium');
 const started=f.begin();assert.deepEqual(started.review_preview.reviewers,table[owner]);f.finish();
 const c=run(f.root,'delegate-review',{});assert.deepEqual(c.members.map(m=>m.executor),table[owner]);
 const requests=c.members.map(m=>read(task(f,`consult-${c.consult_id}-${m.member}.json`)));
 const g=requests.find(r=>r.executor==='grok');assert.equal(g.cli.args[g.cli.args.indexOf('--reasoning-effort')+1],'xhigh');
 assert.ok(g.cli.args.includes('Bash(*)'));assert.ok(g.cli.args.includes('Edit(**)'));
 for(const r of requests){const b=JSON.parse(r.prompt).brief;assert.deepEqual(b.allowed_actions,['read']);assert.equal(b.consult.context.sibling_verdict,undefined);}
 assert.equal(JSON.parse(requests[0].prompt).brief.consult.context.diff,JSON.parse(requests[1].prompt).brief.consult.context.diff);
 const out=await consult(f.root,c.consult_id);assert.ok(out.members.every(m=>m.ok),JSON.stringify(out));
 const result=run(f.root,'consult-finish',{quiescent:true});assert.equal(result.review.panel_status,'unanimous');
 assert.equal(f.state().phase,'LEAD_DECISION_REQUIRED');assert.equal(f.state().configuration.executors.grok.reasoning_effort,'medium');
 const usage=read(task(f,`usage-consult-${c.consult_id}-${c.members.find(m=>m.executor==='grok').member}.json`));
 assert.equal(usage.role,'review');assert.equal(usage.reasoning_effort,'xhigh');
 const rows=f.state().review_results[1];assert.equal(new Set(rows.map(r=>r.digest)).size,1);
});

test('Grok medium implementation never receives a Grok reviewer or changes implementation effort',t=>{
 const {f}=setup(t,'grok');const d=f.begin();assert.equal(d.cli.args[d.cli.args.indexOf('--reasoning-effort')+1],'medium');
 f.finish();const c=run(f.root,'delegate-review',{});assert.deepEqual(c.members.map(m=>m.executor),['sol','sonnet']);
});

test('a Grok rejection cannot be voted away by its paired PASS',async t=>{
 const {f}=setup(t,'antigravity');
 const cli=process.env.HF_GROK_BIN;
 fs.writeFileSync(cli,fs.readFileSync(cli,'utf8').replace('const result=finish(request,id);',`const result=finish(request,id);if('blocking_criteria' in result){result.recommended_verdict='redo';result.blocking_criteria=['AC1'];result.findings=[{file:'a.txt',line:1,severity:'blocker',issue:'AC1 missing',suggestion:'implement AC1'}];}`));
 f.begin();f.finish();const c=run(f.root,'delegate-review',{});await consult(f.root,c.consult_id);
 const result=run(f.root,'consult-finish',{quiescent:true});assert.equal(result.review.panel_status,'conflict');
 assert.equal(f.state().phase,'LEAD_DECISION_REQUIRED');assert.equal(result.review.pass_forbidden,true);
 assert.throws(()=>run(f.root,'lead-decision',{decision:'APPROVE',rationale:'One PASS is enough',baseline_digest:f.state().post_digest,contract_change:false}),/every mandatory|rejection|review/);
});

test('missing Grok does not silently shrink an enabled pair',t=>{
 const {f}=setup(t,'antigravity');f.begin();f.finish();process.env.HF_GROK_BIN=path.join(f.temp,'not-installed');
 assert.throws(()=>run(f.root,'delegate-review',{}),/ADAPTER_UNAVAILABLE/);
 assert.equal(f.state().phase,'REVIEW');assert.equal(f.state().open_consult??null,null);
});

test('the bridge refuses a lowered Grok review effort before launching that reviewer',async t=>{
 const {f}=setup(t,'antigravity');f.begin();f.finish();
 const c=run(f.root,'delegate-review',{}),member=c.members.find(m=>m.executor==='grok');
 const file=task(f,`consult-${c.consult_id}-${member.member}.json`),request=read(file);
 request.cli.args[request.cli.args.indexOf('--reasoning-effort')+1]='medium';
 fs.writeFileSync(file,JSON.stringify(request));
 const result=await consult(f.root,c.consult_id),g=result.members.find(m=>m.executor==='grok');
 assert.equal(g.ok,false);assert.match(g.error,/DISPATCH_TAMPERED/);
 assert.equal(fs.existsSync(path.join(f.temp,'fake-grok-args.json')),false);
 const end=run(f.root,'consult-finish',{quiescent:true});assert.equal(end.review.panel_status,'reviewer_failed');
});

test('disallowing xAI at init preserves the approved Grok-free policy instead of adding a vendor',t=>{
 const {s}=setup(t,'sonnet',{allowed_vendors:['anthropic','openai']});
 assert.equal(s.assignment.review_policy,LEGACY_REVIEW_POLICY);assert.deepEqual(s.review_preview.reviewers,['sol']);
});

test('older Grok requests without additive usage metadata still verify the exact arguments',async t=>{
 const {f}=setup(t,'antigravity');f.begin();f.finish();
 const c=run(f.root,'delegate-review',{}),m=c.members.find(m=>m.executor==='grok');
 const file=task(f,`consult-${c.consult_id}-${m.member}.json`),request=read(file);
 for(const key of ['model','model_family','reasoning_effort'])delete request.cli[key];
 fs.writeFileSync(file,JSON.stringify(request));
 const result=await consult(f.root,c.consult_id);assert.ok(result.members.every(m=>m.ok),JSON.stringify(result));
 assert.equal(read(task(f,`usage-consult-${c.consult_id}-${m.member}.json`)).reasoning_effort,'xhigh');
 assert.equal(run(f.root,'consult-finish',{quiescent:true}).review.panel_status,'unanimous');
});
