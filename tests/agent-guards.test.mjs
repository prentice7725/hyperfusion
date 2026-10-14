import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {consult} from '../scripts/executor-bridge.mjs';
import {snapshot,read,hash} from '../scripts/artifact.mjs';
import {runCommands} from '../scripts/acceptance.mjs';
import {modifiedAcceptanceTests} from '../scripts/acceptance-integrity.mjs';
import {hookObservation} from '../scripts/hook-observation.mjs';
import {rememberHost} from '../scripts/lead-usage.mjs';
import {decide,settingsSnippet} from '../scripts/lead-guard.mjs';
import {dangerousBash} from '../scripts/lead-bash-guard.mjs';
import {checkPreserve} from '../scripts/preserve.mjs';
import {brief as checkBrief} from '../scripts/contracts.mjs';
import {report} from '../scripts/report.mjs';
import {measure} from '../scripts/metrics.mjs';
import {sonnet} from '../scripts/adapters/claude.mjs';
import * as grok from '../scripts/adapters/grok.mjs';
import {secretReadDeny,prompt} from '../scripts/adapters/common.mjs';

const denied=out=>out?.hookSpecificOutput?.permissionDecision==='deny';
const bash=(f,command,cwd=f.root)=>decide({hook_event_name:'PreToolUse',tool_name:'Bash',cwd,tool_input:{command}});
function acceptanceFixture(t,protectedTest=false){
 const f=fixture(t,{initialize:false});
 fs.writeFileSync(path.join(f.root,'check.test.mjs'),"import fs from 'node:fs';import assert from 'node:assert/strict';assert.equal(fs.readFileSync('a.txt','utf8'),'fixed');\n");
 f.git('add','.');f.git('commit','-m','red test');
 const brief={...f.brief,scope:{paths:['a.txt','check.test.mjs']},executor:'grok',acceptance_commands:['node check.test.mjs'],
  ...(protectedTest?{verification:{kind:'red-first',protect:['check.test.mjs']}}:{})};
 return {f,brief};
}
let inventoryUsable=null;
function supervision(t,root){
 inventoryUsable??=runCommands(root,['node -p 1']).every(r=>r.status==='pass');
 if(!inventoryUsable){t.skip('Acceptance process inventory unavailable on this host; CI exercises the controller path');return false;}
 return true;
}

test('red-first protection accepts overlapping scope, requires real inputs and never allows a green waiver',t=>{
 const {f,brief}=acceptanceFixture(t,true);
 assert.doesNotThrow(()=>checkBrief(brief));assert.doesNotThrow(()=>checkPreserve(f.root,brief));
 assert.throws(()=>checkBrief({...brief,acceptance_baseline_green:'skip red'}),/cannot waive/);
 assert.throws(()=>checkPreserve(f.root,{...brief,verification:{kind:'red-first',protect:['missing.test.mjs']}}),/matches no file/);
 assert.throws(()=>checkBrief({...brief,communication_language:'ko'}),/must be en/);
});

test('existing tests and direct command entrypoints are flagged, new tests and application data are not',t=>{
 const {f,brief}=acceptanceFixture(t);const baseline=snapshot(f.root);
 fs.writeFileSync(path.join(f.root,'check.test.mjs'),'process.exit(0)');
 fs.writeFileSync(path.join(f.root,'new.test.mjs'),'process.exit(0)');
 fs.writeFileSync(path.join(f.root,'a.txt'),'fixed');
 assert.deepEqual(modifiedAcceptanceTests(baseline,snapshot(f.root),brief),['check.test.mjs']);
 assert.deepEqual(modifiedAcceptanceTests(baseline,snapshot(f.root),{acceptance_commands:[`node -e "require('fs').readFileSync('a.txt')"`]}),['check.test.mjs']);
 assert.deepEqual(modifiedAcceptanceTests(baseline,snapshot(f.root),{}),[]);
});

