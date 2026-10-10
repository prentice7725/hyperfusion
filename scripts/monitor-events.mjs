// 범용 워커 감시의 이벤트 정규화. 모델 호출은 하지 않는다.
// CLI가 보낸 식별자·종류·지시는 신뢰하지 않는다. 컨트롤러가 부여한 identity만 쓴다.

export const EVENT_VERSION=1;
export const EVENT_KINDS=['process_started','output_seen','tool_started','tool_finished','waiting','permission_denied','authentication_error','rate_limited','diagnostic','process_exited','timeout','interrupted'];
export const EVENT_SOURCES=['bridge','verified-cli-stream','verified-hook','stderr-heuristic'];
export const EVENT_CONFIDENCE=['verified','inferred','unknown'];
export const MONITOR_STATES=['STARTING','ACTIVE','QUIET','WAITING','EXITED','ERROR','UNKNOWN'];
const KIND_SET=new Set(EVENT_KINDS);
const SOURCE_SET=new Set(EVENT_SOURCES);
const CONFIDENCE_SET=new Set(EVENT_CONFIDENCE);
const ONCE=new Set(['process_started','process_exited','timeout','interrupted']);

const isObject=v=>!!v&&typeof v==='object'&&!Array.isArray(v);

export function boundDetail(value,max=240) {
 const text=typeof value==='string'?value:value==null?'':JSON.stringify(value);
 return text.length>max?text.slice(0,max)+'…':text;
}

// CLI JSON은 비신뢰 데이터다. kind/식별자를 채택하지 않고 진단 문자열로만 남긴다.
export function untrustedLine(line) {
 const text=boundDetail(line,240);
 if(!text.trim())return null;
 let parsed=null;
 try{parsed=JSON.parse(line);}catch{/* 자유 텍스트 */}
 if(isObject(parsed)){
  return {kind:'diagnostic',source:'stderr-heuristic',confidence:'unknown',detail:text,cli_claimed_kind:typeof parsed.kind==='string'?boundDetail(parsed.kind,40):null};
 }
 return {kind:'diagnostic',source:'stderr-heuristic',confidence:'unknown',detail:text,cli_claimed_kind:null};
}

export function controllerEvent(identity,fields,receivedAt) {
 if(!identity||typeof identity.task_id!=='string'||!Number.isSafeInteger(identity.round)||typeof identity.run_id!=='string'||typeof identity.executor!=='string'||!['implement','review','consult'].includes(identity.role)){
  throw Object.assign(Error('Monitor identity must be controller-issued'),{code:'MONITOR_IDENTITY'});
 }
 const kind=fields.kind;
 const source=fields.source;
 const confidence=fields.confidence;
 if(!KIND_SET.has(kind)||!SOURCE_SET.has(source)||!CONFIDENCE_SET.has(confidence)){
  throw Object.assign(Error('Monitor event is not in the version 1 schema'),{code:'MONITOR_SCHEMA'});
 }
 if(kind==='waiting'&&!(source==='verified-cli-stream'||source==='verified-hook')&&confidence==='verified'){
  throw Object.assign(Error('WAITING requires a verified stream or hook'),{code:'MONITOR_SCHEMA'});
 }
 return {
  version:EVENT_VERSION,
  task_id:identity.task_id,
  round:identity.round,
  run_id:identity.run_id,
  executor:identity.executor,
  role:identity.role,
  at:receivedAt,
  kind,source,confidence,
  detail:boundDetail(fields.detail??'',240),
  event_id:typeof fields.event_id==='string'?boundDetail(fields.event_id,120):null,
  provider_at:confidence==='verified'&&typeof fields.provider_at==='string'&&Number.isFinite(Date.parse(fields.provider_at))?fields.provider_at:null,
  stream:fields.stream??null
 };
}

export function dedupKey(event) {
 if(ONCE.has(event.kind))return event.kind;
 if(event.confidence==='verified'&&event.event_id)return event.kind+'\0'+event.event_id;
 if(event.kind==='waiting'||event.kind==='permission_denied'||event.kind==='authentication_error'||event.kind==='rate_limited')return event.kind+'\0'+event.detail;
 return null;
}

