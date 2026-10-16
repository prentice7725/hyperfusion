// 위임 승인(재량권). 리드가 작업을 시작할 때(init) 한 번만 주는 컨트롤러 기록이다.
// 저장소 설정, 일꾼 출력, begin 이후의 brief로는 만들거나 바꿀 수 없다(assignment, implement_grant와 같은 규칙).
// 이 기록이 있는 STANDARD 작업은 조건이 전부 맞을 때만 컨트롤러가 라운드를 승인할 수 있고, 하나라도 부족하면 리드 게이트에서 멈춘다.
// 모델은 호출하지 않는다. 승인 기록은 리드가 직접 검토한 것처럼 보이지 않도록 authority.source를 delegated-policy로 남긴다.
import {criterionIds} from './ac-trace.mjs';

export const DELEGATION_POLICIES=['standard-auto'];
export const MAX_DELEGATED_ROUNDS=3;
export const DEFAULT_DELEGATED_ROUNDS=2;
// 재량권 아래 자동 복구의 한도와 제외 대상. 다시 시도해도 같은 결과일 실패(권한·인증·한도·변조)는 리드에게 올린다.
export const AUTO_RECOVERY_CAP=2;
export const NON_RETRYABLE=/permission|denied|forbidden|unauthori[sz]ed|authenticat|login|api[ _-]?key|credential|sign(?:ed)?[ _-]?in|quota|rate[ _-]?limit|credit|billing|tamper|provenance|ROLE_GATE|not installed|ENOENT|DISPATCH_/i;
// 자동 구현자. 이 일꾼들의 STANDARD 라운드만 위임 대상이다(Sonnet·Sol 구현은 별도 grant가 필요한 중요·APEX 작업이다).
export const DELEGABLE_OWNERS=['grok','antigravity','haiku','luna'];

// init 입력에서 delegation을 꺼내 검사하고 입력에서 지운다. 없으면 null.
export function takeDelegation(configuration,assignment,input) {
 if(input?.delegation===undefined)return null;
 const d=input.delegation;
 const fail=why=>Error('DELEGATION: '+why);
 if(configuration?.review?.strategy!=='lead-gated-adaptive')throw fail('requires review.strategy "lead-gated-adaptive" (the lead gate is what the policy stands in for)');
 if(!d||typeof d!=='object'||Array.isArray(d))throw fail('delegation must be an object {policy, reason, max_rounds?}');
 const unknown=Object.keys(d).filter(k=>!['policy','reason','max_rounds','allow_preserve'].includes(k));
 if(unknown.length)throw fail('unknown field '+unknown.join(', '));
 if(!DELEGATION_POLICIES.includes(d.policy))throw fail('policy must be one of '+DELEGATION_POLICIES.join(', '));
 if(typeof d.reason!=='string'||!d.reason.trim()||d.reason.length>300)throw fail('reason must be a short text saying why this task may be approved without the lead');
 const rounds=d.max_rounds??DEFAULT_DELEGATED_ROUNDS;
 if(!Number.isSafeInteger(rounds)||rounds<1||rounds>MAX_DELEGATED_ROUNDS)throw fail(`max_rounds must be an integer from 1 to ${MAX_DELEGATED_ROUNDS}`);
 if(assignment?.criticality!=='standard'||assignment?.strategy!=='external_primary')throw fail('only a STANDARD task with the external_primary strategy can be delegated; important and apex tasks stay with the lead');
 if(!input.acceptance_commands?.length)throw fail('acceptance_commands are required (the controller\'s own test run is the evidence)');
 if(d.allow_preserve!==undefined&&typeof d.allow_preserve!=='boolean')throw fail('allow_preserve must be true or false');
 const preserve=input.verification?.kind==='preserve';
 if(preserve){
  // 리팩터링: red-first 대신 보호 경로 불변이 증거다. 리드가 이 작업에 한해 명시적으로 허용해야 한다.
  if(d.allow_preserve!==true)throw fail('a preserve (refactor) task is delegated only when the lead sets allow_preserve:true');
  if(input.task_kind!=='refactor')throw fail('a delegated preserve task must say task_kind:"refactor"');
 } else if(input.acceptance_baseline_green!==undefined)throw fail('commands that already pass before any change cannot back a delegated approval (red-first is required, or use verification preserve with allow_preserve:true)');
 if(d.allow_preserve===true&&!preserve)throw fail('allow_preserve applies only to a task with verification preserve');
 const ids=criterionIds(input.success_criteria);
 if(!ids.length)throw fail('success_criteria must carry AC ids (AC1, AC2...)');
 const mapped=Object.keys(input.acceptance_map??{}).map(x=>x.toUpperCase());
 const missing=ids.filter(id=>!mapped.includes(id));
 if(missing.length)throw fail('acceptance_map must cover every AC; missing '+missing.join(', '));
 delete input.delegation;
 return {policy:d.policy,reason:d.reason.trim(),max_rounds:rounds,allow_preserve:d.allow_preserve===true,revision:1,granted_by:'lead-at-init',set_by:'controller'};
}

