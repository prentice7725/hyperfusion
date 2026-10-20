import fs from 'node:fs';
import {isMain} from './platform.mjs';
import {read} from './artifact.mjs';
import {aggregate} from './metrics.mjs';
import {weightedUsage,weightedClaude,validatePricing} from './usage-weights.mjs';
import {prepareFixture} from './benchmark-fixtures.mjs';
import {startWindow,stopWindow,recoverWindow} from './benchmark-window.mjs';

export const CASES=JSON.parse(fs.readFileSync(new URL('../references/benchmark-cases.json',import.meta.url),'utf8'));
const known=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
function index(records) {
 if(!Array.isArray(records))throw Error('Benchmark input must be an array of actual metric records');
 const expected=new Set(CASES.map(c=>c.case_id)),out=new Map();
 for(const record of records){
  if(!expected.has(record?.case_id)||out.has(record.case_id))throw Error('Unknown or duplicate benchmark case_id');
  if(typeof record.success!=='boolean')throw Error('Benchmark success must be explicit');
  out.set(record.case_id,record);
 }
 return out;
}
export function comparePilot(baseline,hyperfusion,pricing=null) {
 if(pricing)validatePricing(pricing);
 const a=index(baseline),b=index(hyperfusion),gaps=[];
 const pairs=CASES.map(c=>{
  const left=a.get(c.case_id),right=b.get(c.case_id);
  if(!left||!right){gaps.push(c.case_id+': missing paired result');return {case_id:c.case_id,status:'not_measured'};}
  const scope=left.lead_usage?.scope??'manual-task-total';
  const other=right.lead_usage?.scope??'manual-task-total';
  if(scope!==other||!known(left.lead_usage?.lead_tokens)||!known(right.lead_usage?.lead_tokens))gaps.push(c.case_id+': unmatched scope or unknown lead usage');
  if(!left.initial_tree||left.initial_tree!==right.initial_tree||!left.fixture_id||left.fixture_id!==right.fixture_id)gaps.push(c.case_id+': unmatched or unknown fixture tree');
  const lw=weightedUsage(left.lead_usage,pricing),rw=weightedUsage(right.lead_usage,pricing);
  const lc=weightedClaude(left,pricing),rc=weightedClaude(right,pricing);
  if(lw.input_equivalent===null||rw.input_equivalent===null)gaps.push(c.case_id+': missing usage components');
  if(!pricing&&JSON.stringify(Object.keys(lw.by_model).sort())!==JSON.stringify(Object.keys(rw.by_model).sort()))gaps.push(c.case_id+': mixed model prices need explicit pricing');
  if(pricing&&(lw.estimated_usd===null||rw.estimated_usd===null))gaps.push(c.case_id+': incomplete model pricing');
  if(pricing&&(lc.estimated_usd===null||rc.estimated_usd===null))gaps.push(c.case_id+': incomplete total Claude pricing/components');
  if(!known(left.claude_total_tokens)||!known(right.claude_total_tokens))gaps.push(c.case_id+': unknown total Claude usage');
  return {case_id:c.case_id,status:'recorded',baseline_success:left.success,hyperfusion_success:right.success,scope,
   baseline_lead_tokens:left.lead_usage?.lead_tokens??null,hyperfusion_lead_tokens:right.lead_usage?.lead_tokens??null,
   baseline_weighted_usage:lw,hyperfusion_weighted_usage:rw,baseline_claude_weighted_usage:lc,hyperfusion_claude_weighted_usage:rc};
 });
 const complete=!gaps.length,base=aggregate([...a.values()]),hf=aggregate([...b.values()]);
 const primaryKey=pricing?'estimated_usd':'input_equivalent';
 const perSuccess=records=>{const values=records.map(r=>(pricing?weightedClaude(r,pricing):weightedUsage(r.lead_usage))[primaryKey]);const count=records.filter(r=>r.success).length;return count&&values.every(known)?values.reduce((a,b)=>a+b,0)/count:null;};
 base.weighted_usage_per_success=perSuccess([...a.values()]);hf.weighted_usage_per_success=perSuccess([...b.values()]);
 const reduction=(left,right)=>complete&&known(left)&&left>0&&known(right)?1-right/left:null;
 return {status:complete?'measured-pilot':'incomplete',expected_pairs:CASES.length,
  recorded_pairs:pairs.filter(p=>p.status==='recorded').length,gaps,pairs,
 primary_metric:pricing?'estimated_total_claude_usd_per_success':'reference_lead_input_equivalent_per_success',
  primary_reduction:reduction(base.weighted_usage_per_success,hf.weighted_usage_per_success),
  baseline:base,hyperfusion:hf,lead_token_reduction:reduction(base.lead_tokens_per_success,hf.lead_tokens_per_success),
  total_claude_token_reduction:reduction(base.claude_tokens_per_success,hf.claude_tokens_per_success),
  note:'Reference weights are workload units, not billed cost; explicit model prices enable estimated USD. Host subagent usage is included. Actual paired records only. Failed tasks remain in cost numerators. A ten-case pilot is not statistical proof; no model calls are made by this tool.'};
}

