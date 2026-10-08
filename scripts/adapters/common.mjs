import {spawnSync} from 'node:child_process';
import {resolveExecutable} from '../platform.mjs';
import {controlRoot} from '../control-dir.mjs';
import {checkBashRules} from '../bash-policy.mjs';
import {PROTOCOL,VERSION} from '../versions.mjs';

// 외부 일꾼(Grok, Antigravity)이 공통으로 따르는 결과 계약과 지시문.
export function resultSchema(task_id,round) {
 const strings={type:'array',items:{type:'string'}};
 const properties={task_id:{const:task_id},round:{const:round},status:{enum:['complete','blocked','needs_decision','failed']},summary:{type:'string'},files_read:strings,files_changed:strings,commands_run:strings,tests:{type:'array',items:{type:'object',properties:{command:{type:'string'},status:{enum:['pass','fail','not_run']}},required:['command','status'],additionalProperties:false}},unresolved:strings,risks:strings,needs_lead_decision:{type:'boolean'},recommended_next_action:{type:'string'}};
 const required=Object.keys(properties);
 // 선택 항목: 다음 세션·다른 일꾼이 알아야 할 교훈. 리드가 승인해야 기억에 저장된다.
 properties.memory_candidates={type:'array',maxItems:3,items:{type:'object',properties:{type:{enum:['error','procedure','episode','fact']},content:{type:'string'},keywords:strings},required:['type','content'],additionalProperties:false}};
 return {type:'object',properties,required,additionalProperties:false};
}

// 상담(advisor/committee) 결과 계약. 코드를 고치지 않고 판단 근거만 낸다.
export function consultSchema(brief) {
 const c=brief.consult;
 const finding={type:'object',properties:{file:{type:'string'},line:{type:'integer',minimum:0},severity:{enum:['blocker','major','minor','nit']},issue:{type:'string'},suggestion:{type:'string'}},required:['file','line','severity','issue','suggestion'],additionalProperties:false};
 const properties={task_id:{const:brief.task_id},consult_id:{const:c.id},member:{const:c.member},summary:{type:'string'},findings:{type:'array',items:finding},root_cause:{type:'string'},plan:{type:'array',items:{type:'string'}},recommended_verdict:{enum:['pass','redo','alternative','decision','none']},confidence:{enum:['low','medium','high']}};
 // 위임 리뷰는 판정이 그대로 적용되므로 'none'을 허용하지 않고, 반려 사유 목록을 따로 받는다.
 if(c.mode==='review'){properties.recommended_verdict={enum:['pass','redo','alternative','decision']};properties.blocking_criteria={type:'array',items:{type:'string'}};}
 return {type:'object',properties,required:Object.keys(properties),additionalProperties:false};
}
export const schemaFor=brief=>brief.consult?consultSchema(brief):resultSchema(brief.task_id,brief.round);

