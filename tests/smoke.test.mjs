import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fixture} from './support.mjs';
import {smoke} from '../scripts/smoke.mjs';

const DOCTOR=fileURLToPath(new URL('../scripts/setup-doctor.mjs',import.meta.url));
const doctor=(f,...args)=>{const out=spawnSync(process.execPath,[DOCTOR,f.root,...args],{encoding:'utf8',env:process.env});return {code:out.status,report:JSON.parse(out.stdout)};};

test('contract smoke runs a tiny real round per worker in a throwaway repository',async t=>{
 const f=fixture(t);f.mode('smoke');
 const results=await smoke(['grok','haiku','antigravity','luna'],{timeoutMs:60000});
 assert.deepEqual(results.map(r=>[r.executor,r.ok]),[['grok',true],['haiku',true],['antigravity',true],['luna',true]],JSON.stringify(results));
});

test('a CLI whose output contract broke is named with the stage where it broke',async t=>{
 const f=fixture(t);f.mode('bad-json');
 const [r]=await smoke(['grok'],{timeoutMs:60000});
 assert.equal(r.ok,false);assert.equal(r.stage,'execute');assert.match(r.error,/invalid JSON/i);
});

test('a worker that reports success without doing the work fails the smoke',async t=>{
 const f=fixture(t);f.mode('ok');
 const [r]=await smoke(['sonnet'],{timeoutMs:60000});
 assert.equal(r.ok,false);assert.equal(r.stage,'output');
});

test('doctor --smoke runs only when asked and fails the check when a contract breaks',t=>{
 const f=fixture(t);f.mode('smoke');
 assert.equal(doctor(f).report.smoke,null,'no smoke without the flag');
 const good=doctor(f,'--smoke=grok,sonnet');
 assert.equal(good.code,0,JSON.stringify(good.report.checks));
 assert.deepEqual(good.report.smoke.map(r=>r.executor),['grok','sonnet']);
 f.mode('bad-json');
 const bad=doctor(f,'--smoke=grok');
 assert.equal(bad.code,1);assert.match(bad.report.checks.find(c=>c.name==='smoke').detail,/grok at execute/);
 assert.equal(doctor(f,'--smoke=sol').report.checks.find(c=>c.name==='smoke-targets').ok,false,'sol only reviews');
});
