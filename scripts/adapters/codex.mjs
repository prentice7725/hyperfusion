import {schemaFor,prompt,probe as probeCli,extractResult} from './common.mjs';
import {memberBinary,MEMBERS} from '../member-registry.mjs';
import {sandboxArgs,windowsSandboxSelfTest,SANDBOX_FAILURE,SANDBOX_HINT,WINDOWS_SANDBOX_ENV} from '../codex-sandbox.mjs';

// OpenAI Codex CLI(codex exec) 하나로 두 팀원을 만든다. 모델과 권한만 다르다.
// - sol: GPT-6.1 Sol. 리뷰·상담은 읽기 전용이다. workspace-write와 writer lease는 컨트롤러의 APEX 구현 승인이 있는 라운드만 받는다.
// - luna: Luna. 빠르고 가벼운 모델. 작은 수정·기계적 대량 편집·리뷰 지적 반영 같은 구현을 맡는다.
// 모델 ID는 executors.<sol|luna>.model로 바꿀 수 있다. 기본값은 설치 환경에서 확인해야 한다.
// 플래그 출처: https://developers.openai.com/codex/noninteractive
export const binary=()=>memberBinary('luna');
export const requiredFlags=['--sandbox','--output-schema','--cd','--json'];
export const EFFORTS=['minimal','low','medium','high','xhigh'];

// OpenAI의 구조화 출력은 모든 객체에서 properties의 모든 키를 required로 요구한다(아니면 400 invalid_json_schema).
// 선택 항목(memory_candidates, keywords)도 필수로 바꿔 보낸다. 일꾼은 없으면 빈 배열을 낸다.
export function strictSchema(schema) {
 if(Array.isArray(schema))return schema.map(strictSchema);
 if(!schema||typeof schema!=='object')return schema;
 const out=Object.fromEntries(Object.entries(schema).map(([k,v])=>[k,strictSchema(v)]));
 if(out.type==='object'&&out.properties)out.required=Object.keys(out.properties);
 return out;
}

function member(name,{model,canWrite}) {
 const probe=()=>{
  const cli=probeCli(`Codex (${name})`,binary(),requiredFlags,['--ephemeral'],{help:['exec','--help'],executor:name});
  // Resume contracts vary by CLI version. Never guess or use --last.
  try{probeCli(`Codex (${name}) resume`,binary(),['--json','--output-schema','--model','--sandbox','--cd'],[],{help:['exec','resume','--help'],executor:name});cli.supports.resume=true;}catch{cli.supports.resume=false;}
  return cli;
 };
 function dispatch(brief,lease,{session,resume,probe:cli,promptFile,options={},apexGrant=false}) {
  const consult=!!brief.consult;
  // APEX 구현 승인만 Sol의 workspace-write를 연다. 리뷰와 상담은 같은 CLI라도 read-only다.
  if(apexGrant&&(consult||name!=='sol'))throw Error('ROLE_GATE: APEX workspace-write is only for a Sol implementation round');
  if(!consult&&!canWrite&&!apexGrant)throw Error(`${name} is a reviewer/adviser only; it never holds the writer lease`);
  // --output-schema는 파일을 받는다. 브리지가 실행 직전에 이 파일을 만든다.
  const schemaFile=promptFile.replace(/\.txt$/,'')+'.schema.json';
  const text=prompt(brief,lease);
  // 상담·리뷰는 읽기 전용, 구현은 작업 폴더 쓰기만. 커밋 등은 HEAD/index 스냅샷 검사로 잡는다.
  const sandbox=consult?'read-only':'workspace-write';
  if(resume&&(!cli.supports?.resume||!validSession(session)))throw Error('CODEX_RESUME_UNSUPPORTED: explicit session resume requires compatible CLI help and a recorded thread ID');
  const args=['exec',...(resume?['resume']:[]),'--sandbox',sandbox,'--cd',brief.repo_root,'--output-schema',schemaFile,
   ...((consult||!cli.supports?.resume)&&cli.supports?.['--ephemeral']?['--ephemeral']:[]),
   '--model',options.model??model,
   ...(options.reasoning_effort?['-c',`model_reasoning_effort="${options.reasoning_effort}"`]:[]),
   ...sandboxArgs({consult,repoRoot:brief.repo_root}),
   '--json',...(resume?[session]:[]),
   // 프롬프트는 stdin('-')으로 넘긴다. 명령줄 길이 제한과 따옴표 문제를 피한다.
   '-'];
  return {cli:{...cli,args,session_id:resume?session:null,resume:!!resume,persistence:!consult&&cli.supports?.resume?'task':'ephemeral',model:options.model??model,extra_files:[{path:schemaFile,content:JSON.stringify(strictSchema(schemaFor(brief)))}]},prompt:text,stdin:text};
 }
 // codex exec는 진행 상황을 stderr로, 최종 메시지만 stdout으로 낸다. 세션은 라운드마다 새로 연다.
 const parse=(stdout,request)=>parseEvents(stdout,request);
 // 실행 전 점검: Windows에서 샌드박스가 프로세스를 띄우는지(모델 호출 없음). 컨트롤러가 일꾼을 고를 때 설치 확인과 함께 부른다.
 const preflight=({root}={})=>process.platform==='win32'?preflightSandbox(probe(),root):{status:'skipped',reason:'not Windows'};
 return {name,binary,defaultModel:model,canWrite,probe,newSession:()=>null,dispatch,parse,preflight,diagnose};
}

