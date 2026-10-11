import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {consult} from '../scripts/executor-bridge.mjs';
import {autopilot} from '../scripts/autopilot.mjs';
import {read} from '../scripts/artifact.mjs';

const CHECK=`node -e "const s=require('fs').readFileSync('a.txt','utf8');if(s!=='fixed'){console.error('a.txt is '+s);process.exit(3)}"`;
const GRANT={policy:'standard-auto',reason:'single-file fix with a command that proves AC1'};
const base=(t,{review={},executor='grok',delegation=GRANT,extra={}}={})=>{
 const f=fixture(t,{initialize:false,executor});
 fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({review:{by:'delegate',strategy:'lead-gated-adaptive',...review}}));
 const input={...f.brief,executor,acceptance_commands:[CHECK],acceptance_map:{AC1:[CHECK]},...extra};
 if(delegation!==null)input.delegation=delegation;
 return {f,input};
};
const task=(f,...parts)=>path.join(f.control,'tasks',f.brief.task_id,...parts);
const gate=async f=>{ // 구현 라운드와 위임 리뷰를 끝내고 리드 게이트에 선다
 f.mode('edit');f.begin();await f.bridge();f.mode('ok');
 const c=run(f.root,'delegate-review',{});await consult(f.root,c.consult_id);return run(f.root,'consult-finish',{quiescent:true});
};

test('the lead can grant discretion only at init, and only for a STANDARD task the controller can prove',t=>{
 // adaptive 게이트가 없으면 대신할 게이트가 없다
 let {f,input}=base(t);fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({review:{by:'delegate'}}));
 assert.throws(()=>run(f.root,'init',input),/DELEGATION: requires review.strategy/);
 // 중요 작업은 리드에게 남는다
 ({f,input}=base(t,{extra:{task_criticality:'important',assignment_reason:'payments'}}));
 assert.throws(()=>run(f.root,'init',input),/only a STANDARD task/);
 // 모든 AC를 증명하는 명령이 있어야 한다
 ({f,input}=base(t,{extra:{success_criteria:['AC1: a','AC2: b'],acceptance_map:{AC1:[CHECK]}}}));
 assert.throws(()=>run(f.root,'init',input),/acceptance_map must cover every AC; missing AC2/);
 // 처음부터 통과하는 명령은 근거가 못 된다
 ({f,input}=base(t,{extra:{acceptance_baseline_green:'refactor'}}));
 assert.throws(()=>run(f.root,'init',input),/red-first/);
 ({f,input}=base(t,{delegation:{policy:'always'}}));
 assert.throws(()=>run(f.root,'init',input),/policy must be one of/);
 ({f,input}=base(t,{delegation:{...GRANT,max_rounds:9}}));
 assert.throws(()=>run(f.root,'init',input),/max_rounds/);
 ({f,input}=base(t,{delegation:{...GRANT,extra:1}}));
 assert.throws(()=>run(f.root,'init',input),/unknown field/);
 // Sonnet·Sol 구현은 별도 grant가 필요한 작업이라 위임할 수 없다
 ({f,input}=base(t,{executor:'haiku'}));
 assert.equal(run(f.root,'init',input).delegation.policy,'standard-auto');
});

test('discretion cannot be added after init: not in a later brief, not by repository config',async t=>{
 const {f,input}=base(t,{delegation:null});
 run(f.root,'init',input);
 assert.equal(f.state().delegation,undefined);
 assert.throws(()=>run(f.root,'begin',{...input,delegation:GRANT}),/DELEGATION: the lead grants discretion only at init/);
 assert.throws(()=>run(f.root,'policy-approve',{}),/Invalid phase/);
 const g=base(t,{delegation:null,review:{delegation:GRANT}});
 assert.throws(()=>run(g.f.root,'init',g.input),/review|config|Invalid/i);
});

