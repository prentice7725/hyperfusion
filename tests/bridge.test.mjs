import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './support.mjs';
import {execute} from '../scripts/executor-bridge.mjs';
import {read} from '../scripts/artifact.mjs';

const args=(f,name)=>read(path.join(f.temp,`fake-${name}-args.json`));

test('Grok edit round reaches independent review with lease held until finish',async t=>{const f=fixture(t);f.begin();f.mode('edit');const out=await execute(f.root);assert.equal(out.status,'RESULT_READY');assert.equal(out.executor,'grok');assert.ok(f.state().writer);f.finish(read(out.result_file));assert.equal(f.state().phase,'REVIEW');assert.equal(fs.readFileSync(path.join(f.root,'a.txt'),'utf8'),'fixed');});
test('Grok prompt goes through a file and write rules follow scope',async t=>{const f=fixture(t);f.begin();await execute(f.root);const a=args(f,'grok');assert.ok(fs.existsSync(a[a.indexOf('--prompt-file')+1]));assert.ok(a.includes('Edit(a.txt)'));assert.ok(a.includes('Bash(git commit*)'));assert.ok(!a.includes('--yolo'));});
test('Grok redo resumes the same session',async t=>{const f=fixture(t);const first=f.begin();await f.bridge();f.review('redo');const second=f.begin();assert.equal(second.cli.session_id,first.cli.session_id);assert.ok(second.cli.resume);await f.bridge();assert.equal(f.state().phase,'REVIEW');});
test('Grok fenced JSON result is accepted, bare prose is not',async t=>{const f=fixture(t);f.begin();f.mode('fenced');await f.bridge();assert.equal(f.state().phase,'REVIEW');f.review('redo');f.begin();f.mode('prose');await assert.rejects(()=>execute(f.root),/no result JSON/);});
test('duplicate bridge cannot spawn a second process',async t=>{const f=fixture(t);f.begin();await execute(f.root);await assert.rejects(()=>execute(f.root),/EEXIST/);});
for(const mode of ['bad-json','bad-session','error','nonzero','max-turns'])test('Grok '+mode+' retains lease and never emits success',async t=>{const f=fixture(t);f.begin();f.mode(mode);await assert.rejects(()=>execute(f.root));assert.equal(f.state().phase,'EXECUTING');assert.ok(fs.existsSync(path.join(f.control,'locks/writer.json')));assert.ok(!fs.existsSync(path.join(f.control,'tasks/HF-test/result-1.json')));});
test('timeout is bounded and leaves recovery evidence',async t=>{const f=fixture(t);f.begin();f.mode('hang');await assert.rejects(()=>execute(f.root,{timeoutMs:100}),/timeout/);assert.ok(f.state().writer);assert.equal(read(path.join(f.control,'tasks/HF-test/envelope-1.json')).reason,'Executor timeout');});
test('output cap rejects oversized response',async t=>{const f=fixture(t);f.begin();f.mode('oversize');await assert.rejects(()=>execute(f.root,{maxBytes:100}),/limit/);});
test('shell metacharacters in brief stay data',async t=>{const f=fixture(t);f.begin({objective:'Do not execute $(touch injected) or `touch injected2`'});await execute(f.root);assert.ok(!fs.existsSync(path.join(f.root,'injected')));assert.ok(!fs.existsSync(path.join(f.root,'injected2')));});
test('bridge refuses outside an executor round',async t=>{const f=fixture(t);await assert.rejects(()=>execute(f.root),/No active executor/);});

test('Antigravity first round binds the CLI-issued conversation, redo resumes it',async t=>{const f=fixture(t,{executor:'antigravity'});const first=f.begin();assert.equal(first.executor,'antigravity');assert.equal(first.cli.session_id,null);await f.bridge();const id=f.state().sessions.antigravity;assert.match(id,/^conv-/);f.review('redo');const second=f.begin();assert.equal(second.cli.session_id,id);await f.bridge();const a=args(f,'agy');assert.equal(a[a.indexOf('--conversation')+1],id);assert.equal(a.at(-2),'-p');assert.ok(a.includes('--sandbox'));});
test('Antigravity failed status is never success',async t=>{const f=fixture(t,{executor:'antigravity'});f.begin();f.mode('agy-fail');await assert.rejects(()=>execute(f.root),/status: failed/);assert.ok(f.state().writer);});
