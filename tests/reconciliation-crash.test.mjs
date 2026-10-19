import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {execute,consult} from '../scripts/executor-bridge.mjs';
import {hash} from '../scripts/artifact.mjs';

const GRANT={policy:'settle-complete',reason:'Fault-injection canary: explicit settlement only'};
const taskdir=f=>path.join(f.control,'tasks',f.brief.task_id);
const expected=p=>Object.fromEntries(['task_id','round','action','consult_id','identity'].filter(k=>p[k]!==undefined).map(k=>[k,p[k]]));
const invariant=s=>({task_id:s.task_id,iteration:s.iteration,attempts:s.attempts,limits:s.limits,reconciliation:s.reconciliation,rejections:s.reviews.filter(r=>r.verdict==='redo')});

async function setup(t,{begin=true}={}) {
 const f=fixture(t,{initialize:false});
 fs.writeFileSync(path.join(f.root,'user-notes.txt'),'preserve user changes');
 run(f.root,'init',{...f.brief,executor:'grok',reconciliation:GRANT});
 // Keep real controller rejection history, rather than hand-editing state.
 f.begin();await f.bridge();f.review('redo',['AC1: first implementation must be revised']);
 if(begin)f.begin();
 f.mode('edit');return f;
}

// Exit the actual controller process immediately after a durable filesystem
// boundary. There are no production fault hooks or weakened process checks.
function crash(f,action,boundary,input={},consultId=null) {
 const file=path.join(f.temp,'fault-controller.mjs');
 const controller=new URL('../scripts/fusion-state.mjs',import.meta.url).href;
 const bridge=new URL('../scripts/executor-bridge.mjs',import.meta.url).href;
 fs.writeFileSync(file,`import fs from 'node:fs';
import path from 'node:path';
import {run} from ${JSON.stringify(controller)};
import {execute,consult} from ${JSON.stringify(bridge)};
const [root,action,boundary,json,consultId]=process.argv.slice(2),input=JSON.parse(json);
const hit=file=>{
 if(boundary.startsWith('state:')&&path.basename(String(file))==='state.json'){
  const state=JSON.parse(fs.readFileSync(file));
  if(state.phase===boundary.slice(6))process.exit(77);
 }
 if(boundary.startsWith('acceptance:')&&path.basename(String(file))==='acceptance.json'){
  if(JSON.parse(fs.readFileSync(file)).stage===boundary.slice(11))process.exit(77);
 }
 if(path.basename(String(file))===boundary)process.exit(77);
};
const write=fs.writeFileSync,rename=fs.renameSync;
fs.writeFileSync=function(file,...args){const out=write.call(this,file,...args);hit(file);return out;};
fs.renameSync=function(from,to){const out=rename.call(this,from,to);hit(to);return out;};
if(action==='execute')await execute(root,{proveQuiescence:true});
else if(action==='consult')await consult(root,consultId,{proveQuiescence:true});
else await run(root,action,input);
console.error('Fault checkpoint was not reached');process.exitCode=78;
`);
 const child=spawnSync(process.execPath,[file,f.root,action,boundary,JSON.stringify(input),consultId??''],{encoding:'utf8',timeout:120000,windowsHide:true});
 assert.equal(child.status,77,`${action}/${boundary}: ${child.error?.message??''}\n${child.stderr}`);
}

async function stoppedWithoutMutation(f,code) {
 const stateFile=path.join(f.control,'state.json'),before=fs.readFileSync(stateFile);
 const launches=fs.readdirSync(taskdir(f)).filter(n=>n.startsWith('launch-')).map(n=>[n,hash(fs.readFileSync(path.join(taskdir(f),n)))]);
 const p=await run(f.root,'reconcile');
 assert.deepEqual(p.reason_codes,[code],JSON.stringify(p));
 assert.deepEqual(await run(f.root,'reconcile'),p);
 assert.deepEqual(fs.readFileSync(stateFile),before);
 assert.deepEqual(fs.readdirSync(taskdir(f)).filter(n=>n.startsWith('launch-')).map(n=>[n,hash(fs.readFileSync(path.join(taskdir(f),n)))]),launches);
 assert.equal(fs.readFileSync(path.join(f.root,'user-notes.txt'),'utf8'),'preserve user changes');
 return p;
}

async function finishedWorker(f) {
 await execute(f.root,{proveQuiescence:true});
 const p=await run(f.root,'reconcile');assert.equal(p.status,'READY_FOR_REVALIDATION',JSON.stringify(p));
 return run(f.root,'reconcile',{apply:true,expected:expected(p)});
}

async function verifiedReview(f) {
 await finishedWorker(f);f.mode('ok');
 const descriptor=run(f.root,'delegate-review',{executors:['sol']});
 const out=await consult(f.root,descriptor.consult_id,{proveQuiescence:true});
 assert.ok(out.members.every(m=>m.ok&&m.quiescence?.quiescent));
 const p=await run(f.root,'reconcile');
 const settled=await run(f.root,'reconcile',{apply:true,expected:expected(p)});
 assert.equal(settled.phase,'VERIFY');return settled;
}

