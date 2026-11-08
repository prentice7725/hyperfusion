// 벤치마크 품질 채점. 두 팔 모두에게 보이지 않은 숨긴 시험과 기존 시험 회귀, 범위 위반을 센다.
// 숨긴 시험은 저장소 밖(기본 ~/.hyperfusion/benchmark-hidden/<CASE>/*.test.mjs)에 둔다.
// 설치된 스킬은 이 저장소의 git 복제본이라, 저장소 안에 두면 리드나 일꾼이 읽을 수 있다.
// 채점은 시험 트리의 사본에서만 돌고, 시험 저장소와 제어 폴더에는 --record 때 metrics 파일 하나만 쓴다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {read,atomic} from './artifact.mjs';
import {controlPath} from './control-dir.mjs';
import {LARGE_CASES,treeFiles} from './benchmark-fixtures.mjs';

export const defaultHiddenDir=()=>process.env.HF_BENCHMARK_HIDDEN??path.join(os.homedir(),'.hyperfusion','benchmark-hidden');
const SKIP=/^(?:\.git|node_modules|\.build|\.hf-tmp)(?:\/|$)/;
const TEST_TIMEOUT_MS=300000;

const gitText=(repo,args)=>execFileSync('git',['-c','core.quotepath=false','-C',repo,...args],{encoding:'utf8',maxBuffer:64*1024*1024,stdio:['ignore','pipe','pipe']});
const lines=text=>text.split('\0').filter(Boolean);

export function hiddenTests(caseId,dir=defaultHiddenDir()) {
 const folder=path.join(dir,caseId);
 if(!fs.existsSync(folder))return [];
 return fs.readdirSync(folder).filter(f=>f.endsWith('.test.mjs')).sort().map(f=>path.join(folder,f));
}

// Files the trial ended with: tracked plus untracked, minus ignored files.
function trialFiles(repo) {
 const files=new Map();
 for(const file of lines(gitText(repo,['ls-files','-z','--cached','--others','--exclude-standard']))){
  if(SKIP.test(file))continue;
  const abs=path.join(repo,...file.split('/'));
  if(!fs.existsSync(abs))continue;
  const st=fs.lstatSync(abs);
  if(st.isFile())files.set(file,fs.readFileSync(abs));
 }
 return files;
}
function writeTree(root,files) {
 for(const [file,body] of files){const out=path.join(root,...file.split('/'));fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,body);}
 return root;
}
const rootCommit=repo=>gitText(repo,['rev-list','--max-parents=0','HEAD']).trim().split('\n')[0];

export function changedFiles(repo,base=rootCommit(repo)) {
 const diff=lines(gitText(repo,['diff','-z','--name-only',base]));
 const added=lines(gitText(repo,['ls-files','-z','--others','--exclude-standard']));
 return [...new Set([...diff,...added])].filter(f=>!SKIP.test(f)).sort();
}

const under=(file,prefix)=>file===prefix||file.startsWith(prefix.replace(/\/$/,'')+'/');
export function scopeViolations(changed,{editable=[],protectedFiles=[]}={}) {
 const outside=changed.filter(f=>!editable.some(p=>under(f,p)));
 return {count:outside.length,files:outside,protected_changed:outside.filter(f=>protectedFiles.includes(f))};
}

// Static ES import graph inside the tree. A test is affected when it reaches a changed file.
const IMPORT=/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g;
export function affectedTests(files,changed) {
 const deps=new Map();
 const resolve=(from,spec)=>path.posix.normalize(path.posix.join(path.posix.dirname(from),spec));
 for(const [file,body] of files)if(/\.m?js$/.test(file))deps.set(file,[...body.toString('utf8').matchAll(IMPORT)].map(m=>resolve(file,m[1])));
 const hit=new Set(changed),memo=new Map();
 const reaches=(file,seen=new Set())=>{
  if(memo.has(file))return memo.get(file);
  if(hit.has(file))return true;
  if(seen.has(file))return false;
  seen.add(file);
  const r=(deps.get(file)??[]).some(d=>reaches(d,seen));
  memo.set(file,r);return r;
 };
 return [...files.keys()].filter(f=>/^tests\/[^/]+\.test\.mjs$/.test(f)&&reaches(f)).sort();
}