// The protocol digest is operator-supplied: it identifies the approved task,
// team, models/efforts, acceptance definitions and measurement scope together.
// Matching metadata is a prerequisite, not proof of experimental equivalence.
export function compareRepeated(current,candidate,pricing=null,{repetitions=3}={}) {
 if(!Number.isInteger(repetitions)||repetitions<1||repetitions>10)throw Error('Benchmark repetitions must be 1..10');
 const group=(records,arm)=>{
  if(!Array.isArray(records))throw Error('Repeated benchmark input must be an array');
  const groups=Array.from({length:repetitions},()=>[]),seen=new Set();
  for(const record of records){
   const r=record?.comparison;
   if(!r||!Number.isInteger(r.repetition)||r.repetition<1||r.repetition>repetitions||r.arm!==arm)throw Error('Repeated benchmark requires a matching arm and repetition');
   const key=r.repetition+':'+record.case_id;
   if(seen.has(key))throw Error('Duplicate benchmark case/repetition');
   seen.add(key);groups[r.repetition-1].push(record);
  }
  return groups;
 };
 const left=group(current,'current'),right=group(candidate,'candidate'),gaps=[],trials=[];
 for(const [arm,records] of [['current',current],['candidate',candidate]])if(new Set(records.map(r=>r.comparison.implementation_ref)).size>1)gaps.push(`${arm}: implementation ref changed between repetitions`);
 for(const c of CASES)if(new Set([...current,...candidate].filter(r=>r.case_id===c.case_id).map(r=>r.comparison.protocol_digest)).size>1)gaps.push(`${c.case_id}: approved protocol changed between repetitions`);
 const text=v=>typeof v==='string'&&v.trim().length>0;
 for(let n=0;n<repetitions;n++){
  const pilot=comparePilot(left[n],right[n],pricing);
  gaps.push(...pilot.gaps.map(g=>`repetition ${n+1}: ${g}`));
  for(const row of pilot.pairs){
   const a=left[n].find(r=>r.case_id===row.case_id),b=right[n].find(r=>r.case_id===row.case_id);
   if(a&&b){
    const x=a.comparison,y=b.comparison;
    if(!/^[a-f0-9]{64}$/.test(x.protocol_digest??'')||x.protocol_digest!==y.protocol_digest)gaps.push(`${n+1}/${row.case_id}: unmatched or missing approved protocol digest`);
    for(const [arm,meta] of [['current',x],['candidate',y]]){
     if(!text(meta.implementation_ref)||!text(meta.cli_versions)||!text(meta.cache_conditions)||!text(meta.quota_timeouts)||!text(meta.human_help))gaps.push(`${n+1}/${row.case_id}/${arm}: missing experimental conditions`);
    }
    if(![1,2].includes(x.order)||![1,2].includes(y.order)||x.order===y.order)gaps.push(`${n+1}/${row.case_id}: invalid paired execution order`);
    if(x.implementation_ref===y.implementation_ref)gaps.push(`${n+1}/${row.case_id}: current and candidate refs must differ`);
   }
   trials.push({repetition:n+1,...row,current_conditions:a?.comparison??null,candidate_conditions:b?.comparison??null,current_record:a??null,candidate_record:b??null});
  }
 }
 const complete=!gaps.length,allKnown=(rows,key)=>rows.length>0&&rows.every(r=>known(r[key]));
 const successes=rows=>rows.filter(r=>r.success).length;
 const perSuccess=(rows,value)=>{const values=rows.map(value),count=successes(rows);return count&&values.every(known)?values.reduce((a,b)=>a+b,0)/count:null;};
 const reduction=(a,b)=>complete&&known(a)&&a>0&&known(b)?1-b/a:null;
 const weighted=rows=>perSuccess(rows,r=>weightedUsage(r.lead_usage,pricing).input_equivalent);
 const provider=rows=>perSuccess(rows,r=>r.provider_cost_usd);
 const p95=rows=>allKnown(rows,'wall_ms')?[...rows.map(r=>r.wall_ms)].sort((a,b)=>a-b)[Math.ceil(rows.length*0.95)-1]:null;
 const aWall=p95(current),bWall=p95(candidate);
 const quality=rows=>rows.length>0&&['wrong_closes','escaped_regressions','scope_violations'].every(key=>rows.every(r=>Number.isInteger(r[key])&&r[key]>=0))?Object.fromEntries(['wrong_closes','escaped_regressions','scope_violations'].map(key=>[key,rows.reduce((n,r)=>n+r[key],0)])):null;
 const aQuality=quality(current),bQuality=quality(candidate),leadReduction=reduction(weighted(current),weighted(candidate));
 const providerReduction=reduction(provider(current),provider(candidate));
 return {status:complete?'recorded-repeated-comparison':'incomplete',expected_pairs:CASES.length*repetitions,
  recorded_pairs:trials.filter(r=>r.status==='recorded').length,gaps,trials,
  current:{successes:successes(current),lead_weighted_per_success:weighted(current),provider_cost_per_success:provider(current),p95_wall_ms:aWall,quality:aQuality},
  candidate:{successes:successes(candidate),lead_weighted_per_success:weighted(candidate),provider_cost_per_success:provider(candidate),p95_wall_ms:bWall,quality:bQuality},
  lead_weighted_reduction:leadReduction,provider_cost_reduction:providerReduction,
  guardrails_complete:complete&&allKnown(current,'provider_cost_usd')&&allKnown(candidate,'provider_cost_usd')&&aQuality!==null&&bQuality!==null&&known(aWall)&&known(bWall),
  p95_wall_ratio:complete&&aWall>0&&known(bWall)?bWall/aWall:null,
  rollout:'not_authorized',
  note:'Operator-supplied protocol/conditions; no model calls or automatic rollout. Failed trials remain in cost numerators. Missing provider cost or independent quality evidence stays unknown. A small repeated sample and its p95 are not statistical proof.'};
}
if(isMain(import.meta.url)){
 try{
  const [cmd,left,right,...extra]=process.argv.slice(2);
  const flag=name=>{const i=extra.indexOf(name);return i<0?undefined:extra[i+1];};
  if(cmd==='cases')console.log(JSON.stringify(CASES,null,2));
  else if(cmd==='prepare'&&left&&right)console.log(JSON.stringify(prepareFixture(left,right),null,2));
  else if(cmd==='start'&&left&&right)console.log(JSON.stringify(startWindow(left,right,{arm:flag('--arm')??'baseline',sessionId:flag('--session')}),null,2));
  else if(cmd==='recover'&&left&&right)console.log(JSON.stringify(recoverWindow(left,right,{quiescent:extra.includes('--quiescent'),reason:flag('--reason')}),null,2));
  else if(cmd==='stop'&&left&&right)console.log(JSON.stringify(stopWindow(left,right,{success:extra.includes('--success')?true:extra.includes('--failed')?false:undefined,sessionId:flag('--session'),transcriptPath:flag('--transcript')}),null,2));
  else if(cmd==='compare'&&left&&right)console.log(JSON.stringify(comparePilot(read(left),read(right),flag('--pricing')?read(flag('--pricing')):null),null,2));
  else if(cmd==='compare-repeated'&&left&&right)console.log(JSON.stringify(compareRepeated(read(left),read(right),flag('--pricing')?read(flag('--pricing')):null,{repetitions:flag('--repetitions')?Number(flag('--repetitions')):3}),null,2));
  else throw Error('Usage: benchmark.mjs cases | prepare CASE NEW_REPO | start CASE REPO [--arm baseline|hyperfusion] [--session ID] | stop CASE REPO --success|--failed [--session ID --transcript FILE] | compare BASELINE.json HYPERFUSION.json [--pricing PRICES.json] | compare-repeated CURRENT.json CANDIDATE.json [--repetitions 3] [--pricing PRICES.json]');
 }catch(e){console.error(e.message);process.exitCode=1;}
}
