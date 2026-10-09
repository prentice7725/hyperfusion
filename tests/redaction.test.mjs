import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {redactText,redactValue,maskTransport} from '../scripts/redaction.mjs';
import {fixture} from './support.mjs';
import {execute,consult} from '../scripts/executor-bridge.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {read} from '../scripts/artifact.mjs';

const SENSITIVE='alice@example.com 192.168.10.1 2001:db8::1 password="two words" OPENAI_API_KEY=super-secret-value sk-proj-123456789012345678901234 password="sk-proj-123456789012345678901234 additional-secret" password="[REDACTED:secret]still-secret"';

test('partial masks and user-supplied placeholders never exempt the rest of a secret assignment',()=>{
 for(const value of ['sk-proj-123456789012345678901234 additional-secret','[REDACTED:secret]still-secret',
  'Bearer abcDEF123 additional-secret','[REDACTED:anything]still-secret']){
  for(const quote of ['"',"'"]){
   const masked=redactText(`password=${quote}${value}${quote}`);
   assert.equal(masked,`password=${quote}[REDACTED:secret]${quote}`);
   assert.equal(redactText(masked),masked);
  }
 }
 const request={prompt:JSON.stringify({brief:{constraints:[SENSITIVE]},diff:SENSITIVE,previous:{summary:SENSITIVE}}),cli:{args:[]}};
 const sent=maskTransport(request).request.prompt;
 for(const secret of ['additional-secret','still-secret'])assert.ok(!sent.includes(secret));
 assert.ok(request.prompt.includes('additional-secret'));
});
test('redacts supported patterns, nested JSON and assignment values without changing the input',()=>{
 const input={objective:SENSITIVE,prior:JSON.stringify({DB_PASSWORD:'some value',ip:'::1'}),auth:'Bearer abcDEF123==',pem:'-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----'};
 const copy=structuredClone(input),counts={},masked=redactValue(input,counts);
 assert.deepEqual(input,copy);const text=JSON.stringify(masked);
 for(const value of ['alice@example.com','192.168.10.1','2001:db8::1','two words','super-secret-value','sk-proj-123456789012345678901234','some value','::1','abcDEF123','-----BEGIN'])assert.ok(!text.includes(value),value);
 assert.ok(Object.values(counts).reduce((a,b)=>a+b,0)>=8);
 assert.ok(!JSON.stringify(counts).includes('alice'));
 assert.equal(redactText('model claude-sonnet-5-5 version 0.12.0 hash deadbeef AC1 max_tokens=400'), 'model claude-sonnet-5-5 version 0.12.0 hash deadbeef AC1 max_tokens=400');
 assert.equal(redactText('at [2001:db8::1].'),'at [[REDACTED:ip]].');
 assert.ok(!redactText('+const x = "{\\"DB_PASSWORD\\":\\"hidden value\\"}"').includes('hidden value'));
 assert.ok(!redactText('-----BEGIN PRIVATE KEY-----\ntruncated-secret').includes('truncated-secret'));
 for(const ip of ['::','::1','2001:db8:85a3:0:0:8a2e:370:7334','::ffff:192.0.2.1','fe80::1%eth0'])assert.equal(redactText(ip),'[REDACTED:ip]',ip);
});
test('required identifiers containing sensitive data fail closed',()=>{
 assert.throws(()=>redactValue({task_id:'alice@example.com'}),e=>e.code==='REDACTION_UNSAFE');
 assert.throws(()=>redactValue({scope:{paths:['alice@example.com.txt']}}),e=>e.code==='REDACTION_UNSAFE');
});
for(const executor of ['grok','antigravity','sonnet','luna'])test(executor+' actual transport is masked; local dispatch keeps provenance',async t=>{
 const f=fixture(t,{executor}),cli=process.env[{grok:'HF_GROK_BIN',antigravity:'HF_AGY_BIN',sonnet:'HF_CLAUDE_BIN',luna:'HF_CODEX_BIN'}[executor]];
 fs.writeFileSync(cli,fs.readFileSync(cli,'utf8').replace('const finish=(request,id)=>{',"const finish=(request,id)=>{fs.writeFileSync(HERE+'/received-prompt.json',JSON.stringify(request));"));
 const dispatch=f.begin({objective:SENSITIVE});
 const masked=maskTransport(dispatch);assert.ok(!masked.request.prompt.includes('alice@example.com'));
 assert.ok(dispatch.prompt.includes('alice@example.com'));
 const out=await execute(f.root);assert.equal(out.status,'RESULT_READY');
 const received=fs.readFileSync(path.join(f.temp,'received-prompt.json'),'utf8');
 for(const value of ['alice@example.com','192.168.10.1','two words','super-secret-value','additional-secret','still-secret'])assert.ok(!received.includes(value),executor+': '+value);
 const dir=path.join(f.control,'tasks',f.brief.task_id);
 const audit=read(path.join(dir,'redaction-1.json'));assert.ok(audit.total>0);assert.ok(!JSON.stringify(audit).includes('alice'));
 if(executor==='grok')assert.ok(!fs.readFileSync(dispatch.cli.prompt_file,'utf8').includes('alice@example.com'));
 if(executor==='antigravity')assert.ok(!JSON.stringify(read(path.join(f.temp,'fake-agy-args.json'))).includes('alice@example.com'));
});
test('consult prior-result and diff context is masked before transport',async t=>{
 const f=fixture(t);f.begin();fs.writeFileSync(path.join(f.root,'a.txt'),SENSITIVE);const r=f.result(['a.txt']);r.summary=SENSITIVE;f.finish(r);
 const d=run(f.root,'consult',{mode:'advisor',executors:['grok'],question:SENSITIVE});
 await consult(f.root,d.consult_id);
 const dir=path.join(f.control,'tasks',f.brief.task_id),sent=read(path.join(dir,`consult-${d.consult_id}-m1.json`));
 assert.ok(sent.prompt.includes('alice@example.com'));
 assert.ok(!fs.readFileSync(sent.cli.prompt_file,'utf8').includes('alice@example.com'));
 assert.ok(!fs.readFileSync(sent.cli.prompt_file,'utf8').includes('additional-secret'));
 assert.ok(!fs.readFileSync(sent.cli.prompt_file,'utf8').includes('still-secret'));
});
test('help probes receive only the chosen vendor environment',t=>{
 const f=fixture(t),old=process.env.UNRELATED_DATABASE_PASSWORD;process.env.UNRELATED_DATABASE_PASSWORD='private';
 t.after(()=>{if(old===undefined)delete process.env.UNRELATED_DATABASE_PASSWORD;else process.env.UNRELATED_DATABASE_PASSWORD=old;});
 f.begin();assert.ok(!read(path.join(f.temp,'fake-env.json')).includes('UNRELATED_DATABASE_PASSWORD'));
});
