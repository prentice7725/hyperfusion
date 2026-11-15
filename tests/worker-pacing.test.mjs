import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {read} from '../scripts/artifact.mjs';
import {controlPath} from '../scripts/control-dir.mjs';
import {validateTeam,applyTeam,draftTeam} from '../scripts/team-file.mjs';
import {checkModel} from '../scripts/adapters/antigravity.mjs';
import {runBatch} from '../tools/worker-trial-batch.mjs';
import {route} from '../scripts/router.mjs';
import {config} from '../scripts/executor-config.mjs';
import {acquirePacing,intervalMs,seatAllowed,suspensionHit,recordSuspension,suspension,clearSuspension,cachedModels,cacheModels,lastRun} from '../scripts/worker-pacing.mjs';

const temp=t=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'hf-pacing-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;};
const json=file=>JSON.parse(fs.readFileSync(file,'utf8'));
// 가짜 시계: wait가 시계를 앞으로 돌린다. 실제로 기다리지 않는다.
const clock=(start=Date.parse('2026-11-15T00:00:00Z'))=>{let t=start;const waits=[];return {now:()=>t,wait:async ms=>{waits.push(ms);t+=ms;},waits,advance:ms=>{t+=ms;}};};
const team=members=>({version:1,members});

test('a paced CLI waits out the interval after the previous run ended, then records start and end',async t=>{
 const dir=temp(t),c=clock();
 const first=await acquirePacing('agy',{interval:300000,dir,now:c.now,wait:c.wait});
 assert.equal(first.paced_ms,0);
 c.advance(60000);first.release();
 c.advance(100000);
 const second=await acquirePacing('agy',{interval:300000,dir,now:c.now,wait:c.wait});
 assert.deepEqual(c.waits,[200000],'waits the rest of 300 s counted from the end of the first run');
 assert.equal(second.paced_ms,200000);
 assert.equal(lastRun('agy',{dir}).ended_at,null);
 second.release();
 assert.ok(lastRun('agy',{dir}).ended_at);
 assert.equal(fs.existsSync(path.join(dir,'agy.lock')),false);
});

test('an interval of zero leaves no record and never waits',async t=>{
 const dir=temp(t),c=clock();
 const p=await acquirePacing('agy',{interval:0,dir,now:c.now,wait:c.wait});
 p.release();
 assert.deepEqual(c.waits,[]);assert.deepEqual(fs.readdirSync(dir),[]);
});

test('only one run of a CLI at a time: a live lock is waited for, a dead one is cleared, a foreign one stops',async t=>{
 const dir=temp(t),c=clock(),lock=path.join(dir,'agy.lock');
 // 살아 있는 주인(이 프로세스). 첫 기다림 동안 주인이 끝난다.
 fs.writeFileSync(lock,JSON.stringify({pid:process.pid,host:os.hostname()}));
 const p=await acquirePacing('agy',{interval:1000,dir,now:c.now,pollMs:2000,wait:async ms=>{await c.wait(ms);fs.rmSync(lock);}});
 assert.deepEqual(c.waits,[2000]);p.release();
 // 죽은 주인: 치우고, 끝난 시각이 없던 기록은 치운 시각으로 닫는다.
 fs.writeFileSync(path.join(dir,'agy.json'),JSON.stringify({cli:'agy',started_at:'2026-11-15T00:00:00Z',ended_at:null}));
 fs.writeFileSync(lock,JSON.stringify({pid:2147483646,host:os.hostname()}));
 const c2=clock(Date.parse('2026-11-15T01:00:00Z'));
 const q=await acquirePacing('agy',{interval:1000,dir,now:c2.now,wait:c2.wait});
 assert.deepEqual(c2.waits,[1000],'the cleanup time counts as the end of the dead run');q.release();
 fs.writeFileSync(lock,JSON.stringify({pid:1,host:'other-host'}));
 await assert.rejects(acquirePacing('agy',{interval:1000,dir,now:c.now,wait:c.wait}),/PACING_LOCK_FOREIGN/);
});

