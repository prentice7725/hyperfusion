import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {setImmediate as turn} from 'node:timers/promises';
import {readOnlyPlan,settledSlots,workManifest} from '../scripts/read-only-plan.mjs';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {consult} from '../scripts/executor-bridge.mjs';
import {read} from '../scripts/artifact.mjs';
import {controlPath,acquireLock} from '../scripts/control-dir.mjs';
import {validateWorkflow,workflowDigest} from '../scripts/workflow-plan.mjs';
import {createWorktree} from '../scripts/worktree.mjs';
import * as project from '../scripts/project.mjs';

const jobs=executors=>executors.map((executor,i)=>({id:'read'+i,executor,paths:['a.txt'],focus:['Inspect concern '+i]}));
const setup=(t,{slots=2,executors=['sonnet','grok','antigravity'],limits={max_wall_ms:600000}}={})=>{
 const f=fixture(t,{initialize:false});run(f.root,'init',{...f.brief,limits,read_only:{slots,subtasks:jobs(executors)}});return f;
};
const ask=f=>run(f.root,'consult',{mode:'committee',question:'Inspect the approved concerns without changing files',subtasks:jobs(['sonnet','grok','antigravity']).map(t=>t.id)});
const dir=f=>path.join(f.control,'tasks',f.brief.task_id);
const launches=f=>fs.readdirSync(dir(f)).filter(n=>/^launch-consult-/.test(n));

