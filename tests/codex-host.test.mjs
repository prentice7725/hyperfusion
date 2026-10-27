import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fixture} from './support.mjs';
import {read,hash} from '../scripts/artifact.mjs';
import {execute} from '../scripts/executor-bridge.mjs';
import {decide,decideStop,patchPaths,settingsSnippet,workerProcess} from '../scripts/lead-guard.mjs';
import {usageHook} from '../scripts/lead-usage.mjs';

const codex=(f,tool_name,tool_input={})=>decide({hook_event_name:'PreToolUse',tool_name,tool_input,cwd:f.root,session_id:'lead',model:'gpt-6.1-astra'},{host:'codex'});
const denied=out=>out?.hookSpecificOutput?.permissionDecision==='deny';
const withEnv=(t,values)=>{
 const old=Object.fromEntries(Object.keys(values).map(k=>[k,process.env[k]]));
 for(const [k,v] of Object.entries(values)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
 t.after(()=>{for(const [k,v] of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
};

test('apply_patch targets come from the patch body',()=>{
 const patch='*** Begin Patch\n*** Update File: src/a.js\n@@\n-x\n+y\n*** Add File: docs/new.md\n+hi\n*** Delete File: old.txt\n*** Update File: b.js\n*** Move to: c.js\n*** End Patch';
 assert.deepEqual(patchPaths(patch),['src/a.js','docs/new.md','old.txt','b.js','c.js']);
 assert.deepEqual(patchPaths(undefined),[]);
});

test('a Codex lead cannot patch, type into a shell or delegate natively during a task',t=>{
 const f=fixture(t);
 assert.ok(denied(codex(f,'apply_patch',{command:'*** Begin Patch\n*** Update File: a.txt\n*** End Patch'})));
 // 경로를 못 읽은 패치도 막는다.
 assert.ok(denied(codex(f,'apply_patch',{command:'garbage'})));
 for(const tool of ['write_stdin','spawn_agent','collaborationspawn_agent','Agent','some_future_tool'])assert.ok(denied(codex(f,tool)),tool);
 assert.ok(denied(codex(f,'write_stdin',{session_id:1,chars:'git push\n'})));
 // 빈 입력은 오래 도는 명령의 출력 폴링이다.
 assert.equal(codex(f,'write_stdin',{session_id:1,chars:''}),null);
 assert.equal(codex(f,'update_plan',{plan:[]}),null);
 assert.equal(codex(f,'mcp__github__get_file_contents'),null);
 assert.ok(denied(codex(f,'mcp__github__create_pull_request')));
 assert.ok(denied(codex(f,'Bash',{command:'git push origin HEAD'})));
 assert.ok(denied(codex(f,'Bash',{command:'HF_ALLOW_LEAD_GRADE=A node x'})));
 assert.equal(codex(f,'Bash',{command:'ls'}),null);
});

test('a Codex lead cannot open an interactive shell whose input would skip the hooks',t=>{
 const f=fixture(t);
 for(const command of ['pwsh','pwsh -NoProfile','& "C:\\Program Files\\PowerShell\\7\\pwsh.exe"','bash','cmd /k','node','node -i','python3','cd src && bash'])assert.ok(denied(codex(f,'Bash',{command})),command);
 for(const command of ['node -v','python --version','pwsh -Command "Get-ChildItem"','bash -c "ls"','node -e "1"','node scripts/x.mjs','cmd /c dir','npm test','echo 1 | node'])assert.equal(codex(f,'Bash',{command}),null,command);
 assert.match(codex(f,'Bash',{command:'pwsh'}).hookSpecificOutput.permissionDecisionReason,/write_stdin/);
 // 작업이 없으면 관여하지 않는다.
 const idle=fixture(t,{initialize:false});
 assert.equal(codex(idle,'Bash',{command:'pwsh'}),null);
});

test('the leased worker passes the lead guard only with the current lease marker',t=>{
 const f=fixture(t,{executor:'luna'});
 const started=f.begin();
 assert.ok(started.cli.args.join(' ').includes('-c features.hooks=false'));
 const lease=read(path.join(f.control,'locks/writer.json'));
 const patch={command:'*** Begin Patch\n*** Update File: a.txt\n*** End Patch'};
 withEnv(t,{HF_WORKER_LEASE:undefined,HF_WORKER_CONSULT:undefined});
 assert.ok(denied(codex(f,'apply_patch',patch)));
 process.env.HF_WORKER_LEASE='forged';
 assert.ok(denied(codex(f,'apply_patch',patch)));
 process.env.HF_WORKER_LEASE=hash(String(lease.token));
 assert.equal(codex(f,'apply_patch',patch),null);
 assert.equal(workerProcess(lease,null,{HF_WORKER_LEASE:hash(String(lease.token))}),true);
 assert.equal(workerProcess({...lease,owner:'lead'},null,{HF_WORKER_LEASE:hash(String(lease.token))}),false);
});

test('the bridge marks worker processes with the lease hash',async t=>{
 const f=fixture(t);
 f.begin();
 await execute(f.root);
 assert.ok(read(path.join(f.temp,'fake-env.json')).includes('HF_WORKER_LEASE'));
});

test('Codex Stop is blocked once per turn so the session can still end',t=>{
 const f=fixture(t);
 const stop=turn_id=>decideStop({hook_event_name:'Stop',cwd:f.root,session_id:'lead',turn_id},{host:'codex'});
 assert.equal(stop('turn-1').decision,'block');
 assert.equal(stop('turn-1'),null);
 assert.equal(stop('turn-2').decision,'block');
});

test('Codex hook settings and usage collection',t=>{
 const s=settingsSnippet({host:'codex'}).hooks;
 assert.equal(s.PreToolUse[0].matcher,'.*');assert.match(s.PreToolUse[0].hooks[0].command,/lead-guard\.mjs" --host codex$/);
 assert.match(s.PreToolUse[1].hooks[0].command,/lead-usage\.mjs" --hook --host codex$/);
 assert.equal(s.UserPromptSubmit[0].hooks.some(h=>/lead-guard/.test(h.command)),false);
 assert.throws(()=>settingsSnippet({host:'emacs'}),/host must be one of/);
 const f=fixture(t);
 assert.equal(usageHook({hook_event_name:'Stop',cwd:f.root,session_id:'lead',hook_host:'codex'}).status,'unsupported-host');
});
