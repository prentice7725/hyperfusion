import {resultSchema,prompt,bashRules,probe as probeCli,extractResult} from './common.mjs';
import {assertCommandLine} from '../platform.mjs';

// Google Antigravity CLI(agy) 헤드리스 모드. 모든 플래그는 -p 앞에 와야 한다.
// 대화 ID는 CLI가 발급하므로 첫 라운드 envelope의 conversation_id를 저장해 재개에 쓴다.
export const name='antigravity';
export const requiredFlags=['--output-format','--json-schema','--conversation','--mode','--add-dir','--print'];
export const binary=()=>process.env.HF_AGY_BIN||'agy';
export const probe=(options={})=>probeCli('Antigravity',binary(),[...requiredFlags,...(options.sandbox===false?[]:['--sandbox'])]);
export const newSession=()=>null;

export function dispatch(brief,lease,{session,resume,probe:cli,options={}}) {
 if(resume&&!session)throw Error('Antigravity resume requires a saved conversation_id');
 // agy에는 명령 단위 허용 규칙이 없다. 터미널 제한은 --sandbox로만 건다.
 const ignored=bashRules(brief);
 const text=prompt(brief,lease);
 const args=['--output-format','json','--json-schema',JSON.stringify(resultSchema(brief.task_id,brief.round)),
  ...(brief.allowed_actions.includes('edit')?['--mode','accept-edits']:[]),'--add-dir',brief.repo_root,
  ...(options.sandbox===false?[]:['--sandbox']),...(resume?['--conversation',session]:[]),'-p',text];
 // 프롬프트를 명령줄로 넘기므로 Windows 길이 제한을 lease 획득 전에 확인한다.
 assertCommandLine(cli.executable,[...(cli.prefix_args??[]),...args]);
 return {cli:{...cli,args,session_id:session??null,resume,ignored_bash_rules:ignored},prompt:text};
}

export function parse(stdout,request) {
 let e;
 try{e=JSON.parse(stdout);}catch{throw Error('Antigravity emitted invalid JSON');}
 if(!e||e.error)throw Error('Antigravity returned an error envelope: '+JSON.stringify(e?.error??null));
 if(typeof e.status==='string'&&/error|fail|cancel|timeout|denied|abort/i.test(e.status))throw Error('Antigravity run status: '+e.status);
 if(typeof e.conversation_id!=='string'||!e.conversation_id.trim())throw Error('Antigravity envelope has no conversation_id');
 if(request.cli.session_id&&e.conversation_id!==request.cli.session_id)throw Error('Antigravity session provenance mismatch');
 return {session_id:e.conversation_id,result:e.structured_output??extractResult(e.response),
  usage:{usage:e.usage??null,num_turns:e.num_turns??null,duration_seconds:e.duration_seconds??null,total_cost_usd:null}};
}
