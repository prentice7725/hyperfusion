import {schemaFor,prompt,probe as probeCli,extractResult} from './common.mjs';

// OpenAI Codex CLI를 리뷰어·상담 위원으로만 쓴다. 쓰기 lease를 받는 구현 일꾼은 아니다.
// 리드(Opus)와 다른 계열 모델이라 교차 검증에 가장 쓸모 있다.
// 플래그 출처: https://developers.openai.com/codex/noninteractive
export const name='codex';
export const requiredFlags=['--sandbox','--output-schema','--cd'];
export const binary=()=>process.env.HF_CODEX_BIN||'codex';
export const probe=()=>probeCli('Codex',binary(),requiredFlags,['--ephemeral'],{help:['exec','--help']});
export const newSession=()=>null;
export const EFFORTS=['minimal','low','medium','high','xhigh'];

export function dispatch(brief,lease,{probe:cli,promptFile,options={}}) {
 if(!brief.consult)throw Error('Codex is a reviewer/adviser only; it never holds the writer lease');
 // --output-schema는 파일을 받는다. 브리지가 실행 직전에 이 파일을 만든다.
 const schemaFile=promptFile.replace(/\.txt$/,'')+'.schema.json';
 const text=prompt(brief,lease);
 const args=['exec','--sandbox','read-only','--cd',brief.repo_root,'--output-schema',schemaFile,
  ...(cli.supports?.['--ephemeral']?['--ephemeral']:[]),
  ...(options.model?['-m',options.model]:[]),
  ...(options.reasoning_effort?['-c',`model_reasoning_effort="${options.reasoning_effort}"`]:[]),
  // 프롬프트는 stdin('-')으로 넘긴다. 명령줄 길이 제한과 따옴표 문제를 피한다.
  '-'];
 return {cli:{...cli,args,session_id:null,resume:false,extra_files:[{path:schemaFile,content:JSON.stringify(schemaFor(brief))}]},prompt:text,stdin:text};
}

// codex exec는 진행 상황을 stderr로, 최종 메시지만 stdout으로 낸다.
export function parse(stdout) {
 return {session_id:null,result:extractResult(stdout),usage:{total_cost_usd:null,note:'codex exec reports usage on stderr only'}};
}
