import {hash} from './artifact.mjs';
import {knownNumber} from './usage-accounting.mjs';

export const COMPONENTS=['input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens'];
// User-supplied reference ratios, not current provider prices or billed USD.
export const REFERENCE_WEIGHTS={input_tokens:1,output_tokens:5,cache_read_input_tokens:0.1,cache_creation_input_tokens:1.25};
export function weightedUsage(observation,pricing=null) {
 const rows=observation?.by_model?Object.entries(observation.by_model):[];
 const components=Object.fromEntries(COMPONENTS.map(k=>[k,0]));
 const by_model={};let normalized=0,dollars=0,priced=!!pricing,complete=rows.length>0;
 for(const [model,row] of rows){
  const values=row.components;
  if(!values||!COMPONENTS.every(k=>knownNumber(values[k]))){complete=false;continue;}
  let units=0,cost=0;const rates=pricing?.models?.[model];
  for(const k of COMPONENTS){components[k]+=values[k];units+=values[k]*REFERENCE_WEIGHTS[k];
   if(!knownNumber(rates?.[k]))priced=false;else cost+=values[k]*rates[k]/1e6;}
  normalized+=units;dollars+=cost;
  by_model[model]={components:values,input_equivalent:units,estimated_usd:rates&&COMPONENTS.every(k=>knownNumber(rates[k]))?cost:null};
 }
 return {components:complete?components:null,by_model,input_equivalent:complete?normalized:null,
  estimated_usd:complete&&priced?dollars:null,weights:REFERENCE_WEIGHTS,
  pricing_id:pricing?hash(JSON.stringify(pricing)):null,
  basis:'Reference input-equivalent workload; USD only with explicit per-million component rates for every observed model. Neither is billed cost.'};
}
export function validatePricing(pricing) {
 if(!pricing||typeof pricing.source!=='string'||!pricing.source.trim()||typeof pricing.as_of!=='string'||!Number.isFinite(Date.parse(pricing.as_of))
  ||!pricing.models||typeof pricing.models!=='object'||Array.isArray(pricing.models)||!Object.keys(pricing.models).length)throw Error('PRICING: source, as_of and model rate table required');
 for(const rates of Object.values(pricing.models))if(!COMPONENTS.every(k=>knownNumber(rates?.[k])))throw Error('PRICING: every model needs all four nonnegative USD-per-million rates');
 return pricing;
}
export function weightedClaude(record,pricing=null) {
 const models={};let complete=true;
 const rows=[...Object.entries(record?.lead_usage?.by_model??{}).map(([model,row])=>({model,...row})),
  ...(record?.run_usage??[]).flatMap(r=>r.model_usage?.length?r.model_usage:[r]).filter(r=>/^claude-/.test(r.model??''))];
 if(!record?.lead_usage?.by_model)complete=false;
 for(const row of rows){
  if(!/^claude-/.test(row.model)||!row.components||!COMPONENTS.every(k=>knownNumber(row.components[k]))){complete=false;continue;}
  models[row.model]??={components:Object.fromEntries(COMPONENTS.map(k=>[k,0]))};
  for(const k of COMPONENTS)models[row.model].components[k]+=row.components[k];
 }
 return weightedUsage(complete?{by_model:models}:null,pricing);
}
