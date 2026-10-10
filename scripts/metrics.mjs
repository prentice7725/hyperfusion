import {readInput,printError} from './cli.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {isMain} from './platform.mjs';
import {read,atomic,snapshot,changes,git,SAFE_DIFF} from './artifact.mjs';
import {EXECUTORS} from './executor-config.mjs';
import {controlPath} from './control-dir.mjs';
import {collectRunUsage,summarizeUsage,knownNumber} from './usage-accounting.mjs';

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

 // Include implementation, review, consult and separately observed host usage.
export function measure(root,observations=null) {
 const s=read(controlPath(root,'state.json'));
 const usage=[];for(let n=1;n<=s.iteration;n++){const f=controlPath(root,'tasks',s.task_id,`usage-${n}.json`);if(fs.existsSync(f))usage.push(read(f));}
 const known=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
 // 호스트가 집계한 작업 전체 리드 사용량만 받는다. 가격을 추정하지 않는다.
 let lead=null;
 const metricFile=controlPath(root,'metrics',s.task_id+'.json');
 const prior=fs.existsSync(metricFile)?read(metricFile):null;
 let hostModel=prior?.lead_observed_model??s.lead_model??null;
 if(prior?.lead_usage)lead=prior.lead_usage;
 if(observations){
  if(!observations.source||!known(observations.lead_tokens))throw Error('Metrics require source and nonnegative task-total lead_tokens');
  lead={source:observations.source,lead_tokens:observations.lead_tokens};
  if(observations.lead_model!==undefined){
   if(typeof observations.lead_model!=='string'||!observations.lead_model.trim())throw Error('Metrics lead_model must name the observed host model');
   hostModel=observations.lead_model;
  }
 }
 const runs=collectRunUsage(root,s),accounting=summarizeUsage(runs,lead,hostModel);
 const countedImplementers=[...EXECUTORS,...(runs.some(r=>r.executor==='sol'&&r.role==='implement')?['sol']:[])];
 const v={task_id:s.task_id,success:s.phase==='CLOSE',initial_executor:s.initial_executor??null,attempts:s.attempts??null,
  objective:'minimize total Claude (Opus + Sonnet + Haiku) tokens per successful task',
  lead_target_model:s.lead_target_model??null,lead_model:s.lead_model??null,
  lead_usage:lead,lead_tokens_per_success:s.phase==='CLOSE'&&lead?lead.lead_tokens:null,
  lead_observed_model:hostModel,run_usage:runs,usage_by_executor:accounting.by_executor,usage_by_model:accounting.by_model,
  claude_usage:accounting.claude,claude_total_tokens:accounting.claude_total_tokens,claude_tokens_per_success:s.phase==='CLOSE'?accounting.claude_total_tokens:null,
  unreported_calls:accounting.unreported_calls,review_calls:runs.filter(r=>r.role==='review').length,consult_calls:runs.filter(r=>r.role==='consult').length,
  retry_rounds:Math.max(0,s.iteration-1),mandatory_review_gaps:s.configuration?.review?.strategy==='lead-gated-adaptive'?Array.from({length:s.iteration},(_,i)=>i+1).filter(n=>{
   const planFile=controlPath(root,'tasks',s.task_id,`review-plan-${n}.json`);
   if(!fs.existsSync(planFile))return !(s.lead_decision?.round===n&&s.lead_decision?.diff_reviewed);
   const plan=read(planFile),results=s.review_results?.[n]??[];
   // 자리로 센다. 바꿔 낀 리뷰어나 리드가 직접 채운 자리는 공백이 아니다.
   const filled=s.lead_decision?.round===n?(s.lead_decision.lead_filled_seats?.length??0):0;
   return results.filter(r=>r.ok&&r.executor!==plan.owner).length+filled<plan.reviewers.filter(e=>e!=='lead').length;
  }):[],
  task_kind:s.routing?.task_kind??null,difficulty:s.routing?.difficulty??null,diff_lines:diffLines(root,s),routing_mode:s.routing?.mode??null,routed_executor:s.routing?.executor??null,final_owner:s.owner??null,
  // router 학습용. 어떤 일꾼이 어떤 판정을 받았는지.
  review_outcomes:(s.reviews??[]).map(r=>({owner:r.owner,verdict:r.verdict,round:r.round,reviewed_by:r.reviewed_by??'lead',...(r.overrode?{overrode:r.overrode}:{})})),
  // 리드가 직접 본 리뷰 대 위임 리뷰. 위임 비율이 오르면 Opus 토큰이 줄어야 한다.
  delegated_reviews:(s.reviews??[]).filter(r=>r.reviewed_by&&!['lead','controller'].includes(r.reviewed_by)).length,acceptance_returns:(s.reviews??[]).filter(r=>r.reviewed_by==='controller').length,lead_overrides:(s.reviews??[]).filter(r=>r.overrode).length,
  consults:(s.consults??[]).map(c=>({id:c.id,mode:c.mode,violated:c.violated,members:c.members.map(m=>({executor:m.executor,ok:m.ok,recommended_verdict:m.recommended_verdict??null}))})),consult_runs:s.consult_runs??0,
  worker_usage:usage,worker_rounds:Object.fromEntries(countedImplementers.map(e=>[e,runs.filter(r=>r.executor===e&&r.role==='implement').length])),
  worker_cost_estimate_usd:runs.length&&runs.every(r=>known(r.cost_usd))?runs.reduce((a,r)=>a+r.cost_usd,0):null,
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
  claude_tokens_per_success:successes&&records.every(r=>knownNumber(r.claude_total_tokens))?records.reduce((n,r)=>n+r.claude_total_tokens,0)/successes:null,
  claude_usage_per_success:Object.fromEntries(['opus','sonnet','haiku'].map(model=>[model,successes&&records.every(r=>knownNumber(r.claude_usage?.[model]))?records.reduce((n,r)=>n+r.claude_usage[model],0)/successes:null])),
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