function runTest(cwd,file,timeout=TEST_TIMEOUT_MS) {
 const {NODE_TEST_CONTEXT,...env}=process.env;
 return new Promise(resolve=>{
  const child=spawn(process.execPath,['--test','--test-reporter=tap',file],{cwd,env,windowsHide:true});
  let out='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>out+=d);
  const timer=setTimeout(()=>child.kill('SIGKILL'),timeout);
  child.on('close',code=>{
   clearTimeout(timer);
   const failed=[...out.matchAll(/^(?: {4})?not ok \d+ - (.+)$/gm)].map(m=>m[1].trim());
   const passedNames=[...out.matchAll(/^(?: {4})?ok \d+ - (.+)$/gm)].map(m=>m[1].trim().replace(/ # SKIP.*$/,''));
   resolve({file,ok:code===0,exit_code:code,passed:passedNames.length,passed_names:passedNames,failed});
  });
 });
}
// Windows: a test's leftover child can hold the copy for a while. Cleanup must never discard a finished score.
function cleanup(dir) {
 try{fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:500});}
 catch(error){process.stderr.write(`BENCHMARK: could not remove ${dir}: ${error.code??error.message}\n`);}
}
async function pool(items,limit,fn) {
 const out=[];let next=0;
 await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(next<items.length){const i=next++;out[i]=await fn(items[i]);}}));
 return out;
}

// Score one finished trial. Never touches the trial tree; works on copies.
// Windows: concurrent test files contaminate each other's process-tree checks (see run-tests.mjs), so stay serial there.
const defaultConcurrency=()=>process.platform==='win32'?1:Math.max(1,Math.floor(os.availableParallelism()/2));
export async function scoreTrial(caseId,repo,{hidden=defaultHiddenDir(),cases=LARGE_CASES,regressions=false,concurrency=defaultConcurrency()}={}) {
 const task=cases.find(c=>c.case_id===caseId);
 if(!task)throw Error('BENCHMARK: unknown case '+caseId);
 const tests=hiddenTests(caseId,hidden);
 if(!tests.length)throw Error(`BENCHMARK: no hidden tests for ${caseId} under ${hidden}`);
 repo=path.resolve(repo);
 const base=rootCommit(repo),changed=changedFiles(repo,base);
 const finalFiles=trialFiles(repo);
 const work=fs.mkdtempSync(path.join(os.tmpdir(),'hf-score-'));
 try{
  const finalRoot=writeTree(path.join(work,'final'),finalFiles);
  fs.mkdirSync(path.join(finalRoot,'tests','hidden'),{recursive:true});
  const hiddenNames=tests.map(t=>{const name='tests/hidden/'+path.basename(t);fs.copyFileSync(t,path.join(finalRoot,...name.split('/')));return name;});
  const hiddenRuns=await pool(hiddenNames,concurrency,f=>runTest(finalRoot,f));
  const hiddenSummary={files:hiddenRuns.length,passed:hiddenRuns.reduce((n,r)=>n+r.passed,0),failed:hiddenRuns.flatMap(r=>r.failed),
   crashed:hiddenRuns.filter(r=>!r.ok&&!r.failed.length).map(r=>({file:r.file,exit_code:r.exit_code}))};
  hiddenSummary.failed=hiddenSummary.failed.slice(0,50);
  let regression=null;
  if(regressions){
   const acceptance=new Set(task.acceptance_tests);
   const candidates=affectedTests(finalFiles,changed).filter(f=>!acceptance.has(f));
   // Affected files often cover most of the suite, so run the start tree only for files that fail at the end.
   const after=await pool(candidates,concurrency,f=>runTest(finalRoot,f));
   const failing=candidates.filter((f,i)=>!after[i].ok);
   let before=[];
   if(failing.length){const baseRoot=writeTree(path.join(work,'base'),treeFiles(repo,base));before=await pool(failing,concurrency,f=>runTest(baseRoot,f));}
   // Compare by test name, so a file that already failed for another reason still shows a test it newly breaks.
   const escaped=[];
   failing.forEach((f,i)=>{
    const end=after[candidates.indexOf(f)],start=before[i],passedBefore=new Set(start.passed_names);
    const newly=end.failed.filter(name=>passedBefore.has(name));
    const crashed=!end.failed.length&&start.ok;
    if(newly.length||crashed)escaped.push({file:f,failed:newly.slice(0,20),...(crashed?{crashed:true}:{})});
   });
   regression={checked:candidates.length,already_failing:failing.filter((f,i)=>!before[i].ok),escaped};
  }
  const scope=scopeViolations(changed,{editable:task.editable,protectedFiles:task.acceptance_tests});
  const hiddenFailures=hiddenSummary.failed.length+hiddenSummary.crashed.length;
  return {case_id:caseId,repo,changed_files:changed.length,hidden:hiddenSummary,hidden_passed:hiddenFailures===0,
   regression,scope,
   escaped_regressions:regression?regression.escaped.length:null,scope_violations:scope.count,
   note:'Hidden tests check brief-named items the protected acceptance test does not exercise. Regressions compare affected existing tests by name on the start tree and the final tree. A wrong close is a CLOSE whose hidden tests or regressions fail.'};
 }finally{cleanup(work);}
}

