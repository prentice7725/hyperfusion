// Summary and time breakdown for benchmark trials made with tools/benchmark-trial.mjs (or by hand with the same layout).
// Reads only: the <name>.prepare.json files under the given folders, their control folders and metric records.
//
//   node tools/benchmark-report.mjs ../hf-bench/rep4            # one row per trial plus a total
//   node tools/benchmark-report.mjs ../hf-bench/rep4 --rounds   # also every worker and reviewer run
//   node tools/benchmark-report.mjs ../hf-bench/rep4 --json
//
// Time buckets add up to the window (start to controller CLOSE/BLOCKED):
//   implement  worker rounds (envelope-N.json)
//   review     delegated reviews and consults (envelope-consult-*.json)
//   acceptance controller acceptance and static runs outside those (duration_ms; records before 2026-11-28 lack it)
//   other      everything else: the lead thinking and reading, controller steps, waits
import fs from 'node:fs';
import path from 'node:path';
import {isMain} from '../scripts/platform.mjs';

const readJson=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}};

export function findTrials(dirs) {
 const out=[];
 const walk=dir=>{
  let entries=[];try{entries=fs.readdirSync(dir,{withFileTypes:true});}catch{return;}
  for(const e of entries){
   const p=path.join(dir,e.name);
   // Trial repositories hold a whole HyperFusion tree; their prepare file sits beside them, so do not descend into them.
   if(e.isDirectory()&&!fs.existsSync(p+'.prepare.json')&&e.name!=='node_modules'&&e.name!=='.git')walk(p);
   else if(e.isFile()&&e.name.endsWith('.prepare.json'))out.push(p);
  }
 };
 for(const d of dirs)walk(path.resolve(d));
 return out.sort();
}

// Merge [start,end] intervals and return the covered milliseconds inside [from,to].
const covered=(spans,from,to)=>{
 const sorted=spans.map(([a,b])=>[Math.max(a,from),Math.min(b,to)]).filter(([a,b])=>b>a).sort((x,y)=>x[0]-y[0]);
 let total=0,cur=null;
 for(const s of sorted){if(cur&&s[0]<=cur[1])cur[1]=Math.max(cur[1],s[1]);else{if(cur)total+=cur[1]-cur[0];cur=[...s];}}
 return cur?total+cur[1]-cur[0]:total;
};

export function trialReport(prepareFile) {
 const prepared=readJson(prepareFile);
 if(!prepared?.brief_file)return {file:prepareFile,status:'unreadable'};
 const control=path.dirname(prepared.brief_file);
 const caseId=readJson(prepared.brief_file)?.task_id??prepared.case_id;
 const metric=readJson(path.join(control,'metrics',caseId+'.json'));
 const base={file:prepareFile,case_id:caseId,control};
 if(!metric)return {...base,status:'no_metric',phase:readJson(path.join(control,'state.json'))?.phase??null};
 const dir=path.join(control,'tasks',caseId);
 const files=fs.existsSync(dir)?fs.readdirSync(dir):[];
 const t0=Date.parse(metric.started_at),t1=Date.parse(metric.controller_ended_at??metric.ended_at);
 const runs=[];
 for(const f of files.filter(f=>/^envelope-.+\.json$/.test(f))){
  const e=readJson(path.join(dir,f));if(!e?.started_at||!e?.ended_at)continue;
  const tag=f.slice('envelope-'.length,-'.json'.length);
  const stall=readJson(path.join(dir,`stall-${tag}.json`));
  runs.push({tag,kind:/^\d+$/.test(tag)?'implement':'review',executor:e.executor??null,start:Date.parse(e.started_at),end:Date.parse(e.ended_at),
   ms:e.wall_ms??Date.parse(e.ended_at)-Date.parse(e.started_at),
   // stall-watch.mjs: would_stop is set when a quiet gap reached stall_ms (the run would have been stopped); max_gap_ms is the longest quiet gap.
   stall:stall?Boolean(stall.would_stop):null,max_gap_ms:stall?.max_gap_ms??null});
 }
 runs.sort((a,b)=>a.start-b.start);
 const acceptance=[];let acceptanceUnknown=0;
 for(const f of files.filter(f=>/^(?:acceptance|static)-\d+-.+\.json$/.test(f)&&!f.endsWith('-ignored.json'))){
  const r=readJson(path.join(dir,f));if(!r?.results)continue;
  if(Number.isFinite(r.duration_ms)&&r.at){const start=Date.parse(r.at);acceptance.push([start,start+r.duration_ms]);}else acceptanceUnknown++;
 }
 const window=t1-t0;
 const implementMs=covered(runs.filter(r=>r.kind==='implement').map(r=>[r.start,r.end]),t0,t1);
 const reviewMs=covered(runs.filter(r=>r.kind==='review').map(r=>[r.start,r.end]),t0,t1);
 const workerMs=covered(runs.map(r=>[r.start,r.end]),t0,t1);
 const acceptanceMs=covered([...runs.map(r=>[r.start,r.end]),...acceptance],t0,t1)-workerMs;
 const ie=metric.lead_weighted_usage?.input_equivalent??null;
 return {...base,status:'recorded',arm:metric.arm,success:metric.success,
  lead_input_equivalent:ie===null?null:Math.round(ie),lead_messages:metric.lead_usage?.message_count??null,
  window_ms:window,implement_ms:implementMs,review_ms:reviewMs,acceptance_ms:acceptanceMs,acceptance_unknown:acceptanceUnknown,
  other_ms:Math.max(0,window-workerMs-acceptanceMs),rounds:runs.filter(r=>r.kind==='implement').length,reviews:runs.filter(r=>r.kind==='review').length,
  hidden_passed:metric.quality?.hidden_passed??null,hidden_failed:metric.quality?.hidden_failed??[],scope_violations:metric.scope_violations??null,
  stalls:runs.filter(r=>r.stall).length,max_gap_ms:Math.max(0,...runs.map(r=>r.max_gap_ms??0)),runs};
}

