import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {autopilot} from '../scripts/autopilot.mjs';
import * as contract from '../scripts/contracts.mjs';
import {scopeOverlap} from '../scripts/preserve.mjs';

const CMD=`node -e "process.exit(require('fs').readFileSync('spec/check.txt','utf8')==='ok'?0:1)"`;
const VERIFICATION={kind:'preserve',protect:['spec/**']};
const GRANT={policy:'standard-auto',reason:'behavior-preserving rename covered by spec/',allow_preserve:true};
// a.txt는 작업 범위, spec/는 보호 경로(테스트·픽스처). 명령은 수정 전에도 통과한다.
const repo=(t,{review,extra={},input={}}={})=>{
 const f=fixture(t,{initialize:false});
 fs.mkdirSync(path.join(f.root,'spec'));fs.writeFileSync(path.join(f.root,'spec/check.txt'),'ok');
 f.git('add','.');f.git('commit','-m','spec');
 if(review)fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({review:{by:'delegate',strategy:'lead-gated-adaptive',...review}}));
 return {f,brief:{...f.brief,executor:'grok',task_kind:'refactor',acceptance_commands:[CMD],acceptance_map:{AC1:[CMD]},
  acceptance_baseline_green:'a refactor: the spec already passes and must keep passing',verification:VERIFICATION,...extra,...input}};
};

test('the verification field is validated in the brief',t=>{
 const {brief}=repo(t);
 const bad=v=>()=>contract.brief({...brief,...v});
 assert.doesNotThrow(bad({}));
 for(const verification of [{kind:'other',protect:['spec/**']},{kind:'preserve',protect:[]},{kind:'preserve',protect:['**']},{kind:'preserve',protect:['spec/']},{kind:'preserve',protect:['../x/**']},{kind:'preserve',protect:['spec/**'],extra:1},{kind:'preserve'},'preserve'])
  assert.throws(bad({verification}),/Invalid verification/,JSON.stringify(verification));
 assert.throws(bad({acceptance_baseline_green:undefined}),/needs acceptance_baseline_green/);
 assert.throws(bad({acceptance_commands:undefined,acceptance_map:undefined,acceptance_baseline_green:undefined}),/verification needs acceptance_commands/);
});

test('protected paths may not overlap the task scope, and must match real files',t=>{
 assert.deepEqual(scopeOverlap(['src'],['spec/**']),[]);
 assert.ok(scopeOverlap(['spec/helpers'],['spec/**']).length);
 assert.ok(scopeOverlap(['spec'],['spec/**']).length);
 assert.ok(scopeOverlap(['src'],['**/*.test.mjs']).length,'a leading wildcard can match inside any scope');
 const a=repo(t,{input:{scope:{paths:['spec/helpers'],allowed_expansion:'ask-lead'}}});
 assert.throws(()=>run(a.f.root,'init',a.brief),/protect overlaps the task scope/);
 const b=repo(t,{input:{verification:{kind:'preserve',protect:['nowhere/**']}}});
 assert.throws(()=>run(b.f.root,'init',b.brief),/protect matches no file \(nowhere\/\*\*\)/);
});

test('a preserve task needs commands that already pass; failing ones belong to red-first',t=>{
 const {f,brief}=repo(t,{input:{acceptance_commands:['node -e "process.exit(1)"'],acceptance_map:undefined}});
 assert.throws(()=>run(f.root,'init',brief),/a preserve task needs acceptance_commands that already pass/);
});

test('autopilot accepts a recorded green baseline for a preserve task, and a waiver without verification is still refused',async t=>{
 const {f,brief}=repo(t,{review:{}});
 run(f.root,'init',brief);
 assert.equal(f.state().acceptance_baseline.status,'green-acknowledged');
 const out=await autopilot(f.root);
 assert.equal(out.reason,'LEAD_DECISION_REQUIRED',JSON.stringify(out));
 // 같은 waiver라도 verification이 없으면 예전처럼 거절된다.
 const g=repo(t,{review:{},input:{verification:undefined}});
 run(g.f.root,'init',g.brief);
 assert.equal((await autopilot(g.f.root)).reason,'AUTOPILOT_ACCEPTANCE_NOT_RED');
});

