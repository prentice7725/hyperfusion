import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fixture} from './support.mjs';
import {read} from '../scripts/artifact.mjs';
import {environmentBlocked} from '../scripts/contracts.mjs';
import {WORKER_TEMP_DIR,WINDOWS_TEMP_ORDER} from '../scripts/codex-sandbox.mjs';

// 2026-11-06 L01 run 9: Terra finished the work, but the host refused the full suite and the cleanup,
// so it reported blocked. The lead then spent two no-op rounds turning blocked into complete.
const task=(f,...parts)=>path.join(f.control,'tasks',f.brief.task_id,...parts);
const CHECK=`node -e "const s=require('fs').readFileSync('a.txt','utf8');if(s!=='fixed'){console.error('a.txt is '+s);process.exit(3)}"`;
const ENV_TEST={command:'npm test',status:'not_run',environment_error:'the sandbox refused CIM process-table access'};
const envBlocked=(f,files,tests=[{command:'node --test focused',status:'pass'},ENV_TEST])=>({...f.result(files),status:'blocked',tests,
 unresolved:['The full repository test suite did not complete.'],recommended_next_action:'review'});

test('environmentBlocked accepts only a blocked result whose non-passing tests are all environment errors',()=>{
 const base={status:'blocked',needs_lead_decision:false,tests:[{command:'a',status:'pass'},ENV_TEST]};
 assert.equal(environmentBlocked(base),true);
 assert.equal(environmentBlocked({...base,status:'failed'}),false);
 assert.equal(environmentBlocked({...base,needs_lead_decision:true}),false);
 assert.equal(environmentBlocked({...base,tests:[{command:'a',status:'pass'}]}),false,'no environment error, no exception');
 assert.equal(environmentBlocked({...base,tests:[...base.tests,{command:'b',status:'fail'}]}),false,'a real failure stays blocking');
 assert.equal(environmentBlocked({...base,tests:[{command:'b',status:'not_run'}]}),false,'not_run without a reason is not an environment error');
});

test('an environment-only blocked result can pass when the controller acceptance passed this round',t=>{
 const f=fixture(t);f.brief.acceptance_commands=[CHECK];
 f.begin();fs.writeFileSync(path.join(f.root,'a.txt'),'fixed');
 f.finish(envBlocked(f,['a.txt']));
 assert.equal(f.state().phase,'REVIEW');
 assert.equal(f.state().acceptance.status,'pass');
 const s=f.review('pass');
 assert.notEqual(s.phase,'REVIEW');
 assert.equal(s.reviews.at(-1).verdict,'pass');
});

test('an environment-only blocked result still cannot pass when the controller acceptance failed',t=>{
 const f=fixture(t);f.brief.acceptance_commands=[CHECK];
 f.begin();fs.writeFileSync(path.join(f.root,'a.txt'),'half done');
 f.finish(envBlocked(f,['a.txt']));
 assert.equal(f.state().acceptance.status,'fail');
 assert.throws(()=>f.review('pass'),/Incomplete result cannot pass/);
});

test('an environment-only blocked result cannot pass without acceptance commands',t=>{
 const f=fixture(t);
 f.begin();fs.writeFileSync(path.join(f.root,'a.txt'),'fixed');
 f.finish(envBlocked(f,['a.txt']));
 assert.throws(()=>f.review('pass'),/Incomplete result cannot pass/);
});

test('a blocked result with a real test failure still cannot pass',t=>{
 const f=fixture(t);f.brief.acceptance_commands=[CHECK];
 f.begin();fs.writeFileSync(path.join(f.root,'a.txt'),'fixed');
 f.finish(envBlocked(f,['a.txt'],[{command:'node --test focused',status:'fail'},ENV_TEST]));
 assert.equal(f.state().acceptance.status,'pass');
 assert.throws(()=>f.review('pass'),/Incomplete result cannot pass/);
});

test('finish removes the worker temp folder, even with a git repository inside it',t=>{
 const f=fixture(t);
 f.begin();fs.writeFileSync(path.join(f.root,'a.txt'),'fixed');
 const nested=path.join(f.root,WORKER_TEMP_DIR,'hf-v03-x','repo');fs.mkdirSync(nested,{recursive:true});
 execFileSync('git',['init','-q',nested],{stdio:'pipe'});
 fs.writeFileSync(path.join(nested,'f.txt'),'x');
 const s=f.finish(f.result(['a.txt']));
 assert.equal(s.phase,'REVIEW',JSON.stringify(s.last_errors));
 assert.equal(fs.existsSync(path.join(f.root,WORKER_TEMP_DIR)),false);
 assert.deepEqual(read(task(f,'worker-temp-1.json')),{path:WORKER_TEMP_DIR,removed:true});
});

test('finish keeps a temp folder that existed before the round',t=>{
 const f=fixture(t);
 fs.mkdirSync(path.join(f.root,WORKER_TEMP_DIR));fs.writeFileSync(path.join(f.root,WORKER_TEMP_DIR,'mine.txt'),'user file');
 f.git('add','-A');f.git('commit','-qm','user temp');
 f.begin();fs.writeFileSync(path.join(f.root,'a.txt'),'fixed');
 f.finish(f.result(['a.txt']));
 assert.equal(fs.readFileSync(path.join(f.root,WORKER_TEMP_DIR,'mine.txt'),'utf8'),'user file');
 assert.equal(fs.existsSync(task(f,'worker-temp-1.json')),false);
});

test('the Windows TEMP order leaves the cleanup to the controller',()=>{
 assert.match(WINDOWS_TEMP_ORDER,/Do not delete that folder/);
 assert.match(WINDOWS_TEMP_ORDER,/controller removes it/);
 assert.doesNotMatch(WINDOWS_TEMP_ORDER,/delete that folder before you finish/);
});
