import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fixture} from './support.mjs';
import {resolveExecutable,unwrapShim,samePath,assertCommandLine,isWin} from '../scripts/platform.mjs';
import {execute} from '../scripts/executor-bridge.mjs';
import {read} from '../scripts/artifact.mjs';
import {run} from '../scripts/fusion-state.mjs';

const tmp=t=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'hf-plat-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;};

test('a .js/.mjs entry runs through the current node, so no shebang or .cmd is needed',t=>{const d=tmp(t),f=path.join(d,'cli.mjs');fs.writeFileSync(f,'console.log(1)');const r=resolveExecutable('X',f);assert.equal(r.executable,process.execPath);assert.deepEqual(r.prefix_args,[fs.realpathSync(f)]);});
test('npm .cmd wrapper is unwrapped to its real entry instead of going through cmd.exe',t=>{
 const d=tmp(t);const entry=path.join(d,'node_modules','@anthropic-ai','claude-code','cli.js');fs.mkdirSync(path.dirname(entry),{recursive:true});fs.writeFileSync(entry,'');
 const shim=path.join(d,'claude.cmd');
 fs.writeFileSync(shim,'@ECHO off\r\nGOTO start\r\n:start\r\nSETLOCAL\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n');
 assert.equal(path.normalize(unwrapShim(shim)),path.normalize(entry));
 fs.writeFileSync(shim,'@echo off\r\nsomething-else %*\r\n');assert.equal(unwrapShim(shim),null);
});
test('missing executable is reported, never guessed',()=>{assert.throws(()=>resolveExecutable('X',path.join(os.tmpdir(),'definitely-missing-hf-cli')),/ADAPTER_UNAVAILABLE/);});
test('samePath tolerates separator differences',t=>{const d=tmp(t);assert.ok(samePath(d,d+path.sep));assert.ok(samePath(d,path.join(d,'x','..')));});
test('Windows command-line length guard',()=>{if(!isWin){assertCommandLine('x',['y'.repeat(40000)]);return;}assert.throws(()=>assertCommandLine('x',['y'.repeat(40000)]),/too long/);});
test('backslash paths from a Windows worker are normalized before validation',async t=>{const f=fixture(t);f.begin();f.mode('backslash');const out=await execute(f.root);assert.deepEqual(read(out.result_file).files_read,['sub/a.txt']);});
test('per-executor timeout_ms from config bounds the round',async t=>{const f=fixture(t,{initialize:false});fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({executors:{grok:{timeout_ms:150}}}));run(f.root,'init',{...f.brief,executor:'grok'});f.begin();f.mode('hang');await assert.rejects(()=>execute(f.root),/timeout/);assert.ok(f.state().writer);});
test('process record states how the tree is killed on this platform',async t=>{const f=fixture(t);f.begin();await execute(f.root);const p=read(path.join(f.root,'.fusion/tasks/HF-test/process-1.json'));assert.equal(p.platform,process.platform);assert.equal(p.tree_kill,isWin?'taskkill /T /F':'process group');});
