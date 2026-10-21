import fs from 'node:fs';
import path from 'node:path';
import {controlPath} from './control-dir.mjs';

const known=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
const stamp=s=>typeof s==='string'?Date.parse(s):NaN;
const sum=rows=>rows.every(known)?rows.reduce((a,b)=>a+b,0):null;

// Sum the union, not the seats: parallel reviewers share wall time.
function union(intervals) {
 if(intervals.some(([a,b])=>!Number.isFinite(a)||!Number.isFinite(b)||b<a))return null;
 const sorted=intervals.slice().sort((a,b)=>a[0]-b[0]);let total=0,end=-Infinity;
 for(const [a,b] of sorted){total+=Math.max(0,b-Math.max(a,end));end=Math.max(end,b);}
 return total;
}

export function summarizeAutomation(runs,journals=[],decisions=[]) {
 const groups=new Map();
 for(const r of runs.filter(r=>r.transport_observed===true)){
  const key=JSON.stringify([r.role??null,r.executor??null,r.model_family??r.model??null,r.reasoning_effort??null]);
  const row=groups.get(key)??{role:r.role??null,executor:r.executor??null,model_family:r.model_family??r.model??null,reasoning_effort:r.reasoning_effort??null,transport_attempts:0};
  row.transport_attempts++;groups.set(key,row);
 }
 const reviews=runs.filter(r=>r.role==='review');
 const deep=reviews.filter(r=>r.executor==='grok'&&r.reasoning_effort==='xhigh');
 const stops=Object.create(null),phase_ms=Object.create(null),windows=[];
 let phaseComplete=true,validJournals=0,invalidJournals=0,eligible=false,checked=false;
 for(const j of journals){
  if(!j||!Array.isArray(j.events)){invalidJournals++;phaseComplete=false;continue;}
  validJournals++;
  const d=j.gate_diagnostic??j.error?.diagnostic;
  const reasonCodes=Array.isArray(d?.reason_codes)?d.reason_codes:[];
  if(typeof d?.eligible==='boolean'&&!reasonCodes.some(code=>['DIAGNOSTIC_ERROR','LEGACY_STATE'].includes(code))){checked=true;eligible ||= d.eligible;}
  const codes=reasonCodes.length?reasonCodes:[j.error?.code??j.reason];
  if(j.finished_at&&!['CLOSE','ARCHIVED'].includes(j.reason))for(const code of new Set(codes.filter(c=>typeof c==='string'&&c.length)))stops[code]=(stops[code]??0)+1;
  let at=stamp(j.started_at),phase=j.initial_phase;
  const end=stamp(j.finished_at),parts=Object.create(null);let valid=typeof phase==='string'&&Number.isFinite(at)&&Number.isFinite(end);
  for(const event of j.events){
   if(!event||typeof event!=='object'){valid=false;continue;}
   const next=stamp(event.at);
   if(!Number.isFinite(next)||next<at||next>end||typeof event.phase!=='string')valid=false;
   if(valid)parts[phase]=(parts[phase]??0)+next-at;
   at=next;phase=event.phase;
  }
  if(!valid||end<at){phaseComplete=false;continue;}
  parts[phase]=(parts[phase]??0)+end-at;
  windows.push([stamp(j.started_at),end]);
  for(const [key,ms] of Object.entries(parts))phase_ms[key]=(phase_ms[key]??0)+ms;
 }
 const approvals=decisions.filter(d=>d?.authority?.source==='delegated-policy'&&d.decision==='APPROVE').length;
 if(approvals){checked=true;eligible=true;}
 const phaseSum=Object.values(phase_ms).reduce((a,b)=>a+b,0);
 if(union(windows)!==phaseSum)phaseComplete=false;
 return {revision:1,eligibility_observed:checked?eligible:null,policy_approvals:approvals,
  lead_decisions:decisions.filter(d=>d&&d.authority?.source!=='delegated-policy').length,
  stop_events_by_reason:{...stops},journals:{valid:validJournals,invalid:invalidJournals},
  transport_attempts:runs.filter(r=>r.transport_observed===true).length,
  transport_by_role_model_effort:[...groups.values()],
  review_seat_ms:sum(reviews.map(r=>r.wall_ms)),
  grok_xhigh_review_seat_ms:sum(deep.map(r=>r.wall_ms)),
  review_wait_ms:union(reviews.map(r=>[stamp(r.started_at),known(r.wall_ms)?stamp(r.started_at)+r.wall_ms:NaN])),
  autopilot_phase_ms:validJournals&&phaseComplete?{...phase_ms}:null,
  phase_timing_complete:validJournals>0&&phaseComplete,
  host_model_invocations:null,
  basis:'Launch markers count transport attempts, not host/provider model invocations. Review seat time includes failed transports and supervision; review wait is the union of observed review intervals. Phase time covers complete nonoverlapping autopilot journal windows only; manual lead wait outside these windows is unknown.'};
}

export function collectAutomation(root,state,runs) {
 const dir=controlPath(root,'tasks',state.task_id);
 const names=fs.existsSync(dir)?fs.readdirSync(dir):[];
 const load=name=>{try{return JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));}catch{return null;}};
 const journals=names.filter(f=>/^autopilot-.+\.json$/.test(f)).sort().map(load);
 const decisions=names.filter(f=>/^lead-decision-\d+\.json$/.test(f)).map(load);
 return summarizeAutomation(runs,journals,decisions);
}

export function aggregateAutomation(records) {
 const rows=records.map(r=>r.automation),observed=rows.filter(r=>r?.revision===1);
 const stops=Object.create(null),groups=new Map();
 for(const row of observed)for(const code of Object.keys(row.stop_events_by_reason??{}))stops[code]=(stops[code]??0)+1;
 for(const row of observed)for(const group of row.transport_by_role_model_effort??[]){
  const key=JSON.stringify([group.role,group.executor,group.model_family,group.reasoning_effort]);
  const prior=groups.get(key)??{...group,transport_attempts:0};
  prior.transport_attempts+=group.transport_attempts;groups.set(key,prior);
 }
 const total=field=>observed.length===records.length&&records.length?sum(observed.map(r=>r[field])):null;
 return {observed_tasks:observed.length,eligibility_checked_tasks:observed.filter(r=>typeof r.eligibility_observed==='boolean').length,
  eligible_tasks:observed.filter(r=>r.eligibility_observed===true).length,
  actually_automated_tasks:observed.filter(r=>r.policy_approvals>0).length,
  stopped_tasks_by_reason:{...stops},transport_attempts:total('transport_attempts'),transport_by_role_model_effort:[...groups.values()],
  review_seat_ms:total('review_seat_ms'),review_wait_ms:total('review_wait_ms'),grok_xhigh_review_seat_ms:total('grok_xhigh_review_seat_ms'),
  host_model_invocations:null};
}
