import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {execute,consult} from '../scripts/executor-bridge.mjs';
import {recordCompletion,revalidateProcesses,operationName,takeReconciliation,controllerDigest} from '../scripts/reconciliation.mjs';

const GRANT={policy:'settle-complete',reason:'Explicitly settle already completed evidence after interruption'};
const dir=f=>path.join(f.control,'tasks',f.brief.task_id);
const put=(f,name,value)=>fs.writeFileSync(path.join(dir(f),name),JSON.stringify(value));
const state=(f,value)=>fs.writeFileSync(path.join(f.control,'state.json'),JSON.stringify(value));
const setup=t=>{
 const f=fixture(t,{initialize:false});
 run(f.root,'init',{...f.brief,executor:'grok',reconciliation:GRANT});f.begin();return f;
};
const expected=p=>Object.fromEntries(['task_id','round','action','consult_id','identity'].filter(k=>p[k]!==undefined).map(k=>[k,p[k]]));
function completed(f){
 const at=new Date().toISOString();
 put(f,'launch-1.json',{executor:'grok',at});
 put(f,'process-1.json',{executor:'grok',pid:987654321});
 put(f,'envelope-1.json',{executor:'grok',exit:{code:0},started_at:at,ended_at:at});
 put(f,'quiescence-1.json',{executor:'grok',quiescent:true,checked_at:at,identities:[]});
 put(f,'result-1.json',f.result());put(f,'session-1.json',{executor:'grok',session_id:f.state().sessions.grok});
 recordCompletion(f.root,dir(f),'1',{task_id:f.brief.task_id,round:1,executor:'grok',controller_digest:controllerDigest(f.state())},['launch','process','envelope','quiescence','dispatch','brief','base','result','session'].map(k=>`${k}-1.json`));
}

test('init grant rejects unknown policies, empty reasons and automatic resume',()=>{
 for(const reconciliation of [null,{}, {policy:'always',reason:'x'}, {policy:'settle-complete',reason:''},{...GRANT,auto_resume:true}])assert.throws(()=>takeReconciliation({reconciliation}),/RECONCILIATION_GRANT/);
 const input={reconciliation:GRANT},grant=takeReconciliation(input);
 assert.equal(grant.auto_resume,false);assert.equal(grant.revision,1);assert.equal(input.reconciliation,undefined);
});

test('old tasks remain inspectable and cannot acquire reconciliation authority later',async t=>{
 const f=fixture(t);assert.equal((await run(f.root,'reconcile')).reason_codes[0],'RECONCILIATION_NOT_GRANTED');
 assert.throws(()=>f.begin({reconciliation:GRANT}),/only be granted at init/);
 const s=f.state();s.schema_version=1;state(f,s);
 assert.equal((await run(f.root,'reconcile')).reason_codes[0],'LEGACY_STATE');
});

test('dispatch-only and partial-result interruptions stop without launching or consuming attempts',async t=>{
 const f=setup(t),before=f.state();
 assert.equal((await run(f.root,'reconcile')).reason_codes[0],'DISPATCH_OUTCOME_UNCERTAIN');
 put(f,'launch-1.json',{executor:'grok'});put(f,'result-1.json',f.result());
 assert.equal((await run(f.root,'reconcile')).reason_codes[0],'COMPLETION_EVIDENCE_MISSING');
 assert.deepEqual(f.state(),before);assert.equal(fs.existsSync(path.join(dir(f),'process-1.json')),false);
});

test('read-only plans preserve evidence, detect source drift and artifact edits',async t=>{
 const f=setup(t);completed(f);
 const before=fs.readdirSync(dir(f)),p=await run(f.root,'reconcile');
 assert.equal(p.status,'READY_FOR_REVALIDATION');assert.equal(p.proofs,undefined);
 assert.deepEqual(await run(f.root,'reconcile'),p);assert.deepEqual(fs.readdirSync(dir(f)),before);
 fs.writeFileSync(path.join(f.root,'a.txt'),'user edit');
 assert.equal((await run(f.root,'reconcile')).reason_codes[0],'TREE_CHANGED_AFTER_COMPLETION');
});

