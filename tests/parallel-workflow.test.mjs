import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './support.mjs';
import * as project from '../scripts/project.mjs';
import {createWorktree,bundleWorktree,applyWorktree} from '../scripts/worktree.mjs';
import {validateWorkflow,assertWorkflowTask,assertParallelBegin,sourceIdentity} from '../scripts/workflow-plan.mjs';
import {read,atomic,snapshot,hash} from '../scripts/artifact.mjs';
import {controlPath} from '../scripts/control-dir.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {processTable} from '../scripts/process-proof.mjs';

const command='node -e "process.exit(0)"';
const task=(id,files,extra={})=>({id,title:id,kind:'code',difficulty:'low',depends_on:[],scope:{paths:files},success_criteria:['AC1'],acceptance_commands:[command],acceptance_map:{AC1:[command]},limits:{max_wall_ms:600000},...extra});
const graph=extra=>({milestones:[{id:'M1',tasks:[task('A',['a.txt'],{workspace:'isolated'}),task('I', ['a.txt'],{integrates:'A'}),task('F',['a.txt'],{depends_on:['A']})]}],...extra});
function setup(t,{parallel=true,overlap=false}={}) {
 const f=fixture(t,{initialize:false});
 fs.writeFileSync(path.join(f.root,'plan.md'),'Approved experimental independent work');
 fs.writeFileSync(path.join(f.root,'b.txt'),'base-b');
 const tasks=[task('A',['a.txt'],{workspace:'isolated'}),task('B',[overlap?'a.txt':'b.txt'],{workspace:'isolated'}),task('I',['a.txt'],{integrates:'A'}),task('J',[overlap?'a.txt':'b.txt'],{integrates:'B'}),task('F',['a.txt','b.txt'],{depends_on:['A','B']})];
 project.propose(f.root,{name:'parallel pilot',summary:'bounded pilot',sources:['plan.md'],team:[{member:'grok',role:'implement',why:'fixture',owns:['code']}],excluded:project.MEMBERS.filter(m=>m!=='grok').map(member=>({member,why:'unused'})),review:{by:'lead'},...(parallel?{parallel_implementation:{slots:2,reason:'Explicit experimental independent-task pilot'}}:{}),milestones:[{id:'M1',title:'pilot',goal:'validated integration',checkpoint:['combined evidence'],tasks}]});
 project.approve(f.root,{user_message:'Run the bounded experimental pilot'});
 return f;
}

test('parallel policy is explicit and bounded, while legacy definitions are unchanged',()=>{
 const legacy=validateWorkflow(graph());assert.ok(Array.isArray(legacy.definition));
 const enabled=validateWorkflow(graph({parallel_implementation:{slots:2,reason:'pilot'}}));assert.equal(enabled.definition.parallel_implementation.slots,2);assert.notEqual(enabled.digest,legacy.digest);
 for(const value of [null,{},true,{slots:3,reason:'pilot'},{slots:2,reason:''},{slots:2,reason:'pilot',auto_merge:true}])assert.throws(()=>validateWorkflow(graph({parallel_implementation:value})),/parallel_implementation/);
});
test('parallel plans require combined acceptance after all isolated integrations',()=>{
 const p=graph({parallel_implementation:{slots:2,reason:'pilot'}});p.milestones[0].tasks.pop();
 assert.throws(()=>validateWorkflow(p),/shared join/);
});
test('two disjoint isolated reservations are supported, shared integration waits and policy is frozen',t=>{
 const f=setup(t),a=createWorktree(f.root,'A'),b=createWorktree(f.root,'B');
 const p=project.loadProject(f.root);
 assert.equal(project.schedule(f.root).serial,false);assert.deepEqual(project.schedule(f.root).ready,[]);
 assert.equal(assertWorkflowTask(f.root,p,'A',a.workspace,{reserved:true}).id,'A');
 assert.equal(assertWorkflowTask(f.root,p,'B',b.workspace,{reserved:true}).id,'B');
 assert.equal(sourceIdentity(snapshot(a.workspace)),sourceIdentity(snapshot(f.root)));
 assert.equal(fs.readFileSync(path.join(a.workspace,'b.txt'),'utf8'),'base-b','uncommitted parent source is inherited without a commit');
 p.parallel_implementation.reason='changed';project.saveProject(f.root,p);assert.throws(()=>project.schedule(f.root),/frozen plan drift/);
});
test('serial projects and overlapping scopes cannot reserve a second workspace',t=>{
 const f=setup(t,{parallel:false});createWorktree(f.root,'A');assert.throws(()=>createWorktree(f.root,'B'),/IMPLEMENTATION_RUNNING/);
});
test('parallel scopes conflict conservatively and never fall back to same-tree writes',t=>{
 const f=setup(t,{overlap:true});createWorktree(f.root,'A');assert.throws(()=>createWorktree(f.root,'B'),/PARALLEL_SCOPE_CONFLICT/);
 assert.throws(()=>createWorktree(f.root,'I'),/IMPLEMENTATION_RUNNING|DEPENDENCY|ISOLATED_CLOSE/);
});
test('preparation is refused after an implementation starts; parent drift stops a reserved begin',t=>{
 const f=setup(t),a=createWorktree(f.root,'A'),p=project.loadProject(f.root);
 p.milestones[0].tasks[0].status='active';project.saveProject(f.root,p);
 assert.throws(()=>createWorktree(f.root,'B'),/prepare worktrees before/);
 assert.doesNotThrow(()=>assertParallelBegin(f.root,p,'A',a.workspace));
 fs.writeFileSync(path.join(f.root,'a.txt'),'user change');
 assert.throws(()=>assertParallelBegin(f.root,p,'A',a.workspace),/parent source changed/);
});

