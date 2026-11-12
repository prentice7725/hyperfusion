// 설정의 리드 모델로 일꾼의 역할을 찾는다. 이름(sol, sonnet, haiku)을 코드에 박지 않고 역할로 묻는다.
// 역할은 등록된 모든 일꾼을 후보로 계산한다. 설치 여부나 한도로 역할이 바뀌지 않게 하기 위해서다(설치는 canWork가 따로 본다).
// Opus 리드에서는 지금 동작과 같다: APEX는 Sol, 전문가는 Sonnet, 예비는 Haiku.

import {compose} from './team-composer.mjs';
import {MEMBER_PROFILES,memberEligible} from './model-registry.mjs';
import {MEMBERS} from './member-registry.mjs';

export const DEFAULT_LEAD_MODEL='claude-opus-5-5';
const memo=new Map();

export function roleTeam(configuration) {
 const model=configuration?.lead_model??DEFAULT_LEAD_MODEL;
 if(!memo.has(model))memo.set(model,compose({lead:{model},candidates:Object.keys(MEMBER_PROFILES)}));
 return memo.get(model);
}
// 순서는 공개 명단(MEMBERS) 순서를 따른다. 오류 문구와 기록이 지금과 같게 나오게 하기 위해서다.
const named=(c,...roles)=>Object.keys(MEMBERS).filter(n=>roles.includes(roleTeam(c).roles[n]));

// APEX 구현자: 리드와 계열이 다른 frontier 중 1순위. 리드가 판정한다.
export const apexMember=c=>named(c,'external_top')[0]??null;
// 전문가 구현(sonnet_implementation·REASSIGN_TO_SONNET이 여는 자리): 리드 계열 frontier, 없으면 외부 전문가.
// 같은 역할이 여럿이면 리뷰 순번이 앞선 일꾼이다(Codex 리드면 Terra가 아니라 Sol).
const byRank=(c,list)=>[...list].sort((a,b)=>(roleTeam(c).members[a].review_rank??99)-(roleTeam(c).members[b].review_rank??99));
export const specialistMember=c=>byRank(c,named(c,'lead_family_specialist'))[0]??byRank(c,named(c,'external_specialist'))[0]??null;
// 컨트롤러 grant 없이는 구현하지 못하는 일꾼: 외부 최상위(Opus 리드면 Sol)와, 평소 구현 명단에 없는 전문가(Codex 리드의 Sol)다.
// 등급제에서 구현 명단에 있는 frontier 전문가(Sonnet·Terra)는 A급 일꾼이라 grant 없이 구현한다.
export const grantOnlyMembers=c=>named(c,'external_top','external_specialist','lead_family_specialist').filter(n=>roleTeam(c).roles[n]==='external_top'||!MEMBERS[n].implement);
// 비용 정책으로 자동 선택에서 빼는 리드 계열 일반 일꾼(claude_reserve).
export const reservedMembers=c=>named(c,'lead_family_general');
// 리드와 같은 모델이라 일꾼 자리를 내놓은 일꾼.
export const excludedMembers=c=>named(c,'excluded');
// 위임 자동 승인을 받을 수 있는 작성자: grant 없이 구현하는 일꾼.
export const delegableOwners=c=>named(c,'external_specialist','external_general','lead_family_specialist','lead_family_general');
export const leadFamily=c=>roleTeam(c).lead.family;
// 구현자·리뷰어의 계열. 'lead'는 리드 계열, 명단에 없는 이름(controller 등)은 unknown.
export const memberFamilyOf=(c,name)=>name==='lead'?leadFamily(c):roleTeam(c).members[name]?.family??'unknown';
// 기존 리뷰 정책(legacy-v1, cross-vendor-pairs-v1)은 Anthropic 리드의 역할 배치를 전제로 한다.
export const compatibleLead=c=>leadFamily(c)==='anthropic';
// Opus보다 위 모델(Fable)이 리드인지. 그러면 Opus가 일꾼이 되므로 적응형 리뷰는 일반 규칙(family-rules-v1)을 쓴다.
export const upperLead=c=>memberEligible('opus',c?.lead_model??DEFAULT_LEAD_MODEL);
