// 재검수용 라운드 diff. git diff HEAD는 작업 전체 누적 변경이라 REDO 뒤에도 리드가 같은 내용을 다시 읽는다.
// begin 때 HEAD와 다른 파일의 내용을 제어 폴더에 남겨 두고, 이번 라운드가 그 위에 바꾼 줄만 보여 준다.
// 보조 보기일 뿐 판정·승인에는 쓰지 않는다. 누적 diff가 여전히 기록이다.
import fs from 'node:fs';
import path from 'node:path';
import {git,hash,snapshot,changes,read} from './artifact.mjs';

export const ROUND_BASE_VERSION=1;
const MAX_FILE=512*1024,MAX_TOTAL=4*1024*1024,MAX_LINES=20000,MAX_EDITS=2000,CONTEXT=3;
const split0=s=>s.split('\0').filter(Boolean);
const isText=buf=>!buf.includes(0);

// begin에서 부른다. base는 같은 순간의 스냅샷이고, 여기 적힌 해시와 맞는 내용만 남긴다.
export function captureRoundBase(root,base) {
 const dirty=[...new Set([...split0(git(root,['diff','--name-only','-z','HEAD','--'])),...split0(git(root,['ls-files','-z','--others','--exclude-standard']))])]
  .filter(p=>p!=='.fusion'&&!p.startsWith('.fusion/')).sort();
 const files={},omitted=[];let total=0;
 for(const p of dirty){
  const entry=base.files[p];
  if(entry===undefined)continue;
  if(entry===null){files[p]={deleted:true};continue;}
  if(entry.kind!=='file'){omitted.push({path:p,reason:'not_regular_file'});continue;}
  let buf;try{buf=fs.readFileSync(path.join(root,p));}catch{omitted.push({path:p,reason:'unreadable'});continue;}
  if(hash(buf)!==entry.sha256){omitted.push({path:p,reason:'changed_during_capture'});continue;}
  if(!isText(buf)){omitted.push({path:p,reason:'binary'});continue;}
  if(buf.length>MAX_FILE||total+buf.length>MAX_TOTAL){omitted.push({path:p,reason:'size_limit'});continue;}
  total+=buf.length;files[p]={sha256:entry.sha256,text:buf.toString('utf8')};
 }
 return {round_base_version:ROUND_BASE_VERSION,digest:base.digest,files,omitted};
}

// Myers 차분. 편집 수가 상한을 넘으면 null을 내고 호출자는 파일을 직접 읽으라고 안내한다.
export function lineEdits(a,b,maxEdits=MAX_EDITS) {
 const n=a.length,m=b.length,max=n+m,off=max+1,v=new Int32Array(2*max+3),trace=[];
 let found=-1;
 for(let d=0;d<=Math.min(max,maxEdits)&&found<0;d++){
  for(let k=-d;k<=d;k+=2){
   let x=k===-d||(k!==d&&v[off+k-1]<v[off+k+1])?v[off+k+1]:v[off+k-1]+1,y=x-k;
   while(x<n&&y<m&&a[x]===b[y]){x++;y++;}
   v[off+k]=x;
   if(x>=n&&y>=m){found=d;break;}
  }
  trace.push(v.slice(off-d,off+d+1));
 }
 if(found<0)return null;
 const ops=[];let x=n,y=m;
 for(let d=found;d>0;d--){
  const prev=trace[d-1],at=k=>prev[k+d-1],k=x-y;
  const down=k===-d||(k!==d&&at(k-1)<at(k+1)),pk=down?k+1:k-1,px=at(pk),py=px-pk;
  while(x>px&&y>py){ops.push([' ',a[--x]]);y--;}
  if(down)ops.push(['+',b[--y]]);else ops.push(['-',a[--x]]);
 }
 while(x>0&&y>0){ops.push([' ',a[--x]]);y--;}
 return ops.reverse();
}

