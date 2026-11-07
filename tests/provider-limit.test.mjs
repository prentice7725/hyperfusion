import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {execute,consult} from '../scripts/executor-bridge.mjs';
import {MEMBERS} from '../scripts/member-registry.mjs';
import {limitHit} from '../scripts/provider-limit.mjs';
import {diagnose as codexDiagnose,parseEvents} from '../scripts/adapters/codex.mjs';
import {adapter} from '../scripts/adapters/index.mjs';

// 2026-11-07: Codex 5시간 한도가 L01 run 11 도중에 바닥났다. 한도는 재시도로 풀리지 않는데, 컨트롤러는
// 다음 라운드에도 Terra·Luna를 고르고 다음 리뷰에도 Sol을 먼저 불렀다. 한 번 걸리면 그 작업에서는 그 CLI를 쓰지 않는다.
const task=(f,name)=>path.join(f.control,'tasks',f.brief.task_id,name);
const codex=name=>MEMBERS[name]?.binary==='codex';

test('limit wording from Codex, Claude, OpenAI, xAI and Gemini is recognized; ordinary words are not',()=>{
 for(const text of ["You've hit your usage limit. Try again in 4 hours.",'Claude AI usage limit reached|1762500000','Rate limit reached for gpt-6',
  'insufficient_quota: You exceeded your current quota','429 Too Many Requests','RESOURCE_EXHAUSTED: Quota exceeded for metric','rate_limit_error','Your credit balance is too low'])
  assert.ok(limitHit(text),text);
 for(const text of ['add rate limiting to the API','the quota report is informational','Codex returned an unsuccessful turn','exited with code 1'])
  assert.equal(limitHit(text),null,text);
});

test('Codex error events carry the limit text into the failure; agent messages do not',()=>{
 const failed=[{type:'thread.started',thread_id:'0199a213-81c0-7800-8aa1-bbab2a035a53'},{type:'error',message:"You've hit your usage limit."}].map(e=>JSON.stringify(e)).join('\n');
 assert.match(codexDiagnose(failed,''),/Codex reported: You've hit your usage limit/);
 assert.throws(()=>parseEvents(failed,{}),/unsuccessful turn: You've hit your usage limit/);
 const quoted=[{type:'thread.started',thread_id:'0199a213-81c0-7800-8aa1-bbab2a035a53'},{type:'item.completed',item:{type:'agent_message',text:'429 Too Many Requests when the usage limit is reached'}}].map(e=>JSON.stringify(e)).join('\n');
 assert.equal(codexDiagnose(quoted,''),null);
});

test('a Claude error result carries the limit text; a successful result body never does',()=>{
 const sonnet=adapter('sonnet');
 assert.match(sonnet.diagnose(JSON.stringify({type:'result',is_error:true,result:'Claude AI usage limit reached|1762500000'})),/usage limit reached/);
 assert.equal(sonnet.diagnose(JSON.stringify({type:'result',is_error:false,result:'usage limit reached'})),null);
 assert.equal(sonnet.diagnose('not json'),null);
});

test('a usage limit in an implementation round moves the task off every worker on that CLI',async t=>{
 const f=fixture(t,{executor:'terra'});
 f.mode('codex-limit');
 f.begin();
 await assert.rejects(execute(f.root),/^Error: PROVIDER_LIMIT: terra hit a usage or rate limit/);
 const record=JSON.parse(fs.readFileSync(task(f,'limit-failure-1.json'),'utf8'));
 assert.equal(record.cli,'codex');assert.equal(record.executor,'terra');assert.equal(record.round,1);
 assert.equal(fs.existsSync(task(f,'sandbox-failure-1.json')),false,'a limit is not a sandbox failure');
 const after=run(f.root,'recover',{token:f.state().writer.token,quiescent:true,reason:'bridge failed with PROVIDER_LIMIT; worker stopped'});
 assert.equal(after.phase,'ALTERNATIVE_REQUIRED');
 const unavailable=run(f.root,'status',{}).unavailable;
 for(const name of ['terra','luna'])assert.match(unavailable[name]??'',/PROVIDER_LIMIT/,name);
 assert.equal(unavailable.grok,undefined);
 f.mode('ok');
 const next=f.begin({executor:'auto'}).executor;
 assert.equal(codex(next),false,next);
});

test('a Codex run that only mentions limits in its own message is not treated as limited',async t=>{
 const f=fixture(t,{executor:'terra'});
 f.mode('codex-limit-quoted');
 f.begin();
 const out=await execute(f.root);
 assert.equal(out.status,'RESULT_READY');
 assert.equal(fs.readdirSync(path.dirname(task(f,'x'))).some(n=>n.startsWith('limit-failure-')),false);
});

test('a reviewer that hits its limit is skipped for the rest of the task, not just the round',async t=>{
 const f=fixture(t,{initialize:false});
 fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({review:{by:'delegate'}}));
 run(f.root,'init',{...f.brief,executor:'grok'});
 const delegate=async()=>{const c=run(f.root,'delegate-review',{});await consult(f.root,c.consult_id);return {c,out:run(f.root,'consult-finish',{quiescent:true}).review};};
 f.begin();f.finish();
 f.mode('codex-limit');
 const first=await delegate();
 assert.equal(first.c.members[0].executor,'sol');
 assert.equal(first.out.status,'reviewer_failed');
 const record=JSON.parse(fs.readFileSync(task(f,'limit-failure-consult-c1-m1.json'),'utf8'));
 assert.equal(record.cli,'codex');assert.equal(record.executor,'sol');
 // 한도가 풀린 것처럼 보여도(가짜 CLI가 다시 성공해도) 이 작업에서는 Sol을 부르지 않는다.
 f.mode('ok');
 f.review('redo',['AC1']);
 f.begin();f.finish();
 const second=await delegate();
 assert.equal(codex(second.c.members[0].executor),false,second.c.members[0].executor);
 assert.equal(second.out.status,'applied');
 assert.throws(()=>run(f.root,'delegate-review',{executors:['sol']}),/PROVIDER_LIMIT/);
});

test('a Claude worker that hits its limit is recorded the same way',async t=>{
 const f=fixture(t,{executor:'sonnet'});
 f.mode('claude-limit');
 f.begin();
 await assert.rejects(execute(f.root),/PROVIDER_LIMIT: sonnet/);
 assert.equal(JSON.parse(fs.readFileSync(task(f,'limit-failure-1.json'),'utf8')).cli,MEMBERS.sonnet.binary);
});
