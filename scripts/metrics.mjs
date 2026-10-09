import {readInput,printError} from './cli.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {isMain} from './platform.mjs';
import {read,atomic,snapshot,changes,git,SAFE_DIFF} from './artifact.mjs';
import {EXECUTORS} from './executor-config.mjs';
import {controlPath} from './control-dir.mjs';

// 작업이 바꾼 줄 수(대략). 작업 시작 커밋과 지금 트리를 비교하고, 새 파일은 줄 수를 센다.
// "작은 작업은 리드가 직접 고치는 게 싸지 않나"를 데이터로 판단하려고 남긴다. 작업 전부터 있던 변경도 섞일 수 있다.
function diffLines(root,s) {
 try{
  const baseline=read(controlPath(root,'tasks',s.task_id,'baseline.json'));
  const files=changes(baseline,snapshot(root)).filter(f=>!f.startsWith('.git/'));
  if(!files.length)return 0;
  let lines=0;const seen=new Set();
  for(const row of git(root,['diff','--numstat',...SAFE_DIFF,s.base_commit,'--',...files]).split('\n').filter(Boolean)){
   const [added,removed,file]=row.split('\t');seen.add(file);lines+=(Number(added)||0)+(Number(removed)||0);
  }
  for(const f of files)if(!seen.has(f)){try{lines+=fs.readFileSync(path.join(root,f),'utf8').split('\n').length;}catch{}}
  return lines;
 }catch{return null;}
}

// 목표 지표: 성공 작업당 Opus(리드) 토큰. 일꾼 비용·시간은 별도 가드레일로만 본다.
export function measure(root,observations=null) {
 const s=read(controlPath(root,'state.json'));
 const usage=[];for(let n=1;n<=s.iteration;n++){const f=controlPath(root,'tasks',s.task_id,`usage-${n}.json`);if(fs.existsSync(f))usage.push(read(f));}
 const known=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
 // 호스트가 집계한 작업 전체 리드 사용량만 받는다. 가격을 추정하지 않는다.
 let lead=null;
 if(observations){
  if(!observations.source||!known(observations.lead_tokens))throw Error('Metrics require source and nonnegative task-total lead_tokens');
  lead={source:observations.source,lead_tokens:observations.lead_tokens};
 }
 const byExecutor=e=>usage.filter(u=>u.executor===e);
 const v={task_id:s.task_id,success:s.phase==='CLOSE',initial_executor:s.initial_executor??null,attempts:s.attempts??null,
  objective:'minimize Opus lead tokens per successful task; workers do the heavy lifting',
  lead_target_model:s.lead_target_model??null,lead_model:s.lead_model??null,
  lead_usage:lead,lead_tokens_per_success:s.phase==='CLOSE'&&lead?lead.lead_tokens:null,
  task_kind:s.routing?.task_kind??null,difficulty:s.routing?.difficulty??null,diff_lines:diffLines(root,s),routing_mode:s.routing?.mode??null,routed_executor:s.routing?.executor??null,final_owner:s.owner??null,
  // router 학습용. 어떤 일꾼이 어떤 판정을 받았는지.
  review_outcomes:(s.reviews??[]).map(r=>({owner:r.owner,verdict:r.verdict,round:r.round,reviewed_by:r.reviewed_by??'lead',...(r.overrode?{overrode:r.overrode}:{})})),
  // 리드가 직접 본 리뷰 대 위임 리뷰. 위임 비율이 오르면 Opus 토큰이 줄어야 한다.
  delegated_reviews:(s.reviews??[]).filter(r=>r.reviewed_by&&!['lead','controller'].includes(r.reviewed_by)).length,acceptance_returns:(s.reviews??[]).filter(r=>r.reviewed_by==='controller').length,lead_overrides:(s.reviews??[]).filter(r=>r.overrode).length,
  consults:(s.consults??[]).map(c=>({id:c.id,mode:c.mode,violated:c.violated,members:c.members.map(m=>({executor:m.executor,ok:m.ok,recommended_verdict:m.recommended_verdict??null}))})),consult_runs:s.consult_runs??0,
  worker_usage:usage,worker_rounds:Object.fromEntries(EXECUTORS.map(e=>[e,byExecutor(e).length])),
  worker_cost_estimate_usd:usage.length&&usage.every(u=>known(u.total_cost_usd))?usage.reduce((a,u)=>a+u.total_cost_usd,0):null,
  review_rounds:s.reviews.length,delegation_count:s.iteration,escalation_count:s.escalations.length,lead_takeovers:s.attempts?.lead??0,
  started_at:s.started_at,ended_at:s.ended_at??s.closed_at??null,
  wall_ms:s.ended_at||s.closed_at?Date.parse(s.ended_at??s.closed_at)-Date.parse(s.started_at):null,
  measurement_note:'Unknown usage stays null. Antigravity reports no cost, so mixed tasks have null worker cost. Failed tasks count in the numerator. Run this at CLOSE and BLOCKED so the router learns.'};
 atomic(controlPath(root,'metrics',s.task_id+'.json'),v);return v;
}
function summarize(records) {
 const successes=records.filter(r=>r.success).length;
 const covered=records.length>0&&records.every(r=>r.lead_usage!==null);
 const sizes=records.map(r=>r.diff_lines).filter(n=>typeof n==='number').sort((a,b)=>a-b);
 return {tasks:records.length,successful_tasks:successes,success_rate:records.length?successes/records.length:null,
  lead_tokens_per_success:covered&&successes?records.reduce((n,r)=>n+r.lead_usage.lead_tokens,0)/successes:null,
  lead_takeover_rate:records.length?records.filter(r=>r.lead_takeovers>0).length/records.length:null,
  usage_coverage:records.length?records.filter(r=>r.lead_usage!==null).length/records.length:0,
  median_diff_lines:sizes.length?sizes[Math.floor(sizes.length/2)]:null};
}
// 난이도별로도 나눈다. low 작업의 성공당 리드 토큰이 "리드가 직접 고칠 때"보다 크게 나오면,
// 작은 diff에 한해 리드 직접 수정을 허용하는 예외를 데이터로 정할 수 있다(지금은 허용하지 않는다).
export function aggregate(records) {
 const groups=['low','medium','high',null].map(d=>[d??'unset',records.filter(r=>(r.difficulty??null)===d)]).filter(([,list])=>list.length);
 return {...summarize(records),by_difficulty:Object.fromEntries(groups.map(([d,list])=>[d,summarize(list)]))};
}
export function aggregateRepo(root) {
 const dir=controlPath(root,'metrics');
 return aggregate(fs.existsSync(dir)?fs.readdirSync(dir).filter(f=>f.endsWith('.json')).map(f=>read(path.join(dir,f))):[]);
}
if(isMain(import.meta.url)) {
 try {
  const [root,observations]=process.argv.slice(2);if(!root)throw Error('Usage: metrics.mjs REPO_ROOT [TASK_USAGE.json] | --aggregate METRICS.json ...');
  const inputs=process.argv.slice(3);
  const aggregated=root==='--aggregate'&&inputs.length===1&&fs.statSync(inputs[0]).isDirectory()?aggregateRepo(inputs[0]):root==='--aggregate'?aggregate(inputs.map(read)):measure(root,observations?readInput(observations):null);
  console.log(JSON.stringify(aggregated,null,2));
 }catch(e){printError(e);}
}
