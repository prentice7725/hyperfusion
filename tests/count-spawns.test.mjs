import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {summarize} from '../tools/count-spawns.mjs';

const TOOL=fileURLToPath(new URL('../tools/count-spawns.mjs',import.meta.url));

test('the summary names the commands and the calling site outside the git helpers',()=>{
 const rows=[
  {cmd:'git status',at:'scripts/artifact.mjs:117 < scripts/fusion-state.mjs:814 < scripts/cli.mjs:3'},
  {cmd:'git status',at:'scripts/artifact.mjs:117 < scripts/fusion-state.mjs:814'},
  {cmd:'git ls-files',at:'scripts/artifact.mjs:100 < scripts/fusion-state.mjs:267'},
  {cmd:'fake grok',at:'scripts/executor-bridge.mjs:69'}];
 const text=summarize(rows);
 assert.match(text,/총 4개, 그 중 git 3개 \(75\.0%\)/);
 assert.match(text,/2 +50\.0%  git status/);
 assert.match(text,/2 +50\.0%  scripts\/fusion-state\.mjs:814/);
 assert.match(text,/1 +25\.0%  scripts\/executor-bridge\.mjs:69/);
});

test('the tool counts the child processes of a command it runs, nested ones included',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hf-cs-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const inner=path.join(dir,'inner.mjs'),outer=path.join(dir,'outer.mjs'),keep=path.join(dir,'run.jsonl');
 fs.writeFileSync(inner,"import {execFileSync} from 'node:child_process';execFileSync('git',['--version']);execFileSync('git',['-c','a=b','--version']);");
 fs.writeFileSync(outer,`import {spawnSync} from 'node:child_process';spawnSync(process.execPath,[${JSON.stringify(inner)}]);`);
 const r=spawnSync(process.execPath,[TOOL,'--keep',keep,'--',process.execPath,outer],{cwd:dir,encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);
 const rows=fs.readFileSync(keep,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l));
 assert.equal(rows.filter(x=>x.cmd==='node inner.mjs').length,1,'the child node process');
 assert.equal(rows.filter(x=>x.cmd.startsWith('git')).length,2,'git started by the grandchild');
 assert.match(r.stdout,/총 3개, 그 중 git 2개/);
});
