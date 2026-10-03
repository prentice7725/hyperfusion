import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {read,atomic} from './artifact.mjs';
export function measure(root,observations=null) {
 const s=read(path.join(root,'.fusion/state.json'));
 const usage=[];for(let n=1;n<=s.iteration;n++){const f=path.join(root,'.fusion/tasks',s.task_id,`claude-usage-${n}.json`);if(fs.existsSync(f))usage.push(read(f));}
 const known=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
 // Task-total deltas from host accounting, including retries and takeover; not guessed prices.
 let codex=null;
 if(observations){
  if(!observations.source||!['lead_tokens','luna_tokens'].every(k=>known(observations[k])))throw Error('Metrics require source and nonnegative task-total lead_tokens/luna_tokens');
  codex={...observations,total_tokens:observations.lead_tokens+observations.luna_tokens};
 }
 const v={task_id:s.task_id,success:s.phase==='CLOSE',initial_executor:s.initial_executor??null,attempts:s.attempts??null,
  objective:'minimize total Codex (lead + Luna) usage per successful task across the evaluation cohort',
  lead_target_model:s.lead_target_model??null,lead_target_reasoning_effort:s.lead_target_reasoning_effort??null,lead_model:s.lead_model??null,
  codex_usage:codex,lead_tokens_per_success:s.phase==='CLOSE'&&codex?codex.lead_tokens:null,astra_tokens_per_success:s.phase==='CLOSE'&&codex?codex.lead_tokens:null,codex_tokens_per_success:s.phase==='CLOSE'&&codex?codex.total_tokens:null,
  external_usage:usage,external_cost_estimate_usd:usage.length&&usage.every(u=>known(u.total_cost_usd))?usage.reduce((a,u)=>a+u.total_cost_usd,0):null,
  review_rounds:s.reviews.length,delegation_count:s.iteration,escalation_count:s.escalations.length,
  wall_ms:s.closed_at?Date.parse(s.closed_at)-Date.parse(s.started_at):null,
  measurement_note:'Unknown usage stays null. Cohort denominator is successful tasks; numerator includes failed tasks too. External spend and wall time are separate guardrails.'};
 atomic(path.join(root,'.fusion/metrics',s.task_id+'.json'),v);return v;
}
export function aggregate(records) {
 const successes=records.filter(r=>r.success).length;
 const covered=records.length>0&&records.every(r=>r.codex_usage!==null);
 return {tasks:records.length,successful_tasks:successes,success_rate:records.length?successes/records.length:null,
  codex_tokens_per_success:covered&&successes?records.reduce((n,r)=>n+r.codex_usage.total_tokens,0)/successes:null,
  lead_tokens_per_success:covered&&successes?records.reduce((n,r)=>n+r.codex_usage.lead_tokens,0)/successes:null,
  astra_tokens_per_success:covered&&successes?records.reduce((n,r)=>n+r.codex_usage.lead_tokens,0)/successes:null,
  usage_coverage:records.length?records.filter(r=>r.codex_usage!==null).length/records.length:0};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])) {
 try {
  const [root,observations]=process.argv.slice(2);if(!root)throw Error('Usage: metrics.mjs REPO_ROOT [TASK_USAGE.json] | --aggregate METRICS.json ...');
  console.log(JSON.stringify(root==='--aggregate'?aggregate(process.argv.slice(3).map(read)):measure(root,observations?read(observations):null),null,2));
 }catch(e){console.error(e.message);process.exitCode=1;}
}
