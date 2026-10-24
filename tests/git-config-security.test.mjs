import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fixture} from './support.mjs';
import {git,snapshot,riskyGitConfig} from '../scripts/artifact.mjs';
import {run} from '../scripts/fusion-state.mjs';

// These helpers use real Git and an innocuous clean filter outside the repository.
// If controller Git accidentally runs it, it leaves a marker and copies stdin.
function cleanFilter(f,name='review') {
 const marker=path.join(f.temp,'filter-ran');
 const script=path.join(f.temp,'clean-filter.cjs');
 fs.writeFileSync(script,`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},'ran');process.stdout.write(fs.readFileSync(0));`);
 fs.writeFileSync(path.join(f.root,'.gitattributes'),`a.txt filter=${name}\n`);
 f.git('add','.gitattributes');f.git('commit','-qm','filter fixture');
 return {marker,command:`"${process.execPath.replaceAll('\\','/')}" "${script.replaceAll('\\','/')}"`};
}
function linked(f) {
 const root=path.join(f.temp,'linked');
 f.git('config','extensions.worktreeConfig','true');
 f.git('worktree','add','-q','-b','linked',root);
 const config=(...args)=>execFileSync('git',['-C',root,'config','--worktree',...args],{stdio:'pipe'});
 return {root,config};
}

test('controller Git neutralizes clean filters in included and nested config files',t=>{
 const f=fixture(t,{initialize:false});const {marker,command}=cleanFilter(f);
 const outer=path.join(f.temp,'outer.cfg'),inner=path.join(f.temp,'inner.cfg');
 fs.writeFileSync(outer,'');fs.writeFileSync(inner,'');
 f.git('config','--file',outer,'include.path',inner);
 f.git('config','--file',inner,'filter.review.clean',command);
 f.git('config','--file',inner,'filter.review.required','true');
 f.git('config','include.path',outer);
 fs.writeFileSync(path.join(f.root,'a.txt'),'edit');
 git(f.root,['diff','--no-ext-diff','--no-textconv']);
 assert.equal(fs.existsSync(marker),false,'an included clean command must never run');
 assert.ok(riskyGitConfig(f.root).some(k=>k.startsWith('filter.review.clean=')));
});

test('changing an included config after a controller call cannot reuse stale neutralization',t=>{
 const f=fixture(t,{initialize:false});const {marker,command}=cleanFilter(f);
 const include=path.join(f.temp,'include.cfg');fs.writeFileSync(include,'');
 f.git('config','include.path',include);
 git(f.root,['status','--porcelain']);
 const configFile=path.join(f.root,'.git','config'),unchanged=fs.readFileSync(configFile);
 f.git('config','--file',include,'filter.review.clean',command);
 f.git('config','--file',include,'filter.review.required','true');
 fs.writeFileSync(path.join(f.root,'a.txt'),'edit');
 git(f.root,['diff','--no-ext-diff','--no-textconv']);
 assert.deepEqual(fs.readFileSync(configFile),unchanged,'the parent config did not change');
 assert.equal(fs.existsSync(marker),false,'changing the include must invalidate any old result');
});

test('worktree-local config changes are watched independently of the shared config',t=>{
 const f=fixture(t,{initialize:false});const wt=linked(f);
 const shared=path.join(f.root,'.git','config'),contents=fs.readFileSync(shared);
 const before=snapshot(wt.root);
 wt.config('core.fsmonitor','review-marker');
 const after=snapshot(wt.root);
 assert.deepEqual(fs.readFileSync(shared),contents);
 assert.notEqual(after.digest,before.digest,'worktree config must change the snapshot digest');
 assert.ok(after.files['.git/config.worktree'],'the active worktree config uses the existing guard key');
 assert.ok(riskyGitConfig(wt.root).some(k=>k.startsWith('core.fsmonitor=')));
});

test('controller Git neutralizes a filter added only to a linked worktree',t=>{
 const f=fixture(t,{initialize:false});const {marker,command}=cleanFilter(f);const wt=linked(f);
 git(wt.root,['status','--porcelain']);
 wt.config('filter.review.clean',command);wt.config('filter.review.required','true');
 fs.writeFileSync(path.join(wt.root,'a.txt'),'edit');
 git(wt.root,['diff','--no-ext-diff','--no-textconv']);
 assert.equal(fs.existsSync(marker),false);
 assert.ok(riskyGitConfig(wt.root).some(k=>k.startsWith('filter.review.clean=')));
});

