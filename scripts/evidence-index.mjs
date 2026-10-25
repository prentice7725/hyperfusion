// Read-only evidence views for the lead. Neither function writes files, launches a
// model, executes code or participates in approval; raw controller artifacts stay
// authoritative. See references/evidence-retrieval-experiment.md.
import fs from 'node:fs';
import path from 'node:path';
import {hash} from './artifact.mjs';
import {environmentFailure} from './contracts.mjs';
import {findingLedger} from './finding-ledger.mjs';
import {redactText,isSecretField} from './redaction.mjs';

const MAX_FILE=4*1024*1024,MAX_TOTAL=32*1024*1024,SIGNAL_LIMIT=20,MAX_DEPTH=64,MAX_FILE_CHUNKS=5000,MAX_CHUNKS=20000;
const mask=s=>redactText(String(s??''),{},{preserveLines:true});
const clip=(s,n=300)=>mask(typeof s==='object'&&s!==null?JSON.stringify(s):s).slice(0,n);
function display(value,key='',depth=0) {
 if(isSecretField(key)&&value!==null&&value!==undefined&&value!=='')return '[REDACTED:secret]';
 if(depth>MAX_DEPTH)return '[OMITTED:depth]';
 if(typeof value==='string')return mask(value);
 if(Array.isArray(value))return value.map(v=>display(v,'',depth+1));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,display(v,k,depth+1)]));
 return value;
}
const FAILURE=/\b(?:not ok|fail(?:ed|ure|ures|ing)?|errors?|assert(?:ion)?(?:error)?|exception|panic(?:ked)?|traceback)\b/i;

// Bounded, symlink-free JSON read that also returns the raw SHA-256 for pointers.
function artifact(dir,name) {
 try{
  const file=path.join(dir,name),st=fs.lstatSync(file);
  if(!st.isFile()||st.isSymbolicLink())return {status:'invalid',file:name,reason:'not_regular_file'};
  if(st.size>MAX_FILE)return {status:'invalid',file:name,reason:'too_large',bytes:st.size};
  const bytes=fs.readFileSync(file);
  return {status:'present',file:name,sha256:hash(bytes),bytes:bytes.length,value:JSON.parse(bytes.toString('utf8').replace(/^﻿/,''))};
 }catch(e){return e.code==='ENOENT'?{status:'missing',file:name}:{status:'invalid',file:name,reason:'unreadable'};}
}
const pointer=a=>a?.status==='present'?{file:a.file,sha256:a.sha256}:{file:a.file,status:a.status};

function firstFailure(text) {
 const lines=mask(String(text??'').replaceAll('\r\n','\n')).split('\n');
 const index=lines.findIndex(l=>FAILURE.test(l));
 return index<0?null:{tail_line:index+1,text:clip(redactText(lines[index]))};
}

