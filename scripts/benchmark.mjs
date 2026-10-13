import fs from 'node:fs';
import {isMain} from './platform.mjs';
import {read} from './artifact.mjs';
import {aggregate} from './metrics.mjs';

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
export function comparePilot(baseline,hyperfusion) {
 const a=index(baseline),b=index(hyperfusion),gaps=[];
 const pairs=CASES.map(c=>{
  const left=a.get(c.case_id),right=b.get(c.case_id);
  if(!left||!right){gaps.push(c.case_id+': missing paired result');return {case_id:c.case_id,status:'not_measured'};}
  const scope=left.lead_usage?.scope??'manual-task-total';
  const other=right.lead_usage?.scope??'manual-task-total';
  if(scope!==other||!known(left.lead_usage?.lead_tokens)||!known(right.lead_usage?.lead_tokens))gaps.push(c.case_id+': unmatched scope or unknown lead usage');
  if(!known(left.claude_total_tokens)||!known(right.claude_total_tokens))gaps.push(c.case_id+': unknown total Claude usage');
  return {case_id:c.case_id,status:'recorded',baseline_success:left.success,hyperfusion_success:right.success,scope,
   baseline_lead_tokens:left.lead_usage?.lead_tokens??null,hyperfusion_lead_tokens:right.lead_usage?.lead_tokens??null};
 });
 const complete=!gaps.length,base=aggregate([...a.values()]),hf=aggregate([...b.values()]);
 const reduction=(left,right)=>complete&&known(left)&&left>0&&known(right)?1-right/left:null;
 return {status:complete?'measured-pilot':'incomplete',expected_pairs:CASES.length,
  recorded_pairs:pairs.filter(p=>p.status==='recorded').length,gaps,pairs,
  baseline:base,hyperfusion:hf,lead_token_reduction:reduction(base.lead_tokens_per_success,hf.lead_tokens_per_success),
  total_claude_token_reduction:reduction(base.claude_tokens_per_success,hf.claude_tokens_per_success),
  note:'Actual paired records only. Failed tasks remain in cost numerators. A ten-case pilot is not statistical proof; no model calls are made by this tool.'};
}
if(isMain(import.meta.url)){
 try{
  const [cmd,left,right]=process.argv.slice(2);
  if(cmd==='cases')console.log(JSON.stringify(CASES,null,2));
  else if(cmd==='compare'&&left&&right)console.log(JSON.stringify(comparePilot(read(left),read(right)),null,2));
  else throw Error('Usage: benchmark.mjs cases | compare BASELINE.json HYPERFUSION.json');
 }catch(e){console.error(e.message);process.exitCode=1;}
}