test('test neutralization is rejected before controller acceptance when red-first tests are protected',t=>{
 const {f,brief}=acceptanceFixture(t,true);if(!supervision(t,f.root))return;
 run(f.root,'init',brief);run(f.root,'begin',brief);
 fs.writeFileSync(path.join(f.root,'check.test.mjs'),'process.exit(0)');
 const result={...f.result(['check.test.mjs']),task_id:brief.task_id};
 const s=run(f.root,'finish',{token:f.state().writer.token,quiescent:true,result});
 assert.equal(s.phase,'RECOVERY_REQUIRED');assert.match(s.last_errors.join('\n'),/ACCEPTANCE_TEST_MODIFIED/);
 assert.equal(s.acceptance,undefined);assert.equal(fs.readFileSync(path.join(f.root,'a.txt'),'utf8'),'base');
});

test('unprotected test neutralization cannot CLOSE from PASS alone and review receives the warning',async t=>{
 const {f,brief}=acceptanceFixture(t);if(!supervision(t,f.root))return;
 run(f.root,'init',brief);run(f.root,'begin',brief);
 fs.writeFileSync(path.join(f.root,'check.test.mjs'),'process.exit(0)');
 run(f.root,'finish',{token:f.state().writer.token,quiescent:true,result:f.result(['check.test.mjs'])});
 assert.equal(f.state().acceptance.status,'pass');assert.deepEqual(f.state().acceptance_test_changes,['check.test.mjs']);
 run(f.root,'consult',{mode:'advisor',question:'Check the tests',executors:['sonnet']});
 const dispatch=read(path.join(f.control,'tasks/HF-test/consult-c1-m1.json'));
 assert.equal(JSON.parse(dispatch.prompt).brief.consult.context.controller_acceptance.trusted_test_baseline,false);
 await consult(f.root,'c1');
 assert.equal(run(f.root,'consult-finish',{quiescent:true}).violated,false);
 f.review('pass');
 assert.throws(()=>run(f.root,'verify',{acceptance_satisfied:true}),/ACCEPTANCE_TEST_MODIFIED/);
 assert.equal(f.state().phase,'VERIFY');
 run(f.root,'verify',{acceptance_satisfied:true,acceptance_test_change_reason:'Reviewed the changed test; accepted explicitly for this regression fixture'});
 assert.equal(f.state().phase,'CLOSE');
});

test('red-first protection cannot be removed at begin and a correct implementation can CLOSE',t=>{
 const {f,brief}=acceptanceFixture(t,true);if(!supervision(t,f.root))return;
 run(f.root,'init',brief);
 assert.throws(()=>run(f.root,'begin',{...brief,verification:undefined}),/VERIFICATION_CONTRACT_CHANGED/);
 assert.equal(f.state().iteration,0);
 run(f.root,'begin',brief);fs.writeFileSync(path.join(f.root,'a.txt'),'fixed');
 run(f.root,'finish',{token:f.state().writer.token,quiescent:true,result:f.result(['a.txt'])});f.review('pass');
 run(f.root,'verify',{acceptance_satisfied:true});assert.equal(f.state().phase,'CLOSE');
});

test('a delegated PASS cannot automatically approve modified acceptance tests',async t=>{
 const {f,brief}=acceptanceFixture(t);if(!supervision(t,f.root))return;
 fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({review:{by:'delegate',strategy:'lead-gated-adaptive'}}));
 const input={...brief,delegation:{policy:'standard-auto',reason:'controller-proven fixture'},acceptance_map:{AC1:['node check.test.mjs']}};
 run(f.root,'init',input);run(f.root,'begin',brief);
 fs.writeFileSync(path.join(f.root,'check.test.mjs'),'process.exit(0)');
 run(f.root,'finish',{token:f.state().writer.token,quiescent:true,result:f.result(['check.test.mjs'])});
 const c=run(f.root,'delegate-review',{});await consult(f.root,c.consult_id);run(f.root,'consult-finish',{quiescent:true});
 assert.throws(()=>run(f.root,'policy-approve',{}),/ACCEPTANCE_TEST_MODIFIED/);
 assert.equal(f.state().phase,'LEAD_DECISION_REQUIRED');
});