export function sameDelegation(recorded,current) {
 if(!recorded||!current)return false;
 return ['policy','reason','max_rounds','allow_preserve','revision','granted_by','set_by'].every(k=>recorded[k]===current[k]);
}

// 승인 때 브리프가 처음 계약에서 벗어나지 않았는지 비교하는 필드.
export const CONTRACT_FIELDS=['communication_language','verification','success_criteria','acceptance_commands','acceptance_map','acceptance_artifacts','acceptance_timeout_ms'];
export function contractChanged(initial,current) {
 const same=(a,b)=>JSON.stringify(a??null)===JSON.stringify(b??null);
 return CONTRACT_FIELDS.filter(k=>!same(initial?.[k],current?.[k])).concat(same(initial?.scope?.paths,current?.scope?.paths)?[]:['scope.paths']);
}

// 반려 위임. 리드가 init에서 한 번만 주는 별도의 권한으로, 승인 권한(delegation)과 독립이다.
// 필수 리뷰어 전원이 같은 라운드 digest에서 근거(수용 기준 ID + 파일·줄 blocker/major 지적)를 들어 redo라고 하면
// 컨트롤러가 리드 대신 같은 일꾼에게 돌려보낸다. 승인·교체·범위 변경은 하지 못하고, 조건이 하나라도 부족하면 리드 게이트에서 멈춘다.
export const MAX_AUTO_REDOS=2;
export function takeRedoDelegation(configuration,assignment,input) {
 if(input?.redo_delegation===undefined)return null;
 const d=input.redo_delegation;
 const fail=why=>Error('REDO_DELEGATION: '+why);
 if(configuration?.review?.strategy!=='lead-gated-adaptive')throw fail('requires review.strategy "lead-gated-adaptive" (the lead gate is what the policy stands in for)');
 if(!d||typeof d!=='object'||Array.isArray(d))throw fail('redo_delegation must be an object {reason, max_redos?}');
 const unknown=Object.keys(d).filter(k=>!['reason','max_redos'].includes(k));
 if(unknown.length)throw fail('unknown field '+unknown.join(', '));
 if(typeof d.reason!=='string'||!d.reason.trim()||d.reason.length>300)throw fail('reason must be a short text saying why reviewers may send this task back without the lead');
 const redos=d.max_redos??MAX_AUTO_REDOS;
 if(!Number.isSafeInteger(redos)||redos<1||redos>MAX_AUTO_REDOS)throw fail(`max_redos must be an integer from 1 to ${MAX_AUTO_REDOS}`);
 if(assignment?.criticality!=='standard'||assignment?.strategy!=='external_primary')throw fail('only a STANDARD task with the external_primary strategy can delegate rejections; important and apex tasks stay with the lead');
 if(!criterionIds(input.success_criteria).length)throw fail('success_criteria must carry AC ids (AC1, AC2...): a delegated rejection must name the criterion it fails');
 delete input.redo_delegation;
 return {policy:'evidence-redo',reason:d.reason.trim(),max_redos:redos,revision:1,granted_by:'lead-at-init',set_by:'controller'};
}
export function sameRedoDelegation(recorded,current) {
 if(!recorded||!current)return false;
 return ['policy','reason','max_redos','revision','granted_by','set_by'].every(k=>recorded[k]===current[k]);
}