test('an interrupted or over-deadline wait starts nothing and releases the lock',async t=>{
 const dir=temp(t),c=clock();
 (await acquirePacing('agy',{interval:300000,dir,now:c.now,wait:c.wait})).release();
 const ac=new AbortController();
 await assert.rejects(acquirePacing('agy',{interval:300000,dir,now:c.now,signal:ac.signal,wait:async()=>{ac.abort();throw Object.assign(Error('PACING_ABORTED'),{code:'PACING_ABORTED'});}}),/PACING_ABORTED/);
 assert.equal(fs.existsSync(path.join(dir,'agy.lock')),false);
 assert.ok(lastRun('agy',{dir}).ended_at,'the aborted wait did not write a new start');
 await assert.rejects(acquirePacing('agy',{interval:300000,dir,now:c.now,wait:c.wait,deadline:c.now()+60000}),/PACING_DEADLINE/);
 assert.equal(fs.existsSync(path.join(dir,'agy.lock')),false);
});

test('the interval is counted per CLI, taking the largest value among its workers',()=>{
 const configuration={team:{min_interval_s:{sonnet:60,haiku:120,antigravity:300}}};
 assert.equal(intervalMs(configuration,'sonnet'),120000);
 assert.equal(intervalMs(configuration,'antigravity'),300000);
 assert.equal(intervalMs(configuration,'grok'),0);
 assert.equal(intervalMs({},'antigravity'),0);
});

test('the team file validates seats and intervals',()=>{
 const bad=[
  [{antigravity:{enabled:true,seats:['code']}},/seats must be/],
  [{antigravity:{enabled:true,seats:[]}},/seats must be/],
  [{antigravity:{enabled:true,seats:['implement','implement']}},/seats must be/],
  [{antigravity:{enabled:false,seats:['implement']}},/disabled member/],
  [{antigravity:{enabled:true,min_interval_s:3601}},/min_interval_s/],
  [{antigravity:{enabled:true,min_interval_s:1.5}},/min_interval_s/],
 ];
 for(const [members,why] of bad)assert.throws(()=>validateTeam(team(members)),why);
 assert.throws(()=>validateTeam({...team({grok:{enabled:true,seats:['implement']}}),reviewers:['grok']}),/review seat/);
 assert.doesNotThrow(()=>validateTeam(team({antigravity:{enabled:true,seats:['implement'],min_interval_s:300}})));
});

test('seats narrow the implementing and reviewing lists, and the effect is recorded for init',()=>{
 const v={external:{default:'auto',available:['terra','grok','antigravity']},executors:{},review:{reviewers:['sol','grok','antigravity']}};
 const effect=applyTeam(v,team({terra:{enabled:true},grok:{enabled:true,seats:['review']},antigravity:{enabled:true,seats:['implement'],min_interval_s:300},sol:{enabled:true}}),{file:'team.json'});
 assert.deepEqual(v.external.available,['terra','antigravity']);
 assert.deepEqual(v.review.reviewers,['sol','grok']);
 assert.deepEqual(effect.seats,{grok:['review'],antigravity:['implement']});
 assert.deepEqual(effect.min_interval_s,{antigravity:300});
 const configuration={team:effect};
 assert.equal(seatAllowed(configuration,'antigravity','consult'),false);
 assert.equal(seatAllowed(configuration,'terra','consult'),true);
});

test('a new team file starts antigravity on the implement seat with a 300 s interval',()=>{
 const draft=draftTeam([{member:'antigravity',installed:true},{member:'grok',installed:true}],{review:{reviewers:['grok']}});
 assert.deepEqual(draft.members.antigravity.seats,['implement']);
 assert.equal(draft.members.antigravity.min_interval_s,300);
 assert.equal(draft.members.grok.seats,undefined);
 assert.doesNotThrow(()=>validateTeam(draft));
});

