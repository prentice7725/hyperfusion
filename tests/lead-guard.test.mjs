import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {decide,decideStop,settingsSnippet} from '../scripts/lead-guard.mjs';

const SCRIPT=fileURLToPath(new URL('../scripts/lead-guard.mjs',import.meta.url));
const edit=(f,file='a.txt',tool='Edit')=>decide({tool_name:tool,cwd:f.root,tool_input:{file_path:file}});
const denied=out=>out?.hookSpecificOutput?.permissionDecision==='deny';

test('lead guard leaves repositories without an active task alone',t=>{
 const f=fixture(t,{initialize:false});
 assert.equal(edit(f),null);
 run(f.root,'init',{...f.brief,executor:'grok'});
 assert.equal(edit(f,path.join(f.temp,'outside.txt')),null,'files outside the repository are not guarded');
 assert.equal(decide({tool_name:'Read',cwd:f.root,tool_input:{file_path:'a.txt'}}),null);
});

test('an acceptance marker blocks edits even if the task or takeover state was not saved',t=>{
 const f=fixture(t,{initialize:false});
 fs.mkdirSync(path.join(f.control,'locks'),{recursive:true});
 fs.writeFileSync(path.join(f.control,'locks/acceptance.json'),'{}');
 assert.ok(denied(edit(f)));assert.equal(decide({tool_name:'Read',cwd:f.root,tool_input:{file_path:'a.txt'}}),null);
});

test('lead guard blocks lead edits while a task is active and while a worker holds the lease',t=>{
 const f=fixture(t);
 const plan=edit(f,'new/file.txt','Write');
 assert.ok(denied(plan));assert.match(plan.hookSpecificOutput.permissionDecisionReason,/PLAN.*begin/);
 assert.ok(denied(decide({tool_name:'NotebookEdit',cwd:f.root,tool_input:{notebook_path:'nb.ipynb'}})));
 f.begin();
 const leased=edit(f);
 assert.ok(denied(leased));assert.match(leased.hookSpecificOutput.permissionDecisionReason,/grok.*writer lease/);
 f.finish();
 assert.ok(denied(edit(f)),'REVIEW is still the workers\' turn');
 f.review('pass');run(f.root,'verify',{acceptance_satisfied:true,tests:[{command:'npm test',status:'pass'}]});
 assert.equal(f.state().phase,'CLOSE');
 assert.equal(edit(f),null,'a closed task releases the guard');
});

test('lead guard allows edits only after takeover gives the lead the lease',t=>{
 const f=fixture(t,{initialize:false});
 fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({external:{default:'grok',available:['grok']}}));
 run(f.root,'init',{...f.brief,executor:'grok'});
 for(let i=0;i<3;i++){f.begin();f.finish();f.review('redo',['AC'+i]);}
 assert.equal(f.state().phase,'TAKEOVER_REQUIRED');
 assert.ok(denied(edit(f)),'takeover must be recorded with begin first');
 f.begin({takeover_reason:'grok failed three times'});
 assert.equal(edit(f),null);
});

test('lead guard fails closed on unreadable state and works as a hook process',t=>{
 const f=fixture(t);
 const input=JSON.stringify({tool_name:'Edit',cwd:f.root,tool_input:{file_path:'a.txt'}});
 const out=JSON.parse(execFileSync(process.execPath,[SCRIPT],{input,encoding:'utf8',env:process.env}));
 assert.ok(denied(out));
 fs.writeFileSync(path.join(f.control,'state.json'),'{broken');
 assert.match(edit(f).hookSpecificOutput.permissionDecisionReason,/읽을 수 없어/);
 assert.equal(execFileSync(process.execPath,[SCRIPT],{input:'not json',encoding:'utf8',stdio:['pipe','pipe','pipe']}),'');
 const hook=settingsSnippet().hooks.PreToolUse[0];
 assert.equal(hook.matcher,'Edit|Write|MultiEdit|NotebookEdit');assert.match(hook.hooks[0].command,/lead-guard\.mjs"$/);
 assert.equal(settingsSnippet().hooks.Stop[0].hooks[0].command,hook.hooks[0].command);
});

const stop=(f,extra={})=>decideStop({hook_event_name:'Stop',cwd:f.root,stop_hook_active:false,...extra});
test('the Stop hook keeps the lead from ending its turn on a task that waits for the lead',t=>{
 const f=fixture(t,{initialize:false});
 assert.equal(stop(f),null,'no task');
 run(f.root,'init',{...f.brief,executor:'grok'});
 const plan=stop(f);
 assert.equal(plan.decision,'block');assert.match(plan.reason,/PLAN.*begin/);
 assert.equal(stop(f,{stop_hook_active:true}),null,'a second stop goes through');
 fs.mkdirSync(path.join(f.root,'sub'));
 assert.equal(stop(f,{cwd:path.join(f.root,'sub')}).decision,'block','a subfolder finds the repository');
 f.begin();
 assert.equal(stop(f),null,'a worker is executing');
 f.finish();
 assert.match(stop(f).reason,/REVIEW/);
 f.review('pass');
 assert.match(stop(f).reason,/VERIFY.*verify/);
 run(f.root,'verify',{acceptance_satisfied:true,tests:[{command:'npm test',status:'pass'}]});
 assert.equal(stop(f),null,'closed');
 assert.equal(decideStop({cwd:f.temp,stop_hook_active:false}),null,'outside a repository');
});

test('the Stop hook lets user-facing phases end and runs as a hook process',t=>{
 const f=fixture(t,{initialize:false});
 fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({external:{default:'grok',available:['grok']}}));
 run(f.root,'init',{...f.brief,executor:'grok'});
 for(let i=0;i<3;i++){f.begin();f.finish();f.review('redo',['AC'+i]);}
 assert.equal(f.state().phase,'TAKEOVER_REQUIRED');
 assert.equal(stop(f),null);
 const g=fixture(t);
 const out=JSON.parse(execFileSync(process.execPath,[SCRIPT],{input:JSON.stringify({hook_event_name:'Stop',cwd:g.root,stop_hook_active:false}),encoding:'utf8'}));
 assert.equal(out.decision,'block');
 fs.writeFileSync(path.join(g.control,'state.json'),'{broken');
 assert.equal(stop(g),null,'unreadable state does not trap the session');
});