// Push packet: signals the controller always surfaces, so the lead does not need
// to know what to search for. Lists are capped only with explicit omitted counts.
export function evidencePacket(state,dir) {
 const n=state.iteration,signals=[],read=new Map();
 const get=name=>{if(!read.has(name))read.set(name,artifact(dir,name));return read.get(name);};
 const add=(code,detail,source)=>signals.push({code,...display(detail),...(source?{source:pointer(source)}:{})});
 const usable=a=>{
  if(a.status==='invalid')add('ARTIFACT_UNREADABLE',{file:a.file,reason:a.reason});
  return a.status==='present'?a.value:null;
 };

 const acceptanceName=state.acceptance?.round===n&&typeof state.acceptance.file==='string'&&path.basename(state.acceptance.file)===state.acceptance.file
  ?state.acceptance.file:`acceptance-${n}-finish.json`;
 const accA=get(acceptanceName),acc=usable(accA);
 if(!acc)add('ACCEPTANCE_NOT_RECORDED',{file:acceptanceName});
 else{
  if(acc.status==='skipped')add('ACCEPTANCE_SKIPPED',{reason:clip(acc.reason),ignored_changes:(acc.ignored_changes??[]).length},accA);
  if(Array.isArray(acc.results)&&acc.results.length&&acc.quiescent!==true)add('ACCEPTANCE_NOT_QUIESCENT',{},accA);
  if(Array.isArray(acc.tree_changed)&&acc.tree_changed.length)add('ACCEPTANCE_TREE_CHANGED',{paths:acc.tree_changed.slice(0,10).map(p=>clip(p,200)),count:acc.tree_changed.length},accA);
  for(const [index,r] of (Array.isArray(acc.results)?acc.results:[]).entries()){
   const tail=String(r?.output_tail??'');
   // The controller keeps only an output tail; a failure before it is not recoverable here.
   if(Number.isSafeInteger(r?.output_bytes)&&r.output_bytes>Buffer.byteLength(tail))add('OUTPUT_TRUNCATED',{command:clip(r.command,200),result_index:index,output_bytes:r.output_bytes,tail_bytes:Buffer.byteLength(tail),output_sha256:r.output_sha256??null},accA);
   if(r?.status!=='pass')add('ACCEPTANCE_FAILED',{command:clip(r?.command,200),result_index:index,status:r?.status??null,exit_code:r?.exit_code??null,timed_out:r?.timed_out===true,first_failure:firstFailure(tail)},accA);
  }
 }

 const rawA=get(`raw-result-${n}.json`),raw=usable(rawA);
 const tests=Array.isArray(raw?.tests)?raw.tests:[];
 for(const t of tests){
  if(environmentFailure(t))add('ENVIRONMENT_FAILURE',{command:clip(t.command,200),environment_error:clip(t.environment_error)},rawA);
  else if(t?.status==='fail')add('WORKER_REPORTED_TEST_FAILURE',{command:clip(t.command,200)},rawA);
 }
 const unresolved=Array.isArray(raw?.unresolved)?raw.unresolved.length:0,risks=Array.isArray(raw?.risks)?raw.risks.length:0;
 if(raw&&(unresolved||risks||raw.needs_lead_decision===true))add('WORKER_OPEN_ITEMS',{status:raw.status??null,unresolved,risks,needs_lead_decision:raw.needs_lead_decision===true},rawA);

 const valA=get(`validation-${n}.json`),validation=usable(valA);
 if(raw&&validation&&Array.isArray(raw.files_changed)&&Array.isArray(validation.changed)){
  const declared=new Set(raw.files_changed),actual=new Set(validation.changed);
  const undeclared=[...actual].filter(f=>!declared.has(f)).sort(),phantom=[...declared].filter(f=>!actual.has(f)).sort();
  if(undeclared.length||phantom.length)add('CHANGED_FILES_MISMATCH',{undeclared:undeclared.slice(0,20),claimed_not_changed:phantom.slice(0,20),count:undeclared.length+phantom.length},valA);
 }

 if(Array.isArray(state.acceptance_test_changes)&&state.acceptance_test_changes.length)
  add('ACCEPTANCE_TEST_CHANGED',{paths:state.acceptance_test_changes.slice(0,20).map(p=>clip(typeof p==='string'?p:p?.path??JSON.stringify(p),200)),count:state.acceptance_test_changes.length});
 if(Array.isArray(state.last_errors)&&state.last_errors.length)add('CONTROLLER_ERRORS',{errors:state.last_errors.slice(0,5).map(e=>clip(e)),count:state.last_errors.length,omitted:Math.max(0,state.last_errors.length-5),state_pointer:'/last_errors'});

 const results=(state.review_results?.[n]??[]).filter(r=>r&&!r.superseded&&r.ok!==false);
 const verdicts=[...new Set(results.map(r=>r.verdict))];
 if(verdicts.length>1)add('REVIEW_VERDICT_DISAGREEMENT',{reviewers:results.map(r=>({executor:r.executor,verdict:r.verdict}))});
 let ledger=null;
 try{ledger=findingLedger(state,dir);}catch{add('FINDING_LEDGER_UNAVAILABLE',{});}
 if(ledger){
  for(const w of ledger.warnings)add('REVIEW_SOURCE_WARNING',{warning:w.code,file:w.file??null});
  const current=ledger.issues.flatMap(g=>g.observations).filter(o=>o.round===n);
  const seats=new Set(current.map(o=>o.reviewer));
  for(const g of ledger.issues){
   const rows=g.observations.filter(o=>o.round===n&&['blocker','major'].includes(o.severity));
   const by=new Set(rows.map(o=>o.reviewer));
   if(rows.length&&by.size===1&&Math.max(seats.size,results.length)>1)
    add('SINGLE_REVIEWER_BLOCKING',{finding_id:g.id,reviewer:rows[0].reviewer,severity:rows[0].severity,ac_ids:g.ac_ids,file:g.file,line:g.line,issue:clip(redactText(g.issue))},{status:'present',file:rows[0].source_file,sha256:rows[0].source_sha256});
  }
 }

 // Cap per code, never silently: overflow becomes a count plus its source pointers.
 const kept=[],omitted={};
 for(const s of signals){
  const count=kept.filter(k=>k.code===s.code).length;
  if(count<SIGNAL_LIMIT)kept.push(s);
  else{const o=omitted[s.code]??={count:0,sources:[]};o.count++;if(s.source&&!o.sources.some(p=>p.file===s.source.file))o.sources.push(s.source);}
 }
 const pointers=[...read.values()].filter(a=>a.status==='present').map(pointer);
 return {packet_revision:1,authoritative:false,task_id:state.task_id,round:n,phase:state.phase??null,
  signal_count:signals.length,signals:kept,omitted,pointers,
  note:'Push signals only. Raw artifacts, controller acceptance and mandatory review remain authoritative; no signal means no recognized signal, not a pass.'};
}