// 종료 코드 0이고 시그널이 없을 때만 정상 종료로 본다. 그것도 작업 성공은 아니다.
export function exitFailed(detail) {
 const code=/code=(-?\d+|null)/.exec(detail)?.[1];
 const signal=/signal=(\S*)/.exec(detail)?.[1]??'';
 return !(code==='0'&&signal==='');
}

// 수신 시각 기준으로만 상태를 옮긴다. 출력이 없다는 이유만으로 WAITING/ERROR가 되지 않는다.
export function reduceMonitor(prev,event,{quietMs=120000}={}) {
 const current=prev??{state:'UNKNOWN',last_activity_at:null,started_at:event.at,exited:false,error:false,verified_tools:0,has_verified_stream:false,alert_class:null};
 if(current.last_observed_at&&Date.parse(event.at)<Date.parse(current.last_observed_at))return current;
 if(current.exited&&event.kind!=='process_exited')return current;
 let state=current.state;
 let last=current.last_activity_at;
 let alert=current.alert_class;
 let verifiedTools=current.verified_tools;
 let verifiedStream=current.has_verified_stream;
 let exited=current.exited;
 let error=current.error;
 if(event.confidence==='verified'&&(event.source==='verified-cli-stream'||event.source==='verified-hook'))verifiedStream=true;
 if(event.kind==='tool_finished'&&event.confidence==='verified')verifiedTools++;
 const activity=event.kind==='output_seen'||(event.kind==='tool_started'&&event.confidence==='verified')||(event.kind==='tool_finished'&&event.confidence==='verified');
 if(event.kind==='process_started'){
  if(!last)last=event.at;
  if(!exited&&!error)state='STARTING';
 }else if(event.kind==='waiting'&&event.confidence==='verified'&&!exited&&!error){
  state='WAITING';alert='attention';last=event.at;
 }else if(event.kind==='permission_denied'||event.kind==='authentication_error'||event.kind==='rate_limited'){
  alert='attention';
  if(event.confidence==='verified'){state='ERROR';error=true;}
 }else if(event.kind==='timeout'||event.kind==='interrupted'){
  state='ERROR';error=true;alert='attention';
 }else if(event.kind==='process_exited'){
  exited=true;
  if(exitFailed(event.detail)){state='ERROR';error=true;alert='attention';}
  else if(!error)state='EXITED';
 }else if(event.kind==='diagnostic'&&event.detail===''&&!exited&&!error&&state!=='WAITING'&&state!=='ERROR'){
  const silentFor=last?Date.parse(event.at)-Date.parse(last):0;
  if(Number.isFinite(silentFor)&&silentFor>=quietMs){state='QUIET';alert=alert??'suspicion';}
 }
 if(activity){
  last=event.at;
  if(!exited&&!error&&state!=='WAITING')state='ACTIVE';
 }
 return {state,last_activity_at:last,last_observed_at:event.at,started_at:current.started_at??event.at,exited,error,verified_tools:verifiedTools,has_verified_stream:verifiedStream,alert_class:alert};
}

// 완전한 UTF-8 코드포인트와 완전한 NDJSON 줄만 꺼낸다. 나머지는 버퍼에 둔다.
export function createFrameParser({maxPending=1024*1024}={}) {
 if(!Number.isSafeInteger(maxPending)||maxPending<1)throw Error('Invalid frame buffer limit');
 let buf=Buffer.alloc(0);
 let overflow=false;
 let dropping=false;
 return {
  overflowed:()=>overflow,
  pending:()=>buf.length,
  push(chunk){
   const next=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
   const lines=[];
   let offset=0;
   while(offset<next.length){
    const newline=next.indexOf(10,offset);
    const end=newline<0?next.length:newline;
    const piece=next.subarray(offset,end);
    if(!dropping){
     if(buf.length+piece.length>maxPending){overflow=true;dropping=true;buf=Buffer.alloc(0);}
     else buf=Buffer.concat([buf,piece]);
    }
    if(newline<0)break;
    if(!dropping){
     // Decode only whole lines: UTF-8 bytes and CRLF may span any chunk boundary.
     const text=buf.toString('utf8').replace(/\r$/,'');
     if(text)lines.push(text);
    }
    buf=Buffer.alloc(0);dropping=false;offset=newline+1;
   }
   return {lines,overflow};
  },
  flush(){
   buf=Buffer.alloc(0);dropping=false;
   return {lines:[],overflow};
  }
 };
}
