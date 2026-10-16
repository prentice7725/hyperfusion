import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {consult} from '../scripts/executor-bridge.mjs';
import {autopilot} from '../scripts/autopilot.mjs';
import {read} from '../scripts/artifact.mjs';
import {report} from '../scripts/report.mjs';

// 반려 위임: 리드가 init에서 준 권한으로, 필수 리뷰어 전원이 근거를 들어 redo라고 하면 컨트롤러가 같은 일꾼에게 돌려보낸다.
// 승인 권한(delegation)과 별개다. 승인은 여전히 리드 게이트에서 한다.

const CHECK=`node -e "const s=require('fs').readFileSync('a.txt','utf8');if(s!=='fixed'){console.error('a.txt is '+s);process.exit(3)}"`;
const GRANT={reason:'single-file fix; reviewers may send clear AC failures back'};
const base=(t,{grant=GRANT,extra={},review={}}={})=>{
 const f=fixture(t,{initialize:false,executor:'grok'});
 fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({review:{by:'delegate',strategy:'lead-gated-adaptive',...review}}));
 const input={...f.brief,executor:'grok',acceptance_commands:[CHECK],acceptance_map:{AC1:[CHECK]},...extra};
 if(grant!==null)input.redo_delegation=grant;
 return {f,input};
};
const task=(f,...parts)=>path.join(f.control,'tasks',f.brief.task_id,...parts);
// 리드가 실제로 내는 brief처럼 수용 계약을 그대로 실어 보낸다(계약이 바뀌면 위임 반려는 적용되지 않는다).
const CONTRACT={acceptance_commands:[CHECK],acceptance_map:{AC1:[CHECK]}};
const reviewRound=async(f,mode)=>{
 f.mode(mode);f.begin({...CONTRACT,...(f.state().phase==='PLAN'?{}:{lead_feedback:'@review'})});await f.bridge();
 const c=run(f.root,'delegate-review',{});await consult(f.root,c.consult_id);return run(f.root,'consult-finish',{quiescent:true});
};

test('the rejection grant is given only at init, only for a STANDARD task with AC ids, and is separate from approval',t=>{
 let {f,input}=base(t);fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({review:{by:'delegate'}}));
 assert.throws(()=>run(f.root,'init',input),/REDO_DELEGATION: requires review.strategy/);
 ({f,input}=base(t,{extra:{task_criticality:'important',assignment_reason:'payments'}}));
 assert.throws(()=>run(f.root,'init',input),/REDO_DELEGATION: only a STANDARD task/);
 ({f,input}=base(t,{extra:{success_criteria:['the output is right']}}));
 assert.throws(()=>run(f.root,'init',input),/must carry AC ids/);
 for(const bad of [{reason:''},{reason:'x',max_redos:3},{reason:'x',max_redos:0},{reason:'x',approve:true}]){
  ({f,input}=base(t,{grant:bad}));
  assert.throws(()=>run(f.root,'init',input),/REDO_DELEGATION/,JSON.stringify(bad));
 }
 ({f,input}=base(t));
 run(f.root,'init',input);
 assert.deepEqual(read(task(f,'redo-delegation.json')),{policy:'evidence-redo',reason:GRANT.reason,max_redos:2,revision:1,granted_by:'lead-at-init',set_by:'controller'});
 assert.equal(f.state().delegation,undefined,'no approval power comes with it');
 assert.throws(()=>f.begin({redo_delegation:GRANT}),/REDO_DELEGATION: the lead delegates rejections only at init/);
});

test('a unanimous, evidenced rejection goes straight back to the same worker, recorded as the policy\'s decision',async t=>{
 const {f,input}=base(t);run(f.root,'init',input);
 const out=await reviewRound(f,'edit-review-redo');
 assert.equal(out.review.status,'auto_redo',JSON.stringify(out.review));
 assert.equal(f.state().phase,'REDO');
 const decision=read(task(f,'lead-decision-1.json'));
 assert.equal(decision.decision,'REDO');
 assert.equal(decision.authority.source,'delegated-policy');
 assert.equal(decision.authority.policy,'evidence-redo');
 assert.match(decision.rationale,/The lead did not read this round/);
 assert.ok(!fs.existsSync(task(f,'lead-packet-1.json')),'no lead gate was opened');
 // 다음 라운드는 같은 일꾼, 지시는 리뷰어의 파일·줄 지적이다.
 const next=f.begin({...CONTRACT,lead_feedback:'@review'});
 assert.equal(f.state().owner,'grok');
 assert.ok(JSON.stringify(read(task(f,'brief-2.json')).lead_feedback).includes('a.txt'),JSON.stringify(next.lead_feedback??null));
 assert.equal(report(f.root,f.brief.task_id).lead_load.redos_by_policy,1);
});

test('the same criterion rejected again, or the limit reached, stops at the lead gate with the history',async t=>{
 const {f,input}=base(t,{grant:{...GRANT,max_redos:1}});run(f.root,'init',input);
 assert.equal((await reviewRound(f,'edit-review-redo')).review.status,'auto_redo');
 const second=await reviewRound(f,'edit-review-redo');
 assert.equal(second.review.status,'lead_gate');
 const packet=read(task(f,'lead-packet-2.json'));
 assert.match(packet.note,/delegated rejection not applied/);
 assert.match(packet.note,/1 delegated rejections already used \(limit 1\)/);
 assert.match(packet.note,/the same criterion was rejected twice/);
 assert.deepEqual(packet.delegated_redos.map(r=>[r.round,r.still_rejected]),[[1,['AC1']]]);
});

test('weak or out-of-scope rejections are not applied by the policy',async t=>{
 // 파일·줄이 없는 반려
 let {f,input}=base(t);run(f.root,'init',input);
 f.mode('edit');f.begin(CONTRACT);await f.bridge();f.mode('review-vague');
 let c=run(f.root,'delegate-review',{});await consult(f.root,c.consult_id);
 let out=run(f.root,'consult-finish',{quiescent:true});
 assert.equal(out.review.status,'lead_gate');
 assert.match(read(task(f,'lead-packet-1.json')).note,/no file:line blocker or major finding/);
 // 범위 밖 파일을 가리키는 지적
 ({f,input}=base(t));run(f.root,'init',input);
 out=await reviewRound(f,'edit-review-redo-outside');
 assert.equal(out.review.status,'lead_gate');
 assert.match(read(task(f,'lead-packet-1.json')).note,/a finding points outside scope.paths: other.txt/);
 // 권한이 없으면 지금처럼 리드 게이트
 ({f,input}=base(t,{grant:null}));run(f.root,'init',input);
 out=await reviewRound(f,'edit-review-redo');
 assert.equal(out.review.status,'lead_gate');
 assert.doesNotMatch(read(task(f,'lead-packet-1.json')).note,/delegated rejection/);
});

test('autopilot follows a delegated rejection into the next round and stops when the lead must decide',async t=>{
 const {f,input}=base(t);run(f.root,'init',input);
 f.mode('edit-review-redo');
 const out=await autopilot(f.root);
 assert.equal(out.phase,'LEAD_DECISION_REQUIRED',JSON.stringify(out));
 assert.equal(f.state().iteration,2,'one round was sent back without the lead');
 assert.equal(f.state().auto_redos.length,1);
 const packet=read(task(f,'lead-packet-2.json'));
 assert.equal(packet.delegated_redos[0].round,1);
 assert.match(packet.note,/the same criterion was rejected twice/);
});
