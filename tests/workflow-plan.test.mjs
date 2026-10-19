import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import * as project from '../scripts/project.mjs';
import {validateWorkflow,workflowDefinition} from '../scripts/workflow-plan.mjs';
import {createWorktree} from '../scripts/worktree.mjs';
import {controlPath,acquireLock,ensureControl} from '../scripts/control-dir.mjs';
import {read} from '../scripts/artifact.mjs';

const check=`node -e "if(require('fs').readFileSync('a.txt','utf8')==='base')process.exit(1)"`;
const task=(id,depends_on=[],extra={})=>({id,title:id,kind:'code',difficulty:'low',depends_on,scope:{paths:['a.txt']},success_criteria:['AC1'],acceptance_commands:[check],acceptance_map:{AC1:[check]},limits:{max_wall_ms:600000},...extra});
const graph=tasks=>({milestones:[{id:'M1',tasks}]});
const setup=(t,list,extraMilestones=[])=>{
 const f=fixture(t,{initialize:false});fs.writeFileSync(path.join(f.root,'plan.md'),'Static workflow');
 const p={name:'workflow',summary:'bounded graph',sources:['plan.md'],team:[{member:'grok',role:'implement',why:'fixture',owns:['code']}],excluded:project.MEMBERS.filter(m=>m!=='grok').map(member=>({member,why:'unused'})),review:{by:'lead'},milestones:[{id:'M1',title:'graph',goal:'close',checkpoint:['review results'],tasks:list},...extraMilestones]};
 project.propose(f.root,p);project.approve(f.root,{user_message:'go'});return f;
};
const init=(f,id,extra={})=>{f.brief.task_id=id;return run(f.root,'init',{...f.brief,...extra});};
const close=(f,value)=>{f.begin();if(value!==undefined)fs.writeFileSync(path.join(f.root,'a.txt'),value);f.finish(f.result(value===undefined?[]:['a.txt']));f.git('diff','--','a.txt');f.review('pass');return run(f.root,'verify',{acceptance_satisfied:true,tests:[{command:'review',status:'pass'}]});};

test('read-only child reconciliation does not acquire the parent mutation lock',async t=>{
 const f=fixture(t),parent=path.join(f.temp,'parent');fs.cpSync(f.root,parent,{recursive:true});ensureControl(parent);
 fs.writeFileSync(controlPath(f.root,'workflow-parent.json'),JSON.stringify({source_root:parent,task_id:f.brief.task_id}));
 const unlock=acquireLock(controlPath(parent,'locks/control.lock')),before=fs.readFileSync(controlPath(f.root,'state.json'),'utf8');
 try{
  const result=await run(f.root,'reconcile');assert.equal(result.status,'STOPPED');
  assert.equal(fs.readFileSync(controlPath(f.root,'state.json'),'utf8'),before);
  assert.equal(fs.existsSync(controlPath(parent,'locks/control.lock')),true);
 }finally{unlock();}
});

