// 리드와 후보 일꾼으로 팀을 계산한다. 입출력이 데이터뿐인 순수 함수이며 파일·프로세스를 건드리지 않는다.
// 기본 규칙은 배타적 리뷰다: 결과는 그것을 만든 계열이 스스로 승인하지 않는다.
// 아직 컨트롤러에 연결하지 않았다. Opus 리드의 기존 정책(legacy-v1, cross-vendor-pairs-v1)은 review-plan.mjs가 그대로 맡고,
// 여기의 family-rules-v1은 비 Claude 리드를 위한 일반 규칙이다.

import {MEMBER_PROFILES,UNKNOWN,familyOf,modelBase,memberFamily,memberTier,independent} from './model-registry.mjs';

export const FAMILY_RULES_POLICY='family-rules-v1';
export const ROLES=['external_top','external_specialist','external_general','lead_family_specialist','lead_family_general','probation','excluded'];

// lead: {model}. candidates: 설치·허용된 일꾼 이름. models: 운영자가 지정한 일꾼 모델. probation: 하네스를 아직 통과하지 못한 일꾼.
// lead_family_reserve(기본 true): 리드 계열의 일반 일꾼은 자동 구현 후보에서 뺀다(지금의 claude_reserve).
export function compose({lead,candidates=[],models={},probation=[],lead_family_reserve=true}={}) {
 const leadBase=modelBase(lead?.model);
 const leadFamily=familyOf(lead?.model);
 const members={};
 for(const name of candidates){
  if(!MEMBER_PROFILES[name])throw Error('TEAM: unknown member '+name);
  const model=models[name]??MEMBER_PROFILES[name].model;
  members[name]={family:memberFamily(name,models[name]),tier:memberTier(name,models[name]),model,review_rank:MEMBER_PROFILES[name].review_rank};
 }
 // 리드와 같은 모델은 일꾼 자리를 내놓는다.
 const excluded=Object.keys(members).filter(n=>leadBase&&modelBase(members[n].model)===leadBase);
 const active=Object.keys(members).filter(n=>!excluded.includes(n));
 const trusted=active.filter(n=>!probation.includes(n)&&members[n].family!==UNKNOWN);
 // R0: 리드를 포함해 정식 후보의 계열이 둘 이상이어야 한다. unknown과 수습은 세지 않는다.
 const families=[...new Set([leadFamily,...trusted.map(n=>members[n].family)].filter(f=>f!==UNKNOWN))];
 if(families.length<2)throw Error(`TEAM_SINGLE_FAMILY: exclusive review needs at least two model families (found ${families.join(', ')||'none'}); install a CLI from another family or use the host directly`);
 const external=trusted.filter(n=>members[n].family!==leadFamily);
 const top=external.filter(n=>members[n].tier==='frontier').sort((a,b)=>rank(members,a)-rank(members,b))[0]??null;
 const roles={};
 for(const n of excluded)roles[n]='excluded';
 for(const n of active){
  const m=members[n];
  if(probation.includes(n)||m.family===UNKNOWN)roles[n]='probation';
  else if(n===top)roles[n]='external_top';
  else if(m.family!==leadFamily)roles[n]=m.tier==='frontier'?'external_specialist':'external_general';
  else roles[n]=m.tier==='frontier'?'lead_family_specialist':'lead_family_general';
 }
 const team={policy:FAMILY_RULES_POLICY,lead:{model:lead?.model??null,model_base:leadBase,family:leadFamily},members,roles,families,lead_family_reserve};
 // R0: 자동 구현자는 계열이 다른 리뷰어(일꾼 또는 리드)가 있어야 한다.
 team.auto_implementers=active.filter(n=>roles[n]==='external_general'||(roles[n]==='lead_family_general'&&!lead_family_reserve))
  .filter(n=>reviewerPool(team,members[n].family).length>0||independent(leadFamily,members[n].family));
 return team;
}

const rank=(members,n)=>members[n].review_rank??Infinity;
const familyOfAuthor=(team,owner)=>owner==='lead'?team.lead.family:team.members[owner]?.family??UNKNOWN;
// 작성자와 독립인 정식 리뷰어. 수습·제외·unknown은 자리를 채우지 못한다.
const reviewerPool=(team,authorFamily)=>Object.keys(team.roles)
 .filter(n=>!['probation','excluded'].includes(team.roles[n])&&independent(team.members[n].family,authorFamily));

// 라운드 작성자 기준 리뷰 계획(family-rules-v1). 자리 수는 작성자와 독립인 계열 수로 정한다.
// raised: 중요 작업, 이중 리뷰 요청, 위험 경로. 리드 takeover와 외부 최상위(APEX)는 한 자리다.
export function familyReviewPlan(team,owner,{criticality='standard',strategy='external_primary',risk=[]}={}) {
 if(owner!=='lead'&&!team.roles[owner])throw Error('TEAM: unknown round owner '+owner);
 if(['probation','excluded'].includes(team.roles[owner]))throw Error('TEAM: '+owner+' cannot own an implementation round');
 const author=familyOfAuthor(team,owner);
 const raised=criticality==='important'||criticality==='apex'||strategy==='dual_review'||risk.length>0;
 // 외부 최상위의 구현은 리드가 판정한다. 정의상 리드와 계열이 다르다.
 if(team.roles[owner]==='external_top')return plan(team,owner,['lead'],'external_top authored; the lead decides',risk);
 const pool=reviewerPool(team,author).filter(n=>n!==owner);
 if(!pool.length){
  if(independent(team.lead.family,author))return plan(team,owner,['lead'],'no independent worker reviewer; lead-decision only',risk);
  throw Error('TEAM: no reviewer independent of '+owner+' ('+author+')');
 }
 // 첫 자리: frontier 우선, 리드와 다른 계열 우선, 그다음 review_rank.
 const first=[...pool].sort((a,b)=>score(team,a)-score(team,b))[0];
 const reviewers=[first];
 const second=raised&&owner!=='lead'?pool.filter(n=>independent(team.members[n].family,team.members[first].family))
  .sort((a,b)=>rank(team.members,a)-rank(team.members,b))[0]:null;
 if(second)reviewers.push(second);
 const families=new Set(pool.map(n=>team.members[n].family)).size;
 const reason=second?'two independent families':raised&&owner!=='lead'?`only ${families} independent family available`:'one seat';
 return plan(team,owner,reviewers,reason,risk);
}

function score(team,n) {
 const m=team.members[n];
 return (m.tier==='frontier'?0:100)+(m.family===team.lead.family?10:0)+Math.min(rank(team.members,n),9);
}

function plan(team,owner,reviewers,seat_reason,risk) {
 const deep=reviewers.length>1;
 const effort={};
 for(const n of reviewers){
  const p=MEMBER_PROFILES[n];
  if(!p)continue;
  const e=deep&&p.deep_review_effort?p.deep_review_effort:p.review_effort;
  if(e)effort[n]=e;
 }
 return {owner,policy:team.policy,reviewers,effort,seat_reason,risk:[...risk]};
}
