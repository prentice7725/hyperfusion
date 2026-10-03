import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
export const hash = v => crypto.createHash('sha256').update(v).digest('hex');
export const read = f => JSON.parse(fs.readFileSync(f,'utf8'));
export function atomic(f,v) {
  fs.mkdirSync(path.dirname(f),{recursive:true});
  const tmp=f+'.'+crypto.randomUUID()+'.tmp';
  const fd=fs.openSync(tmp,'wx',0o600);
  try { fs.writeFileSync(fd,JSON.stringify(v,null,2)+'\n'); fs.fsyncSync(fd); } finally {fs.closeSync(fd);}
  fs.renameSync(tmp,f);
}
export function immutable(f,v) {
  fs.mkdirSync(path.dirname(f),{recursive:true});
  fs.writeFileSync(f,JSON.stringify(v,null,2)+'\n',{flag:'wx',mode:0o600});
}
export function git(root,args) {return execFileSync('git',['-C',root,...args],{encoding:'utf8',maxBuffer:64*1024*1024});}
export function repo(input) {
 const root=fs.realpathSync(git(input,['rev-parse','--show-toplevel']).trim());
 if(fs.realpathSync(input)!==root) throw Error('Use repository root');
 return root;
}
export function snapshot(root) {
 const files={};
 const names=[...new Set(git(root,['ls-files','-z','--cached','--others','--exclude-standard']).split('\0').filter(Boolean))].sort();
 for(const name of names) {
   if(name==='.fusion'||name.startsWith('.fusion/')) continue;
   const f=path.join(root,name);
   try {
     const st=fs.lstatSync(f);
     if(st.isDirectory()) throw Error('Submodules/directories unsupported by M0: '+name);
     files[name]={kind:st.isSymbolicLink()?'symlink':'file',mode:st.mode&0o777,sha256:hash(st.isSymbolicLink()?fs.readlinkSync(f):fs.readFileSync(f))};
   } catch(e) {if(e.code==='ENOENT') files[name]=null;else throw e;}
 }
 const head=git(root,['rev-parse','HEAD']).trim();
 const status=git(root,['status','--porcelain=v1','-z','--untracked-files=all','--','.',':(exclude).fusion']);
 const index_hash=hash(git(root,['ls-files','--stage','-z']));
 return {head,status,index_hash,files,digest:hash(JSON.stringify({head,status,index_hash,files}))};
}
export function changes(a,b) {
 return [...new Set([...Object.keys(a.files),...Object.keys(b.files)])].filter(k=>JSON.stringify(a.files[k]??null)!==JSON.stringify(b.files[k]??null)).sort();
}
