import fs from 'node:fs';
import path from 'node:path';
import {read,hash,immutable,atomic,snapshot,changes,repo} from './artifact.mjs';
import {controlPath,acquireLock} from './control-dir.mjs';
import {safePath} from './contracts.mjs';
import {assertWorkflow,sourceIdentity} from './workflow-plan.mjs';

const fail=message=>{throw Error('INTEGRATION: '+message);};
const equal=(a,b)=>JSON.stringify(a??null)===JSON.stringify(b??null);
const MAX_BYTES=8*1024*1024,MAX_FILES=200;
const bundlePath=(root,id)=>controlPath(root,'workflow',`bundle-${id}.json`);
const task=(p,id)=>p.milestones.flatMap(m=>m.tasks).find(t=>t.id===id);
const inside=(name,scope)=>scope.some(p=>name===p||name.startsWith(p+'/'));

// Never traverse links, Git metadata or platform-specific alternate paths.
export function plainFile(root,name) {
 if(!safePath(name)||name.includes('\\')||name.split('/').some(p=>p.toLowerCase()==='.git'||/[.\s]$/.test(p)||p.includes(':')))fail('unsafe path: '+name);
 let target=root;
 for(const part of name.split('/')){
  target=path.join(target,part);
  try{if(fs.lstatSync(target).isSymbolicLink())fail('linked path: '+name);}catch(e){if(e.code!=='ENOENT')throw e;}
 }
 return target;
}
export function filePayload(root,name,entry) {
 if(!entry)return null;
 if(entry.kind!=='file')fail('only regular files can be transferred: '+name);
 const target=plainFile(root,name),stat=fs.statSync(target);
 if(!stat.isFile()||stat.size>MAX_BYTES)fail('file is not bounded: '+name);
 const bytes=fs.readFileSync(target);
 if(hash(bytes)!==entry.sha256)fail('source changed: '+name);
 return bytes.toString('base64');
}
export function prepareSource(source,target,expected,names) {
 // Copy only Git-listed source. Ignored guard files (including secrets) are
 // never propagated; a source-identity mismatch refuses the prepared tree.
 const current=snapshot(target);
 for(const name of names){
  if(name==='.fusion'||name.startsWith('.fusion/')||name.startsWith('.git/'))continue;
  const entry=expected.files[name];
  if(equal(entry,current.files[name]))continue;
  const destination=plainFile(target,name);
  if(entry){const data=filePayload(source,name,entry);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,Buffer.from(data,'base64'));fs.chmodSync(destination,entry.mode);}
  else if(fs.existsSync(destination))fs.unlinkSync(destination);
 }
 if(sourceIdentity(snapshot(source))!==sourceIdentity(expected)||sourceIdentity(snapshot(target))!==sourceIdentity(expected))fail('prepared source differs; preserve workspace for inspection');
}

export function exportBundle(root,p,id) {
 assertWorkflow(root,p);
 const t=task(p,id);
 if(t?.workspace!=='isolated')fail('isolated task required');
 const close=read(controlPath(root,'workflow',`close-${id}.json`));
 if(close.digest!==p.workflow.digest||close.state.task_id!==id||close.state.phase!=='CLOSE'||!close.state.ended_at||close.state.writer||close.state.open_consult)fail('verified child CLOSE required');
 const workspace=repo(close.workspace),dir=controlPath(workspace,'tasks',id),s=read(controlPath(workspace,'state.json'));
 if(s.task_id!==id||s.phase!=='CLOSE'||s.post_digest!==close.state.post_digest||s.writer||s.open_consult||fs.existsSync(controlPath(workspace,'locks/writer.json'))||fs.existsSync(controlPath(workspace,'locks/acceptance.json')))fail('child state is not settled');
 const base=read(path.join(dir,'baseline.json')),post=read(path.join(dir,`post-${s.iteration}.json`)),live=snapshot(workspace);
 if(post.digest!==s.post_digest||live.digest!==post.digest)fail('child tree changed after review');
 const names=changes(base,post);
 if(names.length>MAX_FILES)fail('too many changed files');
 let total=0;
 const files=names.map(name=>{
  if(!inside(name,t.scope.paths))fail('child changed outside frozen scope');
  plainFile(workspace,name);
  if(base.files[name]?.kind==='symlink')fail('linked baseline: '+name);
  const data=filePayload(workspace,name,post.files[name]);total+=data?Buffer.from(data,'base64').length:0;
  if(total>MAX_BYTES)fail('bundle exceeds byte limit');
  return {path:name,before:base.files[name]??null,after:post.files[name]??null,data};
 });
 const value={revision:1,task_id:id,workflow_digest:p.workflow.digest,base_digest:base.digest,reviewed_digest:post.digest,files};
 const record={...value,bundle_digest:hash(JSON.stringify(value))},file=bundlePath(root,id);
 if(fs.existsSync(file)){if(!equal(read(file),record))fail('bundle already exists with different evidence');}
 else immutable(file,record);
 return {task_id:id,bundle_digest:record.bundle_digest,files:files.map(f=>f.path),bundle_file:file};
}