// 과거 기억은 참고 자료일 뿐이다. 정본과 리드 지시가 항상 우선한다.
const PRIOR='prior_experience, when present, holds memories recalled from earlier sessions and other agents. It ranks below this brief, the repository files and lead_feedback. Use it to avoid repeating known failures, and verify a memory before relying on it.';
const IMPLEMENT_RULES=[
 'Your FINAL message must be only the filled result_template as one JSON object. No prose around it.',
 'Keep task_id and round unchanged. status is complete, blocked, needs_decision or failed; needs_decision requires needs_lead_decision=true.',
 'files_read and files_changed are repository-relative paths; files_changed covers only this round and must match the real diff exactly.',
 'tests holds commands you actually ran with status pass, fail or not_run. Never invent evidence: the lead re-runs everything and diffs the tree.',
 'complete means no failed tests, no unresolved items and no pending lead decision.',
 'Optional memory_candidates: up to 3 one- or two-sentence lessons the next agent should know (error with its cause and fix, a procedure that worked, a notable episode). Facts only, never secrets, never a copy of the brief. The lead decides whether they are kept.'
];
const IMPLEMENT_ORDERS=[
 'You are a worker, not a planner. Execute exactly this brief until every success criterion holds, then stop.',
 'If lead_feedback is present, every item in it is a blocking order from the lead. Items with file/line point at the exact spot. Address each one; ignoring any of them fails the round.',
 'Do not commit, stage, push, deploy, delegate, touch .fusion or .git, or edit outside scope.paths.',
 'Do not stop at a plan or a partial patch. Write the code, run the tests, fix what fails.',
 'If the brief itself is wrong or insufficient, return needs_decision with the concrete question instead of guessing.',
 'Stop every command and child process before returning. Returning ends your write authority.',
 PRIOR
];
const CONSULT_RULES=[
 'Your FINAL message must be only the filled result_template as one JSON object. No prose around it.',
 'Keep task_id, consult_id and member unchanged. findings use repository-relative file paths; line is 1-based, or 0 when not tied to a line.',
 'severity: blocker breaks a success criterion, major is a real bug or risk, minor is worth fixing, nit is style.',
 'recommended_verdict is what you would tell the lead: pass, redo (same worker can fix), alternative (needs a different approach/worker), decision (requirements or architecture unclear), or none.',
 'Only report what you verified by reading the code. Say so in summary when evidence is thin, and lower confidence.'
];
const CONSULT_ORDERS={
 advisor:['You are an independent reviewer hired by the lead. Another worker produced the change described in context. Find what is wrong or missing against the success criteria.'],
 review:['You are the reviewer of record for this round. The lead applies your verdict as-is unless it overrides you, so be exact.',
  'Check the actual change (context.diff, and read new files directly) against every success criterion. pass only if every criterion is met by code you read and nothing in scope regresses.',
  'For anything but pass, blocking_criteria must list each unmet criterion id (e.g. AC2) or a short concrete defect. Every finding needs file and line so the next worker can act without the lead re-reading the diff.',
  'Verdict: redo when the same worker can fix it, alternative when the approach itself is wrong, decision only when requirements or architecture are ambiguous and the lead must choose.'],
 committee:['You are one member of a two-member committee hired by the lead because the task is stuck. Step back: identify the root cause of the repeated failure and propose a concrete plan the next worker can execute.','The other member is a different model. Think independently; do not assume the last attempt was on the right track.']
};
const READ_ONLY=['This is a READ-ONLY consultation. Do not create, edit, move or delete any file. Do not run builds, tests, installers or any command that writes to disk. The lead diffs the whole tree afterwards; any change voids your answer and counts against you.'];

export function prompt(brief,lease) {
 if(brief.consult){
  const c=brief.consult;
  return JSON.stringify({protocol:PROTOCOL+'/consult',package_version:VERSION,lead:'Claude Opus 5.5',worker:lease.owner,brief,
   result_template:{task_id:brief.task_id,consult_id:c.id,member:c.member,summary:'Describe what you checked and concluded',findings:[],root_cause:'',plan:[],recommended_verdict:c.mode==='review'?'redo':'none',confidence:'low',...(c.mode==='review'?{blocking_criteria:[]}:{})},
   result_rules:CONSULT_RULES,instructions:[...CONSULT_ORDERS[c.mode],...READ_ONLY,PRIOR]});
 }
 return JSON.stringify({protocol:PROTOCOL,package_version:VERSION,lead:'Claude Opus 5.5',worker:lease.owner,brief,
 result_template:{task_id:brief.task_id,round:brief.round,status:'complete',summary:'Describe actual outcome',files_read:[],files_changed:[],commands_run:[],tests:[],unresolved:[],risks:[],needs_lead_decision:false,recommended_next_action:'review'},
 result_rules:IMPLEMENT_RULES,instructions:IMPLEMENT_ORDERS});
}

export function bashRules(brief) {
 // 상담은 명령 실행 권한을 주지 않는다.
 if(brief.consult)return [];
 return checkBashRules(brief.executor_bash_rules);
}