// Merge the score into the trial's metric record so compare-repeated can read it.
export function recordScore(repo,score) {
 const file=controlPath(repo,'metrics',score.case_id+'.json');
 if(!fs.existsSync(file))throw Error('BENCHMARK: no metric record to update: '+file);
 const metric=read(file);
 const wrong=metric.success===true&&(!score.hidden_passed||(score.escaped_regressions??0)>0)?1:0;
 const out={...metric,wrong_closes:wrong,scope_violations:score.scope_violations,
  ...(score.escaped_regressions===null?{}:{escaped_regressions:score.escaped_regressions}),
  quality:{hidden_passed:score.hidden_passed,hidden_failed:score.hidden.failed,hidden_crashed:score.hidden.crashed,
   escaped:score.regression?.escaped??null,scope_files:score.scope.files,scored_at:new Date().toISOString()}};
 atomic(file,out);
 return out;
}

// Check that a case's hidden tests pass on the reference commit and fail before it.
export async function checkHidden(caseId,{hidden=defaultHiddenDir(),source,cases=LARGE_CASES}={}) {
 const task=cases.find(c=>c.case_id===caseId);
 if(!task)throw Error('BENCHMARK: unknown case '+caseId);
 const tests=hiddenTests(caseId,hidden);
 if(!tests.length)throw Error(`BENCHMARK: no hidden tests for ${caseId} under ${hidden}`);
 const repo=source??process.env.HF_BENCHMARK_SOURCE??path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1')),'..');
 const work=fs.mkdtempSync(path.join(os.tmpdir(),'hf-hidden-check-'));
 try{
  const result={};
  for(const [label,rev] of [['reference',task.source_commit],['before',task.source_commit+'^']]){
   const root=writeTree(path.join(work,label),treeFiles(repo,rev));
   fs.mkdirSync(path.join(root,'tests','hidden'),{recursive:true});
   const names=tests.map(t=>{const name='tests/hidden/'+path.basename(t);fs.copyFileSync(t,path.join(root,...name.split('/')));return name;});
   const runs=await pool(names,4,f=>runTest(root,f));
   result[label]={ok:runs.every(r=>r.ok),passed:runs.reduce((n,r)=>n+r.passed,0),failed:runs.flatMap(r=>r.failed).slice(0,50)};
  }
  return {case_id:caseId,valid:result.reference.ok&&!result.before.ok,...result};
 }finally{cleanup(work);}
}
