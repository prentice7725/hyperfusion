// 모든 구현·리뷰·상담 프로세스가 지나는 공통 감시.
// 성공을 선언하지 않고, 모델도 호출하지 않는다. 관측과 파일 기록만 한다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {redactText} from './redaction.mjs';
import {isMain,renameWithRetry} from './platform.mjs';
import {assertPlainDir} from './control-dir.mjs';
import {controllerEvent,createFrameParser,dedupKey,reduceMonitor,untrustedLine} from './monitor-events.mjs';

const FILE_MODE=0o600;
const DIR_MODE=0o700;

function ensureDir(dir) {
 assertPlainDir(dir);
 fs.mkdirSync(dir,{recursive:true,mode:DIR_MODE});
 try{fs.chmodSync(dir,DIR_MODE);}catch{/* Windows에서는 POSIX 권한이 강제되지 않는다. */}
}

function writeAtomic(file,value) {
 ensureDir(path.dirname(file));
 const tmp=file+'.'+crypto.randomUUID()+'.tmp';
 const fd=fs.openSync(tmp,'wx',FILE_MODE);
 try{
  fs.writeFileSync(fd,JSON.stringify(value)+'\n');
  fs.fsyncSync(fd);
 }finally{fs.closeSync(fd);}
 try{fs.chmodSync(tmp,FILE_MODE);}catch{/* 같은 이유 */}
 try{renameWithRetry(tmp,file);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
 try{fs.chmodSync(file,FILE_MODE);}catch{/* 같은 이유 */}
}

function boundedRead(file,maxBytes) {
 if(!fs.existsSync(file))return null;
 const st=fs.lstatSync(file);
 if(st.isSymbolicLink()||!st.isFile()||st.size>maxBytes)throw Error('MONITOR_STORAGE: unsafe or oversized monitor file');
 return fs.readFileSync(file,'utf8');
}

// Only expired terminal observations are pruned; task/result/launch evidence is never removed.
export function pruneMonitors(dir,{retentionMs=30*86400000,now=Date.now(),exclude=null}={}) {
 if(!Number.isSafeInteger(retentionMs)||retentionMs<1)throw Error('Invalid monitor retention');
 ensureDir(dir);const removed=[];
 for(const name of fs.readdirSync(dir).filter(n=>/^monitor-[\w-]+\.json$/.test(n))){
  const tag=name.slice(8,-5);if(tag===exclude)continue;
  let view;try{view=JSON.parse(boundedRead(path.join(dir,name),512*1024));}catch{continue;}
  if(!view||!['EXITED','ERROR'].includes(view.state)||!Number.isFinite(Date.parse(view.updated_at))||now-Date.parse(view.updated_at)<retentionMs)continue;
  // ERROR can still be a living process (permission/rate-limit); require an observed exit.
  if(view.state==='ERROR'&&view.checkpoint?.reduced?.exited!==true)continue;
  for(const prefix of ['monitor','activity','alerts']){
   const file=path.join(dir,`${prefix}-${tag}.${prefix==='activity'?'ndjson':'json'}`);
   if(fs.existsSync(file)&&fs.lstatSync(file).isFile()&&!fs.lstatSync(file).isSymbolicLink())fs.unlinkSync(file);
  }
  removed.push(tag);
 }
 return removed;
}

export function openMonitor({dir,tag,identity,quietMs=120000,maxRecords=400,maxBytes=256*1024,maxAlerts=64,maxSeen=512,retentionMs=30*86400000,now=()=>new Date()}={}) {
 if(!dir||!tag||!/^[\w-]+$/.test(tag))throw Object.assign(Error('Monitor tag must be a single path segment'),{code:'MONITOR_PATH'});
 for(const value of [quietMs,maxRecords,maxBytes,maxAlerts,maxSeen])if(!Number.isSafeInteger(value)||value<1)throw Error('Invalid monitor limit');
 if(maxRecords>10000||maxBytes>16*1024*1024||maxAlerts>256||maxSeen<4||maxSeen>1024)throw Error('Invalid monitor limit: exceeds bounded storage capacity');
 controllerEvent(identity,{kind:'diagnostic',source:'bridge',confidence:'unknown'},new Date(now()).toISOString());
 ensureDir(dir);
 pruneMonitors(dir,{retentionMs,now:new Date(now()).getTime(),exclude:tag});
 const activity=path.join(dir,`activity-${tag}.ndjson`);
 const summaryPath=path.join(dir,`monitor-${tag}.json`);
 const alertsPath=path.join(dir,`alerts-${tag}.json`);
 const raw=boundedRead(activity,maxBytes);
 const savedText=boundedRead(summaryPath,512*1024);
 const saved=savedText?JSON.parse(savedText):null;
 const matches=v=>v&&['task_id','round','run_id','executor','role'].every(k=>v[k]===identity[k]);
 if(saved&&!matches(saved))throw Error('MONITOR_IDENTITY: existing run identity differs');
 const events=(raw??'').split(/\r?\n/).filter(Boolean).map(line=>{try{return JSON.parse(line);}catch{return null;}}).filter(Boolean);
 if(events.some(e=>!matches(e)))throw Error('MONITOR_IDENTITY: activity run identity differs');
 const checkpoint=saved?.checkpoint;
 const seen=new Set((checkpoint?.seen??events.map(dedupKey).filter(Boolean)).slice(-maxSeen));
 let records=events.length;
 let bytes=fs.existsSync(activity)?fs.statSync(activity).size:0;
 let reduced=checkpoint?.reduced??events.reduce((state,event)=>reduceMonitor(state,event,{quietMs}),null);
 let truncated=saved?.truncated??false;
 let lastEvent=checkpoint?.lastEvent??events.at(-1)??null;
 let stdoutBytes=saved?.stdout_bytes??0;
 let stderrBytes=saved?.stderr_bytes??0;
 const outputNoted=checkpoint?.outputNoted??{stdout:false,stderr:false};
 const savedAlerts=boundedRead(alertsPath,512*1024);
 const alertRecord=savedAlerts?JSON.parse(savedAlerts):null;
 if(alertRecord&&alertRecord.run_id!==identity.run_id)throw Error('MONITOR_IDENTITY: alerts run identity differs');
 const alerts=(alertRecord?.alerts??[]).slice(-maxAlerts);
 function addAlert(alert){
  if(alerts.some(a=>a.key===alert.key))return;
  if(alerts.length>=maxAlerts)alerts.shift();
  alerts.push(alert);
 }
 function remember(key){
  if(!key)return;
  if(seen.size>=maxSeen){
   // Keep once-only terminal keys; evict an older per-event key.
   const oldest=[...seen].find(k=>!['process_started','process_exited','timeout','interrupted'].includes(k));
   if(oldest)seen.delete(oldest);else return;
  }
  seen.add(key);
 }
 const parser=createFrameParser();
 const iso=t=>t instanceof Date?t.toISOString():new Date(t).toISOString();

 function snapshot() {
  const at=iso(now());
  const lastAt=reduced?.last_activity_at??at;
  const started=reduced?.started_at??at;
  const age=Math.max(0,Date.parse(at)-Date.parse(lastAt));
  return {
   version:1,
   updated_at:at,
   started_at:reduced?.started_at??null,
   last_activity_at:reduced?.last_activity_at??null,
   task_id:identity.task_id,
   round:identity.round,
   run_id:identity.run_id,
   executor:identity.executor,
   role:identity.role,
   state:reduced?.state??'UNKNOWN',
   elapsed_ms:Math.max(0,Date.parse(at)-Date.parse(started)),
   last_activity_age_ms:Number.isFinite(age)?age:null,
   observed_tool_calls:reduced?.has_verified_stream?reduced.verified_tools:null,
   last_event:lastEvent?{kind:lastEvent.kind,at:lastEvent.at,source:lastEvent.source,confidence:lastEvent.confidence}:null,
   alert_class:reduced?.alert_class??null,
   telemetry_limited:!(reduced?.has_verified_stream),
   structured_events:'not-enabled',
   cli_stream_assumed:false,
   truncated,
   records,
   dedup_records:seen.size,
   stdout_bytes:stdoutBytes,
   stderr_bytes:stderrBytes,
   declares_success:false,
   task_phase:null
  };
 }

 function persist() {
  const body=snapshot();
  writeAtomic(summaryPath,{...body,checkpoint:{reduced,lastEvent,outputNoted,seen:[...seen]}});
  writeAtomic(alertsPath,{version:1,run_id:identity.run_id,alerts});
  return body;
 }

 function append(event) {
  const key=dedupKey(event);
  if(key&&seen.has(key))return snapshot();
  remember(key);
  lastEvent=event;
  reduced=reduceMonitor(reduced,event,{now:event.at,quietMs});
  if(event.kind==='permission_denied'||event.kind==='authentication_error'||event.kind==='rate_limited'||event.kind==='timeout'||(reduced.alert_class==='suspicion'&&event.kind==='diagnostic'&&event.detail==='')){
   const alertKey=event.kind+'\0'+event.detail;
   addAlert({key:alertKey,class:reduced.alert_class,kind:event.kind,at:event.at,detail:event.detail});
  }
  const line=JSON.stringify(event)+'\n';
  if(truncated||records>=maxRecords||bytes+Buffer.byteLength(line)>maxBytes){
   truncated=true;
   addAlert({key:'truncated',class:'attention',kind:'truncated',at:event.at,detail:'activity log hit its record or byte cap'});
   return persist();
  }
  if(!fs.existsSync(activity))fs.writeFileSync(activity,'',{flag:'wx',mode:FILE_MODE});
  fs.appendFileSync(activity,line);
  try{fs.chmodSync(activity,FILE_MODE);}catch{/* Windows */}
  records++;bytes+=Buffer.byteLength(line);
  return persist();
 }

 function emit(fields) {
  let detail=fields.detail??'';
  try{detail=redactText(String(detail),{});}catch{detail='[REDACTED:unreadable]';}
  // 레드액션은 데이터를 가릴 뿐, 그 문자열을 명령으로 실행하지 않는다.
  return append(controllerEvent(identity,{...fields,detail},iso(now())));
 }

 return {
  paths:{activity,summary:summaryPath,alerts:alertsPath},
  started(){return emit({kind:'process_started',source:'bridge',confidence:'verified',detail:'child process spawned'});},
  output(stream,text){
   const n=Buffer.byteLength(String(text??''));
   if(stream==='stderr')stderrBytes+=n;else stdoutBytes+=n;
   const known=stream==='stderr'?'stderr':'stdout';
   if(outputNoted[known]){
    if(reduced&&!reduced.exited&&!reduced.error){
     reduced={...reduced,last_activity_at:iso(now()),state:reduced.state==='QUIET'||reduced.state==='STARTING'?'ACTIVE':reduced.state};
    }
    return persist();
   }
   outputNoted[known]=true;
   return emit({kind:'output_seen',source:stream==='stderr'?'stderr-heuristic':'bridge',confidence:'inferred',detail:`${stream} bytes=${n}`,stream});
  },
  exit({code,signal}){
   const detail=`code=${code} signal=${signal??''}`;
   return emit({kind:'process_exited',source:'bridge',confidence:'verified',detail});
  },
  timeout(detail='supervisor timeout'){return emit({kind:'timeout',source:'bridge',confidence:'verified',detail});},
  interrupt(detail='supervisor interrupt'){return emit({kind:'interrupted',source:'bridge',confidence:'verified',detail});},
  // 어댑터가 공식 스키마로 확인한 이벤트만 verified로 넣는다. 임의 텍스트는 noteUntrusted.
  noteVerified(fields){return emit({...fields,confidence:'verified',source:fields.source??'verified-cli-stream'});},
  noteUntrusted(stream,line){
   const parsed=untrustedLine(line);
   if(!parsed)return snapshot();
   return emit({kind:'diagnostic',source:stream==='stderr'?'stderr-heuristic':'bridge',confidence:'unknown',detail:parsed.detail,stream});
  },
  tick(){
   if(reduced?.exited||reduced?.error)return snapshot();
   const event=controllerEvent(identity,{kind:'diagnostic',source:'bridge',confidence:'inferred',detail:''},iso(now()));
   const next=reduceMonitor(reduced,event,{quietMs});
   if(next.state==='QUIET'&&reduced?.state!=='QUIET'&&!alerts.some(a=>a.kind==='quiet')){
    addAlert({key:'quiet',class:'suspicion',kind:'quiet',at:event.at,detail:'no new signal; not treated as waiting or failure'});
   }
   reduced=next;
   return persist();
  },
  frames(chunk){
   const {lines,overflow}=parser.push(chunk);
   if(overflow&&!truncated){
    truncated=true;
    addAlert({key:'frame-overflow',class:'attention',kind:'truncated',at:iso(now()),detail:'partial frame buffer hit its cap'});
   }
   return lines;
  },
  snapshot,persist
 };
}

export function readRoundMonitors(dir) {
 if(!dir||!fs.existsSync(dir))return [];
 return fs.readdirSync(dir).filter(name=>/^monitor-.+\.json$/.test(name)&&!name.endsWith('.tmp')).sort().map(name=>{
  try{const {checkpoint,...view}=JSON.parse(boundedRead(path.join(dir,name),512*1024));return view;}catch{return {file:name,state:'UNKNOWN',telemetry_limited:true,parse_error:true,declares_success:false};}
 });
}

export function formatWatch(monitors,now=Date.now()) {
 const list=Array.isArray(monitors)?monitors:[];
 if(!list.length)return 'monitors: none\ntelemetry_limited: true\n';
 return list.map(m=>{
  const age=m.last_activity_at&&!['EXITED','ERROR'].includes(m.state)?Math.max(0,now-Date.parse(m.last_activity_at)):m.last_activity_age_ms??null;
  const tools=m.observed_tool_calls==null?'null':String(m.observed_tool_calls);
  return [
   `executor: ${m.executor} role: ${m.role} state: ${m.state}`,
   `elapsed_ms: ${m.elapsed_ms??'null'}`,
   `last_activity_age_ms: ${age??'null'}`,
   `observed_tool_calls: ${tools}`,
   `last_event: ${m.last_event?.kind??'null'}`,
   `alert_class: ${m.alert_class??'null'}`,
   `telemetry_limited: ${m.telemetry_limited===true}`
  ].join('\n');
 }).join('\n---\n')+'\n';
}

if(isMain(import.meta.url)){
 const [dir,flag]=process.argv.slice(2);
 if(!dir||(flag!=='--watch'&&flag!=='--once')){
  console.error('Usage: node scripts/worker-monitor.mjs DIR --once|--watch');
  process.exitCode=1;
 }else{
  const print=()=>process.stdout.write(formatWatch(readRoundMonitors(dir)));
  print();
  if(flag==='--watch'){
   let last='';
   const timer=setInterval(()=>{
    const text=formatWatch(readRoundMonitors(dir));
    if(text!==last){last=text;process.stdout.write(text);}
   },1000);
   const stop=()=>{clearInterval(timer);process.exit(0);};
   process.on('SIGINT',stop);process.on('SIGTERM',stop);
  }
 }
}
