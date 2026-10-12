import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {execute} from '../scripts/executor-bridge.mjs';
import {autopilot} from '../scripts/autopilot.mjs';
import {read} from '../scripts/artifact.mjs';

const GRANT={policy:'standard-auto',reason:'single-file fix with a command that proves AC1'};
// red-first: 표식 파일이 생기기 전에는 실패하는 수용 명령. 대역 일꾼은 파일을 고치지 않으므로 표식으로 "고쳐짐"을 흉내 낸다.
const setup=(t,{delegation=GRANT,review={}}={})=>{
 const f=fixture(t,{initialize:false});
 fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({review:{by:'delegate',strategy:'lead-gated-adaptive',...review}}));
 const mark=path.join(f.temp,'green');
 const cmd=`node -e "process.exit(require('fs').existsSync(process.argv[1])?0:1)" "${mark}"`;
 const input={...f.brief,executor:'grok',acceptance_commands:[cmd],acceptance_map:{AC1:[cmd]}};
 if(delegation)input.delegation=delegation;
 run(f.root,'init',input);fs.writeFileSync(mark,'1');
 return f;
};
const task=(f,...p)=>path.join(f.control,'tasks',f.brief.task_id,...p);

test('with discretion, a worker run that failed before changing anything is recovered and retried',async t=>{
 const f=setup(t);f.mode('fail-once');
 const out=await autopilot(f.root);
 assert.equal(out.reason,'CLOSE',JSON.stringify(out));
 const s=f.state();
 assert.equal(s.auto_recoveries,1);
 assert.equal(s.last_auto_recovery.round,1);
 assert.match(s.last_auto_recovery.reason,/exited with code 2/);
 assert.equal(s.iteration,2);assert.equal(s.attempts.grok,2,'the failed attempt stays spent');
 assert.equal(s.lead_decision.authority.source,'delegated-policy');
 const recovery=fs.readdirSync(task(f)).filter(n=>/^recovery-\d+\.json$/.test(n)).map(n=>read(task(f,n)));
 assert.match(recovery[0].reason,/^auto-recover \(delegated, 1\/2\): /);
 // 다시 시도한 라운드는 처음 brief에 "결과 없이 끝났다"는 안내를 받는다.
 assert.match(JSON.stringify(read(task(f,'brief-2.json')).lead_feedback),/ended before it produced a result/);
});

test('without discretion the same failure stops autopilot with the writer lease kept',async t=>{
 const f=setup(t,{delegation:null});f.mode('fail-once');
 const out=await autopilot(f.root);
 assert.notEqual(out.reason,'CLOSE');
 assert.equal(f.state().phase,'EXECUTING');assert.ok(f.state().writer);
 assert.equal(f.state().auto_recoveries,undefined);
 assert.throws(()=>run(f.root,'auto-recover',{error:'x'}),/no discretion was granted/);
});

test('a permission or login failure is never retried automatically',async t=>{
 const f=setup(t);f.mode('denied-once');
 const out=await autopilot(f.root);
 assert.notEqual(out.reason,'CLOSE');
 assert.equal(f.state().phase,'EXECUTING');assert.ok(f.state().writer);
 assert.equal(f.state().auto_recoveries,undefined);
});

test('automatic recovery stops after two uses and leaves the third failure to the lead',async t=>{
 const f=setup(t);f.mode('always-fail');
 const out=await autopilot(f.root);
 assert.notEqual(out.reason,'CLOSE');
 const s=f.state();
 assert.equal(s.auto_recoveries,2);
 assert.equal(s.phase,'EXECUTING');assert.ok(s.writer);
 assert.equal(s.attempts.grok,3);
});

test('a failure after the worker changed the tree is not recovered automatically',async t=>{
 const f=setup(t);f.mode('always-fail');
 f.begin();
 await assert.rejects(execute(f.root,{proveQuiescence:true}),/exited with code 2/);
 fs.writeFileSync(path.join(f.root,'a.txt'),'half-done edit');
 assert.throws(()=>run(f.root,'auto-recover',{error:'grok exited with code 2'}),/AUTO_RECOVER_REFUSED.*changed the tree/);
 assert.equal(f.state().phase,'EXECUTING','a refusal changes nothing');
});

test('with discretion, a reviewer that could not finish is replaced by a model from another company',async t=>{
 const f=setup(t);f.mode('reviewer-fail-once');
 const out=await autopilot(f.root);
 assert.equal(out.reason,'CLOSE',JSON.stringify(out));
 const records=f.state().review_results[1];
 assert.deepEqual(records.map(r=>[r.executor,r.ok,r.verdict??null,!!r.substitute]),[['sonnet',true,'pass',true]]);
 assert.match(records[0].substitution_reason,/auto-substitute \(delegated\): .*sol.*did not finish; sonnet from another company/);
 assert.equal(f.state().lead_decision.authority.source,'delegated-policy');
 assert.equal(f.state().review_runs[1],2);
});

test('without discretion a failed reviewer is left to the lead',async t=>{
 const f=setup(t,{delegation:null});f.mode('reviewer-fail-once');
 const out=await autopilot(f.root);
 assert.equal(out.reason,'LEAD_DECISION_REQUIRED');
 assert.equal(f.state().phase,'LEAD_DECISION_REQUIRED');
 assert.equal(f.state().review_runs[1],1);
 assert.throws(()=>run(f.root,'auto-substitute-review',{}),/no discretion was granted/);
});

test('when no reviewer from another company is installed, the gate keeps the task and says why',async t=>{
 const f=setup(t,{review:{reviewers:['sol','grok']}});f.mode('reviewer-fail-once');
 const out=await autopilot(f.root);
 assert.equal(out.reason,'LEAD_DECISION_REQUIRED');
 assert.match(out.error.message,/AUTO_SUBSTITUTE_REFUSED: no installed reviewer from another company/);
 assert.equal(f.state().phase,'LEAD_DECISION_REQUIRED');
});
