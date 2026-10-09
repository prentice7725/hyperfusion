import crypto from 'node:crypto';
import {denyRules} from '../bash-policy.mjs';
import {prompt,bashRules,editDeny,probe as probeCli,extractResult} from './common.mjs';

// Grok Build CLI 헤드리스 모드. stdin을 프롬프트로 읽지 않으므로 --prompt-file을 쓴다.
// 플래그 출처: xai-org/grok-build user-guide 14-headless-mode.md
export const name='grok';
export const requiredFlags=['--prompt-file','--output-format','--session-id','--resume','--cwd','--max-turns','--allow','--deny'];
export const binary=()=>process.env.HF_GROK_BIN||'grok';
// 추론 강도는 --reasoning-effort(별칭 --effort). 설정했을 때만 필수 플래그로 확인한다.
export const probe=(options={})=>probeCli('Grok',binary(),[...requiredFlags,...(options.model?['--model']:[]),...(options.reasoning_effort?['--reasoning-effort']:[])],['--model','--reasoning-effort']);
export const newSession=()=>crypto.randomUUID();
// 상담은 편집과 셸을 모두 막는다. 규칙 문법이 버전마다 다를 수 있어 실제 보증은 상담 전후 스냅샷 비교다.
export const CONSULT_DENY=['Edit(**)','Bash(*)'];
export const DENY=denyRules('grok');

export function dispatch(brief,lease,{session,resume,probe:cli,promptFile,options={}}) {
 if(options.model&&!cli.supports?.['--model'])throw Error('MODEL_UNSUPPORTED: Grok requires --model support for a model override');
 if(options.reasoning_effort&&!cli.supports?.['--reasoning-effort'])throw Error('EFFORT_UNSUPPORTED: Grok requires --reasoning-effort support for a reasoning_effort setting');
 if(!session)throw Error('Grok requires a preallocated session UUID');
 const edit=brief.allowed_actions.includes('edit')&&!brief.consult;
 // 쓰기 권한은 scope 경로로만 연다. 이 규칙은 협업 통제이지 OS 샌드박스가 아니다.
 const allow=[...(edit?brief.scope.paths.flatMap(p=>[`Edit(${p})`,`Edit(${p}/**)`]):[]),...bashRules(brief)];
 const args=['--prompt-file',promptFile,'--output-format','json','--cwd',brief.repo_root,'--max-turns','40',...(options.model?['--model',options.model]:[]),...(options.reasoning_effort?['--reasoning-effort',options.reasoning_effort]:[]),
  resume?'--resume':'--session-id',session,...allow.flatMap(r=>['--allow',r]),...[...editDeny(brief),...DENY,...(brief.consult?CONSULT_DENY:[])].flatMap(r=>['--deny',r])];
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
