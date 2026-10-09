import fs from 'node:fs';
import path from 'node:path';
import {git,repo,read,atomic} from './artifact.mjs';
import {stateHome,repoId,controlPath,ensureControl,assertPlainDir,acquireLock} from './control-dir.mjs';
import {isMain,samePath} from './platform.mjs';
import {TERMINAL_PHASES} from './state-policy.mjs';
import {readInput,printError} from './cli.mjs';

const valid=id=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id);
const workspacePath=(root,id)=>path.resolve(stateHome(),'worktrees',repoId(root),id);
const manifest=(root,id)=>controlPath(root,'worktrees',id+'.json');
const locked=(root,fn)=>{ensureControl(root);const unlock=acquireLock(controlPath(root,'locks/worktrees.lock'));try{return fn();}finally{unlock();}};

export function createWorktree(root,id) {
 root=repo(root);if(!valid(id))throw Error('Invalid task_id');
 return locked(root,()=>{
  const workspace=workspacePath(root,id),file=manifest(root,id);
  if(fs.existsSync(file)||fs.existsSync(workspace))throw Error('Worktree task already exists: '+id);
  assertPlainDir(path.dirname(workspace));fs.mkdirSync(path.dirname(workspace),{recursive:true});
  const base=git(root,['rev-parse','HEAD']).trim();
  git(root,['worktree','add','--detach',workspace,base]);
  // Preserve repository policy for an untracked local config, without copying dirty code.
  const config=path.join(root,'hyperfusion.config.json');
  if(fs.existsSync(config))fs.copyFileSync(config,path.join(workspace,'hyperfusion.config.json'));
  const record={task_id:id,source_root:root,workspace,base_commit:base,created_at:new Date().toISOString()};
  atomic(file,record);
  return {...record,next_action:'init and run the task in workspace; each worktree has independent state and writer lease. Review and integrate changes explicitly.'};
 });
}
export function listWorktrees(root) {
 root=repo(root);const dir=controlPath(root,'worktrees');
 if(!fs.existsSync(dir))return [];
 return fs.readdirSync(dir).filter(f=>f.endsWith('.json')).map(f=>{
  const entry=read(path.join(dir,f)),sf=controlPath(entry.workspace,'state.json');
  return {...entry,phase:fs.existsSync(sf)?read(sf).phase:null};
 });
}
export function removeWorktree(root,id,input={}) {
 root=repo(root);if(!valid(id)||input.quiescent!==true)throw Error('Worktree removal requires a valid task_id and quiescent:true');
 return locked(root,()=>{
  const file=manifest(root,id),record=read(file),expected=workspacePath(root,id);
  if(!samePath(record.source_root,root)||!samePath(record.workspace,expected))throw Error('Worktree manifest path mismatch');
  assertPlainDir(expected);
  const sf=controlPath(expected,'state.json');
  if(fs.existsSync(controlPath(expected,'locks/writer.json')))throw Error('Writer still present; recover');
  if(fs.existsSync(controlPath(expected,'locks/acceptance.json')))throw Error('Acceptance shutdown is unconfirmed; recover or archive before removal');
  if(fs.existsSync(sf)){const state=read(sf);if(!TERMINAL_PHASES.includes(state.phase)||state.open_consult)throw Error('Worktree task is unfinished');}
  // Git refuses dirty/untracked contents. No force removal and no automatic merge.
  git(root,['worktree','remove',expected]);fs.unlinkSync(file);
  return {task_id:id,removed:true};
 });
}
if(isMain(import.meta.url)){
 try{const [action,root,id,file]=process.argv.slice(2);const result=action==='create'?createWorktree(root,id):action==='list'?listWorktrees(root):action==='remove'?removeWorktree(root,id,readInput(file)):null;
  if(result===null)throw Error('Usage: worktree.mjs create|list|remove REPO [TASK_ID] [INPUT.json|-]');console.log(JSON.stringify(result,null,2));
 }catch(e){printError(e);}
}
