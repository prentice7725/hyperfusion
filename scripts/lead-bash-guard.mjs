import path from 'node:path';
// Recognize known dangerous shell forms. This is a hook guard, not a shell
// parser or an OS boundary: aliases, arbitrary scripts and API tools need host policy.
export function shellWords(command) {
 const words=[];let word='',quote=null;
 for(let i=0;i<command.length;i++){
  const ch=command[i];
  if(quote){if(ch===quote)quote=null;else word+=ch;continue;}
  if(ch==='"'||ch==="'"){quote=ch;continue;}
  if(/[\s;&|()]/.test(ch)){if(word){words.push(word);word='';}}else word+=ch;
 }
 if(word)words.push(word);return words;
}
export function bashDirectories(command,cwd) {
 const words=shellWords(command),dirs=[cwd];let current=cwd;
 for(let i=0;i<words.length;i++){
  if(words[i]==='cd'&&words[i+1]&&!/[$`]/.test(words[i+1])){current=path.resolve(current,words[++i]);dirs.push(current);}
  else if(['-C','--work-tree','--git-dir'].includes(words[i])&&words[i+1]&&!/[$`]/.test(words[i+1]))dirs.push(path.resolve(current,words[++i]));
  else if(/^--(?:work-tree|git-dir)=/.test(words[i]))dirs.push(path.resolve(current,words[i].slice(words[i].indexOf('=')+1)));
 }
 return dirs;
}
export function dangerousBash(command) {
 if(typeof command!=='string')return null;
 const words=shellWords(command.replace(/\\\r?\n/g,''));
 const base=v=>v.replaceAll('\\','/').split('/').at(-1).toLowerCase().replace(/\.exe$/,'');
 for(let i=0;i<words.length;i++){
  const name=base(words[i]);
  if(name==='git'){
   let n=i+1;
   for(;n<words.length&&words[n].startsWith('-');n++){
    if(['-C','-c','--git-dir','--work-tree','--namespace','--exec-path'].includes(words[n]))n++;
   }
   const verb=words[n]?.toLowerCase(),args=words.slice(n+1);
   if(['commit','push'].includes(verb))return 'git '+verb;
   if(verb==='reset'&&args.includes('--hard'))return 'git reset --hard';
   if(verb==='clean'&&args.some(a=>a==='--force'||/^-[^-]*f/.test(a)))return 'git clean with force';
  }
  if(name==='rm'){
   const flags=words.slice(i+1).filter(w=>w.startsWith('-'));
   const recursive=flags.some(w=>w==='--recursive'||/^-[^-]*[rR]/.test(w));
   const force=flags.some(w=>w==='--force'||/^-[^-]*f/.test(w));
   if(recursive&&force)return 'recursive force deletion';
  }
  if(name==='remove-item'&&words.slice(i+1).some(w=>w.toLowerCase()==='-recurse')&&words.slice(i+1).some(w=>w.toLowerCase()==='-force'))return 'recursive force deletion';
 }
 return null;
}
