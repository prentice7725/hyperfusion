// AnchorMind MCP 서버(HTTP)를 부르는 최소 클라이언트.
// 도구 인자 이름을 추측하지 않는다. tools/list로 받은 실제 스키마에 있는 이름만 채운다.

const PROTOCOL='2025-06-18';

// JSON 또는 SSE(text/event-stream) 응답에서 JSON-RPC 메시지를 꺼낸다.
async function rpcBody(res,id) {
 const text=await res.text();
 const type=res.headers.get('content-type')??'';
 const messages=type.includes('text/event-stream')
  ?text.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>{try{return JSON.parse(l.slice(5).trim());}catch{return null;}}).filter(Boolean)
  :text.trim()?[JSON.parse(text)]:[];
 const m=messages.find(x=>x.id===id);
 if(!m)throw Error('AnchorMind returned no response for request '+id);
 if(m.error)throw Error('AnchorMind error: '+(m.error.message??JSON.stringify(m.error)));
 return m.result;
}

export class AnchorMind {
 constructor({url=process.env.HF_MEMORY_URL,key=process.env.HF_MEMORY_KEY,timeoutMs=15000}={}) {
  if(!url)throw Error('MEMORY_UNAVAILABLE: set HF_MEMORY_URL (e.g. http://localhost:57332/mcp)');
  this.url=url;this.key=key;this.timeoutMs=timeoutMs;this.session=null;this.nextId=1;this.tools=null;
 }
 async send(method,params,{notify=false}={}) {
  const id=notify?undefined:this.nextId++;
  const headers={'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':PROTOCOL};
  if(this.key)headers.Authorization='Bearer '+this.key;
  if(this.session)headers['Mcp-Session-Id']=this.session;
  const res=await fetch(this.url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',...(notify?{}:{id}),method,params}),signal:AbortSignal.timeout(this.timeoutMs)});
  if(res.status===401||res.status===403)throw Error('MEMORY_UNAVAILABLE: AnchorMind rejected the access key (HF_MEMORY_KEY)');
  if(!res.ok&&!(notify&&res.status===202))throw Error(`AnchorMind HTTP ${res.status}`);
  this.session??=res.headers.get('mcp-session-id');
  return notify?null:rpcBody(res,id);
 }
 async connect() {
  if(this.tools)return this;
  await this.send('initialize',{protocolVersion:PROTOCOL,capabilities:{},clientInfo:{name:'hyperfusion',version:'0.6.0'}});
  await this.send('notifications/initialized',{}, {notify:true});
  const list=await this.send('tools/list',{});
  this.tools=Object.fromEntries((list.tools??[]).map(t=>[t.name,t.inputSchema??{}]));
  return this;
 }
 // 우리 쪽 이름(canonical)을 서버 스키마의 실제 이름으로 옮긴다. 별칭 후보 중 스키마에 있는 첫 이름을 쓴다.
 shape(tool,canonical,aliases) {
  const schema=this.tools?.[tool];
  if(!schema)throw Error(`MEMORY_UNAVAILABLE: AnchorMind has no '${tool}' tool`);
  const props=schema.properties??{},args={};
  for(const [k,v] of Object.entries(canonical)){
   if(v===undefined)continue;
   const name=(aliases[k]??[k]).find(n=>n in props);
   if(name)args[name]=typeof v==='function'?v(props[name]):v;
  }
  const missing=(schema.required??[]).filter(r=>!(r in args));
  if(missing.length)throw Error(`AnchorMind '${tool}' requires ${missing.join(', ')} which HyperFusion cannot fill; check the server version`);
  return args;
 }
 async call(tool,args) {
  const r=await this.send('tools/call',{name:tool,arguments:args});
  if(r?.isError)throw Error(`AnchorMind ${tool} failed: `+(r.content??[]).map(c=>c.text).join(' '));
  const text=(r?.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');
  try{return JSON.parse(text);}catch{return text;}
 }
 async context(workspace) {
  await this.connect();
  return this.call('context',this.shape('context',{workspace},{}));
 }
 async recall(workspace,query,{type,keywords,limit=8}={}) {
  await this.connect();
  return this.call('recall',this.shape('recall',{workspace,query,type,keywords,limit},{query:['text','query','content','topic'],limit:['limit','topK','top_k']}));
 }
 // importance는 서버 스키마의 범위에 맞춰 low/medium/high를 숫자로 바꾼다.
 async remember(workspace,f) {
  await this.connect();
  const level={low:0.3,medium:0.6,high:0.9}[f.importance??'medium'];
  const importance=prop=>{const max=typeof prop?.maximum==='number'?prop.maximum:1,min=typeof prop?.minimum==='number'?prop.minimum:0;const v=min+(max-min)*level;return prop?.type==='integer'?Math.round(v):Math.round(v*100)/100;};
  return this.call('remember',this.shape('remember',{workspace,type:f.type,content:f.content,keywords:f.keywords,importance,assertionStatus:f.assertion,anchor:f.anchor?true:undefined},{content:['content','text'],anchor:['isAnchor','anchor']}));
 }
}

// recall 결과가 어떤 모양이든 {id, type, content, assertion}의 배열로 맞춘다. 못 맞추면 원문을 돌려준다.
export function fragmentsOf(result) {
 const list=Array.isArray(result)?result:result&&typeof result==='object'?(result.fragments??result.results??result.items??result.memories):null;
 if(!Array.isArray(list))return {fragments:[],raw:result};
 return {fragments:list.map(x=>({id:x.id??x.fragment_id??null,type:x.type??null,content:x.content??x.text??'',assertion:x.assertionStatus??x.assertion_status??null,importance:x.importance??null,anchor:x.isAnchor??x.anchor??false})).filter(x=>x.content),raw:null};
}
