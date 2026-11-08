import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {affectedTests,scopeViolations,scoreTrial,recordScore,hiddenTests} from '../scripts/benchmark-quality.mjs';
import {controlPath} from '../scripts/control-dir.mjs';

const files=o=>new Map(Object.entries(o).map(([k,v])=>[k,Buffer.from(v)]));

test('affected tests follow static imports transitively and ignore unrelated tests',()=>{
 const tree=files({
  'scripts/a.mjs':"import {b} from './b.mjs';export const a=b;",
  'scripts/b.mjs':'export const b=1;',
  'scripts/c.mjs':'export const c=1;',
  'tests/a.test.mjs':"import {a} from '../scripts/a.mjs';",
  'tests/c.test.mjs':"import {c} from '../scripts/c.mjs';",
  'tests/dyn.test.mjs':"const m=await import('../scripts/b.mjs');",
  'tests/support.mjs':"import '../scripts/b.mjs';",
 });
 assert.deepEqual(affectedTests(tree,['scripts/b.mjs']),['tests/a.test.mjs','tests/dyn.test.mjs']);
 assert.deepEqual(affectedTests(tree,['README.md']),[]);
});

test('scope violations are changes outside the editable paths, with protected files named',()=>{
 const r=scopeViolations(['scripts/x.mjs','scripts-old/y.mjs','tests/a.test.mjs','README.md'],{editable:['scripts','README.md'],protectedFiles:['tests/a.test.mjs']});
 assert.deepEqual(r.files,['scripts-old/y.mjs','tests/a.test.mjs']);
 assert.equal(r.count,2);assert.deepEqual(r.protected_changed,['tests/a.test.mjs']);
});

test('a trial is scored on a copy with hidden tests; the trial tree is unchanged',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hf-quality-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const repo=path.join(dir,'repo'),hidden=path.join(dir,'hidden');
 const git=(...a)=>execFileSync('git',['-c','core.autocrlf=false','-c','user.name=t','-c','user.email=t@example.invalid','-C',repo,...a],{stdio:'pipe'});
 fs.mkdirSync(path.join(repo,'scripts'),{recursive:true});fs.mkdirSync(path.join(repo,'tests'));
 fs.writeFileSync(path.join(repo,'scripts','add.mjs'),'export const add=(a,b)=>a-b;\n');
 const head="import test from 'node:test';import assert from 'node:assert/strict';import {add} from '../scripts/add.mjs';\n";
 fs.writeFileSync(path.join(repo,'tests','sub.test.mjs'),head+"test('subtracts',()=>assert.equal(add(5,3),2));\n");
 fs.writeFileSync(path.join(repo,'tests','old.test.mjs'),head+"test('was already broken',()=>assert.equal(add(1,1),3));\ntest('still subtracts',()=>assert.equal(add(4,1),3));\n");
 fs.writeFileSync(path.join(repo,'tests','other.test.mjs'),"import test from 'node:test';test('unrelated',()=>{});\n");
 git('init','-q');git('add','.');git('commit','-q','-m','base');
 fs.writeFileSync(path.join(repo,'scripts','add.mjs'),'export const add=(a,b)=>a+b;\n');
 fs.writeFileSync(path.join(repo,'notes.txt'),'stray\n');
 fs.mkdirSync(path.join(hidden,'HF-T01'),{recursive:true});
 fs.writeFileSync(path.join(hidden,'HF-T01','add.test.mjs'),"import test from 'node:test';import assert from 'node:assert/strict';import {add} from '../../scripts/add.mjs';\n"
  +"test('adds',()=>assert.equal(add(2,3),5));\ntest('negative',()=>assert.equal(add(-2,-3),-6));\n");
 const cases=[{case_id:'HF-T01',acceptance_tests:[],editable:['scripts']}];
 assert.deepEqual(hiddenTests('HF-T01',hidden).map(f=>path.basename(f)),['add.test.mjs']);
 const before=git('status','--porcelain').toString();
 const score=await scoreTrial('HF-T01',repo,{hidden,cases,regressions:false});
 assert.equal(score.hidden.passed,1);assert.deepEqual(score.hidden.failed,['negative']);assert.equal(score.hidden_passed,false);
 assert.deepEqual(score.scope.files,['notes.txt']);assert.equal(score.escaped_regressions,null);
 assert.equal(git('status','--porcelain').toString(),before,'scoring never writes into the trial tree');
 const full=await scoreTrial('HF-T01',repo,{hidden,cases,regressions:true});
 assert.equal(full.regression.checked,2,'only tests that reach a changed file');
 assert.deepEqual(full.regression.escaped,[{file:'tests/old.test.mjs',failed:['still subtracts']},{file:'tests/sub.test.mjs',failed:['subtracts']}],
  'a test newly broken inside an already failing file still counts; the old failure does not');
 assert.deepEqual(full.regression.already_failing,['tests/old.test.mjs']);
 assert.equal(full.escaped_regressions,2);
 assert.equal(git('status','--porcelain').toString(),before);
 await assert.rejects(scoreTrial('HF-T02',repo,{hidden,cases}),/unknown case/);
 await assert.rejects(scoreTrial('HF-T01',repo,{hidden:path.join(dir,'none'),cases}),/no hidden tests/);
});

test('recording marks a CLOSE with failing hidden tests as a wrong close, and a clean one as zero',t=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'hf-quality-rec-'));
 const prev=process.env.HF_STATE_DIR;process.env.HF_STATE_DIR=path.join(temp,'state');
 t.after(()=>{if(prev===undefined)delete process.env.HF_STATE_DIR;else process.env.HF_STATE_DIR=prev;fs.rmSync(temp,{recursive:true,force:true});});
 const repo=path.join(temp,'repo');fs.mkdirSync(repo);
 const score=(ok,escaped)=>({case_id:'HF-T01',hidden_passed:ok,hidden:{failed:ok?[]:['negative'],crashed:[]},escaped_regressions:escaped,regression:escaped===null?null:{escaped:[]},scope_violations:1,scope:{files:['notes.txt']}});
 assert.throws(()=>recordScore(repo,score(false,0)),/no metric record/);
 const file=controlPath(repo,'metrics','HF-T01.json');fs.mkdirSync(path.dirname(file),{recursive:true});
 fs.writeFileSync(file,JSON.stringify({case_id:'HF-T01',success:true}));
 const wrong=recordScore(repo,score(false,0));
 assert.equal(wrong.wrong_closes,1);assert.equal(wrong.escaped_regressions,0);assert.equal(wrong.scope_violations,1);assert.deepEqual(wrong.quality.hidden_failed,['negative']);
 const clean=recordScore(repo,score(true,null));
 assert.equal(clean.wrong_closes,0);assert.equal(clean.escaped_regressions,0,'an unscored regression check keeps the earlier count');
 fs.writeFileSync(file,JSON.stringify({case_id:'HF-T01',success:false}));
 assert.equal(recordScore(repo,score(false,0)).wrong_closes,0,'a failed task is not a wrong close');
});
