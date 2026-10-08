import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {consult,execute} from '../scripts/executor-bridge.mjs';
import {read} from '../scripts/artifact.mjs';
import {measure} from '../scripts/metrics.mjs';
import {route} from '../scripts/router.mjs';
import {config} from '../scripts/executor-config.mjs';

const ask=(f,input)=>run(f.root,'consult',{question:'Does the change meet AC1?',...input});
const done=f=>run(f.root,'consult-finish',{quiescent:true});
const argsOf=(f,name)=>read(path.join(f.temp,`fake-${name}-args.json`));
const inReview=async f=>{f.begin();f.mode('edit');await f.bridge();f.mode('ok');};

test('advisor reviews another worker\'s diff read-only and its findings come back to the lead',async t=>{
 const f=fixture(t);await inReview(f);
 const c=ask(f,{mode:'advisor'});
 assert.equal(c.members.length,1);assert.notEqual(c.members[0].executor,'grok');
 f.mode('findings');const out=await consult(f.root,c.consult_id);
 assert.equal(out.members[0].ok,true);
 const brief=JSON.parse(read(path.join(f.control,`tasks/HF-test/consult-${c.consult_id}-m1.json`)).prompt).brief;
 assert.deepEqual(brief.consult.context.changed_files,['a.txt']);assert.match(brief.consult.context.diff,/\+fixed/);
 const r=done(f);
 assert.equal(r.violated,false);assert.equal(r.results[0].findings[0].file,'sub/a.txt');assert.equal(r.members[0].blockers,1);
 assert.equal(f.state().phase,'REVIEW');assert.equal(f.review('pass').phase,'VERIFY');
});
test('committee seats two different workers and runs them together',async t=>{
 const f=fixture(t);f.begin();f.finish();f.review('redo',['AC1']);
 const c=ask(f,{mode:'committee',question:'Why does AC1 keep failing?'});
 assert.equal(c.members.length,2);assert.notEqual(c.members[0].executor,c.members[1].executor);
 const out=await consult(f.root,c.consult_id);
 assert.ok(out.members.every(m=>m.ok));assert.equal(done(f).results.length,2);
 assert.equal(f.state().consult_runs,2);
});
test('consult workers are launched read-only on every CLI',async t=>{
 const f=fixture(t);
 ask(f,{mode:'committee',executors:['sonnet','antigravity']});await consult(f.root,'c1');done(f);
 const sonnet=argsOf(f,'claude');assert.equal(sonnet[sonnet.indexOf('--tools')+1],'Read,Glob,Grep');assert.ok(!sonnet[sonnet.indexOf('--allowedTools')+1].includes('Bash'));
 const agy=argsOf(f,'agy');assert.equal(agy[agy.indexOf('--mode')+1],'plan');
 ask(f,{mode:'advisor',executors:['grok']});await consult(f.root,'c2');done(f);
 const grok=argsOf(f,'grok');assert.ok(!grok.some(a=>a.startsWith('Edit(a.txt')));assert.ok(grok.includes('Bash(*)'));
});
test('a consult that edits the tree is voided and forces recovery',async t=>{
 const f=fixture(t);f.begin();f.finish();
 ask(f,{mode:'advisor',executors:['sonnet']});f.mode('edit');await consult(f.root,'c1');
 const r=done(f);
 assert.equal(r.violated,true);assert.deepEqual(r.touched,['a.txt']);assert.deepEqual(r.results,[]);
 assert.equal(f.state().phase,'RECOVERY_REQUIRED');
 const m=measure(f.root);assert.equal(m.consults[0].violated,true);
});
test('nothing else moves while a consult is open',async t=>{
 const f=fixture(t);f.begin();f.finish();
 ask(f,{mode:'advisor'});
 assert.throws(()=>f.review('pass'),/in progress/);assert.throws(()=>ask(f,{mode:'advisor'}),/in progress/);
 assert.ok(run(f.root,'status').open_consult);
 await consult(f.root,'c1');done(f);assert.equal(f.review('pass').phase,'VERIFY');
});
test('consult budget is capped per task',async t=>{
 const f=fixture(t);
 for(const id of ['c1','c2']){ask(f,{mode:'committee'});await consult(f.root,id);done(f);}
 assert.throws(()=>ask(f,{mode:'advisor'}),/cap reached/);assert.equal(run(f.root,'status').consult_remaining,0);
});
test('consult is refused during a writer round and without a question',t=>{
 const f=fixture(t);assert.throws(()=>run(f.root,'consult',{mode:'advisor'}),/question/);
 f.begin();assert.throws(()=>ask(f,{mode:'advisor'}),/Invalid phase/);
});
test('missing worker CLI is skipped for default members, fatal when named',t=>{
 const f=fixture(t);process.env.HF_CLAUDE_BIN=path.join(f.temp,'missing');
 assert.notEqual(ask(f,{mode:'advisor'}).members[0].executor,'sonnet');done(f);
 assert.throws(()=>ask(f,{mode:'advisor',executors:['sonnet']}),/ADAPTER_UNAVAILABLE/);
});
test('repeated failure suggests a committee before switching workers',t=>{
 const f=fixture(t);f.begin();f.finish();f.review('redo',['AC1']);f.begin();f.finish();
 const s=f.review('redo',['AC1']);assert.equal(s.phase,'ALTERNATIVE_REQUIRED');assert.equal(s.hint.mode,'committee');
 ask(f,{mode:'committee'});assert.equal(f.state().hint,null);
});
test('line-level feedback from a consult can be handed straight to the next worker',t=>{
 const f=fixture(t);f.begin();f.finish();f.review('redo',['AC1']);
 assert.throws(()=>f.begin({lead_feedback:[{file:'../x',comment:'no'}]}),/lead_feedback/);
 assert.throws(()=>f.begin({lead_feedback:[{file:'a.txt',line:-1,comment:'no'}]}),/lead_feedback/);
 const d=f.begin({lead_feedback:[{file:'a.txt',line:3,comment:'handle empty input'},'keep the API']});
 assert.deepEqual(JSON.parse(d.prompt).brief.lead_feedback[0],{file:'a.txt',line:3,comment:'handle empty input'});
 assert.equal(read(path.join(f.control,'tasks/HF-test/brief-2.json')).lead_feedback[0].line,3);
});
test('a worker that breaks read-only consults loses rank for that task kind',t=>{
 const f=fixture(t,{initialize:false});const dir=path.join(f.control,'metrics');fs.mkdirSync(dir,{recursive:true});
 for(let i=0;i<3;i++)fs.writeFileSync(path.join(dir,`old-${i}.json`),JSON.stringify({task_kind:'code',review_outcomes:[],consults:[{violated:true,members:[{executor:'sonnet'}]}]}));
 assert.equal(route(f.root,config(f.root),{task_kind:'code',difficulty:'high'}).executor,'grok');
});
test('HF_NOTIFY_URL receives a push when a worker finishes',async t=>{
 const got=[];const server=http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{got.push({title:req.headers.title,body:b});res.end('ok');});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const old=process.env.HF_NOTIFY_URL;process.env.HF_NOTIFY_URL=`http://127.0.0.1:${server.address().port}/hf`;t.after(()=>{if(old===undefined)delete process.env.HF_NOTIFY_URL;else process.env.HF_NOTIFY_URL=old;});
 const f=fixture(t);f.begin();await execute(f.root);
 assert.equal(got.length,1);assert.equal(got[0].title,'HyperFusion HF-test');assert.match(got[0].body,/grok round 1 done \(complete\)/);
});