test('suspension notices are recorded once, read from any repository and cleared only on purpose',t=>{
 const dir=temp(t);
 assert.equal(suspensionHit('agy','all good'),null);
 assert.equal(suspensionHit('grok','disabled in this account for violation of Terms of Service'),null,'phrases are per CLI');
 const line=suspensionHit('agy','x\nError 403: disabled in this account for violation of Terms of Service\ny');
 assert.match(line,/Terms of Service/);
 const first=recordSuspension('agy',line,{task:'T1'},{dir});
 recordSuspension('agy','later line',{task:'T2'},{dir});
 assert.equal(suspension('agy',{dir}).task,'T1');assert.equal(first.task,'T1');
 assert.equal(clearSuspension('agy',{dir}),true);assert.equal(suspension('agy',{dir}),null);
 assert.equal(clearSuspension('agy',{dir}),false);
});

// agy models 조회 수를 세는 가짜 CLI.
function countingAgy(t,{stdout='gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)',stderr='',code=0}={}) {
 const dir=temp(t),script=path.join(dir,'agy.cjs'),count=path.join(dir,'count');
 fs.writeFileSync(script,`require('fs').appendFileSync(${JSON.stringify(count)},'x');process.stdout.write(${JSON.stringify(stdout)});process.stderr.write(${JSON.stringify(stderr)});process.exit(${code});`);
 return {cli:{executable:process.execPath,prefix_args:[script]},calls:()=>fs.existsSync(count)?fs.readFileSync(count,'utf8').length:0};
}
const withPacingDir=(t,dir)=>{const old=process.env.HF_PACING_DIR;process.env.HF_PACING_DIR=dir;t.after(()=>{if(old===undefined)delete process.env.HF_PACING_DIR;else process.env.HF_PACING_DIR=old;});};

test('agy models runs only when something is about to launch, and its list is shared for six hours',t=>{
 const dir=temp(t);withPacingDir(t,dir);
 const agy=countingAgy(t);
 assert.equal(checkModel(agy.cli,'gemini-4-hydrogen-high',{fresh:false}).status,'unverified');
 assert.equal(agy.calls(),0,'a check that launches nothing does not ask the server');
 assert.equal(checkModel(agy.cli,'gemini-4-hydrogen-high').status,'listed');
 assert.equal(agy.calls(),1);
 assert.equal(checkModel(agy.cli,'gemini-4-hydrogen-high',{fresh:false}).source,'cache');
 assert.equal(checkModel(agy.cli,'gemini-4-hydrogen-high').source,'cache');
 assert.equal(agy.calls(),1,'the cached list is reused even before a launch');
 assert.throws(()=>checkModel(agy.cli,'gemini-9-unknown'),/MODEL_UNLISTED/);
 assert.equal(agy.calls(),2,'a model missing from the cache is looked up once more');
 assert.equal(cachedModels('agy',{dir,now:()=>Date.now()+7*3600000}),null,'the list expires after six hours');
});

test('a suspension notice from agy models blocks agy before any round runs',t=>{
 const dir=temp(t);withPacingDir(t,dir);
 const agy=countingAgy(t,{stdout:'',stderr:'Error 403: disabled in this account for violation of Terms of Service',code:1});
 assert.throws(()=>checkModel(agy.cli,'gemini-4-hydrogen-high'),/ACCOUNT_SUSPENDED/);
 assert.equal(suspension('agy',{dir}).source,'agy models');
 cacheModels('agy','gemini-4-hydrogen-high',{dir});
 assert.equal(checkModel(agy.cli,'gemini-4-hydrogen-high').status,'listed','a cached list still answers without a launch');
 assert.throws(()=>checkModel(agy.cli,'gemini-9-unknown'),/ACCOUNT_SUSPENDED/,'no new lookup is sent from a suspended account');
 assert.equal(agy.calls(),1);
});

