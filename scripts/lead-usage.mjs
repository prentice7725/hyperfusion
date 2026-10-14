import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {isMain} from './platform.mjs';
import {read,atomic,hash} from './artifact.mjs';
import {controlPath,ensureControl,acquireLock} from './control-dir.mjs';
import {refreshHostUsage} from './metrics.mjs';

const MAX_BYTES=64*1024*1024;
const numeric=v=>Number.isSafeInteger(v)&&v>=0;
const optional=f=>fs.existsSync(f)?read(f):null;
const windowFile=(root,id)=>controlPath(root,'tasks',id,'host-usage-window.json');
const usageFile=(root,id)=>controlPath(root,'tasks',id,'lead-usage.json');

export function hookRoot(cwd) {
 if(typeof cwd!=='string')return null;
 for(let dir=path.resolve(cwd);;){
  if(fs.existsSync(path.join(dir,'.git')))return dir;
  const up=path.dirname(dir);if(up===dir)return null;dir=up;
 }
}

// Context contains identifiers/timestamps only, never the prompt or transcript.
export function rememberHost(root,input,at=Date.now()) {
 if(typeof input.session_id!=='string'||!input.session_id)return;
 const file=controlPath(root,'host-session.json'),prior=optional(file);
 const session=hash(input.session_id);
 const fresh=input.hook_event_name==='UserPromptSubmit'||prior?.session!==session;
 atomic(file,{session,turn_started_at:fresh?new Date(at).toISOString():prior.turn_started_at,observed_at:new Date(at).toISOString()});
 const tasks=controlPath(root,'tasks');
 if(fs.existsSync(tasks))for(const item of fs.readdirSync(tasks,{withFileTypes:true})){
  if(!item.isDirectory())continue;const w=optional(windowFile(root,item.name));
  if(w?.benchmark&&!w.ended_at)atomic(windowFile(root,item.name),{...w,sessions:[...new Set([...(w.sessions??[]),session])]});
 }
 const state=optional(controlPath(root,'state.json'));
 if(state&&!['CLOSE','BLOCKED','ARCHIVED'].includes(state.phase)){
  const window=optional(windowFile(root,state.task_id));
  if(window&&!window.ended_at){
   const sessions=[...new Set([...(window.sessions??(window.session?[window.session]:[])),session])];
   atomic(windowFile(root,state.task_id),{...window,sessions,...(!window.session?{session,scope:'controller-window',late_binding:true}:{})});
  }
 }
}

// The init controller freezes the host binding. A repository config cannot bind
// a transcript, and another session's Stop cannot claim this task's usage.
export function recordHostWindow(root,state) {
 const file=windowFile(root,state.task_id),prior=optional(file),context=optional(controlPath(root,'host-session.json'));
 const started=Date.parse(state.started_at);
 const anchor=context?Date.parse(context.turn_started_at):NaN;
 const base=prior??{task_id:state.task_id,session:context?.session??null,sessions:context?[context.session]:[],
  started_at:new Date(Number.isFinite(anchor)&&anchor<=started?anchor:started).toISOString(),
  controller_started_at:state.started_at,scope:Number.isFinite(anchor)&&anchor<=started?'prompt-to-terminal':'controller-window'};
 // Sequential tasks in one turn cannot all claim the same planning request.
 if(!prior&&base.session){
  const dir=controlPath(root,'tasks');
  for(const item of fs.readdirSync(dir,{withFileTypes:true})){
   if(!item.isDirectory()||item.name===state.task_id)continue;
   const older=optional(windowFile(root,item.name));
   if((older?.sessions??[older?.session]).includes(base.session)&&older.ended_at&&Date.parse(older.ended_at)<=started&&Date.parse(older.ended_at)>Date.parse(base.started_at))base.started_at=older.ended_at;
  }
 }
 atomic(file,{...base,ended_at:base.benchmark?(prior?.ended_at??null):state.ended_at??state.closed_at??prior?.ended_at??null});
}

