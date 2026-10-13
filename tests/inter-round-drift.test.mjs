import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {read,snapshot} from '../scripts/artifact.mjs';
import {consult} from '../scripts/executor-bridge.mjs';

const art=(f,name)=>read(path.join(f.control,'tasks',f.brief.task_id,name));
const write=(f,file,value)=>fs.writeFileSync(path.join(f.root,file),value);
const verify=f=>run(f.root,'verify',{acceptance_satisfied:true,tests:[{command:'independent inspection',status:'pass'}]});
function task(t,config={}) {
 const f=fixture(t,{initialize:false});
 write(f,'b.txt','base');f.git('add','b.txt');f.git('commit','-qm','second scoped file');
 f.brief.scope.paths=['a.txt','b.txt'];
 if(Object.keys(config).length)write(f,'hyperfusion.config.json',JSON.stringify(config));
 run(f.root,'init',{...f.brief,executor:'grok'});
 return f;
}
function redo(f) {
 f.begin();write(f,'a.txt','first round');f.finish(f.result(['a.txt']));f.review('redo');
}
const recover=f=>{
 if(f.state().phase!=='RECOVERY_REQUIRED')assert.throws(()=>f.begin(),/Tree drift/);
 return run(f.root,'recover',{quiescent:true,reason:'Inspect and retain the inter-round change for cumulative review'});
};

test('begin blocks the screenshot reproduction before a new lease or attempt',t=>{
 const f=task(t);redo(f);const before=f.state();write(f,'b.txt','lead Bash write');
 assert.throws(()=>f.begin(),/Tree drift before begin/);
 const after=f.state();assert.equal(after.phase,'RECOVERY_REQUIRED');
 assert.equal(after.iteration,1);assert.deepEqual(after.attempts,before.attempts);
 assert.equal(after.post_digest,before.post_digest);
 assert.equal(fs.existsSync(path.join(f.control,'locks/writer.json')),false);
 assert.equal(fs.existsSync(path.join(f.control,'tasks',f.brief.task_id,'base-2.json')),false);
});

test('a CLI preflight that writes the tree cannot become the first worker baseline',t=>{
 const f=task(t),binary=process.env.HF_GROK_BIN;
 const source=fs.readFileSync(binary,'utf8');
 fs.writeFileSync(binary,source.replace("if(args.includes('--help')){",`if(args.includes('--help')){fs.writeFileSync(${JSON.stringify(path.join(f.root,'b.txt'))},'preflight write');`));
 assert.throws(()=>f.begin(),/Tree drift before begin \(during preflight\)/);
 assert.equal(f.state().iteration,0);assert.equal(f.state().attempts.grok,0);
 assert.equal(f.state().phase,'RECOVERY_REQUIRED');assert.equal(f.state().writer,null);
});

test('recovery refreshes the expected digest without pretending the change was a worker edit',t=>{
 const f=task(t);redo(f);write(f,'b.txt','retained external write');
 assert.throws(()=>f.begin(),/Tree drift/);recover(f);
 assert.equal(f.state().post_digest,snapshot(f.root).digest);
 assert.equal(f.state().iteration,1);assert.equal(f.state().phase,'REDO');
 f.begin();write(f,'a.txt','fixed');f.finish(f.result(['a.txt']));f.review();
 const closed=verify(f);assert.equal(closed.phase,'CLOSE');
 const evidence=art(f,'verification.json');
 assert.deepEqual(evidence.changed_files,['a.txt','b.txt']);
 assert.deepEqual(evidence.unattributed_changes,['b.txt']);
 const draft=fs.readFileSync(closed.pr_draft,'utf8');
 assert.match(draft,/`b\.txt`/);assert.match(draft,/일꾼 라운드에 귀속되지 않는 변경/);
 assert.deepEqual(run(f.root,'report').changed_files,['a.txt','b.txt']);
});

test('delegated review receives the cumulative diff and recovered risk paths still require the lead',async t=>{
 const f=task(t,{review:{by:'delegate',auto_apply:false,risk_paths:['b.txt']}});
 redo(f);write(f,'b.txt','external change');recover(f);
 f.begin();write(f,'a.txt','fixed');f.finish(f.result(['a.txt']));
 const d=run(f.root,'delegate-review',{});
 const request=art(f,`consult-${d.consult_id}-m1.json`);
 const context=JSON.parse(request.prompt).brief.consult.context;
 assert.deepEqual(context.changed_files,['a.txt','b.txt']);
 assert.deepEqual(context.round_changed_files,['a.txt']);
 assert.deepEqual(context.unattributed_changes,['b.txt']);
 assert.match(context.diff,/external change/);
 await consult(f.root,d.consult_id);
 const reviewed=run(f.root,'consult-finish',{quiescent:true});
 assert.equal(reviewed.review.reason,'risk_paths');
 assert.deepEqual(reviewed.review.risk_paths,['b.txt']);
});

test('a worker rewrite after recovery gives that file genuine round attribution',t=>{
 const f=task(t);redo(f);write(f,'b.txt','external');recover(f);
 f.begin();write(f,'a.txt','fixed');write(f,'b.txt','worker fix');
 f.finish(f.result(['a.txt','b.txt']));f.review();verify(f);
 assert.deepEqual(art(f,'verification.json').unattributed_changes,[]);
});

test('an inter-round rewrite of an earlier worker file is still marked unattributed',t=>{
 const f=task(t);redo(f);write(f,'a.txt','external overwrite');recover(f);
 f.begin();write(f,'b.txt','worker fix');f.finish(f.result(['b.txt']));f.review();verify(f);
 assert.deepEqual(art(f,'verification.json').unattributed_changes,['a.txt']);
});

test('the PR draft describes net changes rather than reverted round history',t=>{
 const f=task(t);redo(f);f.begin();write(f,'a.txt','base');write(f,'b.txt','fixed');
 f.finish(f.result(['a.txt','b.txt']));f.review();const closed=verify(f);
 assert.deepEqual(art(f,'verification.json').changed_files,['b.txt']);
 const draft=fs.readFileSync(closed.pr_draft,'utf8');assert.match(draft,/`b\.txt`/);assert.doesNotMatch(draft,/- `a\.txt`/);
});

test('the first worker baseline preserves user edits made before implementation starts',t=>{
 const f=task(t);write(f,'b.txt','pre-existing user change');
 f.begin();write(f,'a.txt','fixed');f.finish(f.result(['a.txt']));f.review();verify(f);
 assert.deepEqual(art(f,'verification.json').changed_files,['a.txt']);
 assert.equal(fs.readFileSync(path.join(f.root,'b.txt'),'utf8'),'pre-existing user change');
});

test('verify refuses unattributed files if the approving review never covered them',t=>{
 const f=task(t);redo(f);write(f,'b.txt','external');recover(f);
 f.begin();write(f,'a.txt','fixed');f.finish(f.result(['a.txt']));f.review();
 const state=f.state();delete state.reviews.at(-1).reviewed_changed_files;
 fs.writeFileSync(path.join(f.control,'state.json'),JSON.stringify(state));
 assert.throws(()=>verify(f),/UNREVIEWED_CHANGES.*b\.txt/);
 assert.notEqual(f.state().phase,'CLOSE');
});
