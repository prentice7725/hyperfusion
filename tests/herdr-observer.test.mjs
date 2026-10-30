import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fixture} from './support.mjs';
import {execute} from '../scripts/executor-bridge.mjs';
import {openMonitor} from '../scripts/worker-monitor.mjs';
import {herdrEnabled,shQuote,psQuote,cmdQuote,shellKind,viewCommand,attachObserverPane,setHerdrRunner,resetHerdrLayout,readWorkerView,formatWorkerView,clean,ownerAlive,layoutFile,fit} from '../scripts/herdr-observer.mjs';

// pane 배치 기록은 상태 폴더에 남는다. 사용자의 실제 ~/.hyperfusion을 건드리지 않게 이 파일 전용 폴더를 쓴다.
const STATE=fs.mkdtempSync(path.join(os.tmpdir(),'hf-herdr-state-'));
process.env.HF_STATE_DIR=STATE;
process.on('exit',()=>{try{fs.rmSync(STATE,{recursive:true,force:true});}catch{}});
const OBSERVER=fileURLToPath(new URL('../scripts/herdr-observer.mjs',import.meta.url));
const ENV={HYPERFUSION_HERDR:'1',HERDR_PANE_ID:'w1:p1'};
const fakeHerdr=(calls,{fail=null,shell='pwsh.exe'}={})=>async(bin,args)=>{
 calls.push([bin,...args]);
 if(fail&&args[1]===fail)throw Object.assign(Error('boom'),{stderr:'herdr down'});
 if(args[1]==='get')return JSON.stringify({result:{pane:{pane_id:args[2]}}});
 if(args[1]==='process-info')return JSON.stringify({result:{process_info:{shell_pid:7,foreground_processes:[{pid:7,name:shell}]}}});
 if(args[1]==='split')return JSON.stringify({result:{pane:{pane_id:`w1:p${calls.length+1}`}}});
 return '{}';
};
test.afterEach(()=>{setHerdrRunner(null);resetHerdrLayout();fs.rmSync(path.join(STATE,'herdr'),{recursive:true,force:true});});

test('HYPERFUSION_HERDR is auto when unset, always off at 0 and forced at 1',()=>{
 const pane={HERDR_PANE_ID:'w1:p1'};
 // 자동: Herdr pane 안이면 켜고 밖이면 조용히 끈다(forced가 아니라 기록도 남기지 않는다).
 assert.deepEqual(herdrEnabled(pane),{enabled:true,forced:false,reason:null});
 assert.deepEqual(herdrEnabled({...pane,HYPERFUSION_HERDR:''}),{enabled:true,forced:false,reason:null});
 const outside=herdrEnabled({});
 assert.equal(outside.enabled,false);assert.equal(outside.forced,false);
 // 0: pane 안이어도 항상 끈다.
 const off=herdrEnabled({...pane,HYPERFUSION_HERDR:'0'});
 assert.equal(off.enabled,false);assert.equal(off.forced,false);assert.match(off.reason,/HYPERFUSION_HERDR=0/);
 // 1: pane 안이면 켜고, 밖이면 켜지지 않지만 사유를 남기도록 forced로 알린다.
 assert.equal(herdrEnabled(ENV).enabled,true);
 const forced=herdrEnabled({HYPERFUSION_HERDR:'1'});
 assert.equal(forced.enabled,false);assert.equal(forced.forced,true);assert.match(forced.reason,/HERDR_PANE_ID missing/);
 // 알 수 없는 값은 켜지 않는다.
 const bad=herdrEnabled({...pane,HYPERFUSION_HERDR:'true'});
 assert.equal(bad.enabled,false);assert.equal(bad.forced,false);
});

