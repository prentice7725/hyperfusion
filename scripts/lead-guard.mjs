import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isMain} from './platform.mjs';
import {read} from './artifact.mjs';
import {controlPath} from './control-dir.mjs';
import {TERMINAL_PHASES,nextAction} from './state-policy.mjs';
import {readStatusLine} from './status-line.mjs';

// Claude Code 훅. SKILL.md의 리드 규칙을 지시가 아니라 차단으로 강제한다.
//   PreToolUse 1) lease가 걸린 동안 리드는 트리를 수정하지 않는다(일꾼이 writer다).
//   PreToolUse 2) 일꾼 예산이 남아 있으면 리드는 코드를 쓰지 않는다(takeover로 lease를 받은 경우만 예외).
//   Stop       3) 리드가 처리할 단계(리뷰, 검증, 재지시 등)에 작업을 둔 채 턴을 끝내지 않는다.
//   UserPromptSubmit  4) 프롬프트를 보낼 때 작업 상태 한 줄을 사용자 화면에만 보여 준다(차단 없음, 모델 컨텍스트에 넣지 않음).
// 진행 중인 작업이 없는 저장소, Git 저장소 밖의 파일은 건드리지 않는다.
// 일꾼 Sonnet은 --safe-mode로 떠서 사용자 훅이 꺼지므로 이 훅에 막히지 않는다.

export const GUARDED_TOOLS=['Edit','Write','MultiEdit','NotebookEdit'];

// 파일이 아직 없을 수도 있으니 부모로 올라가며 .git(폴더 또는 worktree의 파일)을 찾는다.
function repoRootOf(file) {
 for(let d=path.dirname(file);;){
  if(fs.existsSync(path.join(d,'.git')))return d;
  const up=path.dirname(d);if(up===d)return null;d=up;
 }
}

const deny=reason=>({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:reason}});

// 허용이면 null, 차단이면 Claude Code가 읽는 훅 출력.
export function decide(input) {
 if(!GUARDED_TOOLS.includes(input?.tool_name))return null;
 const target=input.tool_input?.file_path??input.tool_input?.notebook_path;
 if(typeof target!=='string'||!target)return null;
 const root=repoRootOf(path.resolve(input.cwd??process.cwd(),target));
 if(!root)return null;
 if(fs.existsSync(controlPath(root,'locks/acceptance.json')))return deny('HyperFusion: 수용 테스트의 프로세스 정지가 확인되지 않았습니다. 남은 프로세스를 중지하고 recover 또는 archive로 기록하기 전에는 트리를 수정할 수 없습니다.');
 const stateFile=controlPath(root,'state.json'),writerFile=controlPath(root,'locks/writer.json');
 if(!fs.existsSync(stateFile)&&!fs.existsSync(writerFile))return null;
 // 상태가 있는데 읽지 못하면 막는다. 규칙을 확인할 수 없을 때 열어 두면 강제가 아니다.
 let s,lease;
 try{s=fs.existsSync(stateFile)?read(stateFile):null;lease=fs.existsSync(writerFile)?read(writerFile):null;}
 catch(e){return deny(`HyperFusion 상태를 읽을 수 없어 리드의 수정을 막았습니다(${e.message}). status로 확인하세요.`);}
 if(lease)return lease.owner==='lead'?null
  :deny(`HyperFusion: ${lease.owner}가 writer lease를 잡고 있습니다(작업 ${lease.task_id}, 라운드 ${lease.round}). lease가 걸린 동안 리드는 트리를 수정하지 않습니다. 브리지 실행 후 finish하고 review에서 판정하세요.`);
 if(!s||TERMINAL_PHASES.includes(s.phase))return null;
 return deny(`HyperFusion: 작업 ${s.task_id}가 ${s.phase} 단계입니다. 일꾼 예산이 남아 있는 동안 리드는 코드를 쓰지 않습니다. 다음 동작: ${nextAction(s.phase,!!s.open_consult)}. 리드가 직접 고치려면 takeover로 lease를 받아야 합니다.`);
}

// 리드가 바로 다음 동작을 해야 하는 단계. 일꾼 실행 중(EXECUTING)이나 사용자 판단이 필요한 단계
// (DECISION_REQUIRED, TAKEOVER_REQUIRED, RECOVERY_REQUIRED)는 멈춰도 된다.
export const LEAD_TURN=['PLAN','REVIEW','VERIFY','REDO','ALTERNATIVE_REQUIRED','LEAD_DECISION_REQUIRED'];