test('crash immediately after dispatch retains the original task, budgets, grant and rejection history',async t=>{
 const f=await setup(t,{begin:false}),before=invariant(f.state());
 crash(f,'begin','dispatch-2.json',{...f.brief,lead_feedback:['AC1: finish the revision']});
 const after=f.state();assert.equal(after.iteration,2);assert.equal(after.attempts.grok,2);
 assert.deepEqual(invariant(after),{...before,iteration:2,attempts:{...before.attempts,grok:2}});
 assert.deepEqual(after.reconciliation,before.reconciliation);assert.deepEqual(invariant(after).rejections,before.rejections);
 assert.equal(after.task_id,before.task_id);assert.ok(after.writer);
 await stoppedWithoutMutation(f,'DISPATCH_OUTCOME_UNCERTAIN');
});

for(const [boundary,code] of [['envelope-2.json','COMPLETION_EVIDENCE_MISSING'],['result-2.json','COMPLETION_EVIDENCE_MISSING']])test(`crash after ${boundary} cannot replay a worker or manufacture completion`,async t=>{
 const f=await setup(t),before=invariant(f.state());
 crash(f,'execute',boundary);
 assert.deepEqual(invariant(f.state()),before);assert.equal(fs.readFileSync(path.join(f.root,'a.txt'),'utf8'),'fixed');
 await stoppedWithoutMutation(f,code);assert.ok(f.state().writer);
});

test('crash after complete worker evidence allows one explicit finish and preserves rejection history',async t=>{
 const f=await setup(t),before=invariant(f.state());crash(f,'execute','completion-2.json');
 const p=await run(f.root,'reconcile');assert.equal(p.status,'READY_FOR_REVALIDATION',JSON.stringify(p));
 const input={apply:true,expected:expected(p)},settled=await run(f.root,'reconcile',input);
 assert.equal(settled.phase,'REVIEW');assert.deepEqual(invariant(f.state()),before);
 const records=fs.readdirSync(taskdir(f));
 assert.deepEqual(await run(f.root,'reconcile',input),settled);assert.deepEqual(fs.readdirSync(taskdir(f)),records);
 assert.equal(f.state().writer,null);assert.equal(fs.readFileSync(path.join(f.root,'user-notes.txt'),'utf8'),'preserve user changes');
});

for(const complete of [false,true])test(`crash after reviewer ${complete?'completion':'result'} preserves the panel and never relaunches a seat`,async t=>{
 const f=await setup(t);await finishedWorker(f);f.mode('ok');
 const descriptor=run(f.root,'delegate-review',{executors:['sol']}),id=descriptor.consult_id;
 const before=invariant(f.state()),open=f.state().open_consult;
 crash(f,'consult',complete?`completion-consult-${id}-m1.json`:`consult-result-${id}-m1.json`,{},id);
 assert.deepEqual(invariant(f.state()),before);assert.deepEqual(f.state().open_consult,open);
 if(!complete){await stoppedWithoutMutation(f,'COMPLETION_EVIDENCE_MISSING');return;}
 const p=await run(f.root,'reconcile'),input={apply:true,expected:expected(p)};
 assert.equal(p.action,'consult-finish',JSON.stringify(p));
 const settled=await run(f.root,'reconcile',input);assert.equal(settled.phase,'VERIFY');
 const reviews=f.state().reviews;assert.deepEqual(await run(f.root,'reconcile',input),settled);assert.deepEqual(f.state().reviews,reviews);
 assert.deepEqual(invariant(f.state()),before);
});

test('crash while recording review settlement remains uncertain and cannot append another review',async t=>{
 const f=await setup(t);await finishedWorker(f);f.mode('ok');
 const review=run(f.root,'delegate-review',{executors:['sol']});
 await consult(f.root,review.consult_id,{proveQuiescence:true});
 const p=await run(f.root,'reconcile'),input={apply:true,expected:expected(p)},before=invariant(f.state());
 crash(f,'reconcile',`consult-${review.consult_id}-finish.json`,input);
 assert.deepEqual((await run(f.root,'reconcile',input)).reason_codes,['OPERATION_OUTCOME_UNCERTAIN']);
 await stoppedWithoutMutation(f,'OPERATION_OUTCOME_UNCERTAIN');assert.deepEqual(invariant(f.state()),before);
});

