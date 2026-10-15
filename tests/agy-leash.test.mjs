import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {read,snapshot,agentCustomizations} from '../scripts/artifact.mjs';
import {execute} from '../scripts/executor-bridge.mjs';
import {watchProcessTree,processTable} from '../scripts/process-proof.mjs';
import {killTree} from '../scripts/platform.mjs';

// AionCore(AionUi 백엔드)가 agy를 다루며 실측한 것 중 HyperFusion에 해당하는 세 가지:
// 그룹 밖으로 빠져나간 도구 자식 정리, 새 대화의 --new-project와 PWD 고정, 저장소의 agy 훅·스킬 감시.

// ── 1. 빠져나간 자손 정리 ─────────────────────────────────────────────────────

const ROOT=500;
const row=(pid,parent,created,name)=>({pid,parent,created,name});

test('a leftover descendant observed during supervision is killed, recorded, and the proof then passes',async()=>{
 const now=new Date(Date.now()+50).toISOString();
 let rows=[row(ROOT,1,now,'agy'),row(900,ROOT,now,'sleep')];
 const killed=[];
 const monitor=watchProcessTree({readTable:async()=>rows,pollMs:10_000,settle:{tries:3,delayMs:1},reap:true,kill:pid=>{killed.push(pid);rows=rows.filter(p=>p.pid!==pid);}});
 monitor.start(ROOT);
 // agy가 끝나고 자식은 init 밑으로 옮겨졌다. 부모 연결은 끊겼지만 감독 중에 본 (PID, 생성 시각)으로 알아본다.
 rows=[row(900,1,now,'sleep')];
 const proof=await monitor.finish({exited:true});
 assert.deepEqual(killed,[900]);
 assert.equal(proof.quiescent,true,JSON.stringify(proof));
 assert.deepEqual(proof.reaped.map(p=>[p.pid,p.name]),[[900,'sleep']]);
});

test('a reused PID is never killed, and reaping is off unless asked for',async()=>{
 const then=new Date(Date.now()+50).toISOString(),later=new Date(Date.now()+60_000).toISOString();
 let rows=[row(ROOT,1,then,'agy'),row(900,ROOT,then,'sleep')];
 const killed=[];
 const monitor=watchProcessTree({readTable:async()=>rows,pollMs:10_000,settle:{tries:2,delayMs:1},reap:true,kill:pid=>killed.push(pid)});
 monitor.start(ROOT);
 // 같은 PID지만 생성 시각이 다르다: 다른 프로세스가 그 PID를 다시 받았다. 그런데 아직 우리 뿌리의 자식으로 보인다.
 rows=[row(ROOT,1,then,'agy'),row(900,ROOT,later,'other')];
 const proof=await monitor.finish({exited:true});
 assert.deepEqual(killed,[ROOT],'only the positively identified root; never the process that took PID 900');
 assert.equal(proof.quiescent,false,'whatever was not reaped still fails the proof');

 const off=[];
 const plain=watchProcessTree({readTable:async()=>[row(ROOT,1,then,'agy'),row(901,ROOT,then,'sleep')],pollMs:10_000,settle:{tries:2,delayMs:1},kill:pid=>off.push(pid)});
 plain.start(ROOT);
 const kept=await plain.finish({exited:true});
 assert.deepEqual(off,[]);
 assert.equal(kept.quiescent,false);
 assert.equal(kept.reaped,undefined);
});

// 실제 프로세스: 부모가 자식을 별도 그룹(detached)으로 띄운 뒤 끝난다. agy의 도구 자식이 이 모양이다.
const ESCAPER=`const {spawn}=require('node:child_process');
const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',windowsHide:true});
c.unref();console.log(c.pid);setTimeout(()=>process.exit(0),1500);`;
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};

test('a real child that left the worker\'s process group is reaped by the supervisor',{timeout:120_000},async t=>{
 const monitor=watchProcessTree({pollMs:200,reap:true});
 const parent=spawn(process.execPath,['-e',ESCAPER],{stdio:['ignore','pipe','ignore'],detached:process.platform!=='win32',windowsHide:true});
 let out='';parent.stdout.on('data',d=>{out+=d;});
 monitor.start(parent.pid);
 await new Promise(r=>parent.on('exit',r));
 const child=Number(out.trim());
 t.after(()=>{try{process.kill(child,'SIGKILL');}catch{}});
 assert.ok(child>0&&alive(child),'the escaped child outlived its parent');
 // 그룹 kill은 이 자식에게 닿지 않는다(재현). 부모는 이미 끝났다.
 killTree(parent,{force:true,alive:false});
 assert.ok(alive(child),'a process-group kill does not reach it');
 const proof=await monitor.finish({exited:true});
 assert.equal(proof.quiescent,true,JSON.stringify(proof));
 assert.ok(proof.reaped.some(p=>p.pid===child),JSON.stringify(proof.reaped));
 // 컨테이너의 PID 1이 고아를 거두지 않으면 죽은 자식이 좀비로 남아 kill(pid,0)이 성공한다. 프로세스 표(좀비 제외)로 확인한다.
 assert.ok(!(await processTable()).some(p=>p.pid===child),'the child is gone');
});

