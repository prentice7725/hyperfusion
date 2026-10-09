import fs from 'node:fs';
import path from 'node:path';
import {config,selectExecutor,EXECUTORS,CAP} from './executor-config.mjs';
import {adapter} from './adapters/index.mjs';
import {repo,git,read,atomic,riskyGitConfig} from './artifact.mjs';
import {controlRoot,controlPath,isLegacy,ensureControl} from './control-dir.mjs';
import {workspaceOf} from './memory-policy.mjs';
import {stats as memoryStats,bindingStatus} from './memory-store.mjs';
import {repoId} from './control-dir.mjs';
import {status as projectStatus} from './project.mjs';
import {errorRecord} from './cli.mjs';
import {SCHEMA_VERSION} from './versions.mjs';
import {smoke} from './smoke.mjs';

// 실행 전 점검. 일꾼 CLI는 모두 프로브해서 교체 가능한 인력을 미리 파악한다.
const checks=[];
const probeEvidence={};
const probeMember=name=>{
 try{const p=adapter(name).probe(c.executors[name]??{});probeEvidence[name]={...p,help:p.help};return p;}
 catch(e){probeEvidence[name]={error:e.message,...e.probe};throw e;}
};
const check=(name,fn)=>{try{checks.push({name,ok:true,detail:fn()});}catch(e){checks.push({name,ok:false,detail:e.message,error:errorRecord(e)});}};
check('node',()=>{if(Number(process.versions.node.split('.')[0])<20)throw Error('Node 20+ required');return process.version;});
// 옵션: --executor NAME, --smoke[=NAME,NAME] (설치된 일꾼에게 작은 작업을 실제로 시킨다. 비용이 든다)
const argv=process.argv.slice(3),flags=[];let smokeWanted=null;
for(const a of argv){if(a==='--smoke')smokeWanted='installed';else if(a.startsWith('--smoke='))smokeWanted=a.slice(8).split(',').filter(Boolean);else flags.push(a);}
let selected,c;
check('executor',()=>{c=config(process.argv[2]??process.cwd());if(flags.length&&(flags.length!==2||flags[0]!=='--executor'))throw Error('Use --executor NAME');selected=selectExecutor(c,flags[1]);return selected==='auto'?'auto (router picks per task)':selected;});
const bench=[];
for(const name of c?.external.available??[]){
 const entry=()=>probeMember(name);
 if(name===selected)check(name+'-cli',entry);
 else{try{bench.push({name,ok:true,detail:entry()});}catch(e){bench.push({name,ok:false,detail:e.message,error:errorRecord(e)});}}
}
// auto면 한 명이라도 설치돼 있으면 통과. 명시 지정이면 그 일꾼이 반드시 있어야 한다.
if(selected==='auto')check('workers',()=>{const ok=bench.filter(b=>b.ok).map(b=>b.name);if(!ok.length)throw Error('ADAPTER_UNAVAILABLE: no worker CLI installed');return ok.join(', ');});
const warnings=[];
let root;
check('repository',()=>{root=repo(process.argv[2]??process.cwd());git(root,['rev-parse','HEAD']);return root;});
if(root){
 check('worktree',()=>{if(git(root,['ls-files','--stage']).split('\n').some(x=>x.startsWith('160000')))throw Error('Submodules are not supported');return 'ordinary git worktree';});
 // 제어 파일은 작업 폴더 밖에 둔다(일꾼의 편집 도구가 닿지 않게). 예전 .fusion이 남아 있으면 이전하라고 알린다.
 check('control-dir',()=>{
  const d=controlRoot(root);
  if(fs.existsSync(d)&&fs.lstatSync(d).isSymbolicLink())throw Error('control directory is a symlink: '+d);
  if(isLegacy(root))throw Error(`LEGACY_CONTROL_DIR: records are inside the workspace (${d}), where workers can edit them. Run: node fusion-state.mjs migrate ${root}`);
  return d+' (outside the workspace; cooperative locking only)';
 });
 // 저장소 설정에 실행 가능한 항목(훅, fsmonitor, filter, 외부 diff)이 있으면 알린다. 막지는 않는다(husky 같은 정상 사용이 있다).
 try{const risky=riskyGitConfig(root);if(risky.length)warnings.push('git config can run commands (verify they are yours): '+risky.join('; '));}catch(e){warnings.push('git config scan failed: '+e.message);}
 // 중단 흔적이 있으면 무엇이 남았는지와 다음 명령까지 보여 준다. 잠금은 절대 자동으로 지우지 않는다.
 check('recovery',()=>{
  const lock=f=>controlPath(root,'locks',f),sf=controlPath(root,'state.json');
  const s=fs.existsSync(sf)?read(sf):null,problems=[];
  if(fs.existsSync(lock('control.lock')))problems.push('control.lock (controller crashed mid-command)');
  if(fs.existsSync(lock('writer.json'))){const w=read(lock('writer.json'));problems.push(`writer.json owner=${w.owner} task=${w.task_id} round=${w.round} since=${w.created_at}`);}
  if(s&&['EXECUTING','RECOVERY_REQUIRED'].includes(s.phase))problems.push('phase '+s.phase);
  if(!problems.length)return 'no interrupted mutation';
  const legacy=s&&s.schema_version!==SCHEMA_VERSION;
  throw Error('RECOVERY_REQUIRED: '+problems.join('; ')+(s?` | state task=${s.task_id} schema=${s.schema_version} phase=${s.phase}`:' | no state.json')
   +' | next: confirm no worker/controller process is running, then '+(legacy?'archive (state from another branch/version)':'recover')+' with the writer token; see references/recovery-protocol.md');
 });
}
// 리뷰 위임이 켜져 있으면 리뷰어(구현 일꾼이 아닌 Codex 포함)도 점검한다. 최소 한 명은 있어야 한다.
let reviewers=null;
if(c?.review.by==='delegate'){
 reviewers=c.review.reviewers.map(name=>{const b=bench.find(x=>x.name===name);if(b)return {name,ok:b.ok,detail:b.detail};if(name===selected)return {name,ok:true};try{return {name,ok:true,detail:adapter(name).probe(c.executors[name]??{})};}catch(e){return {name,ok:false,detail:e.message};}});
 check('reviewers',()=>{const ok=reviewers.filter(r=>r.ok).map(r=>r.name);if(!ok.length)throw Error('review.by is delegate but no reviewer CLI is installed');return ok.join(', ');});
}
// 기억 계층은 선택 사항이라 실패해도 전체 점검을 막지 않는다.
let memory=null;
try{const w=c?workspaceOf(c):null;if(w){memory={...memoryStats(w),binding:root?bindingStatus(w,repoId(root)):'unknown'};if(memory.binding==='foreign'||memory.binding==='unclaimed')warnings.push(`memory workspace "${w}" is ${memory.binding==='foreign'?'bound to other repositories':'not bound to any repository'}; memory commands will refuse until the user approves: node memory.mjs bind REPO`);}}catch(e){memory={error:e.message};}
let project=null;
try{if(root)project=projectStatus(root);}catch(e){project={error:e.message};}
let probe_file=null;
if(root&&!isLegacy(root)){
 try{ensureControl(root);probe_file=controlPath(root,'doctor',`probes-${Date.now()}-${process.pid}.json`);atomic(probe_file,{at:new Date().toISOString(),probes:probeEvidence});}
 catch(e){warnings.push('probe evidence not saved: '+e.message);}
}
// 어댑터 계약 스모크. 아침에 한 번 돌리면 밤사이 CLI 업데이트로 누가 고장 났는지 바로 나온다.
let smoke_results=null;
if(smokeWanted&&c){
 const installed=[...bench.filter(b=>b.ok).map(b=>b.name),...checks.filter(x=>x.ok&&x.name.endsWith('-cli')).map(x=>x.name.slice(0,-4))];
 const names=smokeWanted==='installed'?installed:smokeWanted;
 check('smoke-targets',()=>{const bad=names.filter(n=>!EXECUTORS.includes(n));if(bad.length)throw Error('Unknown or non-implementing workers: '+bad.join(', '));if(!names.length)throw Error('No installed worker to smoke');return names.join(', ');});
 if(names.every(n=>EXECUTORS.includes(n))&&names.length){
  smoke_results=await smoke(names);
  check('smoke',()=>{const broken=smoke_results.filter(r=>!r.ok);if(broken.length)throw Error('Contract broken: '+broken.map(r=>`${r.executor} at ${r.stage}: ${r.error}`).join(' | '));return smoke_results.map(r=>`${r.executor} ok ${Math.round(r.ms/1000)}s`).join(', ');});
 }
}
console.log(JSON.stringify({ok:checks.every(x=>x.ok),checks,warnings,smoke:smoke_results,bench,reviewers,memory,project,probe_file,review:c?.review??null,roster:{lead:`${c?.lead_model??'Claude Opus'} (host)`,workers:EXECUTORS,caps:CAP,selected,routing_rules:c?.routing.rules??null}},null,2));
if(checks.some(x=>!x.ok))process.exitCode=1;
