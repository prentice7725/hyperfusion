import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isMain} from './platform.mjs';
import {read,atomic,hash} from './artifact.mjs';
import {controlPath} from './control-dir.mjs';
import {TERMINAL_PHASES,nextAction} from './state-policy.mjs';
import {dangerousBash,bashDirectories} from './lead-bash-guard.mjs';
import {readStatusLine} from './status-line.mjs';
import {familyOf,UNKNOWN} from './model-registry.mjs';

// Claude Code 훅. SKILL.md의 리드 규칙을 지시가 아니라 차단으로 강제한다.
//   PreToolUse 1) lease가 걸린 동안 리드는 트리를 수정하지 않는다(일꾼이 writer다).
//   PreToolUse 2) 일꾼 예산이 남아 있으면 리드는 코드를 쓰지 않는다(takeover로 lease를 받은 경우만 예외).
//   PreToolUse 2-1) MCP 도구도 같은 규칙을 따른다. 이름만으로는 쓰기 여부를 알 수 없으므로 읽기 전용 허용 목록 밖은 막는다.
//   Stop       3) 리드가 처리할 단계(리뷰, 검증, 재지시 등)에 작업을 둔 채 턴을 끝내지 않는다.
//   UserPromptSubmit  4) 프롬프트를 보낼 때 작업 상태 한 줄을 사용자 화면에만 보여 준다(차단 없음, 모델 컨텍스트에 넣지 않음).
//   PreModelSwitch    5) 진행 중인 작업이 있으면 리드를 다른 계열 모델로 바꾸지 못한다(R7). 같은 계열 안의 전환은 허용한다.
//   PreToolUse(Bash)  6) 리드는 완화 환경변수(HF_ALLOW_*, HF_LEAD_*, HF_ALLOWED_VENDORS)를 설정하지 못한다. 완화는 운영자가 호스트를 띄우기 전에 정한다.
// 가드 명령은 onFailure:"block"으로 등록한다. 가드가 죽거나 시간을 넘기면 도구 호출이 막힌다(Claude Code v2.1.295 이상).
// 진행 중인 작업이 없는 저장소, Git 저장소 밖의 파일은 건드리지 않는다.
// 일꾼 Sonnet은 --safe-mode로 떠서 사용자 훅이 꺼지므로 이 훅에 막히지 않는다.

export const GUARDED_TOOLS=['Edit','Write','MultiEdit','NotebookEdit'];
export const MCP_MATCHER='mcp__.*';
// 읽기 전용으로 확인한 도구만 적는다. 쓰기·실행·코멘트·병합·실행 트리거 도구는 넣지 않는다.
// 서버 이름은 직접 등록(github), 플러그인 등록(plugin_github_github)과 아래 별칭을 받는다. 다른 이름으로 등록한 서버는 HF_LEAD_MCP_ALLOW로 더한다.
export const MCP_READ_ONLY={
 // Serena(https://github.com/oraios/serena): 심볼 조회·참조 찾기·검색·파일 읽기.
 serena:['find_symbol','find_referencing_symbols','get_symbols_overview','search_for_pattern','find_file','list_dir','read_file'],
 // GitHub MCP 서버(https://github.com/github/github-mcp-server): 저장소·이슈·PR·CI 조회.
 github:['get_me','get_file_contents','get_commit','list_commits','list_branches','list_tags','get_tag','list_releases','get_latest_release','get_release_by_tag',
  'search_code','search_commits','search_repositories','search_issues','search_pull_requests','issue_read','list_issues','get_label','list_issue_types','list_issue_fields',
  'pull_request_read','list_pull_requests','actions_get','actions_list','get_job_logs','get_check_run'],
 // Context7(https://github.com/upstash/context7): 라이브러리 문서 조회.
 context7:['resolve-library-id','get-library-docs','query-docs'],
 // Google Drive: 설계 문서 등 기준 자료가 드라이브에 있는 프로젝트용 검색·읽기. 생성·수정·복사·공유·휴지통 도구는 넣지 않는다.
 google_drive:['search_files','list_recent_files','get_file_metadata','get_file_permissions','read_file_content','download_file_content']
};
// 같은 서버가 호스트마다 다른 이름으로 붙는다(claude.ai 커넥터는 claude_ai_<이름>).
export const MCP_SERVER_ALIASES={github:['claude_ai_GitHub'],google_drive:['Google_Drive','claude_ai_Google_Drive']};
// 운영자가 읽기 전용임을 확인한 도구를 정확한 전체 이름(mcp__server__tool)으로 더한다. 와일드카드는 받지 않는다.
export const MCP_ALLOW_ENV='HF_LEAD_MCP_ALLOW';