test('pilot slot limits and approved scope/focus are validated without widening paths',()=>{
 assert.equal(readOnlyPlan(undefined,{paths:['src']}),null);
 const valid={slots:2,subtasks:[{id:'A',executor:'sonnet',paths:['src/api'],focus:['inspect interfaces']}]};
 assert.deepEqual(readOnlyPlan(valid,{paths:['src']}).subtasks,valid.subtasks);
 for(const slots of [0,3,-1,'2',2.5])assert.throws(()=>readOnlyPlan({...valid,slots},{paths:['src']}),/slots/);
 for(const extra of [{paths:['other']},{paths:['../src']},{focus:[]},{executor:'unknown'},{workspace:'other'}])assert.throws(()=>readOnlyPlan({...valid,subtasks:[{...valid.subtasks[0],...extra}]},{paths:['src']}));
 assert.throws(()=>readOnlyPlan({...valid,subtasks:[valid.subtasks[0],valid.subtasks[0]]},{paths:['src']}),/unique/);
});
test('one or two slots bound peak activity and preserve input result order',async()=>{
 for(const slots of [1,2]){
  let active=0,peak=0;const runs=await settledSlots([0,1,2,3],slots,async n=>{active++;peak=Math.max(active,peak);await turn();active--;return n;});
  assert.equal(peak,slots);assert.equal(active,0);assert.deepEqual(runs.map(r=>r.value),[0,1,2,3]);
 }
});
test('a proven-stopped failure retains successful siblings and continues bounded queued work',async()=>{
 const runs=await settledSlots([0,1,2],1,async n=>{if(n===1)throw Object.assign(Error('invocation failed'),{quiescence:{quiescent:true}});return n;},{stopOn:e=>e.quiescence?.quiescent!==true});
 assert.deepEqual(runs.map(r=>r.status),['fulfilled','rejected','fulfilled']);assert.equal(runs[0].value,0);assert.equal(runs[2].value,2);
});
test('uncertain shutdown prevents queued launches while preserving an in-flight sibling',async()=>{
 const started=[];const runs=await settledSlots([0,1,2,3],2,async n=>{started.push(n);if(n===0)throw Object.assign(Error('unknown shutdown'),{quiescence:{quiescent:false}});await turn();return n;},{stopOn:e=>e.quiescence?.quiescent!==true});
 assert.deepEqual(started,[0,1]);assert.equal(runs[1].value,1);assert.match(runs[2].reason.message,/QUEUE_STOPPED/);assert.equal(runs[3].status,'rejected');
});
test('mandatory review focus manifests retain the full approved scope and shared evidence',()=>{
 const m=workManifest({mode:'review',member:'m1',scope:{paths:['api','client']},focus:['api'],digest:'digest'});
 assert.deepEqual(m.paths,['api','client']);assert.match(m.shared_evidence,/all cumulative/);assert.equal(m.kind,'mandatory-review');assert.deepEqual(m.allowed_actions,['read']);
});
test('read-only subtask definitions participate in the frozen project graph digest',()=>{
 const task={id:'A',title:'A',kind:'code',depends_on:[],scope:{paths:['a.txt']},success_criteria:['AC1'],acceptance_commands:['node --version'],acceptance_map:{AC1:['node --version']},limits:{max_wall_ms:10000},read_only:{slots:1,subtasks:jobs(['sonnet'])}};
 const plan={milestones:[{id:'M1',tasks:[task]}]};delete task.depends_on;assert.ok(validateWorkflow(plan),'read_only alone opts project tasks into a frozen workflow');const original=workflowDigest(plan);
 task.read_only.slots=2;assert.notEqual(workflowDigest(plan),original);
 plan.team=[{member:'grok'}];assert.throws(()=>validateWorkflow(plan),/approved team/);delete plan.team;
 task.read_only.subtasks[0].paths=['other'];assert.throws(()=>validateWorkflow(plan),/approved scope/);
});
test('additional reads require init authorization and cannot be added later or selected ad hoc',t=>{
 const f=fixture(t);assert.throws(()=>run(f.root,'consult',{mode:'committee',question:'inspect',subtasks:['unapproved']}),/unapproved/);
 assert.throws(()=>f.begin({read_only:{slots:1}}),/fixed at init/);
 const g=fixture(t,{initialize:false});assert.throws(()=>run(g.root,'init',{...g.brief,read_only:{subtasks:jobs(['sonnet'])}}),/wall-time limit/);
});
test('legacy project tasks cannot enable an excluded reader through inherited base review settings',t=>{
 const f=fixture(t,{initialize:false});fs.writeFileSync(path.join(f.root,'plan.md'),'approved legacy team');
 project.propose(f.root,{name:'legacy',summary:'one approved implementer',sources:['plan.md'],team:[{member:'grok',role:'implement',owns:['code'],why:'approved'}],excluded:project.MEMBERS.filter(m=>m!=='grok').map(member=>({member,why:'excluded'})),review:{by:'lead'},milestones:[{id:'M1',title:'work',goal:'finish',checkpoint:['review'],tasks:[{id:'node',title:'node',kind:'code'}]}]});
 project.approve(f.root,{user_message:'approve this team'});
 assert.throws(()=>run(f.root,'init',{...f.brief,task_id:'node',limits:{max_wall_ms:600000},read_only:{subtasks:jobs(['sol'])}}),/approved project team/);
 assert.equal(project.loadProject(f.root).milestones[0].tasks[0].status,'planned');assert.equal(fs.existsSync(controlPath(f.root,'state.json')),false);
});
test('three approved reads use bounded slots, retain a failed sibling, and consume reservations once',async t=>{
 const f=setup(t);const c=ask(f);f.mode('always-fail');
 const result=await consult(f.root,c.consult_id);assert.equal(result.members.filter(m=>m.ok).length,2);assert.equal(launches(f).length,3);
 const events=c.members.flatMap(m=>{const e=read(path.join(dir(f),`envelope-consult-c1-${m.member}.json`));return [[Date.parse(e.started_at),1],[Date.parse(e.ended_at),-1]];}).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
 let active=0,peak=0;for(const [,delta] of events){active+=delta;peak=Math.max(peak,active);}assert.ok(peak<=2,'actual transport envelopes exceed the configured two slots');assert.equal(active,0);
 const meta=read(path.join(dir(f),'consult-c1.json'));assert.equal(meta.execution.slots,2);
 for(const m of c.members){const b=JSON.parse(read(path.join(dir(f),`consult-c1-${m.member}.json`)).prompt).brief;assert.deepEqual(b.scope.paths,['a.txt']);assert.equal(b.consult.work_manifest.subtask_id,'read'+(Number(m.member.slice(1))-1));}
 const proofFile=path.join(dir(f),'quiescence-consult-c1-m1.json'),proof=fs.readFileSync(proofFile,'utf8');
 fs.writeFileSync(proofFile,JSON.stringify({quiescent:false}));assert.throws(()=>run(f.root,'consult-finish',{quiescent:true}),/SHUTDOWN_UNPROVEN/);assert.ok(f.state().open_consult);assert.throws(()=>f.begin(),/in progress/);fs.writeFileSync(proofFile,proof);
 const settled=run(f.root,'consult-finish',{quiescent:true});assert.equal(settled.results.length,2);assert.equal(f.state().consult_runs,3);
 assert.throws(()=>ask(f),/already reserved/);assert.equal(launches(f).length,3);
});
test('writer, acceptance and source drift checks prevent every conflicting invocation',async t=>{
 const f=setup(t);ask(f);const writer=controlPath(f.root,'locks/writer.json'),acceptance=controlPath(f.root,'locks/acceptance.json');
 fs.writeFileSync(writer,'{}');assert.ok((await consult(f.root,'c1')).members.every(m=>!m.ok));assert.equal(launches(f).length,0);fs.unlinkSync(writer);
 fs.writeFileSync(acceptance,'{}');assert.ok((await consult(f.root,'c1')).members.every(m=>!m.ok));assert.equal(launches(f).length,0);fs.unlinkSync(acceptance);
 const unlock=acquireLock(controlPath(f.root,'locks/consult-execution.lock'));
 try{assert.throws(()=>run(f.root,'consult-finish',{quiescent:true}),/consult-execution.lock.*held/);assert.ok(f.state().open_consult);assert.equal(launches(f).length,0);}finally{unlock();}
 fs.writeFileSync(path.join(f.root,'a.txt'),'drift');assert.ok((await consult(f.root,'c1')).members.every(m=>!m.ok));assert.equal(launches(f).length,0);
 assert.equal(fs.existsSync(controlPath(f.root,'locks/consult-execution.lock')),false);
});
test('tampering with a dispatched focus manifest/shared evidence launches no reader',async t=>{
 const f=setup(t);ask(f);const file=path.join(dir(f),'consult-c1-m1.json'),request=read(file),prompt=JSON.parse(request.prompt);
 prompt.brief.consult.context.changed_files=[];prompt.brief.consult.work_manifest.paths=['other'];request.prompt=JSON.stringify(prompt);fs.writeFileSync(file,JSON.stringify(request));
 const out=await consult(f.root,'c1');assert.match(out.members[0].error,/DISPATCH_TAMPERED/);assert.equal(out.members[0].ok,false);
 assert.equal(fs.existsSync(path.join(dir(f),'launch-consult-c1-m1.json')),false);
});
test('queued reads recheck observed task cost and never reset consumed consultation budgets',async t=>{
 const f=setup(t,{slots:1,executors:['grok','grok','grok'],limits:{max_wall_ms:600000,max_cost_usd:1}});
 const helper=process.env.HF_GROK_BIN,script=fs.readFileSync(helper,'utf8');
 const usage=path.join(dir(f),'usage-observed-cost.json');
 fs.writeFileSync(helper,script.replace('const args=process.argv.slice(2);',`const args=process.argv.slice(2);if(!args.includes('--version')&&!args.includes('--help'))fs.writeFileSync(${JSON.stringify(usage)},JSON.stringify({total_cost_usd:2}));`));
 ask(f);const out=await consult(f.root,'c1');assert.equal(out.members[0].ok,true);assert.equal(out.members[1].ok,false);assert.match(out.members[1].error,/BUDGET_EXCEEDED/);assert.equal(launches(f).length,1);assert.equal(f.state().consult_runs,3);
});
test('serialized mandatory reviewers keep common evidence and a successful seat cannot replace a failed seat',async t=>{
 const f=fixture(t,{initialize:false});f.brief.scope.paths=['a.txt','b.txt'];fs.writeFileSync(path.join(f.root,'b.txt'),'base');
 fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({review:{by:'delegate',strategy:'lead-gated-adaptive'}}));
 run(f.root,'init',{...f.brief,executor:'grok',task_criticality:'important',assignment_reason:'mandatory pair',read_only:{slots:1}});
 f.begin();fs.writeFileSync(path.join(f.root,'a.txt'),'a changed');fs.writeFileSync(path.join(f.root,'b.txt'),'b changed');f.finish(f.result(['a.txt','b.txt']));
 const c=run(f.root,'delegate-review',{});assert.equal(c.members.length,2);f.mode('reviewer-fail-once');const out=await consult(f.root,c.consult_id);
 assert.equal(out.members.filter(m=>m.ok).length,1);
 const briefs=c.members.map(m=>JSON.parse(read(path.join(dir(f),`consult-${c.consult_id}-${m.member}.json`)).prompt).brief);
 for(const b of briefs){assert.deepEqual(b.consult.work_manifest.paths,['a.txt','b.txt']);assert.deepEqual(b.consult.context.changed_files,['a.txt','b.txt']);}
 assert.equal(briefs[0].consult.work_manifest.digest,briefs[1].consult.work_manifest.digest);
 const envelopes=c.members.map(m=>read(path.join(dir(f),`envelope-consult-${c.consult_id}-${m.member}.json`)));
 assert.ok(Date.parse(envelopes[1].started_at)>=Date.parse(envelopes[0].ended_at),'one-slot review invocations overlapped');
 const settled=run(f.root,'consult-finish',{quiescent:true});assert.equal(settled.phase,'LEAD_DECISION_REQUIRED');assert.equal(settled.results.length,1);assert.equal(f.state().review_results[1].length,2);
 assert.equal(run(f.root,'diagnose').eligible,false);
});
test('an explicitly selected independent worktree may read while the source workspace has a writer',async t=>{
 const f=fixture(t),child=createWorktree(f.root,'independent-read');
 f.begin();fs.writeFileSync(path.join(f.root,'a.txt'),'source writer change');
 run(child.workspace,'init',{...f.brief,task_id:'independent-read',read_only:{slots:1}});
 const c=run(child.workspace,'consult',{mode:'advisor',question:'Inspect this explicit isolated workspace',executors:['sonnet']});
 const result=await consult(child.workspace,c.consult_id);assert.equal(result.members[0].ok,true);
 assert.equal(run(child.workspace,'consult-finish',{quiescent:true}).violated,false);
 assert.equal(fs.readFileSync(path.join(child.workspace,'a.txt'),'utf8'),'base');
 assert.equal(fs.existsSync(controlPath(f.root,'locks/writer.json')),true);f.finish(f.result(['a.txt']));
});
