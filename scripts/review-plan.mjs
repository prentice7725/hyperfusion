// 라운드 작성자 기준의 리뷰 계획. 모델 호출은 하지 않는다.
// 최소 원칙은 하나다: 라운드를 구현한 모델은 그 라운드를 리뷰하지 않는다.
// 계획은 기본 리뷰어와 자리 수를 정한다. 한도·장애로 기본 리뷰어가 못 하면 리드가 사유를 적고 다른 모델로 바꿔 끼운다.
// 저장소 설정이나 워커 JSON은 자리 수를 줄이거나 리뷰어를 바꾸지 못한다. 최종 판정은 언제나 리드다.

import {EXECUTORS,externalFirst,DIFFICULTY_EFFORT,automaticImplementer} from './executor-config.mjs';

export const CRITICALITIES=['standard','important','apex'];
export const ASSIGNMENT_STRATEGIES=['external_primary','dual_review','sonnet_implementation','sol_apex'];
const OWNERS=['grok','antigravity','haiku','luna','sonnet','sol','lead'];

// 이름을 받아 적기만 하면 승인된 것처럼 보이므로 아직 거절한다.
const LATER=['explicit_repair'];
// 기본 리뷰어의 강도. 바꿔 낀 리뷰어도 같은 값을 쓰고, 표에 없으면 설정값을 쓴다.
export const REVIEW_EFFORT={sol:'medium',sonnet:'high'};
// 같은 회사 모델끼리의 리뷰는 허용하되 교차 검증이 약하다는 표시를 남긴다.
const FAMILY={sonnet:'anthropic',haiku:'anthropic',lead:'anthropic',sol:'openai',luna:'openai',grok:'xai',antigravity:'google'};
export const sameFamily=(a,b)=>!!FAMILY[a]&&FAMILY[a]===FAMILY[b];

export function planReview(owner,{criticality='standard',strategy='external_primary'}={}) {
 if(!OWNERS.includes(owner))throw Error('ADAPTIVE_REVIEW: unknown round owner '+owner);
 if(!CRITICALITIES.includes(criticality))throw Error('ADAPTIVE_REVIEW: task_criticality must be standard, important, or apex');
 if(!ASSIGNMENT_STRATEGIES.includes(strategy))throw Error('ADAPTIVE_REVIEW: assignment_strategy is not enabled');
 // 이중 리뷰는 Grok/AGY에 대해서만 Sol+Sonnet이다. Luna/Haiku의 독립성 규칙을 숫자 맞추기로 깨지 않는다.
 const raised=criticality==='important'||criticality==='apex'||strategy==='dual_review';
 const dual=raised&&(owner==='grok'||owner==='antigravity');
 let reviewers;
 if(dual)reviewers=['sol','sonnet'];
 else if(owner==='luna')reviewers=['sonnet'];
 else if(owner==='sol')reviewers=['lead'];
 else reviewers=['sol'];
 if(reviewers.includes(owner))throw Error('ADAPTIVE_REVIEW: self-review is refused');
 if(owner==='luna'&&reviewers.includes('sol'))throw Error('ADAPTIVE_REVIEW: Sol cannot independently review Luna');
 if(owner==='haiku'&&reviewers.includes('sonnet'))throw Error('ADAPTIVE_REVIEW: Sonnet cannot replace Sol for a Haiku round');
 if(owner==='sonnet'&&reviewers.includes('sonnet'))throw Error('ADAPTIVE_REVIEW: Sonnet cannot review its own round');
 return {owner,criticality,strategy,reviewers,effort:reviewEffort(reviewers)};
}

export function reviewEffort(reviewers) {
 return Object.fromEntries(reviewers.filter(e=>REVIEW_EFFORT[e]).map(e=>[e,REVIEW_EFFORT[e]]));
}

