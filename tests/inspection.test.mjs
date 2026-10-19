import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {gateCollector} from '../scripts/gate-diagnostics.mjs';
import {errorRecord} from '../scripts/cli.mjs';

const save=(f,s)=>fs.writeFileSync(path.join(f.control,'state.json'),JSON.stringify(s));
const task=(f,name)=>path.join(f.control,'tasks',f.brief.task_id,name);
const contents=dir=>Object.fromEntries(fs.readdirSync(dir,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()).map(e=>{
 const file=path.join(e.parentPath??e.path,e.name);return [path.relative(dir,file),fs.readFileSync(file).toString('base64')];
}));

test('inspection is repeatable, read-only and omits prompts and lease tokens',t=>{
 const f=fixture(t);f.begin();
 const before=contents(f.control),attempts=f.state().attempts;
 const packet=run(f.root,'resume');
 assert.deepEqual(run(f.root,'resume'),packet);
 assert.deepEqual(contents(f.control),before);
 assert.deepEqual(packet.budgets.attempts,attempts);
 assert.equal(packet.auto_resume,false);
 assert.ok(packet.reason_codes.includes('DISPATCH_OUTCOME_UNCERTAIN'));
 assert.ok(packet.reason_codes.includes('PROCESS_SHUTDOWN_UNVERIFIED'));
 assert.ok(!JSON.stringify(packet).includes(f.state().writer.token));
 assert.ok(!JSON.stringify(packet).includes(f.brief.objective));
 assert.ok(JSON.stringify(packet).length<10000);
});

test('existing launch, consultation and acceptance marker never get replay instructions or mutation',t=>{
 const f=fixture(t);f.begin();
 fs.writeFileSync(task(f,'launch-1.json'),'{}');
 const s=f.state();s.open_consult={id:'prior-review'};save(f,s);
 fs.writeFileSync(path.join(f.control,'locks/acceptance.json'),'{"broken":true}');
 fs.writeFileSync(path.join(f.control,'locks/control.lock'),'do not steal');
 const before=contents(f.control),p=run(f.root,'resume');
 for(const code of ['EXISTING_LAUNCH','EXISTING_CONSULT','ACCEPTANCE_PENDING','CONTROLLER_LOCK_PRESENT'])assert.ok(p.reason_codes.includes(code),code);
 assert.match(p.next_action,/Do not replay/);
 assert.deepEqual(contents(f.control),before);
});

test('legacy state is inspectable and corrupt evidence stays explicit',t=>{
 const f=fixture(t);const s=f.state();s.schema_version=1;save(f,s);
 fs.writeFileSync(task(f,'initial-brief.json'),'broken');
 const p=run(f.root,'resume');
 assert.ok(p.reason_codes.includes('LEGACY_STATE'));
 assert.ok(p.reason_codes.includes('ARTIFACT_INVALID'));
 assert.equal(p.artifacts['initial-brief.json'].status,'invalid');
 assert.deepEqual(run(f.root,'diagnose').reason_codes,['LEGACY_STATE']);
});

test('missing grant diagnosis uses the controller policy and leaves all records unchanged',t=>{
 const f=fixture(t);const before=contents(f.control);
 const d=run(f.root,'diagnose');
 assert.equal(d.eligible,false);assert.deepEqual(d.reason_codes,['DELEGATION_MISSING']);
 assert.deepEqual(d.unmet,['no discretion was granted at init']);
 assert.equal(d.lead_required,true);assert.equal(d.policy_revision,null);
 assert.deepEqual(contents(f.control),before);
});

test('diagnosis reports invalid policy evidence without hiding the underlying error',t=>{
 const f=fixture(t),s=f.state();s.delegation={policy:'standard-auto'};save(f,s);
 fs.writeFileSync(task(f,'delegation.json'),'not json');
 const d=run(f.root,'diagnose');
 assert.equal(d.eligible,false);assert.deepEqual(d.reason_codes,['DIAGNOSTIC_ERROR']);
 assert.match(d.error.message,/INSPECTION_ARTIFACT_INVALID/);
});

test('full controller evaluation exposes independent stop codes and preserves frozen attempts',t=>{
 const f=fixture(t,{initialize:false});
 fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({review:{strategy:'lead-gated-adaptive'}}));
 run(f.root,'init',f.brief);f.begin();
 const s=f.state();
 // Simulate an interrupted task's incomplete evidence, without running a model.
 s.delegation={policy:'standard-auto',revision:1,max_rounds:0,reason:'fixture',granted_by:'lead-at-init',set_by:'controller'};
 s.limits={max_wall_ms:1};s.started_at='2000-01-01T00:00:00.000Z';
 save(f,s);fs.writeFileSync(task(f,'delegation.json'),JSON.stringify(s.delegation));
 const before=contents(f.control),d=run(f.root,'diagnose');
 assert.ok(!d.error,JSON.stringify(d));
 for(const code of ['ROUND_LIMIT_EXHAUSTED','WRITER_PRESENT','TREE_DIGEST_STALE','BUDGET_EXHAUSTED','MANDATORY_REVIEW_MISSING','WORKER_RESULT_INCOMPLETE','BASELINE_NOT_RED','ACCEPTANCE_SHUTDOWN_UNPROVEN','AC_MAPPING_INCOMPLETE'])assert.ok(d.reason_codes.includes(code),`${code}: ${JSON.stringify(d)}`);
 assert.equal(d.policy_revision,1);
 assert.deepEqual(contents(f.control),before);
});

test('uninitialized inspection never creates control state',t=>{
 const f=fixture(t,{initialize:false});
 assert.throws(()=>run(f.root,'resume'),/INSPECTION_STATE_INVALID/);
 assert.throws(()=>run(f.root,'diagnose'),/INSPECTION_STATE_INVALID/);
 assert.equal(fs.existsSync(f.control),false);
});

test('structured checks preserve prose, unknown codes and CLI diagnostic evidence',()=>{
 const g=gateCollector({task_id:'task',iteration:2,post_digest:'digest',delegation:{policy:'standard-auto',revision:1}});
 g.need(true,'PASS','present evidence','missing evidence');
 g.need(false,'FUTURE_UNKNOWN_REASON','new evidence','new failure');
 const d=g.result();
 assert.deepEqual(d.passed,['present evidence']);assert.deepEqual(d.unmet,['new failure']);
 assert.deepEqual(d.reason_codes,['FUTURE_UNKNOWN_REASON']);assert.equal(d.round,2);
 assert.deepEqual(errorRecord(Object.assign(Error('refused'),{diagnostic:d})).diagnostic,d);
});
