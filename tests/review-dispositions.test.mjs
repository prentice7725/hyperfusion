import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {consult} from '../scripts/executor-bridge.mjs';
import {read} from '../scripts/artifact.mjs';
import {measure} from '../scripts/metrics.mjs';

const adaptive=(t,extra={})=>{
 const f=fixture(t,{initialize:false,executor:'grok'});
 fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({review:{by:'delegate',strategy:'lead-gated-adaptive'}}));
 run(f.root,'init',{...f.brief,executor:'grok',...extra});
 return f;
};
const task=(f,...parts)=>path.join(f.control,'tasks',f.brief.task_id,...parts);
const delegate=async f=>{const c=run(f.root,'delegate-review',{});await consult(f.root,c.consult_id);return {c,out:run(f.root,'consult-finish',{quiescent:true})};};
const prompt=(f,id,member='m1')=>JSON.parse(read(task(f,`consult-${id}-${member}.json`)).prompt);
const decide=(f,extra)=>run(f.root,'lead-decision',{rationale:'Read the round evidence',baseline_digest:f.state().post_digest,contract_change:false,...extra});
const onlyFinding=f=>read(task(f,'lead-packet-1.json')).finding_summary.displayed[0].id;

test('a delegated reviewer sees facts, not the worker\'s claims or earlier reviewers\' reasons',async t=>{
 const f=adaptive(t);
 f.begin();f.finish();f.mode('review-redo');
 const {c}=await delegate(f);
 const first=prompt(f,c.consult_id).brief.consult.context;
 assert.equal(first.last_result.status,'complete');
 assert.deepEqual(first.last_result.files_changed,[]);
 assert.equal(first.last_result.summary,undefined);
 assert.equal(first.last_result.tests,undefined);
 assert.equal(first.last_result.risks,undefined);
 assert.ok(first.last_result.claims_withheld.includes('summary'));
 assert.ok(first.last_result.claims_withheld.includes('tests'));
 assert.ok(prompt(f,c.consult_id).instructions.some(line=>line.includes('claims_withheld')));
 // 다음 라운드 리뷰어는 이전 반려 기준만 보고, 이전 판정과 사유는 보지 않는다.
 decide(f,{decision:'REDO'});
 f.mode('review-redo');f.begin();f.finish();
 const second=await delegate(f);
 const reviews=prompt(f,second.c.consult_id).brief.consult.context.recent_reviews;
 assert.equal(reviews.length,1);
 assert.deepEqual(reviews[0].blocking_criteria,['AC1']);
 assert.equal(reviews[0].rationale,undefined);
 assert.equal(reviews[0].verdict,undefined);
});

test('an advisor consultation still receives the worker\'s full report',async t=>{
 const f=fixture(t);
 f.begin();f.finish();
 const c=run(f.root,'consult',{mode:'advisor',question:'Does it meet AC1?'});
 const context=prompt(f,c.consult_id).brief.consult.context;
 assert.equal(context.last_result.summary,'Test result');
 assert.equal(context.last_result.claims_withheld,undefined);
});

test('finding dispositions are validated before anything is recorded',async t=>{
 const f=adaptive(t);
 f.begin();f.finish();f.mode('review-redo');
 await delegate(f);
 const id=onlyFinding(f);
 const refuse=(list,pattern,decision='REDO')=>{assert.throws(()=>decide(f,{decision,finding_dispositions:list}),pattern);};
 refuse([],/non-empty array/);
 refuse([{finding_id:id,bucket:'ignore',reason:'x'}],/bucket must be one of/);
 refuse([{finding_id:id,bucket:'dismissed',reason:' '}],/need a reason/);
 refuse([{finding_id:id,bucket:'dismissed',reason:'x',extra:1}],/only finding_id, bucket and reason/);
 refuse([{finding_id:'F-'+'0'.repeat(24),bucket:'noted',reason:'x'}],/not a finding reviewed on this round/);
 refuse([{finding_id:id,bucket:'noted',reason:'x'},{finding_id:id,bucket:'act',reason:'y'}],/repeat/);
 refuse([{finding_id:id,bucket:'act',reason:'AC1 really fails'}],/APPROVE is refused while findings are marked act/,'APPROVE');
 assert.equal(f.state().phase,'LEAD_DECISION_REQUIRED');
 assert.equal(fs.existsSync(task(f,'lead-decision-1.json')),false);
});

test('a dismissed finding is recorded, kept from the next worker and counted against its reviewer',async t=>{
 const f=adaptive(t);
 f.begin();f.finish();f.mode('review-redo');
 await delegate(f);
 const id=onlyFinding(f);
 const out=decide(f,{decision:'REDO',finding_dispositions:[{finding_id:id,bucket:'dismissed',reason:'the caller validates input upstream'}]});
 assert.equal(out.phase,'REDO');
 const record=read(task(f,'lead-decision-1.json'));
 assert.deepEqual(record.finding_dispositions,[{finding_id:id,bucket:'dismissed',reason:'the caller validates input upstream',reviewers:['sol'],severities:['blocker']}]);
 const packet=run(f.root,'revision-packet');
 assert.deepEqual(packet.withheld_by_lead,[{finding_id:id,bucket:'dismissed'}]);
 assert.equal(packet.feedback.some(v=>JSON.stringify(v).includes(id)),false);
 // 기각은 지적 문장만 거른다. 반려 기준은 그대로 넘어간다.
 assert.ok(packet.feedback.some(v=>typeof v==='string'&&v.startsWith('Unmet: AC1')));
 // 실제 다음 라운드 brief에도 기각된 지적은 들어가지 않는다.
 f.begin({lead_feedback:'@findings'});
 const forwarded=JSON.stringify(read(task(f,'brief-2.json')).lead_feedback);
 assert.equal(forwarded.includes(id),false);
 assert.ok(forwarded.includes('Unmet: AC1'));
 const m=measure(f.root).review_dispositions;
 assert.equal(m.findings,1);
 assert.deepEqual(m.by_reviewer.sol,{act:0,consider:0,noted:0,dismissed:1,contract_misread:0,actionable_rate:0});
});

test('an acted finding is forwarded with the lead\'s note',async t=>{
 const f=adaptive(t);
 f.begin();f.finish();f.mode('review-redo');
 await delegate(f);
 const id=onlyFinding(f);
 decide(f,{decision:'REDO',finding_dispositions:[{finding_id:id,bucket:'act',reason:'empty input crashes'}]});
 const packet=run(f.root,'revision-packet');
 assert.equal(packet.withheld_by_lead,undefined);
 assert.ok(packet.feedback.some(v=>JSON.stringify(v).includes(`[lead: act — empty input crashes]`)));
 assert.equal(measure(f.root).review_dispositions.by_reviewer.sol.actionable_rate,1);
});

test('metrics stay null when the lead recorded no dispositions',async t=>{
 const f=adaptive(t);
 f.begin();f.finish();
 await delegate(f);
 decide(f,{decision:'APPROVE'});
 assert.equal(measure(f.root).review_dispositions,null);
});
