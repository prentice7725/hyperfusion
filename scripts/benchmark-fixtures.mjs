import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
import {hash,atomic,git} from './artifact.mjs';
import {ensureControl,controlPath} from './control-dir.mjs';

const source=fileURLToPath(new URL('../references/benchmark-fixtures/',import.meta.url));
export function prepareFixture(caseId,target) {
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
 const env={...process.env,GIT_AUTHOR_DATE:'2026-01-01T00:00:00Z',GIT_COMMITTER_DATE:'2026-01-01T00:00:00Z',
  GIT_AUTHOR_NAME:'HyperFusion benchmark',GIT_COMMITTER_NAME:'HyperFusion benchmark',GIT_AUTHOR_EMAIL:'benchmark@example.invalid',GIT_COMMITTER_EMAIL:'benchmark@example.invalid'};
 const command=(...args)=>execFileSync('git',['-c','core.hooksPath=', '-c','core.autocrlf=false','-C',root,...args],{env,stdio:'pipe'});
 command('init');command('add','.');command('commit','-m','Canonical '+caseId+' baseline');
 const initial_tree=git(root,['rev-parse','HEAD^{tree}']).trim();
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
