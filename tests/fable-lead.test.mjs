import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {consult} from '../scripts/executor-bridge.mjs';
import {read} from '../scripts/artifact.mjs';
import {config,selectExecutor,REVIEWERS} from '../scripts/executor-config.mjs';
import {apexMember,specialistMember,excludedMembers,grantOnlyMembers,compatibleLead,upperLead} from '../scripts/team-roles.mjs';
import {compose,familyReviewPlan} from '../scripts/team-composer.mjs';
import {memberEligible,familyOf,tierOf} from '../scripts/model-registry.mjs';
import {opus} from '../scripts/adapters/claude.mjs';

// Fable 리드: Opus보다 위 모델이 리드일 때만 Opus가 리뷰·상담 일꾼이 되고, A급 실패 작업은 리드가 Opus에게 넘길 수 있다.
const FABLE='claude-fable-5-2';
const asLead=(t,model)=>{const old=process.env.HF_LEAD_MODEL;process.env.HF_LEAD_MODEL=model;t.after(()=>{if(old===undefined)delete process.env.HF_LEAD_MODEL;else process.env.HF_LEAD_MODEL=old;});};
const task=(f,...parts)=>path.join(f.control,'tasks',f.brief.task_id,...parts);

test('Fable is a registered Anthropic frontier model and Opus works only under it',()=>{
 assert.equal(familyOf(FABLE),'anthropic');assert.equal(tierOf(FABLE),'frontier');
 assert.equal(memberEligible('opus',FABLE),true);
 for(const lead of ['claude-opus-5-5','gpt-6.1-astra','gemini-4-argon',null])assert.equal(memberEligible('opus',lead),false);
 assert.equal(memberEligible('sonnet','claude-opus-5-5'),true);
 assert.ok(REVIEWERS.includes('opus'));
});

test('roles stay the same under Opus and Codex leads, and Opus takes the specialist seat under Fable',()=>{
 const opusLead={lead_model:'claude-opus-5-5'},fable={lead_model:FABLE},astra={lead_model:'gpt-6.1-astra'};
 assert.deepEqual([specialistMember(opusLead),apexMember(opusLead),grantOnlyMembers(opusLead),excludedMembers(opusLead)],['sonnet','sol',['sol'],['opus']]);
 assert.deepEqual([specialistMember(astra),apexMember(astra),excludedMembers(astra)],['sol','sonnet',['opus']]);
 assert.deepEqual([specialistMember(fable),apexMember(fable),grantOnlyMembers(fable),excludedMembers(fable)],['opus','sol',['sol','opus'],[]]);
 assert.equal(compatibleLead(fable),true);assert.equal(upperLead(fable),true);assert.equal(upperLead(opusLead),false);
});

test('under Fable, Opus reviews OpenAI rounds and never reviews its own family',()=>{
 const team=compose({lead:{model:FABLE},candidates:['terra','grok','sonnet','luna','haiku','antigravity','sol','opus']});
 assert.deepEqual(familyReviewPlan(team,'terra').reviewers,['opus']);
 assert.deepEqual(familyReviewPlan(team,'luna',{criticality:'important'}).reviewers,['opus','grok']);
 assert.deepEqual(familyReviewPlan(team,'grok').reviewers,['sol']);
 for(const owner of ['sonnet','haiku','opus','lead'])assert.ok(!familyReviewPlan(team,owner,{criticality:'important'}).reviewers.includes('opus'),owner);
});

test('the repository config may name a Fable lead model, and opus is never a direct worker pick',t=>{
 const f=fixture(t,{initialize:false});
 fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({lead_model:FABLE}));
 assert.equal(config(f.root).lead_model,FABLE);
 assert.throws(()=>selectExecutor(config(f.root),'opus'),/opus only reviews and advises under a Fable lead/);
 assert.throws(()=>selectExecutor(config(f.root),'claude'),/Opus is the lead/);
});

