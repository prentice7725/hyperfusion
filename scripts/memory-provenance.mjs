import {looksSecret} from './memory-policy.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Caller-supplied context is an advisory filter, never an execution grant.
export function checkProvenance(value) {
 if(value===undefined)return [];
 if(!value||typeof value!=='object'||Array.isArray(value))return ['invalid memory provenance'];
 const problems=[];
 if(Object.keys(value).some(k=>!['task','version','artifact'].includes(k)))problems.push('unknown memory provenance field');
 for(const key of ['task','version'])if(value[key]!==undefined&&(typeof value[key]!=='string'||!value[key].trim()||value[key].length>100||looksSecret(value[key])))problems.push('invalid memory provenance '+key);
 if(value.task!==undefined&&!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value.task))problems.push('invalid memory provenance task');
 if(value.artifact!==undefined){
  const a=value.artifact;
  if(!a||typeof a!=='object'||Array.isArray(a)||Object.keys(a).some(k=>!['path','sha256'].includes(k))||typeof a.path!=='string'||!a.path||a.path.length>240||a.path.includes('\\')||a.path.startsWith('/')||a.path.split('/').some(p=>!p||p==='.'||p==='..'||/[.\s]$/.test(p)||p.toLowerCase()==='.git')||/[\x00-\x1f:<>"|?*]/.test(a.path)||looksSecret(a.path)||typeof a.sha256!=='string'||!/^([a-f0-9]{64})$/.test(a.sha256))problems.push('invalid memory provenance artifact');
 }
 return problems;
}

export const provenanceKey=p=>JSON.stringify(p?{task:p.task,version:p.version,artifact:p.artifact?{path:p.artifact.path,sha256:p.artifact.sha256}:undefined}:null);
export function matchesProvenance(stored,wanted) {
 if(!wanted)return true;
 return ['task','version'].every(k=>wanted[k]===undefined||stored?.[k]===wanted[k])&&(!wanted.artifact||(stored?.artifact?.path===wanted.artifact.path&&stored?.artifact?.sha256===wanted.artifact.sha256));
}

// Do not follow a memory pointer through links or outside the repository.
// Hashes establish artifact identity only, never that the advice is correct.
export function artifactStatus(root,provenance) {
 if(checkProvenance(provenance).length)return 'invalid_provenance';
 if(!provenance?.artifact)return 'artifact_unknown';
 const artifact=provenance.artifact;
 try{
  let target=fs.realpathSync(root);
  for(const part of artifact.path.split('/')){
   target=path.join(target,part);
   const stat=fs.lstatSync(target);
   if(stat.isSymbolicLink())return 'artifact_link_refused';
  }
  const stat=fs.statSync(target);
  if(!stat.isFile())return 'artifact_not_file';
  // Refuse excessive reads rather than letting untrusted pointers exhaust memory.
  if(stat.size>8*1024*1024)return 'artifact_too_large';
  const actual=crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  return actual===artifact.sha256?'artifact_matches':'artifact_changed';
 }catch(e){return e.code==='ENOENT'?'artifact_missing':'artifact_unreadable';}
}

export function validateRecallArtifacts(root,result) {
 const invalidated=[];
 const hits=result.hits.map(hit=>({...hit,artifact_status:artifactStatus(root,hit.provenance)})).filter(hit=>{
  if(['artifact_matches','artifact_unknown'].includes(hit.artifact_status))return true;
  invalidated.push({id:hit.id,artifact_status:hit.artifact_status,source_pointer:{fragment:hit.id},conflicts_with:hit.conflicts_with??[]});
  return false;
 });
 return {...result,hits,invalidated,needs_review:result.needs_review.map(hit=>({...hit,artifact_status:artifactStatus(root,hit.provenance)}))};
}