test('changed evidence and partial finish records never authorize another settlement',async t=>{
 const f=setup(t);completed(f);
 put(f,'result-1.json',{...f.result(),summary:'changed'});
 assert.equal((await run(f.root,'reconcile')).reason_codes[0],'COMPLETION_EVIDENCE_CHANGED');
});

test('existing partial settlement, acceptance recovery and grant mismatch all stop',async t=>{
 const f=setup(t);completed(f);put(f,'raw-result-1.json',f.result());
 assert.equal((await run(f.root,'reconcile')).reason_codes[0],'PARTIAL_SETTLEMENT');
 fs.writeFileSync(path.join(f.control,'locks/acceptance.json'),'{}');
 assert.equal((await run(f.root,'reconcile')).reason_codes[0],'ACCEPTANCE_RECOVERY_PENDING');
 put(f,'reconciliation-grant.json',{...f.state().reconciliation,revision:2});
 assert.equal((await run(f.root,'reconcile')).reason_codes[0],'RECONCILIATION_NOT_GRANTED');
});

test('changed controller budgets or review context cannot reuse completed evidence',async t=>{
 const f=setup(t);completed(f);const s=f.state();s.limits={max_wall_ms:12345};state(f,s);
 assert.deepEqual((await run(f.root,'reconcile')).reason_codes,['CONTROLLER_STATE_CHANGED']);
});

test('completion from another host cannot be validated by local process inventory',async t=>{
 const f=setup(t);completed(f);
 const receipt=JSON.parse(fs.readFileSync(path.join(dir(f),'completion-1.json')));
 put(f,'completion-1.json',{...receipt,host:receipt.host+'-another-host'});
 assert.deepEqual((await run(f.root,'reconcile')).reason_codes,['PROCESS_HOST_MISMATCH']);
});

test('process revalidation stops for live identities and unknown inventory without killing anything',async()=>{
 const plan={proofs:[{process:{pid:7},envelope:{started_at:'2026-01-01T00:00:00Z'},proof:{identities:[{pid:8,created:'child'}]}}]};
 await assert.rejects(()=>revalidateProcesses(plan,async()=>[{pid:8,parent:1,created:'child'}]),e=>e.code==='PROCESS_STILL_PRESENT');
 await assert.rejects(()=>revalidateProcesses(plan,async()=>{throw Error('inventory failed');}),e=>e.code==='PROCESS_INVENTORY_UNAVAILABLE');
 await revalidateProcesses(plan,async()=>[]);
 assert.throws(()=>operationName({round:1,action:'finish',identity:'a'.repeat(64),consult_id:'../../escape'}),/EXPECTED_OPERATION_REQUIRED/);
});

test('explicit apply uses finish once, retains attempts and returns the same receipt on repeat',async t=>{
 const f=setup(t);completed(f);const attempts=f.state().attempts;
 const p=await run(f.root,'reconcile'),input={apply:true,expected:expected(p)};
 const settled=await run(f.root,'reconcile',input);
 assert.equal(settled.status,'SETTLED');assert.equal(f.state().phase,'REVIEW');assert.equal(f.state().writer,null);
 assert.deepEqual(f.state().attempts,attempts);
 const before=fs.readFileSync(path.join(f.control,'state.json'),'utf8');
 assert.deepEqual(await run(f.root,'reconcile',input),settled);
 assert.equal(fs.readFileSync(path.join(f.control,'state.json'),'utf8'),before);
});

test('a persisted intent with uncertain outcome is never replayed',async t=>{
 const f=setup(t);completed(f);const p=await run(f.root,'reconcile'),e=expected(p);
 put(f,operationName(e),{revision:1,task_id:e.task_id,round:e.round,intended_action:e.action,identity:e.identity,status:'intended'});
 const out=await run(f.root,'reconcile',{apply:true,expected:e});
 assert.deepEqual(out.reason_codes,['OPERATION_OUTCOME_UNCERTAIN']);
 assert.equal(fs.existsSync(path.join(dir(f),'raw-result-1.json')),false);assert.equal(f.state().phase,'EXECUTING');
});

