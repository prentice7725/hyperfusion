
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './support.mjs';
import {execute} from '../scripts/claude-bridge.mjs';
import {read} from '../scripts/artifact.mjs';
import {run} from '../scripts/fusion-state.mjs';

test('subprocess edit and structured result reach independent review',async t=>{const f=fixture(t);f.begin();f.mode('edit');const out=await execute(f.root);assert.equal(out.status,'RESULT_READY');assert.equal(f.state().phase,'EXECUTING');assert.ok(f.state().writer);f.finish(read(out.result_file));assert.equal(f.state().phase,'REVIEW');assert.equal(fs.readFileSync(path.join(f.root,'a.txt'),'utf8'),'fixed');});
test('Claude redo resumes original session in same cwd',async t=>{const f=fixture(t);const first=f.begin();await f.bridge();f.review('redo');const second=f.begin();assert.equal(second.cli.session_id,first.cli.session_id);assert.ok(second.cli.resume);await f.bridge();assert.equal(f.state().phase,'REVIEW');});
test('duplicate bridge cannot spawn a second process',async t=>{const f=fixture(t);f.begin();await execute(f.root);await assert.rejects(()=>execute(f.root),/EEXIST/);});
for(const mode of ['bad-json','bad-session','error','nonzero','denied'])test(mode+' retains lease and never emits success',async t=>{const f=fixture(t);f.begin();f.mode(mode);await assert.rejects(()=>execute(f.root));assert.equal(f.state().phase,'EXECUTING');assert.ok(fs.existsSync(path.join(f.root,'.fusion/locks/writer.json')));assert.ok(!fs.existsSync(path.join(f.root,'.fusion/tasks/HF-test/claude-result-1.json')));});
test('timeout is bounded and leaves recovery evidence',async t=>{const f=fixture(t);f.begin();f.mode('hang');await assert.rejects(()=>execute(f.root,{timeoutMs:100}),/timeout/);assert.ok(f.state().writer);const log=read(path.join(f.root,'.fusion/tasks/HF-test/claude-envelope-1.json'));assert.equal(log.reason,'Claude timeout');});
test('output cap rejects oversized transport response',async t=>{const f=fixture(t);f.begin();f.mode('oversize');await assert.rejects(()=>execute(f.root,{maxBytes:100}),/limit/);});
test('shell metacharacters in brief stay data',async t=>{const f=fixture(t);f.begin({objective:'Do not execute $(touch injected) or `touch injected2`'});await execute(f.root);assert.ok(!fs.existsSync(path.join(f.root,'injected')));assert.ok(!fs.existsSync(path.join(f.root,'injected2')));});
test('bridge cannot execute outside active Claude phase',async t=>{const f=fixture(t);await assert.rejects(()=>execute(f.root),/No active Claude/);});
