import fs from 'node:fs';
import path from 'node:path';
import {isMain} from './platform.mjs';
import {read,atomic} from './artifact.mjs';

// 목표 지표: 성공 작업당 Opus(리드) 토큰. 일꾼 비용·시간은 별도 가드레일로만 본다.
export function measure(root,observations=null) {
 const s=read(path.join(root,'.fusion/state.json'));
 const usage=[];for(let n=1;n<=s.iteration;n++){const f=path.join(root,'.fusion/tasks',s.task_id,`usage-${n}.json`);if(fs.existsSync(f))usage.push(read(f));}
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
  task_kind:s.routing?.task_kind??null,difficulty:s.routing?.difficulty??null,routing_mode:s.routing?.mode??null,routed_executor:s.routing?.executor??null,final_owner:s.owner??null,
  // router 학습용. 어떤 일꾼이 어떤 판정을 받았는지.
  review_outcomes:(s.reviews??[]).map(r=>({owner:r.owner,verdict:r.verdict,round:r.round,reviewed_by:r.reviewed_by??'lead',...(r.overrode?{overrode:r.overrode}:{})})),
  // 리드가 직접 본 리뷰 대 위임 리뷰. 위임 비율이 오르면 Opus 토큰이 줄어야 한다.
  delegated_reviews:(s.reviews??[]).filter(r=>r.reviewed_by&&r.reviewed_by!=='lead').length,lead_overrides:(s.reviews??[]).filter(r=>r.overrode).length,
  consults:(s.consults??[]).map(c=>({id:c.id,mode:c.mode,violated:c.violated,members:c.members.map(m=>({executor:m.executor,ok:m.ok,recommended_verdict:m.recommended_verdict??null}))})),consult_runs:s.consult_runs??0,
  worker_usage:usage,worker_rounds:Object.fromEntries(['grok','antigravity','sonnet'].map(e=>[e,byExecutor(e).length])),
  worker_cost_estimate_usd:usage.length&&usage.every(u=>known(u.total_cost_usd))?usage.reduce((a,u)=>a+u.total_cost_usd,0):null,
  review_rounds:s.reviews.length,delegation_count:s.iteration,escalation_count:s.escalations.length,lead_takeovers:s.attempts?.lead??0,
  wall_ms:s.closed_at?Date.parse(s.closed_at)-Date.parse(s.started_at):null,
  measurement_note:'Unknown usage stays null. Antigravity reports no cost, so mixed tasks have null worker cost. Failed tasks count in the numerator. Run this at CLOSE and BLOCKED so the router learns.'};
 atomic(path.join(root,'.fusion/metrics',s.task_id+'.json'),v);return v;
}
export function aggregate(records) {
 const successes=records.filter(r=>r.success).length;
 const covered=records.length>0&&records.every(r=>r.lead_usage!==null);
 return {tasks:records.length,successful_tasks:successes,success_rate:records.length?successes/records.length:null,
  lead_tokens_per_success:covered&&successes?records.reduce((n,r)=>n+r.lead_usage.lead_tokens,0)/successes:null,
  lead_takeover_rate:records.length?records.filter(r=>r.lead_takeovers>0).length/records.length:null,
  usage_coverage:records.length?records.filter(r=>r.lead_usage!==null).length/records.length:0};
}
if(isMain(import.meta.url)) {
 try {
  const [root,observations]=process.argv.slice(2);if(!root)throw Error('Usage: metrics.mjs REPO_ROOT [TASK_USAGE.json] | --aggregate METRICS.json ...');
  console.log(JSON.stringify(root==='--aggregate'?aggregate(process.argv.slice(3).map(read)):measure(root,observations?read(observations):null),null,2));
 }catch(e){console.error(e.message);process.exitCode=1;}
}