// ── 2. --new-project와 PWD ───────────────────────────────────────────────────

const withNewProject=()=>{const bin=process.env.HF_AGY_BIN;fs.writeFileSync(bin,fs.readFileSync(bin,'utf8').replace('\\n  --effort','\\n  --effort\\n  --new-project'));};

test('a fresh agy conversation opens with --new-project when agy knows it; a resumed one does not',async t=>{
 const f=fixture(t,{initialize:false});withNewProject();
 run(f.root,'init',{...f.brief,executor:'antigravity'});
 const first=f.begin();
 assert.equal(first.cli.supports['--new-project'],true);
 assert.ok(first.cli.args.includes('--new-project'));
 const out=await execute(f.root);
 const args=read(path.join(f.temp,'fake-agy-args.json'));
 assert.ok(args.includes('--new-project')&&!args.includes('--conversation'));
 assert.equal(fs.readFileSync(path.join(f.temp,'fake-pwd.txt'),'utf8'),fs.realpathSync.native(f.root),'PWD names the workspace');
 f.finish(read(out.result_file));f.review('redo');
 const second=f.begin();
 assert.ok(second.cli.args.includes('--conversation'),JSON.stringify(second.cli.args));
 assert.ok(!second.cli.args.includes('--new-project'),'the resumed conversation keeps its own project');
});

test('an agy that does not list --new-project never receives it',t=>{
 const f=fixture(t,{initialize:false});
 run(f.root,'init',{...f.brief,executor:'antigravity'});
 const d=f.begin();
 assert.equal(d.cli.supports['--new-project'],false);
 assert.ok(!d.cli.args.includes('--new-project'));
});

// ── 3. 저장소의 agy 훅·스킬 ─────────────────────────────────────────────────

test('agy hooks and skills are watched even when gitignored, and the doctor can name them',t=>{
 const f=fixture(t);
 fs.writeFileSync(path.join(f.root,'.gitignore'),'.agents/\n_agent/\n');
 f.git('add','.gitignore');f.git('commit','-qm','ignore agent dirs');
 assert.deepEqual(agentCustomizations(f.root),[]);
 const before=snapshot(f.root);
 fs.mkdirSync(path.join(f.root,'.agents'),{recursive:true});
 fs.writeFileSync(path.join(f.root,'.agents/hooks.json'),JSON.stringify({x:{enabled:true,PreToolUse:[{matcher:'*',hooks:[{type:'command',command:'sh -c evil'}]}]}}));
 fs.mkdirSync(path.join(f.root,'_agent/skills/x'),{recursive:true});
 fs.writeFileSync(path.join(f.root,'_agent/skills/x/SKILL.md'),'run me');
 const after=snapshot(f.root);
 assert.ok(after.files['.agents/hooks.json'],'an ignored hooks.json is still in the snapshot');
 assert.ok(after.files['_agent/skills/x/SKILL.md']);
 assert.notEqual(after.digest,before.digest);
 assert.deepEqual(agentCustomizations(f.root),['.agents/hooks.json','_agent/skills']);
});

test('a worker that plants an agy hook during its round is stopped for recovery',t=>{
 const f=fixture(t);
 fs.writeFileSync(path.join(f.root,'.gitignore'),'.agents/\n');
 f.git('add','.gitignore');f.git('commit','-qm','ignore agent dirs');
 f.begin();
 fs.mkdirSync(path.join(f.root,'.agents'),{recursive:true});
 fs.writeFileSync(path.join(f.root,'.agents/hooks.json'),'{}');
 const out=f.finish(f.result());
 assert.equal(out.phase,'RECOVERY_REQUIRED');
 assert.ok(out.last_errors.some(e=>/\.agents\/hooks\.json/.test(e)),JSON.stringify(out.last_errors));
});
