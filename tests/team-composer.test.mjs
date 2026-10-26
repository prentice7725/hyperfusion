import test from 'node:test';
import assert from 'node:assert/strict';
import {compose,familyReviewPlan} from '../scripts/team-composer.mjs';
import {modelBase,familyOf,memberFamily,independent} from '../scripts/model-registry.mjs';
import {planReview,PAIRED_REVIEW_POLICY,LEGACY_REVIEW_POLICY} from '../scripts/review-plan.mjs';

const ALL=['grok','antigravity','sonnet','haiku','luna','sol'];
const OPUS={model:'claude-opus-5-5'};
const ASSIGNMENTS=[
 [{criticality:'standard'},{}],
 [{criticality:'important'},{}],
 [{strategy:'dual_review'},{}],
 [{criticality:'standard'},{risk:['src/auth/login.js']}]
];

test('registry normalizes host model values and never guesses a family',()=>{
 assert.equal(modelBase('gemini-4-argon-high'),'gemini-4-argon');
 assert.equal(familyOf('Gemini 4 Argon (Medium)'),'google');
 // agy가 돌리는 Claude도 계열은 모델로 정한다.
 assert.equal(familyOf('claude-opus-5-5'),'anthropic');
 for(const value of ['auto','default','gpt-oss-120b',undefined,null])assert.equal(familyOf(value),'unknown');
 assert.equal(memberFamily('grok'),'xai');
 assert.equal(memberFamily('grok','custom-endpoint-model'),'unknown');
 assert.equal(independent('unknown','unknown'),false);
 assert.equal(independent('openai','unknown'),false);
});

test('an Opus lead reproduces the current paired review plan for every owner',()=>{
 const team=compose({lead:OPUS,candidates:ALL});
 for(const owner of ['grok','antigravity','haiku','luna','sonnet','lead'])for(const [assignment,options] of ASSIGNMENTS){
  const want=planReview(owner,{review_policy:PAIRED_REVIEW_POLICY,...assignment},options);
  const got=familyReviewPlan(team,owner,{...assignment,...options});
  assert.deepEqual(got.reviewers,want.reviewers,`${owner} ${JSON.stringify(assignment)} ${JSON.stringify(options)}`);
  assert.deepEqual(got.effort,want.effort,`${owner} effort`);
 }
 const apex=familyReviewPlan(team,'sol',{criticality:'apex',strategy:'sol_apex'});
 assert.deepEqual(apex.reviewers,planReview('sol',{review_policy:PAIRED_REVIEW_POLICY,criticality:'apex',strategy:'sol_apex'}).reviewers);
});

test('without Grok the legacy plan matches only where the documentation says it does',()=>{
 const team=compose({lead:OPUS,candidates:['antigravity','sonnet','haiku','luna','sol']});
 for(const [assignment] of ASSIGNMENTS){
  assert.deepEqual(familyReviewPlan(team,'antigravity',assignment).reviewers,planReview('antigravity',{review_policy:LEGACY_REVIEW_POLICY,...assignment}).reviewers);
 }
 // legacy-v1은 Grok·AGY 작업만 이중 리뷰한다. 일반 규칙은 남은 계열로 두 번째 자리를 채운다.
 // 그래서 기존 작업은 호환 resolver로 계속 계산해야 한다.
 for(const owner of ['luna','haiku','sonnet']){
  const legacy=planReview(owner,{review_policy:LEGACY_REVIEW_POLICY,criticality:'important'}).reviewers;
  const general=familyReviewPlan(team,owner,{criticality:'important'}).reviewers;
  assert.equal(legacy.length,1);
  assert.deepEqual(general,[...legacy,'antigravity']);
 }
});