// Requires a reserved integration task's lease, before any worker launch. There is no implicit
// worker launch, approval, verification, commit, staging, or merge to main.
export function applyBundle(root,p,id,input) {
 assertWorkflow(root,p);
 const release=acquireLock(controlPath(root,'locks/integration.lock'));
 try{
  const child=task(p,id),s=read(controlPath(root,'state.json')),integration=task(p,s.task_id),lease=read(controlPath(root,'locks/writer.json'));
  if(typeof input.token!=='string'||!input.token||child?.workspace!=='isolated'||integration?.integrates!==id||s.project?.workflow_digest!==p.workflow.digest||s.phase!=='EXECUTING'||s.open_consult||s.writer?.token!==input.token||lease.token!==input.token||lease.task_id!==s.task_id||lease.round!==s.iteration)fail('current integration writer lease required');
  if(fs.existsSync(controlPath(root,'locks/acceptance.json')))fail('acceptance is active or uncertain');
  if(fs.existsSync(controlPath(root,'tasks',s.task_id,`launch-${s.iteration}.json`))||fs.existsSync(controlPath(root,'tasks',s.task_id,`process-${s.iteration}.json`)))fail('apply must precede worker launch; never mutate alongside a live or uncertain worker');
  const bundle=read(bundlePath(root,id)),{bundle_digest,...value}=bundle;
  if(bundle.revision!==1||bundle.task_id!==id||bundle.workflow_digest!==p.workflow.digest||bundle_digest!==hash(JSON.stringify(value))||input.bundle_digest!==bundle_digest)fail('bundle identity changed');
  const close=read(controlPath(root,'workflow',`close-${id}.json`));
  if(close.state?.phase!=='CLOSE'||close.state.post_digest!==bundle.reviewed_digest||close.digest!==p.workflow.digest)fail('reviewed child identity changed');
  const childDir=controlPath(close.workspace,'tasks',id),base=read(path.join(childDir,'baseline.json')),post=read(path.join(childDir,`post-${close.state.iteration}.json`));
  if(base.digest!==bundle.base_digest||post.digest!==bundle.reviewed_digest||!Array.isArray(bundle.files)||!equal(bundle.files.map(f=>f.path),changes(base,post)))fail('bundle differs from reviewed change set');
  for(const f of bundle.files)if(!equal(f.before,base.files[f.path])||!equal(f.after,post.files[f.path]))fail('bundle differs from reviewed files');
  const receiptFile=controlPath(root,'workflow',`apply-${s.task_id}-${s.iteration}.json`),tree=snapshot(root);
  if(fs.existsSync(receiptFile)){
   const prior=read(receiptFile);
   if(prior.status!=='applied'||prior.bundle_digest!==bundle_digest||prior.task_id!==s.task_id||prior.round!==s.iteration||prior.after_digest!==tree.digest)fail('prior apply is uncertain or tree changed; inspect without replay');
   return {...prior,replayed:false};
  }
  if(input.expected_digest!==tree.digest)fail('integration base changed');
  if(!Array.isArray(bundle.files)||bundle.files.length>MAX_FILES)fail('invalid bundle files');
  let total=0;const seen=new Set();
  for(const f of bundle.files){
   if(seen.has(f.path.toLowerCase())||!inside(f.path,child.scope.paths)||!inside(f.path,integration.scope.paths))fail('duplicate or out-of-scope bundle path');
   seen.add(f.path.toLowerCase());plainFile(root,f.path);
   if(!equal(tree.files[f.path],f.before))fail('conflict at '+f.path);
   if(f.before&&f.before.kind!=='file'||f.after&&f.after.kind!=='file')fail('regular files required');
   if(f.after){
    if(typeof f.data!=='string'||!Number.isInteger(f.after.mode)||f.after.mode<0||f.after.mode>0o777)fail('invalid payload');
    const data=Buffer.from(f.data,'base64');total+=data.length;
    if(data.toString('base64')!==f.data||hash(data)!==f.after.sha256||total>MAX_BYTES)fail('invalid or oversized payload');
   }else if(f.data!==null)fail('deleted file has payload');
  }
  const intent={revision:1,status:'intent',task_id:s.task_id,round:s.iteration,child_id:id,bundle_digest,before_digest:tree.digest};
  immutable(receiptFile,intent);
  // A crash after this intent is intentionally ambiguous and cannot be replayed.
  for(const f of bundle.files){
   const target=plainFile(root,f.path);
   if(f.after){fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,Buffer.from(f.data,'base64'));fs.chmodSync(target,f.after.mode);}
   else fs.unlinkSync(target);
  }
  const after=snapshot(root);
  for(const f of bundle.files)if(!equal(after.files[f.path],f.after))fail('applied file verification failed');
  const changed=changes(tree,after);
  if(changed.some(name=>!bundle.files.some(f=>f.path===name)))fail('unrelated tree change during apply');
  const receipt={...intent,status:'applied',after_digest:after.digest,changed};atomic(receiptFile,receipt);
  return receipt;
 }finally{release();}
}
