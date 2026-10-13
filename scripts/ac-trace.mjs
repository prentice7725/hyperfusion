// AC 추적표와 PR 설명 초안. 모델 호출은 하지 않고, 컨트롤러가 남긴 기록만 읽는다.
// 브리프의 acceptance_map은 {"AC1":["npm test -- a"]}처럼 수용 기준 ID와 그 기준을 증명하는 수용 명령을 잇는다.
// 판정은 컨트롤러가 실행한 결과로만 정한다. 일꾼이나 리뷰어의 말로 PASS가 되지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import {read,changes} from './artifact.mjs';

const AC_ID=/^AC\d+$/;
export const criterionIds=list=>[...new Set((list??[]).flatMap(t=>String(t).match(/\bAC\d+\b/gi)??[]).map(x=>x.toUpperCase()))];

// 브리프 검사. 지도에 적은 ID는 success_criteria에 있어야 하고, 명령은 acceptance_commands에 그대로 있어야 한다.
export function checkAcceptanceMap(v) {
 const map=v.acceptance_map;
 if(map===undefined)return;
 if(!v.acceptance_commands)throw Error('acceptance_map needs acceptance_commands');
 if(!map||typeof map!=='object'||Array.isArray(map)||!Object.keys(map).length)throw Error('acceptance_map must map AC IDs to acceptance commands');
 const ids=criterionIds(v.success_criteria);
 for(const [id,commands] of Object.entries(map)){
  if(!AC_ID.test(id))throw Error(`acceptance_map key ${id} must look like AC1`);
  if(!ids.includes(id))throw Error(`acceptance_map ${id} is not named in success_criteria`);
  if(!Array.isArray(commands)||!commands.length||commands.some(x=>!v.acceptance_commands.includes(x))){
   throw Error(`acceptance_map ${id} must list commands copied exactly from acceptance_commands`);
  }
 }
}

// 실패한 수용 명령을 반려 사유로 바꿀 때 AC ID를 앞에 붙인다. 반복 반려 판정이 ID로 같은 실수를 알아본다.
export function failureCriteria(brief,failed) {
 const map=brief.acceptance_map??{};
 return failed.map(r=>{
  const ids=Object.keys(map).filter(id=>map[id].includes(r.command));
  return (ids.length?ids.join(' ')+' ':'')+'Acceptance: '+r.command;
 });
}

// AC별 판정. PASS/FAIL은 수용 명령 결과로만, 명령이 없는 기준은 리뷰로만 확인된 것(REVIEWED)과 근거 없음(UNVERIFIED)으로 나눈다.
export function acTable(brief,results,{reviewed=false}={}) {
 const map=brief.acceptance_map??{};
 const byCommand=new Map((results??[]).map(r=>[r.command,r.status]));
 return criterionIds(brief.success_criteria).map(id=>{
  const text=brief.success_criteria.find(t=>new RegExp(`\\b${id}\\b`,'i').test(t));
  const commands=map[id]??[];
  let status;
  if(commands.length){
   const got=commands.map(cmd=>byCommand.get(cmd));
   status=got.every(x=>x==='pass')?'PASS':got.some(x=>x!==undefined&&x!=='pass'&&x!=='not_run')?'FAIL':'NOT_RUN';
  } else status=reviewed?'REVIEWED':'UNVERIFIED';
  return {id,criterion:String(text).slice(0,200),commands,status};
 });
}

const cell=v=>String(v??'').replace(/\|/g,'\\|').replace(/\r?\n/g,' ');

