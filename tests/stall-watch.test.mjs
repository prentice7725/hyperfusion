import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fixture} from './support.mjs';
import {execute} from '../scripts/executor-bridge.mjs';
import {read,changeFingerprint} from '../scripts/artifact.mjs';
import {psCpuMs,watchProcessTree} from '../scripts/process-proof.mjs';
import {createStallWatch,judgeStall,readStallRecords,formatStallReport,stallFile} from '../scripts/stall-watch.mjs';

const T0=Date.UTC(2026,10,1);
const min=n=>n*60000;
const proc=(pid,cpu_ms,created='c'+pid)=>({pid,parent:1,created,cpu_ms});

test('ps CPU time is read in both the Linux and the macOS form',()=>{
 assert.equal(psCpuMs('00:00:07'),7000);
 assert.equal(psCpuMs('01:02:03'),3723000);
 assert.equal(psCpuMs('2-00:00:01'),2*86400000+1000);
 assert.equal(psCpuMs('0:01.50'),1500);
 assert.equal(psCpuMs('garbage'),null);
});

test('a run with no signal at all is flagged once at the first-signal threshold and never stopped',()=>{
 const w=createStallWatch({startedAt:T0});
 assert.equal(w.tick(T0+min(4)),null);
 const hit=w.tick(T0+min(5));
 assert.equal(hit.kind,'no_first_signal');
 assert.equal(w.tick(T0+min(6)),null,'flagged once');
 const r=w.finish(T0+min(40),{ok:false,reason:'Executor timeout'});
 assert.equal(r.mode,'observe-only');
 assert.equal(r.declares_success,false);
 assert.equal(r.gaps.length,1);
 assert.equal(r.gaps[0].before_first_signal,true);
 assert.equal(r.gaps[0].ended_by,'exit');
 const j=judgeStall(r);
 assert.equal(j.verdict,'would_save');
 assert.equal(j.saved_ms,min(35));
});

test('a stall after progress uses the longer threshold, and a signal that returns marks it a false positive',()=>{
 const w=createStallWatch({startedAt:T0});
 w.progress('output',T0+1000);
 assert.equal(w.tick(T0+1000+min(9)),null);
 assert.equal(w.tick(T0+1000+min(10)).kind,'stalled');
 w.progress('tree',T0+1000+min(12));
 const r=w.finish(T0+min(20),{ok:true});
 assert.equal(r.would_stop.resumed_by,'tree');
 assert.equal(r.would_stop.resumed_after_ms,min(2));
 assert.equal(judgeStall(r).verdict,'false_positive_resumed');
 // 기준을 15분으로 다시 계산하면 12분 구간은 걸리지 않는다.
 assert.equal(judgeStall(r,{stallMs:min(15)}).verdict,'none');
});

test('a quiet run that then exits cleanly is a false positive, not a saving',()=>{
 const w=createStallWatch({startedAt:T0});
 w.progress('output',T0+1000);
 const r=w.finish(T0+min(15),{ok:true});
 assert.equal(judgeStall(r).verdict,'false_positive_finished');
});

test('CPU counts as progress only when a known process gains a whole second or a new process appears',()=>{
 const w=createStallWatch({startedAt:T0});
 w.processes([proc(10,400)],T0+1000);
 assert.equal(w.report(T0+1000).signals.cpu.count,0,'the first sample is only a baseline');
 assert.equal(w.report(T0+1000).signals.cpu.available,true);
 w.processes([proc(10,900)],T0+2000);
 assert.equal(w.report(T0+2000).signals.cpu.count,0,'sub-second timer wakeups are not progress');
 w.processes([proc(10,1100)],T0+3000);
 assert.equal(w.report(T0+3000).signals.cpu.count,1);
 w.processes([proc(10,1100),proc(11,0)],T0+4000);
 assert.equal(w.report(T0+4000).signals.cpu.count,2,'a tool child was started');
 w.processes([proc(10,1100),proc(11,0)],T0+5000);
 assert.equal(w.report(T0+5000).signals.cpu.count,2);
 // 같은 PID라도 생성 시각이 다르면 다른 프로세스다.
 w.processes([proc(10,0,'reused')],T0+6000);
 assert.equal(w.report(T0+6000).signals.cpu.count,3);
});

test('an unreadable CPU column leaves the signal unavailable instead of inventing progress',()=>{
 const w=createStallWatch({startedAt:T0});
 w.processes([proc(10,null)],T0+1000);
 w.processes([proc(10,null)],T0+2000);
 const r=w.report(T0+2000);
 assert.equal(r.signals.cpu.available,false);
 assert.equal(r.signals.cpu.count,0);
});

