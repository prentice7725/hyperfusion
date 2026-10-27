import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fixture} from './support.mjs';
import {read} from '../scripts/artifact.mjs';
import {controlPath} from '../scripts/control-dir.mjs';
import {decideAgy,normalizeAgy,agyMcpName,agyCommandPath,settingsSnippet} from '../scripts/lead-guard.mjs';
import {leadIdentity} from '../scripts/lead-host.mjs';
import {config} from '../scripts/executor-config.mjs';

const SCRIPTS=fileURLToPath(new URL('../scripts/',import.meta.url));
const raw=(f,name,args={},extra={})=>({conversationId:'agy-lead',workspacePaths:[f.root],modelName:'gemini-4-argon-high',toolCall:{name,args},...extra});
const tool=(f,name,args)=>decideAgy(raw(f,name,args),'PreToolUse');

test('agy tool names map to the shared guard inputs',()=>{
 assert.equal(agyMcpName('call_mcp_tool',{ServerName:'github',ToolName:'get_me'}),'mcp__github__get_me');
 assert.equal(agyMcpName('mcp_github_get_file_contents'),'mcp__github__get_file_contents');
 assert.equal(agyMcpName('mcp_custom_server_tool'),'mcp__unknown__custom_server_tool');
 assert.equal(agyMcpName('view_file'),null);
 const n=normalizeAgy({conversationId:'c',workspacePaths:['/w'],modelName:'m',toolCall:{name:'run_command',args:{CommandLine:'ls',Cwd:'/w/sub',BypassSandbox:true}}},'PreToolUse');
 assert.deepEqual([n.tool_name,n.tool_input.command,n.cwd,n.bypass_sandbox,n.session_id,n.hook_host],['Bash','ls','/w/sub',true,'c','antigravity']);
});

test('an agy lead cannot write, delegate or leave the sandbox during a task',t=>{
 const f=fixture(t);
 const deny=out=>out.decision==='deny';
 assert.ok(deny(tool(f,'write_to_file',{TargetFile:path.join(f.root,'a.txt')})));
 assert.ok(deny(tool(f,'replace_file_content',{})),'a write without a path is blocked');
 for(const [name,args] of [['invoke_subagent',{}],['manage_task',{Action:'send_input'}],['mcp_custom_server_tool',{}],['future_tool',{}]])assert.ok(deny(tool(f,name,args)),name);
 assert.ok(deny(tool(f,'run_command',{CommandLine:'git push origin HEAD'})));
 assert.ok(deny(tool(f,'run_command',{CommandLine:'curl https://example.com',BypassSandbox:true})));
 const bridge=`node "${path.join(SCRIPTS,'executor-bridge.mjs').replaceAll('\\','/')}" "${f.root}"`;
 assert.equal(tool(f,'run_command',{CommandLine:bridge,BypassSandbox:true}).decision,'allow');
 assert.equal(tool(f,'run_command',{CommandLine:'npm test'}).decision,'allow');
 assert.equal(tool(f,'view_file',{AbsolutePath:path.join(f.root,'a.txt')}).decision,'allow');
 // agy 1.4.7의 실제 읽기 도구 이름.
 assert.equal(tool(f,'read_file',{Path:path.join(f.root,'a.txt')}).decision,'allow');
 assert.equal(tool(f,'call_mcp_tool',{ServerName:'github',ToolName:'get_me'}).decision,'allow');
 // 저장소를 알 수 없는 호출은 관여하지 않는다.
 assert.equal(decideAgy({toolCall:{name:'write_to_file',args:{TargetFile:'rel.txt'}}},'PreToolUse').decision,'allow');
});

test('agy Stop continues once only after a normal, fully idle stop',t=>{
 const f=fixture(t);
 const stop=extra=>decideAgy({conversationId:'agy-lead',workspacePaths:[f.root],...extra},'Stop');
 assert.deepEqual(stop({terminationReason:'error',fullyIdle:true}),{decision:'stop'});
 assert.deepEqual(stop({terminationReason:'model_stop',fullyIdle:false}),{decision:'stop'});
 assert.equal(stop({terminationReason:'NO_TOOL_CALL',fullyIdle:true}).decision,'continue');
 assert.deepEqual(stop({terminationReason:'model_stop',fullyIdle:true,executionNum:2}),{decision:'stop'});
 const start=decideAgy({conversationId:'agy-lead',workspacePaths:[f.root]},'SessionStart');
 assert.match(start.injectSteps[0].systemMessage.systemMessage,/active task HF-test/);
});

test('agy hook settings, usage binding and lead identity',t=>{
 const s=settingsSnippet({host:'antigravity'});
 assert.match(s['hyperfusion-guard'].PreToolUse[0].hooks[0].command,/--host antigravity --event PreToolUse$/);
 assert.match(s['hyperfusion-guard'].Stop[0].command,/--event Stop$/);
 assert.equal(s['hyperfusion-usage'].PreToolUse[0].matcher,'run_command');
 // agy는 따옴표를 글자 그대로 넘기므로 명령에 따옴표가 없어야 하고, 공백이 든 경로는 거절한다.
 for(const hook of [s['hyperfusion-guard'].PreToolUse[0].hooks[0],s['hyperfusion-guard'].Stop[0],s['hyperfusion-usage'].SessionStart[0]]){
  assert.doesNotMatch(hook.command,/["']/);assert.match(hook.command,/^node \S+\.mjs /);
 }
 assert.equal(agyCommandPath('C:/tools/hf/scripts/lead-guard.mjs'),'C:/tools/hf/scripts/lead-guard.mjs');
 assert.throws(()=>agyCommandPath('C:/Program Files/hf/scripts/lead-guard.mjs'),/without spaces/);
 const f=fixture(t,{initialize:false});
 const usage=path.join(SCRIPTS,'lead-usage.mjs');
 const send=(event,body)=>spawnSync(process.execPath,[usage,'--hook','--host','antigravity','--event',event],{input:JSON.stringify(body),encoding:'utf8',env:process.env});
 assert.equal(send('SessionStart',{conversationId:'agy-lead',workspacePaths:[f.root],modelName:'gemini-4-argon-high'}).status,0);
 const out=send('PreToolUse',raw(f,'run_command',{CommandLine:'node x'}));
 assert.deepEqual(JSON.parse(out.stdout),{decision:'allow'});
 const row=read(controlPath(f.root,'host-session.json'));
 assert.deepEqual([row.host,row.lead_model,row.tool_name],['antigravity','gemini-4-argon-high','Bash']);
 const lead=leadIdentity(f.root,config(f.root),{env:{}});
 assert.deepEqual([lead.host,lead.family,lead.source,lead.grade,lead.enforced],['antigravity','google','host-hook','C',true]);
});
