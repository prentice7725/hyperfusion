import crypto from 'node:crypto';
import {prompt,bashRules,probe as probeCli,extractResult} from './common.mjs';

// Grok Build CLI 헤드리스 모드. stdin을 프롬프트로 읽지 않으므로 --prompt-file을 쓴다.
// 플래그 출처: xai-org/grok-build user-guide 14-headless-mode.md
export const name='grok';
export const requiredFlags=['--prompt-file','--output-format','--session-id','--resume','--cwd','--max-turns','--allow','--deny'];
export const binary=()=>process.env.HF_GROK_BIN||'grok';
export const probe=()=>probeCli('Grok',binary(),requiredFlags);
export const newSession=()=>crypto.randomUUID();
export const DENY=['Edit(.fusion/**)','Edit(.git/**)','Bash(git commit*)','Bash(git push*)','Bash(git reset*)','Bash(git clean*)','Bash(git stash*)','Bash(git checkout*)','Bash(git add*)'];

export function dispatch(brief,lease,{session,resume,probe:cli,promptFile}) {
 if(!session)throw Error('Grok requires a preallocated session UUID');
 const edit=brief.allowed_actions.includes('edit');
 // 쓰기 권한은 scope 경로로만 연다. 이 규칙은 협업 통제이지 OS 샌드박스가 아니다.
 const allow=[...(edit?brief.scope.paths.flatMap(p=>[`Edit(${p})`,`Edit(${p}/**)`]):[]),...bashRules(brief)];
 const args=['--prompt-file',promptFile,'--output-format','json','--cwd',brief.repo_root,'--max-turns','40',
  resume?'--resume':'--session-id',session,...allow.flatMap(r=>['--allow',r]),...DENY.flatMap(r=>['--deny',r])];
 return {cli:{...cli,args,session_id:session,resume,prompt_file:promptFile},prompt:prompt(brief,lease)};
}

export function parse(stdout,request) {
 let e;
 try{e=JSON.parse(stdout);}catch{throw Error('Grok emitted invalid JSON');}
 if(!e||e.type==='error')throw Error('Grok returned an error envelope: '+(e?.message??'unknown'));
 if(e.sessionId!==request.cli.session_id)throw Error('Grok session provenance mismatch');
 if(e.stopReason!=='end_turn')throw Error('Grok stopped without finishing: '+e.stopReason);
 return {session_id:e.sessionId,result:extractResult(e.text),
  usage:{usage:e.usage??null,modelUsage:e.modelUsage??null,num_turns:e.num_turns??null,total_cost_usd:e.total_cost_usd??null}};
}
