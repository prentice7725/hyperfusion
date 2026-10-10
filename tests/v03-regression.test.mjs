import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {execute} from '../scripts/executor-bridge.mjs';
import {automaticImplementer,config} from '../scripts/executor-config.mjs';
import {teamConfig} from '../scripts/project.mjs';
import {route} from '../scripts/router.mjs';
import {recordQuota} from '../scripts/quota-policy.mjs';

test('external-first blocks specialists and reserved Claude before every replacement lease',t=>{
 const f=fixture(t,{initialize:false});
 fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({external:{default:'auto',available:['grok','sonnet','haiku','luna']},routing:{policy:'external-first'}}));
 run(f.root,'init',{...f.brief,executor:'grok'});f.begin();f.finish();f.review('alternative');
 assert.throws(()=>f.begin({executor:'sonnet'}),/ROLE_GATE/);
 assert.equal(f.state().writer,null);
 assert.equal(f.begin().executor,'luna');
 f.finish();f.review('alternative');
 assert.equal(f.begin().executor,'grok');
});

test('explicit Haiku is an operator selection while automatic reserve remains excluded',t=>{
 const f=fixture(t,{initialize:false});
 fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({routing:{policy:'external-first'}}));
 assert.equal(automaticImplementer(config(f.root),'haiku'),false);
 assert.throws(()=>run(f.root,'init',{...f.brief,executor:'sonnet'}),/ROLE_GATE/);
 run(f.root,'init',{...f.brief,executor:'haiku'});
 assert.equal(f.begin().executor,'haiku');
 f.finish();f.review('redo');assert.equal(f.begin().executor,'haiku');
});

test('bridge updates a silent live worker to QUIET without ending the lease',async t=>{
 const f=fixture(t);f.begin();f.mode('hang');
 const pending=execute(f.root,{timeoutMs:450,monitorQuietMs:30,monitorIntervalMs:10});
 const observed=pending.catch(error=>error);
 const file=path.join(f.control,'tasks',f.brief.task_id,'monitor-1.json');
 let view;
 for(let i=0;i<80;i++){
  await new Promise(resolve=>setTimeout(resolve,15));
  try{view=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
  if(view?.state==='QUIET')break;
 }
 assert.equal(view?.state,'QUIET');
 assert.equal(f.state().phase,'EXECUTING');assert.ok(f.state().writer);
 assert.match((await observed).message,/timeout/);
});

test('approved project review strategy reaches the frozen task configuration',()=>{
 const p={name:'adaptive',revision:1,team:[{member:'grok',owns:['code']},{member:'sol',owns:[]}],review:{by:'delegate',strategy:'lead-gated-adaptive',reviewers:['sol'],auto_apply:false}};
 const c=teamConfig(p,{review:{by:'lead',auto_apply:true},routing:{}});
 assert.equal(c.review.strategy,'lead-gated-adaptive');
 assert.equal(c.review.auto_apply,false);
});

test('exploration cannot promote exhausted workers when another exhausted adapter is unavailable',t=>{
 const f=fixture(t,{initialize:false});
 fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({external:{default:'auto',available:['grok','antigravity','luna']},routing:{policy:'external-first',newcomer_every:0,explore_every:4}}));
 process.env.HF_AGY_BIN=path.join(f.temp,'missing');
 const dir=path.join(f.control,'metrics');fs.mkdirSync(dir,{recursive:true});
 for(let i=0;i<3;i++)fs.writeFileSync(path.join(dir,`old-${i}.json`),JSON.stringify({task_kind:'code',difficulty:'high',review_outcomes:[{owner:'grok',verdict:'redo'},{owner:'luna',verdict:'pass'}]}));
 for(const provider of ['xai','google'])recordQuota(f.root,{provider,source:'user_manual',collected_at:new Date().toISOString(),ttl_ms:60000,remaining:0,unit:'requests'});
 const routed=route(f.root,config(f.root),{task_kind:'code',difficulty:'high'});
 assert.match(routed.reason,/exploration/);assert.equal(routed.executor,'luna');
});
