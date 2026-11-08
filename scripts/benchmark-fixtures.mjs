import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
import {hash,atomic,git} from './artifact.mjs';
import {ensureControl,controlPath} from './control-dir.mjs';

const source=fileURLToPath(new URL('../references/benchmark-fixtures/',import.meta.url));
export const LARGE_CASES=JSON.parse(fs.readFileSync(new URL('../references/benchmark-large-cases.json',import.meta.url),'utf8'));
const GIT_ENV={GIT_AUTHOR_DATE:'2026-01-01T00:00:00Z',GIT_COMMITTER_DATE:'2026-01-01T00:00:00Z',
 GIT_AUTHOR_NAME:'HyperFusion benchmark',GIT_COMMITTER_NAME:'HyperFusion benchmark',GIT_AUTHOR_EMAIL:'benchmark@example.invalid',GIT_COMMITTER_EMAIL:'benchmark@example.invalid'};
const commitFixture=(root,caseId)=>{
 const command=(...args)=>execFileSync('git',['-c','core.hooksPath=', '-c','core.autocrlf=false','-C',root,...args],{env:{...process.env,...GIT_ENV},stdio:'pipe'});
 command('init');command('add','.');command('commit','-m','Canonical '+caseId+' baseline');
 return git(root,['rev-parse','HEAD^{tree}']).trim();
};
export function prepareFixture(caseId,target,options={}) {
 if(/^HF-L\d\d$/.test(caseId))return prepareHistoryFixture(caseId,target,options);
 if(!/^HF-B(?:0[1-9]|10)$/.test(caseId))throw Error('BENCHMARK: unknown fixture');
 const folder=path.join(source,caseId),root=path.resolve(target);
 if(fs.existsSync(root))throw Error('BENCHMARK: target must not exist; never overwrite a trial');
 fs.mkdirSync(root,{recursive:true});fs.cpSync(folder,root,{recursive:true});
 const run=path.join(source,'run.mjs');fs.copyFileSync(run,path.join(root,'run.mjs'));
 for(const name of fs.readdirSync(root))fs.writeFileSync(path.join(root,name),fs.readFileSync(path.join(root,name),'utf8').replace(/\r\n/g,'\n'));
 const files=fs.readdirSync(root).sort().map(name=>[name,hash(fs.readFileSync(path.join(root,name)))]);
 const editable=caseId==='HF-B10'?['QUICKSTART.md']:fs.existsSync(path.join(root,'Task.java'))?['Task.java']:['task.mjs'];
 const protected_files=Object.fromEntries(files.filter(([name])=>!editable.includes(name)));
 const manifest={case_id:caseId,fixture_id:hash(JSON.stringify(files)),acceptance_command:'node run.mjs',protected_files,editable};
 fs.writeFileSync(path.join(root,'benchmark-fixture.json'),JSON.stringify(manifest,null,2)+'\n');
 fs.writeFileSync(path.join(root,'.gitignore'),'.build/\nhyperfusion.config.json\n');
 const initial_tree=commitFixture(root,caseId);
 const cases=JSON.parse(fs.readFileSync(new URL('../references/benchmark-cases.json',import.meta.url),'utf8'));
 const task=cases.find(c=>c.case_id===caseId);
 const brief={task_id:caseId,objective:task.objective,scope:{paths:editable},constraints:['Keep canonical acceptance fixtures unchanged'],
  success_criteria:['AC1: '+task.acceptance],allowed_actions:['read','edit','test'],task_kind:task.kind,difficulty:task.difficulty,
  acceptance_commands:['node run.mjs'],acceptance_timeout_ms:120000,acceptance_artifacts:['.build/**']};
 ensureControl(root);atomic(controlPath(root,'benchmark-fixture.json'),{...manifest,initial_tree});
 const brief_file=controlPath(root,'benchmark-brief.json');atomic(brief_file,brief);
 const result=spawnSync(process.execPath,['run.mjs'],{cwd:root,encoding:'utf8',timeout:60000});
 const baseline_status=result.status===1?'red':result.status===0?'unexpected-green':'environment-unverified';
 return {root,...manifest,initial_tree,brief_file,baseline_status,baseline_exit:result.status,baseline_signal:result.signal,
  note:'Exit 1 is an assertion failure; exit 2 means toolchain or execution unavailable. Keep the fixture tests unchanged in both arms.'};
}

