import path from 'node:path';
import {adapter} from './adapters/index.mjs';
import {read} from './artifact.mjs';

// 브리지는 dispatch 파일을 그대로 믿지 않는다. 컨트롤러가 쓴 brief와 상태에서 같은 요청을 다시 만들어 보고,
// 실행 파일, 인자, 프롬프트가 하나라도 다르면 일꾼을 띄우지 않는다. 그래서 파일이 바뀌었어도 권한이 넓어지지 않는다.

const canon=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a<b?-1:1)):x);
const shape=r=>({cli:r.cli,prompt:r.prompt,stdin:r.stdin});

function compare(label,expected,request) {
 const a=canon(shape(expected)),b=canon(shape(request));
 if(a===b)return;
 const parts=['executable','args','prompt_file','extra_files'].filter(k=>canon(expected.cli?.[k])!==canon(request.cli?.[k]));
 if(canon(expected.prompt)!==canon(request.prompt))parts.push('prompt');
 throw Error(`DISPATCH_TAMPERED: ${label} differs from what the controller derives (${parts.join(', ')||'other fields'}); nothing was started`);
}

// 구현 라운드: brief-N.json(생성 후 불변)과 상태의 세션으로 요청을 다시 만든다.
export function verifyExecute(root,state,dir,request,lease) {
 const n=state.iteration,owner=state.owner,a=adapter(owner);
 const options=state.configuration?.executors?.[owner]??{};
 const brief={...read(path.join(dir,`brief-${n}.json`)),repo_root:root,round:n};
 const expected=a.dispatch(brief,lease,{session:state.sessions?.[owner]??null,resume:!!request.cli?.resume,probe:a.probe(options),promptFile:path.join(dir,`prompt-${n}.txt`),options});
 compare(`dispatch-${n}.json`,expected,request);
 return expected;
}

// 상담: 요청에 담긴 brief가 읽기 전용 상담인지 확인한 뒤, 그 brief로 인자를 다시 만들어 비교한다.
export function verifyConsult(root,state,dir,request,{id,member,executor}) {
 let brief;
 try{brief=JSON.parse(request.prompt).brief;}catch{throw Error('DISPATCH_TAMPERED: consult prompt is not a brief; nothing was started');}
 const c=brief?.consult;
 const ok=c&&c.id===id&&c.member===member&&brief.task_id===state.task_id&&brief.repo_root===root
  &&Array.isArray(brief.allowed_actions)&&brief.allowed_actions.length===1&&brief.allowed_actions[0]==='read'
  &&request.executor===executor&&request.kind==='consult';
 if(!ok)throw Error('DISPATCH_TAMPERED: consult request does not match the open consult or is not read-only; nothing was started');
 const a=adapter(executor),options=state.configuration?.executors?.[executor]??{};
 const expected=a.dispatch(brief,{token:'consult',owner:executor},{session:request.cli?.session_id??null,resume:false,probe:a.probe(options),
  promptFile:path.join(dir,`prompt-consult-${id}-${member}.txt`),options});
 compare(`consult-${id}-${member}.json`,expected,request);
 return expected;
}