test('a suspended agy round blocks agy on this machine, and the next task does not pick it',async t=>{
 const f=fixture(t,{initialize:false});run(f.root,'init',{...f.brief,executor:'antigravity'});f.begin();
 fs.writeFileSync(path.join(path.dirname(process.env.HF_AGY_BIN),'fake-mode'),'agy-suspended');
 await assert.rejects(()=>f.bridge(),/ACCOUNT_SUSPENDED: agy reported a Terms of Service suspension/);
 const record=suspension('agy');
 assert.match(record.line,/Terms of Service/);
 assert.ok(fs.readdirSync(controlPath(f.root,'tasks',f.brief.task_id)).some(x=>/^limit-failure-/.test(x)),'the round takes the usage-limit path to another worker');
 // 다른 저장소의 새 작업에서도 agy는 후보가 아니다.
 const g=fixture(t,{initialize:false});process.env.HF_PACING_DIR=path.join(f.temp,'pacing');
 assert.match(route(g.root,config(g.root),{task_kind:'ui'}).unavailable.antigravity,/ACCOUNT_SUSPENDED/);
 assert.throws(()=>{run(g.root,'init',{...g.brief,executor:'antigravity'});g.begin();},/ADAPTER_UNAVAILABLE: antigravity/);
 assert.ok(!fs.existsSync(path.join(controlPath(g.root,'tasks',g.brief.task_id),'launch-1.json')),'nothing was launched');
});

test('a paced round waits before launch and records the wait in its envelope',async t=>{
 const f=fixture(t,{initialize:false});
 const teamFile=path.join(f.temp,'team.json'),old=process.env.HF_TEAM_FILE;
 fs.writeFileSync(teamFile,JSON.stringify(team({antigravity:{enabled:true,seats:['implement'],min_interval_s:3},grok:{enabled:true},sol:{enabled:true},sonnet:{enabled:true}})));
 process.env.HF_TEAM_FILE=teamFile;t.after(()=>{if(old===undefined)delete process.env.HF_TEAM_FILE;else process.env.HF_TEAM_FILE=old;});
 run(f.root,'init',{...f.brief,executor:'antigravity'});f.begin();
 assert.deepEqual(read(controlPath(f.root,'state.json')).configuration.team.min_interval_s,{antigravity:3});
 fs.mkdirSync(process.env.HF_PACING_DIR,{recursive:true});
 fs.writeFileSync(path.join(process.env.HF_PACING_DIR,'agy.json'),JSON.stringify({cli:'agy',started_at:new Date().toISOString(),ended_at:new Date().toISOString()}));
 await f.bridge();
 const envelope=read(controlPath(f.root,'tasks',f.brief.task_id,'envelope-1.json'));
 assert.ok(envelope.paced_ms>=1000,`paced_ms ${envelope.paced_ms}`);
 assert.ok(lastRun('agy').ended_at);
});

test('a trial batch with agy arms needs --allow-agy',async t=>{
 const out=temp(t);
 const arms=[{label:'h',vendor:'google',args:['--worker','antigravity']}];
 await assert.rejects(runBatch({out,reps:1,cases:['HF-X1'],arms,commands:{execute:()=>[process.execPath,['-e','']],settle:()=>[process.execPath,['-e','']]}}),/--allow-agy/);
});

test('a member without the consult seat is skipped by automatic picks and refused when named',t=>{
 const f=fixture(t,{initialize:false});
 const teamFile=path.join(f.temp,'team.json'),old=process.env.HF_TEAM_FILE;
 fs.writeFileSync(teamFile,JSON.stringify(team({grok:{enabled:true},antigravity:{enabled:true,seats:['implement']},sol:{enabled:true},sonnet:{enabled:true}})));
 process.env.HF_TEAM_FILE=teamFile;t.after(()=>{if(old===undefined)delete process.env.HF_TEAM_FILE;else process.env.HF_TEAM_FILE=old;});
 run(f.root,'init',f.brief);f.begin();f.finish();f.review('redo',['AC1']);
 assert.throws(()=>run(f.root,'consult',{question:'Why does AC1 fail?',mode:'advisor',executors:['antigravity']}),/SEAT_POLICY: antigravity does not take consult/);
 const c=run(f.root,'consult',{question:'Why does AC1 fail?',mode:'advisor'});
 assert.ok(c.members.every(m=>m.executor!=='antigravity'));
});
