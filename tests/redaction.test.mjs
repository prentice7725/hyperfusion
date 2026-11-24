import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {redactText,redactValue,maskTransport} from '../scripts/redaction.mjs';
import {fixture} from './support.mjs';
import {execute,consult} from '../scripts/executor-bridge.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {read} from '../scripts/artifact.mjs';
import {workerEnv} from '../scripts/worker-env.mjs';

test('PowerShell runtime module paths survive filtering while unrelated secrets do not',()=>{
 const env=workerEnv('acceptance',{PSModulePath:'C:/Windows/System32/WindowsPowerShell/v1.0/Modules',DATABASE_PASSWORD:'private',ANTHROPIC_API_KEY:'private'});
 assert.equal(env.PSModulePath,'C:/Windows/System32/WindowsPowerShell/v1.0/Modules');
 assert.equal(env.DATABASE_PASSWORD,undefined);assert.equal(env.ANTHROPIC_API_KEY,undefined);
});

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

test('image density filenames (icon@16.png, logo@2x.png) are not mistaken for email addresses',()=>{
 const names=['assets/icon@16.png','logo@2x.png','img/hero@1.5x.webp','ui/arrow@3x.SVG','tray@16.ico','a/b/c@2x.jpeg'];
 for(const name of names){
  assert.equal(redactText(name),name,name);
  assert.equal(redactText(`see ${name} and ${name}.`),`see ${name} and ${name}.`,'inside a sentence');
 }
 // 경로 필드도 막히지 않는다(전에는 REDACTION_UNSAFE: rename it before dispatch).
 assert.doesNotThrow(()=>redactValue({scope:{paths:['assets/icon@16.png']},files_changed:['a/logo@2x.png'],files_read:['x/hero@3x.png']}));
 const counts={};redactText(names.join(' '),counts);
 assert.equal(counts.email,undefined,'nothing was counted as an email');
});

test('real email addresses are still masked next to, or inside, image-like names',()=>{
 const counts={};
 assert.equal(redactText('mail bob@corp.io, icon@2x.png',counts),'mail [REDACTED:email], icon@2x.png');
 assert.equal(counts.email,1);
 for(const text of ['alice@example.com','bob@2x.com','bob@16.com','alice@example.com.txt','alice@example.com.png','bob@16.png.example.com','x@2x.png.bak'])
  assert.match(redactText(text),/\[REDACTED:email\]/,text);
 // 실제 이메일이 든 파일명은 경로 필드에서 여전히 막힌다.
 assert.throws(()=>redactValue({scope:{paths:['alice@example.com.txt']}}),e=>e.code==='REDACTION_UNSAFE');
});

// 個人番号 check digit, computed here so the fixtures stay valid numbers.
const myNumber=base=>{let s=0;for(let n=1;n<=11;n++)s+=Number(base[11-n])*(n<=6?n+1:n-6);const r=s%11;return base+(r<=1?0:11-r);};

test('Korean personal identifiers are masked',()=>{
 const cases=[
  ['주민번호 900101-1234567','rrn'],['외국인등록번호 900101-5234567','rrn'],['주민 9001011234568','rrn'],['신규 201015-3123456','rrn'],
  ['휴대폰 010-1234-5678','phone'],['01012345678','phone'],['011-123-4567','phone'],['전화 02-123-4567','phone'],['031.123.4567','phone'],['+82 10-1234-5678','phone'],
  ['카드 4111-1111-1111-1111','card'],['5555 5555 5555 4444','card'],['378282246310005','card'],
  ['국민은행 123456-04-123456','bank-account'],['여권 M12345678','passport'],['여권번호M123A4567','passport'],['면허 11-22-123456-78','driver-license'],
 ];
 for(const [text,kind] of cases){
  const counts={},masked=redactText(text,counts);
  assert.match(masked,new RegExp(`\\[REDACTED:${kind}\\]`),text);
  assert.equal(counts[kind],1,text);
 }
});

