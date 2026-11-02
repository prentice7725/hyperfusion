import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {prepareHistoryFixture,LARGE_CASES} from '../scripts/benchmark-fixtures.mjs';
import {startWindow} from '../scripts/benchmark-window.mjs';
import {SUITES,comparePilot} from '../scripts/benchmark.mjs';
import {read} from '../scripts/artifact.mjs';

const GIT_ENV={...process.env,GIT_AUTHOR_NAME:'t',GIT_COMMITTER_NAME:'t',GIT_AUTHOR_EMAIL:'t@example.invalid',GIT_COMMITTER_EMAIL:'t@example.invalid'};
const temp=t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hf-large-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};
const write=(root,file,text)=>{const out=path.join(root,file);fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,text);};

// 원본 저장소: 첫 커밋은 f()가 1을 돌려주고, 기능 커밋은 f()를 2로 바꾸며 시험도 2를 요구한다.
function sourceRepo(t) {
 const src=path.join(temp(t),'src');
 const git=(...args)=>execFileSync('git',['-c','core.autocrlf=false','-C',src,...args],{env:GIT_ENV,stdio:'pipe'}).toString().trim();
 fs.mkdirSync(src);git('init');
 write(src,'scripts/lib.mjs','export const f=()=>1;\n');
 write(src,'tests/lib.test.mjs',"import test from 'node:test';import assert from 'node:assert/strict';import {f} from '../scripts/lib.mjs';test('f',()=>assert.equal(f(),1));\n");
 write(src,'.claude/settings.json','{}\n');write(src,'README.md','demo\n');write(src,'.gitignore','node_modules/\n');
 git('add','.');git('commit','-m','base');
 write(src,'scripts/lib.mjs','export const f=()=>2;\n');
 write(src,'tests/lib.test.mjs',"import test from 'node:test';import assert from 'node:assert/strict';import {f} from '../scripts/lib.mjs';test('f',()=>assert.equal(f(),2));\n");
 git('add','.');git('commit','-m','feature');
 return {src,commit:git('rev-parse','HEAD')};
}
const largeCase=commit=>({case_id:'HF-L99',suite:'large',kind:'code',difficulty:'high',source_commit:commit,objective:'Make f return 2',
 criteria:['AC1: f returns 2'],acceptance:'lib tests pass',acceptance_command:'node --test tests/lib.test.mjs',acceptance_tests:['tests/lib.test.mjs'],editable:['scripts','README.md'],acceptance_timeout_ms:60000});

test('a large fixture is the pre-commit tree plus the commit tests, without history or excluded folders',t=>{
 const {src,commit}=sourceRepo(t),cases=[largeCase(commit)],out=temp(t);
 const a=prepareHistoryFixture('HF-L99',path.join(out,'a'),{source:src,cases});
 assert.equal(a.baseline_status,'red');
 assert.equal(fs.readFileSync(path.join(a.root,'scripts/lib.mjs'),'utf8'),'export const f=()=>1;\n');
 assert.match(fs.readFileSync(path.join(a.root,'tests/lib.test.mjs'),'utf8'),/f\(\),2/);
 assert.equal(fs.existsSync(path.join(a.root,'.claude')),false);
 assert.match(fs.readFileSync(path.join(a.root,'.gitignore'),'utf8'),/^node_modules\/\n\.build\/\nhyperfusion\.config\.json\n$/);
 // 정답 커밋이 이력에 남으면 git log로 볼 수 있으므로 커밋은 하나뿐이어야 한다.
 assert.equal(execFileSync('git',['-C',a.root,'rev-list','--count','HEAD']).toString().trim(),'1');
 assert.deepEqual(Object.keys(a.protected_files),['tests/lib.test.mjs']);
 assert.equal(a.acceptance_timeout_ms,60000);
 const brief=read(a.brief_file);
 assert.deepEqual(brief.scope.paths,['scripts','README.md']);
 assert.deepEqual(brief.success_criteria,['AC1: f returns 2']);
 assert.deepEqual(brief.acceptance_commands,['node --test tests/lib.test.mjs']);
 const b=prepareHistoryFixture('HF-L99',path.join(out,'b'),{source:src,cases});
 assert.equal(a.initial_tree,b.initial_tree);assert.equal(a.fixture_id,b.fixture_id);
 assert.throws(()=>prepareHistoryFixture('HF-L99',a.root,{source:src,cases}),/must not exist/);
 const window=startWindow('HF-L99',a.root,{sessionId:'s'});
 assert.equal(window.benchmark.acceptance_timeout_ms,60000);
});

test('a large fixture refuses a source without the commit and tests outside tests/',t=>{
 const {src,commit}=sourceRepo(t),out=temp(t);
 assert.throws(()=>prepareHistoryFixture('HF-L99',path.join(out,'x'),{source:src,cases:[largeCase('f'.repeat(40))]}),/does not contain/);
 assert.throws(()=>prepareHistoryFixture('HF-L99',path.join(out,'y'),{source:src,cases:[{...largeCase(commit),acceptance_tests:['scripts/lib.mjs']}]}),/under tests\//);
 assert.equal(fs.existsSync(path.join(out,'x')),false);
});

test('suites compare separately and the shipped large cases are well formed',()=>{
 assert.equal(SUITES.core.length,10);
 assert.equal(SUITES.large,LARGE_CASES);
 for(const c of LARGE_CASES){
  assert.match(c.case_id,/^HF-L\d\d$/);assert.match(c.source_commit,/^[0-9a-f]{40}$/);
  assert.ok(c.criteria.length>=3&&c.criteria.every((s,i)=>s.startsWith(`AC${i+1}: `)),c.case_id);
  assert.ok(c.acceptance_tests.includes(c.acceptance_command.split(' ').at(-1)),c.case_id);
  assert.ok(!c.editable.some(p=>p==='tests'||p.startsWith('tests/')),c.case_id);
 }
 const out=comparePilot([],[],null,{suite:'large'});
 assert.equal(out.suite,'large');assert.equal(out.expected_pairs,LARGE_CASES.length);assert.equal(out.status,'incomplete');
 assert.throws(()=>comparePilot([{case_id:'HF-B01',success:true}],[],null,{suite:'large'}),/Unknown or duplicate/);
 assert.throws(()=>comparePilot([],[],null,{suite:'huge'}),/Unknown benchmark suite/);
});