test('with discretion granted, autopilot runs the round, the controller approves it, and verify closes it',async t=>{
 const {f,input}=base(t);
 const mark=path.join(f.temp,'green');
 // red-first: 표식 파일이 생기기 전에는 실패하는 명령
 const cmd=`node -e "process.exit(require('fs').existsSync(process.argv[1])?0:1)" "${mark}"`;
 input.acceptance_commands=[cmd];input.acceptance_map={AC1:[cmd]};
 const state=run(f.root,'init',input);
 assert.equal(state.phase,'PLAN');assert.equal(state.delegation.max_rounds,2);
 fs.writeFileSync(mark,'1');
 const out=await autopilot(f.root);
 assert.equal(out.reason,'CLOSE',JSON.stringify(out));
 const s=f.state();
 assert.equal(s.phase,'CLOSE');
 assert.equal(s.lead_decision.authority.source,'delegated-policy');
 assert.equal(s.lead_decision.authority.model_verified,false);
 assert.ok(s.lead_decision.policy_checks.length>=10,'the passing checks are recorded');
 assert.match(s.lead_decision.rationale,/the lead did not read this round/);
 assert.deepEqual(s.ac_table,[{id:'AC1',status:'PASS'}]);
 assert.match(fs.readFileSync(s.pr_draft,'utf8'),/위임 정책\(standard-auto\)/);
 assert.deepEqual(read(task(f,'lead-decision-1.json')).authority.source,'delegated-policy');
});

test('without discretion autopilot still stops at the lead gate',async t=>{
 const {f,input}=base(t,{delegation:null});
 const mark=path.join(f.temp,'green');
 const cmd=`node -e "process.exit(require('fs').existsSync(process.argv[1])?0:1)" "${mark}"`;
 input.acceptance_commands=[cmd];input.acceptance_map={AC1:[cmd]};
 run(f.root,'init',input);fs.writeFileSync(mark,'1');
 const out=await autopilot(f.root);
 assert.equal(out.reason,'LEAD_DECISION_REQUIRED');assert.equal(f.state().phase,'LEAD_DECISION_REQUIRED');
 assert.throws(()=>run(f.root,'policy-approve',{}),/no discretion was granted/);
});

test('a risk path round is never approved by the policy; the lead gate keeps it',async t=>{
 const {f,input}=base(t,{review:{risk_paths:['a.txt']}});
 run(f.root,'init',input);
 const out=await gate(f);
 assert.equal(out.phase,'LEAD_DECISION_REQUIRED');
 assert.throws(()=>run(f.root,'policy-approve',{}),/POLICY_NOT_ELIGIBLE.*risk paths: a\.txt/);
 assert.equal(f.state().phase,'LEAD_DECISION_REQUIRED','a refusal changes nothing');
});

test('a replaced rejection is never approved by the policy',async t=>{
 const {f,input}=base(t);
 run(f.root,'init',input);
 f.mode('edit');f.begin();await f.bridge();
 f.mode('review-redo');
 let c=run(f.root,'delegate-review',{});await consult(f.root,c.consult_id);run(f.root,'consult-finish',{quiescent:true});
 f.mode('ok');
 c=run(f.root,'delegate-review',{executors:['luna'],substitution_reason:'second opinion'});await consult(f.root,c.consult_id);run(f.root,'consult-finish',{quiescent:true});
 assert.throws(()=>run(f.root,'policy-approve',{}),/POLICY_NOT_ELIGIBLE.*replaced/);
});

test('the policy refuses when the tree changed after the round',async t=>{
 const {f,input}=base(t);
 run(f.root,'init',input);
 await gate(f);
 fs.writeFileSync(path.join(f.root,'a.txt'),'tampered');
 assert.throws(()=>run(f.root,'policy-approve',{}),/POLICY_NOT_ELIGIBLE.*tree changed/);
});

test('the policy refuses when the contract in the round brief differs from the one granted at init',async t=>{
 const {f,input}=base(t);
 run(f.root,'init',input);
 await gate(f);
 const file=task(f,'brief-1.json');
 const brief=read(file);brief.success_criteria=['AC1: something easier'];
 fs.writeFileSync(file,JSON.stringify(brief));
 assert.throws(()=>run(f.root,'policy-approve',{}),/POLICY_NOT_ELIGIBLE.*contract changed since init: success_criteria/);
});

test('next shows whether the policy would approve and why not',async t=>{
 const {f,input}=base(t,{review:{risk_paths:['a.txt']}});
 run(f.root,'init',input);
 await gate(f);
 const n=run(f.root,'next',{});
 assert.equal(n.action,'lead-decision');
 assert.equal(n.delegated_policy.eligible,false);
 assert.match(n.delegated_policy.unmet.join(' '),/risk paths/);
});