test('Claude/Grok deny secret reads and protected edits in both implementation and consultation',t=>{
 const {f,brief}=acceptanceFixture(t,true);
 const b={...brief,repo_root:f.root,round:1};
 for(const consult of [false,true])for(const adapter of [sonnet,grok]){
  const q={...b,...(consult?{consult:{id:'c1',member:'m1',mode:'advisor'}}:{})};
  const d=adapter.dispatch(q,{owner:adapter.name},{probe:adapter.probe(),session:adapter.newSession(),promptFile:path.join(f.temp,'prompt.txt')});
  const args=d.cli.args.join(',');for(const rule of secretReadDeny())assert.ok(args.includes(rule),rule);
  assert.ok(args.includes('Edit(check.test.mjs)'));assert.ok(args.includes('Write(check.test.mjs)'));
 }
});

test('English communication and instruction file hashes are recorded without transmitting instruction contents',t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.root,'AGENTS.md'),'private instruction body');
 fs.mkdirSync(path.join(f.root,'sub'));fs.writeFileSync(path.join(f.root,'sub/CLAUDE.md'),'nested instructions');
 const brief={...f.brief,repo_root:f.root,round:1};
 for(const consult of [false,true]){
  const b={...brief,...(consult?{consult:{id:'c1',member:'m1',mode:'advisor'}}:{})};
  const request=JSON.parse(prompt(b,{owner:'luna'}));assert.equal(request.communication_language,'en');
  assert.equal(request.instruction_files.length,2);assert.equal(request.instruction_files[0].sha256,hash('private instruction body'));
  assert.ok(request.instructions.some(s=>s.includes('Use English')));assert.ok(request.instructions.some(s=>s.includes('cannot expand')));
  assert.ok(!JSON.stringify(request).includes('private instruction body'));
 }
});

test('fresh Bash observations survive init and appear in report/metrics without claiming all hooks enforce policy',t=>{
 const f=fixture(t,{initialize:false});const at=Date.now();
 rememberHost(f.root,{session_id:'host',hook_event_name:'PreToolUse',tool_name:'Bash'},at);
 assert.equal(hookObservation(f.root,{at:at+1000,sessionId:'host'}).hooks_observed,true);
 assert.equal(hookObservation(f.root,{at:at+16000}).hooks_observed,false);
 assert.equal(hookObservation(f.root,{at:at-1}).hooks_observed,false);
 assert.equal(hookObservation(f.root,{at:at+1000,sessionId:'foreign'}).hooks_observed,false);
 run(f.root,'init',f.brief);assert.equal(f.state().hooks_observed,true);assert.equal(report(f.root,f.brief.task_id).hooks_observed,true);
 assert.equal(measure(f.root).hooks_observed,true);
 rememberHost(f.root,{session_id:'host',hook_event_name:'SessionStart'},at);assert.equal(hookObservation(f.root,{at:at+1000}).hooks_observed,false);
});

test('dangerous Bash commands are blocked only while a task or lease is active, including explicit Git targets',t=>{
 const f=fixture(t,{initialize:false});assert.equal(bash(f,'git push'),null);run(f.root,'init',f.brief);
 for(const cmd of ['git push','git -C . push','git -c core.pager=cat commit -m done','git reset --hard','git clean -fd','rm -r -f build','rm --recursive --force build','Remove-Item build -Recurse -Force'])assert.ok(denied(bash(f,cmd)),cmd);
 assert.ok(denied(bash(f,`git -C "${f.root}" push`,f.temp)));
 assert.ok(denied(bash(f,`cd "${f.root}" && git push`,f.temp)));
 assert.equal(bash(f,'git status'),null);assert.equal(bash(f,'npm test'),null);assert.equal(bash(f,'rm obsolete.txt'),null);
 f.begin();f.finish();f.review();run(f.root,'verify',{acceptance_satisfied:true,tests:[{command:'inspection',status:'pass'}]});
 assert.equal(bash(f,'git push'),null,'the hook grants no publication authority; user authorization is still required');
 const hooks=settingsSnippet().hooks.PreToolUse.find(h=>h.matcher==='Bash');assert.ok(hooks.hooks.some(h=>h.command.includes('lead-guard.mjs')));
 assert.equal(dangerousBash('git p"u"sh'),'git push');
});
