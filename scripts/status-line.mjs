import fs from 'node:fs';
import {read} from './artifact.mjs';
import {controlPath} from './control-dir.mjs';
import {CAP,APEX_ROUND_CAP} from './executor-config.mjs';
import {TERMINAL_PHASES,nextAction} from './state-policy.mjs';

// 작업 상태 한 줄. 사용자가 "지금 어디까지 왔나"를 리드에게 묻지 않고 바로 볼 수 있게 한다.
// 상태 파일만 읽는다(모델 호출도, 잠금도, 상태 변경도 없다). 같은 문장을 세 곳이 쓴다:
//   · fusion-state.mjs line REPO      명령줄에서 직접 확인
//   · lead-guard.mjs UserPromptSubmit  프롬프트를 보낼 때 사용자 화면에만 한 줄(모델 컨텍스트에는 들어가지 않는다)
//   · mods/hf-status                  프롬프트 위 띠(터미널·데스크톱)

// 단계를 사용자가 읽는 말로. 원래 이름도 함께 보여 줘서 문서·로그와 대조할 수 있게 한다.
const PHASE_LABEL={
 PLAN:'시작 대기',REDO:'재작업 대기',ALTERNATIVE_REQUIRED:'교체 일꾼 필요',TAKEOVER_REQUIRED:'리드 직접 수정 승인 필요',
 EXECUTING:'일꾼 실행 중',REVIEW:'리뷰 차례',LEAD_DECISION_REQUIRED:'리드 판단 차례',DECISION_REQUIRED:'사용자 판단 필요',
 VERIFY:'검증 차례',RECOVERY_REQUIRED:'복구 필요'
};

// 일꾼의 라운드 사용량. Sol은 별도 상한(APEX_ROUND_CAP)을 쓴다. 상한에 닿으면 REDO가 거절되므로 표시해 둔다.
function rounds(s) {
 const owner=s.owner;
 if(!owner)return null;
 const used=owner==='sol'?s.apex_rounds??0:s.attempts?.[owner]??0;
 const cap=owner==='sol'?APEX_ROUND_CAP:CAP[owner];
 if(cap===undefined)return owner;
 return `${owner} ${used}/${cap}${used>=cap?' 상한':''}`;
}

// 진행 중인 작업이 없으면 빈 문자열. 호출하는 쪽은 빈 문자열이면 아무것도 보이지 않는다.
export function statusLine(s) {
 if(!s||typeof s.phase!=='string'||TERMINAL_PHASES.includes(s.phase))return '';
 const consult=!!s.open_consult;
 const label=PHASE_LABEL[s.phase];
 const parts=[String(s.task_id??'?').slice(0,40),label?`${s.phase} ${label}`:s.phase,rounds(s),consult?'상담 열림':null,
  `다음 ${nextAction(s.phase,consult)??'status'}`];
 return 'HF ▸ '+parts.filter(Boolean).join(' │ ');
}

// 저장소 루트에서 상태를 읽어 한 줄로. 상태가 없거나 읽지 못하면 빈 문자열(상태 표시가 작업을 막으면 안 된다).
export function readStatusLine(root) {
 try{
  const file=controlPath(root,'state.json');
  if(!fs.existsSync(file))return '';
  return statusLine(read(file));
 }catch{return '';}
}
