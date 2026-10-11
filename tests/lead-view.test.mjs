import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {consult,execute} from '../scripts/executor-bridge.mjs';
import {autopilot} from '../scripts/autopilot.mjs';
import {read} from '../scripts/artifact.mjs';

const SCRIPT=fileURLToPath(new URL('../scripts/fusion-state.mjs',import.meta.url));
// 실제 명령줄을 띄워 리드가 받는 출력을 본다.
const cli=(f,action,input,...flags)=>{
 const r=spawnSync(process.execPath,[SCRIPT,action,f.root,...(input===undefined?[]:['-']),...flags],{encoding:'utf8',env:process.env,input:input===undefined?undefined:JSON.stringify(input),timeout:60000});
 assert.equal(r.status,0,r.stderr);
 return {text:r.stdout,json:JSON.parse(r.stdout)};
};
const adaptive=(t,review={})=>{
 const f=fixture(t,{initialize:false});
 fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({review:{by:'delegate',strategy:'lead-gated-adaptive',...review}}));
 return f;
};

test('begin prints what the lead needs to run the worker, not the whole prompt and probe result; --full prints everything',t=>{
 const f=fixture(t);
 const compact=cli(f,'begin',f.brief);
 assert.deepEqual(['command','args','token','task_id','round','executor'].filter(k=>compact.json[k]===undefined),[]);
 assert.equal(compact.json.cli,undefined);assert.equal(compact.json.prompt,undefined);
 assert.match(compact.json.omitted,/--full/);
 // dispatch 파일에는 전부 남아 있다.
 const dispatch=read(path.join(f.control,'tasks',f.brief.task_id,'dispatch-1.json'));
 assert.ok(dispatch.cli&&dispatch.prompt);
 assert.ok(compact.text.length<1500,String(compact.text.length));
 assert.ok(dispatch.prompt.length+JSON.stringify(dispatch.cli).length>5000);
});

test('--full keeps the complete output',t=>{
 const f=fixture(t);
 const full=cli(f,'begin',f.brief,'--full');
 assert.ok(full.json.cli&&full.json.prompt);assert.equal(full.json.omitted,undefined);
});

test('state-shaped outputs drop configuration and routing bulk, keep the phase, errors and next action',async t=>{
 const f=fixture(t);f.begin();await execute(f.root);
 const out=cli(f,'finish',{token:f.state().writer.token,quiescent:true});
 assert.equal(out.json.configuration,undefined);
 assert.equal(out.json.phase,f.state().phase);
 assert.ok(out.json.next_action);
 assert.deepEqual(out.json.last_errors,f.state().last_errors);
 assert.ok(out.text.length<2500,String(out.text.length));
 const full=cli(f,'status',undefined);
 assert.ok(full.json.configuration,'status itself is unchanged');
});

test('init shows the routing summary and the baseline instead of the whole configuration',t=>{
 const f=fixture(t,{initialize:false});
 const out=cli(f,'init',{...f.brief,executor:'grok'});
 assert.equal(out.json.configuration,undefined);
 assert.equal(out.json.routing.executor,'grok');
 assert.equal(out.json.next_action,'begin');
});

test('lead-decision keeps the decision, not the whole record',async t=>{
 const f=adaptive(t);run(f.root,'init',{...f.brief,executor:'grok'});
 f.begin();f.finish();
 const c=run(f.root,'delegate-review',{});await consult(f.root,c.consult_id);run(f.root,'consult-finish',{quiescent:true});
 const out=cli(f,'lead-decision',{decision:'APPROVE',rationale:'read it',baseline_digest:f.state().post_digest,contract_change:false,diff_reviewed:true,tests_checked:['t'],changed_scope:['a.txt']});
 assert.equal(out.json.decision,'APPROVE');
 assert.equal(out.json.phase,'VERIFY');
 assert.equal(out.json.lead_decision.decision,'APPROVE');
 assert.ok(out.json.lead_decision.file);
 assert.equal(out.json.lead_decision.rationale,undefined);
});

