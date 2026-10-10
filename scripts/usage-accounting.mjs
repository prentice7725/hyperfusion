import fs from 'node:fs';
import path from 'node:path';
import {read} from './artifact.mjs';
import {controlPath} from './control-dir.mjs';

export const knownNumber=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
export function reportedTokens(record) {
 const u=record?.usage??record;
 if(knownNumber(u?.total_tokens))return u.total_tokens;
 const input=u?.input_tokens??u?.inputTokens;
 const output=u?.output_tokens??u?.outputTokens;
 if(!knownNumber(input)||!knownNumber(output))return null;
 const cache=[u?.cache_read_input_tokens??u?.cacheReadInputTokens??0,u?.cache_creation_input_tokens??u?.cacheCreationInputTokens??0];
 return cache.every(knownNumber)?input+output+cache[0]+cache[1]:null;
}
export const completeSum=(rows,key)=>rows.every(r=>knownNumber(r[key]))?rows.reduce((n,r)=>n+r[key],0):null;

// One row per controller artifact tag. Failed launches without usage remain unknown.
export function collectRunUsage(root,state) {
 const dir=controlPath(root,'tasks',state.task_id);
 if(!fs.existsSync(dir))return [];
 const names=fs.readdirSync(dir);
 const tags=[...new Set(names.flatMap(name=>{
  const m=/^(?:usage|launch|envelope)-(\d+|consult-c\d+-m\d+)\.json$/.exec(name);return m?[m[1]]:[];
 }))].sort();
 const optional=file=>fs.existsSync(path.join(dir,file))?read(path.join(dir,file)):null;
 return tags.map(tag=>{
  const usage=optional(`usage-${tag}.json`),launch=optional(`launch-${tag}.json`),envelope=optional(`envelope-${tag}.json`);
  const consult=/^consult-(c\d+)-(m\d+)$/.exec(tag);
  const context=consult?optional(`consult-${consult[1]}.json`):null;
  const dispatch=optional(consult?`${tag}.json`:`dispatch-${tag}.json`);
  return {tag,file:usage?`usage-${tag}.json`:null,executor:usage?.executor??launch?.executor??envelope?.executor??dispatch?.executor??null,
   role:usage?.role??(consult?context?.mode==='review'?'review':'consult':'implement'),
   round:usage?.round??(consult?dispatch?.round??null:Number(tag)),model:usage?.model??dispatch?.cli?.model??null,
   tokens:usage?reportedTokens(usage):null,cost_usd:knownNumber(usage?.total_cost_usd)?usage.total_cost_usd:null,
   model_usage:usage?.modelUsage&&typeof usage.modelUsage==='object'&&!Array.isArray(usage.modelUsage)?Object.entries(usage.modelUsage).map(([model,u])=>({model,tokens:reportedTokens(u),cost_usd:knownNumber(u?.costUSD)?u.costUSD:null})):null,
   wall_ms:usage?.wall_ms??envelope?.wall_ms??null,started_at:usage?.started_at??envelope?.started_at??launch?.at??null,
   reported:!!usage,exit_code:envelope?.exit?.code??null,cost_basis:'client-side report, not billed cost'};
 });
}

export function summarizeUsage(runs,lead=null,leadModel=null) {
 const executors=['grok','antigravity','luna','sol','sonnet','haiku'];
 const by_executor=Object.fromEntries(executors.map(executor=>{
  const rows=runs.filter(r=>r.executor===executor);
  return [executor,{calls:rows.length,roles:Object.fromEntries(['implement','review','consult'].map(role=>[role,rows.filter(r=>r.role===role).length])),tokens:completeSum(rows,'tokens'),cost_usd:completeSum(rows,'cost_usd'),unreported_calls:rows.filter(r=>!r.reported).length}];
 }));
 const modelRows=runs.flatMap(r=>r.model_usage?.length?r.model_usage:r);
 const models=[...new Set(modelRows.map(r=>r.model??'unknown'))];
 const by_model=Object.fromEntries(models.map(model=>{
  const rows=modelRows.filter(r=>(r.model??'unknown')===model);return [model,{calls:rows.length,tokens:completeSum(rows,'tokens'),cost_usd:completeSum(rows,'cost_usd')}];
 }));
 // An unverified host model is never reported as measured Opus usage.
 const opus=lead&&/^claude-opus-/.test(leadModel??'')?lead.lead_tokens:null;
 const claudeRows=runs.filter(r=>['sonnet','haiku'].includes(r.executor)).flatMap(r=>r.model_usage?.length?r.model_usage:r);
 const unknownClaude=claudeRows.some(r=>!/^claude-(opus|sonnet|haiku)-/.test(r.model??''));
 const familyTokens=family=>unknownClaude?null:completeSum(claudeRows.filter(r=>r.model.startsWith(`claude-${family}-`)),'tokens');
 const workerOpus=familyTokens('opus');
 const claude={opus:knownNumber(opus)&&knownNumber(workerOpus)?opus+workerOpus:null,sonnet:familyTokens('sonnet'),haiku:familyTokens('haiku')};
 return {by_executor,by_model,claude,claude_total_tokens:Object.values(claude).every(knownNumber)?Object.values(claude).reduce((a,b)=>a+b,0):null,
  unreported_calls:runs.filter(r=>!r.reported).length};
}
