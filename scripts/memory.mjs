import {readInput,printError} from './cli.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {isMain} from './platform.mjs';
import {read,repo} from './artifact.mjs';
import {controlPath,repoId,acquireLock} from './control-dir.mjs';
import {config} from './executor-config.mjs';
import * as store from './memory-store.mjs';
import {retrievalPacket} from './memory-packet.mjs';
import {recordRetrieval,assessMemory} from './memory-observations.mjs';
import {validateRecallArtifacts,artifactStatus} from './memory-provenance.mjs';
import {workspaceOf,readLedger,writeLedger,propose,checkCandidate} from './memory-policy.mjs';

// 리드 전용 기억 도구. 흐름은 context → recall → (작업) → candidates → commit → reflect.
// 기억은 정본이 아니다. 가져온 기억은 정본(설계 문서)과 Git HEAD로 확인한 뒤에만 brief에 넣는다.

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

// 규칙으로 바꾼 조각(enforced_by)은 회수에서 빠진다. 규칙 파일을 확인할 때만(validate_artifacts) 사라지거나 바뀐 규칙의 조각을 다시 올린다.
const staleRule=root=>f=>artifactStatus(root,{artifact:f.enforced_by.artifact})!=='artifact_matches';

export function context(root,{validate_artifacts=false}={}) {
 if(typeof validate_artifacts!=='boolean')throw Error('memory validate_artifacts must be boolean');
 root=repo(root);const w=workspace(root);
 return {workspace:w,...store.context(w,{staleEnforcement:validate_artifacts?staleRule(root):null}),note:'Hints, not authority. Instruction files and the SOT outrank every memory here.'};
}

// 기계 검사로 바꿀 후보(references/static-gate.md HF-I12). 읽기 전용이고 모델을 부르지 않는다.
export function ruleCandidates(root,{limit,enforced=false}={}) {
 root=repo(root);const w=workspace(root);
 return {workspace:w,...store.ruleCandidates(w,{limit,enforced}),
  next_action:enforced?'Recheck each rule file; rerun commit rules.enforce with the new sha256 when a rule file changed for another reason':
   'Turn a candidate into a lint rule or test with an ordinary task first; after it closes, record it with commit {rules:{expected_digest, enforce:[{id, kind, ref, artifact:{path, sha256}}]}} or mark it not_enforceable'};
}

export function recall(root,query,{type,limit,byte_budget,provenance,observe=false,validate_artifacts=false}={}) {
 if(typeof observe!=='boolean')throw Error('memory observe must be boolean');
 if(typeof validate_artifacts!=='boolean')throw Error('memory validate_artifacts must be boolean');
 root=repo(root);const w=workspace(root);
 if(typeof query!=='string'||!query.trim())throw Error('recall needs a query');
 const retrieved=store.recall(w,query,{type,provenance,limit:limit??config(root).memory?.recall_limit??8,touch:byte_budget===undefined&&!validate_artifacts,staleEnforcement:validate_artifacts?staleRule(root):null});
 const found=validate_artifacts?validateRecallArtifacts(root,retrieved):retrieved;
 const r=byte_budget===undefined?found:retrievalPacket(found,{byte_budget});
 const retrieval_id=observe?recordRetrieval(root,read(controlPath(root,'state.json')).task_id,w,r.hits):undefined;
 return {workspace:w,query,...r,...(retrieval_id?{retrieval_id}:{}),
  prior_experience:r.hits.map(h=>({id:h.id,type:h.type,content:h.content,assertion:h.assertion})),
  next_action:'check each hit against the source of truth (design docs) and Git HEAD, then copy only the confirmed ones into brief.prior_experience; settle needs_review items with resolve'};
}

const lockOf=root=>controlPath(root,'locks/control.lock');
const ledgerDigest=ledger=>crypto.createHash('sha256').update(JSON.stringify(ledger)).digest('hex');

// Read-only preparation. Approval still requires explicit candidate IDs.
export function reviewCandidates(root,task,{limit=20}={}) {
 if(!Number.isInteger(limit)||limit<1||limit>100)throw Error('memory review limit must be 1..100');
 const ledger=candidates(root,task),pending=ledger.candidates.filter(c=>c.status==='pending');
 return {task:ledger.task_id,ledger_digest:ledgerDigest(ledger),authority:'advisory',candidates:pending.slice(0,limit),remaining:Math.max(0,pending.length-limit),next_action:'Explicitly accept or reject IDs with commit; pass expected_digest to refuse stale review decisions.'};
}

