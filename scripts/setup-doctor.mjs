import fs from 'node:fs';
import {config,selectExecutor,REGISTRY} from './executor-config.mjs';
import {probeClaude} from './claude-adapter.mjs';
import path from 'node:path';
import {repo,git,read} from './artifact.mjs';
const checks=[];
const check=(name,fn)=>{try{checks.push({name,ok:true,detail:fn()});}catch(e){checks.push({name,ok:false,detail:e.message});}};
check('node',()=>{if(Number(process.versions.node.split('.')[0])<20)throw Error('Node 20+ required');return process.version;});
const flags=process.argv.slice(3);
let selected;
check('executor',()=>{const c=config(process.argv[2]??process.cwd());if(flags.length&&(flags.length!==2||flags[0]!=='--executor'))throw Error('Use --executor NAME');selected=selectExecutor(c,flags[1]);return selected;});
if(selected==='claude')check('claude-cli',()=>probeClaude());
let root;
check('repository',()=>{root=repo(process.argv[2]??process.cwd());git(root,['rev-parse','HEAD']);return root;});
if(root){
 check('worktree',()=>{const subs=git(root,['ls-files','--stage']).split('\n').filter(x=>x.startsWith('160000'));if(subs.length)throw Error('External M0 does not support submodules');return 'ordinary git worktree';});
 check('metadata',()=>{const d=path.join(root,'.fusion');if(fs.existsSync(d)&&fs.lstatSync(d).isSymbolicLink())throw Error('.fusion symlink');return 'cooperative locking only';});
 check('recovery',()=>{for(const f of ['locks/control.lock','locks/writer.json'])if(fs.existsSync(path.join(root,'.fusion',f)))throw Error('RECOVERY_REQUIRED: '+f);const f=path.join(root,'.fusion/state.json');if(fs.existsSync(f)){const s=read(f);if(['EXECUTING','RECOVERY_REQUIRED'].includes(s.phase))throw Error('RECOVERY_REQUIRED: '+s.phase);}return 'no interrupted mutation';});
 check('metadata-ignore',()=>{try{git(root,['check-ignore','.fusion/state.json']);}catch{throw Error('Add /.fusion/ to local git info/exclude before init');}return 'ignored';});
}
console.log(JSON.stringify({ok:checks.every(x=>x.ok),checks,adapter:{selected,registry:REGISTRY,internal_helper:'Luna, only after review',claude:'POSIX bridge; credentials checked only by actual invocation'}},null,2));
if(checks.some(x=>!x.ok))process.exitCode=1;
