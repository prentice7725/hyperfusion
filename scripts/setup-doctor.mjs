import fs from 'node:fs';
import path from 'node:path';
import {config,selectExecutor,EXECUTORS,CAP} from './executor-config.mjs';
import {adapter} from './adapters/index.mjs';
import {repo,git,read} from './artifact.mjs';
import {workspaceOf} from './memory-policy.mjs';
import {stats as memoryStats} from './memory-store.mjs';
import {status as projectStatus} from './project.mjs';

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
 // 중단 흔적이 있으면 무엇이 남았는지와 다음 명령까지 보여 준다. 잠금은 절대 자동으로 지우지 않는다.
 check('recovery',()=>{
  const lock=f=>path.join(root,'.fusion/locks',f),sf=path.join(root,'.fusion/state.json');
  const s=fs.existsSync(sf)?read(sf):null,problems=[];
  if(fs.existsSync(lock('control.lock')))problems.push('control.lock (controller crashed mid-command)');
  if(fs.existsSync(lock('writer.json'))){const w=read(lock('writer.json'));problems.push(`writer.json owner=${w.owner} task=${w.task_id} round=${w.round} since=${w.created_at}`);}
  if(s&&['EXECUTING','RECOVERY_REQUIRED'].includes(s.phase))problems.push('phase '+s.phase);
  if(!problems.length)return 'no interrupted mutation';
  const legacy=s&&s.schema_version!==4;
  throw Error('RECOVERY_REQUIRED: '+problems.join('; ')+(s?` | state task=${s.task_id} schema=${s.schema_version} phase=${s.phase}`:' | no state.json')
   +' | next: confirm no worker/controller process is running, then '+(legacy?'archive (state from another branch/version)':'recover')+' with the writer token; see references/recovery-protocol.md');
 });
 check('metadata-ignore',()=>{try{git(root,['check-ignore','.fusion/state.json']);}catch{throw Error('Add /.fusion/ to local git info/exclude before init');}return 'ignored';});
}
// 리뷰 위임이 켜져 있으면 리뷰어(구현 일꾼이 아닌 Codex 포함)도 점검한다. 최소 한 명은 있어야 한다.
let reviewers=null;
if(c?.review.by==='delegate'){
 reviewers=c.review.reviewers.map(name=>{const b=bench.find(x=>x.name===name);if(b)return {name,ok:b.ok,detail:b.detail};if(name===selected)return {name,ok:true};try{return {name,ok:true,detail:adapter(name).probe(c.executors[name]??{})};}catch(e){return {name,ok:false,detail:e.message};}});
 check('reviewers',()=>{const ok=reviewers.filter(r=>r.ok).map(r=>r.name);if(!ok.length)throw Error('review.by is delegate but no reviewer CLI is installed');return ok.join(', ');});
}
// 기억 계층은 선택 사항이라 실패해도 전체 점검을 막지 않는다.
let memory=null;
try{const w=c?workspaceOf(c):null;if(w)memory=memoryStats(w);}catch(e){memory={error:e.message};}
let project=null;
try{if(root)project=projectStatus(root);}catch(e){project={error:e.message};}
console.log(JSON.stringify({ok:checks.every(x=>x.ok),checks,bench,reviewers,memory,project,review:c?.review??null,roster:{lead:'Claude Opus 5.5 (host)',workers:EXECUTORS,caps:CAP,selected,routing_rules:c?.routing.rules??null}},null,2));
if(checks.some(x=>!x.ok))process.exitCode=1;