test('a dead or missing current pane skips the observer before any split',async()=>{
 const calls=[];
 setHerdrRunner(async(bin,args)=>{calls.push([bin,...args]);return JSON.stringify({error:{code:'pane_not_found',message:'pane w1:p1 not found'}});});
 const r=await attachObserverPane({dir:'/d',tag:'1',env:ENV,platform:'linux'});
 assert.equal(r.attached,false);
 assert.match(r.reason,/not alive/);
 assert.deepEqual(calls.map(c=>c[2]),['get']);
 resetHerdrLayout();
 setHerdrRunner(async(bin,args)=>{calls.push([bin,...args]);throw Object.assign(Error('exit 1'),{stderr:'no herdr server is running'});});
 const s=await attachObserverPane({dir:'/d',tag:'1',env:ENV,platform:'linux'});
 assert.equal(s.attached,false);
 assert.match(s.reason,/no herdr server is running/);
 assert.equal(calls.some(c=>c[2]==='split'),false);
 resetHerdrLayout();
 const bad=await attachObserverPane({dir:'/d',tag:'1',env:{...ENV,HERDR_PANE_ID:'bad id; rm'},platform:'linux'});
 assert.equal(bad.attached,false);
 assert.match(bad.reason,/usable pane id/);
});

test('pane shell kinds map to a quoting rule and unknown shells are refused',()=>{
 assert.equal(shellKind('pwsh.exe'),'powershell');
 assert.equal(shellKind(String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`),'powershell');
 assert.equal(shellKind('cmd.exe'),'cmd');
 assert.equal(shellKind('/usr/bin/bash'),'posix');
 assert.equal(shellKind('nu.exe'),null);
 assert.equal(shellKind(undefined),null);
 assert.throws(()=>viewCommand({dir:'/d',tag:'1',shell:'nu'}),/Unsupported pane shell/);
});

test('PowerShell and cmd quoting keep paths with spaces and quotes as data',()=>{
 assert.equal(psQuote("it's"),"'it''s'");
 assert.equal(psQuote('\u2018x'),"'\u2018\u2018x'");
 const ps=viewCommand({dir:String.raw`C:\Users\a b\it's`,tag:'consult-1-sol',node:String.raw`C:\Program Files\nodejs\node.exe`,script:String.raw`C:\hf\herdr-observer.mjs`,shell:'powershell'});
 assert.equal(ps,String.raw`& 'C:\Program Files\nodejs\node.exe' 'C:\hf\herdr-observer.mjs' view 'C:\Users\a b\it''s' 'consult-1-sol'`);
 const cmd=viewCommand({dir:String.raw`C:\Users\a b`,tag:'1',node:String.raw`C:\Program Files\nodejs\node.exe`,script:String.raw`C:\hf\s.mjs`,shell:'cmd'});
 assert.equal(cmd,String.raw`"C:\Program Files\nodejs\node.exe" "C:\hf\s.mjs" view "C:\Users\a b" "1"`);
 assert.throws(()=>cmdQuote('C:\\%PATH%'),/cmd\.exe/);
 assert.throws(()=>cmdQuote('a"b'),/cmd\.exe/);
});

test('Windows detects the pane shell and refuses or cleans up when it cannot quote',async()=>{
 const calls=[];setHerdrRunner(fakeHerdr(calls));
 const ok=await attachObserverPane({dir:String.raw`C:\d`,tag:'1',env:ENV,platform:'win32'});
 assert.equal(ok.attached,true);
 assert.deepEqual(calls.map(c=>c[2]),['get','split','process-info','run']);
 assert.match(calls[3][4],/^& '/);
 resetHerdrLayout();
 const bad=[];setHerdrRunner(fakeHerdr(bad,{shell:'nu.exe'}));
 const r=await attachObserverPane({dir:String.raw`C:\d`,tag:'1',env:ENV,platform:'win32'});
 assert.equal(r.attached,false);
 assert.match(r.reason,/unsupported pane shell/);
 assert.equal(bad.at(-1)[2],'close');
 assert.equal(bad.some(c=>c[2]==='run'),false);
});

test('a freshly split pane is polled until its shell has started',async()=>{
 const calls=[];let empty=2;
 setHerdrRunner(async(bin,args)=>{
  calls.push([bin,...args]);
  if(args[1]==='process-info'){
   if(empty-->0)return JSON.stringify({result:{process_info:{shell_pid:null,foreground_processes:[]}}});
   return JSON.stringify({result:{process_info:{shell_pid:7,foreground_processes:[{pid:7,name:'pwsh.exe'}]}}});
  }
  if(args[1]==='get')return JSON.stringify({result:{pane:{pane_id:args[2]}}});
  if(args[1]==='split')return JSON.stringify({result:{pane:{pane_id:'w1:p2'}}});
  return '{}';
 });
 const ok=await attachObserverPane({dir:String.raw`C:\d`,tag:'1',env:ENV,platform:'win32'});
 assert.equal(ok.attached,true);
 assert.equal(calls.filter(c=>c[2]==='process-info').length,3);
 assert.equal(calls.at(-1)[2],'run');
});

test('HERDR_BIN_PATH is used when HYPERFUSION_HERDR_BIN is unset',async()=>{
 const calls=[];setHerdrRunner(fakeHerdr(calls));
 await attachObserverPane({dir:'/d',tag:'1',env:{...ENV,HERDR_BIN_PATH:'/opt/herdr'},platform:'linux'});
 assert.equal(calls[0][0],'/opt/herdr');
 resetHerdrLayout();calls.length=0;
 await attachObserverPane({dir:'/d',tag:'1',env:{...ENV,HERDR_BIN_PATH:'/opt/herdr',HYPERFUSION_HERDR_BIN:'/x/herdr'},platform:'linux'});
 assert.equal(calls[0][0],'/x/herdr');
});

test('pane command quotes hostile paths and rejects bad tags',()=>{
 assert.equal(shQuote("a'b"),`'a'\\''b'`);
 const cmd=viewCommand({dir:"/tmp/x y'; rm -rf /",tag:'consult-1-sol',node:'/usr/bin/node',script:'/s/herdr-observer.mjs'});
 assert.equal(cmd,String.raw`'/usr/bin/node' '/s/herdr-observer.mjs' view '/tmp/x y'\''; rm -rf /' 'consult-1-sol'`);
 assert.equal(cmd.startsWith('exec'),false);
 assert.throws(()=>viewCommand({dir:'/d',tag:'a;b'}),/Invalid monitor tag/);
});

test('first worker splits the current pane, a still-running worker gets a pane stacked under it',async()=>{
 const calls=[];setHerdrRunner(fakeHerdr(calls));
 const a=await attachObserverPane({dir:'/d',tag:'1',env:ENV,platform:'linux'});
 const b=await attachObserverPane({dir:'/d',tag:'consult-1-sol',env:ENV,platform:'linux'});
 assert.equal(a.attached&&b.attached,true);
 assert.notEqual(a.pane_id,b.pane_id);
 assert.deepEqual(calls[0],['herdr','pane','get','w1:p1']);
 assert.deepEqual(calls[1],['herdr','pane','split','--current','--direction','right','--no-focus']);
 assert.equal(calls[2][1]+calls[2][2],'panerun');
 // a의 화면은 아직 끝나지 않았으므로(모니터 없음) 다시 쓰지 않고 그 아래로 쌓는다.
 const second=calls.find((c,i)=>i>2&&c[2]==='split');
 assert.deepEqual(second,['herdr','pane','split',a.pane_id,'--direction','down','--no-focus']);
 assert.equal(calls.filter(c=>c[2]==='split').length,2);
});

test('a later controller process reuses an idle observer pane instead of splitting the lead pane again',async()=>{
 const calls=[];setHerdrRunner(fakeHerdr(calls));
 const a=await attachObserverPane({dir:'/d',tag:'1',env:ENV,platform:'linux'});
 assert.equal(a.attached,true);
 // 브리지는 라운드마다 새 프로세스다. 메모리 상태를 지워도 상태 폴더의 배치 기록으로 같은 pane을 찾는다.
 resetHerdrLayout();calls.length=0;
 const b=await attachObserverPane({dir:'/d',tag:'2',env:ENV,platform:'linux'});
 assert.equal(b.attached,true);
 assert.equal(b.pane_id,a.pane_id);
 assert.equal(calls.some(c=>c[2]==='split'),false);
 assert.deepEqual(calls.map(c=>c[2]),['get','get','process-info','run']);
 assert.equal(JSON.parse(fs.readFileSync(layoutFile(ENV),'utf8')).panes.length,1);
});

test('a busy or vanished observer pane is never reused',async()=>{
 const calls=[];setHerdrRunner(fakeHerdr(calls));
 const a=await attachObserverPane({dir:'/d',tag:'1',env:ENV,platform:'linux'});
 resetHerdrLayout();calls.length=0;
 // 사용자가 그 pane에서 다른 것을 실행 중이면(셸 말고 다른 전면 프로세스) 아래로 새로 쌓는다.
 setHerdrRunner(async(bin,args)=>{
  calls.push([bin,...args]);
  if(args[1]==='process-info')return JSON.stringify({result:{process_info:{shell_pid:7,foreground_processes:[{pid:7,name:'bash'},{pid:9,name:'vim'}]}}});
  return fakeHerdr([])(bin,args);
 });
 const b=await attachObserverPane({dir:'/d',tag:'2',env:ENV,platform:'linux'});
 assert.equal(b.attached,true);
 assert.notEqual(b.pane_id,a.pane_id);
 assert.equal(calls.some(c=>c[2]==='run'&&c[3]===a.pane_id),false);
 assert.deepEqual(calls.find(c=>c[2]==='split').slice(3,6),[a.pane_id,'--direction','down']);
 // 기록된 pane이 모두 사라졌으면 리드 pane 오른쪽에서 다시 시작한다.
 resetHerdrLayout();calls.length=0;
 setHerdrRunner(async(bin,args)=>{
  calls.push([bin,...args]);
  if(args[1]==='get'&&args[2]!=='w1:p1')return JSON.stringify({error:{code:'pane_not_found'}});
  return fakeHerdr([])(bin,args);
 });
 const c=await attachObserverPane({dir:'/d',tag:'3',env:ENV,platform:'linux'});
 assert.equal(c.attached,true);
 assert.deepEqual(calls.find(x=>x[2]==='split').slice(3),['--current','--direction','right','--no-focus']);
 assert.deepEqual(JSON.parse(fs.readFileSync(layoutFile(ENV),'utf8')).panes,[c.pane_id]);
});

test('a slow herdr is cut off by the attach budget and the new pane is closed',async()=>{
 const calls=[];
 setHerdrRunner((bin,args,env,timeout)=>{
  calls.push([bin,...args,timeout]);
  if(args[1]==='process-info')return new Promise((_,reject)=>setTimeout(()=>reject(Object.assign(Error('timed out'),{stderr:''})),timeout));
  return fakeHerdr([])(bin,args);
 });
 const started=Date.now();
 const r=await attachObserverPane({dir:String.raw`C:\d`,tag:'1',env:ENV,platform:'win32',budgetMs:300});
 assert.equal(r.attached,false);
 assert.ok(Date.now()-started<2000,'attach stopped near its budget');
 // 예산을 넘긴 호출은 남은 시간만큼만 기다렸다.
 assert.ok(calls.filter(c=>c[2]==='process-info').every(c=>c.at(-1)<=300));
 assert.equal(calls.at(-1)[2],'close');
});

test('herdr failures and unusable pane ids are reported, never thrown',async()=>{
 setHerdrRunner(fakeHerdr([],{fail:'split'}));
 const r=await attachObserverPane({dir:'/d',tag:'1',env:ENV,platform:'linux'});
 assert.equal(r.attached,false);
 assert.match(r.reason,/herdr down/);
 resetHerdrLayout();
 setHerdrRunner(async(bin,args)=>args[1]==='get'?JSON.stringify({result:{pane:{pane_id:args[2]}}}):JSON.stringify({result:{pane:{pane_id:'bad id; rm'}}}));
 const unusable=await attachObserverPane({dir:'/d',tag:'1',env:ENV,platform:'linux'});
 assert.equal(unusable.attached,false);
 assert.match(unusable.reason,/no usable pane id/);
 resetHerdrLayout();
 setHerdrRunner(async()=>'not json');
 assert.equal((await attachObserverPane({dir:'/d',tag:'1',env:ENV,platform:'linux'})).attached,false);
});

test('worker-controlled text cannot inject terminal escape sequences',()=>{
 assert.equal(clean('a\x1b]52;c;ZXZpbA==\x07b'),'a?]52;c;ZXZpbA==?b');
 assert.equal(clean('x‮y\x9bz\r\n'),'x?y?z??');
 const view={executor:'grok\x1b[2J',role:'implement',task_id:'HF\x1b]0;pwned\x07',round:1,state:'RUNNING\x1b[31m',elapsed_ms:1000};
 const events=[{at:'2026-10-30T00:00:00.000Z',kind:'diagnostic\x1b[8m',detail:'\x1b]8;;http://x\x07click\x1b]8;;\x07'}];
 const text=formatWorkerView({view,events},'1');
 assert.equal(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(text),false);
});

test('view lines fit a narrow pane instead of wrapping',()=>{
 assert.equal(fit('abcdef',0),'abcdef');
 assert.equal(fit('abcdef',6),'abcdef');
 assert.equal(fit('abcdef',4),'abc…');
 // 한글은 두 칸이라 4칸에는 한 글자와 …만 들어간다.
 assert.equal(fit('가나다',4),'가…');
 assert.equal(fit('가나',4),'가나');
 const view={executor:'grok',role:'implement',task_id:'HF-x',round:1,state:'RUNNING',elapsed_ms:11000};
 const events=[{at:'2026-10-30T00:00:00.000Z',kind:'diagnostic',detail:'herdr pane w6:p4 attached'}];
 const text=formatWorkerView({view,events},'1',Date.now(),12);
 for(const line of text.split('\n'))assert.ok([...line].length<=12,line);
 assert.match(text,/^HyperFusion…$/m);
 assert.match(text,/^state: RUNN…$/m);
 assert.match(formatWorkerView({view:null,events:[]},'1',Date.now(),12),/^waiting for…$/m);
});

test('view command carries the controller pid and the view stops when that process is gone',t=>{
 assert.match(viewCommand({dir:'/d',tag:'1',owner:4242,node:'/n',script:'/s'}),/ view '\/d' '1' '4242'$/);
 assert.throws(()=>viewCommand({dir:'/d',tag:'1',owner:-1}),/owner pid/);
 assert.equal(ownerAlive(process.pid),true);
 // 끝난 프로세스의 PID로 화면을 띄우면, 모니터가 끝나지 않았어도 바로 멈춰야 한다.
 const gone=spawnSync(process.execPath,['-e','0']).pid;
 assert.equal(ownerAlive(gone),false);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'herdr-owner-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const r=spawnSync(process.execPath,[OBSERVER,'view',dir,'1',String(gone)],{encoding:'utf8',timeout:10000,windowsHide:true});
 assert.equal(r.error,undefined);
 assert.equal(r.status,0);
 assert.match(r.stdout,/controller process ended without a final worker state/);
});

test('disabled observer never calls herdr',async()=>{
 const calls=[];setHerdrRunner(fakeHerdr(calls));
 const r=await attachObserverPane({dir:'/d',tag:'1',env:{},platform:'linux'});
 assert.equal(r.attached,false);
 assert.equal(calls.length,0);
});

test('worker view reads one monitor and ends only on an observed exit',t=>{
 const dir=fs.mkdtempSync(path.join(fs.realpathSync(process.env.TEMP??'/tmp'),'herdr-view-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 assert.match(formatWorkerView(readWorkerView(dir,'1'),'1'),/waiting for the worker/);
 const identity={task_id:'HF-x',round:1,run_id:'r1',executor:'grok',role:'implement'};
 const m=openMonitor({dir,tag:'1',identity});
 m.started();
 let data=readWorkerView(dir,'1');
 assert.equal(data.done,false);
 const text=formatWorkerView(data,'1');
 assert.match(text,/grok · implement · task HF-x round 1/);
 assert.match(text,/not an acceptance or success verdict/);
 assert.match(text,/process_started/);
 m.exit({code:0,signal:''});
 data=readWorkerView(dir,'1');
 assert.equal(data.done,true);
 assert.equal(data.view.state,'EXITED');
 assert.throws(()=>readWorkerView(dir,'../x'),/Invalid monitor tag/);
});

test('bridge opens an observer pane per worker and leaves the result untouched',{},async t=>{
 const calls=[];setHerdrRunner(fakeHerdr(calls));
 const saved={h:process.env.HYPERFUSION_HERDR,p:process.env.HERDR_PANE_ID};
 process.env.HYPERFUSION_HERDR='1';process.env.HERDR_PANE_ID='w1:p1';
 t.after(()=>{for(const [k,v] of [['HYPERFUSION_HERDR',saved.h],['HERDR_PANE_ID',saved.p]]){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
 const f=fixture(t);
 f.begin();
 const out=await execute(f.root);
 assert.equal(out.status,'RESULT_READY');
 assert.equal(f.state().phase,'EXECUTING');
 const run=calls.find(c=>c[2]==='run');
 assert.ok(run,'pane run was called');
 assert.match(run[4],/herdr-observer\.mjs' view '.+' '1' '\d+'$/);
 const dir=path.join(f.control,'tasks',f.brief.task_id);
 assert.match(fs.readFileSync(path.join(dir,'activity-1.ndjson'),'utf8'),/herdr pane w1:p\d+ attached/);
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'monitor-1.json'),'utf8')).declares_success,false);
});

test('bridge round still succeeds when herdr is broken',{},async t=>{
 setHerdrRunner(fakeHerdr([],{fail:'split'}));
 const saved={h:process.env.HYPERFUSION_HERDR,p:process.env.HERDR_PANE_ID};
 process.env.HYPERFUSION_HERDR='1';process.env.HERDR_PANE_ID='w1:p1';
 t.after(()=>{for(const [k,v] of [['HYPERFUSION_HERDR',saved.h],['HERDR_PANE_ID',saved.p]]){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
 const f=fixture(t);
 f.begin();
 const out=await execute(f.root);
 assert.equal(out.status,'RESULT_READY');
 const dir=path.join(f.control,'tasks',f.brief.task_id);
 assert.match(fs.readFileSync(path.join(dir,'activity-1.ndjson'),'utf8'),/herdr pane skipped/);
});

// 브리지가 보는 환경은 process.env라 시험마다 값을 넣었다가 되돌린다. undefined는 변수를 지운다.
function bridgeEnv(t,vars){
 const saved={};
 for(const [k,v] of Object.entries(vars)){saved[k]=process.env[k];if(v===undefined)delete process.env[k];else process.env[k]=v;}
 t.after(()=>{for(const [k,v] of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
}
async function bridgeRound(t,vars,runner){
 const calls=[];setHerdrRunner(runner(calls));
 bridgeEnv(t,vars);
 const f=fixture(t);
 f.begin();
 const out=await execute(f.root);
 const note=fs.readFileSync(path.join(f.control,'tasks',f.brief.task_id,'activity-1.ndjson'),'utf8');
 return {out,calls,note};
}

test('bridge auto-detects Herdr when HYPERFUSION_HERDR is unset',{},async t=>{
 const {out,calls,note}=await bridgeRound(t,{HYPERFUSION_HERDR:undefined,HERDR_PANE_ID:'w1:p1'},fakeHerdr);
 assert.equal(out.status,'RESULT_READY');
 assert.ok(calls.some(c=>c[2]==='run'),'pane run was called');
 assert.match(note,/herdr pane w1:p\d+ attached/);
});

test('bridge stays silent outside Herdr in auto mode',{},async t=>{
 const {out,calls,note}=await bridgeRound(t,{HYPERFUSION_HERDR:undefined,HERDR_PANE_ID:undefined},fakeHerdr);
 assert.equal(out.status,'RESULT_READY');
 assert.equal(calls.length,0);
 assert.doesNotMatch(note,/herdr/);
});

test('HYPERFUSION_HERDR=0 keeps the observer off inside a Herdr pane',{},async t=>{
 const {out,calls,note}=await bridgeRound(t,{HYPERFUSION_HERDR:'0',HERDR_PANE_ID:'w1:p1'},fakeHerdr);
 assert.equal(out.status,'RESULT_READY');
 assert.equal(calls.length,0);
 assert.doesNotMatch(note,/herdr/);
});

test('HYPERFUSION_HERDR=1 outside Herdr records why the pane was skipped',{},async t=>{
 const {out,calls,note}=await bridgeRound(t,{HYPERFUSION_HERDR:'1',HERDR_PANE_ID:undefined},fakeHerdr);
 assert.equal(out.status,'RESULT_READY');
 assert.equal(calls.length,0);
 assert.match(note,/herdr pane skipped: HYPERFUSION_HERDR=1 but not running inside a Herdr pane/);
});
