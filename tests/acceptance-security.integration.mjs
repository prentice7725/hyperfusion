import test from 'node:test';
// Run after the parallel suite (npm test). These tests deliberately create real
// orphans: another acceptance supervisor must fail closed if it observes one.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {atomic,read} from '../scripts/artifact.mjs';
import {runCommands} from '../scripts/acceptance.mjs';
import {unattributedProcesses} from '../scripts/process-proof.mjs';
import {supervisedCommands} from '../scripts/acceptance-runner.mjs';

const CHECK=`node -e "process.exit(require('fs').readFileSync('a.txt','utf8')==='fixed'?0:1)"`;
const expire=f=>{const s=f.state();s.limits={max_wall_ms:1};s.started_at=new Date(Date.now()-1000).toISOString();atomic(path.join(f.control,'state.json'),s);};
const evidence=f=>read(path.join(f.control,'tasks',f.brief.task_id,f.state().acceptance.file));
const kill=pid=>{try{if(process.platform==='win32')execFileSync('taskkill',['/PID',String(pid),'/T','/F'],{stdio:'ignore',windowsHide:true});else process.kill(pid,'SIGKILL');}catch{}};

test('new orphans fail closed; unrelated new children of a baseline process do not',()=>{
 const baseline=[{pid:10,parent:1,created:'2026-01-01'},{pid:20,parent:10,created:'2026-01-02'}];
 const rows=[...baseline,{pid:30,parent:20,created:'2026-01-03'},{pid:40,parent:999,created:'2026-01-03'},
  {pid:50,parent:1,created:'2026-01-03'},{pid:60,parent:10,created:'2026-01-03'}];
 assert.deepEqual(unattributedProcesses(rows,baseline,10).map(p=>p.pid),[40,50,60]);
});

test('unavailable process inventory starts no command, including later commands',async t=>{
 const f=fixture(t),marker=path.join(f.temp,'should-not-run');
 const command=`node -e "require('fs').writeFileSync(process.argv[1],'ran')" "${marker}"`;
 const results=await supervisedCommands(f.root,[command,command],{readTable:async()=>{throw Object.assign(Error('missing ps'),{code:'ENOENT'});}});
 for(const r of results){assert.equal(r.status,'not_run');assert.equal(r.code,'PROCESS_TABLE_UNAVAILABLE');assert.equal(r.quiescence.quiescent,true);}
 assert.equal(fs.existsSync(marker),false);
});

test('a detached acceptance child blocks finish, retains the lease and cannot reach CLOSE',t=>{
 const f=fixture(t),pidfile=path.join(f.temp,'child.pid'),child=path.join(f.temp,'child.cjs'),parent=path.join(f.temp,'parent.cjs');
 fs.writeFileSync(child,`setTimeout(()=>{require('fs').writeFileSync(process.argv[2],'late-write')},120000);`);
 fs.writeFileSync(parent,`const fs=require('fs');if(fs.readFileSync('a.txt','utf8')!=='fixed')process.exit(1);
 const c=require('child_process').spawn(process.execPath,[${JSON.stringify(child)},require('path').resolve('a.txt')],{detached:true,stdio:'ignore'});
 fs.writeFileSync(${JSON.stringify(pidfile)},String(c.pid));c.unref();`);
 f.brief.acceptance_commands=[`node "${parent}"`];f.begin();fs.writeFileSync(path.join(f.root,'a.txt'),'fixed');
 try{
  const s=f.finish(f.result(['a.txt']));
  assert.equal(s.phase,'RECOVERY_REQUIRED');assert.ok(s.writer);
  assert.equal(evidence(f).results[0].quiescence.quiescent,false);
  const pid=Number(fs.readFileSync(pidfile,'utf8'));assert.doesNotThrow(()=>process.kill(pid,0));
  assert.throws(()=>run(f.root,'verify',{acceptance_satisfied:true}),/ACCEPTANCE_NOT_QUIESCENT/);
  assert.throws(()=>run(f.root,'init',{...f.brief,task_id:'another'}),/ACCEPTANCE_NOT_QUIESCENT/);
  assert.equal(f.state().phase,'RECOVERY_REQUIRED');
  kill(pid);
  run(f.root,'recover',{token:s.writer.token,quiescent:true,reason:'Stopped the acceptance child'});
  assert.equal(fs.existsSync(path.join(f.control,'locks/acceptance.json')),false);
 }finally{if(fs.existsSync(pidfile))kill(Number(fs.readFileSync(pidfile,'utf8')));}
});

