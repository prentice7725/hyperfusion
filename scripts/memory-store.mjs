import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {read,atomic} from './artifact.mjs';

// 에이전트 공유 작업기억 저장소. AnchorMind의 설계(fragment, workspace 격리, 중복 병합, 모순 탐지,
// importance 감쇠, TTL, 연상 확산, 출처·신뢰 표시)를 의존성 없이 로컬 파일로 구현한다.
// 정본(Drive SOT, Git)이 아니다. 여기 있는 건 "지난번에 겪은 일"이다.

// 종류별 반감기(일). 오래 안 쓰인 기억은 점수가 내려가 검색 순위에서 밀린다. anchor는 감쇠하지 않는다.
export const HALF_LIFE={error:120,procedure:180,decision:365,preference:365,episode:60,fact:90,relation:180};
const ASSERTION_WEIGHT={verified:1,inferred:0.8};
const LEVEL={low:0.3,medium:0.6,high:0.9};
export const DUPLICATE=0.8,TOPIC=0.3;
const DAY=86400000;

export const storeDir=()=>process.env.HF_MEMORY_DIR||path.join(os.homedir(),'.hyperfusion','memory');
const fileOf=w=>path.join(storeDir(),w+'.json');

// 워크스페이스는 저장소 하나의 것이다. 저장소의 hyperfusion.config.json은 일꾼이나 복제한 저장소가 쓴 파일일 수 있어서,
// 거기 적힌 이름만으로 다른 프로젝트의 기억을 읽거나 쓰게 두면 안 된다. 처음 쓰는 저장소가 소유하고,
// 다른 저장소가 같은 이름을 쓰려면 사용자가 `memory.mjs bind`로 직접 허락해야 한다.
const bindFile=w=>path.join(storeDir(),'bindings',w+'.json');
const foreign=(w,why)=>Error(`MEMORY_WORKSPACE_FOREIGN: workspace "${w}" ${why}. If this repository really shares it, ask the user, then run: node memory.mjs bind REPO`);
export function bindingStatus(w,id) {
 const f=bindFile(w);
 if(fs.existsSync(f))return read(f).repos?.includes(id)?'bound':'foreign';
 return fs.existsSync(fileOf(w))?'unclaimed':'new';
}
export function assertBound(w,id) {
 const status=bindingStatus(w,id);
 if(status==='bound')return;
 if(status==='foreign')throw foreign(w,'belongs to other repositories');
 if(status==='unclaimed')throw foreign(w,'already holds memories but is not bound to any repository');
 bind(w,id);
}
export function bind(w,id) {
 const f=bindFile(w);
 const prior=fs.existsSync(f)?read(f):{workspace:w,repos:[]};
 atomic(f,{...prior,repos:[...new Set([...prior.repos,id])],updated_at:new Date().toISOString()});
 return {workspace:w,repos:[...new Set([...prior.repos,id])].length};
}

// 영문은 단어, 한글은 단어와 글자 bigram까지 색인한다. 붙여 쓴 한국어도 걸리게 하려는 것이다.
const STOP=new Set(['a','an','the','is','are','was','of','to','and','or','in','on','for','with','by','at','it','this','that','be','as','from']);
export function tokens(text) {
 const out=[];
 for(const w of String(text).toLowerCase().normalize('NFC').split(/[^\p{L}\p{N}.+_-]+/u).map(x=>x.replace(/^[.+_-]+|[.+_-]+$/g,'')).filter(Boolean)){
  if(STOP.has(w))continue;
  out.push(w);
  if(/\p{Script=Hangul}/u.test(w)&&w.length>2)for(let i=0;i<w.length-1;i++)out.push(w.slice(i,i+2));
 }
 return out;
}
export function similarity(a,b) {
 const A=new Set(tokens(a)),B=new Set(tokens(b));
 if(!A.size||!B.size)return 0;
 let n=0;for(const x of A)if(B.has(x))n++;
 return n/(A.size+B.size-n);
}