// 같은 실행 파일·설정·저장소에 대한 점검은 한 프로세스에서 한 번만 한다(Sol과 Luna는 같은 CLI다).
const preflightMemo=new Map();
function preflightSandbox(cli,root) {
 const key=[cli.executable,...(cli.prefix_args??[]),process.env[WINDOWS_SANDBOX_ENV]??'',root??''].join('\0');
 if(!preflightMemo.has(key)){
  try{preflightMemo.set(key,{ok:windowsSandboxSelfTest(cli,{root})});}catch(e){preflightMemo.set(key,{error:e});}
 }
 const hit=preflightMemo.get(key);
 if(hit.error)throw hit.error;
 return hit.ok;
}

// 실패한 실행의 출력에서 원인을 알아본다(브리지가 오류 문구에 덧붙인다).
export function diagnose(stdout,stderr) {
 const text=String(stderr??'').slice(-8000)+'\n'+String(stdout??'').slice(-8000);
 return SANDBOX_FAILURE.test(text)?`CODEX_WINDOWS_SANDBOX: Codex could not start a process inside its Windows sandbox (access denied). ${SANDBOX_HINT}`:null;
}

const validSession=id=>typeof id==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id);
export function parseEvents(stdout,request) {
 let session=null,text=null,completed=false,usage=null,sandboxFailure=null;
 for(const line of stdout.split(/\r?\n/).filter(s=>s.trim())){
  let e;try{e=JSON.parse(line);}catch{throw Error('Codex emitted invalid JSONL');}
  if(!e||typeof e.type!=='string')throw Error('Codex emitted an unrecognized event');
  // 샌드박스가 셸을 띄우지 못하면 턴은 정상 종료되고 일꾼은 "못 했다"고만 보고한다. 명령 실행 결과에서 직접 찾아 라운드를 실패시킨다.
  if(e.type==='item.completed'&&e.item?.type==='command_execution'){
   const out=String(e.item.aggregated_output??'')+'\n'+String(e.item.error??'');
   const hit=out.split(/\r?\n/).find(l=>SANDBOX_FAILURE.test(l));
   if(hit&&!sandboxFailure)sandboxFailure=hit.trim().slice(0,200);
  }
  if(['turn.failed','error'].includes(e.type))throw Error('Codex returned an unsuccessful turn');
  if(e.type==='thread.started'){
   if(!validSession(e.thread_id)||session)throw Error('Codex thread provenance mismatch');
   session=e.thread_id;
  }
  if(e.type==='item.completed'&&e.item?.type==='agent_message'){
   if(completed)throw Error('Codex emitted a result after turn completion');
   text=e.item.text;
  }
  if(e.type==='turn.completed'){
   if(completed)throw Error('Codex emitted multiple turns');
   completed=true;usage=e.usage;
  }
 }
 if(sandboxFailure)throw Error(`CODEX_WINDOWS_SANDBOX: Codex could not run commands inside its Windows sandbox (access denied: "${sandboxFailure}"). ${SANDBOX_HINT}`);
 if(!completed||!session||!text)throw Error('Codex returned an incomplete turn');
 if(request?.cli?.session_id&&session!==request.cli.session_id)throw Error('Codex session provenance mismatch');
 const numeric=n=>Number.isSafeInteger(n)&&n>=0;
 const valid=numeric(usage?.input_tokens)&&numeric(usage?.output_tokens)&&numeric(usage?.cached_input_tokens??0)&&numeric(usage.input_tokens+usage.output_tokens)&&(usage.cached_input_tokens??0)<=usage.input_tokens;
 // Codex cached_input_tokens is a SUBSET of input, unlike Claude cache fields.
 const normalized=valid?{input_tokens:usage.input_tokens,output_tokens:usage.output_tokens,cached_input_tokens:usage.cached_input_tokens??0,total_tokens:usage.input_tokens+usage.output_tokens}:null;
 return {session_id:request?.cli?.persistence==='ephemeral'?null:session,result:extractResult(text),usage:{thread_id:session,usage:normalized,total_cost_usd:null,note:'Codex turn.completed client report; cached input is included in input, not added again'}};
}
export const sol=member('sol',{model:MEMBERS.sol.model,canWrite:false});
export const luna=member('luna',{model:MEMBERS.luna.model,canWrite:true});