// Claude transcripts can contain several content-block rows for one API
// message. Use component maxima per message ID, not a sum of duplicate rows.
// The JSONL format is local observational evidence, not a billing API.
export function transcriptMessages(text,sessionId,forcedRole=null) {
 const session=hash(sessionId),groups=new Map();
 const lines=text.replace(/^\uFEFF/,'').split('\n');
 if(lines.at(-1)==='')lines.pop();
 for(const [lineIndex,line] of lines.entries()){
  if(!line.trim())continue;
  let row;try{row=JSON.parse(line);}catch{if(lineIndex===lines.length-1&&!text.endsWith('\n'))continue;throw Error('HOST_USAGE_TRANSCRIPT_INCOMPLETE');}
  if(row.type!=='assistant')continue;
  if(typeof row.sessionId!=='string'||hash(row.sessionId)!==session)continue;
  const message=row.message,at=Date.parse(row.timestamp);
  if(row.isApiErrorMessage===true||message?.model==='<synthetic>')continue;
  if(typeof message?.id!=='string'||!message.id||!Number.isFinite(at))throw Error('HOST_USAGE_UNRECOGNIZED_ROW');
  const role=forcedRole??(row.isSidechain===true||row.isSubagent===true?'subagent':'lead');
  const id=hash(JSON.stringify([role,message.id])),usage=message.usage;
  const tokens={input_tokens:usage?.input_tokens,output_tokens:usage?.output_tokens,
   cache_read_input_tokens:usage?.cache_read_input_tokens??0,cache_creation_input_tokens:usage?.cache_creation_input_tokens??0};
  const valid=Object.values(tokens).every(numeric)&&typeof message.model==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(message.model);
  const old=groups.get(id);
  if(old&&valid&&old.model&&old.model!==message.model)throw Error('HOST_USAGE_MODEL_CONFLICT');
  const merged=old??{id,role,model:null,first_at:at,last_at:at,valid:false,tokens:{}};
  merged.first_at=Math.min(merged.first_at,at);merged.last_at=Math.max(merged.last_at,at);
  if(valid){merged.valid=true;merged.model=message.model;for(const [k,v] of Object.entries(tokens))merged.tokens[k]=Math.max(merged.tokens[k]??0,v);}
  groups.set(id,merged);
 }
 return [...groups.values()];
}