// 이번 위임에서 채울 자리와 리뷰어. 이미 끝난 리뷰(kept)는 다시 돌리지 않는다. 실패한 리뷰어는 기본값에서 빠지고, 다시 쓰려면 이름을 적는다.
// 기본 리뷰어가 아닌 모델을 넣으면 substitution_reason이 필요하다. 작성자 자신과 리드는 위임 리뷰어가 될 수 없다.
export function panelSeats(plan,{asked,kept=[],failed=[],reason}={}) {
 const owner=plan.owner;
 const seats=plan.reviewers.length-kept.length;
 if(seats<=0)throw Error('ADAPTIVE_REVIEW: mandatory review already finished for this round');
 const defaults=plan.reviewers.filter(e=>!kept.includes(e)&&!failed.includes(e));
 const picks=asked===undefined?defaults:asked;
 if(!Array.isArray(picks)||picks.some(e=>typeof e!=='string'))throw Error('ADAPTIVE_REVIEW: executors must be a list of reviewer names');
 if(picks.length!==seats){
  const avoid=[owner,...kept].filter((e,i,a)=>a.indexOf(e)===i).join(', ');
  throw Error(`ADAPTIVE_REVIEW: ${seats} reviewer(s) needed; name executors other than ${avoid}${failed.length?' (failed: '+failed.join(', ')+')':''} with substitution_reason`);
 }
 if(new Set(picks).size!==picks.length)throw Error('ADAPTIVE_REVIEW: reviewers must be distinct');
 if(picks.includes(owner))throw Error('ADAPTIVE_REVIEW: self-review is refused; '+owner+' implemented this round');
 if(picks.includes('lead'))throw Error('ADAPTIVE_REVIEW: the lead is not a delegated reviewer; use lead-decision');
 const reused=picks.filter(e=>kept.includes(e));
 if(reused.length)throw Error('ADAPTIVE_REVIEW: already reviewed this round: '+reused.join(', '));
 const substitutes=picks.filter(e=>!plan.reviewers.includes(e));
 const why=typeof reason==='string'?reason.trim():'';
 if(substitutes.length&&!why)throw Error('ADAPTIVE_REVIEW: substitution_reason is required to replace the planned reviewer ('+plan.reviewers.join(', ')+')');
 return {reviewers:picks,effort:reviewEffort(picks),substitutes,substitution_reason:substitutes.length?why:null,kept:[...kept]};
}

// 계획한 자리 수만큼 작성자와 다른 모델이 같은 digest에서 pass했는지. 이름이 아니라 자리로 센다.
export function reviewCoverage(plan,records,digest) {
 const passed=[...new Set((records??[]).filter(r=>r?.ok&&r.verdict==='pass'&&r.digest===digest&&r.executor!==plan.owner).map(r=>r.executor))];
 const substitutes=passed.filter(e=>!plan.reviewers.includes(e));
 const gaps=plan.reviewers.filter(e=>e!=='lead'&&!passed.includes(e)).slice(substitutes.length);
 const same_family=passed.filter(e=>sameFamily(e,plan.owner));
 return {covered:gaps.length===0&&passed.length>=plan.reviewers.filter(e=>e!=='lead').length,passed,substitutes,gaps,same_family};
}

