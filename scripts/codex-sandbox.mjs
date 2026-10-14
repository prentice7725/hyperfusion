import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {git} from './artifact.mjs';
import {stateHome} from './control-dir.mjs';

// Resolve existing ancestors too: protected directories need not exist yet.
export function canonicalPath(input) {
 let target=path.resolve(input),tail=[];
 while(!fs.existsSync(target)) {tail.unshift(path.basename(target));const up=path.dirname(target);if(up===target)break;target=up;}
 const real=path.join(fs.realpathSync(target),...tail);
 return process.platform==='win32'?real.toLowerCase():real;
}
const contains=(a,b)=>{const rel=path.relative(a,b);return rel===''||(!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep));};
export function protectedRoots(repoRoot,env=process.env) {
 const home=os.homedir();
 const roots=[stateHome(),env.HF_STATE_DIR,path.join(home,'.hyperfusion','state'),path.join(home,'.claude'),path.join(home,'.codex'),
  env.CODEX_HOME,env.CLAUDE_CONFIG_DIR,env.HF_SKILL,process.env.CODEX_HOME,process.env.CLAUDE_CONFIG_DIR,process.env.HF_SKILL,
  path.resolve(fileURLToPath(new URL('..',import.meta.url)))].filter(Boolean);
 if(repoRoot){
  roots.push(path.join(repoRoot,'.git'),path.join(repoRoot,'.fusion'));
  roots.push(...git(repoRoot,['rev-parse','--git-common-dir','--git-dir']).trim().split(/\r?\n/).map(p=>path.resolve(repoRoot,p)));
 }
 return roots.map(canonicalPath);
}
// Operator environment only: repository config/worker output cannot widen it.
export function sandboxArgs({consult=false,repoRoot}={},env=process.env) {
 if(consult)return [];
 const args=[];
 if(env.HF_CODEX_WRITABLE_ROOTS!==undefined){
  let roots;try{roots=JSON.parse(env.HF_CODEX_WRITABLE_ROOTS);}catch{throw Error('CODEX_SANDBOX: writable roots must be a JSON array');}
  if(!Array.isArray(roots)||roots.length>20||roots.some(r=>typeof r!=='string'||!path.isAbsolute(r)||!fs.existsSync(r)||!fs.statSync(r).isDirectory()))throw Error('CODEX_SANDBOX: writable roots must be existing absolute directories');
  const resolved=[...new Set(roots.map(r=>fs.realpathSync(r)))];
  if(resolved.some(r=>r===path.parse(r).root))throw Error('CODEX_SANDBOX: filesystem root cannot be writable');
  const protectedPaths=protectedRoots(repoRoot,env);
  if(resolved.some(r=>protectedPaths.some(p=>contains(canonicalPath(r),p)||contains(p,canonicalPath(r)))))throw Error('CODEX_SANDBOX: writable root overlaps protected control, skill, Git or CLI configuration paths');
  args.push('-c','sandbox_workspace_write.writable_roots='+JSON.stringify(resolved));
 }
 if(env.HF_CODEX_NETWORK_ACCESS!==undefined){
  if(!['0','1'].includes(env.HF_CODEX_NETWORK_ACCESS))throw Error('CODEX_SANDBOX: network access must be 0 or 1');
  args.push('-c','sandbox_workspace_write.network_access='+(env.HF_CODEX_NETWORK_ACCESS==='1'));
 }
 return args;
}