test('finish catches worktree-local settings and recovery refuses command-running exceptions',t=>{
 const f=fixture(t,{initialize:false});const wt=linked(f);
 run(wt.root,'init',{...f.brief,executor:'grok'});
 const request=run(wt.root,'begin',f.brief);
 wt.config('filter.foo.bar.clean','review-command');
 const result={task_id:f.brief.task_id,round:1,status:'complete',summary:'fixture',files_read:[],files_changed:[],commands_run:[],tests:[],unresolved:[],risks:[],needs_lead_decision:false,recommended_next_action:'review'};
 const finished=run(wt.root,'finish',{token:request.token,quiescent:true,result});
 assert.equal(finished.phase,'RECOVERY_REQUIRED');
 assert.ok(finished.last_errors.some(e=>/Out of scope: \.git\/config\.worktree/.test(e)),JSON.stringify(finished.last_errors));
 assert.throws(()=>run(wt.root,'recover',{token:request.token,quiescent:true,reason:'fixture',allow_out_of_scope:[{path:'.git/config.worktree',reason:'must be refused'}]}),/entries that can run commands/);
});

test('global filters are neutralized without blocking a harmless local config exception',t=>{
 const f=fixture(t,{initialize:false});const {marker,command}=cleanFilter(f);
 const global=path.join(f.temp,'global.cfg');fs.writeFileSync(global,'');
 f.git('config','--file',global,'filter.review.clean',command);
 f.git('config','branch.main.remote','origin');
 fs.writeFileSync(path.join(f.root,'a.txt'),'edit');
 const script=`import {git,riskyGitConfig} from ${JSON.stringify(new URL('../scripts/artifact.mjs',import.meta.url).href)};git(process.cwd(),['diff','--no-ext-diff','--no-textconv']);console.log(JSON.stringify(riskyGitConfig(process.cwd())));`;
 const out=execFileSync(process.execPath,['--input-type=module','-e',script],{cwd:f.root,env:{...process.env,GIT_CONFIG_GLOBAL:global},encoding:'utf8'});
 assert.deepEqual(JSON.parse(out),[],'global defaults are not repository scope violations');
 assert.equal(fs.existsSync(marker),false,'global clean filters still cannot run in the controller');
});

test('dotted driver names are risky and cannot be accepted as a Git config scope exception',t=>{
 const f=fixture(t);f.begin();
 for(const key of ['filter.foo.bar.clean','filter.foo.bar.smudge','filter.foo.bar.process','diff.foo.bar.command','diff.foo.bar.textconv','merge.foo.bar.driver']){
  f.git('config',key,'review-command');
  assert.ok(riskyGitConfig(f.root).some(k=>k.startsWith(key+'=')),key);
 }
 assert.equal(f.finish(f.result()).phase,'RECOVERY_REQUIRED');
 assert.throws(()=>run(f.root,'recover',{token:f.state().writer.token,quiescent:true,reason:'review fixture',allow_out_of_scope:[{path:'.git/config',reason:'must be refused'}]}),/entries that can run commands/);
});

test('conditional include names with dotted paths are identified as risky',t=>{
 const f=fixture(t,{initialize:false});
 const include=path.join(f.temp,'unused.cfg');fs.writeFileSync(include,'');
 f.git('config','includeIf.gitdir:/review.path/.path',include);
 assert.ok(riskyGitConfig(f.root).some(k=>/^includeif\./i.test(k)),JSON.stringify(riskyGitConfig(f.root)));
});

test('malformed included configuration fails closed instead of dropping neutralization',t=>{
 const f=fixture(t,{initialize:false});const include=path.join(f.temp,'bad.cfg');
 fs.writeFileSync(include,'');f.git('config','include.path',include);
 git(f.root,['status','--porcelain']);fs.writeFileSync(include,'[broken\n');
 assert.throws(()=>git(f.root,['status','--porcelain']),/GIT_CONFIG_UNREADABLE/);
 assert.ok(riskyGitConfig(f.root).some(k=>/unreadable/i.test(k)));
});

// snapshot은 설정을 한 번 읽어 그 안의 git 호출에 같이 쓴다(횟수는 snapshot-spawns.test.mjs). 다음 snapshot은 바뀐 설정을 다시 읽는다.
test('a filter added after one snapshot is neutralized by the next',t=>{
 const f=fixture(t,{initialize:false});const {marker,command}=cleanFilter(f);
 snapshot(f.root);
 f.git('config','filter.review.clean',command);f.git('config','filter.review.required','true');
 // 크기가 같고 시각만 다르면 git status가 내용을 걸러 비교하므로 clean 필터가 불린다.
 const file=path.join(f.root,'a.txt'),size=fs.statSync(file).size;
 fs.writeFileSync(file,'x'.repeat(size));fs.utimesSync(file,new Date(Date.now()+60000),new Date(Date.now()+60000));
 snapshot(f.root);
 assert.equal(fs.existsSync(marker),false,'the second snapshot must read the new filter');
});