// 컨트롤러가 init에서만 남기는 배정. 브리프나 저장소 설정으로 다시 읽지 않는다.
export function takeAssignment(configuration,input) {
 const adaptive=configuration?.review?.strategy==='lead-gated-adaptive';
 const present=['task_criticality','assignment_strategy','assignment_reason'].filter(k=>input?.[k]!==undefined);
 if(!adaptive){
  if(present.length)throw Error('ADAPTIVE_REVIEW: task_criticality requires review.strategy lead-gated-adaptive');
  return null;
 }
 if(LATER.includes(input.assignment_strategy))throw Error('ADAPTIVE_REVIEW: '+input.assignment_strategy+' is not enabled in this phase');
 const criticality=input.task_criticality??'standard';
 const strategy=input.assignment_strategy??'external_primary';
 if(!CRITICALITIES.includes(criticality))throw Error('ADAPTIVE_REVIEW: task_criticality must be standard, important, or apex');
 if(!ASSIGNMENT_STRATEGIES.includes(strategy))throw Error('ADAPTIVE_REVIEW: assignment_strategy must be external_primary, dual_review, sonnet_implementation, or sol_apex');
 if(strategy==='sonnet_implementation'&&criticality!=='important')throw Error('ROLE_GATE: sonnet_implementation requires task_criticality important');
 if(strategy==='sol_apex'&&criticality!=='apex')throw Error('ROLE_GATE: sol_apex requires task_criticality apex');
 const reason=input.assignment_reason??'controller assignment at init';
 if(typeof reason!=='string'||!reason.trim())throw Error('ADAPTIVE_REVIEW: assignment_reason must be text');
 delete input.task_criticality;delete input.assignment_strategy;delete input.assignment_reason;
 const authorized_implementer=strategy==='sonnet_implementation'?'sonnet':strategy==='sol_apex'?'sol':null;
 return {criticality,strategy,reason:reason.trim(),revision:1,final_decider:'lead',set_by:'controller',authorized_implementer};
}

export function sameAssignment(recorded,current) {
 if(!recorded||!current)return false;
 return recorded.criticality===current.criticality&&recorded.strategy===current.strategy
  &&recorded.revision===current.revision&&recorded.reason===current.reason
  &&recorded.final_decider===current.final_decider&&recorded.set_by===current.set_by
  &&(recorded.authorized_implementer??null)===(current.authorized_implementer??null);
}

// 구현 승인은 라운드가 끝나면 만료된다. 저장소 설정이나 워커 JSON에는 만들지 않는다.
export function makeGrant({executor,strategy,criticality,reason,revision}) {
 const specialist=executor==='sol'
  ?{effort:'medium',sandbox:'workspace-write'}
  :{effort:'high',sandbox:null};
 return {revision,executor,role:'implement',strategy,criticality,reason,round:null,set_by:'controller',...specialist};
}

export function initialGrant(assignment) {
 if(assignment?.strategy==='sonnet_implementation')return makeGrant({executor:'sonnet',strategy:assignment.strategy,criticality:assignment.criticality,reason:assignment.reason,revision:1});
 if(assignment?.strategy==='sol_apex')return makeGrant({executor:'sol',strategy:assignment.strategy,criticality:assignment.criticality,reason:assignment.reason,revision:1});
 return null;
}

export function sameGrant(recorded,grant) {
 if(!recorded||!grant||recorded.round!=null)return false;
 const fields=['revision','executor','role','strategy','criticality','reason','effort','sandbox','set_by'];
 return fields.every(k=>recorded[k]===grant[k]);
}

// 옵트인 작업에서 Sonnet/Sol 구현은 소모되지 않은 컨트롤러 승인이 있을 때만 연다.
export function assertImplementRound(state,owner) {
 if(state?.configuration?.review?.strategy!=='lead-gated-adaptive'){
  if(externalFirst(state?.configuration)&&['sonnet','sol'].includes(owner))throw Error('ROLE_GATE: '+owner+' requires adaptive controller authorization');
  return null;
 }
 if(owner!=='sonnet'&&owner!=='sol')return null;
 const grant=state.implement_grant;
 const open=grant&&grant.executor===owner&&grant.role==='implement'&&grant.round==null&&grant.set_by==='controller';
 if(!open)throw Error(`ROLE_GATE: ${owner} needs an unconsumed controller implement grant`);
 if(owner==='sol'&&!(grant.strategy==='sol_apex'&&grant.sandbox==='workspace-write'&&grant.criticality==='apex'&&grant.effort==='medium')){
  throw Error('ROLE_GATE: Sol implements only an APEX round');
 }
 if(owner==='sonnet'&&!(grant.effort==='high'&&(grant.strategy==='sonnet_implementation'||grant.strategy==='reassign_to_sonnet'))){
  throw Error('ROLE_GATE: Sonnet implements only an authorized important or reassigned round');
 }
 if(grant.strategy==='sonnet_implementation'&&grant.criticality!=='important')throw Error('ROLE_GATE: sonnet_implementation requires task_criticality important');
 return grant;
}

