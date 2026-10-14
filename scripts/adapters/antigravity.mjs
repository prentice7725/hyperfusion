import {spawnSync} from 'node:child_process';
import {schemaFor,prompt,bashRules,probe as probeCli,extractResult,ACCEPTANCE} from './common.mjs';
import {assertCommandLine} from '../platform.mjs';
import {workerEnv} from '../worker-env.mjs';
import {memberBinary} from '../member-registry.mjs';
import {selectAgyModel} from './agy-model.mjs';

// Google Antigravity CLI(agy) 헤드리스 모드. 모든 플래그는 -p 앞에 와야 한다.
// 대화 ID는 CLI가 발급하므로 첫 라운드 envelope의 conversation_id를 저장해 재개에 쓴다.
export const name='antigravity';
export const requiredFlags=['--output-format','--json-schema','--conversation','--mode','--add-dir','--print'];
export const binary=()=>memberBinary('antigravity');
// --sandbox는 agy의 터미널만 제한하고 파일 쓰기 도구(write_to_file)는 막지 못한다(외부 실측). 그래서 상담·리뷰의
// 읽기 전용은 sandbox가 아니라 컨트롤러가 전후 스냅샷을 비교해 강제한다(저장소가 바뀌면 그 답변을 버린다).
// 그래도 셸로 쓰는 길은 줄여 주므로, 끌 수 있는 것은 운영자가 허용한 구현 라운드뿐이고 상담과 리뷰는 항상 --sandbox를 넘긴다
// (CLI가 그 플래그를 모르면 상담이 실패한다. 읽기 전용이어야 할 일꾼을 풀어 두는 것보다 낫다).
const unsandboxed=(options,brief)=>options.sandbox===false&&!brief?.consult;
export const probe=(options={})=>{
 const choice=selectAgyModel(options);
 const cli=probeCli('Antigravity',binary(),[...requiredFlags,...(options.sandbox===false?[]:['--sandbox']),...(choice.model||options.models_by_difficulty?['--model']:[]),...(choice.effort_flag?['--effort']:[])],['--print-timeout','--model','--effort'],{executor:'antigravity'});
 return choice.model?{...cli,model_check:checkModel(cli,choice.model)}:cli;
};

