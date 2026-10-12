import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {statusLine,readStatusLine} from '../scripts/status-line.mjs';
import {decideUserPrompt,settingsSnippet} from '../scripts/lead-guard.mjs';

const STATE=fileURLToPath(new URL('../scripts/fusion-state.mjs',import.meta.url));
const GUARD=fileURLToPath(new URL('../scripts/lead-guard.mjs',import.meta.url));

test('the status line names the task, phase, worker round use and next step',t=>{
 const f=fixture(t,{initialize:false});
 assert.equal(readStatusLine(f.root),'','no task, no line');
 run(f.root,'init',{...f.brief,executor:'grok'});
 assert.equal(readStatusLine(f.root),'HF ▸ HF-test │ PLAN 시작 대기 │ 다음 begin');
 f.begin();
 assert.match(readStatusLine(f.root),/EXECUTING 일꾼 실행 중 │ grok 1\/3 │ 다음 run the bridge/);
 f.finish();
 assert.match(readStatusLine(f.root),/REVIEW 리뷰 차례 │ grok 1\/3 │ 다음 review or delegate-review/);
});

test('the line says so when a worker reached its round cap, and shows an open consult',()=>{
 const base={task_id:'T',phase:'REDO',owner:'grok',attempts:{grok:3}};
 assert.match(statusLine(base),/grok 3\/3 상한/);
 assert.match(statusLine({...base,owner:'sol',apex_rounds:3}),/sol 3\/3 상한/);
 assert.match(statusLine({...base,attempts:{grok:1},open_consult:{id:'c1'}}),/grok 1\/3 │ 상담 열림 │ 다음 consult-finish/);
 assert.match(statusLine({task_id:'T',phase:'PLAN'}),/^HF ▸ T │ PLAN 시작 대기 │ 다음 begin$/,'no owner yet');
 assert.equal(statusLine({task_id:'T',phase:'CLOSE',owner:'grok'}),'','finished tasks show nothing');
 assert.equal(statusLine(null),'');assert.equal(statusLine({}),'');
});

test('a task that closed, or state that cannot be read, shows nothing and never throws',t=>{
 const f=fixture(t);
 f.begin();f.finish();f.review('pass');run(f.root,'verify',{acceptance_satisfied:true,tests:[{command:'npm test',status:'pass'}]});
 assert.equal(f.state().phase,'CLOSE');
 assert.equal(readStatusLine(f.root),'');
 fs.writeFileSync(path.join(f.control,'state.json'),'{broken');
 assert.equal(readStatusLine(f.root),'');
});

test('the line command prints the line without taking the controller lock',t=>{
 const f=fixture(t,{initialize:false});
 const line=()=>execFileSync(process.execPath,[STATE,'line',f.root],{encoding:'utf8'});
 assert.equal(line(),'','no task prints nothing');
 run(f.root,'init',{...f.brief,executor:'grok'});
 assert.equal(line(),'HF ▸ HF-test │ PLAN 시작 대기 │ 다음 begin\n');
 fs.mkdirSync(path.join(f.control,'locks'),{recursive:true});
 fs.writeFileSync(path.join(f.control,'locks/control.lock'),'held');
 assert.match(line(),/PLAN/,'a held lock does not block a read-only view');
});

test('the UserPromptSubmit hook shows the line to the user only, from any folder of the repository',t=>{
 const f=fixture(t,{initialize:false});
 const prompt=cwd=>decideUserPrompt({hook_event_name:'UserPromptSubmit',cwd,prompt:'hi'});
 assert.equal(prompt(f.root),null,'no task');
 run(f.root,'init',{...f.brief,executor:'grok'});
 const out=prompt(f.root);
 assert.deepEqual(Object.keys(out),['systemMessage'],'a display message only: nothing goes into the model context');
 assert.match(out.systemMessage,/^HF ▸ HF-test/);
 fs.mkdirSync(path.join(f.root,'sub'));
 assert.equal(prompt(path.join(f.root,'sub')).systemMessage,out.systemMessage);
 const viaHook=JSON.parse(execFileSync(process.execPath,[GUARD],{input:JSON.stringify({hook_event_name:'UserPromptSubmit',cwd:f.root,prompt:'hi'}),encoding:'utf8'}));
 assert.equal(viaHook.systemMessage,out.systemMessage);
 const entry=settingsSnippet().hooks.UserPromptSubmit[0];
 assert.match(entry.hooks[0].command,/lead-guard\.mjs"$/);
 assert.equal(entry.matcher,undefined,'every prompt');
 fs.writeFileSync(path.join(f.control,'state.json'),'{broken');
 assert.equal(prompt(f.root),null,'unreadable state never blocks a prompt');
});