// 큰 과제는 실제 기능 커밋의 바로 앞 트리에 그 커밋의 시험만 얹어 만든다. 저장소 이력은 넣지 않는다
// (git log로 정답 커밋을 볼 수 없게). 원본은 그 커밋이 들어 있는 HyperFusion 저장소다.
const PROTECTED_PREFIX='tests/';
const EXCLUDED=['.claude/','.github/'];
const under=(file,prefixes)=>prefixes.some(p=>file===p||file.startsWith(p.endsWith('/')?p:p+'/'));
function sourceRepo(commit,given) {
 const candidates=[given,process.env.HF_BENCHMARK_SOURCE,fileURLToPath(new URL('..',import.meta.url))].filter(Boolean);
 for(const repo of candidates){
  const r=spawnSync('git',['-C',repo,'cat-file','-e',commit+'^{commit}'],{stdio:'ignore'});
  if(r.status===0)return repo;
  if(repo===given)throw Error('BENCHMARK: source repository does not contain '+commit);
 }
 throw Error('BENCHMARK: no source repository contains '+commit+'; pass --source with a full HyperFusion clone (CI checkouts are shallow)');
}
// git ls-tree + cat-file --batch로 한 트리의 일반 파일을 바이트 그대로 읽는다. 심볼릭 링크·서브모듈은 건너뛴다.
export function treeFiles(repo,rev,only=null) {
 const listing=execFileSync('git',['-C',repo,'ls-tree','-r','-z','--full-tree',rev,...(only?['--',...only]:[])],{maxBuffer:64*1024*1024});
 const entries=listing.toString('utf8').split('\0').filter(Boolean).map(line=>{const [meta,file]=line.split('\t');const [mode,type,object]=meta.split(' ');return {mode,type,object,file};})
  .filter(e=>e.type==='blob'&&(e.mode==='100644'||e.mode==='100755'));
 const out=execFileSync('git',['-C',repo,'cat-file','--batch'],{input:entries.map(e=>e.object).join('\n')+'\n',maxBuffer:256*1024*1024});
 const files=new Map();let at=0;
 for(const e of entries){
  const nl=out.indexOf(10,at),[,, size]=out.subarray(at,nl).toString('utf8').split(' ');
  files.set(e.file,out.subarray(nl+1,nl+1+Number(size)));at=nl+1+Number(size)+1;
 }
 return files;
}
export function prepareHistoryFixture(caseId,target,{source:given,cases=LARGE_CASES}={}) {
 const task=cases.find(c=>c.case_id===caseId);
 if(!task)throw Error('BENCHMARK: unknown fixture');
 if(!/^[0-9a-f]{40}$/.test(task.source_commit??''))throw Error('BENCHMARK: large case needs a full source_commit');
 if(!task.acceptance_tests?.length||!task.acceptance_tests.every(f=>f.startsWith(PROTECTED_PREFIX)))throw Error('BENCHMARK: acceptance tests must live under '+PROTECTED_PREFIX);
 const root=path.resolve(target);
 if(fs.existsSync(root))throw Error('BENCHMARK: target must not exist; never overwrite a trial');
 const repo=sourceRepo(task.source_commit,given);
 const files=treeFiles(repo,task.source_commit+'^');
 for(const [file,body] of treeFiles(repo,task.source_commit,task.acceptance_tests))files.set(file,body);
 for(const file of [...files.keys()])if(under(file,EXCLUDED))files.delete(file);
 if(!task.acceptance_tests.every(f=>files.has(f)))throw Error('BENCHMARK: acceptance test missing from source commit');
 for(const [file,body] of files){const out=path.join(root,...file.split('/'));fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,body);}
 const digests=[...files].map(([file,body])=>[file,hash(body)]).sort((a,b)=>a[0]<b[0]?-1:1);
 const protected_files=Object.fromEntries(digests.filter(([file])=>file.startsWith(PROTECTED_PREFIX)));
 const timeout=task.acceptance_timeout_ms??300000;
 const manifest={case_id:caseId,suite:'large',source_commit:task.source_commit,fixture_id:hash(JSON.stringify(digests)),acceptance_command:task.acceptance_command,
  acceptance_timeout_ms:timeout,protected_files,editable:task.editable};
 fs.writeFileSync(path.join(root,'benchmark-fixture.json'),JSON.stringify(manifest,null,2)+'\n');
 const ignore=path.join(root,'.gitignore');
 fs.writeFileSync(ignore,(fs.existsSync(ignore)?fs.readFileSync(ignore,'utf8').replace(/\n?$/,'\n'):'')+'.build/\nhyperfusion.config.json\n');
 const initial_tree=commitFixture(root,caseId);
 const brief={task_id:caseId,objective:task.objective,scope:{paths:task.editable},constraints:['Keep canonical acceptance fixtures unchanged','Do not modify anything under tests/'],
  success_criteria:task.criteria,allowed_actions:['read','edit','test'],task_kind:task.kind,difficulty:task.difficulty,
  acceptance_commands:[task.acceptance_command],acceptance_timeout_ms:timeout,acceptance_artifacts:['.build/**']};
 ensureControl(root);atomic(controlPath(root,'benchmark-fixture.json'),{...manifest,initial_tree});
 const brief_file=controlPath(root,'benchmark-brief.json');atomic(brief_file,brief);
 const [bin,...args]=task.acceptance_command.split(' ');
 // node --test 안에서 부르면 NODE_TEST_CONTEXT 때문에 자식 시험이 부모에게 보고만 하고 0으로 끝난다.
 const {NODE_TEST_CONTEXT,...env}=process.env;
 const result=spawnSync(bin==='node'?process.execPath:bin,args,{cwd:root,encoding:'utf8',timeout,windowsHide:true,env});
 const baseline_status=result.status===1?'red':result.status===0?'unexpected-green':'environment-unverified';
 return {root,...manifest,initial_tree,brief_file,baseline_status,baseline_exit:result.status,baseline_signal:result.signal,
  note:'Large fixtures are a pre-commit tree plus the commit\'s tests, without history. Keep tests/ unchanged in both arms.'};
}
