import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {profileController} from '../tools/profile-controller.mjs';
import {hash,snapshot} from '../scripts/artifact.mjs';
import {fixture} from './support.mjs';

test('profiler measures fresh operations and counts without changing tree or task evidence',t=>{
 const f=fixture(t),taskDir=path.join(f.control,'tasks',f.brief.task_id),stateFile=path.join(f.control,'state.json');
 fs.writeFileSync(path.join(f.root,'.gitignore'),'ignored.txt\n');fs.writeFileSync(path.join(f.root,'ignored.txt'),'watched ignored input');
 const source=path.join(taskDir,'review-1.json');
 fs.writeFileSync(source,JSON.stringify({verdict:'redo',blocking_criteria:['AC1'],findings:[{file:'a.txt',line:1,severity:'major',issue:'AC1: defect'}]}));
 const before=snapshot(f.root),evidence=hash(fs.readFileSync(source)),state=fs.readFileSync(stateFile),files=fs.readdirSync(taskDir).sort();
 const report=profileController(f.root,{repetitions:2,stateFile,taskDir});
 assert.equal(report.authoritative,false);assert.equal(report.repetitions,2);
 assert.deepEqual(Object.keys(report.measurements),['snapshot','ignoredManifest','findingLedger']);
 for(const m of Object.values(report.measurements)){
  assert.equal(m.samples.length,2);assert.ok(m.samples.every(s=>Number.isFinite(s.elapsed_ms)&&s.elapsed_ms>=0));
  assert.ok(m.min_ms<=m.median_ms&&m.median_ms<=m.max_ms);
 }
 assert.equal(report.measurements.findingLedger.samples[0].counts.issues,1);
 assert.equal(report.measurements.ignoredManifest.samples[0].counts.watched,1);
 assert.deepEqual(snapshot(f.root),before);assert.equal(hash(fs.readFileSync(source)),evidence);
 assert.deepEqual(fs.readFileSync(stateFile),state);assert.deepEqual(fs.readdirSync(taskDir).sort(),files);
});

test('profiler rejects unbounded options and oversized task inputs before measurements',t=>{
 const f=fixture(t),stateFile=path.join(f.control,'state.json'),taskDir=path.join(f.temp,'oversized');fs.mkdirSync(taskDir);
 for(const repetitions of [0,11,1.5,NaN])assert.throws(()=>profileController(f.root,{repetitions}),/1-10/);
 assert.throws(()=>profileController(f.root,{stateFile}),/both/);
 fs.writeFileSync(path.join(taskDir,'large.json'),' '.repeat(4*1024*1024+1));
 assert.throws(()=>profileController(f.root,{stateFile,taskDir}),/at most 4 MiB/);
});

test('profiler CLI reports only local operation timings without initializing a task',t=>{
 const f=fixture(t,{initialize:false}),before=snapshot(f.root);
 const r=spawnSync(process.execPath,['tools/profile-controller.mjs',f.root,'--repetitions','1'],{encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);const out=JSON.parse(r.stdout);
 assert.deepEqual(Object.keys(out.measurements),['snapshot','ignoredManifest']);
 assert.ok(out.exclusions.includes('model time and usage'));assert.deepEqual(snapshot(f.root),before);
 assert.equal(fs.existsSync(path.join(f.control,'state.json')),false);
});