// Search candidates: controller-written evidence only. Dispatch prompts and state are excluded.
const SEARCHABLE=/^(?:acceptance-\d+-[\w-]+|raw-result-\d+|result-\d+|validation-\d+|review-\d+(?:-verify)?|consult-result-c\d+-m\d+|lead-packet-\d+(?:-[\w-]+)?|revision-packet-\d+|brief-\d+|initial-brief|verification)\.json$/;
const roundOf=name=>{const m=/^(?:acceptance|raw-result|result|validation|review|lead-packet|revision-packet|brief)-(\d+)/.exec(name);return m?Number(m[1]):null;};
const tokens=text=>String(text).toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(t=>t.length>1);

// A consult's number is not its implementation round. Validate the controller
// assignment and raw identity before deriving round provenance from its prompt.
function consultRound(state,dir,name,value) {
 const match=/^consult-result-(c\d+)-(m\d+)\.json$/.exec(name);
 if(!match)return {round:roundOf(name)};
 const [,id,member]=match,meta=artifact(dir,`consult-${id}.json`),request=artifact(dir,`consult-${id}-${member}.json`),finish=artifact(dir,`consult-${id}-finish.json`);
 try{
  const brief=JSON.parse(request.value?.prompt??'null')?.brief;
  if(meta.status!=='present'||request.status!=='present'||!['advisor','committee','review'].includes(meta.value?.mode)
   ||!meta.value.members?.some(m=>m.member===member&&typeof m.executor==='string'&&m.executor)
   ||value?.task_id!==state.task_id||value?.consult_id!==id||value?.member!==member
   ||brief?.task_id!==state.task_id||!Number.isSafeInteger(brief?.round)||brief.round<0
   ||finish.status==='invalid'||finish.value?.violated)throw Error('provenance');
  return {round:brief.round};
 }catch{return {reason:'consult_provenance'};}
}

function chunks(file,value,remaining) {
 const out=[],stack=[{value,at:'',key:'',depth:0}];
 const push=row=>{
  if(out.length>=MAX_FILE_CHUNKS||out.length>=remaining)throw Error('chunk_limit');
  out.push(row);
 };
 while(stack.length){
  const {value,at,key,depth}=stack.pop();
  if(depth>MAX_DEPTH)throw Error('depth_limit');
  if(isSecretField(key)&&value!==null&&value!==undefined&&value!==''){
   push({...file,pointer:at||'/',lines:null,text:'[REDACTED:secret]'});
  }else if(typeof value==='string'){
   // Mask the whole string first (a private key may span chunk boundaries),
   // preserving every original newline so ranges still point into the raw value.
   const lines=mask(value.replaceAll('\r\n','\n')).split('\n');
   for(let i=0;i<lines.length;i+=8){
    const text=lines.slice(i,i+8).join('\n');
    if(text.trim())push({...file,pointer:at||'/',lines:lines.length>1?[i+1,Math.min(lines.length,i+8)]:null,text});
   }
  }else if(Array.isArray(value)){
   if(value.length>MAX_FILE_CHUNKS)throw Error('chunk_limit');
   for(let i=value.length-1;i>=0;i--)stack.push({value:value[i],at:`${at}/${i}`,key:'',depth:depth+1});
  }else if(value&&typeof value==='object'){
   const entries=Object.entries(value);
   if(entries.length>MAX_FILE_CHUNKS)throw Error('chunk_limit');
   for(let i=entries.length-1;i>=0;i--){const [k,v]=entries[i];if(mask(k)!==k)throw Error('redaction_unsafe');stack.push({value:v,at:`${at}/${k.replaceAll('~','~0').replaceAll('/','~1')}`,key:k,depth:depth+1});}
  }else if(typeof value==='number'||typeof value==='boolean')push({...file,pointer:at||'/',lines:null,text:`${at.split('/').pop()} ${value}`});
 }
 return out;
}