test('gap storage is bounded and keeps the longest gaps',()=>{
 const w=createStallWatch({startedAt:T0,maxGaps:2,minGapMs:1000,firstSignalMs:min(60),stallMs:min(60)});
 let at=T0;
 for(const ms of [2000,9000,3000,5000]){at+=ms;w.progress('output',at);}
 const r=w.finish(at+10);
 assert.deepEqual(r.gaps.map(g=>g.ms).sort((a,b)=>a-b),[5000,9000]);
 assert.equal(r.gaps_dropped,2);
 assert.equal(r.max_gap_ms,9000);
 assert.throws(()=>createStallWatch({maxGaps:100000}),/bounded storage/);
});

test('the process watcher hands its samples to the stall watch without changing the proof',async()=>{
 const seen=[];
 const rows=[{pid:500,parent:1,created:'a',cpu_ms:1},{pid:501,parent:500,created:'b',cpu_ms:2},{pid:9,parent:1,created:'z',cpu_ms:3}];
 let table=rows;
 const monitor=watchProcessTree({readTable:async()=>table,pollMs:10_000,settle:{tries:1,delayMs:1},onSample:live=>{seen.push(live.map(p=>p.pid));throw Error('observer bug');}});
 monitor.start(500);
 await new Promise(r=>setTimeout(r,20));
 table=[rows[2]];
 const proof=await monitor.finish({exited:true});
 assert.deepEqual(seen[0],[500,501]);
 assert.equal(proof.quiescent,true,'an observer error does not reach the shutdown proof');
});

test('the change fingerprint moves when a file is edited and holds when nothing changes',async t=>{
 const f=fixture(t,{initialize:false});
 const a=await changeFingerprint(f.root);
 assert.equal(await changeFingerprint(f.root),a);
 fs.writeFileSync(path.join(f.root,'new-file.txt'),'x');
 const b=await changeFingerprint(f.root);
 assert.notEqual(b,a);
 await new Promise(r=>setTimeout(r,20));
 fs.writeFileSync(path.join(f.root,'new-file.txt'),'longer');
 assert.notEqual(await changeFingerprint(f.root),b,'a second edit to an already changed file is still seen');
});

test('a hung worker is recorded as a stall but still runs to the supervisor timeout',async t=>{
 const f=fixture(t);
 f.begin();f.mode('hang');
 await assert.rejects(()=>execute(f.root,{timeoutMs:700,monitorIntervalMs:20,stallWatch:{minGapMs:50,firstSignalMs:150,stallMs:150}}),/Executor timeout/);
 const dir=path.join(f.control,'tasks',f.brief.task_id);
 const record=read(path.join(dir,stallFile(1)));
 assert.equal(record.mode,'observe-only');
 assert.equal(record.executor,'grok');
 assert.equal(record.role,'implement');
 assert.equal(record.would_stop.kind,'no_first_signal');
 assert.equal(record.would_stop.resumed_at,null);
 assert.equal(record.outcome.ok,false);
 assert.equal(record.outcome.reason,'Executor timeout');
 assert.ok(record.wall_ms>=650,`the worker was stopped early (${record.wall_ms}ms)`);
 assert.equal(judgeStall(record).verdict,'would_save');
 const activity=fs.readFileSync(path.join(dir,'activity-1.ndjson'),'utf8');
 assert.match(activity,/stall watch \(observe only\)/);
 assert.match(activity,/"kind":"timeout"/);
 assert.equal(f.state().phase,'EXECUTING');
 assert.ok(f.state().writer,'the writer lease is untouched');
 const text=formatStallReport(readStallRecords(path.join(f.control,'tasks')));
 assert.match(text,/would_save/);
 assert.match(text,/runs 1 \| would_save 1/);
});

test('a normal round leaves a record with no flag and the round result is unchanged',async t=>{
 const f=fixture(t);
 f.begin();
 const out=await execute(f.root);
 assert.equal(out.status,'RESULT_READY');
 const record=read(path.join(f.control,'tasks',f.brief.task_id,stallFile(1)));
 assert.equal(record.would_stop,null);
 assert.equal(record.outcome.ok,true);
 assert.equal(record.signals.output.count>0,true);
 assert.equal(judgeStall(record).verdict,'none');
});

test('the report reads nothing as nothing',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hf-stall-'));
 try{assert.equal(formatStallReport(readStallRecords(dir)),'stall records: none\n');}
 finally{fs.rmSync(dir,{recursive:true,force:true});}
});