test('chain and diamond dry-run order is deterministic and serial',()=>{
 const p=graph([task('D',['B','C']),task('C',['A']),task('B',['A']),task('A')]);
 assert.deepEqual(validateWorkflow(p).order,['A','B','C','D']);assert.deepEqual(validateWorkflow(p),validateWorkflow(p));
});
test('graph validation rejects duplicate, missing, self, cyclic and later-milestone edges',()=>{
 for(const list of [[task('A'),task('A')],[task('A',['missing'])],[task('A',['A'])],[task('A',['B']),task('B',['A'])],[task('A',['B','B']),task('B')]])assert.throws(()=>validateWorkflow(graph(list)),/WORKFLOW/);
 assert.throws(()=>validateWorkflow({milestones:[{id:'M1',tasks:[task('A',['B'])]},{id:'M2',tasks:[task('B')]}]}),/later-milestone/);
});
test('static tasks require bounded scope, command-mapped ACs and bounded wall budgets',()=>{
 for(const extra of [{scope:{paths:['../x']}},{acceptance_commands:[]},{acceptance_map:{}},{limits:{}},{limits:{max_wall_ms:86400001}},{workspace:'dynamic'}])assert.throws(()=>validateWorkflow(graph([task('A',[],extra)])));
});
test('integration edges require an isolated child and covering parent scope and commands',()=>{
 assert.ok(validateWorkflow(graph([task('A',[],{workspace:'isolated'}),task('I',[],{integrates:'A'})])));
 for(const extra of [{scope:{paths:['other.txt']}},{acceptance_commands:['node --version'],acceptance_map:{AC1:['node --version']}},{workspace:'isolated'}])assert.throws(()=>validateWorkflow(graph([task('A',[],{workspace:'isolated'}),task('I',[],{integrates:'A',...extra})])),/integration/);
});
test('legacy plans without dependency fields retain their original validation path',()=>{
 assert.equal(validateWorkflow(graph([{id:'A',title:'old',kind:'docs'}])),null);
});
test('frozen graph detects user edits to dependencies, acceptance, scopes and budgets before dispatch',t=>{
 const f=setup(t,[task('A'),task('B',['A'])]);const file=controlPath(f.root,'project.json'),original=read(file);
 assert.deepEqual(project.schedule(f.root).ready,['A']);
 for(const change of [t=>t.depends_on.push('B'),t=>t.limits.max_wall_ms++,t=>t.scope.paths.push('other.txt'),t=>t.acceptance_commands.push('node --version')]){
  const p=structuredClone(original);change(p.milestones[0].tasks[0]);fs.writeFileSync(file,JSON.stringify(p));assert.throws(()=>init(f,'A'),/frozen plan drift/);fs.writeFileSync(file,JSON.stringify(original));
 }
 assert.throws(()=>project.amend(f.root,{drop_tasks:[{id:'A',why:'skip'}]}),/static approved/);
 assert.throws(()=>init(f,'A',{limits:{max_wall_ms:999999}}),/frozen limits/);
 assert.deepEqual(workflowDefinition(read(file)),workflowDefinition(original));
});
test('unreviewed or BLOCKED parents never satisfy a dependency, and only one task can be claimed',t=>{
 const f=setup(t,[task('A'),task('B',['A']),task('C')]);
 assert.throws(()=>init(f,'B'),/DEPENDENCY_UNSATISFIED/);
 init(f,'A');assert.deepEqual(project.schedule(f.root).ready,[]);
 f.begin();fs.writeFileSync(path.join(f.root,'a.txt'),'candidate');f.finish(f.result(['a.txt']));
 assert.throws(()=>init(f,'B'),/IMPLEMENTATION_RUNNING|DEPENDENCY_UNSATISFIED/);
 const p=project.loadProject(f.root);p.milestones[0].tasks[0].status='closed';project.saveProject(f.root,p);
 assert.deepEqual(project.schedule(f.root).ready,[],'unsettled controller state blocks a claim even if project metadata disagrees');
 assert.ok(project.schedule(f.root).tasks.find(t=>t.id==='B').reasons.includes('DEPENDENCY_UNSATISFIED:A'));
 p.milestones[0].tasks[0].status='blocked';project.saveProject(f.root,p);
 assert.ok(project.schedule(f.root).tasks.find(t=>t.id==='B').reasons.includes('DEPENDENCY_UNSATISFIED:A'));
});
test('verified CLOSE unlocks diamond children across reloads; checkpoint acknowledgement still gates milestones',t=>{
 const preserve={acceptance_baseline_green:'Keep the verified parent result while checking graph readiness'};
 const f=setup(t,[task('A'),task('B',['A'],preserve),task('C',['A'],preserve),task('D',['B','C'],preserve)]);
 init(f,'A');assert.equal(close(f,'fixed').phase,'CLOSE');assert.deepEqual(project.schedule(f.root).ready,['B','C']);
 const stale=project.loadProject(f.root);stale.milestones[0].tasks[0].status='active';project.saveProject(f.root,stale);
 assert.deepEqual(project.schedule(f.root).ready,[]);project.sync(f.root,{task_id:'A'});
 assert.deepEqual(project.schedule(f.root).ready,['B','C']);
 init(f,'C');assert.equal(close(f).phase,'CLOSE');assert.deepEqual(project.schedule(f.root).ready,['B']);
 init(f,'B');close(f);assert.deepEqual(project.schedule(f.root).ready,['D']);
 init(f,'D');close(f);assert.deepEqual(project.status(f.root).checkpoint_due,['M1']);
 project.checkpoint(f.root);assert.equal(project.ack(f.root,{milestone:'M1',user_message:'done'}).status,'COMPLETE');
});
test('begin rejects frozen plan drift even after init, without spending a worker attempt',t=>{
 const f=setup(t,[task('A')]);init(f,'A');
 const p=project.loadProject(f.root);p.milestones[0].tasks[0].limits.max_wall_ms++;project.saveProject(f.root,p);
 assert.throws(()=>f.begin(),/frozen plan drift/);assert.equal(f.state().attempts.grok,0);
});
test('workflow claims obey the existing controller lock without writing partial task state',t=>{
 const f=setup(t,[task('A')]),unlock=acquireLock(controlPath(f.root,'locks/control.lock'));
 try{assert.throws(()=>init(f,'A'),/EEXIST|lock/i);assert.equal(fs.existsSync(controlPath(f.root,'state.json')),false);}
 finally{unlock();}
 assert.deepEqual(project.schedule(f.root).ready,['A']);
});
test('a closed dependency cannot bypass the next milestone checkpoint acknowledgement',t=>{
 const f=setup(t,[task('A')],[{id:'M2',title:'next',goal:'continue',checkpoint:['review'],tasks:[task('B',['A'],{acceptance_baseline_green:'Retain the verified parent result'})]}]);
 init(f,'A');close(f,'fixed');assert.deepEqual(project.schedule(f.root).ready,[]);
 assert.throws(()=>init(f,'B'),/PROJECT_CHECKPOINT_PENDING/);project.checkpoint(f.root);
 assert.deepEqual(project.schedule(f.root).ready,[]);project.ack(f.root,{milestone:'M1',user_message:'continue'});
 assert.deepEqual(project.schedule(f.root).ready,['B']);
});
test('isolated CLOSE needs an explicit integration task and parent acceptance before dependents unlock',t=>{
 const f=setup(t,[task('A',[],{workspace:'isolated'}),task('I',[],{integrates:'A'}),task('B',['A'])]);
 // The worktree copies committed source, so retain the same red baseline.
 assert.throws(()=>init(f,'A'),/wrong workspace/);
 const wt=createWorktree(f.root,'A');assert.deepEqual(project.schedule(f.root).ready,[]);
 const root=f.root,originalBrief=f.brief;
 run(wt.workspace,'init',{...f.brief,task_id:'A'});
 const brief=read(controlPath(wt.workspace,'tasks','A','initial-brief.json'));
 const request=run(wt.workspace,'begin',brief);fs.writeFileSync(path.join(wt.workspace,'a.txt'),'isolated');
 const result={task_id:'A',round:1,status:'complete',summary:'isolated change',files_read:['a.txt'],files_changed:['a.txt'],commands_run:[],tests:[],unresolved:[],risks:[],needs_lead_decision:false,recommended_next_action:'review'};
 run(wt.workspace,'finish',{token:request.token,quiescent:true,result});
 run(wt.workspace,'review',{verdict:'pass',rationale:'independent review',commands_run:['git diff'],independent_diff_review:true,findings:[],blocking_criteria:[]});
 run(wt.workspace,'verify',{acceptance_satisfied:true,tests:[{command:'review',status:'pass'}]});
 assert.equal(project.loadProject(root).milestones[0].tasks[0].status,'awaiting_integration');
 assert.deepEqual(project.schedule(root).ready,['I']);
 assert.throws(()=>project.integrate(root,{task_id:'A',integration_task_id:'I',reason:'not yet'}),/CLOSE receipts/);
 f.brief=originalBrief;init(f,'I');close(f,'isolated');
 fs.writeFileSync(path.join(root,'a.txt'),'unreviewed change');
 assert.throws(()=>project.integrate(root,{task_id:'A',integration_task_id:'I',reason:'stale'}),/parent acceptance is stale/);
 assert.deepEqual(project.schedule(root).ready,[]);
 fs.writeFileSync(path.join(root,'a.txt'),'isolated');
 const receipt=project.integrate(root,{task_id:'A',integration_task_id:'I',reason:'reviewed exact integration'});
 assert.equal(receipt.parent_digest,f.state().post_digest);assert.deepEqual(project.schedule(root).ready,['B']);
 assert.deepEqual(project.integrate(root,{task_id:'A',integration_task_id:'I',reason:'reviewed exact integration'}),receipt);
 project.sync(root,{task_id:'A'});assert.equal(project.loadProject(root).milestones[0].tasks[0].status,'closed');
});