// 실행 직전과 검증이 같은 강도와 sandbox를 다시 만들게 한다. 승인 없는 Sol은 여기서 쓰기가 되지 않는다.
export function implementDispatch(state,owner) {
 const options={...(state.configuration?.executors?.[owner]??{})};
 const grant=state.implement_grant;
 const adaptive=state.configuration?.review?.strategy==='lead-gated-adaptive';
 const round=state.iteration??0;
 const active=!!(adaptive&&grant&&grant.executor===owner&&grant.role==='implement'&&grant.set_by==='controller'&&(grant.round==null||grant.round===round));
 // External-First: 운영자가 강도를 직접 적지 않은 Grok/AGY는 작업 난이도에 맞춘다.
 const table=DIFFICULTY_EFFORT[owner];
 const difficulty=state.routing?.difficulty;
 if(externalFirst(state.configuration)&&table&&table[difficulty]&&state.configuration?.effort_source?.[owner]==='default')options.reasoning_effort=table[difficulty];
 if(active&&grant.effort)options.reasoning_effort=grant.effort;
 const apexGrant=!!(active&&owner==='sol'&&grant.strategy==='sol_apex'&&grant.sandbox==='workspace-write'&&grant.criticality==='apex');
 return {options,apexGrant};
}

export function executionAllowed(state) {
 if(!state||state.phase!=='EXECUTING')return false;
 const owner=state.owner;
 const adaptive=state.configuration?.review?.strategy==='lead-gated-adaptive';
 const grant=state.implement_grant;
 if(owner==='sol'){
  return !!(adaptive&&grant&&grant.executor==='sol'&&grant.round===state.iteration&&grant.role==='implement'&&grant.strategy==='sol_apex'&&grant.sandbox==='workspace-write');
 }
 if(!EXECUTORS.includes(owner))return false;
 if(owner==='haiku'&&!automaticImplementer(state.configuration,owner)&&!explicitImplementation(state,owner))return false;
 if(adaptive&&owner==='sonnet')return !!(grant&&grant.executor==='sonnet'&&grant.round===state.iteration&&grant.role==='implement');
 // External-First만 켜진 작업에는 grant 장치가 없다. Sonnet 구현 라운드를 열 수 없다.
 if(!adaptive&&owner==='sonnet'&&externalFirst(state.configuration))return false;
 return true;
}

export function explicitImplementation(state,owner) {
 return (state.routing?.mode==='explicit'&&state.initial_executor===owner)
  ||(state.lead_decision?.next_executor===owner)
  ||(state.implementation_selection?.executor===owner&&state.implementation_selection?.source==='explicit');
}

export function samePlan(recorded,current) {
 if(!recorded||!current)return false;
 const reviewers=recorded.reviewers??[];
 return recorded.owner===current.owner&&recorded.criticality===current.criticality&&recorded.strategy===current.strategy
  &&recorded.revision===current.revision&&JSON.stringify(recorded.effort)===JSON.stringify(current.effort)
  &&reviewers.length===current.reviewers.length&&reviewers.every((e,i)=>e===current.reviewers[i]);
}

// 한 명의 pass를 전원 pass로 세지 않는다. digest가 다르면 합의로 치지 않는다.
export function aggregateVerdicts(records) {
 if(!Array.isArray(records)||!records.length)return {status:'reviewer_failed'};
 if(records.some(r=>!r?.ok||!r.verdict))return {status:'reviewer_failed'};
 const digest=records[0].digest;
 if(!digest||records.some(r=>r.digest!==digest))return {status:'conflict'};
 const verdicts=new Set(records.map(r=>r.verdict));
 if(verdicts.size!==1)return {status:'conflict'};
 return {status:'unanimous',verdict:records[0].verdict,digest};
}
