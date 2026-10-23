import test from 'node:test';
import assert from 'node:assert/strict';
import {descendants,watchProcessTree} from '../scripts/process-proof.mjs';

// Windows는 죽은 부모의 PID를 자식의 ParentProcessId에 그대로 남기고 PID를 빠르게 재사용한다.
// 실제 실패(CI): 감독 뿌리의 PID가 부팅 때 죽은 프로세스의 PID와 같았고, 뿌리가 끝나 표에서 사라지자
// csrss·wininit·services·svchost 수십 개(모두 ParentProcessId가 그 PID)가 자손으로 잡혀 "프로세스가 남았다"가 됐다.
const at=ms=>new Date(Date.UTC(2026,9,12,11,0,0)+ms).toISOString();
const proc=(pid,parent,ms,name)=>({pid,parent,created:at(ms),name});

const BOOT=-18*60*1000;          // 17~18분 전에 부팅
const START=0;                   // 감독 시작
const ROOT=732;                  // 부팅 때 죽은 프로세스의 PID를 뿌리가 재사용했다
const system=[
 proc(4,0,BOOT,'System'),
 proc(744,ROOT,BOOT+1000,'csrss.exe'),
 proc(864,ROOT,BOOT+2000,'wininit.exe'),
 proc(964,864,BOOT+3000,'services.exe'),
 proc(916,964,BOOT+4000,'svchost.exe')];

test('a finished root whose PID was reused does not adopt the older system processes that still point at that PID',()=>{
 const rows=[...system];                               // 뿌리는 이미 끝나 표에 없다
 const found=descendants(rows,ROOT,new Map(),{bornAfter:Date.parse(at(START))-2000});
 assert.deepEqual(found.map(p=>p.name),[],'nothing older than the supervision start can be a descendant');
 // 시작 시각을 모르면(예전 호출 방식) 예전처럼 시스템이 통째로 잡힌다. 그래서 감독 쪽이 bornAfter를 반드시 넘긴다.
 assert.ok(descendants(rows,ROOT).length>=4,'documents the old failure mode');
});

test('a child that really was created after the supervision started is still found when the root is gone',()=>{
 const orphan=proc(5000,ROOT,START+500,'node.exe');
 const grandchild=proc(5004,5000,START+800,'node.exe');
 const found=descendants([...system,orphan,grandchild],ROOT,new Map(),{bornAfter:Date.parse(at(START))-2000});
 assert.deepEqual(found.map(p=>p.pid).sort(),[5000,5004]);
});

test('the root\'s first observed creation time bounds its children even after it disappears',()=>{
 const tracked=new Map([[ROOT,at(START+100)]]);
 const older=proc(6000,ROOT,START-60000,'stale.exe');
 const younger=proc(6001,ROOT,START+300,'child.exe');
 const found=descendants([older,younger],ROOT,tracked,{bornAfter:null});
 assert.deepEqual(found.map(p=>p.pid),[6001]);
});

test('with the root still in the table the older-than-parent rule is unchanged',()=>{
 const root=proc(ROOT,1,START,'node.exe');
 const found=descendants([root,...system,proc(7000,ROOT,START+10,'child.exe')],ROOT,new Map(),{bornAfter:Date.parse(at(START))-2000});
 assert.deepEqual(found.map(p=>p.pid).sort((a,b)=>a-b),[ROOT,7000]);
});

test('a supervised run whose root exited reports quiescent, even with old system processes pointing at the root PID',async()=>{
 let rows=[...system];
 const monitor=watchProcessTree({readTable:async()=>rows,pollMs:10_000,settle:{tries:2,delayMs:1}});
 monitor.start(ROOT);
 const proof=await monitor.finish({exited:true});
 assert.equal(proof.quiescent,true,JSON.stringify(proof.remaining?.slice(0,3)));
 assert.equal(proof.tracked,0);
});

test('a genuine leftover child of the exited root still fails the proof',async()=>{
 const now=Date.now();
 const rowsAt=ms=>({pid:9000,parent:ROOT,created:new Date(now+ms).toISOString(),name:'leftover.exe'});
 const monitor=watchProcessTree({readTable:async()=>[...system,rowsAt(50)],pollMs:10_000,settle:{tries:2,delayMs:1}});
 monitor.start(ROOT);
 const proof=await monitor.finish({exited:true});
 assert.equal(proof.quiescent,false);
 assert.deepEqual(proof.remaining.map(p=>p.name),['leftover.exe']);
});

// Windows는 PowerShell 하나를 띄워 두고 조회마다 재사용한다. 그 PowerShell이 표에 끼거나,
// 쉬는 동안 Node를 붙잡거나, Node가 끝난 뒤에 남으면 안 된다.
import {spawnSync} from 'node:child_process';
import {processTable} from '../scripts/process-proof.mjs';
const PROOF=new URL('../scripts/process-proof.mjs',import.meta.url).href;
test('the reused Windows inventory process stays out of the table, does not keep Node alive and ends with it',{skip:process.platform!=='win32'&&'Windows only'},async()=>{
 const script=`const {processTable}=await import(${JSON.stringify(PROOF)});
const tables=[];for(let i=0;i<3;i++)tables.push(await processTable());
const mine=t=>t.filter(p=>p.parent===process.pid).map(p=>p.name).sort().join();
const both=await Promise.all([processTable(),processTable()]);
console.log(JSON.stringify({pid:process.pid,own:[...tables,...both].map(mine)}));`;
 const r=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:90000,windowsHide:true});
 assert.equal(r.status,0,r.stderr||'the idle inventory process kept Node alive');
 const out=JSON.parse(r.stdout);
 // Node 자신의 conhost.exe 하나는 예전부터 보인다. PowerShell이나 그 conhost가 더해지면 안 된다.
 assert.ok(out.own.every(names=>names===''||names==='conhost.exe'),JSON.stringify(out.own));
 let left=[];
 for(let i=0;i<20;i++){left=(await processTable()).filter(p=>p.parent===out.pid);if(!left.length)break;await new Promise(r=>setTimeout(r,500));}
 assert.deepEqual(left,[],'nothing started by the exited process remains');
});

import {autopilot} from '../scripts/autopilot.mjs';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
test('autopilot returns why it stopped for recovery, so a CI log shows the cause',async t=>{
 const f=fixture(t,{initialize:false});
 run(f.root,'init',{...f.brief,executor:'grok',acceptance_commands:['node -e "process.exit(1)"']});
 // 복구 단계와 사유를 직접 만들어 autopilot의 정지 반환값을 확인한다.
 const file=f.control+'/state.json';
 const fs=await import('node:fs');
 const state=JSON.parse(fs.readFileSync(file,'utf8'));
 state.phase='RECOVERY_REQUIRED';state.last_errors=['ACCEPTANCE_NOT_QUIESCENT: Supervised processes remain (x.exe pid=1 parent=2)'];
 fs.writeFileSync(file,JSON.stringify(state));
 const out=await autopilot(f.root);
 assert.equal(out.phase,'RECOVERY_REQUIRED');
 assert.match(out.last_errors[0],/ACCEPTANCE_NOT_QUIESCENT.*x\.exe pid=1/);
});