// 장부 후보를 승인·수정·기각하고, 승인분만 저장한다. 저장 시 중복은 병합, 충돌은 검토 대기열로 간다.
export function commit(root,input) {
 root=repo(root);const w=workspace(root);
 // 컨트롤러와 동시에 장부를 건드리지 않도록 같은 잠금을 잡는다.
 const release=acquireLock(lockOf(root));
 try{
  // 규칙 기록은 장부와 따로다. 하나라도 틀리면 아무것도 적지 않는다.
  const rules=input.rules===undefined?undefined:store.recordRules(w,input.rules);
  if(rules&&!input.accept?.length&&!input.reject?.length&&!input.add?.length)return {workspace:w,rules};
  const state=read(controlPath(root,'state.json'));
  const task=input.task??state.task_id;
  const currentLedger=readLedger(root,task);
  if(input.expected_digest!==undefined&&input.expected_digest!==ledgerDigest(currentLedger))throw Error('MEMORY_REVIEW_STALE: prepare a fresh candidate review before committing');
  const closed=task===state.task_id?state.phase==='CLOSE':false;
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
   const f={type:edit.type??c.type,content:edit.content??c.content,keywords:c.keywords,importance:edit.importance??c.importance,anchor_key:c.anchor_key,reason:c.reason,ttl_days:edit.ttl_days??c.ttl_days,provenance:edit.provenance??c.provenance};
   // 리드가 고친 내용도 같은 규칙으로 다시 검사한다.
   const problems=checkCandidate(f,Object.keys(edit).length?'lead':c.source.role);
   if(problems.length){c.problems=problems;results.push({id:c.id,status:'invalid',problems});continue;}
   // 검증을 통과해 닫힌 작업에서 프로토콜이 뽑은 기록만 verified. 나머지는 모두 inferred.
   const assertion=closed&&c.source.role==='protocol'&&c.source.verified&&Object.keys(edit).length===0?'verified':'inferred';
   const keywords=[...new Set([...f.keywords,'hf:'+task,'src:'+c.source.role,...(c.source.executor?['by:'+c.source.executor]:[])])];
   const saved=store.remember(w,{...f,keywords,assertion,source:{...c.source,task,candidate:c.id}});
   if(saved.status==='refused'){c.status='refused';c.problems=[saved.reason];}
   else Object.assign(c,{status:'committed',memory_id:saved.id,store_status:saved.status,assertion,committed_at:new Date().toISOString()});
   results.push({id:c.id,...saved,assertion});
  }
  writeLedger(root,task,ledger);
  return {workspace:w,task,results,pending:ledger.candidates.filter(c=>c.status==='pending').map(c=>c.id),...(rules?{rules}:{})};
 } finally {release();}
}

export function candidates(root,task) {
 root=repo(root);
 return readLedger(root,task??read(controlPath(root,'state.json')).task_id);
}
export const resolve=(root,input)=>store.resolve(workspace(repo(root)),input);
export const reflect=root=>({...store.reflect(workspace(repo(root))),...store.stats(workspace(repo(root)))});
export const forget=(root,id)=>store.forget(workspace(repo(root)),id);
export const assess=(root,input)=>{root=repo(root);return assessMemory(root,input,workspace(root));};

if(isMain(import.meta.url)) {
 try{
  const [cmd,root,...rest]=process.argv.slice(2);
  const flag=n=>{const i=rest.indexOf(n);return i>=0?rest[i+1]:undefined;};
  const out={
   bind:()=>bind(root),
   context:()=>context(root,{validate_artifacts:rest.includes('--validate-artifacts')}),
   'rule-candidates':()=>ruleCandidates(root,{limit:flag('--limit')?Number(flag('--limit')):undefined,enforced:rest.includes('--enforced')}),
   recall:()=>recall(root,rest[0],{type:flag('--type'),limit:flag('--limit')?Number(flag('--limit')):undefined,byte_budget:flag('--byte-budget')?Number(flag('--byte-budget')):undefined,provenance:flag('--provenance')?readInput(flag('--provenance')):undefined,observe:rest.includes('--observe'),validate_artifacts:rest.includes('--validate-artifacts')}),
   candidates:()=>candidates(root,rest[0]),
   review:()=>reviewCandidates(root,rest[0],{limit:flag('--limit')?Number(flag('--limit')):undefined}),
   commit:()=>commit(root,readInput(rest[0])),
   assess:()=>assess(root,readInput(rest[0])),
   resolve:()=>resolve(root,readInput(rest[0])),
   reflect:()=>reflect(root),
   forget:()=>forget(root,rest[0]),
   stats:()=>store.stats(workspace(repo(root)))
  }[cmd];
  if(!out)throw Error('Usage: memory.mjs bind|context [--validate-artifacts]|rule-candidates [--limit N] [--enforced]|recall "query" [--type T] [--limit N] [--byte-budget N] [--provenance INPUT.json] [--observe] [--validate-artifacts]|candidates [TASK]|review [TASK] [--limit N]|commit INPUT.json|assess INPUT.json|resolve INPUT.json|reflect|forget ID|stats  (each takes REPO first)');
  console.log(JSON.stringify(out(),null,2));
 }catch(e){printError(e);}
}
