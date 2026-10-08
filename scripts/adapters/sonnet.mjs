import crypto from 'node:crypto';
import {denyRules} from '../bash-policy.mjs';
import {schemaFor,prompt,bashRules,editDeny,probe as probeCli} from './common.mjs';

// Claude Code CLI를 Sonnet 모델로 띄워 일꾼으로 쓴다. 리드(Opus)와는 별도 프로세스·별도 세션이다.
// 플래그 출처: https://code.claude.com/docs/en/headless, https://code.claude.com/docs/en/cli-reference
export const name='sonnet';
export const MODEL='claude-sonnet-5-5';
// --max-turns는 --help에 나오지 않는 버전이 있어 프로브 대상에서 뺀다. 인자로는 계속 넘기며, 인식 못 하면 실행이 실패로 끝난다.
export const requiredFlags=['--model','--output-format','--json-schema','--resume','--session-id','--safe-mode','--tools','--allowedTools','--disallowedTools','--permission-mode'];
export const binary=()=>process.env.HF_CLAUDE_BIN||'claude';
export const probe=()=>probeCli('Claude Code (Sonnet)',binary(),requiredFlags);
export const newSession=()=>crypto.randomUUID();

export function dispatch(brief,lease,{session,resume,probe:cli}) {
 if(!session)throw Error('Sonnet requires a preallocated session UUID');
 const edit=brief.allowed_actions.includes('edit')&&!brief.consult;
 const allowed=['Read','Glob','Grep',...(edit?['Edit','Write']:[]),...bashRules(brief)];
 // 상담은 Bash 자체를 주지 않는다. 읽기 도구만 있으면 트리를 바꿀 수단이 없다.
 const tools=brief.consult?'Read,Glob,Grep':edit?'Read,Glob,Grep,Edit,Write,Bash':'Read,Glob,Grep,Bash';
 // safe-mode로 사용자 플러그인·훅·메모리를 끄고, dontAsk로 허용 목록 밖은 묻지 않고 거절한다.
 const args=['-p','--model',MODEL,'--safe-mode','--output-format','json','--json-schema',JSON.stringify(schemaFor(brief)),
  '--permission-mode','dontAsk','--tools',tools,
  '--allowedTools',allowed.join(','),'--disallowedTools',['Agent','Task','Skill','mcp__*',...editDeny(brief),...denyRules('claude')].join(','),
  '--max-turns','40',resume?'--resume':'--session-id',session];
 const text=prompt(brief,lease);
 return {cli:{...cli,args,session_id:session,resume,model:MODEL},prompt:text,stdin:text};
}

export function parse(stdout,request) {
 let e;
 try{e=JSON.parse(stdout);}catch{throw Error('Sonnet emitted invalid JSON');}
 if(!e||e.type!=='result'||e.is_error===true||e.subtype!=='success')throw Error('Sonnet returned an unsuccessful result envelope');
 if(e.session_id!==request.cli.session_id)throw Error('Sonnet session provenance mismatch');
 if(e.permission_denials?.length)throw Error('Sonnet reported permission denials; inspect before recovery');
 return {session_id:e.session_id,result:e.structured_output,
  usage:{usage:e.usage??null,modelUsage:e.modelUsage??null,num_turns:e.num_turns??null,total_cost_usd:e.total_cost_usd??null}};
}
