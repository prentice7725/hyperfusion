export const TERMINAL_PHASES=['CLOSE','BLOCKED','ARCHIVED'];
export const ACTION_PHASES={
 begin:['PLAN','REDO','ALTERNATIVE_REQUIRED','TAKEOVER_REQUIRED'],
 finish:['EXECUTING'],review:['REVIEW'],'lead-decision':['LEAD_DECISION_REQUIRED'],'policy-approve':['LEAD_DECISION_REQUIRED'],'auto-recover':['EXECUTING'],'auto-substitute-review':['LEAD_DECISION_REQUIRED'],
 decide:['DECISION_REQUIRED'],verify:['VERIFY'],
 consult:['PLAN','REVIEW','REDO','ALTERNATIVE_REQUIRED','DECISION_REQUIRED'],
 // 게이트의 재위임은 리뷰어가 끝내지 못한 라운드만 컨트롤러가 받는다.
 // VERIFY: 같은 계열의 승인만 있는 라운드(SAME_FAMILY_VERIFICATION)에 다른 계열의 리뷰를 더할 수 있다.
 'delegate-review':['REVIEW','LEAD_DECISION_REQUIRED','VERIFY'],
 'grant-implement':['PLAN','REDO','ALTERNATIVE_REQUIRED','REVIEW','DECISION_REQUIRED'],
 'consult-finish':['PLAN','REVIEW','REDO','ALTERNATIVE_REQUIRED','DECISION_REQUIRED','LEAD_DECISION_REQUIRED','VERIFY'],
 recover:['PLAN','REDO','ALTERNATIVE_REQUIRED','TAKEOVER_REQUIRED','EXECUTING','RECOVERY_REQUIRED','REVIEW','LEAD_DECISION_REQUIRED']
};
export const PHASES=[...new Set([...Object.values(ACTION_PHASES).flat(),...TERMINAL_PHASES])];
export function assertAction(phase,action,input={}) {
 const allowed=action==='consult'&&input.mode==='review'?ACTION_PHASES['delegate-review']:ACTION_PHASES[action];
 if(allowed&&!allowed.includes(phase)){
  const error=Error(`Invalid phase ${phase} for ${action}`);error.code='INVALID_PHASE';throw error;
 }
}
export function nextAction(phase,consultOpen=false) {
 if(consultOpen)return 'consult-finish';
 return {PLAN:'begin',REDO:'begin with lead_feedback',ALTERNATIVE_REQUIRED:'begin with an alternative executor',
  TAKEOVER_REQUIRED:'begin with takeover_reason',EXECUTING:'run the bridge, then finish after quiescence',
  REVIEW:'review or delegate-review',LEAD_DECISION_REQUIRED:'lead-decision',VERIFY:'verify',DECISION_REQUIRED:'decide',RECOVERY_REQUIRED:'recover',
  CLOSE:'init a new task',BLOCKED:'report the blocker, then init a new task',ARCHIVED:'init a new task'}[phase];
}
export function phaseTable() {
 return ['| Phase | Allowed actions |','|---|---|',...PHASES.map(phase=>`| ${phase} | ${[
  ...Object.entries(ACTION_PHASES).filter(([,phases])=>phases.includes(phase)).map(([action])=>action),
  ...(TERMINAL_PHASES.includes(phase)?['init']:[]),'status','report','archive'].join(', ')} |`)].join('\n');
}
