import {schemaFor,prompt,probe as probeCli,extractResult} from './common.mjs';

// OpenAI Codex CLI(codex exec) 하나로 두 팀원을 만든다. 모델과 권한만 다르다.
// - sol: GPT-6.1 Sol. 리뷰·상담은 읽기 전용이다. workspace-write와 writer lease는 컨트롤러의 APEX 구현 승인이 있는 라운드만 받는다.
// - luna: Luna. 빠르고 가벼운 모델. 작은 수정·기계적 대량 편집·리뷰 지적 반영 같은 구현을 맡는다.
// 모델 ID는 executors.<sol|luna>.model로 바꿀 수 있다. 기본값은 설치 환경에서 확인해야 한다.
// 플래그 출처: https://developers.openai.com/codex/noninteractive
export const binary=()=>process.env.HF_CODEX_BIN||'codex';
export const requiredFlags=['--sandbox','--output-schema','--cd'];
export const EFFORTS=['minimal','low','medium','high','xhigh'];

function member(name,{model,canWrite}) {
 const probe=()=>probeCli(`Codex (${name})`,binary(),requiredFlags,['--ephemeral'],{help:['exec','--help']});
 function dispatch(brief,lease,{probe:cli,promptFile,options={},apexGrant=false}) {
  const consult=!!brief.consult;
  // APEX 구현 승인만 Sol의 workspace-write를 연다. 리뷰와 상담은 같은 CLI라도 read-only다.
  if(apexGrant&&(consult||name!=='sol'))throw Error('ROLE_GATE: APEX workspace-write is only for a Sol implementation round');
  if(!consult&&!canWrite&&!apexGrant)throw Error(`${name} is a reviewer/adviser only; it never holds the writer lease`);
  // --output-schema는 파일을 받는다. 브리지가 실행 직전에 이 파일을 만든다.
  const schemaFile=promptFile.replace(/\.txt$/,'')+'.schema.json';
  const text=prompt(brief,lease);
  // 상담·리뷰는 읽기 전용, 구현은 작업 폴더 쓰기만. 커밋 등은 HEAD/index 스냅샷 검사로 잡는다.
  const sandbox=consult?'read-only':'workspace-write';
  const args=['exec','--sandbox',sandbox,'--cd',brief.repo_root,'--output-schema',schemaFile,
   ...(cli.supports?.['--ephemeral']?['--ephemeral']:[]),
   '-m',options.model??model,
   ...(options.reasoning_effort?['-c',`model_reasoning_effort="${options.reasoning_effort}"`]:[]),
   // 프롬프트는 stdin('-')으로 넘긴다. 명령줄 길이 제한과 따옴표 문제를 피한다.
   '-'];
  return {cli:{...cli,args,session_id:null,resume:false,model:options.model??model,extra_files:[{path:schemaFile,content:JSON.stringify(schemaFor(brief))}]},prompt:text,stdin:text};
 }
 // codex exec는 진행 상황을 stderr로, 최종 메시지만 stdout으로 낸다. 세션은 라운드마다 새로 연다.
 const parse=stdout=>({session_id:null,result:extractResult(stdout),usage:{total_cost_usd:null,note:'codex exec reports usage on stderr only'}});
 return {name,binary,defaultModel:model,canWrite,probe,newSession:()=>null,dispatch,parse};
}

export const sol=member('sol',{model:'gpt-6.1-sol',canWrite:false});
export const luna=member('luna',{model:'gpt-6-luna',canWrite:true});