export function unifiedHunks(ops,context=CONTEXT) {
 const changed=ops.map((o,i)=>o[0]===' '?-1:i).filter(i=>i>=0);
 if(!changed.length)return '';
 const groups=[];
 for(const i of changed){const g=groups.at(-1);if(g&&i-g[1]<=2*context)g[1]=i;else groups.push([i,i]);}
 const out=[];
 for(const [first,last] of groups){
  const start=Math.max(0,first-context),end=Math.min(ops.length,last+context+1);
  let oldNo=1,newNo=1;
  for(let i=0;i<start;i++){if(ops[i][0]!=='+')oldNo++;if(ops[i][0]!=='-')newNo++;}
  const body=ops.slice(start,end),ol=body.filter(o=>o[0]!=='+').length,nl=body.filter(o=>o[0]!=='-').length;
  out.push(`@@ -${ol?oldNo:oldNo-1},${ol} +${nl?newNo:newNo-1},${nl} @@`,...body.map(([t,l])=>t+l));
 }
 return out.join('\n');
}

const lines=text=>{const l=text.replaceAll('\r\n','\n').split('\n');if(l.at(-1)==='')l.pop();return l;};

function fileDelta(root,p,saved,baseEntry) {
 const current=fs.existsSync(path.join(root,p))?fs.readFileSync(path.join(root,p)):null;
 let before;
 if(saved?.deleted||baseEntry==null)before=null;
 else if(saved)before=Buffer.from(saved.text,'utf8');
 else{try{before=Buffer.from(git(root,['show',`HEAD:${p}`]),'utf8');}catch{return {path:p,status:'unavailable',reason:'base_not_recorded'};}}
 if(before===null&&current===null)return {path:p,status:'unchanged'};
 if(before===null)return {path:p,status:'added',note:'new since the round started; read the file directly'};
 if(current===null)return {path:p,status:'deleted'};
 if(!isText(current)||!isText(before))return {path:p,status:'binary'};
 const a=lines(before.toString('utf8')),b=lines(current.toString('utf8'));
 if(a.length>MAX_LINES||b.length>MAX_LINES)return {path:p,status:'unavailable',reason:'line_limit'};
 const ops=lineEdits(a,b);
 if(!ops)return {path:p,status:'unavailable',reason:'edit_limit'};
 return {path:p,status:'modified',diff:unifiedHunks(ops)};
}

// 읽기 전용: 파일 쓰기·모델 호출·상태 변경이 없다.
export function roundDelta(root,state,taskdir,{charBudget=60000}={}) {
 const n=state?.iteration??0;
 const base={authoritative:false,round:n,
  note:'Changes made since this round started, for re-review after REDO. It is not the review record: approval still covers the cumulative task diff (git diff HEAD) and every success criterion.'};
 if(n<2)return {...base,available:false,reason:'FIRST_ROUND'};
 const rb=path.join(taskdir,`round-base-${n}.json`),bs=path.join(taskdir,`base-${n}.json`);
 if(!fs.existsSync(rb)||!fs.existsSync(bs))return {...base,available:false,reason:'ROUND_BASE_NOT_RECORDED'};
 const saved=read(rb),start=read(bs);
 if(saved.round_base_version!==ROUND_BASE_VERSION||saved.digest!==start.digest)return {...base,available:false,reason:'ROUND_BASE_MISMATCH'};
 const now=snapshot(root),omittedBase=new Map((saved.omitted??[]).map(o=>[o.path,o.reason]));
 const files=[],omitted=[];let used=0;
 for(const p of changes(start,now)){
  const entry=omittedBase.has(p)?{path:p,status:'unavailable',reason:omittedBase.get(p)}:fileDelta(root,p,saved.files[p],start.files[p]);
  const size=JSON.stringify(entry).length;
  if(used+size>charBudget){omitted.push({path:p,status:entry.status,reason:'char_budget'});continue;}
  used+=size;files.push(entry);
 }
 return {...base,available:true,changed_since_round_start:files.length+omitted.length,files,omitted,
  tree_changed_after_finish:!!state.post_digest&&now.digest!==state.post_digest};
}
