import {execFileSync} from 'node:child_process';
import {resolveExecutable} from '../platform.mjs';

// 외부 일꾼(Grok, Antigravity)이 공통으로 따르는 결과 계약과 지시문.
export function resultSchema(task_id,round) {
 const strings={type:'array',items:{type:'string'}};
 const properties={task_id:{const:task_id},round:{const:round},status:{enum:['complete','blocked','needs_decision','failed']},summary:{type:'string'},files_read:strings,files_changed:strings,commands_run:strings,tests:{type:'array',items:{type:'object',properties:{command:{type:'string'},status:{enum:['pass','fail','not_run']}},required:['command','status'],additionalProperties:false}},unresolved:strings,risks:strings,needs_lead_decision:{type:'boolean'},recommended_next_action:{type:'string'}};
 return {type:'object',properties,required:Object.keys(properties),additionalProperties:false};
}

export function prompt(brief,lease) {
 return JSON.stringify({protocol:'hyperfusion-opus-lead-v0.3',lead:'Claude Opus 5.5',worker:lease.owner,brief,
 result_template:{task_id:brief.task_id,round:brief.round,status:'complete',summary:'Describe actual outcome',files_read:[],files_changed:[],commands_run:[],tests:[],unresolved:[],risks:[],needs_lead_decision:false,recommended_next_action:'review'},
 result_rules:[
  'Your FINAL message must be only the filled result_template as one JSON object. No prose around it.',
  'Keep task_id and round unchanged. status is complete, blocked, needs_decision or failed; needs_decision requires needs_lead_decision=true.',
  'files_read and files_changed are repository-relative paths; files_changed covers only this round and must match the real diff exactly.',
  'tests holds commands you actually ran with status pass, fail or not_run. Never invent evidence: the lead re-runs everything and diffs the tree.',
  'complete means no failed tests, no unresolved items and no pending lead decision.'
 ],
 instructions:[
  'You are a worker, not a planner. Execute exactly this brief until every success criterion holds, then stop.',
  'If lead_feedback is present, every item in it is a blocking order from the lead. Address each one; ignoring any of them fails the round.',
  'Do not commit, stage, push, deploy, delegate, touch .fusion or .git, or edit outside scope.paths.',
  'Do not stop at a plan or a partial patch. Write the code, run the tests, fix what fails.',
  'If the brief itself is wrong or insufficient, return needs_decision with the concrete question instead of guessing.',
  'Stop every command and child process before returning. Returning ends your write authority.'
 ]});
}

export function bashRules(brief) {
 const rules=brief.executor_bash_rules??[];
 if(!Array.isArray(rules)||rules.some(r=>typeof r!=='string'||!/^Bash\([^(),\n]+\)$/.test(r)||r==='Bash(*)'))throw Error('Invalid executor_bash_rules');
 return rules;
}

// 실행 파일과 필수 플래그를 확인한다. 인증은 실제 호출에서만 드러난다.
export function probe(name,binary,requiredFlags) {
 const {executable,prefix_args}=resolveExecutable(name,binary);
 const opts={encoding:'utf8',timeout:15000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe'],windowsHide:true};
 const version=execFileSync(executable,[...prefix_args,'--version'],opts).trim();
 const help=execFileSync(executable,[...prefix_args,'--help'],opts);
 const missing=requiredFlags.filter(f=>!help.includes(f));
 if(missing.length)throw Error(`ADAPTER_UNAVAILABLE: missing ${name} flags `+missing.join(', '));
 return {executable,prefix_args,version,platform:process.platform,authentication:'not verified by local probe'};
}

// 스키마 강제가 없는 CLI는 최종 텍스트에서 결과 JSON을 꺼낸다. 마지막 ```json 블록 또는 본문 전체만 인정한다.
export function extractResult(text) {
 if(typeof text!=='string'||!text.trim())throw Error('Executor returned no final text');
 try{return JSON.parse(text.trim());}catch{}
 const blocks=[...text.matchAll(/```json\s*\n([\s\S]*?)```/g)];
 if(!blocks.length)throw Error('Executor final text has no result JSON');
 try{return JSON.parse(blocks.at(-1)[1]);}catch{throw Error('Executor result JSON is malformed');}
}
