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
import {adapter} from '../scripts/adapters/index.mjs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

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
test('wrong binary (e.g. IDE launcher) is named in the probe error with its help text',t=>{
 const d=tmp(t),f=path.join(d,'agy.mjs');
 fs.writeFileSync(f,"console.error(process.argv.includes('--help')?'Usage: antigravity [options][paths...]\\n  --new-window':'1.2.3');");
 const old=process.env.HF_AGY_BIN;process.env.HF_AGY_BIN=f;t.after(()=>{if(old===undefined)delete process.env.HF_AGY_BIN;else process.env.HF_AGY_BIN=old;});
 assert.throws(()=>adapter('antigravity').probe(),e=>e.message.includes(fs.realpathSync(f))&&e.message.includes('Usage: antigravity')&&e.message.includes('version "1.2.3"'));
});
test('doctor explains a leftover writer lease instead of a bare error',t=>{
 const f=fixture(t);f.begin();
 const out=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/setup-doctor.mjs',import.meta.url)),f.root,'--executor','grok'],{encoding:'utf8'});
 const rec=JSON.parse(out.stdout).checks.find(c=>c.name==='recovery');
 assert.equal(rec.ok,false);assert.match(rec.detail,/owner=grok task=HF-test round=1/);assert.match(rec.detail,/schema=4 phase=EXECUTING/);assert.match(rec.detail,/then recover/);
});
test('JSON input written by PowerShell with a UTF-8 BOM is accepted',t=>{const d=tmp(t),f=path.join(d,'in.json');fs.writeFileSync(f,'\uFEFF{"a":1}');assert.deepEqual(read(f),{a:1});});
test('Go-style help on stderr with exit code 2 (real agy.EXE) still passes the probe',t=>{const f=fixture(t,{initialize:false});const p=adapter('antigravity').probe();assert.equal(p.supports['--print-timeout'],true);});
test('agy gets --print-timeout shorter than the bridge timeout',async t=>{const f=fixture(t,{initialize:false});fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({executors:{antigravity:{timeout_ms:300000}}}));run(f.root,'init',{...f.brief,executor:'antigravity'});const d=f.begin();assert.equal(d.cli.args[d.cli.args.indexOf('--print-timeout')+1],'270s');assert.ok(d.cli.args.indexOf('--print-timeout')<d.cli.args.indexOf('-p'));});