test('next names the one command to run in every phase, with the values the lead would copy already filled in',async t=>{
 const f=adaptive(t);
 run(f.root,'init',{...f.brief,executor:'grok'});
 const stateBefore=()=>fs.readFileSync(path.join(f.control,'state.json'),'utf8');
 let before=stateBefore();
 let n=run(f.root,'next',{});
 assert.equal(n.action,'begin');assert.match(n.command_line,/ begin .* -$/);assert.match(n.input_from,/initial-brief\.json$/);
 assert.equal(stateBefore(),before,'next never changes the state');

 f.begin();
 n=run(f.root,'next',{});
 assert.equal(n.phase,'EXECUTING');
 assert.equal(n.then.input.token,f.state().writer.token);
 assert.equal(n.then.input.quiescent,true);
 assert.equal(n.run.command,process.execPath);assert.equal(n.run.args.length,2);

 f.finish();
 n=run(f.root,'next',{});
 assert.equal(n.action,'delegate-review');

 const c=run(f.root,'delegate-review',{});
 n=run(f.root,'next',{});
 assert.equal(n.then.action,'consult-finish');assert.deepEqual(n.run.args.slice(-2),['--consult',c.consult_id]);
 await consult(f.root,c.consult_id);run(f.root,'consult-finish',{quiescent:true});

 n=run(f.root,'next',{});
 assert.equal(n.action,'lead-decision');
 assert.equal(n.input.baseline_digest,f.state().post_digest);
 assert.match(n.read_first,/lead-packet-1.*\.json$/);
 assert.ok(fs.existsSync(n.read_first));

 run(f.root,'lead-decision',{decision:'APPROVE',rationale:'x',baseline_digest:f.state().post_digest,contract_change:false,diff_reviewed:true,tests_checked:['t'],changed_scope:['a.txt']});
 n=run(f.root,'next',{});
 assert.equal(n.action,'verify');
 assert.deepEqual(n.input.acceptance_satisfied,true);
});

test('next in a classic task points to review, and after a rejection to begin with the review findings',t=>{
 const f=fixture(t);f.begin();f.finish();
 let n=run(f.root,'next',{});
 assert.equal(n.action,'review');assert.ok('verdict' in n.input);
 f.review('redo');
 n=run(f.root,'next',{});
 assert.equal(n.action,'begin');assert.match(n.input_note,/@review/);
});

test('next after an unproven acceptance run points to recover and shows why',t=>{
 const f=fixture(t);f.begin();f.finish();
 const s=f.state();s.phase='RECOVERY_REQUIRED';s.last_errors=['ACCEPTANCE_NOT_QUIESCENT: x'];
 fs.writeFileSync(path.join(f.control,'state.json'),JSON.stringify(s));
 const n=run(f.root,'next',{});
 assert.equal(n.action,'recover');assert.deepEqual(n.last_errors,['ACCEPTANCE_NOT_QUIESCENT: x']);
});

test('autopilot starts with the sample v0.3 config (auto_apply false) and stops at the lead gate',async t=>{
 const f=adaptive(t,{auto_apply:false});
 const mark=path.join(f.temp,'green');
 f.brief.acceptance_commands=[`node -e "process.exit(require('fs').existsSync(process.argv[1])?0:1)" "${mark}"`];
 run(f.root,'init',{...f.brief,executor:'grok'});
 fs.writeFileSync(mark,'1');
 const out=await autopilot(f.root);
 assert.notEqual(out.reason,'AUTOPILOT_REVIEW_REQUIRED');
 assert.equal(out.phase,'LEAD_DECISION_REQUIRED',JSON.stringify(out));
});

test('a classic task without auto_apply is still refused by autopilot',async t=>{
 const f=fixture(t,{initialize:false});
 fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({review:{by:'delegate',auto_apply:false}}));
 f.brief.acceptance_commands=['node -e "process.exit(1)"'];
 run(f.root,'init',{...f.brief,executor:'grok'});
 assert.equal((await autopilot(f.root)).reason,'AUTOPILOT_REVIEW_REQUIRED');
});