test('Japanese personal identifiers are masked, including full-width digits and long-mark dashes',()=>{
 const mn=myNumber('12345678901'),grouped=`${mn.slice(0,4)} ${mn.slice(4,8)} ${mn.slice(8)}`;
 const cases=[
  [`マイナンバー ${mn}`,'my-number'],[`番号 ${grouped}`,'my-number'],
  ['携帯 090-1234-5678','phone'],['080 1234 5678','phone'],['050-1234-5678','phone'],['電話 03-1234-5678','phone'],['045-123-4567','phone'],
  ['0123-45-6789','phone'],['03(1234)5678','phone'],['+81 90-1234-5678','phone'],['０９０－１２３４－５６７８','phone'],['090ー1234ー5678','phone'],
  ['在留カード AB12345678CD','residence-card'],['旅券番号 TK1234567','passport'],['免許証番号 301234567890','driver-license'],
  ['普通預金 口座番号 1234567','bank-account'],['基礎年金番号 1234-567890','pension-number'],
 ];
 for(const [text,kind] of cases){
  const counts={},masked=redactText(text,counts);
  assert.match(masked,new RegExp(`\\[REDACTED:${kind}\\]`),text);
  assert.equal(counts[kind],1,text);
 }
 // Full-width input is replaced at the original offsets, so the surrounding text survives untouched.
 assert.equal(redactText('連絡先：０９０－１２３４－５６７８まで'),'連絡先：[REDACTED:phone]まで');
});

test('personal-identifier rules leave ordinary numbers alone',()=>{
 const mn=myNumber('12345678901'),wrong=mn.slice(0,11)+((Number(mn[11])+1)%10);
 const plain=['version 0.12.0 hash deadbeef sha 3fbe6ad','2026-11-23 12:34:56','ts 1795435151584','build 20240101123456',
  'uuid 123e4567-e89b-12d3-a456-426614174000','hex a01012345678b','order 123456-04-123456','date 01-01-2024',
  'tests/run-0102345678.log','9001011234567','991301-1234567','4111 1111 1111 1112','1111 1111 1111 1117','M12345678',
  '301234567890','1234567','1234-567890',`${wrong.slice(0,4)}-${wrong.slice(4,8)}-${wrong.slice(8)}`,mn,'99-22-123456-78'];
 for(const text of plain)assert.equal(redactText(text),text,text);
});

test('a field name supplies the keyword for a bare identifier value',()=>{
 const masked=redactValue({passport:'M12345678',my_number:myNumber('12345678901'),driver_license:'301234567890',note:'M12345678'});
 assert.deepEqual(masked,{passport:'[REDACTED:passport]',my_number:'[REDACTED:my-number]',driver_license:'[REDACTED:driver-license]',note:'M12345678'});
 // A phone number in a transport path still blocks dispatch rather than leaking.
 assert.throws(()=>redactValue({scope:{paths:['contacts/010-1234-5678.txt']}}),e=>e.code==='REDACTION_UNSAFE');
 assert.doesNotThrow(()=>redactValue({scope:{paths:['src/v0.12.0/build-20240101123456.log']},task_id:'HF-1795435151584'}));
});

// Existing transport callers keep compact masks; evidence opts into raw line coordinates.
test('line-preserving text redaction masks whole multiline secrets without shifting later evidence',()=>{
 const input='header\n-----BEGIN PRIVATE KEY-----\nprivate body\n-----END PRIVATE KEY-----\npassword="first\nsecond"\nfailed later';
 const masked=redactText(input,{},{preserveLines:true});
 assert.equal(masked.split('\n').length,input.split('\n').length);
 assert.equal(masked.split('\n')[6],'failed later');
 for(const secret of ['private body','first','second'])assert.ok(!masked.includes(secret));
 assert.ok(redactText(input).split('\n').length<input.split('\n').length);
});
