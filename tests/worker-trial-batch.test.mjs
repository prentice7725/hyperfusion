import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runBatch,schedule,status} from '../tools/worker-trial-batch.mjs';

const ARMS=[{label:'a',vendor:'x',args:[]},{label:'b',vendor:'y',args:[]}];
const CASES=['HF-X1'];
const temp=t=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'hf-batch-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;};
const lines=file=>fs.readFileSync(file,'utf8').trim().split('\n').map(l=>JSON.parse(l));

// 실제 일꾼 대신 쓰는 대역 스크립트. execute는 폴더를 만들고 미룬 기록을, settle은 채점된 기록을 출력한다.
// hang이면 끝나지 않는다. LOG가 있으면 시작(s)과 끝(e)을 남겨 동시 실행 여부를 본다.
const EXECUTE=`const fs=require('fs');const [mode,log,label,caseId,dir]=process.argv.slice(2);
if(mode==='hang')setInterval(()=>{},1000);
else{if(log!=='-')fs.appendFileSync(log,'s\\n');fs.mkdirSync(dir);
 setTimeout(()=>{if(log!=='-')fs.appendFileSync(log,'e\\n');
  console.log(JSON.stringify({case_id:caseId,label,repo:dir,stage:'executed',error:null,score:null,settled:false}));},300);}
`;
const SETTLE=`const r=JSON.parse(require('fs').readFileSync(process.argv[2],'utf8'));
console.log(JSON.stringify({...r,settled:true,stage:r.stage==='executed'?'done':r.stage,score:{hidden_passed:1,hidden_failed:0,all_hidden_passed:true,scope_violations:0}}));
`;
function fakes(t,mode,log='-') {
 const dir=temp(t);
 fs.writeFileSync(path.join(dir,'execute.cjs'),EXECUTE);fs.writeFileSync(path.join(dir,'settle.cjs'),SETTLE);
 return {
  execute:(trial,target)=>[process.execPath,[path.join(dir,'execute.cjs'),mode,log,trial.arm.label,trial.case_id,target]],
  settle:file=>[process.execPath,[path.join(dir,'settle.cjs'),file]],
 };
}

test('the schedule rotates arms per case and finishes rep 1 before rep 2',()=>{
 const ids=schedule({reps:2,cases:['HF-X1','HF-X2'],arms:ARMS}).map(t=>t.trial_id);
 assert.deepEqual(ids,['hf-x1-b-1','hf-x1-a-1','hf-x2-a-1','hf-x2-b-1','hf-x1-a-2','hf-x1-b-2','hf-x2-b-2','hf-x2-a-2']);
});

test('a resumed batch skips recorded trials and reruns an interrupted one under a new name',async t=>{
 const out=temp(t);
 // 예전 셸 묶음이 남긴 기록(trial_id 없음)과, 기록 없이 폴더만 남은 중단된 시험.
 fs.writeFileSync(path.join(out,'trials.jsonl'),JSON.stringify({case_id:'HF-X1',label:'b',repo:path.join(out,'hf-x1-b-1'),stage:'done',error:null,score:null})+'\n');
 fs.mkdirSync(path.join(out,'hf-x1-b-1'));fs.mkdirSync(path.join(out,'hf-x1-a-1'));
 const ran=await runBatch({out,reps:1,cases:CASES,arms:ARMS,commands:fakes(t,'ok')});
 assert.deepEqual(ran.map(r=>[r.trial_id,r.attempt,r.stage]),[['hf-x1-a-1','hf-x1-a-1b','done']]);
 assert.ok(lines(path.join(out,'batch-events.jsonl')).some(e=>e.event==='interrupted'&&e.dir==='hf-x1-a-1'));
 assert.deepEqual(await runBatch({out,reps:1,cases:CASES,arms:ARMS,commands:fakes(t,'ok')}),[]);
 const s=status(out,{reps:1,cases:CASES,arms:ARMS});
 assert.deepEqual([s.done,s.awaiting_settle,s.total,s.not_started],[2,0,2,[]]);
 assert.equal(fs.existsSync(path.join(out,'batch.lock')),false);
});

test('a trial that stops responding is killed, recorded and still settled',async t=>{
 const out=temp(t);
 const [r]=await runBatch({out,reps:1,cases:CASES,arms:[ARMS[0]],timeoutMin:0.002,graceMin:0.002,commands:fakes(t,'hang')});
 const [e]=lines(path.join(out,'executed.jsonl'));
 assert.equal(e.stage,'watchdog');assert.match(e.error,/WATCHDOG_TIMEOUT/);
 assert.equal(r.trial_id,'hf-x1-a-1');assert.equal(r.stage,'watchdog');assert.match(r.error,/WATCHDOG_TIMEOUT/);
 assert.equal(lines(path.join(out,'trials.jsonl')).length,1);
});

test('a second batch on the same folder is refused while the first holds the lock',async t=>{
 const out=temp(t);
 fs.writeFileSync(path.join(out,'batch.lock'),JSON.stringify({pid:process.pid}));
 await assert.rejects(runBatch({out,reps:1,cases:CASES,arms:ARMS,commands:fakes(t,'ok')}),/another batch/);
});

test('parallel lanes run different vendors at the same time and settle afterwards',async t=>{
 const out=temp(t),log=path.join(out,'order.log');
 await runBatch({out,reps:1,cases:CASES,arms:ARMS,parallel:true,commands:fakes(t,'ok',log)});
 // 두 줄이 동시에 돌면 둘 다 시작한 뒤에 끝난다.
 assert.deepEqual(fs.readFileSync(log,'utf8').trim().split('\n'),['s','s','e','e']);
 assert.ok(lines(path.join(out,'executed.jsonl')).every(r=>r.concurrent_lanes===2));
 const events=lines(path.join(out,'batch-events.jsonl')).map(e=>e.event);
 assert.ok(events.lastIndexOf('executed')<events.indexOf('settled'),'settling starts after every execution');
 assert.equal(lines(path.join(out,'trials.jsonl')).length,2);
});

test('the same vendor stays in one lane even in parallel mode',async t=>{
 const out=temp(t),log=path.join(out,'order.log');
 await runBatch({out,reps:1,cases:CASES,arms:ARMS.map(a=>({...a,vendor:'same'})),parallel:true,commands:fakes(t,'ok',log)});
 assert.deepEqual(fs.readFileSync(log,'utf8').trim().split('\n'),['s','e','s','e']);
});

test('a batch interrupted after execution only settles on resume',async t=>{
 const out=temp(t);
 fs.mkdirSync(path.join(out,'hf-x1-a-1'));
 fs.writeFileSync(path.join(out,'executed.jsonl'),JSON.stringify({trial_id:'hf-x1-a-1',case_id:'HF-X1',label:'a',repo:path.join(out,'hf-x1-a-1'),stage:'executed',error:null,score:null,settled:false})+'\n');
 const ran=await runBatch({out,reps:1,cases:CASES,arms:[ARMS[0]],commands:{...fakes(t,'hang'),settle:fakes(t,'ok').settle}});
 assert.deepEqual(ran.map(r=>[r.trial_id,r.stage]),[['hf-x1-a-1','done']]);
 assert.equal(fs.existsSync(path.join(out,'hf-x1-a-1b')),false);
});