test('init adds Opus to the reviewers under Fable and removes it under an Opus lead',t=>{
 const f=fixture(t,{initialize:false});
 fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({review:{by:'delegate',reviewers:['sol','opus','sonnet']}}));
 run(f.root,'init',{...f.brief,executor:'grok'});
 assert.deepEqual(f.state().configuration.review.reviewers,['sol','sonnet']);
 const g=fixture(t,{initialize:false});asLead(t,FABLE);
 run(g.root,'init',{...g.brief,executor:'grok'});
 assert.equal(g.state().configuration.lead_model,FABLE);
 assert.deepEqual(g.state().configuration.review.reviewers,['sol','sonnet','grok','opus']);
});

test('a team file that leaves Opus off keeps it out under Fable',t=>{
 const f=fixture(t,{initialize:false}),file=path.join(f.temp,'team.json');asLead(t,FABLE);
 fs.writeFileSync(file,JSON.stringify({version:1,members:{grok:{enabled:true},sonnet:{enabled:true},sol:{enabled:true}}}));
 const old=process.env.HF_TEAM_FILE;process.env.HF_TEAM_FILE=file;t.after(()=>{process.env.HF_TEAM_FILE=old;});
 run(f.root,'init',{...f.brief,executor:'grok'});
 assert.ok(!f.state().configuration.review.reviewers.includes('opus'));
});

test('the Opus adapter refuses an implementation round unless the controller granted it',()=>{
 const brief={task_id:'T',round:1,objective:'x',scope:{paths:['a.txt']},constraints:[],success_criteria:['AC1'],allowed_actions:['read','edit','test'],forbidden_actions:[],evidence_required:[],repo_root:'.'};
 const cli={executable:'claude',supports:{}};
 assert.throws(()=>opus.dispatch(brief,{token:'t',owner:'opus'},{session:'s',probe:cli}),/Opus reviews and advises only/);
 assert.equal(opus.dispatch(brief,{token:'t',owner:'opus'},{session:'s',probe:cli,granted:true}).cli.model,'claude-opus-5-5');
 assert.equal(opus.dispatch({...brief,allowed_actions:['read']},{token:'t',owner:'opus'},{session:'s',probe:cli}).cli.model,'claude-opus-5-5');
});

test('under a Fable lead with adaptive review, Opus reviews a Terra round and takes a reassigned round',async t=>{
 asLead(t,FABLE);
 const f=fixture(t,{initialize:false,executor:'terra'});
 fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({review:{by:'delegate',strategy:'lead-gated-adaptive'}}));
 run(f.root,'init',{...f.brief,executor:'terra'});
 assert.equal(read(task(f,'assignment.json')).review_policy,'family-rules-v1');
 f.begin();f.finish();
 f.mode('review-alt');
 const c=run(f.root,'delegate-review',{});await consult(f.root,c.consult_id);run(f.root,'consult-finish',{quiescent:true});
 assert.deepEqual(c.members.map(m=>m.executor),['opus']);
 assert.equal(f.state().phase,'LEAD_DECISION_REQUIRED');
 f.mode('ok');
 const reassigned=run(f.root,'lead-decision',{decision:'REASSIGN_TO_SONNET',rationale:'Terra could not fix AC1; hand it to Opus',baseline_digest:f.state().post_digest,contract_change:false});
 assert.equal(reassigned.phase,'ALTERNATIVE_REQUIRED');
 assert.equal(f.state().implement_grant.executor,'opus');
 f.begin({executor:'opus'});
 assert.equal(f.state().owner,'opus');
 f.finish();
 // Opus가 쓴 라운드는 다른 회사 모델(Sol)이 리뷰한다.
 const second=run(f.root,'delegate-review',{});
 assert.deepEqual(second.members.map(m=>m.executor),['sol']);
 assert.deepEqual(read(task(f,'review-plan-2.json')).reviewers,['sol']);
});