// agy는 모르는 --model을 받으면 오류 없이 기본 모델로 돈다(외부 실측). 어느 모델이 구현·리뷰했는지가 판정 근거이므로,
// 설정한 모델이 `agy models` 목록에 없으면 실행 전에 막는다. agy 1.2부터 한 줄이 `slug<TAB>표시 이름`이고 --model은 둘 다 받는다.
// 목록을 못 얻으면(옛 agy, 로그인 전, 시간 초과) 막지 않고 unverified로 남긴다. 운영자는 HF_AGY_ALLOW_UNLISTED_MODEL=1로 검사를 끌 수 있다.
export const ALLOW_UNLISTED_ENV='HF_AGY_ALLOW_UNLISTED_MODEL';
const modelKey=v=>String(v).toLowerCase().replace(/[^0-9a-z]/g,'');
// 출력 형식이 버전마다 달랐다(표시 이름만, slug<TAB>표시 이름). 형식이 또 바뀌어도 맞는 모델을 막지 않도록
// 줄 전체, 탭으로 나눈 열, 공백으로 나눈 낱말(slug에는 공백이 없다)을 모두 후보로 본다.
export function listedModels(text) {
 return String(text??'').split(/\r?\n/).map(l=>l.trim()).filter(Boolean)
  .flatMap(l=>[l,...l.split('\t'),...l.split(/\s+/)].map(x=>x.trim()).filter(x=>modelKey(x)));
}
const shownModels=text=>String(text??'').split(/\r?\n/).map(l=>l.split('\t')[0].trim()).filter(Boolean);
export function checkModel(cli,model) {
 if(process.env[ALLOW_UNLISTED_ENV]==='1')return {model,status:'skipped',reason:ALLOW_UNLISTED_ENV+'=1'};
 const r=spawnSync(cli.executable,[...(cli.prefix_args??[]),'models'],{encoding:'utf8',timeout:15000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe'],windowsHide:true,env:workerEnv('antigravity')});
 if(r.error||r.status!==0)return {model,status:'unverified',reason:'agy models '+(r.error?.code==='ETIMEDOUT'?'timed out':r.error?.message??`exited ${r.status}`)};
 const names=listedModels(r.stdout);
 if(!names.length)return {model,status:'unverified',reason:'agy models listed nothing'};
 if(names.some(n=>modelKey(n)===modelKey(model)))return {model,status:'listed'};
 throw Error(`MODEL_UNLISTED: executors.antigravity.model "${model}" is not listed by \`agy models\` (listed: ${shownModels(r.stdout).slice(0,6).join(', ')}${shownModels(r.stdout).length>6?', ...':''}). `
  +`agy would silently run its default model instead. Fix the model name, or have the operator set ${ALLOW_UNLISTED_ENV}=1 to launch anyway`);
}
// agy가 스스로 먼저 끝내도록 브리지 timeout보다 30초 짧게 잡는다. 그래야 강제 종료 대신 정상 envelope가 남는다.
export const printTimeout=options=>Math.max(30,Math.floor(((options.timeout_ms??1200000)-30000)/1000))+'s';
export const newSession=()=>null;
// 프롬프트가 명령줄로 가므로(Windows 32,767자) 상담 위원에게 넣는 diff를 작게 유지한다. 나머지는 파일을 직접 읽는다.
export const contextDiffMax=12000;

export function dispatch(brief,lease,{session,resume,probe:cli,options={}}) {
 const choice=selectAgyModel(options);
 if(choice.model&&!cli.supports?.['--model'])throw Error('MODEL_UNSUPPORTED: Antigravity requires --model support for a model override');
 if(choice.effort_flag&&!cli.supports?.['--effort'])throw Error('EFFORT_UNSUPPORTED: Antigravity requires --effort support for a reasoning_effort setting');
 if(resume&&!session)throw Error('Antigravity resume requires a saved conversation_id');
 // agy에는 실행 단위 명령 허용 플래그가 없다. 터미널 제한은 --sandbox와 운영자의 agy settings.json(permissions.allow)뿐이다.
 const ignored=bashRules(brief);
 const text=commandOrders(prompt(brief,lease),ignored,brief);
 const args=['--output-format','json','--json-schema',JSON.stringify(schemaFor(brief)),...(choice.model?['--model',choice.model]:[]),...(choice.effort_flag?['--effort',choice.effort_flag]:[]),
  // 상담은 plan 모드(읽기·계획만), 구현은 accept-edits.
  ...(brief.consult?['--mode','plan']:brief.allowed_actions.includes('edit')?['--mode','accept-edits']:[]),'--add-dir',brief.repo_root,
  ...(unsandboxed(options,brief)?[]:['--sandbox']),...(cli.supports?.['--print-timeout']?['--print-timeout',printTimeout(options)]:[]),
  ...(resume?['--conversation',session]:[]),'-p',text];
 // 프롬프트를 명령줄로 넘기므로 Windows 길이 제한을 lease 획득 전에 확인한다.
 assertCommandLine(cli.executable,[...(cli.prefix_args??[]),...args]);
 return {cli:{...cli,args,session_id:session??null,resume,model:choice.model,model_family:choice.model_family,reasoning_effort:choice.reasoning_effort,ignored_bash_rules:ignored},prompt:text};
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
 // 헤드리스 agy는 오래 걸리는 명령을 비동기로 띄우고 완료 알림을 기다리다 결과 없이 끝난 적이 있다.
 // 명령은 끝날 때까지 기다리게 하고, 수용 테스트는 직접 돌리지 말고 컨트롤러에 맡기게 한다.
 const sync='Run every command in the foreground and wait until it exits before your next step. Never start a command in the background, never leave a process running, and never wait for a completion notification: headless mode cannot deliver one, so the run ends with no result.';
 const tests='Do not run brief.acceptance_commands yourself in this headless mode. The controller runs every one of them right after you finish and sends any failure back to you with its output; list them in tests as not_run. Leave the tree clean: no new untracked files, and do not touch gitignored files (node_modules, build outputs) unless the brief asks for it, or the controller will refuse to run the tests.';
 const p=JSON.parse(text);
 p.instructions=[...p.instructions.filter(x=>x!==ACCEPTANCE),order,sync,...(brief.acceptance_commands?.length?[tests]:[])];
 return JSON.stringify(p);
}

// agy에는 로그인 상태를 묻는 하위 명령이 없고, 로그아웃 상태에서는 라운드 하나를 빈 응답으로 날린다.
// 실행 전 점검(매번 최대 35초)은 비싸서, 실패한 실행의 출력에서만 원인을 알아본다.
const SIGNED_OUT=/not (?:signed|logged)[ -]?in|(?:sign|log)[ -]?in (?:is )?required|please (?:sign|log)[ -]?in|unauthenticated|not authenticated|authentication (?:required|failed)|no (?:active )?(?:google )?(?:session|credentials)|invalid api key/i;
export function diagnose(stdout,stderr) {
 const text=String(stderr??'').slice(-4000)+'\n'+String(stdout??'').slice(-4000);
 return SIGNED_OUT.test(text)
  ?'AGY_NOT_SIGNED_IN: agy does not look signed in. Run `agy` once interactively and sign in (or have the operator set GEMINI_API_KEY / ANTIGRAVITY_API_KEY), then retry. Retrying without signing in fails the same way'
  :null;
}

export function parse(stdout,request) {
 let e;
 try{e=JSON.parse(stdout);}catch{throw Error('Antigravity emitted invalid JSON');}
 if(!e||e.error)throw Error('Antigravity returned an error envelope: '+JSON.stringify(e?.error??null));
 if(typeof e.status==='string'&&/error|fail|cancel|timeout|denied|abort/i.test(e.status))throw Error('Antigravity run status: '+e.status);
 if(typeof e.conversation_id!=='string'||!e.conversation_id.trim())throw Error('Antigravity envelope has no conversation_id');
 if(request.cli.session_id&&e.conversation_id!==request.cli.session_id)throw Error('Antigravity session provenance mismatch');
 return {session_id:e.conversation_id,result:currentResult(e,request),
  usage:{usage:e.usage??null,num_turns:e.num_turns??null,duration_seconds:e.duration_seconds??null,total_cost_usd:null}};
}

// --conversation로 재개하면 agy가 structured_output에 이전 라운드 결과를 그대로 돌려주고, 새 결과는 응답 텍스트에만 넣는다.
// 현재 라운드(상담이면 consult_id·member)와 맞지 않는 structured_output은 버리고 응답 텍스트의 JSON을 쓴다.
// 응답 텍스트에도 현재 결과가 없으면 이전 결과를 이번 라운드 결과로 받아들이지 않고 실패시킨다.
export function currentResult(e,request) {
 const fresh=r=>!!r&&typeof r==='object'&&(request.task_id===undefined||r.task_id===request.task_id)
  &&(request.consult_id!==undefined?r.consult_id===request.consult_id&&r.member===request.member:r.round===request.round);
 const structured=e.structured_output;
 if(structured===undefined||structured===null)return extractResult(e.response);
 if(fresh(structured))return structured;
 let text;
 try{text=extractResult(e.response);}catch{text=null;}
 if(fresh(text))return text;
 const seen=request.consult_id!==undefined?`consult ${structured?.consult_id}`:`round ${structured?.round}`;
 throw Error(`Antigravity structured_output belongs to ${seen}, not this run, and the response text has no current result`);
}