test('roles follow the lead family for each documented host',()=>{
 const cases=[
  [{model:'claude-opus-5-5'},{sol:'external_top',grok:'external_general',antigravity:'external_general',luna:'external_general',sonnet:'lead_family_specialist',haiku:'lead_family_general'}],
  [{model:'gpt-6.1-astra'},{sonnet:'external_top',grok:'external_general',antigravity:'external_general',haiku:'external_general',sol:'lead_family_specialist',luna:'lead_family_general'}],
  [{model:'gpt-6.1-sol-high'},{sonnet:'external_top',grok:'external_general',antigravity:'external_general',haiku:'external_general',sol:'excluded',luna:'lead_family_general'}],
  [{model:'gemini-4-argon-medium'},{sol:'external_top',sonnet:'external_specialist',grok:'external_general',luna:'external_general',haiku:'external_general',antigravity:'lead_family_general'}]
 ];
 for(const [lead,roles] of cases)assert.deepEqual(compose({lead,candidates:ALL}).roles,roles,lead.model);
 assert.deepEqual(compose({lead:OPUS,candidates:ALL}).auto_implementers,['grok','antigravity','luna']);
 assert.deepEqual(compose({lead:{model:'gemini-4-argon'},candidates:ALL}).auto_implementers,['grok','haiku','luna']);
 assert.deepEqual(compose({lead:OPUS,candidates:ALL,lead_family_reserve:false}).auto_implementers,['grok','antigravity','haiku','luna']);
});

test('Claude and Codex alone review each other in one seat',()=>{
 const opus=compose({lead:OPUS,candidates:['sonnet','haiku','luna','sol']});
 assert.deepEqual(opus.auto_implementers,['luna']);
 const raised={criticality:'important'};
 assert.deepEqual(familyReviewPlan(opus,'luna',raised).reviewers,['sonnet']);
 assert.deepEqual(familyReviewPlan(opus,'haiku',raised).reviewers,['sol']);
 assert.deepEqual(familyReviewPlan(opus,'sonnet',raised).reviewers,['sol']);
 assert.deepEqual(familyReviewPlan(opus,'sol',raised).reviewers,['lead']);
 assert.match(familyReviewPlan(opus,'luna',raised).seat_reason,/only 1 independent family/);
 const astra=compose({lead:{model:'gpt-6.1-astra'},candidates:['sonnet','haiku','luna','sol']});
 assert.deepEqual(astra.auto_implementers,['haiku']);
 assert.deepEqual(familyReviewPlan(astra,'haiku').reviewers,['sol']);
 assert.deepEqual(familyReviewPlan(astra,'luna').reviewers,['sonnet']);
 assert.deepEqual(familyReviewPlan(astra,'sol').reviewers,['sonnet']);
 assert.deepEqual(familyReviewPlan(astra,'sonnet').reviewers,['lead']);
});

test('a single family is refused, and a lead of another family closes by lead-decision',()=>{
 assert.throws(()=>compose({lead:OPUS,candidates:['sonnet','haiku']}),/TEAM_SINGLE_FAMILY/);
 assert.throws(()=>compose({lead:{model:'gpt-6.1-astra'},candidates:['luna','sol']}),/TEAM_SINGLE_FAMILY/);
 // 수습과 unknown은 계열 수에 세지 않는다.
 assert.throws(()=>compose({lead:OPUS,candidates:['sonnet','luna'],probation:['luna']}),/TEAM_SINGLE_FAMILY/);
 assert.throws(()=>compose({lead:OPUS,candidates:['sonnet','grok'],models:{grok:'custom-endpoint-model'}}),/TEAM_SINGLE_FAMILY/);
 const team=compose({lead:OPUS,candidates:['luna','sol']});
 assert.deepEqual(team.auto_implementers,['luna']);
 const p=familyReviewPlan(team,'luna',{criticality:'important'});
 assert.deepEqual(p.reviewers,['lead']);
 assert.match(p.seat_reason,/lead-decision only/);
});

test('probation and unknown members never fill a review seat',()=>{
 const team=compose({lead:OPUS,candidates:ALL,probation:['grok']});
 assert.equal(team.roles.grok,'probation');
 assert.ok(!team.auto_implementers.includes('grok'));
 assert.deepEqual(familyReviewPlan(team,'luna',{criticality:'important'}).reviewers,['sonnet','antigravity']);
 assert.throws(()=>familyReviewPlan(team,'grok'),/cannot own/);
 // 리드 모델을 알 수 없으면 계열은 unknown이고, 일꾼 계열만으로 R0을 따진다.
 assert.equal(compose({lead:{model:'auto'},candidates:ALL}).lead.family,'unknown');
});
