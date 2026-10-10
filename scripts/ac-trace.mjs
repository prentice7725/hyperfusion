// AC 추적표와 PR 설명 초안. 모델 호출은 하지 않고, 컨트롤러가 남긴 기록만 읽는다.
// 브리프의 acceptance_map은 {"AC1":["npm test -- a"]}처럼 수용 기준 ID와 그 기준을 증명하는 수용 명령을 잇는다.
// 판정은 컨트롤러가 실행한 결과로만 정한다. 일꾼이나 리뷰어의 말로 PASS가 되지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import {read} from './artifact.mjs';

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
export function prDraft({state,brief,table,changed,rounds,risks}) {
 const lines=[];
 const title=brief.objective.split(/\r?\n/)[0].trim().slice(0,72);
 lines.push(`# ${title}`,'');
 lines.push('## 변경 내용','');
 if(brief.objective.trim()!==title)lines.push(brief.objective.trim(),'');
 if(changed.length)lines.push(...changed.map(f=>`- \`${f}\``),'');
 lines.push('## 수용 기준','','| AC | 기준 | 판정 | 증명 명령 |','|---|---|---|---|',
  ...table.map(r=>`| ${r.id} | ${cell(r.criterion)} | ${r.status} | ${r.commands.map(x=>'`'+cell(x)+'`').join('<br>')||'-'} |`),'');
 const plain=brief.success_criteria.filter(t=>!criterionIds([t]).length);
 if(plain.length)lines.push('ID 없는 기준(리뷰로 확인):','',...plain.map(t=>`- ${t}`),'');
 lines.push('## 진행','','| 라운드 | 작업자 | 판정 | 리뷰 |','|---|---|---|---|',
  ...rounds.map(r=>`| ${r.round} | ${r.owner??'-'} | ${r.verdict??'-'} | ${cell(r.reviewed_by??'-')} |`),'');
 if(risks.length)lines.push('## 남은 위험','',...risks.map(x=>`- ${x}`),'');
 lines.push('---',`HyperFusion task \`${state.task_id}\` · base \`${String(state.base_commit??'').slice(0,12)}\` · 커밋과 푸시는 하지 않았다.`,'');
 return lines.join('\n');
}

// 라운드 기록에서 초안 재료를 모은다.
export function draftInputs(dir,state) {
 const optional=name=>{const f=path.join(dir,name);return fs.existsSync(f)?read(f):null;};
 const changed=new Set(),risks=[],rounds=[];
 for(let n=1;n<=state.iteration;n++){
  for(const f of optional(`validation-${n}.json`)?.changed??[])changed.add(f);
  const review=state.reviews.filter(r=>r.round===n).at(-1);
  const lead=optional(`lead-decision-${n}.json`);
  const panel=(state.review_results?.[n]??[]).filter(r=>r.ok).map(r=>`${r.executor}:${r.verdict}`).join(', ');
  rounds.push({round:n,owner:optional(`dispatch-${n}.json`)?.executor??(n===state.iteration?state.owner:null),
   verdict:lead?.decision??review?.verdict??(n===state.iteration?'pass':null),reviewed_by:panel||review?.reviewed_by||null});
 }
 const last=optional(`raw-result-${state.iteration}.json`);
 for(const x of last?.risks??[])if(typeof x==='string'&&x.trim())risks.push(x.trim());
 return {changed:[...changed].sort(),rounds,risks};
}