// 모순 탐지 휴리스틱: 같은 주제(겹침이 충분)인데 한쪽만 부정하거나, 숫자·버전이 다르면 충돌로 본다.
// NLI 모델이 아니므로 판정하지 않고 검토 대기열에 올리기만 한다.
const NEG=/\b(?:not|no|never|don't|doesn't|didn't|without|exclude[sd]?|avoid|stop|disable[sd]?|remove[sd]?)\b|않|없|금지|제외|말\s?것|중단|빼/i;
const versions=t=>new Set(tokens(t).filter(x=>/\d/.test(x)));
const sameVersions=(a,b)=>{const va=versions(a),vb=versions(b);return va.size===vb.size&&[...va].every(x=>vb.has(x));};
// 거의 같은 문장이어도 숫자·버전이 다르면(0.4 vs 0.7, Godot 4.4 vs 4.5) 중복이 아니라 모순 후보다.
export const duplicate=(a,b)=>similarity(a,b)>=DUPLICATE&&sameVersions(a,b);
export function contradicts(a,b) {
 const sim=similarity(a,b);
 if(sim<TOPIC||duplicate(a,b))return false;
 if(NEG.test(a)!==NEG.test(b))return true;
 const va=versions(a),vb=versions(b);
 return va.size>0&&vb.size>0&&[...va].some(x=>!vb.has(x))&&[...vb].some(x=>!va.has(x));
}

const active=f=>f.status==='active';
const expired=(f,now)=>f.expires_at&&Date.parse(f.expires_at)<=now;
// 감쇠는 마지막으로 만들어지거나 쓰인 때부터 잰다. 다시 꺼내 쓰면 강화된다(재공고화).
export function effective(f,now=Date.now()) {
 if(f.anchor_key)return f.importance;
 const since=Math.max(Date.parse(f.updated_at),f.last_recalled_at?Date.parse(f.last_recalled_at):0);
 return f.importance*Math.pow(0.5,(now-since)/DAY/(HALF_LIFE[f.type]??90));
}

function load(w) {
 const f=fileOf(w);
 return fs.existsSync(f)?read(f):{workspace:w,version:1,fragments:[],archive:[]};
}
// workspace 파일마다 잠금을 잡고 원자적으로 저장한다. 여러 에이전트·세션이 같은 기억을 공유하기 때문이다.
function withStore(w,fn) {
 fs.mkdirSync(storeDir(),{recursive:true});
 const lock=fileOf(w)+'.lock';
 fs.closeSync(fs.openSync(lock,'wx',0o600));
 try{const s=load(w);const out=fn(s);atomic(fileOf(w),s);return out;}
 finally{fs.unlinkSync(lock);}
}

// 저장. 같은 내용이면 병합하고, 예전에 기각된 내용이면 거절하고, 충돌하면 검토 대기열로 보낸다.
export function remember(w,f,{now=Date.now()}={}) {
 return withStore(w,s=>{
  const at=new Date(now).toISOString();
  const rejected=s.fragments.find(x=>x.assertion==='rejected'&&x.type===f.type&&duplicate(x.content,f.content));
  if(rejected)return {status:'refused',id:rejected.id,reason:'previously rejected memory; resolve it explicitly if it became true'};
  const dup=s.fragments.find(x=>active(x)&&x.type===f.type&&duplicate(x.content,f.content));
  if(dup){
   dup.importance=Math.min(1,Math.max(dup.importance,LEVEL[f.importance]??0.6)+0.05);
   dup.keywords=[...new Set([...dup.keywords,...(f.keywords??[])])];
   if(f.assertion==='verified')dup.assertion='verified';
   dup.sources.push(f.source);dup.updated_at=at;dup.merge_count=(dup.merge_count??0)+1;
   return {status:'merged',id:dup.id};
  }
  const conflicts=s.fragments.filter(x=>active(x)&&x.type===f.type&&contradicts(x.content,f.content)).map(x=>x.id);
  const id='f'+crypto.randomUUID().slice(0,8);
  s.fragments.push({id,type:f.type,content:f.content,keywords:f.keywords??[],importance:LEVEL[f.importance]??0.6,assertion:f.assertion,
   anchor_key:f.anchor_key,links:f.links??[],sources:[f.source],status:conflicts.length?'needs_review':'active',conflicts_with:conflicts,
   created_at:at,updated_at:at,expires_at:f.ttl_days?new Date(now+f.ttl_days*DAY).toISOString():undefined,recall_count:0});
  return {status:conflicts.length?'needs_review':'stored',id,conflicts_with:conflicts};
 });
}

// 검색: 어휘 점수(BM25) × (0.5 + 감쇠된 중요도) × 신뢰도, 그다음 링크·같은 작업 기억으로 1단계 연상 확산.
export function recall(w,query,{type,keywords,limit=8,now=Date.now(),touch=true}={}) {
 const s=load(w);
 const live=s.fragments.filter(f=>active(f)&&f.assertion!=='rejected'&&!expired(f,now));
 const pool=live.filter(f=>(!type||f.type===type)&&(!keywords?.length||keywords.some(k=>f.keywords.includes(k))));
 const q=[...new Set(tokens(query))];
 const docs=pool.map(f=>({f,t:tokens(f.content+' '+f.keywords.join(' '))}));
 const avg=docs.reduce((n,d)=>n+d.t.length,0)/(docs.length||1);
 const df=Object.fromEntries(q.map(x=>[x,docs.filter(d=>d.t.includes(x)).length]));
 const score=new Map();
 for(const d of docs){
  let bm=0;
  for(const x of q){const tf=d.t.filter(y=>y===x).length;if(!tf)continue;const idf=Math.log(1+(docs.length-df[x]+0.5)/(df[x]+0.5));bm+=idf*tf*2.2/(tf+1.2*(0.25+0.75*d.t.length/avg));}
  if(bm>0)score.set(d.f.id,bm*(0.5+effective(d.f,now))*(ASSERTION_WEIGHT[d.f.assertion]??0.8));
 }
 const top=[...score.entries()].sort((a,b)=>b[1]-a[1]).slice(0,limit);
 // 연상 확산: 상위 기억과 명시적으로 링크됐거나 같은 작업(hf:<task>)에서 나온 기억을 낮은 점수로 함께 꺼낸다.
 const byId=Object.fromEntries(live.map(f=>[f.id,f])),spread=new Map();
 for(const [id,sc] of top){
  const f=byId[id],task=f.keywords.find(k=>k.startsWith('hf:'));
  for(const g of live)if(g.id!==id&&!score.has(g.id)&&(f.links.includes(g.id)||g.links.includes(id)||(task&&g.keywords.includes(task))))spread.set(g.id,Math.max(spread.get(g.id)??0,sc*0.3));
 }
 const hits=[...top.map(([id,sc])=>({f:byId[id],score:sc,via:'match'})),...[...spread.entries()].sort((a,b)=>b[1]-a[1]).slice(0,Math.ceil(limit/2)).map(([id,sc])=>({f:byId[id],score:sc,via:'association'}))];
 // 검토 대기 중인 충돌 기억은 결과에 표시만 한다. 리드가 정리하기 전엔 일꾼에게 넘기지 않는다.
 const review=s.fragments.filter(f=>f.status==='needs_review'&&q.some(x=>tokens(f.content).includes(x)));
 if(touch&&hits.length)withStore(w,st=>{for(const h of hits){const f=st.fragments.find(x=>x.id===h.f.id);if(f){f.last_recalled_at=new Date(now).toISOString();f.recall_count=(f.recall_count??0)+1;}}});
 return {hits:hits.map(h=>({...view(h.f,now),score:Math.round(h.score*1000)/1000,via:h.via})),needs_review:review.map(f=>view(f,now))};
}

const view=(f,now)=>({id:f.id,type:f.type,content:f.content,assertion:f.assertion,anchor_key:f.anchor_key,keywords:f.keywords,importance:Math.round(effective(f,now)*100)/100,status:f.status,conflicts_with:f.conflicts_with?.length?f.conflicts_with:undefined,sources:f.sources.length});

// 세션 시작용 핵심 기억: anchor 전부 + 감쇠 점수 상위(verified 우선).
export function context(w,{limit=10,now=Date.now()}={}) {
 const s=load(w);
 const live=s.fragments.filter(f=>active(f)&&f.assertion!=='rejected'&&!expired(f,now));
 const anchors=live.filter(f=>f.anchor_key).map(f=>view(f,now));
 const core=live.filter(f=>!f.anchor_key).sort((a,b)=>(ASSERTION_WEIGHT[b.assertion]??0.8)*effective(b,now)-(ASSERTION_WEIGHT[a.assertion]??0.8)*effective(a,now)).slice(0,limit).map(f=>view(f,now));
 return {anchors,core,needs_review:s.fragments.filter(f=>f.status==='needs_review').map(f=>view(f,now))};
}

// 충돌 정리. keep을 살리고 drop은 rejected로 남긴다(같은 잘못이 다시 저장되는 걸 막는 기록).
export function resolve(w,{keep,drop,reject},{now=Date.now()}={}) {
 return withStore(w,s=>{
  const at=new Date(now).toISOString(),get=id=>{const f=s.fragments.find(x=>x.id===id);if(!f)throw Error('Unknown memory '+id);return f;};
  const out=[];
  for(const id of [...(drop?[drop]:[]),...(reject??[])]){const f=get(id);f.assertion='rejected';f.status='rejected';f.superseded_by=keep;f.updated_at=at;out.push({id,status:'rejected'});}
  if(keep){const f=get(keep);f.status='active';f.conflicts_with=(f.conflicts_with??[]).filter(x=>x!==drop);f.updated_at=at;out.push({id:keep,status:'active'});}
  return out;
 });
}

// 정리(reflect): 만료된 기억과, 오래 안 쓰여 거의 잊힌 추정 기억을 archive로 옮긴다. verified와 anchor는 지우지 않는다.
export function reflect(w,{now=Date.now(),floor=0.05}={}) {
 return withStore(w,s=>{
  const out=s.fragments.filter(f=>!f.anchor_key&&(expired(f,now)||(f.assertion==='inferred'&&f.status==='active'&&effective(f,now)<floor)));
  s.archive.push(...out.map(f=>({...f,archived_at:new Date(now).toISOString(),archive_reason:expired(f,now)?'ttl':'decayed'})));
  s.fragments=s.fragments.filter(f=>!out.includes(f));
  return {archived:out.map(f=>({id:f.id,reason:expired(f,now)?'ttl':'decayed'})),active:s.fragments.filter(active).length,needs_review:s.fragments.filter(f=>f.status==='needs_review').map(f=>f.id)};
 });
}

export function forget(w,id,{now=Date.now()}={}) {
 return withStore(w,s=>{
  const f=s.fragments.find(x=>x.id===id);if(!f)throw Error('Unknown memory '+id);
  s.fragments=s.fragments.filter(x=>x!==f);s.archive.push({...f,archived_at:new Date(now).toISOString(),archive_reason:'forgotten'});
  return {id,status:'forgotten'};
 });
}

export const stats=w=>{const s=load(w);return {workspace:w,file:fileOf(w),active:s.fragments.filter(active).length,needs_review:s.fragments.filter(f=>f.status==='needs_review').length,rejected:s.fragments.filter(f=>f.status==='rejected').length,archived:s.archive.length};};