export function mcpReadOnly(name,env=process.env) {
 if(typeof name!=='string'||!name.startsWith('mcp__'))return false;
 if(String(env[MCP_ALLOW_ENV]??'').split(',').map(v=>v.trim()).includes(name))return true;
 const cut=name.lastIndexOf('__');if(cut<='mcp_'.length)return false;
 const server=name.slice('mcp__'.length,cut),tool=name.slice(cut+2);
 return Object.entries(MCP_READ_ONLY).some(([id,tools])=>(server===id||server===`plugin_${id}_${id}`||MCP_SERVER_ALIASES[id]?.includes(server))&&tools.includes(tool));
}

// 파일이 아직 없을 수도 있으니 부모로 올라가며 .git(폴더 또는 worktree의 파일)을 찾는다.
function repoRootOf(file) {
 for(let d=path.dirname(file);;){
  if(fs.existsSync(path.join(d,'.git')))return d;
  const up=path.dirname(d);if(up===d)return null;d=up;
 }
}

const deny=reason=>({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:reason}});

// 컨트롤러가 띄운 일꾼 프로세스인지. 브리지가 lease 토큰의 해시나 상담 ID를 환경변수로 넘긴다.
// 호스트 훅을 끌 수 없는 일꾼(Codex 관리형 훅, agy)이 리드용 가드에 막히지 않게 하고, 리드 세션은 이 값을 갖지 않는다.
export function workerProcess(lease,state,env=process.env) {
 if(lease&&lease.owner!=='lead'&&typeof env.HF_WORKER_LEASE==='string'&&env.HF_WORKER_LEASE===hash(String(lease.token)))return true;
 return !!(state?.open_consult&&typeof env.HF_WORKER_CONSULT==='string'&&env.HF_WORKER_CONSULT===String(state.open_consult.id));
}

export const HOSTS=['claude-code','codex','antigravity'];

// 허용이면 null, 차단이면 호스트가 읽는 훅 출력(Claude Code와 Codex는 같은 deny 형식이다).
export function decide(input,{host='claude-code'}={}) {
 if(host==='codex')return decideCodex(input);
 if(input?.tool_name==='Bash')return decideBash(input);
 if(input?.tool_name?.startsWith?.('mcp__'))return decideMcp(input);
 if(!GUARDED_TOOLS.includes(input?.tool_name))return null;
 const target=input.tool_input?.file_path??input.tool_input?.notebook_path;
 if(typeof target!=='string'||!target)return null;
 const root=repoRootOf(path.resolve(input.cwd??process.cwd(),target));
 return root?treeLock(root):null;
}

// MCP 도구는 대상 파일을 일정한 필드로 받지 않으므로 Bash처럼 cwd의 저장소를 기준으로 판단한다.
// 허용 목록 밖의 도구는 쓰기·코드 실행이 가능하다고 보고 Edit/Write와 같은 조건에서 막는다.
export function decideMcp(input) {
 if(mcpReadOnly(input?.tool_name))return null;
 const root=repoRootOf(path.join(path.resolve(input?.cwd??process.cwd()),'.hf-mcp'));
 return root?treeLock(root,` Blocked: ${input.tool_name} is not a recognized read-only MCP tool; operators may list verified read-only tools in ${MCP_ALLOW_ENV}.`):null;
}

