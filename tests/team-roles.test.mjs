import test from 'node:test';
import assert from 'node:assert/strict';
import {apexMember,specialistMember,grantOnlyMembers,reservedMembers,delegableOwners,excludedMembers,compatibleLead} from '../scripts/team-roles.mjs';
import {automaticImplementer} from '../scripts/executor-config.mjs';
import {takeAssignment,planReview,panelSeats,initialGrant,assertImplementRound,implementDispatch,executionAllowed,sameAssignment,FAMILY_RULES_POLICY} from '../scripts/review-plan.mjs';

const ALL={grok:1,antigravity:1,sonnet:1,haiku:1,luna:1};
const conf=(lead_model,extra={})=>({lead_model,routing:{policy:'external-first'},review:{strategy:'lead-gated-adaptive',reviewers:['sol','sonnet','antigravity','grok','luna','haiku']},external:{available:Object.keys(ALL)},...extra});
const take=(c,input)=>takeAssignment(c,{...input});

test('an Opus lead keeps the fixed names for every seat; A-tier Sonnet implements without a grant',()=>{
 const c=conf('claude-opus-5-5');
 assert.equal(apexMember(c),'sol');assert.equal(specialistMember(c),'sonnet');
 assert.deepEqual(grantOnlyMembers(c),['sol']);assert.deepEqual(reservedMembers(c),['haiku']);
 assert.deepEqual(delegableOwners(c),['grok','antigravity','sonnet','haiku','luna','terra']);
 assert.equal(automaticImplementer(c,'sonnet'),true);assert.equal(automaticImplementer(c,'terra'),true);assert.equal(automaticImplementer(c,'sol'),false);
 // Haiku는 B급 일꾼이라 운영자가 claude_reserve를 켤 때만 자동 후보에서 빠진다.
 assert.equal(automaticImplementer(c,'haiku'),true);assert.equal(automaticImplementer({...c,routing:{...c.routing,claude_reserve:true}},'haiku'),false);assert.deepEqual(excludedMembers(c),[]);
 assert.equal(compatibleLead(c),true);
 // 레지스트리에 없는 이전 Opus도 계열은 접두사로 anthropic이다.
 assert.equal(apexMember(conf('claude-opus-4-7')),'sol');
});

test('a Codex lead swaps the specialist and the APEX seat',()=>{
 const astra=conf('gpt-6.1-astra');
 assert.equal(apexMember(astra),'sonnet');assert.equal(specialistMember(astra),'sol');assert.deepEqual(reservedMembers(astra),['luna']);
 assert.equal(automaticImplementer(astra,'haiku'),true);
 for(const name of ['sonnet','sol'])assert.equal(automaticImplementer(astra,name),false,name);
 assert.equal(automaticImplementer(astra,'luna'),true);
 const sol=conf('gpt-6.1-sol-high');
 // Sol 리드에서는 같은 계열 frontier인 Terra가 전문가 자리다.
 assert.deepEqual(excludedMembers(sol),['sol']);assert.equal(specialistMember(sol),'terra');
 assert.equal(take(sol,{task_criticality:'important',assignment_strategy:'sonnet_implementation',assignment_reason:'x'}).authorized_implementer,'terra');
 const argon=conf('gemini-4-argon');
 // 리드 계열 일반 일꾼은 claude_reserve를 켰을 때만 자동 후보에서 빠진다.
 assert.equal(automaticImplementer(argon,'antigravity'),true);assert.equal(automaticImplementer(argon,'haiku'),true);
 assert.equal(automaticImplementer({...argon,routing:{...argon.routing,claude_reserve:true}},'antigravity'),false);
 assert.equal(specialistMember(argon),'sonnet');
});

test('a non-Claude lead records its team and reviews by family rules',()=>{
 const c=conf('gpt-6.1-astra');
 assert.throws(()=>take({...c,review:{reviewers:['sol']}},{}),/non-Claude lead requires/);
 const a=take(c,{task_criticality:'important',assignment_reason:'payments'});
 assert.equal(a.review_policy,FAMILY_RULES_POLICY);
 assert.deepEqual(a.team,{lead_model:'gpt-6.1-astra',candidates:['grok','antigravity','sonnet','haiku','luna','sol']});
 assert.equal(sameAssignment(a,{...a,team:{...a.team,candidates:['luna','sol']}}),false);
 const plan=planReview('haiku',a);
 assert.deepEqual(plan.reviewers,['sol','grok']);assert.deepEqual(plan.effort,{sol:'xhigh',grok:'xhigh'});
 assert.equal(plan.families.haiku,'anthropic');
 // 작성자와 같은 계열은 바꿔 끼운 자리도 채우지 못한다.
 assert.throws(()=>panelSeats(plan,{asked:['sonnet','grok'],reason:'quota'}),/same-vendor/);
 assert.throws(()=>panelSeats(plan,{asked:['sol','luna'],reason:'quota'}),/distinct vendors/);
 assert.deepEqual(panelSeats(plan,{asked:['luna','grok'],reason:'Sol quota'}).reviewers,['luna','grok']);
 // 같은 계열만 남는 팀은 init에서 거절한다.
 assert.throws(()=>take({...c,external:{available:['luna']},review:{strategy:'lead-gated-adaptive',reviewers:['sol']}},{}),/TEAM_SINGLE_FAMILY/);
});

test('a Codex lead opens Sol as the specialist and Sonnet as APEX through grants',()=>{
 const c=conf('gpt-6.1-astra');
 const a=take(c,{task_criticality:'important',assignment_strategy:'sonnet_implementation',assignment_reason:'specialist'});
 assert.equal(a.authorized_implementer,'sol');
 const grant=initialGrant(a);
 assert.equal(grant.executor,'sol');assert.equal(grant.sandbox,'workspace-write');assert.equal(grant.effort,'medium');
 const state={configuration:c,implement_grant:grant,iteration:0};
 assert.equal(assertImplementRound(state,'sol'),grant);
 assert.equal(implementDispatch(state,'sol').apexGrant,true);
 assert.equal(executionAllowed({...state,phase:'EXECUTING',owner:'sol',iteration:1,implement_grant:{...grant,round:1}}),true);
 assert.throws(()=>assertImplementRound(state,'sonnet'),/unconsumed controller implement grant/);
 const apex=take(c,{task_criticality:'apex',assignment_strategy:'sol_apex',assignment_reason:'schema'});
 assert.equal(apex.authorized_implementer,'sonnet');
 const sonnetGrant=initialGrant(apex);
 assert.equal(sonnetGrant.sandbox,null);
 const s={configuration:c,implement_grant:sonnetGrant,iteration:0};
 assert.equal(assertImplementRound(s,'sonnet'),sonnetGrant);
 assert.equal(implementDispatch(s,'sonnet').apexGrant,false);
 assert.deepEqual(planReview('sonnet',apex).reviewers,['lead']);
});