// Stop 훅: 리드 차례인 작업을 남기고 턴을 끝내려 하면 한 번 막고 다음 동작을 알려 준다.
// 이미 한 번 막혀 이어 가는 중(stop_hook_active)이면 통과시킨다. 사용자에게 보고하고 멈추는 것도 리드의 판단이다.
export function decideStop(input) {
 if(input?.stop_hook_active===true)return null;
 const root=repoRootOf(path.join(path.resolve(input?.cwd??process.cwd()),'.hf-stop'));
 if(!root)return null;
 const stateFile=controlPath(root,'state.json');
 if(!fs.existsSync(stateFile))return null;
 // 상태를 읽지 못하면 막지 않는다. Stop을 막는 쪽으로 실패하면 세션이 끝나지 않는다.
 let s;
 try{s=read(stateFile);}catch{return null;}
 const consult=!!s.open_consult;
 if(!consult&&!LEAD_TURN.includes(s.phase))return null;
 return {decision:'block',reason:`HyperFusion: 작업 ${s.task_id}가 ${s.phase} 단계에 남아 있습니다. 다음 동작: ${nextAction(s.phase,consult)}. 사용자 판단이 필요해서 멈추는 거라면 그 이유를 보고하고 끝내세요.`};
}

// SessionStart 훅: 대화가 요약(compact)되거나 새 세션이 같은 저장소에서 시작될 때, 진행 중인 작업이 있으면
// 어느 단계인지와 다음 명령을 알려 준다. 요약이 작업 상태를 잃어도 리드가 status를 더듬지 않고 이어 간다.
// 진행 중인 작업이 없으면 아무것도 넣지 않는다(토큰 0). 모델을 부르지 않고 상태 파일만 읽는다.
export function decideSessionStart(input) {
 const root=repoRootOf(path.join(path.resolve(input?.cwd??process.cwd()),'.hf-start'));
 if(!root)return null;
 const stateFile=controlPath(root,'state.json');
 if(!fs.existsSync(stateFile))return null;
 let s;
 try{s=read(stateFile);}catch{return null;}
 if(!s||TERMINAL_PHASES.includes(s.phase))return null;
 const self=fileURLToPath(new URL('./fusion-state.mjs',import.meta.url)).replaceAll('\\','/');
 const consult=!!s.open_consult;
 const lines=[
  `HyperFusion: 이 저장소에 진행 중인 작업이 있습니다. 작업 ${s.task_id}, 단계 ${s.phase}${s.owner?`, 일꾼 ${s.owner}`:''}, 라운드 ${s.iteration}${consult?', 열린 상담 있음':''}.`,
  `다음 동작: ${nextAction(s.phase,consult)}.`,
  `지금 칠 명령과 채워 둔 입력 틀: node "${self}" next "${root}"`,
  '요약 전의 기억보다 이 상태를 믿으세요. 일꾼 예산이 남아 있는 동안 리드는 코드를 직접 쓰지 않습니다.'];
 return {hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:lines.join('\n')}};
}

// UserPromptSubmit 훅: 진행 중인 작업이 있으면 상태 한 줄을 사용자에게만 보여 준다.
// systemMessage는 화면 표시용이라 모델 컨텍스트와 토큰에 들어가지 않는다. 터미널 전용 띠(mods/hf-status)와 달리
// 훅 출력은 VS Code 같은 화면에서도 쓰이는 공통 경로다. 진행 중인 작업이 없거나 상태를 읽지 못하면 아무것도 내지 않는다.
export function decideUserPrompt(input) {
 const root=repoRootOf(path.join(path.resolve(input?.cwd??process.cwd()),'.hf-prompt'));
 if(!root)return null;
 const line=readStatusLine(root);
 return line?{systemMessage:line}:null;
}

// 사용자 설정(~/.claude/settings.json 등)에 넣을 훅 항목. 이 파일의 절대 경로를 쓴다.
export function settingsSnippet() {
 const script=fileURLToPath(import.meta.url).replaceAll('\\','/');
 const command=[{type:'command',command:`node "${script}"`}];
 const usage=fileURLToPath(new URL('./lead-usage.mjs',import.meta.url)).replaceAll('\\','/');
 const collect=[{type:'command',command:`node "${usage}" --hook`,timeout:10}];
 return {hooks:{PreToolUse:[{matcher:GUARDED_TOOLS.join('|'),hooks:command},{matcher:'Bash',hooks:collect}],
  Stop:[{hooks:[...command,...collect]}],SessionStart:[{matcher:'startup|resume|compact',hooks:[...command,...collect]}],
  UserPromptSubmit:[{hooks:[...command,...collect]}],SessionEnd:[{hooks:collect}],StopFailure:[{hooks:collect}]}};
}

if(isMain(import.meta.url)) {
 if(process.argv[2]==='--print-settings'){console.log(JSON.stringify(settingsSnippet(),null,2));process.exit(0);}
 let input;
 try{input=JSON.parse(fs.readFileSync(0,'utf8').replace(/^\uFEFF/,''));}
 catch(e){console.error('lead-guard: invalid hook input: '+e.message);process.exit(0);}
 const event=input?.hook_event_name;
 const out=event==='Stop'?decideStop(input):event==='SessionStart'?decideSessionStart(input):event==='UserPromptSubmit'?decideUserPrompt(input):decide(input);
 if(out)console.log(JSON.stringify(out));
}
