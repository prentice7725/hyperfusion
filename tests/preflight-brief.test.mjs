import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {preflightBrief} from '../tools/preflight-brief.mjs';
import {DEFAULT_CONFIG} from '../scripts/executor-config.mjs';
import {fixture} from './support.mjs';

const example=name=>JSON.parse(fs.readFileSync(new URL(`../references/brief-examples/${name}.json`,import.meta.url)));
const adaptive=()=>({...structuredClone(DEFAULT_CONFIG),review:{...DEFAULT_CONFIG.review,strategy:'lead-gated-adaptive'}});

test('task examples pass shared static checks without changing input or creating grant records',()=>{
 for(const name of ['bugfix','preserve','new-feature']){
  const input=example(name),configuration=adaptive(),before=structuredClone({input,configuration});
  const report=preflightBrief(input,configuration);
  assert.equal(report.valid,true);assert.equal(report.static_only,true);assert.equal(report.authoritative,false);
  assert.ok(report.checks.every(c=>c.status==='pass'));assert.ok(report.unchecked.includes('approval eligibility'));
  assert.deepEqual({input,configuration},before);assert.equal(report.assignment,undefined);assert.equal(report.delegation,undefined);
 }
});

test('preflight reuses assignment, delegation, redo and brief constraints on cloned inputs',()=>{
 const input={...example('bugfix'),task_criticality:'standard',assignment_strategy:'external_primary',assignment_reason:'bounded example',delegation:{policy:'standard-auto',reason:'prepared regression contract'}};
 const original=structuredClone(input);
 assert.equal(preflightBrief(input,adaptive()).valid,true);assert.deepEqual(input,original);
 const important=preflightBrief({...input,task_criticality:'important'},adaptive());
 assert.match(important.checks.at(-1).message,/only a STANDARD/);assert.equal(important.checks.at(-1).name,'delegation');
 const preserve={...example('preserve'),delegation:input.delegation};
 assert.match(preflightBrief(preserve,adaptive()).checks.at(-1).message,/allow_preserve:true/);
 const redo={...input,delegation:undefined,redo_delegation:{reason:'bounded retry',max_redos:99}};
 assert.equal(preflightBrief(redo,adaptive()).checks.at(-1).name,'redo_delegation');
 assert.equal(preflightBrief({...input,task_criticality:'unknown'},adaptive()).checks.at(-1).name,'assignment');
 assert.match(preflightBrief({...example('bugfix'),scope:{paths:['../outside']}},DEFAULT_CONFIG).checks.at(-1).message,/Invalid bounded scope/);
});

test('CLI preflight never executes supplied commands or initializes control state',t=>{
 const f=fixture(t,{initialize:false}),marker=path.join(f.root,'executed.txt'),file=path.join(f.temp,'brief.json');
 const input={...example('bugfix'),acceptance_commands:[`node -e "require('fs').writeFileSync('executed.txt','bad')"`]};
 input.acceptance_map={AC1:input.acceptance_commands};fs.writeFileSync(file,JSON.stringify(input));
 const before=fs.readdirSync(f.root).sort(),result=spawnSync(process.execPath,['tools/preflight-brief.mjs',f.root,file],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).valid,true);
 assert.equal(fs.existsSync(marker),false);assert.deepEqual(fs.readdirSync(f.root).sort(),before);assert.equal(fs.existsSync(path.join(f.control,'state.json')),false);
 input.scope.paths=['../outside'];fs.writeFileSync(file,JSON.stringify(input));
 const invalid=spawnSync(process.execPath,['tools/preflight-brief.mjs',f.root,file],{encoding:'utf8'});
 assert.equal(invalid.status,1);assert.equal(JSON.parse(invalid.stdout).valid,false);
});