// Unit-level controller artifacts only: these helpers do not pretend to run a
// live worker or establish acceptance. Workflow integration E2E remains in the
// supervised workflow-plan suite and platform CI.
function reviewedChild(t) {
 const f=setup(t),wt=createWorktree(f.root,'A'),p=project.loadProject(f.root),root=wt.workspace;
 const base=snapshot(root);fs.writeFileSync(path.join(root,'a.txt'),'reviewed child');const post=snapshot(root);
 const state={task_id:'A',iteration:1,phase:'CLOSE',ended_at:new Date().toISOString(),post_digest:post.digest,writer:null,open_consult:null};
 atomic(controlPath(root,'state.json'),state);atomic(controlPath(root,'tasks','A','baseline.json'),base);atomic(controlPath(root,'tasks','A','post-1.json'),post);
 atomic(controlPath(f.root,'workflow','close-A.json'),{revision:1,digest:p.workflow.digest,workspace:root,state});
 const bundle=bundleWorktree(f.root,'A');
 const token='unit-integration-lease',writer={token,task_id:'I',round:1,owner:'grok'};
 atomic(controlPath(f.root,'state.json'),{task_id:'I',iteration:1,phase:'EXECUTING',project:{workflow_digest:p.workflow.digest},writer});
 atomic(controlPath(f.root,'locks/writer.json'),writer);
 return {...f,wt,bundle,input:{token,bundle_digest:bundle.bundle_digest,expected_digest:snapshot(f.root).digest}};
}
test('bundles bind reviewed files and apply once under the existing integration lease',t=>{
 const f=reviewedChild(t),before=fs.readFileSync(path.join(f.root,'b.txt'),'utf8');
 const result=applyWorktree(f.root,'A',f.input);assert.equal(result.status,'applied');assert.equal(fs.readFileSync(path.join(f.root,'a.txt'),'utf8'),'reviewed child');assert.equal(fs.readFileSync(path.join(f.root,'b.txt'),'utf8'),before);
 assert.equal(read(controlPath(f.root,'state.json')).phase,'EXECUTING','apply cannot approve or close a task');
 assert.equal(applyWorktree(f.root,'A',f.input).replayed,false);
 fs.writeFileSync(path.join(f.root,'b.txt'),'later change');assert.throws(()=>applyWorktree(f.root,'A',f.input),/uncertain or tree changed/);
});
test('stale expected trees, wrong leases and modified bundles are refused before mutation',t=>{
 const f=reviewedChild(t);
 assert.throws(()=>applyWorktree(f.root,'A',{...f.input,token:'wrong'}),/lease required/);
 assert.throws(()=>applyWorktree(f.root,'A',{...f.input,expected_digest:'stale'}),/base changed/);
 const file=f.bundle.bundle_file,b=read(file);b.files[0].data=Buffer.from('unreviewed').toString('base64');atomic(file,b);
 assert.throws(()=>applyWorktree(f.root,'A',f.input),/identity changed/);assert.equal(fs.readFileSync(path.join(f.root,'a.txt'),'utf8'),'base');
});
test('rewriting the bundle digest does not authorize changes different from the reviewed snapshot',t=>{
 const f=reviewedChild(t),file=f.bundle.bundle_file,b=read(file);b.files[0].data=Buffer.from('unreviewed').toString('base64');b.files[0].after.sha256=hash(Buffer.from('unreviewed'));
 const {bundle_digest,...value}=b;b.bundle_digest=hash(JSON.stringify(value));atomic(file,b);
 assert.throws(()=>applyWorktree(f.root,'A',{...f.input,bundle_digest:b.bundle_digest}),/reviewed files/);
});
test('existing worker launch markers forbid controller source application',t=>{
 const f=reviewedChild(t);
 atomic(controlPath(f.root,'tasks','I','launch-1.json'),{executor:'grok'});
 assert.throws(()=>applyWorktree(f.root,'A',f.input),/precede worker launch/);
 assert.equal(fs.readFileSync(path.join(f.root,'a.txt'),'utf8'),'base');
});
test('conflicting user changes and interrupted apply intent are retained without replay',t=>{
 const f=reviewedChild(t);fs.writeFileSync(path.join(f.root,'a.txt'),'user-owned conflict');
 assert.throws(()=>applyWorktree(f.root,'A',{...f.input,expected_digest:snapshot(f.root).digest}),/conflict at/);
 assert.equal(fs.readFileSync(path.join(f.root,'a.txt'),'utf8'),'user-owned conflict');
 atomic(controlPath(f.root,'workflow','apply-I-1.json'),{status:'intent',bundle_digest:f.bundle.bundle_digest});
 assert.throws(()=>applyWorktree(f.root,'A',f.input),/uncertain/);
});
test('unsettled child or changed child evidence cannot be exported',t=>{
 const f=setup(t),a=createWorktree(f.root,'A');assert.throws(()=>bundleWorktree(f.root,'A'));
 const state={task_id:'A',phase:'REVIEW',iteration:1};atomic(controlPath(a.workspace,'state.json'),state);
 atomic(controlPath(f.root,'workflow','close-A.json'),{digest:project.loadProject(f.root).workflow.digest,workspace:a.workspace,state});
 assert.throws(()=>bundleWorktree(f.root,'A'),/verified child CLOSE/);
});

