import fs from 'node:fs';
import path from 'node:path';
import {isMain} from './platform.mjs';
import {read,repo} from './artifact.mjs';
import {config} from './executor-config.mjs';
import {AnchorMind,fragmentsOf} from './memory-client.mjs';
import {workspaceOf,readLedger,writeLedger,propose,checkCandidate} from './memory-policy.mjs';

// 리드 전용 기억 도구. 읽기(context, recall)는 참고 자료를 가져오고, 쓰기(commit)는 리드가 승인한 후보만 저장한다.
// AnchorMind는 정본이 아니다. 가져온 기억은 Drive SOT와 Git HEAD로 확인한 뒤에만 brief에 넣는다.

const workspace=root=>{
 const w=workspaceOf(config(root));
 if(!w)throw Error('MEMORY_DISABLED: set memory.workspace in hyperfusion.config.json (one workspace per project)');
 return w;
};

export async function context(root,{client}={}) {
 root=repo(root);const w=workspace(root);
 return {workspace:w,core:await (client??new AnchorMind()).context(w),note:'Core memories are hints. Instruction files and SOT outrank them.'};
}

export async function recall(root,query,{type,limit,client}={}) {
 root=repo(root);const w=workspace(root);
 if(typeof query!=='string'||!query.trim())throw Error('recall needs a query');
 limit??=config(root).memory?.recall_limit??8;
 const {fragments,raw}=fragmentsOf(await (client??new AnchorMind()).recall(w,query,{type,limit}));
 // 기각된 기억은 일꾼에게 넘기지 않는다.
 const usable=fragments.filter(f=>f.assertion!=='rejected');
 return {workspace:w,query,fragments:usable,dropped_rejected:fragments.length-usable.length,raw,
  prior_experience:usable.map(f=>({...(f.id!=null?{id:f.id}:{}),type:f.type,content:f.content,...(['verified','inferred'].includes(f.assertion)?{assertion:f.assertion}:{})})).filter(f=>f.type),
  next_action:'check each fragment against Drive SOT / Git HEAD, then copy only the confirmed ones into brief.prior_experience'};
}

const lockOf=root=>path.join(root,'.fusion/locks/control.lock');

// 장부 후보를 승인·수정·기각하고, 승인분만 AnchorMind에 저장한다.
export async function commit(root,input,{client}={}) {
 root=repo(root);const w=workspace(root);
 const state=read(path.join(root,'.fusion/state.json'));
 const task=input.task??state.task_id;
 const closed=task===state.task_id?state.phase==='CLOSE':fs.existsSync(path.join(root,'.fusion/tasks',task,'verification.json'));
 // 컨트롤러와 동시에 장부를 건드리지 않도록 같은 잠금을 잡는다.
 fs.closeSync(fs.openSync(lockOf(root),'wx',0o600));
 try{
  // 리드가 이번에 직접 추가한 항목은 곧바로 승인 대상이다.
  const before=readLedger(root,task).candidates.length;
  if(Array.isArray(input.add)&&input.add.length)propose(root,task,input.add,{role:'lead'});
  const ledger=readLedger(root,task),api=client??new AnchorMind();
  const accept=new Set([...(input.accept??[]),...ledger.candidates.slice(before).map(c=>c.id)]);
  const results=[];
  for(const c of ledger.candidates){
   if((input.reject??[]).includes(c.id)&&c.status==='pending'){c.status='rejected';c.decided_at=new Date().toISOString();results.push({id:c.id,status:'rejected'});continue;}
   if(!accept.has(c.id))continue;
   if(c.status!=='pending'){results.push({id:c.id,status:c.status,note:'not pending; skipped'});continue;}
   const edit=input.edits?.[c.id]??{};
   const f={type:edit.type??c.type,content:edit.content??c.content,keywords:c.keywords,importance:edit.importance??c.importance,anchor_key:c.anchor_key,reason:c.reason};
   // 리드가 고친 내용도 같은 규칙으로 다시 검사한다. 일꾼 후보의 종류를 리드가 바꾸면 리드 기준을 쓴다.
   const problems=checkCandidate(f,Object.keys(edit).length?'lead':c.source.role);
   if(problems.length){c.problems=problems;results.push({id:c.id,status:'invalid',problems});continue;}
   // 검증을 통과해 닫힌 작업에서 프로토콜이 뽑은 기록만 verified. 나머지는 모두 inferred.
   const assertion=closed&&c.source.role==='protocol'&&c.source.verified?'verified':'inferred';
   const keywords=[...new Set([...f.keywords,'hf:'+task,'src:'+c.source.role,...(c.source.executor?['by:'+c.source.executor]:[]),...(f.anchor_key?['anchor:'+f.anchor_key]:[])])];
   try{
    const saved=await api.remember(w,{...f,keywords,assertion,anchor:!!f.anchor_key});
    Object.assign(c,{status:'committed',type:f.type,content:f.content,assertion,committed_at:new Date().toISOString(),server:saved});
    results.push({id:c.id,status:'committed',assertion});
   }catch(e){results.push({id:c.id,status:'error',error:e.message});}
  }
  writeLedger(root,task,ledger);
  return {workspace:w,task,results,pending:ledger.candidates.filter(c=>c.status==='pending').map(c=>c.id)};
 } finally {fs.unlinkSync(lockOf(root));}
}

export function candidates(root,task) {
 root=repo(root);
 const state=read(path.join(root,'.fusion/state.json'));
 return readLedger(root,task??state.task_id);
}

if(isMain(import.meta.url)) {
 try{
  const [cmd,root,...rest]=process.argv.slice(2);
  const flag=n=>{const i=rest.indexOf(n);return i>=0?rest[i+1]:undefined;};
  let out;
  if(cmd==='context')out=await context(root);
  else if(cmd==='recall')out=await recall(root,rest[0],{type:flag('--type'),limit:flag('--limit')?Number(flag('--limit')):undefined});
  else if(cmd==='candidates')out=candidates(root,rest[0]);
  else if(cmd==='commit')out=await commit(root,read(rest[0]));
  else throw Error('Usage: memory.mjs context REPO | recall REPO "query" [--type T] [--limit N] | candidates REPO [TASK] | commit REPO INPUT.json');
  console.log(JSON.stringify(out,null,2));
 }catch(e){console.error(e.message);process.exitCode=1;}
}