test('a worker that changes a protected file is stopped, and the lead accepting the stray file does not lift the protection',async t=>{
 const {f,brief}=repo(t);
 run(f.root,'init',brief);
 f.begin();
 const token=f.state().writer.token;
 fs.writeFileSync(path.join(f.root,'spec/check.txt'),'weakened');
 let s=run(f.root,'finish',{token,quiescent:true,result:f.result(['spec/check.txt'])});
 assert.equal(s.phase,'RECOVERY_REQUIRED');
 assert.match(s.last_errors.join(' '),/Protected by verification\.preserve.*spec\/check\.txt/);
 run(f.root,'recover',{token,quiescent:true,reason:'seen it',allow_out_of_scope:[{path:'spec/check.txt',reason:'lead accepts'}]});
 f.begin();
 s=run(f.root,'finish',{token:f.state().writer.token,quiescent:true,result:f.result(['spec/check.txt'].slice(0,0))});
 assert.equal(s.phase,'RECOVERY_REQUIRED');
 assert.match(s.last_errors.join(' '),/Protected by verification\.preserve/);
});

test('delegated approval of a preserve task needs the lead\'s explicit allow_preserve and task_kind refactor',t=>{
 let {f,brief}=repo(t,{review:{},input:{delegation:{policy:'standard-auto',reason:'x'}}});
 assert.throws(()=>run(f.root,'init',brief),/only when the lead sets allow_preserve:true/);
 ({f,brief}=repo(t,{review:{},input:{delegation:GRANT,task_kind:'code'}}));
 assert.throws(()=>run(f.root,'init',brief),/task_kind:"refactor"/);
 ({f,brief}=repo(t,{review:{},input:{delegation:{...GRANT,allow_preserve:'yes'}}}));
 assert.throws(()=>run(f.root,'init',brief),/allow_preserve must be true or false/);
 // allow_preserve는 보존 작업에만 의미가 있다
 ({f,brief}=repo(t,{review:{},input:{verification:undefined,acceptance_baseline_green:undefined,acceptance_commands:['node -e "process.exit(require(\'fs\').existsSync(\'x\')?0:1)"'],acceptance_map:undefined,delegation:GRANT}}));
 brief.acceptance_map={AC1:brief.acceptance_commands};
 assert.throws(()=>run(f.root,'init',brief),/allow_preserve applies only to a task with verification preserve/);
});

test('a delegated preserve task runs to CLOSE with the preserve evidence recorded',async t=>{
 const {f,brief}=repo(t,{review:{},input:{delegation:GRANT}});
 run(f.root,'init',brief);
 const out=await autopilot(f.root);
 assert.equal(out.reason,'CLOSE',JSON.stringify(out));
 const s=f.state();
 assert.equal(s.lead_decision.authority.source,'delegated-policy');
 assert.ok(s.lead_decision.policy_checks.includes('protected files unchanged'));
 assert.ok(s.lead_decision.policy_checks.includes('the lead allowed a preserve task'));
 assert.match(fs.readFileSync(s.pr_draft,'utf8'),/검증: 보존\(preserve\).*`spec\/\*\*`/);
});

test('the policy refuses a preserve task whose protected files changed after the round',async t=>{
 const {f,brief}=repo(t,{review:{},input:{delegation:GRANT}});
 run(f.root,'init',brief);
 f.begin();f.finish();
 const {consult}=await import('../scripts/executor-bridge.mjs');
 const c=run(f.root,'delegate-review',{});await consult(f.root,c.consult_id);run(f.root,'consult-finish',{quiescent:true});
 assert.equal(f.state().phase,'LEAD_DECISION_REQUIRED');
 fs.writeFileSync(path.join(f.root,'spec/check.txt'),'weakened');
 assert.throws(()=>run(f.root,'policy-approve',{}),/POLICY_NOT_ELIGIBLE.*protected files changed: spec\/check\.txt/);
});