// CLOSE 때 만드는 PR 설명 초안. 커밋이나 푸시는 하지 않는다. 파일은 제어 폴더에만 쓴다.
export function prDraft({state,brief,table,changed,unattributed_changes=[],rounds,risks}) {
 const lines=[];
 const title=brief.objective.split(/\r?\n/)[0].trim().slice(0,72);
 lines.push(`# ${title}`,'');
 lines.push('## 변경 내용','');
 if(brief.objective.trim()!==title)lines.push(brief.objective.trim(),'');
 if(changed.length)lines.push(...changed.map(f=>`- \`${f}\``),'');
 if(unattributed_changes.length)lines.push('## 일꾼 라운드에 귀속되지 않는 변경','',
  '아래 파일의 최종 내용은 검증된 일꾼 라운드의 변경으로 확인되지 않았다. 복구·누적 리뷰에서 확인한 변경이며 일꾼의 구현 실적으로 계산하지 않는다.','',
  ...unattributed_changes.map(f=>`- \`${f}\``),'');
 lines.push('## 수용 기준','','| AC | 기준 | 판정 | 증명 명령 |','|---|---|---|---|',
  ...table.map(r=>`| ${r.id} | ${cell(r.criterion)} | ${r.status} | ${r.commands.map(x=>'`'+cell(x)+'`').join('<br>')||'-'} |`),'');
 if(brief.verification?.kind==='preserve')lines.push(`> 검증: 보존(preserve). 수정 전에도 통과하는 명령이고, 보호 경로(${brief.verification.protect.map(g=>'`'+g+'`').join(', ')})의 파일은 작업 내내 바뀌지 않았다.`,'');
 const plain=brief.success_criteria.filter(t=>!criterionIds([t]).length);
 if(plain.length)lines.push('ID 없는 기준(리뷰로 확인):','',...plain.map(t=>`- ${t}`),'');
 if(state?.lead_decision?.authority?.source==='delegated-policy')lines.push('> 승인: 위임 정책('+state.lead_decision.authority.policy+')이 컨트롤러 조건을 확인해 승인했다. 리드가 이 라운드를 직접 읽지 않았다.','');
 lines.push('## 진행','','| 라운드 | 작업자 | 판정 | 리뷰 |','|---|---|---|---|',
  ...rounds.map(r=>`| ${r.round} | ${r.owner??'-'} | ${r.verdict??'-'} | ${cell(r.reviewed_by??'-')} |`),'');
 if(risks.length)lines.push('## 남은 위험','',...risks.map(x=>`- ${x}`),'');
 lines.push('---',`HyperFusion task \`${state.task_id}\` · base \`${String(state.base_commit??'').slice(0,12)}\` · 커밋과 푸시는 하지 않았다.`,'');
 return lines.join('\n');
}

// Implementation starts at base-1, preserving user edits before the first round.
// Attribute a final file to a worker only when it still matches that worker's
// last validated post-snapshot. A recovered overwrite of an earlier worker file
// must not acquire attribution just because its name appears in round history.
export function taskChangeEvidence(dir,state,current) {
 const optional=name=>{const f=path.join(dir,name);return fs.existsSync(f)?read(f):null;};
 const start=optional('base-1.json')??optional('baseline.json');
 const end=current??optional(`post-${state.iteration}.json`)??start;
 if(!start||!end)throw Error('Missing task change snapshots');
 const changed=changes(start,end),workerEntries=new Map();
 for(let n=1;n<=state.iteration;n++){
  const validation=optional(`validation-${n}.json`),post=optional(`post-${n}.json`);
  if(!validation||validation.errors?.length||!post)continue;
  for(const file of validation.changed??[])workerEntries.set(file,post.files[file]??null);
 }
 const unattributed_changes=changed.filter(file=>!workerEntries.has(file)
  ||JSON.stringify(workerEntries.get(file))!==JSON.stringify(end.files[file]??null));
 return {changed,unattributed_changes};
}

// Final change list is the net task diff, not a union of round history.
export function draftInputs(dir,state,current) {
 const optional=name=>{const f=path.join(dir,name);return fs.existsSync(f)?read(f):null;};
 const risks=[],rounds=[];
 for(let n=1;n<=state.iteration;n++){
  const review=state.reviews.filter(r=>r.round===n).at(-1);
  const lead=optional(`lead-decision-${n}.json`);
  const panel=(state.review_results?.[n]??[]).filter(r=>r.ok).map(r=>`${r.executor}:${r.verdict}${r.superseded?' (replaced)':''}`).join(', ');
  rounds.push({round:n,owner:optional(`dispatch-${n}.json`)?.executor??(n===state.iteration?state.owner:null),
   verdict:lead?.decision??review?.verdict??(n===state.iteration?'pass':null),reviewed_by:panel||review?.reviewed_by||null});
 }
 const last=optional(`raw-result-${state.iteration}.json`);
 for(const x of last?.risks??[])if(typeof x==='string'&&x.trim())risks.push(x.trim());
 return {...taskChangeEvidence(dir,state,current),rounds,risks};
}
