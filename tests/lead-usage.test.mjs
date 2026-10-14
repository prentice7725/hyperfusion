import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {read,hash} from '../scripts/artifact.mjs';
import {measure} from '../scripts/metrics.mjs';
import {rememberHost,collectHostUsage,transcriptMessages} from '../scripts/lead-usage.mjs';
import {settingsSnippet} from '../scripts/lead-guard.mjs';

const sid='host-session';
const usage={input_tokens:10,output_tokens:5,cache_read_input_tokens:20,cache_creation_input_tokens:2};
const row=(id,at,extra={})=>({type:'assistant',sessionId:sid,timestamp:new Date(at).toISOString(),message:{id,model:'claude-opus-5-5',usage},...extra});
function setup(t) {
 const f=fixture(t,{initialize:false}),anchor=Date.now()-1000;
 rememberHost(f.root,{session_id:sid,hook_event_name:'UserPromptSubmit'},anchor);
 run(f.root,'init',{...f.brief,executor:'grok'});
 return {...f,anchor,transcript:path.join(f.temp,'session.jsonl')};
}
const close=f=>{f.begin();f.finish();f.review();run(f.root,'verify',{acceptance_satisfied:true,tests:[{command:'inspection',status:'pass'}]});};
const put=(f,rows)=>fs.writeFileSync(f.transcript,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
const collect=(f,at)=>collectHostUsage(f.root,{hook_event_name:'Stop',session_id:sid,transcript_path:f.transcript},{at});
const metric=f=>read(path.join(f.control,'metrics',f.brief.task_id+'.json'));

test('Stop counts planning, cache and duplicate API blocks once and persists no content',t=>{
 const f=setup(t);close(f);const at=Date.now()+100;
 put(f,[row('old',f.anchor-10),row('plan',f.anchor+10),row('plan',f.anchor+20,{message:{id:'plan',model:'claude-opus-5-5',usage:{...usage,output_tokens:7},content:[{text:'secret-content'}]}}),
  row('child',f.anchor+30,{isSidechain:true}),row('other',f.anchor+30,{sessionId:'other'}),row('later',at+1000)]);
 assert.equal(collect(f,at).tasks[0].lead_tokens,76);
 assert.equal(metric(f).lead_tokens_per_success,76);assert.equal(metric(f).claude_usage.opus,76);
 const text=fs.readFileSync(path.join(f.control,'tasks',f.brief.task_id,'lead-usage.json'),'utf8');
 assert.doesNotMatch(text,/secret-content|session\.jsonl/);assert.equal(JSON.parse(text).message_count,2);
 assert.equal(JSON.parse(text).scope,'prompt-to-terminal');
});

test('repeated Stop/SessionEnd refreshes a total without adding it twice or extending the finished window',t=>{
 const f=setup(t);close(f);const at=Date.now()+100;put(f,[row('one',f.anchor+10)]);collect(f,at);
 put(f,[row('one',f.anchor+10),row('unrelated',at+50)]);collect(f,at+1000);
 assert.equal(metric(f).lead_usage.lead_tokens,37);
 collectHostUsage(f.root,{hook_event_name:'SessionEnd',session_id:sid,transcript_path:f.transcript},{at:at+2000});
 assert.equal(metric(f).lead_usage.lead_tokens,37);
});

test('active-task usage is partial and never becomes a fabricated task total',t=>{
 const f=setup(t);put(f,[row('plan',f.anchor+10)]);
 assert.equal(collect(f,Date.now()).tasks[0].status,'partial');
 assert.equal(measure(f.root).lead_usage,null);
});

test('an explicit manual observation remains authoritative over later auto-collection',t=>{
 const f=setup(t);close(f);measure(f.root,{source:'manual full task export',lead_tokens:999,lead_model:'claude-opus-5-5'});
 put(f,[row('one',f.anchor+10)]);collect(f,Date.now()+100);
 assert.equal(metric(f).lead_usage.lead_tokens,999);assert.equal(measure(f.root).lead_usage.lead_tokens,999);
});

test('missing hook binding and wrong-session events remain unknown',t=>{
 const f=fixture(t);close(f);f.transcript=path.join(f.temp,'x.jsonl');put(f,[row('one',Date.now())]);
 assert.equal(collect(f,Date.now()+100).tasks.length,0);assert.equal(metric(f).lead_usage,null);
 const g=setup(t);close(g);put(g,[row('one',g.anchor+10)]);
 assert.equal(collectHostUsage(g.root,{hook_event_name:'Stop',session_id:'foreign',transcript_path:g.transcript}).tasks.length,0);
 assert.equal(metric(g).lead_usage,null);
});

test('malformed JSONL and unrecognized usage cannot silently create zero usage',()=>{
 assert.deepEqual(transcriptMessages('{partial',sid),[]);
 assert.throws(()=>transcriptMessages('{broken\n',sid),/INCOMPLETE/);
 const [message]=transcriptMessages(JSON.stringify(row('bad',Date.now(),{message:{id:'bad',model:'claude-opus-5-5',usage:{input_tokens:10}}})),sid);
 assert.equal(message.valid,false);
 assert.throws(()=>transcriptMessages(JSON.stringify(row('same',1))+'\n'+JSON.stringify(row('same',2,{message:{id:'same',model:'claude-sonnet-5-5',usage}})),sid),/MODEL_CONFLICT/);
});

test('observed host model switches are split by actual model without assuming target Opus',t=>{
 const f=setup(t);close(f);put(f,[row('opus',f.anchor+10),row('sonnet',f.anchor+20,{message:{id:'sonnet',model:'claude-sonnet-5-5',usage:{input_tokens:3,output_tokens:4}}})]);
 collect(f,Date.now()+100);const m=metric(f);
 assert.equal(m.lead_usage.lead_model,null);assert.equal(m.claude_usage.opus,37);assert.equal(m.claude_usage.sonnet,7);assert.equal(m.claude_total_tokens,44);
});

test('a later task cannot count the same boundary-spanning API request twice',t=>{
 const f=setup(t);close(f);put(f,[row('shared',f.anchor+10)]);collect(f,Date.now()+100);
 run(f.root,'init',{...f.brief,task_id:'second',executor:'grok'});f.brief.task_id='second';close(f);
 put(f,[row('shared',f.anchor+10),row('shared',Date.now())]);collect(f,Date.now()+1000);
 assert.equal(metric(f).lead_usage,null,'the request belongs to the first task only');
});

test('generated hooks bind sessions and collect usage on terminal/failed stops',()=>{
 const hooks=settingsSnippet().hooks;
 for(const event of ['SessionStart','UserPromptSubmit','Stop','StopFailure','SessionEnd'])assert.ok(hooks[event].some(entry=>entry.hooks.some(h=>/lead-usage\.mjs.*--hook/.test(h.command))),event);
 assert.ok(hooks.PreToolUse.some(h=>h.matcher==='Bash'));
});

test('resuming an active task in another host session preserves both session contributions',t=>{
 const f=setup(t);put(f,[row('first-session',f.anchor+10)]);collect(f,Date.now());
 rememberHost(f.root,{session_id:'resumed-session',hook_event_name:'SessionStart'},Date.now());
 close(f);
 put(f,[row('second-session',Date.now(),{sessionId:'resumed-session'})]);
 collectHostUsage(f.root,{hook_event_name:'Stop',session_id:'resumed-session',transcript_path:f.transcript},{at:Date.now()+100});
 assert.equal(metric(f).lead_usage.lead_tokens,74);
 assert.equal(Object.keys(metric(f).lead_usage.segments).length,2);
});


test('manual non-Opus host observations retain their actual Claude family',t=>{
 const f=setup(t);close(f);
 const result=measure(f.root,{source:'manual',lead_tokens:75,lead_model:'claude-sonnet-5-5'});
 assert.equal(result.claude_usage.sonnet,75);assert.equal(result.claude_usage.opus,0);
});

test('incremental transcript reads merge appended blocks and retry the unfinished last line',t=>{
 const f=setup(t);close(f);const at=Date.now()+100;
 fs.writeFileSync(f.transcript,JSON.stringify(row('one',f.anchor+10))+'\n{"type":');
 assert.equal(collect(f,at).tasks[0].status,'partial');
 assert.equal(metric(f).lead_usage,null);
 fs.writeFileSync(f.transcript,JSON.stringify(row('one',f.anchor+10))+'\n'+JSON.stringify(row('two',f.anchor+20))+'\n');collect(f,at+10);
 assert.equal(metric(f).lead_usage.lead_tokens,74);
 fs.appendFileSync(f.transcript,JSON.stringify(row('two',f.anchor+20))+'\n');collect(f,at+20);
 assert.equal(metric(f).lead_usage.lead_tokens,74);
 const cache=path.join(f.control,'host-transcripts');
 for(const name of fs.readdirSync(cache))assert.doesNotMatch(fs.readFileSync(path.join(cache,name),'utf8'),/session\.jsonl|host-session|"content"/);
});

test('subagent files contribute once, separately from the main host',t=>{
 const f=setup(t);close(f);const at=Date.now()+100;put(f,[row('main',f.anchor+10)]);
 const subdir=path.join(path.dirname(f.transcript),sid,'subagents');fs.mkdirSync(subdir,{recursive:true});
 fs.writeFileSync(path.join(subdir,'agent-one.jsonl'),JSON.stringify(row('child-only',f.anchor+20))+'\n');
 collect(f,at);collect(f,at+10);
 const m=metric(f);assert.equal(m.lead_usage.lead_tokens,74);assert.equal(m.lead_usage.subagent_tokens,37);
 assert.equal(m.lead_usage.by_role.lead.input_tokens,10);assert.equal(m.lead_usage.by_role.subagent.input_tokens,10);
 assert.equal(m.lead_weighted_usage.input_equivalent,79);
});

test('API copies in parent/subagent files dedupe globally and retain legacy message IDs',t=>{
 const f=setup(t);close(f);const at=Date.now()+100;
 put(f,[row('shared-api',f.anchor+10)]);
 const children=path.join(path.dirname(f.transcript),sid,'subagents');fs.mkdirSync(children,{recursive:true});
 fs.writeFileSync(path.join(children,'agent-copy.jsonl'),JSON.stringify(row('shared-api',f.anchor+10,{isSidechain:true}))+'\n');
 collect(f,at);assert.equal(metric(f).lead_usage.lead_tokens,37);
 const owner=read(path.join(f.control,'host-usage-owners.json'));
 assert.equal(Object.keys(owner).length,1);
 assert.equal(owner[hash('shared-api')],f.brief.task_id);
});
