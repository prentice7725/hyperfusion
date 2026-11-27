import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './support.mjs';
import {config,taskExecutorOptions} from '../scripts/executor-config.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {read} from '../scripts/artifact.mjs';
import {route} from '../scripts/router.mjs';
import {validateTeam} from '../scripts/team-file.mjs';

const write=(f,value)=>fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify(value));
const effort=args=>args[args.indexOf('--reasoning-effort')+1];

for(const policy of ['classic','external-first']){
 test(`Grok 4.7 implements at medium for every ${policy} difficulty and implementation dispatch`,t=>{
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
 // HyperFusion은 Grok 4.7의 medium, high, xhigh를 받는다. 그 밖의 값은 설정에서 거절한다.
 for(const bad of ['low','max','minimal'])assert.throws(()=>{write(f,{executors:{grok:{reasoning_effort:bad}}});config(f.root);},/EFFORT_UNSUPPORTED: grok reasoning_effort must be one of medium, high, xhigh/);
 for(const setting of ['medium','high','xhigh',null]){
  write(f,{routing:{policy:'external-first'},executors:{grok:{reasoning_effort:setting}}});
  const c=config(f.root);
  for(const difficulty of ['low','medium','high',undefined])assert.equal(taskExecutorOptions(c,'grok',difficulty).reasoning_effort,setting??undefined);
 }
});

// 상담은 구현 강도(medium), 리뷰 자리는 xhigh다.
for(const [mode,expected] of [['advisor','medium'],['review','xhigh']])test(`Grok ${mode} dispatch defaults to ${expected}`,t=>{
 const f=fixture(t,{initialize:false});write(f,{review:{by:'delegate',reviewers:['grok']}});
 run(f.root,'init',{...f.brief,executor:'antigravity'});
 if(mode==='review'){f.begin();f.finish();}
 const c=run(f.root,mode==='review'?'delegate-review':'consult',{mode,question:'Check the change',executors:['grok']});
 const d=read(path.join(f.control,'tasks',f.brief.task_id,`consult-${c.consult_id}-m1.json`));
 assert.equal(effort(d.cli.args),expected);
});

test('both shipped profiles explicitly select Grok medium',()=>{
 for(const file of ['hyperfusion.config.example.json','hyperfusion.v03.config.example.json']){
  assert.equal(JSON.parse(fs.readFileSync(new URL('../'+file,import.meta.url),'utf8')).executors.grok.reasoning_effort,'medium',file);
 }
});

test('Grok medium reaches the CLI for advice and implementation',t=>{
 const f=fixture(t,{initialize:false});
 write(f,{routing:{policy:'external-first'},review:{by:'delegate',reviewers:['grok']},executors:{grok:{reasoning_effort:'medium'}}});
 const c=config(f.root);assert.equal(c.executors.grok.reasoning_effort,'medium');assert.equal(c.effort_source.grok,'config');
 run(f.root,'init',{...f.brief,executor:'grok',difficulty:'high'});
 const advice=run(f.root,'consult',{mode:'advisor',question:'Check the change',executors:['grok']});
 assert.equal(effort(read(path.join(f.control,'tasks',f.brief.task_id,`consult-${advice.consult_id}-m1.json`)).cli.args),'medium');
 run(f.root,'consult-finish',{quiescent:true});
 assert.equal(effort(f.begin().cli.args),'medium');
});

test('an adaptive Grok review seat runs at xhigh even when Grok implementation is set to medium',t=>{
 const f=fixture(t,{initialize:false});
 write(f,{review:{by:'delegate',strategy:'lead-gated-adaptive'},executors:{grok:{reasoning_effort:'medium'}}});
 run(f.root,'init',{...f.brief,executor:'antigravity',task_criticality:'important',assignment_reason:'Independent deep review'});
 f.begin();f.finish();
 const c=run(f.root,'delegate-review',{});
 const m=c.members.find(x=>x.executor==='grok');assert.ok(m,'Grok holds a review seat');
 assert.equal(effort(read(path.join(f.control,'tasks',f.brief.task_id,`consult-${c.consult_id}-${m.member}.json`)).cli.args),'xhigh');
 assert.equal(f.state().configuration.executors.grok.reasoning_effort,'medium');
});

test('a team file accepts Grok medium and refuses efforts outside medium, high and xhigh',()=>{
 assert.doesNotThrow(()=>validateTeam({version:1,members:{grok:{enabled:true,reasoning_effort:'medium'}}}));
 assert.throws(()=>validateTeam({version:1,members:{grok:{enabled:true,reasoning_effort:'low'}}}),/members.grok.reasoning_effort must be one of medium, high, xhigh/);
});

test('a repository config or team file that pins Grok high keeps implementation and advice at high',t=>{
 const f=fixture(t,{initialize:false});write(f,{executors:{grok:{reasoning_effort:'high'}}});
 const c=config(f.root);assert.equal(c.executors.grok.reasoning_effort,'high');
 for(const difficulty of ['low','medium','high'])assert.equal(taskExecutorOptions(c,'grok',difficulty).reasoning_effort,'high');
 const dir=fs.mkdtempSync(path.join(f.root,'..','hf-team-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const team=path.join(dir,'team.json');fs.writeFileSync(team,JSON.stringify({version:1,members:{grok:{enabled:true,reasoning_effort:'high'},sonnet:{enabled:true}}}));
 const fromTeam=config(dir,{teamFile:team});assert.equal(fromTeam.executors.grok.reasoning_effort,'high');assert.equal(fromTeam.effort_source.grok,'team');
 write(f,{routing:{policy:'external-first'}});
 for(const difficulty of ['low','medium','high'])assert.equal(taskExecutorOptions(config(f.root,{teamFile:team}),'grok',difficulty).reasoning_effort,'high');
});
