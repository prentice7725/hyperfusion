import fs from 'node:fs';
import path from 'node:path';
import {git,hash} from './artifact.mjs';
const names=new Set(['AGENTS.md','AGENTS.override.md','CLAUDE.md','GEMINI.md']);
export function instructionInventory(root) {
 if(!root)return [];
 let inventoryUnavailable=false,listed=[];
 try{listed=git(root,['ls-files','-z','--cached','--others','--exclude-standard']).split('\0');}catch{inventoryUnavailable=true;}
 const candidates=new Set(listed.filter(p=>names.has(path.posix.basename(p))));
 for(const name of ['AGENTS.md','AGENTS.override.md','CLAUDE.md','GEMINI.md','.claude/CLAUDE.md'])if(fs.existsSync(path.join(root,name)))candidates.add(name);
 const entries=[...candidates].sort().map(file=>{
  const full=path.join(root,file);
  // Do not follow a symlinked parent directory just to inventory instructions.
  let parent=root;
  for(const part of file.split('/').slice(0,-1)){
   parent=path.join(parent,part);
   try{if(fs.lstatSync(parent).isSymbolicLink())return {path:file,status:'symlink-parent-not-followed',sha256:null};}catch{return {path:file,status:'missing',sha256:null};}
  }
  let stat;try{stat=fs.lstatSync(full);}catch{return {path:file,status:'missing',sha256:null};}
  if(stat.isSymbolicLink())return {path:file,status:'symlink-not-followed',sha256:hash(fs.readlinkSync(full))};
  if(!stat.isFile()||stat.size>256*1024)return {path:file,status:'not-hashed',sha256:null};
  return {path:file,status:'recorded',sha256:hash(fs.readFileSync(full))};
 });
 return inventoryUnavailable?[{path:null,status:'git-inventory-unavailable',sha256:null},...entries]:entries;
}