// Persist token metadata only, not transcript text or filesystem paths. Re-read
// the unfinished suffix on append; rotate/truncate/rewrite resets the cache.
export function readTranscriptIncremental(root,file,sessionId,forcedRole=null) {
 if(fs.lstatSync(file).isSymbolicLink())throw Error('HOST_USAGE_TRANSCRIPT_SYMLINK');
 const st=fs.statSync(file);
 if(!st.isFile())throw Error('HOST_USAGE_TRANSCRIPT_LIMIT');
 const cacheFile=controlPath(root,'host-transcripts',hash(JSON.stringify([fs.realpathSync(file),sessionId,forcedRole]))+'.json');
 let cache=optional(cacheFile),offset=cache?.offset??0;
 const fd=fs.openSync(file,'r');
 try{
  const anchorAt=Math.max(0,offset-256),anchor=Buffer.alloc(offset-anchorAt);
  fs.readSync(fd,anchor,0,anchor.length,anchorAt);
  if(!cache||cache.version!==1||cache.dev!==st.dev||cache.ino!==st.ino||st.size<offset||hash(anchor)!==cache.anchor
    ||(st.size===cache.size&&st.mtimeMs!==cache.mtimeMs)) {cache=null;offset=0;}
  const length=st.size-offset;
  if(length>MAX_BYTES)throw Error('HOST_USAGE_TRANSCRIPT_LIMIT');
  const chunk=Buffer.alloc(length);
  if(fs.readSync(fd,chunk,0,length,offset)!==length)throw Error('HOST_USAGE_TRANSCRIPT_CHANGED');
  const complete=chunk.lastIndexOf(10)+1;
  // Parsing may observe a complete final JSON object without a newline; its
  // bytes remain unconsumed until newline so subsequent appends remain sound.
  const added=transcriptMessages(chunk.toString('utf8'),sessionId,forcedRole);
  const groups=new Map((cache?.messages??[]).map(m=>[m.id,m]));
  for(const m of added){
   const old=groups.get(m.id);
   if(old){
    if(old.valid&&m.valid&&old.model!==m.model)throw Error('HOST_USAGE_MODEL_CONFLICT');
    m.first_at=Math.min(old.first_at,m.first_at);m.last_at=Math.max(old.last_at,m.last_at);
    if(old.valid){m.model=old.model;m.valid=true;for(const [k,v] of Object.entries(old.tokens))m.tokens[k]=Math.max(m.tokens[k]??0,v);}
   }
   groups.set(m.id,m);
  }
  if(groups.size>100000)throw Error('HOST_USAGE_TRANSCRIPT_LIMIT');
  offset+=complete;
  const nextAnchor=Buffer.alloc(Math.min(256,offset));fs.readSync(fd,nextAnchor,0,nextAnchor.length,offset-nextAnchor.length);
  let incompleteTail=false;
  const suffix=chunk.subarray(complete).toString('utf8').trim();
  if(suffix){try{JSON.parse(suffix);}catch{incompleteTail=true;}}
  atomic(cacheFile,{version:1,dev:st.dev,ino:st.ino,size:st.size,mtimeMs:st.mtimeMs,offset,anchor:hash(nextAnchor),messages:[...groups.values()]});
  const messages=[...groups.values()];messages.incompleteTail=incompleteTail;return messages;
 }finally{fs.closeSync(fd);}
}

