import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fixture} from './support.mjs';
import {sandboxArgs} from '../scripts/codex-sandbox.mjs';
import {vendorAllowed} from '../scripts/vendor-policy.mjs';

test('writable roots reject home, control/CLI/skill/Git overlaps in both directions',t=>{
 const f=fixture(t,{initialize:false});
 const protectedDir=path.join(f.temp,'protected');fs.mkdirSync(path.join(protectedDir,'child'),{recursive:true});
 const env={HF_SKILL:protectedDir};
 for(const candidate of [os.homedir(),f.temp,protectedDir,path.join(protectedDir,'child'),path.join(f.root,'.git')]){
  assert.throws(()=>sandboxArgs({repoRoot:f.root},{...env,HF_CODEX_WRITABLE_ROOTS:JSON.stringify([candidate])}),/overlaps protected/);
 }
 const cache=path.join(f.temp,'cache');fs.mkdirSync(cache);
 assert.match(sandboxArgs({repoRoot:f.root},{...env,HF_CODEX_WRITABLE_ROOTS:JSON.stringify([cache])}).join(' '),/writable_roots/);
 const absent=path.join(cache,'future','config');
 assert.throws(()=>sandboxArgs({repoRoot:f.root},{HF_SKILL:absent,HF_CODEX_WRITABLE_ROOTS:JSON.stringify([cache])}),/overlaps protected/);
});

test('symlink aliases cannot bypass protected roots and linked worktree common Git is protected',t=>{
 const f=fixture(t,{initialize:false});const alias=path.join(f.temp,'git-alias');
 try{fs.symlinkSync(path.join(f.root,'.git'),alias,'junction');}catch(e){if(['EPERM','EACCES','ENOTSUP'].includes(e.code)){t.skip('symlink unavailable');return;}throw e;}
 assert.throws(()=>sandboxArgs({repoRoot:f.root},{HF_CODEX_WRITABLE_ROOTS:JSON.stringify([alias])}),/overlaps protected/);
 const worktree=path.join(f.temp,'linked');f.git('worktree','add','-b','linked',worktree);
 assert.throws(()=>sandboxArgs({repoRoot:worktree},{HF_CODEX_WRITABLE_ROOTS:JSON.stringify([path.join(f.root,'.git')])}),/overlaps protected/);
});

test('empty operator vendor policy is an explicit configuration error, empty repo policy still denies',()=>{
 for(const value of ['', '  ', 'openai,'])assert.throws(()=>vendorAllowed({},'luna',{HF_ALLOWED_VENDORS:value}),/VENDOR_POLICY/);
 assert.equal(vendorAllowed({allowed_vendors:[]},'luna',{}),false);
});
