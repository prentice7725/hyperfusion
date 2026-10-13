import fs from 'node:fs';
import path from 'node:path';
// Operator environment only: repository config/worker output cannot widen it.
export function sandboxArgs({consult=false}={},env=process.env) {
 if(consult)return [];
 const args=[];
 if(env.HF_CODEX_WRITABLE_ROOTS!==undefined){
  let roots;try{roots=JSON.parse(env.HF_CODEX_WRITABLE_ROOTS);}catch{throw Error('CODEX_SANDBOX: writable roots must be a JSON array');}
  if(!Array.isArray(roots)||roots.length>20||roots.some(r=>typeof r!=='string'||!path.isAbsolute(r)||!fs.existsSync(r)||!fs.statSync(r).isDirectory()))throw Error('CODEX_SANDBOX: writable roots must be existing absolute directories');
  const resolved=[...new Set(roots.map(r=>fs.realpathSync(r)))];
  if(resolved.some(r=>r===path.parse(r).root))throw Error('CODEX_SANDBOX: filesystem root cannot be writable');
  args.push('-c','sandbox_workspace_write.writable_roots='+JSON.stringify(resolved));
 }
 if(env.HF_CODEX_NETWORK_ACCESS!==undefined){
  if(!['0','1'].includes(env.HF_CODEX_NETWORK_ACCESS))throw Error('CODEX_SANDBOX: network access must be 0 or 1');
  args.push('-c','sandbox_workspace_write.network_access='+(env.HF_CODEX_NETWORK_ACCESS==='1'));
 }
 return args;
}
