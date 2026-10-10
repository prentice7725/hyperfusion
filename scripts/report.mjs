import fs from 'node:fs';
import path from 'node:path';
import {read} from './artifact.mjs';
import {controlPath} from './control-dir.mjs';

export function report(root,taskId) {
 if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(taskId))throw Error('Invalid task_id');
 const dir=controlPath(root,'tasks',taskId);
 const optional=name=>{const f=path.join(dir,name);return fs.existsSync(f)?read(f):null;};
 if(!fs.existsSync(dir))throw Error('Task not found: '+taskId);
 const rounds=fs.readdirSync(dir).filter(f=>/^brief-\d+\.json$/.test(f)).map(f=>Number(f.match(/\d+/)[0])).sort((a,b)=>a-b).map(round=>{
  const dispatch=optional(`dispatch-${round}.json`),envelope=optional(`envelope-${round}.json`),launch=optional(`launch-${round}.json`);
  const usage=optional(`usage-${round}.json`),review=optional(`review-${round}.json`),lead=optional(`lead-decision-${round}.json`),result=optional(`raw-result-${round}.json`)??optional(`result-${round}.json`);
  return {round,owner:dispatch?.executor??(dispatch?.transport==='lead-takeover'?'lead':null),
   result:result?.status??null,verdict:review?.verdict??lead?.decision??null,blocking_criteria:review?.blocking_criteria??[],
   started_at:envelope?.started_at??launch?.at??null,wall_ms:envelope?.wall_ms??null,
   cost_usd:usage?.total_cost_usd??null,error:envelope?.reason??null};
 });
 const metric=controlPath(root,'metrics',taskId+'.json');
 const m=fs.existsSync(metric)?read(metric):null;
 const metrics=m?{success:m.success,wall_ms:m.wall_ms,worker_cost_estimate_usd:m.worker_cost_estimate_usd,
  lead_tokens_per_success:m.lead_tokens_per_success,delegation_count:m.delegation_count}:null;
 if(metrics){metrics.claude_tokens_per_success=m.claude_tokens_per_success??null;metrics.claude_usage=m.claude_usage??null;metrics.review_calls=m.review_calls??null;metrics.unreported_calls=m.unreported_calls??null;}
 return {task_id:taskId,rounds,metrics};
}
