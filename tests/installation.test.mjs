import {fileURLToPath} from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {read} from '../scripts/artifact.mjs';
import {draftTeam,propose,approve,amend,loadProject} from '../scripts/project.mjs';
import {recommendPreset,presetTaskInput} from '../scripts/installation.mjs';

function setup(t) {
 const f=fixture(t,{initialize:false});
 process.env.HF_GROK_BIN=path.join(f.temp,'missing-grok');process.env.HF_AGY_BIN=path.join(f.temp,'missing-agy');
 fs.mkdirSync(path.join(f.root,'docs'));fs.writeFileSync(path.join(f.root,'docs/GDD.md'),'# GDD');
 return f;
}
const plan=f=>({...draftTeam(f.root),name:'CLI-only project',summary:'Installed team',sources:['docs/GDD.md'],
 milestones:[{id:'M1',title:'one',goal:'code',checkpoint:['reviewed'],tasks:[{id:'LOW',title:'small',kind:'code',difficulty:'low'},{id:'HIGH',title:'large',kind:'code',difficulty:'high'}]}]});

test('an installed-team draft fills missing members into excluded and selects Claude/Codex',t=>{
 const f=setup(t),p=plan(f);
 assert.equal(p.preset,'claude-codex');assert.deepEqual(p.team.map(m=>m.member),['sonnet','luna','sol']);
 assert.ok(p.excluded.find(m=>m.member==='grok').why.includes('미설치'));
 assert.ok(p.excluded.find(m=>m.member==='antigravity').why.includes('미설치'));
 assert.equal(p.requires_approval,true);
});

test('proposal auto-excludes omitted unavailable members but rejects unavailable team entries',t=>{
 const f=setup(t),p=plan(f);p.excluded=p.excluded.filter(m=>!['grok','antigravity'].includes(m.member));
 propose(f.root,p);assert.ok(loadProject(f.root).excluded.some(m=>m.member==='grok'));
 const bad=plan(f);bad.team.push({member:'grok',role:'code',owns:['code'],why:'wrong'});bad.excluded=bad.excluded.filter(m=>m.member!=='grok');
 assert.throws(()=>propose(f.root,bad),/TEAM_UNAVAILABLE.*grok/);
});

test('only an approved preset grants Sonnet for high tasks and retains cross-company review',t=>{
 const f=setup(t);propose(f.root,plan(f));
 assert.throws(()=>run(f.root,'init',{...f.brief,task_id:'HIGH'}),/PROJECT_NOT_APPROVED/);
 approve(f.root,{user_message:'Approve the installed team and preset'});
 const high=run(f.root,'init',{...f.brief,task_id:'HIGH'});f.brief.task_id='HIGH';
 assert.equal(high.initial_executor,'sonnet');assert.equal(high.assignment.strategy,'sonnet_implementation');
 assert.equal(high.implement_grant.executor,'sonnet');assert.equal(high.assignment.set_by,'controller');
 f.begin();f.finish();const review=run(f.root,'delegate-review',{});
 assert.deepEqual(review.members.map(m=>m.executor),['sol']);
 assert.match(read(path.join(f.control,'tasks/HIGH','assignment.json')).reason,/user-approved/);
});

test('low preset tasks use Luna and Sonnet reviews them',t=>{
 const f=setup(t);propose(f.root,plan(f));approve(f.root,{user_message:'approved'});
 const low=run(f.root,'init',{...f.brief,task_id:'LOW'});f.brief.task_id='LOW';
 assert.equal(low.initial_executor,'luna');assert.equal(low.implement_grant,undefined);
 f.begin();f.finish();assert.deepEqual(run(f.root,'delegate-review',{}).members.map(m=>m.executor),['sonnet']);
});

test('repository config cannot opt a standalone task into an automatic Sonnet grant',t=>{
 const f=setup(t);
 fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({preset:'claude-codex',review:{by:'delegate',strategy:'lead-gated-adaptive'}}));
 assert.throws(()=>run(f.root,'init',{...f.brief,executor:'sonnet',difficulty:'high'}),/ROLE_GATE/);
});

test('preset changes require reapproval and nonstructural amendments retain the preset',t=>{
 const f=setup(t);propose(f.root,plan(f));approve(f.root,{user_message:'approved'});
 amend(f.root,{summary:'updated'});assert.equal(loadProject(f.root).preset,'claude-codex');assert.equal(loadProject(f.root).status,'ACTIVE');
 assert.equal(amend(f.root,{preset:null}).needs_approval,true);assert.equal(loadProject(f.root).status,'PROPOSED');
});

test('doctor recommends from actual installed adapters without writing config',t=>{
 const f=setup(t),script=new URL('../scripts/setup-doctor.mjs',import.meta.url);
 const out=JSON.parse(execFileSync(process.execPath,[fileURLToPath(script),f.root],{encoding:'utf8'}));
 assert.equal(out.recommended_preset.name,'claude-codex');assert.equal(fs.existsSync(path.join(f.root,'hyperfusion.config.json')),false);
 assert.equal(out.installation.find(m=>m.member==='grok').installed,false);
});

test('preset defaults respect explicit assignment/worker selection and image capability',()=>{
 assert.equal(presetTaskInput('claude-codex',{executor:'luna',difficulty:'high'}).executor,'luna');
 assert.equal(presetTaskInput('claude-codex',{difficulty:'high',task_kind:'image-asset'}).executor,'luna');
 assert.equal(presetTaskInput('claude-codex',{difficulty:'high',assignment_strategy:'external_primary'}).assignment_strategy,'external_primary');
 assert.equal(recommendPreset([{member:'sol',installed:true}]).name,'unavailable');
});
