import fs from 'node:fs';
import path from 'node:path';
import {config,selectExecutor,EXECUTORS,CAP} from './executor-config.mjs';
import {adapter} from './adapters/index.mjs';
import {repo,git,read} from './artifact.mjs';

// 실행 전 점검. 일꾼 CLI는 모두 프로브해서 교체 가능한 인력을 미리 파악한다.
const checks=[];
const check=(name,fn)=>{try{checks.push({name,ok:true,detail:fn()});}catch(e){checks.push({name,ok:false,detail:e.message});}};
check('node',()=>{if(Number(process.versions.node.split('.')[0])<20)throw Error('Node 20+ required');return process.version;});
const flags=process.argv.slice(3);
let selected,c;
check('executor',()=>{c=config(process.argv[2]??process.cwd());if(flags.length&&(flags.length!==2||flags[0]!=='--executor'))throw Error('Use --executor NAME');selected=selectExecutor(c,flags[1]);return selected==='auto'?'auto (router picks per task)':selected;});
const bench=[];
for(const name of c?.external.available??[]){
 const entry=()=>adapter(name).probe(c.executors[name]??{});
 if(name===selected)check(name+'-cli',entry);
 else{try{bench.push({name,ok:true,detail:entry()});}catch(e){bench.push({name,ok:false,detail:e.message});}}
}
// auto면 한 명이라도 설치돼 있으면 통과. 명시 지정이면 그 일꾼이 반드시 있어야 한다.
if(selected==='auto')check('workers',()=>{const ok=bench.filter(b=>b.ok).map(b=>b.name);if(!ok.length)throw Error('ADAPTER_UNAVAILABLE: no worker CLI installed');return ok.join(', ');});
let root;
check('repository',()=>{root=repo(process.argv[2]??process.cwd());git(root,['rev-parse','HEAD']);return root;});
if(root){
 check('worktree',()=>{if(git(root,['ls-files','--stage']).split('\n').some(x=>x.startsWith('160000')))throw Error('Submodules are not supported');return 'ordinary git worktree';});
 check('metadata',()=>{const d=path.join(root,'.fusion');if(fs.existsSync(d)&&fs.lstatSync(d).isSymbolicLink())throw Error('.fusion symlink');return 'cooperative locking only';});
 check('recovery',()=>{for(const f of ['locks/control.lock','locks/writer.json'])if(fs.existsSync(path.join(root,'.fusion',f)))throw Error('RECOVERY_REQUIRED: '+f);const f=path.join(root,'.fusion/state.json');if(fs.existsSync(f)){const s=read(f);if(['EXECUTING','RECOVERY_REQUIRED'].includes(s.phase))throw Error('RECOVERY_REQUIRED: '+s.phase);}return 'no interrupted mutation';});
 check('metadata-ignore',()=>{try{git(root,['check-ignore','.fusion/state.json']);}catch{throw Error('Add /.fusion/ to local git info/exclude before init');}return 'ignored';});
}
console.log(JSON.stringify({ok:checks.every(x=>x.ok),checks,bench,roster:{lead:'Claude Opus 5.5 (host)',workers:EXECUTORS,caps:CAP,selected,routing_rules:c?.routing.rules??null}},null,2));
if(checks.some(x=>!x.ok))process.exitCode=1;
