import {schemaFor,prompt,bashRules,probe as probeCli,extractResult} from './common.mjs';
import {assertCommandLine} from '../platform.mjs';

// Google Antigravity CLI(agy) 헤드리스 모드. 모든 플래그는 -p 앞에 와야 한다.
// 대화 ID는 CLI가 발급하므로 첫 라운드 envelope의 conversation_id를 저장해 재개에 쓴다.
export const name='antigravity';
export const requiredFlags=['--output-format','--json-schema','--conversation','--mode','--add-dir','--print'];
export const binary=()=>process.env.HF_AGY_BIN||'agy';
export const probe=(options={})=>probeCli('Antigravity',binary(),[...requiredFlags,...(options.sandbox===false?[]:['--sandbox'])],['--print-timeout']);
// agy가 스스로 먼저 끝내도록 브리지 timeout보다 30초 짧게 잡는다. 그래야 강제 종료 대신 정상 envelope가 남는다.
export const printTimeout=options=>Math.max(30,Math.floor(((options.timeout_ms??1200000)-30000)/1000))+'s';
export const newSession=()=>null;

export function dispatch(brief,lease,{session,resume,probe:cli,options={}}) {
 if(resume&&!session)throw Error('Antigravity resume requires a saved conversation_id');
 // agy에는 명령 단위 허용 규칙이 없다. 터미널 제한은 --sandbox로만 건다.
 const ignored=bashRules(brief);
 const text=prompt(brief,lease);
 const args=['--output-format','json','--json-schema',JSON.stringify(schemaFor(brief)),
  // 상담은 plan 모드(읽기·계획만), 구현은 accept-edits.
  ...(brief.consult?['--mode','plan']:brief.allowed_actions.includes('edit')?['--mode','accept-edits']:[]),'--add-dir',brief.repo_root,
  ...(options.sandbox===false?[]:['--sandbox']),...(cli.supports?.['--print-timeout']?['--print-timeout',printTimeout(options)]:[]),
  ...(resume?['--conversation',session]:[]),'-p',text];
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
