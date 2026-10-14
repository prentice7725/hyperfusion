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
  else throw Error('Usage: benchmark.mjs cases | prepare CASE NEW_REPO | start CASE REPO [--arm baseline|hyperfusion] [--session ID] | stop CASE REPO --success|--failed [--session ID --transcript FILE] | compare BASELINE.json HYPERFUSION.json [--pricing PRICES.json]');
 }catch(e){console.error(e.message);process.exitCode=1;}
}
