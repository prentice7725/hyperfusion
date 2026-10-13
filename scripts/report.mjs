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

 // 리드가 얼마나 직접 개입했는지. 새 기록을 만들지 않고 이미 남은 산출물에서 센다.
 // decisions_by_lead는 리드가 명령으로 낸 판정, decisions_by_policy는 재량권 아래 컨트롤러가 승인한 판정이다.
 // reviews_recorded는 classic 리뷰 기록(lead-decision 파일이 없는 경로), lead_packets는 리드가 직접 읽어야 했던 게이트의 수, recoveries_*는 막힌 라운드를 되돌린 횟수다.
 const names=fs.readdirSync(dir);
 const decisions=names.filter(f=>/^lead-decision-\d+\.json$/.test(f)).map(f=>optional(f));
 const recoveries=names.filter(f=>/^recovery-\d+\.json$/.test(f)).map(f=>optional(f));
 const auto=recoveries.filter(r=>String(r?.reason??'').startsWith('auto-recover')).length;
 const delegation=optional('delegation.json');
 const lead_load={delegation:delegation?{policy:delegation.policy,reason:delegation.reason}:null,
  decisions_by_lead:decisions.filter(d=>d?.authority?.source!=='delegated-policy').length,
  decisions_by_policy:decisions.filter(d=>d?.authority?.source==='delegated-policy').length,
  reviews_recorded:names.filter(f=>/^review-\d+\.json$/.test(f)).length,
  lead_packets:names.filter(f=>/^lead-packet-\d+/.test(f)).length,
  recoveries_auto:auto,recoveries_manual:recoveries.length-auto};
 const metric=controlPath(root,'metrics',taskId+'.json');
 const m=fs.existsSync(metric)?read(metric):null;
 const metrics=m?{success:m.success,wall_ms:m.wall_ms,worker_cost_estimate_usd:m.worker_cost_estimate_usd,
  lead_tokens_per_success:m.lead_tokens_per_success,delegation_count:m.delegation_count}:null;
 if(metrics){metrics.claude_tokens_per_success=m.claude_tokens_per_success??null;metrics.claude_usage=m.claude_usage??null;metrics.review_calls=m.review_calls??null;metrics.unreported_calls=m.unreported_calls??null;}
 const draft=path.join(dir,'pr-draft.md');
 const verification=optional('verification.json');
 return {task_id:taskId,rounds,lead_load,metrics,ac_table:verification?.ac_table??null,
  changed_files:verification?.changed_files??null,unattributed_changes:verification?.unattributed_changes??null,
  pr_draft:fs.existsSync(draft)?draft:null};
}