test('timeout terminates the acceptance tree before starting another command',t=>{
 const f=fixture(t),pidfile=path.join(f.temp,'timeout-child.pid'),parent=path.join(f.temp,'timeout.cjs');
 fs.writeFileSync(parent,`const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 require('fs').writeFileSync(${JSON.stringify(pidfile)},String(c.pid));setInterval(()=>{},1000);`);
 try{
  const [r,next]=runCommands(f.root,[`node "${parent}"`,'node -e "process.exit(0)"'],{timeout_ms:1500});
  assert.equal(r.timed_out,true);assert.equal(r.status,'fail');
  if(r.quiescence.quiescent)assert.equal(next.status,'pass');
  else {assert.equal(next.status,'not_run');assert.equal(next.code,'ACCEPTANCE_NOT_QUIESCENT');}
  const pid=Number(fs.readFileSync(pidfile,'utf8'));
  if(process.platform==='win32')assert.throws(()=>process.kill(pid,0));
 }finally{if(fs.existsSync(pidfile))kill(Number(fs.readFileSync(pidfile,'utf8')));}
});

test('expired finish budget never starts acceptance and safely releases the worker lease',t=>{
 const f=fixture(t);f.brief.acceptance_commands=[CHECK];f.begin();fs.writeFileSync(path.join(f.root,'a.txt'),'fixed');expire(f);
 const s=f.finish(f.result(['a.txt']));assert.equal(s.phase,'BLOCKED');assert.equal(s.writer,null);
 assert.equal(evidence(f).results[0].status,'not_run');assert.equal(evidence(f).results[0].code,'BUDGET_EXCEEDED');
});

test('VERIFY cannot reuse passing evidence after the task budget expires',t=>{
 const f=fixture(t);f.brief.acceptance_commands=[CHECK];f.begin();fs.writeFileSync(path.join(f.root,'a.txt'),'fixed');f.finish(f.result(['a.txt']));
 f.review('pass');expire(f);
 assert.equal(run(f.root,'verify',{acceptance_satisfied:true}).phase,'BLOCKED');
 assert.equal(fs.existsSync(path.join(f.control,'tasks',f.brief.task_id,'verification.json')),false);
});

test('task deadline clamps a command timeout and suppresses later commands',t=>{
 const f=fixture(t),marker=path.join(f.temp,'later');
 const [r,next]=runCommands(f.root,['node -e "setInterval(()=>{},1000)"',`node -e "require('fs').writeFileSync(process.argv[1],'ran')" "${marker}"`],
  {timeout_ms:30000,deadline_ms:Date.now()+4000});
 assert.ok(['fail','not_run'].includes(r.status));assert.equal(r.quiescence.quiescent,true,JSON.stringify(r));assert.equal(r.code,'BUDGET_EXCEEDED');
 if(r.status==='fail')assert.equal(r.timed_out,true);
 assert.equal(next.status,'not_run');assert.equal(fs.existsSync(marker),false);
});

test('an interrupted acceptance marker forbids reusing an older pass',t=>{
 const f=fixture(t);f.brief.acceptance_commands=[CHECK];f.begin();fs.writeFileSync(path.join(f.root,'a.txt'),'fixed');f.finish(f.result(['a.txt']));f.review('pass');
 atomic(path.join(f.control,'locks/acceptance.json'),{state:f.state(),brief:f.brief,stage:'verify'});
 assert.throws(()=>run(f.root,'verify',{acceptance_satisfied:true}),/ACCEPTANCE_NOT_QUIESCENT/);
 assert.equal(f.state().phase,'RECOVERY_REQUIRED');
});

test('init enforces the task deadline during the untouched-tree acceptance baseline',t=>{
 const f=fixture(t,{initialize:false});
 const s=run(f.root,'init',{...f.brief,executor:'grok',limits:{max_wall_ms:1},acceptance_commands:[CHECK]});
 assert.equal(s.phase,'BLOCKED');assert.equal(s.iteration,0);assert.equal(s.writer,null);
});
