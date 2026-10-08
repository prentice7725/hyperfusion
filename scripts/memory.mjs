import fs from 'node:fs';
import path from 'node:path';
import {isMain} from './platform.mjs';
import {read,repo} from './artifact.mjs';
import {controlPath,repoId,acquireLock} from './control-dir.mjs';
import {config} from './executor-config.mjs';
import * as store from './memory-store.mjs';
import {workspaceOf,readLedger,writeLedger,propose,checkCandidate} from './memory-policy.mjs';

// 리드 전용 기억 도구. 흐름은 context → recall → (작업) → candidates → commit → reflect.
// 기억은 정본이 아니다. 가져온 기억은 Drive SOT와 Git HEAD로 확인한 뒤에만 brief에 넣는다.

const workspace=root=>{
 const w=workspaceOf(config(root));
 if(!w)throw Error('MEMORY_DISABLED: set memory.workspace in hyperfusion.config.json (one workspace per project)');
 store.assertBound(w,repoId(root));
 return w;
};

// 이 저장소가 설정에 적힌 워크스페이스를 써도 된다고 사용자가 확인한 뒤에만 부른다.
export function bind(root) {
 root=repo(root);
 const w=workspaceOf(config(root));
 if(!w)throw Error('MEMORY_DISABLED: set memory.workspace in hyperfusion.config.json first');
 return store.bind(w,repoId(root));
}

export function context(root) {
 root=repo(root);const w=workspace(root);
 return {workspace:w,...store.context(w),note:'Hints, not authority. Instruction files and the SOT outrank every memory here.'};
}

export function recall(root,query,{type,limit}={}) {
 root=repo(root);const w=workspace(root);
 if(typeof query!=='string'||!query.trim())throw Error('recall needs a query');
 const r=store.recall(w,query,{type,limit:limit??config(root).memory?.recall_limit??8});
 return {workspace:w,query,...r,
  prior_experience:r.hits.map(h=>({id:h.id,type:h.type,content:h.content,assertion:h.assertion})),
  next_action:'check each hit against Drive SOT / Git HEAD, then copy only the confirmed ones into brief.prior_experience; settle needs_review items with resolve'};
}

const lockOf=root=>controlPath(root,'locks/control.lock');

// 장부 후보를 승인·수정·기각하고, 승인분만 저장한다. 저장 시 중복은 병합, 충돌은 검토 대기열로 간다.
export function commit(root,input) {
 root=repo(root);const w=workspace(root);
 const state=read(controlPath(root,'state.json'));
 const task=input.task??state.task_id;
 const closed=task===state.task_id?state.phase==='CLOSE':fs.existsSync(controlPath(root,'tasks',task,'verification.json'));
 // 컨트롤러와 동시에 장부를 건드리지 않도록 같은 잠금을 잡는다.
 const release=acquireLock(lockOf(root));
 try{
  // 리드가 이번에 직접 추가한 항목은 곧바로 승인 대상이다.
  const before=readLedger(root,task).candidates.length;
  if(Array.isArray(input.add)&&input.add.length)propose(root,task,input.add,{role:'lead'});
  const ledger=readLedger(root,task);
  const accept=new Set([...(input.accept??[]),...ledger.candidates.slice(before).map(c=>c.id)]);
  const results=[];
  for(const c of ledger.candidates){
   if((input.reject??[]).includes(c.id)&&c.status==='pending'){c.status='rejected';c.decided_at=new Date().toISOString();results.push({id:c.id,status:'rejected'});continue;}
   if(!accept.has(c.id))continue;
   if(c.status!=='pending'){results.push({id:c.id,status:c.status,note:'not pending; skipped'});continue;}
   const edit=input.edits?.[c.id]??{};
   const f={type:edit.type??c.type,content:edit.content??c.content,keywords:c.keywords,importance:edit.importance??c.importance,anchor_key:c.anchor_key,reason:c.reason,ttl_days:edit.ttl_days??c.ttl_days};
   // 리드가 고친 내용도 같은 규칙으로 다시 검사한다.
   const problems=checkCandidate(f,Object.keys(edit).length?'lead':c.source.role);
   if(problems.length){c.problems=problems;results.push({id:c.id,status:'invalid',problems});continue;}
   // 검증을 통과해 닫힌 작업에서 프로토콜이 뽑은 기록만 verified. 나머지는 모두 inferred.
   const assertion=closed&&c.source.role==='protocol'&&c.source.verified?'verified':'inferred';
   const keywords=[...new Set([...f.keywords,'hf:'+task,'src:'+c.source.role,...(c.source.executor?['by:'+c.source.executor]:[])])];
   const saved=store.remember(w,{...f,keywords,assertion,source:{...c.source,task,candidate:c.id}});
   if(saved.status==='refused'){c.status='refused';c.problems=[saved.reason];}
   else Object.assign(c,{status:'committed',memory_id:saved.id,store_status:saved.status,assertion,committed_at:new Date().toISOString()});
   results.push({id:c.id,...saved,assertion});
  }
  writeLedger(root,task,ledger);
  return {workspace:w,task,results,pending:ledger.candidates.filter(c=>c.status==='pending').map(c=>c.id)};
 } finally {release();}
}

export function candidates(root,task) {
 root=repo(root);
 return readLedger(root,task??read(controlPath(root,'state.json')).task_id);
}
export const resolve=(root,input)=>store.resolve(workspace(repo(root)),input);
export const reflect=root=>({...store.reflect(workspace(repo(root))),...store.stats(workspace(repo(root)))});
export const forget=(root,id)=>store.forget(workspace(repo(root)),id);

if(isMain(import.meta.url)) {
 try{
  const [cmd,root,...rest]=process.argv.slice(2);
  const flag=n=>{const i=rest.indexOf(n);return i>=0?rest[i+1]:undefined;};
  const out={
   bind:()=>bind(root),
   context:()=>context(root),
   recall:()=>recall(root,rest[0],{type:flag('--type'),limit:flag('--limit')?Number(flag('--limit')):undefined}),
   candidates:()=>candidates(root,rest[0]),
   commit:()=>commit(root,read(rest[0])),
   resolve:()=>resolve(root,read(rest[0])),
   reflect:()=>reflect(root),
   forget:()=>forget(root,rest[0]),
   stats:()=>store.stats(workspace(repo(root)))
  }[cmd];
  if(!out)throw Error('Usage: memory.mjs bind|context|recall "query" [--type T] [--limit N]|candidates [TASK]|commit INPUT.json|resolve INPUT.json|reflect|forget ID|stats  (each takes REPO first)');
  console.log(JSON.stringify(out(),null,2));
 }catch(e){console.error(e.message);process.exitCode=1;}
}