test('bridge completion receipts support real fake-CLI finish and review settlement without relaunch',async t=>{
 const f=setup(t);f.mode('edit');
 const result=await execute(f.root,{proveQuiescence:true});assert.equal(result.quiescence.quiescent,true);
 let p=await run(f.root,'reconcile');assert.equal(p.status,'READY_FOR_REVALIDATION',JSON.stringify(p));
 assert.equal((await run(f.root,'reconcile',{apply:true,expected:expected(p)})).phase,'REVIEW');
 f.mode('ok');const review=run(f.root,'delegate-review',{executors:['sol']});
 const out=await consult(f.root,review.consult_id,{proveQuiescence:true});assert.ok(out.members.every(m=>m.ok&&m.quiescence.quiescent));
 p=await run(f.root,'reconcile');assert.equal(p.action,'consult-finish',JSON.stringify(p));
 const input={apply:true,expected:expected(p)},settled=await run(f.root,'reconcile',input);
 assert.equal(settled.phase,'VERIFY');assert.equal(f.state().open_consult,null);
 assert.deepEqual(await run(f.root,'reconcile',input),settled);
 assert.equal(f.state().attempts.grok,1);assert.equal(f.state().phase,'VERIFY','reconciliation never verifies or CLOSEs');
 const command="if(require('fs').readFileSync('a.txt','utf8')!=='fixed')process.exit(1)";
 const check=spawnSync(process.execPath,['-e',command],{cwd:f.root,windowsHide:true});assert.equal(check.status,0);
 run(f.root,'verify',{acceptance_satisfied:true,tests:[{command:'node -e '+command,status:'pass'}]});
 assert.equal(f.state().phase,'CLOSE');
 const before=fs.readFileSync(path.join(f.control,'state.json'),'utf8');
 assert.deepEqual((await run(f.root,'reconcile')).reason_codes,['NO_SETTLEMENT_ACTION']);
 assert.equal(fs.readFileSync(path.join(f.control,'state.json'),'utf8'),before);
});

test('a controller crash after persisting raw result leaves an uncertain receipt and cannot repeat finish',async t=>{
 const f=setup(t);completed(f);const p=await run(f.root,'reconcile'),input={apply:true,expected:expected(p)};
 const module=new URL('../scripts/fusion-state.mjs',import.meta.url).href;
 const code=`import fs from 'node:fs';import {run} from ${JSON.stringify(module)};const write=fs.writeFileSync;fs.writeFileSync=function(file,...args){const out=write.call(this,file,...args);if(String(file).endsWith('raw-result-1.json'))process.exit(77);return out;};await run(process.argv[1],'reconcile',JSON.parse(process.argv[2]));`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',code,f.root,JSON.stringify(input)],{encoding:'utf8',timeout:60000,windowsHide:true});
 assert.equal(child.status,77,child.stderr);
 assert.deepEqual((await run(f.root,'reconcile',input)).reason_codes,['OPERATION_OUTCOME_UNCERTAIN']);
 assert.equal(f.state().attempts.grok,1);assert.ok(f.state().writer);
});

test('a crash after finish saves its phase cannot replay acceptance or release the lease twice',async t=>{
 const f=setup(t);completed(f);const p=await run(f.root,'reconcile'),input={apply:true,expected:expected(p)};
 const module=new URL('../scripts/fusion-state.mjs',import.meta.url).href;
 const code=`import fs from 'node:fs';import {run} from ${JSON.stringify(module)};const rename=fs.renameSync;fs.renameSync=function(from,to){const out=rename.call(this,from,to);if(String(to).endsWith('state.json')&&JSON.parse(fs.readFileSync(to)).phase==='REVIEW')process.exit(77);return out;};await run(process.argv[1],'reconcile',JSON.parse(process.argv[2]));`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',code,f.root,JSON.stringify(input)],{encoding:'utf8',timeout:60000,windowsHide:true});
 assert.equal(child.status,77,child.stderr);assert.equal(f.state().phase,'REVIEW');
 const before=fs.readFileSync(path.join(f.control,'state.json'),'utf8');
 assert.deepEqual((await run(f.root,'reconcile',input)).reason_codes,['OPERATION_OUTCOME_UNCERTAIN']);
 assert.equal(fs.readFileSync(path.join(f.control,'state.json'),'utf8'),before);
});