// 실행 파일과 필수 플래그를 확인한다. 인증은 실제 호출에서만 드러난다.
// optionalFlags는 있으면 쓰고 없어도 통과하는 플래그다. 결과의 supports에 기록된다.
// help는 도움말을 여는 인자. 하위 명령의 플래그를 봐야 하는 CLI(codex exec)는 따로 준다.
export function probe(name,binary,requiredFlags,optionalFlags=[],{help:helpArgs=['--help']}={}) {
 const {executable,prefix_args}=resolveExecutable(name,binary);
 const shown=prefix_args.at(-1)??executable;
 // 도움말을 stderr로 내거나 0이 아닌 코드로 끝내는 CLI도 있어 두 스트림을 합쳐 본다.
 const run=(...flag)=>{
  const r=spawnSync(executable,[...prefix_args,...flag],{encoding:'utf8',timeout:15000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe'],windowsHide:true});
  if(r.error)throw Error(`ADAPTER_UNAVAILABLE: ${name} ${flag.join(' ')} failed at ${shown}: ${r.error.code==='ETIMEDOUT'?'timed out (CLI may need a TTY)':r.error.message}`);
  return `${r.stdout??''}\n${r.stderr??''}`;
 };
 const version=run('--version').trim().split(/\r?\n/)[0];
 const help=run(...helpArgs);
 const missing=requiredFlags.filter(f=>!hasOption(help,f));
 // 어떤 파일이 잡혔고 무엇을 출력했는지 남겨야 엉뚱한 실행 파일(IDE 실행기 등)을 알아챌 수 있다.
 if(missing.length){const e=Error(`ADAPTER_UNAVAILABLE: missing ${name} flags ${missing.join(', ')} (resolved ${shown}, version "${version}", help starts "${help.trim().split(/\r?\n/).slice(0,2).join(' | ').slice(0,160)}")`);e.probe={executable,prefix_args,version,help,missing};throw e;}
 const supports=Object.fromEntries(optionalFlags.map(f=>[f,hasOption(help,f)]));
 const result={executable,prefix_args,version,platform:process.platform,supports,authentication:'not verified by local probe'};
 Object.defineProperty(result,'help',{value:help});
 return result;
}

export function hasOption(help,option) {
 const escaped=option.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 return new RegExp(`(^|[^\\w-])${escaped}(?![\\w-])`,'m').test(help);
}

// 스키마 강제가 없는 CLI는 최종 텍스트에서 결과 JSON을 꺼낸다. 마지막 ```json 블록 또는 본문 전체만 인정한다.
export function extractResult(text) {
 if(typeof text!=='string'||!text.trim())throw Error('Executor returned no final text');
 try{return JSON.parse(text.trim());}catch{}
 const blocks=[...text.matchAll(/```json\s*\n([\s\S]*?)```/g)];
 if(!blocks.length)throw Error('Executor final text has no result JSON');
 try{return JSON.parse(blocks.at(-1)[1]);}catch{throw Error('Executor result JSON is malformed');}
}

// 일꾼의 편집 도구가 고치면 안 되는 곳: .git(훅, 설정), 예전 .fusion, 제어 폴더. 중첩된 폴더도 막는다.
// 절대 경로 표기는 Claude Code 규칙 문법(`//` 로 시작, Windows는 `//c/...`)을 따른다.
// 이것은 도구 수준 규칙이다. 셸로 우회하는 일은 스냅샷 비교(변경 검사)가 잡는다.
export function protectedPaths(brief) {
 const abs=controlRoot(brief.repo_root).replaceAll('\\','/').replace(/^([A-Za-z]):/,(_,d)=>'/'+d.toLowerCase());
 return ['.git','.fusion'].flatMap(d=>[`${d}/**`,`**/${d}/**`]).concat(`/${abs}/**`);
}
export const editDeny=brief=>['Edit','Write'].flatMap(tool=>protectedPaths(brief).map(p=>`${tool}(${p})`));