// Codex 리드. 파일 수정은 apply_patch(Edit·Write로도 맞는다)이고 대상 경로는 패치 본문에 있다.
// write_stdin은 이미 허용된 셸에 입력을 넣을 때 PreToolUse를 다시 거치지 않고, spawn_agent는 컨트롤러를 거치지 않는 위임이다.
// 둘 다, 그리고 이름을 모르는 도구는 작업 중에 쓰기로 보고 막는다.
export const CODEX_READ_TOOLS=['update_plan','view_image'];
export const CODEX_BYPASS_TOOLS=['write_stdin','spawn_agent','Agent'];
export function patchPaths(text) {
 if(typeof text!=='string')return [];
 return [...text.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map(m=>m[1].trim()).filter(Boolean);
}
export function decideCodex(input) {
 const tool=input?.tool_name,cwd=path.resolve(input?.cwd??process.cwd());
 if(tool==='Bash')return decideBash(input);
 if(typeof tool==='string'&&tool.startsWith('mcp__'))return decideMcp(input);
 if(CODEX_READ_TOOLS.includes(tool))return null;
 if(['apply_patch','Edit','Write'].includes(tool)){
  const targets=patchPaths(input.tool_input?.command);
  // 경로를 읽지 못한 패치는 작업 폴더의 저장소를 기준으로 막는다(열어 두면 강제가 아니다).
  for(const target of targets.length?targets:['.hf-patch']){
   const root=repoRootOf(path.resolve(cwd,target));
   const out=root?treeLock(root):null;if(out)return out;
  }
  return null;
 }
 const root=repoRootOf(path.join(cwd,'.hf-tool'));
 const why=CODEX_BYPASS_TOOLS.includes(tool)?`${tool} bypasses the per-call guard or the controller`:`${tool} is not a recognized read-only Codex tool`;
 return root?treeLock(root,` Blocked: ${why}.`):null;
}

function treeLock(root,note='') {
 if(fs.existsSync(controlPath(root,'locks/acceptance.json')))return deny(`HyperFusion: acceptance process shutdown is unproven. Stop remaining processes and record recovery before editing the tree.${note}`);
 const stateFile=controlPath(root,'state.json'),writerFile=controlPath(root,'locks/writer.json');
 if(!fs.existsSync(stateFile)&&!fs.existsSync(writerFile))return null;
 // 상태가 있는데 읽지 못하면 막는다. 규칙을 확인할 수 없을 때 열어 두면 강제가 아니다.
 let s,lease;
 try{s=fs.existsSync(stateFile)?read(stateFile):null;lease=fs.existsSync(writerFile)?read(writerFile):null;}
 catch(e){return deny(`HyperFusion: state is unreadable (${e.message}); lead edits are blocked. Inspect status.${note}`);}
 // lease를 쥔 일꾼 자신의 쓰기는 막지 않는다(훅을 끌 수 없는 호스트의 일꾼).
 if(workerProcess(lease,s))return null;
 if(lease)return lease.owner==='lead'?null
  :deny(`HyperFusion: ${lease.owner} holds the writer lease (task ${lease.task_id}, round ${lease.round}). The lead must not edit the tree; execute the bridge, finish after quiescence, then review.${note}`);
 if(!s||TERMINAL_PHASES.includes(s.phase))return null;
 return deny(`HyperFusion: task ${s.task_id} is in ${s.phase}. The lead cannot edit while worker budget remains. Next: ${nextAction(s.phase,!!s.open_consult)}. Record takeover and acquire the lead lease before implementation.${note}`);
}

// 리드가 셸에서 완화 환경변수를 붙이면 운영자가 준 완화와 구분할 수 없다. 작업 여부와 상관없이 막는다.
const RELAXATION=/(?:^|[\s;&|(`])(?:export\s+|set\s+|\$env:)?HF_(?:ALLOW_[A-Z0-9_]*|LEAD_[A-Z0-9_]*|ALLOWED_VENDORS)\s*=|\bsetx\s+HF_(?:ALLOW_|LEAD_|ALLOWED_VENDORS)/i;
export const relaxationEnv=command=>typeof command==='string'&&RELAXATION.test(command);

// Task-local restrictions expire at CLOSE/BLOCKED. User-authorized publication
// takes place after task shutdown, so it needs no additional approval prompt.
export function decideBash(input) {
 if(relaxationEnv(input?.tool_input?.command))return deny('HyperFusion: the lead cannot set HF_ALLOW_*, HF_LEAD_* or HF_ALLOWED_VENDORS. Relaxations come from the operator before the host starts.');
 const danger=dangerousBash(input?.tool_input?.command);if(!danger)return null;
 const cwd=path.resolve(input?.cwd??process.cwd());
 for(const dir of bashDirectories(input.tool_input.command,cwd)){
 const root=repoRootOf(path.join(dir,'.hf-bash'));if(!root)continue;
 const stateFile=controlPath(root,'state.json'),writerFile=controlPath(root,'locks/writer.json');
 if(fs.existsSync(controlPath(root,'locks/acceptance.json')))return deny('HyperFusion: process shutdown is unproven; '+danger+' is blocked until recovery.');
 let state,lease;
 try{state=fs.existsSync(stateFile)?read(stateFile):null;lease=fs.existsSync(writerFile)?read(writerFile):null;}
 catch{return deny('HyperFusion: state is unreadable; '+danger+' is blocked.');}
 if(!lease&&(!state||TERMINAL_PHASES.includes(state.phase)))continue;
 return deny('HyperFusion: '+danger+' is blocked during the active task. Finish the worker, review and verify before user-authorized publication. This guard does not grant authority after closure.');
 }
 return null;
}

// 리드가 바로 다음 동작을 해야 하는 단계. 일꾼 실행 중(EXECUTING)이나 사용자 판단이 필요한 단계
// (DECISION_REQUIRED, TAKEOVER_REQUIRED, RECOVERY_REQUIRED)는 멈춰도 된다.
export const LEAD_TURN=['PLAN','REVIEW','VERIFY','REDO','ALTERNATIVE_REQUIRED','LEAD_DECISION_REQUIRED'];

// Stop 훅: 리드 차례인 작업을 남기고 턴을 끝내려 하면 한 번 막고 다음 동작을 알려 준다.
// 이미 한 번 막혀 이어 가는 중(stop_hook_active)이면 통과시킨다. 사용자에게 보고하고 멈추는 것도 리드의 판단이다.
// Codex는 stop_hook_active를 주지 않는다. 같은 턴(turn_id)에서 한 번 막았으면 다음에는 통과시켜 끝없이 이어지지 않게 한다.
export function decideStop(input,{host='claude-code'}={}) {
 if(input?.stop_hook_active===true)return null;
 const root=repoRootOf(path.join(path.resolve(input?.cwd??process.cwd()),'.hf-stop'));
 if(!root)return null;
 const stateFile=controlPath(root,'state.json');
 if(!fs.existsSync(stateFile))return null;
 // 상태를 읽지 못하면 막지 않는다. Stop을 막는 쪽으로 실패하면 세션이 끝나지 않는다.
 let s;
 try{s=read(stateFile);}catch{return null;}
 if(workerProcess(null,s))return null;
 const consult=!!s.open_consult;
 if(!consult&&!LEAD_TURN.includes(s.phase))return null;
 if(host!=='claude-code'){
  // Codex는 턴(turn_id)마다, Antigravity는 대화·단계·라운드마다 한 번만 막는다(agy의 executionNum은 이어 갈 때마다 바뀐다).
  const key=hash(host==='codex'?String(input?.turn_id??input?.session_id??''):[input?.session_id,s.task_id,s.phase,s.iteration,!!s.open_consult].join(':'));
  const file=controlPath(root,'stop-guard.json');
  try{if(fs.existsSync(file)&&read(file).key===key)return null;atomic(file,{key,at:new Date().toISOString()});}catch{return null;}
 }
 return {decision:'block',reason:`HyperFusion: task ${s.task_id} remains in ${s.phase}. Next: ${nextAction(s.phase,consult)}. If user input is required, report the reason before stopping.`};
}

// PreModelSwitch 훅: 진행 중인 작업이 있으면 init 때의 리드 계열과 다른 모델로 바꾸지 못한다.
// 모르는 모델(unknown)로의 전환도 막는다. 진행 중인 작업이 없으면 관여하지 않는다.
export function decideModelSwitch(input) {
 const root=repoRootOf(path.join(path.resolve(input?.cwd??process.cwd()),'.hf-model'));
 if(!root)return null;
 const stateFile=controlPath(root,'state.json');
 if(!fs.existsSync(stateFile))return null;
 const refuse=reason=>({hookSpecificOutput:{hookEventName:'PreModelSwitch',permissionDecision:'deny',permissionDecisionReason:reason}});
 let s;
 try{s=read(stateFile);}catch{return refuse('HyperFusion: state is unreadable; the lead model cannot change during an active task.');}
 if(!s||TERMINAL_PHASES.includes(s.phase))return null;
 const family=s.lead_identity?.family??familyOf(s.configuration?.lead_model);
 const target=familyOf(input?.to_model);
 if(target!==UNKNOWN&&target===family)return null;
 return refuse(`HyperFusion: task ${s.task_id} runs with a ${family} lead; switching to ${input?.to_model??'an unknown model'} (${target}) would change who may review. Finish or archive the task first.`);
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
  `HyperFusion: active task ${s.task_id}, phase ${s.phase}${s.owner?`, worker ${s.owner}`:''}, round ${s.iteration}${consult?', consultation open':''}.`,
  `Next: ${nextAction(s.phase,consult)}.`,
  `Prepared command and input: node "${self}" next "${root}"`,
  'Use controller state after compaction. The lead must not implement while worker budget remains. Use English for inter-agent instructions and reports.'];
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

// ── Antigravity(agy) ────────────────────────────────────────────────
// agy 훅은 입력이 camelCase이고 이벤트 이름이 없으며(--event로 받는다), cwd가 저장소가 아니라 hooks.json 폴더다.
// 입력을 Claude Code 형식으로 바꿔 같은 판정을 쓰고, 결과를 agy 형식({decision})으로 되돌린다.
// 도구 이름은 문서와 다른 에이전트의 실측 보고를 따른 것이다. 모르는 이름은 작업 중에 쓰기로 보고 막는다.
export const AGY_WRITE_TOOLS=['write_to_file','replace_file_content','multi_replace_file_content','write_file','edit_file'];
export const AGY_READ_TOOLS=['view_file','view_file_outline','view_code_item','list_dir','grep_search','find_by_name','codebase_search','read_url_content','search_web','read_resource','list_resources'];
export const AGY_BYPASS_TOOLS=['invoke_subagent','define_subagent','send_message'];
const AGY_PATH_KEYS=['Path','TargetFile','AbsolutePath','FilePath','File'];
const AGY_STOP_REASONS=['model_stop','no_tool_call'];
const firstString=(...values)=>values.find(v=>typeof v==='string'&&v.trim())??null;

// agy MCP 이름을 mcp__server__tool로 바꾼다. 지연 로드(call_mcp_tool)는 인자에서, 즉시 로드(mcp_<server>_<tool>)는 아는 서버 이름으로 자른다.
export function agyMcpName(name,args={}) {
 if(name==='call_mcp_tool'){const server=firstString(args.ServerName),tool=firstString(args.ToolName);return server&&tool?`mcp__${server}__${tool}`:'mcp__unknown__unknown';}
 if(typeof name!=='string'||!name.startsWith('mcp_'))return null;
 const servers=[...Object.keys(MCP_READ_ONLY),...Object.values(MCP_SERVER_ALIASES).flat()];
 const server=servers.find(id=>name.startsWith(`mcp_${id}_`));
 return server?`mcp__${server}__${name.slice(`mcp_${server}_`.length)}`:`mcp__unknown__${name.slice(4)}`;
}

export function normalizeAgy(input,event) {
 const call=input?.toolCall??{},args=call.args??{};
 const workspace=firstString(...(Array.isArray(input?.workspacePaths)?input.workspacePaths:[]));
 const target=firstString(...AGY_PATH_KEYS.map(k=>args[k]));
 const base={hook_event_name:event,session_id:firstString(input?.conversationId),model:firstString(input?.modelName),hook_host:'antigravity',
  turn_id:null,stop_hook_active:false,cwd:workspace??(target&&path.isAbsolute(target)?path.dirname(target):null)};
 if(event!=='PreToolUse')return {...base,termination_reason:input?.terminationReason??null,fully_idle:input?.fullyIdle===true};
 const name=call.name;
 if(name==='run_command')return {...base,tool_name:'Bash',tool_input:{command:String(args.CommandLine??'')},cwd:firstString(args.Cwd)??base.cwd,bypass_sandbox:args.BypassSandbox===true};
 if(AGY_WRITE_TOOLS.includes(name))return {...base,tool_name:'Write',tool_input:{file_path:target??'.hf-agy-write'}};
 const mcp=agyMcpName(name,args);
 if(mcp)return {...base,tool_name:mcp,tool_input:args};
 if(AGY_READ_TOOLS.includes(name))return {...base,tool_name:'Read',tool_input:args};
 if(name==='manage_task'&&!['send_input','kill'].includes(args.Action??args.action))return {...base,tool_name:'Read',tool_input:args};
 return {...base,tool_name:name,tool_input:args,agy_unknown:true};
}

// 샌드박스를 벗어나는 run_command는 이 스킬의 컨트롤러 명령(브리지·오토파일럿·스모크·상태)만 허용한다.
function controllerCommand(command) {
 const scripts=path.dirname(fileURLToPath(import.meta.url)).replaceAll('\\','/');
 const words=command.trim().replaceAll('\\','/').split(/\s+/);
 const file=(words[1]??'').replace(/^"|"$/g,'');
 return ['node','node.exe'].includes(words[0])&&words.length>1&&/^(?:executor-bridge|autopilot|smoke|fusion-state)\.mjs$/.test(path.basename(file))&&path.dirname(path.resolve(file))===path.resolve(scripts);
}

export function decideAgy(raw,event) {
 const input=normalizeAgy(raw,event);
 if(event==='Stop'){
  const reason=String(input.termination_reason??'').toLowerCase();
  // 오류·취소·한도 종료는 막지 않는다. 정상 종료로 확인된 값이고 모든 작업이 끝났을 때만 한 번 이어 가게 한다.
  if(!input.fully_idle||!AGY_STOP_REASONS.includes(reason))return {decision:'stop'};
  const out=decideStop(input,{host:'antigravity'});
  return out?{decision:'continue',reason:out.reason}:{decision:'stop'};
 }
 if(event==='SessionStart'){
  const out=decideSessionStart(input);
  return out?{injectSteps:[{systemMessage:{systemMessage:out.hookSpecificOutput.additionalContext}}]}:{};
 }
 if(event!=='PreToolUse')return {};
 if(!input.cwd)return {decision:'allow'};
 let out;
 if(input.tool_name==='Bash'){
  out=decideBash(input);
  if(!out&&input.bypass_sandbox&&!controllerCommand(input.tool_input.command)){
   const root=repoRootOf(path.join(path.resolve(input.cwd),'.hf-bypass'));
   out=root?treeLock(root,' Blocked: only HyperFusion controller commands may bypass the agy sandbox during a task.'):null;
  }
 }
 else if(input.tool_name==='Write')out=decide({...input,tool_name:'Write'});
 else if(input.tool_name.startsWith('mcp__'))out=decideMcp(input);
 else if(input.tool_name==='Read')out=null;
 else{
  const root=repoRootOf(path.join(path.resolve(input.cwd),'.hf-tool'));
  const why=AGY_BYPASS_TOOLS.includes(input.tool_name)||input.tool_name==='manage_task'?`${input.tool_name} bypasses the controller or an allowed shell`:`${input.tool_name} is not a recognized read-only Antigravity tool`;
  out=root?treeLock(root,` Blocked: ${why}.`):null;
 }
 return out?{decision:'deny',reason:out.hookSpecificOutput.permissionDecisionReason}:{decision:'allow'};
}

// agy hooks.json 항목. 최상위 키는 훅 이름이고 Stop·SessionStart는 matcher 없이 핸들러 배열이다.
function agySnippet(script,usage) {
 const guard=event=>({type:'command',command:`node "${script}" --host antigravity --event ${event}`,timeout:30});
 const collect=event=>({type:'command',command:`node "${usage}" --hook --host antigravity --event ${event}`,timeout:10});
 return {'hyperfusion-guard':{enabled:true,PreToolUse:[{matcher:'*',hooks:[guard('PreToolUse')]}],Stop:[guard('Stop')],SessionStart:[guard('SessionStart')]},
  'hyperfusion-usage':{enabled:true,PreToolUse:[{matcher:'run_command',hooks:[collect('PreToolUse')]}],SessionStart:[collect('SessionStart')]}};
}

// Codex 사용자 훅(~/.codex/hooks.json)에 넣을 항목. 사용자 훅도 /hooks에서 신뢰해야 돈다. 상태 줄(UserPromptSubmit systemMessage)은 넣지 않는다.
function codexSnippet(script,usage) {
 const guard={type:'command',command:`node "${script}" --host codex`,timeout:30,statusMessage:'HyperFusion lead guard'};
 const collect={type:'command',command:`node "${usage}" --hook --host codex`,timeout:10};
 return {hooks:{PreToolUse:[{matcher:'.*',hooks:[guard]},{matcher:'^Bash$',hooks:[collect]}],
  SessionStart:[{matcher:'startup|resume|compact',hooks:[guard,collect]}],UserPromptSubmit:[{hooks:[collect]}],Stop:[{hooks:[guard]}]}};
}

// 사용자 설정(~/.claude/settings.json 등)에 넣을 훅 항목. 이 파일의 절대 경로를 쓴다.
export function settingsSnippet({host='claude-code'}={}) {
 if(!HOSTS.includes(host))throw Error('guard settings host must be one of '+HOSTS.join(', '));
 const script=fileURLToPath(import.meta.url).replaceAll('\\','/');
 const command=[{type:'command',command:`node "${script}"`}];
 // 차단하는 가드는 실패해도 막는다. 상태 표시·문맥 주입·사용량 수집은 실패해도 진행한다.
 const gate=[{...command[0],onFailure:'block'}];
 const usage=fileURLToPath(new URL('./lead-usage.mjs',import.meta.url)).replaceAll('\\','/');
 if(host==='codex')return codexSnippet(script,usage);
 if(host==='antigravity')return agySnippet(script,usage);
 const collect=[{type:'command',command:`node "${usage}" --hook`,timeout:10}];
 return {hooks:{PreToolUse:[{matcher:GUARDED_TOOLS.join('|'),hooks:gate},{matcher:MCP_MATCHER,hooks:gate},{matcher:'Bash',hooks:[...gate,...collect]}],
  Stop:[{hooks:[...command,...collect]}],SessionStart:[{matcher:'startup|resume|compact',hooks:[...command,...collect]}],
  UserPromptSubmit:[{hooks:[...command,...collect]}],PreModelSwitch:[{hooks:gate}],PostModelSwitch:[{hooks:collect}],
  SessionEnd:[{hooks:collect}],StopFailure:[{hooks:collect}]}};
}

if(isMain(import.meta.url)) {
 const at=process.argv.indexOf('--host'),host=at>=0?process.argv[at+1]:'claude-code';
 if(process.argv[2]==='--print-settings'){console.log(JSON.stringify(settingsSnippet({host}),null,2));process.exit(0);}
 if(host==='antigravity'){
  // agy는 출력이 있어야 판정한다. 입력을 못 읽으면 작업 여부를 알 수 없으므로 도구 호출을 막는다.
  const ev=process.argv[process.argv.indexOf('--event')+1];
  let raw;try{raw=JSON.parse(fs.readFileSync(0,'utf8').replace(/^\uFEFF/,''));}
  catch{console.log(JSON.stringify(ev==='PreToolUse'?{decision:'deny',reason:'HyperFusion: hook input unreadable'}:ev==='Stop'?{decision:'stop'}:{}));process.exit(0);}
  console.log(JSON.stringify(decideAgy(raw,ev)));process.exit(0);
 }
 let input;
 try{input=JSON.parse(fs.readFileSync(0,'utf8').replace(/^\uFEFF/,''));}
 catch(e){console.error('lead-guard: invalid hook input: '+e.message);process.exit(0);}
 const event=input?.hook_event_name;
 const out=event==='Stop'?decideStop(input,{host}):event==='SessionStart'?decideSessionStart(input):event==='UserPromptSubmit'?decideUserPrompt(input)
  :event==='PreModelSwitch'?decideModelSwitch(input):decide(input,{host});
 if(out)console.log(JSON.stringify(out));
}