export function collectHostUsage(root,input,{at=Date.now()}={}) {
 if(!['Stop','SessionEnd','StopFailure'].includes(input.hook_event_name))return {status:'ignored'};
 if(typeof input.session_id!=='string'||!input.session_id||typeof input.transcript_path!=='string')return {status:'unavailable',reason:'missing session or transcript path'};
 const transcript=input.transcript_path.startsWith('~/')?path.join(os.homedir(),input.transcript_path.slice(2)):input.transcript_path;
 const messages=readTranscriptIncremental(root,transcript,input.session_id);
 let incompleteTail=messages.incompleteTail;
 // Claude Code keeps subagent transcripts alongside the parent session file.
 if(/^[A-Za-z0-9_-]+$/.test(input.session_id)){
  const children=path.join(path.dirname(transcript),input.session_id,'subagents');
  if(fs.existsSync(children)){
   if(fs.lstatSync(children).isSymbolicLink())throw Error('HOST_USAGE_TRANSCRIPT_SYMLINK');
   const files=fs.readdirSync(children).filter(n=>/^agent-[A-Za-z0-9_-]+\.jsonl$/.test(n));
   if(files.length>256)throw Error('HOST_USAGE_TRANSCRIPT_LIMIT');
   for(const name of files){const rows=readTranscriptIncremental(root,path.join(children,name),input.session_id,'subagent');messages.push(...rows);incompleteTail||=rows.incompleteTail;}
  }
 }
 const session=hash(input.session_id),dir=controlPath(root,'tasks');
 if(!fs.existsSync(dir))return {status:'ignored'};
 const windows=fs.readdirSync(dir,{withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>optional(windowFile(root,d.name)))
  .filter(w=>(w?.sessions??[w?.session]).includes(session)).sort((a,b)=>Date.parse(a.controller_started_at)-Date.parse(b.controller_started_at));
 const ownersFile=controlPath(root,'host-usage-owners.json'),owners=optional(ownersFile)??{};
 const collected=[];
 for(const [index,w] of windows.entries()){
  const ended=w.ended_at!==null;
  // Include the closing summary on the first terminal Stop only. Subsequent
  // prompts or SessionEnd must not extend a finished task's collection window.
  const end=w.collected_end_at??(ended&&index===windows.length-1?new Date(at).toISOString():w.ended_at??new Date(at).toISOString());
  const start=Date.parse(w.started_at),until=Date.parse(end);
  const selected=messages.filter(m=>m.last_at>=start&&m.first_at<=until&&(!owners[m.id]||owners[m.id]===w.task_id));
  if(!selected.length||selected.some(m=>!m.valid)){collected.push({task_id:w.task_id,status:'unavailable'});continue;}
  const prior=optional(usageFile(root,w.task_id));
  const segments={...(prior?.segments??{}),[session]:selected.map(m=>({id:m.id,role:m.role??'lead',model:m.model,tokens:m.tokens}))};
  const merged=new Map();
  for(const m of Object.values(segments).flat()){
   const old=merged.get(m.id);
   if(old&&old.model!==m.model)throw Error('HOST_USAGE_MODEL_CONFLICT');
   const value=old??{...m,tokens:{...m.tokens}};
   for(const [key,n] of Object.entries(m.tokens))value.tokens[key]=Math.max(value.tokens[key]??0,n);
   merged.set(m.id,value);
  }
  const empty=()=>({input_tokens:0,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0});
  const totals=empty(),models={},roles={lead:empty(),subagent:empty()};
  for(const m of merged.values()){
   owners[m.id]=w.task_id;models[m.model]??={tokens:0,components:empty()};
   for(const [key,value] of Object.entries(m.tokens)){totals[key]+=value;roles[m.role??'lead'][key]+=value;models[m.model].tokens+=value;models[m.model].components[key]+=value;}
  }
  const lead_tokens=Object.values(totals).reduce((a,b)=>a+b,0);
  if(!numeric(lead_tokens))throw Error('HOST_USAGE_TOKEN_OVERFLOW');
  const names=Object.keys(models);
  const observation={source:'Claude Code local transcript',source_kind:'claude-transcript',lead_tokens,
   lead_model:names.length===1?names[0]:null,by_model:models,components:totals,by_role:roles,subagent_tokens:Object.values(roles.subagent).reduce((a,b)=>a+b,0),
   complete:ended&&!incompleteTail,transcript_complete:!incompleteTail,scope:w.scope,window:{started_at:w.started_at,ended_at:end},session,segments,
   message_count:merged.size,collected_at:new Date(at).toISOString(),
   note:'Client-reported usage. Boundary-spanning API messages are attributed once to the first overlapping task; not billed cost.'};
  atomic(usageFile(root,w.task_id),observation);
  if(ended){atomic(windowFile(root,w.task_id),{...w,collected_end_at:end});refreshHostUsage(root,w.task_id,observation);}
  collected.push({task_id:w.task_id,status:observation.complete?'recorded':'partial',lead_tokens});
 }
 atomic(ownersFile,owners);
 return {status:'collected',tasks:collected};
}

export function usageHook(input) {
 const root=hookRoot(input?.cwd);if(!root)return {status:'ignored'};
 ensureControl(root);
 const unlock=acquireLock(controlPath(root,'locks/control.lock'));
 try{
  if(['SessionStart','UserPromptSubmit','PreToolUse'].includes(input.hook_event_name)){
   rememberHost(root,input);return {status:'bound'};
  }
  return collectHostUsage(root,input);
 }finally{unlock();}
}

if(isMain(import.meta.url)){
 try{
  const input=JSON.parse(fs.readFileSync(0,'utf8').replace(/^\uFEFF/,''));
  const result=usageHook(input);
  if(process.argv[2]!=='--hook')console.log(JSON.stringify(result));
 }catch(e){
  // Optional accounting cannot block Stop/SessionEnd, or expose transcript text.
  console.error('HyperFusion host usage unavailable: '+(e.code==='LOCK_BUSY'?'controller busy':String(e.message).startsWith('HOST_USAGE_')?e.message:'could not read usage evidence'));
  if(process.argv[2]!=='--hook')process.exitCode=1;
 }
}
