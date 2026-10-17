import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './support.mjs';
import {config,taskExecutorOptions} from '../scripts/executor-config.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {read} from '../scripts/artifact.mjs';
import {route} from '../scripts/router.mjs';

const write=(f,value)=>fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify(value));
const effort=args=>args[args.indexOf('--reasoning-effort')+1];

for(const policy of ['classic','external-first']){
 test(`Grok defaults to medium for every ${policy} difficulty and implementation dispatch`,t=>{
  const f=fixture(t,{initialize:false});write(f,{routing:{policy}});
  const c=config(f.root);
  for(const difficulty of ['low','medium','high',undefined]){
   assert.equal(taskExecutorOptions(c,'grok',difficulty).reasoning_effort,'medium');
   assert.equal(route(f.root,c,{task_kind:'image-asset',difficulty},{probe:false}).effort?.reasoning_effort??c.executors.grok.reasoning_effort,'medium');
  }
  run(f.root,'init',{...f.brief,executor:'grok',difficulty:'high'});
  assert.equal(effort(f.begin().cli.args),'medium');
 });
}

test('explicit Grok effort and CLI-default opt-out remain authoritative',t=>{
 const f=fixture(t,{initialize:false});
 for(const setting of ['low','high','xhigh',null]){
  write(f,{routing:{policy:'external-first'},executors:{grok:{reasoning_effort:setting}}});
  const c=config(f.root);
  for(const difficulty of ['low','medium','high',undefined])assert.equal(taskExecutorOptions(c,'grok',difficulty).reasoning_effort,setting??undefined);
 }
});

for(const mode of ['advisor','review'])test(`Grok ${mode} dispatch defaults to medium`,t=>{
 const f=fixture(t,{initialize:false});write(f,{review:{by:'delegate',reviewers:['grok']}});
 run(f.root,'init',{...f.brief,executor:'antigravity'});
 if(mode==='review'){f.begin();f.finish();}
 const c=run(f.root,mode==='review'?'delegate-review':'consult',{mode,question:'Check the change',executors:['grok']});
 const d=read(path.join(f.control,'tasks',f.brief.task_id,`consult-${c.consult_id}-m1.json`));
 assert.equal(effort(d.cli.args),'medium');
});

test('both shipped profiles explicitly select Grok medium',()=>{
 for(const file of ['hyperfusion.config.example.json','hyperfusion.v03.config.example.json']){
  assert.equal(JSON.parse(fs.readFileSync(new URL('../'+file,import.meta.url),'utf8')).executors.grok.reasoning_effort,'medium',file);
 }
});
