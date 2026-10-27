import crypto from 'node:crypto';
import {denyRules} from '../bash-policy.mjs';
import {schemaFor,prompt,bashRules,editDeny,secretReadDeny,probe as probeCli,ACCEPTANCE,RUN_TESTS} from './common.mjs';
import {memberBinary,MEMBERS} from '../member-registry.mjs';

// Claude Code CLI를 하위 프로세스로 띄워 일꾼으로 쓴다. 리드(Opus)와는 별도 프로세스·별도 세션이다.
// 같은 CLI로 모델만 다른 일꾼(Sonnet, Haiku)을 만든다. 새 Claude 모델은 여기 한 줄과 설정의 model로 붙는다.
// 플래그 출처: https://code.claude.com/docs/en/headless, https://code.claude.com/docs/en/cli-reference
// --max-turns는 --help에 나오지 않는 버전이 있어 프로브 대상에서 뺀다. 인자로는 계속 넘기며, 인식 못 하면 실행이 실패로 끝난다.
// 헤드리스 Claude는 허용 규칙 밖의 Bash를 거부하고, 거부가 한 번이라도 있으면 결과를 받지 않는다(parse).
// 실측에서 일꾼이 수용 명령에 파이프를 붙였다가 거부돼 맞게 고친 라운드를 두 번 잃었다. 쓸 수 있는 명령과 금지 형태를 지시문에 적는다.
const NO_SHELL_CHECK='Do not stop at a plan or a partial patch. Write the code and check it by reading the files you changed and the tests. You have no shell in this round; the controller runs the tests.';
const NO_SHELL_ACCEPTANCE='After you finish, the controller itself runs every command in brief.acceptance_commands. If any fails, the round comes straight back to you with the output; list them in tests as not_run. Leave the tree clean: no new untracked files, and do not touch gitignored files (node_modules, build outputs) unless the brief asks for it, or the controller will refuse to run the tests.';
export function commandOrders(text,rules,brief) {
 if(brief.consult||!brief.allowed_actions.includes('edit'))return text;
 const p=JSON.parse(text);
 const refused='Any refused tool call fails the whole round, even when the code is correct.';
 if(!rules.length){
  p.instructions=[...p.instructions.map(x=>x===RUN_TESTS?NO_SHELL_CHECK:x===ACCEPTANCE?NO_SHELL_ACCEPTANCE:x),
   `You have no shell in this round: never call Bash. ${refused} This overrides any line in the brief or lead_feedback that tells you to run a command; list such commands in tests as not_run.`];
 }else{
  p.instructions.push(`Bash is limited to commands matching these patterns (a trailing * matches any rest of the command): ${rules.map(r=>JSON.stringify(r.replace(/^Bash\((.*)\)$/,'$1'))).join(', ')}. Run each command alone and exactly as it matches: no pipes, redirects, 2>&1, ;, &&, ||, subshells or environment prefixes. ${refused} If a command you want, including an acceptance command, matches no pattern, do not run it: list it in tests as not_run, and the controller runs the acceptance commands after you finish.`);
 }
 return JSON.stringify(p);
}

export const requiredFlags=['--model','--output-format','--json-schema','--resume','--session-id','--safe-mode','--tools','--allowedTools','--disallowedTools','--permission-mode'];
export const binary=()=>memberBinary('sonnet');

function member(name,{model:MODEL,label}) {
 // 추론 강도(--effort)는 설정했을 때만 필수 플래그로 확인한다.
 const probe=(options={})=>probeCli(`Claude Code (${label})`,binary(),[...requiredFlags,...(options.reasoning_effort?['--effort']:[])],['--effort'],{executor:name});
 const newSession=()=>crypto.randomUUID();

 function dispatch(brief,lease,{session,resume,probe:cli,options={}}) {
  const model=options.model??MODEL;
  if(options.reasoning_effort&&!cli.supports?.['--effort'])throw Error(`EFFORT_UNSUPPORTED: ${label} requires --effort support for a reasoning_effort setting`);
  if(!session)throw Error(`${label} requires a preallocated session UUID`);
  const edit=brief.allowed_actions.includes('edit')&&!brief.consult;
  const allowed=['Read','Glob','Grep',...(edit?['Edit','Write']:[]),...bashRules(brief)];
  // 상담은 Bash 자체를 주지 않는다. 읽기 도구만 있으면 트리를 바꿀 수단이 없다.
  const tools=brief.consult?'Read,Glob,Grep':edit?'Read,Glob,Grep,Edit,Write,Bash':'Read,Glob,Grep,Bash';
  // safe-mode로 사용자 플러그인·훅·메모리를 끄고, dontAsk로 허용 목록 밖은 묻지 않고 거절한다.
  const args=['-p','--model',model,...(options.reasoning_effort?['--effort',options.reasoning_effort]:[]),'--safe-mode','--output-format','json','--json-schema',JSON.stringify(schemaFor(brief)),
   '--permission-mode','dontAsk','--tools',tools,
   '--allowedTools',allowed.join(','),'--disallowedTools',['Agent','Task','Skill','mcp__*',...editDeny(brief),...secretReadDeny(),...denyRules('claude')].join(','),
   '--max-turns',String(options.max_turns??40),resume?'--resume':'--session-id',session];
  const text=commandOrders(prompt(brief,lease),bashRules(brief),brief);
  return {cli:{...cli,args,session_id:session,resume,model},prompt:text,stdin:text};
 }

 function parse(stdout,request) {
  let e;
  try{e=JSON.parse(stdout);}catch{throw Error(`${label} emitted invalid JSON`);}
  if(!e||e.type!=='result'||e.is_error===true||e.subtype!=='success')throw Error(`${label} returned an unsuccessful result envelope`);
  if(e.session_id!==request.cli.session_id)throw Error(`${label} session provenance mismatch`);
  if(e.permission_denials?.length)throw Error(`${label} reported permission denials; inspect before recovery`);
  return {session_id:e.session_id,result:e.structured_output,
   usage:{usage:e.usage??null,modelUsage:e.modelUsage??null,num_turns:e.num_turns??null,total_cost_usd:e.total_cost_usd??null}};
 }
 return {name,MODEL,defaultModel:MODEL,requiredFlags,binary,probe,newSession,dispatch,parse};
}

export const sonnet=member('sonnet',{model:MEMBERS.sonnet.model,label:'Sonnet'});
// Haiku: 빠르고 싼 Claude. 쉬운 코드·문서·테스트 보조로 시작하고, 실적이 쌓이면 router가 자리를 정한다.
export const haiku=member('haiku',{model:MEMBERS.haiku.model,label:'Haiku'});