const min=ms=>ms===null||ms===undefined?'-':(ms/60000).toFixed(1);
const k=n=>n===null||n===undefined?'-':`${Math.round(n/1000)}K`;

export function formatReport(rows,{rounds=false}={}) {
 const done=rows.filter(r=>r.status==='recorded');
 const lines=['| Case | Arm | Lead IE | Msgs | Window min | Implement | Review | Acceptance | Other | Rounds | Reviews | Hidden | Stalls (longest quiet min) |','|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
 for(const r of done)lines.push(`| ${r.case_id} | ${r.arm} | ${k(r.lead_input_equivalent)} | ${r.lead_messages??'-'} | ${min(r.window_ms)} | ${min(r.implement_ms)} | ${min(r.review_ms)} | ${min(r.acceptance_ms)}${r.acceptance_unknown?'*':''} | ${min(r.other_ms)} | ${r.rounds} | ${r.reviews} | ${r.hidden_passed===null?'-':r.hidden_passed?'pass':'FAIL '+r.hidden_failed.join(', ')} | ${r.stalls} (${min(r.max_gap_ms)}) |`);
 if(done.length>1){
  const sum=key=>done.reduce((s,r)=>s+(r[key]??0),0);
  lines.push(`| **Total** | | ${k(sum('lead_input_equivalent'))} | ${sum('lead_messages')} | ${min(sum('window_ms'))} | ${min(sum('implement_ms'))} | ${min(sum('review_ms'))} | ${min(sum('acceptance_ms'))} | ${min(sum('other_ms'))} | ${sum('rounds')} | ${sum('reviews')} | ${done.filter(r=>r.hidden_passed).length}/${done.filter(r=>r.hidden_passed!==null).length} | ${sum('stalls')} |`);
 }
 if(done.some(r=>r.acceptance_unknown))lines.push('','\\* Some acceptance records have no duration_ms (written before 2026-11-28); their time is counted in Other.');
 for(const r of rows.filter(r=>r.status!=='recorded'))lines.push('',`${r.case_id??r.file}: ${r.status}${r.phase?` (phase ${r.phase})`:''} — ${r.file}`);
 if(rounds)for(const r of done){
  lines.push('',`${r.case_id} ${r.arm}`);
  for(const x of r.runs)lines.push(`  ${new Date(x.start).toISOString().slice(11,19)} ${x.kind.padEnd(9)} ${x.tag.padEnd(16)} ${String(x.executor).padEnd(8)} ${min(x.ms).padStart(5)} min${x.stall?' WOULD STOP':''}${x.max_gap_ms?` quiet ${min(x.max_gap_ms)}`:''}`);
 }
 return lines.join('\n');
}

if(isMain(import.meta.url)){
 const args=process.argv.slice(2),dirs=args.filter(a=>!a.startsWith('--'));
 if(!dirs.length){console.error('Usage: benchmark-report.mjs DIR... [--rounds] [--json]');process.exitCode=2;}
 else{
  const rows=findTrials(dirs).map(trialReport);
  if(args.includes('--json'))console.log(JSON.stringify(rows.map(({runs,...r})=>args.includes('--rounds')?{...r,runs}:r),null,2));
  else console.log(formatReport(rows,{rounds:args.includes('--rounds')}));
 }
}
