import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fixture} from './support.mjs';
import {trial,summarize} from '../tools/worker-trial.mjs';

// 과제 원본: 부모 커밋은 a.txt가 base, 과제 커밋이 a.txt를 fixed로 바꾸고 그 시험을 더한다.
function source(f) {
 const repo=path.join(f.temp,'source'),hidden=path.join(f.temp,'hidden');
 const git=(...a)=>execFileSync('git',['-c','core.autocrlf=false','-c','user.name=t','-c','user.email=t@example.invalid','-C',repo,...a],{stdio:'pipe'}).toString().trim();
 fs.mkdirSync(path.join(repo,'tests'),{recursive:true});
 fs.writeFileSync(path.join(repo,'a.txt'),'base');fs.writeFileSync(path.join(repo,'tests','keep.txt'),'keep\n');
 git('init','-q');git('add','.');git('commit','-q','-m','base');
 const head="import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';\n";
 fs.writeFileSync(path.join(repo,'a.txt'),'fixed');
 fs.writeFileSync(path.join(repo,'tests','a.test.mjs'),head+"test('fixed',()=>assert.equal(fs.readFileSync('a.txt','utf8'),'fixed'));\n");
 git('add','.');git('commit','-q','-m','feature');
 fs.mkdirSync(path.join(hidden,'HF-T01'),{recursive:true});
 fs.writeFileSync(path.join(hidden,'HF-T01','a.test.mjs'),head+"test('starts with fix',()=>assert.match(fs.readFileSync('a.txt','utf8'),/^fix/));\ntest('no newline',()=>assert.doesNotMatch(fs.readFileSync('a.txt','utf8'),/\\n/));\n");
 const cases=[{case_id:'HF-T01',suite:'large',kind:'code',difficulty:'low',source_commit:git('rev-parse','HEAD'),objective:'Make a.txt say fixed',criteria:['AC1: a.txt is exactly fixed'],
  acceptance:'The protected test passes',acceptance_command:'node --test tests/a.test.mjs',acceptance_tests:['tests/a.test.mjs'],editable:['a.txt'],acceptance_timeout_ms:60000}];
 return {repo,hidden,cases};
}

test('a single worker round is run, settled and scored with hidden tests',async t=>{
 const f=fixture(t,{initialize:false});f.mode('edit');
 const s=source(f);
 const r=await trial({caseId:'HF-T01',target:path.join(f.temp,'trial-1'),worker:'grok',label:'grok-a',source:s.repo,hidden:s.hidden,cases:s.cases,timeoutMs:60000});
 assert.equal(r.error,null,JSON.stringify(r));
 assert.equal(r.stage,'done');assert.equal(r.phase,'REVIEW');assert.equal(r.acceptance_passed,true);assert.equal(r.worker_status,'complete');
 assert.deepEqual([r.score.hidden_passed,r.score.hidden_failed,r.score.all_hidden_passed,r.score.scope_violations],[2,0,true,0]);
 assert.equal(typeof r.usage.wall_ms,'number');
 assert.equal(fs.readFileSync(path.join(r.repo,'a.txt'),'utf8'),'fixed');
});

test('a worker that does not do the work is recorded and scored, not dropped',async t=>{
 const f=fixture(t,{initialize:false});f.mode('ok');
 const s=source(f);
 const r=await trial({caseId:'HF-T01',target:path.join(f.temp,'trial-2'),worker:'grok',source:s.repo,hidden:s.hidden,cases:s.cases,timeoutMs:60000});
 assert.equal(r.acceptance_passed,false,JSON.stringify(r));
 assert.equal(r.score.all_hidden_passed,false);assert.equal(r.score.hidden_failed,1);
 const [row]=summarize([r,{...r,score:null,error:'boom'}]);
 assert.deepEqual([row.label,row.trials,row.errored,row.unscored,row.acceptance_passed,row.all_hidden_passed],['grok',2,1,1,0,0]);
 assert.deepEqual(row.by_case['HF-T01'],['1/2','unscored']);
});

test('a review-only worker and an existing target are refused before anything runs',async t=>{
 const f=fixture(t,{initialize:false});
 const s=source(f);
 await assert.rejects(trial({caseId:'HF-T01',target:path.join(f.temp,'x'),worker:'sol',source:s.repo,hidden:s.hidden,cases:s.cases}),/not an implementing worker/);
 const r=await trial({caseId:'HF-T01',target:f.temp,worker:'grok',source:s.repo,hidden:s.hidden,cases:s.cases});
 assert.equal(r.stage,'prepare');assert.match(r.error,/must not exist/);assert.equal(r.score,null);
});