// used_bytes is the UTF-8 size of the complete compact JSON response, including
// this counter. Reach its fixed point when a digit boundary changes that size.
function responseBytes(out) {
 for(let i=0;i<5;i++){
  const bytes=Buffer.byteLength(JSON.stringify(out));
  if(bytes===out.used_bytes)return bytes;
  out.used_bytes=bytes;
 }
 return Buffer.byteLength(JSON.stringify(out));
}
function boundedResponse(out,budget) {
 // Keep useful evidence before individual metadata rows. Totals remain explicit
 // when the pointer lists themselves cannot fit in the complete response.
 while(responseBytes(out)>budget){
  if(out.omitted.length){out.omitted.pop();out.metadata_omitted.omitted++;}
  else if(out.skipped.length){out.skipped.pop();out.metadata_omitted.skipped++;}
  else if(out.hits.length){out.hits.pop();out.omitted_count++;out.metadata_omitted.omitted++;}
  else throw Error('EVIDENCE_RESPONSE_BUDGET: required response metadata exceeds byte_budget; shorten the query or increase the budget');
 }
 return out;
}

// Pull search: in-memory BM25 rebuilt on every call, so it cannot serve stale text.
// Whole hits are omitted rather than truncated; metadata overflow has explicit counts.
export function evidenceSearch(state,dir,query,{limit=8,byteBudget=12000,round=null}={}) {
 const terms=[...new Set(tokens(query??''))];
 if(!terms.length)throw Error('EVIDENCE_QUERY_EMPTY: supply a query with at least one word');
 if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw Error('EVIDENCE_LIMIT_INVALID: limit must be 1-50');
 if(!Number.isSafeInteger(byteBudget)||byteBudget<512||byteBudget>200000)throw Error('EVIDENCE_BUDGET_INVALID: byte_budget must be 512-200000');
 if(round!==null&&!(Number.isSafeInteger(round)&&round>=0))throw Error('EVIDENCE_ROUND_INVALID');
 const docs=[],skipped=[];let total=0;
 for(const name of fs.readdirSync(dir).filter(f=>SEARCHABLE.test(f)).sort()){
  if(round!==null&&!name.startsWith('consult-result-')&&roundOf(name)!==round)continue;
  const a=artifact(dir,name);
  if(a.status!=='present'){skipped.push({file:name,reason:a.reason??a.status});continue;}
  if(total+a.bytes>MAX_TOTAL){skipped.push({file:name,reason:'total_budget'});continue;}
  total+=a.bytes;
  const provenance=consultRound(state,dir,name,a.value);
  if(provenance.reason){skipped.push({file:name,reason:provenance.reason});continue;}
  if(round!==null&&provenance.round!==round)continue;
  try{docs.push(...chunks({file:name,sha256:a.sha256,round:provenance.round},a.value,MAX_CHUNKS-docs.length));}
  catch(e){skipped.push({file:name,reason:['depth_limit','chunk_limit'].includes(e.message)?e.message:'redaction_unsafe'});}
 }
 const tf=docs.map(d=>{const m=new Map();for(const t of tokens(`${d.pointer} ${d.text}`))m.set(t,(m.get(t)??0)+1);return m;});
 const lengths=tf.map(m=>[...m.values()].reduce((a,b)=>a+b,0)),avg=lengths.reduce((a,b)=>a+b,0)/(lengths.length||1);
 const df=new Map(terms.map(t=>[t,tf.filter(m=>m.has(t)).length]));
 const scored=[];
 docs.forEach((d,i)=>{
  let score=0;
  for(const t of terms){
   const f=tf[i].get(t);if(!f)continue;
   const idf=Math.log(1+(docs.length-df.get(t)+0.5)/(df.get(t)+0.5));
   score+=idf*f*2.2/(f+1.2*(0.25+0.75*lengths[i]/(avg||1)));
  }
  if(score>0)scored.push({...d,score:Math.round(score*1000)/1000});
 });
 scored.sort((a,b)=>b.score-a.score||a.file.localeCompare(b.file)||a.pointer.localeCompare(b.pointer));
 const out={revision:1,authoritative:false,task_id:state.task_id,query:terms,hits:[],omitted:[],omitted_count:0,
  more_matches:Math.max(0,scored.length-limit),searched_files:new Set(docs.map(d=>d.file)).size,
  skipped,skipped_count:skipped.length,metadata_omitted:{omitted:0,skipped:0},byte_budget:byteBudget,used_bytes:0,
  note:'Display only. Read the evidence packet first; verify raw files by sha256. Metadata overflow is counted.'};
 // Choose whole hits against the minimum envelope with explicit metadata counts.
 // Final compaction retains individual metadata rows only while space permits.
 for(const h of scored.slice(0,limit)){
  out.hits.push(h);
  const minimum={...out,omitted:[],skipped:[],metadata_omitted:{omitted:out.omitted_count,skipped:out.skipped_count}};
  if(responseBytes(minimum)>byteBudget){out.hits.pop();out.omitted.push({file:h.file,sha256:h.sha256,pointer:h.pointer,lines:h.lines,score:h.score});out.omitted_count++;}
 }
 return boundedResponse(out,byteBudget);
}
