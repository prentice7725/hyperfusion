import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {autopilot} from '../scripts/autopilot.mjs';
import {read,atomic} from '../scripts/artifact.mjs';
import {acquireLock} from '../scripts/lock.mjs';
import {descendants,watchProcessTree} from '../scripts/process-proof.mjs';

const setup=(t,extra={})=>{
 const f=fixture(t,{initialize:false});f.brief.acceptance_commands=['node -e "process.exit(0)"'];
 run(f.root,'init',{...f.brief,executor:'grok',...extra});return f;
};
test('autopilot passes independent review and stops at VERIFY with process and masking audit',async t=>{
 const f=setup(t);const out=await autopilot(f.root);
 assert.equal(out.phase,'VERIFY',JSON.stringify(out));assert.equal(out.reason,'VERIFY');assert.equal(f.state().writer,null);
 assert.equal(f.state().reviews.at(-1).reviewed_by,'sol');
 const dir=path.join(f.control,'tasks',f.brief.task_id);assert.equal(read(path.join(dir,'quiescence-1.json')).quiescent,true);
 assert.equal(read(path.join(dir,'redaction-1.json')).enabled,true);assert.ok(!fs.existsSync(path.join(dir,'verification.json')));
 assert.deepEqual(read(out.journal_file).events.map(e=>e.action),['begin','execute','finish','delegate-review','consult','consult-finish']);
});
test('missing acceptance commands never launches a worker',async t=>{
 const f=fixture(t);const out=await autopilot(f.root);assert.equal(out.reason,'AUTOPILOT_ACCEPTANCE_REQUIRED');assert.equal(f.state().iteration,0);
});
test('disabled automatic review never launches a worker',async t=>{
 const f=setup(t),s=f.state();s.configuration.review.auto_apply=false;atomic(path.join(f.control,'state.json'),s);
 assert.equal((await autopilot(f.root)).reason,'AUTOPILOT_REVIEW_REQUIRED');assert.equal(f.state().iteration,0);
});
test('an existing launch marker is never re-executed or automatically settled',async t=>{
 const f=setup(t);f.begin({acceptance_commands:f.brief.acceptance_commands});
 fs.writeFileSync(path.join(f.control,'tasks',f.brief.task_id,'launch-1.json'),'{}');
 const out=await autopilot(f.root);assert.equal(out.reason,'AUTOPILOT_EXISTING_LAUNCH');assert.ok(f.state().writer);
});
test('exclusive runner lock prevents concurrent autopilots',async t=>{
 const f=setup(t),unlock=acquireLock(path.join(f.control,'locks/autopilot.lock'));t.after(unlock);
 await assert.rejects(()=>autopilot(f.root),e=>e.code==='LOCK_BUSY');assert.equal(f.state().iteration,0);
});
test('step cap preserves a launched result and writer lease for manual settlement',async t=>{
 const f=setup(t);const out=await autopilot(f.root,{max_steps:2});
 assert.equal(out.reason,'AUTOPILOT_STEP_LIMIT');assert.equal(out.phase,'EXECUTING');assert.ok(f.state().writer);
});
test('aborted autopilot does not begin a round',async t=>{
 const f=setup(t),controller=new AbortController();controller.abort();
 assert.equal((await autopilot(f.root,{signal:controller.signal})).reason,'AUTOPILOT_INTERRUPTED');assert.equal(f.state().iteration,0);
});
test('interrupting a running worker stops supervision and retains the lease',async t=>{
 const f=setup(t),controller=new AbortController();f.mode('hang');
 const timer=setTimeout(()=>controller.abort(),1500);t.after(()=>clearTimeout(timer));
 const out=await autopilot(f.root,{signal:controller.signal});assert.equal(out.reason,'AUTOPILOT_INTERRUPTED');assert.equal(out.phase,'EXECUTING');assert.ok(f.state().writer);
 assert.ok(!fs.existsSync(path.join(f.control,'tasks',f.brief.task_id,'result-1.json')));
});
test('budget exhaustion stops before launching',async t=>{
 const f=setup(t,{limits:{max_wall_ms:1}});await new Promise(r=>setTimeout(r,5));
 const out=await autopilot(f.root);assert.equal(out.reason,'BUDGET_EXCEEDED');assert.equal(out.phase,'BLOCKED');assert.equal(f.state().iteration,0);
});
test('worker scope violations require recovery and retain the lease',async t=>{
 const f=setup(t);f.mode('tamper');const out=await autopilot(f.root);
 assert.equal(out.phase,'RECOVERY_REQUIRED');assert.ok(f.state().writer);
});
test('rejected acceptance retries with controller feedback up to attempt cap',async t=>{
 const f=setup(t,{acceptance_commands:['node -e "process.exit(1)"']});
 const s=f.state();s.configuration.external.available=['grok'];s.routing.candidates=['grok'];s.active_executor='grok';atomic(path.join(f.control,'state.json'),s);
 const out=await autopilot(f.root);assert.equal(out.phase,'TAKEOVER_REQUIRED');assert.equal(f.state().attempts.grok,3);
 const brief=read(path.join(f.control,'tasks',f.brief.task_id,'brief-2.json'));assert.ok(Array.isArray(brief.lead_feedback));assert.ok(JSON.stringify(brief.lead_feedback).includes('process.exit(1)'));
});
test('process evidence tracks descendant identities without treating a reused PID as a tracked child',()=>{
 const tracked=new Map([[2,'old']]);const rows=[{pid:1,parent:0,created:'root'},{pid:2,parent:0,created:'new'},{pid:3,parent:1,created:'child'},{pid:4,parent:3,created:'grandchild'}];
 assert.deepEqual(descendants(rows,1,tracked).map(p=>p.pid),[1,3,4]);
});
test('unavailable process table or live tracked descendants cannot prove quiescence',async()=>{
 const broken=watchProcessTree({readTable:async()=>{throw Object.assign(Error('denied'),{code:'EACCES'});}});broken.start(100);
 assert.equal((await broken.finish({exited:true})).quiescent,false);
 let calls=0;const watcher=watchProcessTree({readTable:async()=>++calls===1?[{pid:100,parent:0,created:'p'},{pid:101,parent:100,created:'c'}]:[{pid:101,parent:0,created:'c'}]});
 watcher.start(100);assert.equal((await watcher.finish({exited:true})).quiescent,false);
 const aborted=watchProcessTree({readTable:async()=>[]});aborted.start(100);assert.equal((await aborted.finish({exited:false,aborted:true})).quiescent,false);
});
test('slow process-table observations do not accumulate a polling backlog',async()=>{
 let calls=0,release;const gate=new Promise(resolve=>{release=resolve;});
 const watcher=watchProcessTree({pollMs:5,readTable:async()=>{
  calls++;if(calls===1){await gate;return [{pid:100,parent:0,created:'p'}];}return [];
 }});
 watcher.start(100);await new Promise(resolve=>setTimeout(resolve,30));
 const finished=watcher.finish({exited:true});release();
 assert.equal((await finished).quiescent,true);assert.equal(calls,2,'one in-flight observation and one final check');
});
test('independent rejection is forwarded to the next round without changing acceptance commands',async t=>{
 const f=setup(t);f.mode('review-redo');const out=await autopilot(f.root,{max_steps:7});
 assert.equal(out.phase,'EXECUTING');assert.equal(f.state().iteration,2);
 const brief=read(path.join(f.control,'tasks',f.brief.task_id,'brief-2.json'));assert.deepEqual(brief.acceptance_commands,f.brief.acceptance_commands);
 assert.ok(brief.lead_feedback.some(x=>x.file==='a.txt'&&x.comment.includes('AC1')));
});
test('independent reviewer decision stops for the lead',async t=>{
 const f=setup(t),cli=process.env.HF_CODEX_BIN;
 fs.writeFileSync(cli,fs.readFileSync(cli,'utf8').replace("console.log(JSON.stringify(finish(request,null)));","const r=finish(request,null);r.recommended_verdict='decision';r.blocking_criteria=['choose design'];console.log(JSON.stringify(r));"));
 const out=await autopilot(f.root);assert.equal(out.phase,'DECISION_REQUIRED');assert.equal(f.state().iteration,1);
});
test('failed reviewer with proven shutdown is replaced within the existing cap',async t=>{
 const f=setup(t);f.mode('codex-crash');const out=await autopilot(f.root);
 assert.equal(out.phase,'VERIFY');assert.equal(f.state().review_runs[1],2);assert.deepEqual(f.state().review_failed[1],['sol']);assert.equal(f.state().reviews.at(-1).reviewed_by,'sonnet');
});
test('repeated reviewer failure stops at the controller cap without a pending launch',async t=>{
 const f=setup(t),s=f.state();s.configuration.review.reviewers=['sol','luna'];atomic(path.join(f.control,'state.json'),s);f.mode('codex-crash');
 const out=await autopilot(f.root);assert.equal(out.phase,'REVIEW');assert.equal(f.state().review_runs[1],2);assert.equal(f.state().open_consult,null);assert.match(out.error.message,/cap/);
});
test('ignored executable input changes stop before delegated review',async t=>{
 const f=fixture(t,{initialize:false});fs.writeFileSync(path.join(f.root,'.gitignore'),'.env\nnode_modules/\n');f.git('add','.gitignore');f.git('commit','-m','ignore');
 const cli=process.env.HF_GROK_BIN;
 fs.writeFileSync(cli,fs.readFileSync(cli,'utf8').replace('PLANT[mode]?.();',"if(mode==='ignored'){fs.mkdirSync('node_modules/dep',{recursive:true});fs.writeFileSync('node_modules/dep/index.js','changed');}else PLANT[mode]?.();"));
 f.brief.acceptance_commands=['node -e "process.exit(0)"'];run(f.root,'init',{...f.brief,executor:'grok'});f.mode('ignored');
 const out=await autopilot(f.root);assert.equal(out.reason,'AUTOPILOT_ACCEPTANCE_UNVERIFIED');assert.equal(f.state().acceptance.status,'skipped');assert.equal(f.state().open_consult,undefined);
});
test('stale passing acceptance evidence is not forwarded to another reviewer',async t=>{
 const f=setup(t);f.begin({acceptance_commands:f.brief.acceptance_commands});await f.bridge();fs.writeFileSync(path.join(f.root,'a.txt'),'later edit');
 const out=await autopilot(f.root);assert.equal(out.reason,'AUTOPILOT_ACCEPTANCE_UNVERIFIED');assert.equal(f.state().open_consult,undefined);
});
test('reported cost cap prevents a delegated review launch',async t=>{
 const f=setup(t,{limits:{max_cost_usd:0.001}});const out=await autopilot(f.root);
 assert.equal(out.reason,'BUDGET_EXCEEDED');assert.equal(f.state().review_runs,undefined);assert.equal(f.state().writer,null);
});
