import {schemaFor,prompt,bashRules,probe as probeCli,extractResult} from './common.mjs';
import {assertCommandLine} from '../platform.mjs';

// Google Antigravity CLI(agy) 헤드리스 모드. 모든 플래그는 -p 앞에 와야 한다.
// 대화 ID는 CLI가 발급하므로 첫 라운드 envelope의 conversation_id를 저장해 재개에 쓴다.
export const name='antigravity';
export const requiredFlags=['--output-format','--json-schema','--conversation','--mode','--add-dir','--print'];
export const binary=()=>process.env.HF_AGY_BIN||'agy';
// 샌드박스를 끌 수 있는 것은 운영자가 허용한 구현 라운드뿐이다. 상담과 리뷰는 설정과 상관없이 항상 --sandbox를 넘긴다
// (CLI가 그 플래그를 모르면 상담이 실패한다. 읽기 전용이어야 할 일꾼을 풀어 두는 것보다 낫다).
const unsandboxed=(options,brief)=>options.sandbox===false&&!brief?.consult;
export const probe=(options={})=>probeCli('Antigravity',binary(),[...requiredFlags,...(options.sandbox===false?[]:['--sandbox']),...(options.model?['--model']:[]),...(options.reasoning_effort?['--effort']:[])],['--print-timeout','--model','--effort']);
// agy가 스스로 먼저 끝내도록 브리지 timeout보다 30초 짧게 잡는다. 그래야 강제 종료 대신 정상 envelope가 남는다.
export const printTimeout=options=>Math.max(30,Math.floor(((options.timeout_ms??1200000)-30000)/1000))+'s';
export const newSession=()=>null;

export function dispatch(brief,lease,{session,resume,probe:cli,options={}}) {
 if(options.model&&!cli.supports?.['--model'])throw Error('MODEL_UNSUPPORTED: Antigravity requires --model support for a model override');
 if(options.reasoning_effort&&!cli.supports?.['--effort'])throw Error('EFFORT_UNSUPPORTED: Antigravity requires --effort support for a reasoning_effort setting');
 if(resume&&!session)throw Error('Antigravity resume requires a saved conversation_id');
 // agy에는 실행 단위 명령 허용 플래그가 없다. 터미널 제한은 --sandbox와 운영자의 agy settings.json(permissions.allow)뿐이다.
 const ignored=bashRules(brief);
 const text=commandOrders(prompt(brief,lease),ignored,brief);
 const args=['--output-format','json','--json-schema',JSON.stringify(schemaFor(brief)),...(options.model?['--model',options.model]:[]),...(options.reasoning_effort?['--effort',options.reasoning_effort]:[]),
  // 상담은 plan 모드(읽기·계획만), 구현은 accept-edits.
  ...(brief.consult?['--mode','plan']:brief.allowed_actions.includes('edit')?['--mode','accept-edits']:[]),'--add-dir',brief.repo_root,
  ...(unsandboxed(options,brief)?[]:['--sandbox']),...(cli.supports?.['--print-timeout']?['--print-timeout',printTimeout(options)]:[]),
  ...(resume?['--conversation',session]:[]),'-p',text];
 // 프롬프트를 명령줄로 넘기므로 Windows 길이 제한을 lease 획득 전에 확인한다.
 assertCommandLine(cli.executable,[...(cli.prefix_args??[]),...args]);
 return {cli:{...cli,args,session_id:session??null,resume,ignored_bash_rules:ignored},prompt:text};
}

// 헤드리스 agy는 허용 목록 밖의 명령을 자동 거부하고, 거부가 한 번이라도 나면 결과 없이 끝난다
// (agy 1.3.2 실측: 파일 바이트 확인용 powershell 한 줄 때문에 라운드 전체가 빈 응답).
// 그래서 brief가 허용한 명령만 정확히 알려 주고, 확인은 파일 읽기 도구로 하게 한다.
const ruleCommand=rule=>rule.replace(/^Bash\(/,'').replace(/\)$/,'').replace(/\*$/,'').trim();
export function commandOrders(text,rules,brief) {
 if(brief.consult)return text;
 const allowed=rules.map(ruleCommand).filter(Boolean);
 const order=allowed.length
  ?`Headless mode auto-denies any shell command outside the operator allow-list, and one denied command ends this run with no result. Run only commands that start with one of: ${allowed.map(c=>JSON.stringify(c)).join(', ')}. Never run any other shell command (no powershell, node -e, cat, type or byte dumps); read and verify files with your file view tools. If a check needs a command outside this list, report it as not_run.`
  :'Headless mode auto-denies shell commands, and one denied command ends this run with no result. Run no shell commands at all; read and verify files with your file view tools and report checks you could not run as not_run.';
 const p=JSON.parse(text);
 p.instructions=[...p.instructions,order];
 return JSON.stringify(p);
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