const VERIFY="if(require('fs').readFileSync('a.txt','utf8')!=='fixed')process.exit(1)";
for(const [boundary,phase,code] of [['verification.json','VERIFY','VERIFICATION_OUTCOME_UNCERTAIN'],['state:CLOSE','CLOSE','TERMINAL_SETTLEMENT_INCOMPLETE']])test(`crash at ${boundary} never replays verification or hides unfinished settlement`,async t=>{
 const f=await setup(t);await verifiedReview(f);const before=invariant(f.state());
 const checked=spawnSync(process.execPath,['-e',VERIFY],{cwd:f.root,windowsHide:true});assert.equal(checked.status,0);
 crash(f,'verify',boundary,{acceptance_satisfied:true,tests:[{command:'node -e '+VERIFY,status:'pass'}]});
 assert.equal(f.state().phase,phase);assert.deepEqual(invariant(f.state()),before);
 await stoppedWithoutMutation(f,code);
 const packet=run(f.root,'resume');assert.ok(packet.reason_codes.includes(code));assert.equal(packet.lead_required,true);
 assert.ok(!packet.next_action.startsWith('init'));
});

test('crash before a fresh verification acceptance run retains its marker without rerunning tests',async t=>{
 const f=fixture(t,{initialize:false});
 fs.writeFileSync(path.join(f.root,'user-notes.txt'),'preserve user changes');
 fs.appendFileSync(path.join(f.root,'.gitignore'),'\ncache.bin\n');
 f.brief.acceptance_commands=[`node -e "${VERIFY}"`];
 const initial=run(f.root,'init',{...f.brief,executor:'grok',reconciliation:GRANT});
 assert.equal(initial.phase,'PLAN');assert.equal(initial.acceptance_baseline.status,'red');
 f.begin();f.mode('edit');await finishedWorker(f);
 f.git('diff','--','a.txt');f.review('pass');
 fs.writeFileSync(path.join(f.root,'cache.bin'),'non-executable cache');
 const before=invariant(f.state());
 crash(f,'verify','acceptance:verify',{acceptance_satisfied:true,acceptance_trust_ignored:true});
 const marker=path.join(f.control,'locks/acceptance.json'),bytes=fs.readFileSync(marker);
 assert.equal(JSON.parse(bytes).stage,'verify');
 await stoppedWithoutMutation(f,'ACCEPTANCE_RECOVERY_PENDING');
 assert.deepEqual(fs.readFileSync(marker),bytes);assert.deepEqual(invariant(f.state()),before);
 assert.ok(run(f.root,'resume').reason_codes.includes('ACCEPTANCE_PENDING'));
 // The ordinary controller restart path may mark recovery, but cannot reset
 // this task's authority/history or silently run the pending command.
 assert.equal(run(f.root,'status',{summary:true}).phase,'RECOVERY_REQUIRED');
 assert.deepEqual(invariant(f.state()),before);assert.deepEqual(fs.readFileSync(marker),bytes);
 assert.equal(run(f.root,'status',{summary:true}).phase,'RECOVERY_REQUIRED');
 assert.deepEqual(invariant(f.state()),before);
});

test('mandatory paired reviews require every completion and retain the important-task lead gate',async t=>{
 const f=fixture(t,{initialize:false});
 fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({review:{by:'delegate',strategy:'lead-gated-adaptive'}}));
 run(f.root,'init',{...f.brief,executor:'grok',task_criticality:'important',assignment_reason:'Mandatory independent pair',reconciliation:GRANT});
 f.begin();f.mode('edit');await finishedWorker(f);f.mode('ok');
 const descriptor=run(f.root,'delegate-review',{});
 assert.deepEqual(descriptor.members.map(m=>m.executor),['sol','sonnet']);
 const results=await consult(f.root,descriptor.consult_id,{proveQuiescence:true});
 assert.ok(results.members.every(m=>m.ok&&m.quiescence?.quiescent),JSON.stringify(results));
 const before=f.state(),launches=fs.readdirSync(taskdir(f)).filter(n=>n.startsWith('launch-'));
 const second=path.join(taskdir(f),`completion-consult-${descriptor.consult_id}-${descriptor.members[1].member}.json`);
 const held=path.join(f.temp,'held-completion.json');
 // Both supervised reviewers have stopped. Model an incompletely persisted
 // panel without spawning or killing a still-running sibling.
 fs.renameSync(second,held);
 assert.deepEqual((await run(f.root,'reconcile')).reason_codes,['COMPLETION_EVIDENCE_MISSING']);
 assert.deepEqual(f.state(),before);assert.deepEqual(fs.readdirSync(taskdir(f)).filter(n=>n.startsWith('launch-')),launches);
 fs.renameSync(held,second);
 const p=await run(f.root,'reconcile'),input={apply:true,expected:expected(p)};
 assert.equal(p.status,'READY_FOR_REVALIDATION',JSON.stringify(p));
 const settled=await run(f.root,'reconcile',input);
 assert.equal(settled.phase,'LEAD_DECISION_REQUIRED');
 const records=f.state().review_results[1];assert.equal(records.length,2);
 assert.ok(records.every(r=>r.ok&&r.verdict==='pass'&&r.digest===f.state().post_digest));
 assert.deepEqual(await run(f.root,'reconcile',input),settled);assert.deepEqual(f.state().review_results[1],records);
 assert.deepEqual(f.state().attempts,before.attempts);assert.deepEqual(f.state().assignment,before.assignment);
});
