import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './support.mjs';
import {prepareFixture} from '../scripts/benchmark-fixtures.mjs';
import {controlPath} from '../scripts/control-dir.mjs';
import {atomic} from '../scripts/artifact.mjs';
import {trialPrompt,trialPaths,runSuite} from '../tools/benchmark-trial.mjs';
import {findTrials,trialReport,formatReport} from '../tools/benchmark-report.mjs';

// 2026-11-28 L03: a cut-off trial was moved aside and the case prepared again at the same path. The control folder is
// keyed by the repository path, so the new trial inherited the old writer lock and `start` said "BENCHMARK: writer active".
test('prepare refuses a path whose control folder survives from an earlier trial',t=>{
 const f=fixture(t,{initialize:false}),parent=path.join(f.temp,'L03'),target=path.join(parent,'trial');
 const first=prepareFixture('HF-B01',target);
 fs.rmSync(parent,{recursive:true,force:true});
 assert.ok(fs.existsSync(path.dirname(first.brief_file)),'the control folder outlives the trial folder');
 assert.throws(()=>prepareFixture('HF-B01',target),/control folder from an earlier trial at this path still exists/);
 assert.equal(fs.existsSync(parent),false,'a refused prepare leaves no folder behind, so the error does not turn into "must not exist"');
 assert.doesNotThrow(()=>prepareFixture('HF-B01',path.join(f.temp,'trial-2')));
});

test('both trial prompts forbid the full suite and point at the fixture',()=>{
 const prepared={brief_file:'C:/state/x/benchmark-brief.json',acceptance_command:'node --test tests/a.test.mjs'};
 const hf=trialPrompt('hyperfusion','HF-L03',prepared,{task_id:'HF-L03'});
 const solo=trialPrompt('baseline','HF-L03',prepared,{task_id:'HF-L03'});
 for(const p of [hf,solo])assert.match(p,/Do not run the full test suite/);
 assert.match(hf,/HyperFusion skill/);assert.match(hf,/task ID HF-L03/);assert.ok(hf.includes(prepared.brief_file));
 assert.match(solo,/yourself, alone/);assert.ok(solo.includes('node --test tests/a.test.mjs'));
 assert.equal(path.basename(trialPaths('d','HF-L03','hyperfusion').repo),'L03-hf');
 assert.equal(path.basename(trialPaths('d','HF-L03','baseline').repo),'L03-base');
});

test('a suite run skips a case whose trial already recorded a metric',t=>{
 const f=fixture(t,{initialize:false}),dir=path.join(f.temp,'rep');
 const p=trialPaths(path.join(dir,'L01'),'HF-L01','hyperfusion');
 fs.mkdirSync(p.dir,{recursive:true});
 fs.writeFileSync(p.log,'[2026-11-28T00:00:00.000Z] HF-L01 hyperfusion: recorded success true lead_tokens 1 claude_total 1\n');
 // The skill path is checked only for a case that runs, so a skipped case needs none.
 const out=runSuite({dir,cases:['HF-L01'],skill:path.join(f.temp,'no-skill')});
 assert.deepEqual(out,[{case_id:'HF-L01',status:'skipped'}]);
 assert.throws(()=>runSuite({dir,cases:['HF-L02'],skill:path.join(f.temp,'no-skill')}),/benchmark\.mjs not found/);
});

test('the report splits the window into worker, review, acceptance and other time',t=>{
 const f=fixture(t,{initialize:false}),dir=path.join(f.temp,'rep','L01');
 const p=trialPaths(dir,'HF-B01','hyperfusion');fs.mkdirSync(dir,{recursive:true});
 const prepared=prepareFixture('HF-B01',p.repo);
 fs.writeFileSync(p.prefix+'.prepare.json',JSON.stringify(prepared));
 const at=m=>new Date(Date.UTC(2026,10,28,0,m)).toISOString();
 const task=controlPath(p.repo,'tasks','HF-B01');fs.mkdirSync(task,{recursive:true});
 // 0–60 min window: implement 0–20, review 20–30, acceptance 30–35 and 21–22 (inside the review, counted once), other 25 min.
 atomic(path.join(task,'envelope-1.json'),{executor:'grok',started_at:at(0),ended_at:at(20),wall_ms:20*60000});
 atomic(path.join(task,'stall-1.json'),{would_stop:{at:at(15)},max_gap_ms:11*60000});
 atomic(path.join(task,'envelope-consult-c1-m1.json'),{executor:'sol',started_at:at(20),ended_at:at(30),wall_ms:10*60000});
 atomic(path.join(task,'acceptance-1-finish.json'),{at:at(30),duration_ms:5*60000,results:[{status:'pass'}]});
 atomic(path.join(task,'acceptance-1-verify-1.json'),{at:at(21),duration_ms:60000,results:[{status:'pass'}]});
 atomic(path.join(task,'acceptance-1-finish-ignored.json'),{files:[]});
 atomic(path.join(task,'static-1-finish.json'),{at:at(36),results:[{status:'pass'}]});
 atomic(controlPath(p.repo,'metrics','HF-B01.json'),{arm:'hyperfusion',success:true,started_at:at(0),controller_ended_at:at(60),ended_at:at(61),
  lead_usage:{message_count:12},lead_weighted_usage:{input_equivalent:123456.7},quality:{hidden_passed:true,hidden_failed:[]},scope_violations:0});
 const files=findTrials([path.join(f.temp,'rep')]);
 assert.deepEqual(files,[p.prefix+'.prepare.json'],'the trial repository itself is not searched');
 const r=trialReport(files[0]);
 assert.equal(r.status,'recorded');
 assert.deepEqual([r.window_ms,r.implement_ms,r.review_ms,r.acceptance_ms,r.other_ms].map(ms=>ms/60000),[60,20,10,5,25]);
 assert.equal(r.acceptance_unknown,1,'the static record without duration_ms is reported, not guessed');
 assert.deepEqual([r.lead_input_equivalent,r.lead_messages,r.rounds,r.reviews,r.stalls,r.max_gap_ms],[123457,12,1,1,1,11*60000]);
 const table=formatReport([r,{status:'no_metric',case_id:'HF-L09',phase:'EXECUTING',file:'x.prepare.json'}],{rounds:true});
 assert.match(table,/\| HF-B01 \| hyperfusion \| 123K \| 12 \| 60\.0 \| 20\.0 \| 10\.0 \| 5\.0\* \| 25\.0 \| 1 \| 1 \| pass \| 1 \(11\.0\) \|/);
 assert.match(table,/HF-L09: no_metric \(phase EXECUTING\)/);
 assert.match(table,/WOULD STOP/);
});