test('supervised parallel children require serial integrations and combined acceptance before checkpoint',async t=>{
 try{await processTable();}catch{t.skip('Host process inventory unavailable; supervised parallel lifecycle requires platform CI');return;}
 const f=fixture(t,{initialize:false});fs.writeFileSync(path.join(f.root,'plan.md'),'Supervised two-child integration');
 fs.writeFileSync(path.join(f.root,'b.txt'),'base');
 const check=name=>`node -e "if(require('fs').readFileSync('${name}','utf8')!=='fixed')process.exit(1)"`;
 const a=check('a.txt'),b=check('b.txt');
 const bounded=(id,paths,commands,extra={})=>task(id,paths,{acceptance_commands:commands,acceptance_map:{AC1:commands},...extra});
 project.propose(f.root,{name:'supervised parallel',summary:'real acceptance and leases',sources:['plan.md'],team:[{member:'grok',role:'implement',why:'fixture',owns:['code']}],excluded:project.MEMBERS.filter(m=>m!=='grok').map(member=>({member,why:'unused'})),review:{by:'lead'},parallel_implementation:{slots:2,reason:'Test independent work with combined acceptance'},milestones:[{id:'M1',title:'cohort',goal:'combined CLOSE',checkpoint:['combined tests'],tasks:[bounded('A',['a.txt'],[a],{workspace:'isolated'}),bounded('B',['b.txt'],[b],{workspace:'isolated'}),bounded('I',['a.txt'],[a],{integrates:'A'}),bounded('J',['b.txt'],[b],{integrates:'B'}),bounded('F',['a.txt','b.txt'],[a,b],{depends_on:['A','B'],acceptance_baseline_green:'Explicitly verify the combined integrated results'})]}]});
 project.approve(f.root,{user_message:'Run this test cohort'});
 const wa=createWorktree(f.root,'A').workspace,wb=createWorktree(f.root,'B').workspace;
 const initialize=(root,id)=>run(root,'init',{task_id:id,objective:'Verify '+id,constraints:[],allowed_actions:['read','edit','test'],forbidden_actions:['commit','push'],evidence_required:['files_changed','test_results']});
 const begin=(root,id)=>{initialize(root,id);return run(root,'begin',read(controlPath(root,'tasks',id,'initial-brief.json')));};
 const ra=begin(wa,'A'),rb=begin(wb,'B');
 assert.equal(read(controlPath(wa,'state.json')).phase,'EXECUTING');assert.equal(read(controlPath(wb,'state.json')).phase,'EXECUTING');
 const finish=(root,id,token,files)=>{
  run(root,'finish',{token,quiescent:true,result:{task_id:id,round:1,status:'complete',summary:'bounded fixture',files_read:files,files_changed:files,commands_run:[],tests:[],unresolved:[],risks:[],needs_lead_decision:false,recommended_next_action:'review'}});
  run(root,'review',{verdict:'pass',rationale:'Inspected exact bounded diff',commands_run:['git diff'],independent_diff_review:true,findings:[],blocking_criteria:[]});
  assert.equal(run(root,'verify',{acceptance_satisfied:true,tests:[{command:'independent fixture review',status:'pass'}]}).phase,'CLOSE');
 };
 fs.writeFileSync(path.join(wa,'a.txt'),'fixed');fs.writeFileSync(path.join(wb,'b.txt'),'fixed');
 finish(wa,'A',ra.token,['a.txt']);finish(wb,'B',rb.token,['b.txt']);
 assert.deepEqual(project.schedule(f.root).ready,['I','J']);
 for(const [child,id] of [['A','I'],['B','J']]){
  const bundle=bundleWorktree(f.root,child),request=begin(f.root,id);
  const receipt=applyWorktree(f.root,child,{token:request.token,bundle_digest:bundle.bundle_digest,expected_digest:snapshot(f.root).digest});
  finish(f.root,id,request.token,receipt.changed);
  project.integrate(f.root,{task_id:child,integration_task_id:id,reason:'Exact reviewed bundle and current acceptance'});
 }
 assert.deepEqual(project.schedule(f.root).ready,['F']);
 const final=begin(f.root,'F');finish(f.root,'F',final.token,[]);
 assert.deepEqual(project.status(f.root).checkpoint_due,['M1']);
});
