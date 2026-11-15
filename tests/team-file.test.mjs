import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {config} from '../scripts/executor-config.mjs';
import {teamFilePath,validateTeam,draftTeam,teamDrift} from '../scripts/team-file.mjs';

const doctor=fileURLToPath(new URL('../scripts/setup-doctor.mjs',import.meta.url));
function temp(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hf-team-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 return {dir,team:path.join(dir,'team.json')};
}
const write=(file,v)=>fs.writeFileSync(file,JSON.stringify(v));
const team=(members,extra={})=>({version:1,members,...extra});

test('HF_TEAM_FILE picks the path, off disables it, and the default lives in ~/.hyperfusion',()=>{
 assert.equal(teamFilePath({HF_TEAM_FILE:'off'}),null);
 assert.equal(teamFilePath({HF_TEAM_FILE:'/x/team.json'}),'/x/team.json');
 assert.equal(teamFilePath({}),path.join(os.homedir(),'.hyperfusion','team.json'));
});

test('the team file narrows workers and reviewers and fills models the repository config left out',t=>{
 const {dir,team:file}=temp(t);
 write(file,team({terra:{enabled:true,model:'gpt-6.1-terra',reasoning_effort:'high'},sonnet:{enabled:true},sol:{enabled:true},
  grok:{enabled:false,note:'not installed'},antigravity:{enabled:true,model:'gemini-4-argon-high'}},{reviewers:['sonnet','sol']}));
 const c=config(dir,{teamFile:file});
 assert.deepEqual(c.external.available,['terra','sonnet','antigravity']);
 assert.deepEqual(c.review.reviewers,['sonnet','sol']);
 assert.equal(c.executors.terra.reasoning_effort,'high');assert.equal(c.effort_source.terra,'team');
 // 내장 기본값(gemini-4-hydrogen-high)보다 팀 파일이 앞선다.
 assert.equal(c.executors.antigravity.model,'gemini-4-argon-high');
 assert.deepEqual(c.team.removed,['grok','luna','haiku']);
 assert.equal(c.team.reviewers_from,'team-file');
 // 팀 파일이 없으면 예전과 같다.
 assert.equal(config(dir,{teamFile:null}).team,null);
 assert.equal(config(dir,{teamFile:null}).external.available.length,6);
});

test('a repository config keeps its own models, efforts and reviewer list over the team file',t=>{
 const {dir,team:file}=temp(t);
 write(path.join(dir,'hyperfusion.config.json'),{executors:{terra:{reasoning_effort:'low'}},review:{by:'lead',reviewers:['grok','sol','sonnet']}});
 write(file,team({terra:{enabled:true,reasoning_effort:'high'},sonnet:{enabled:true},sol:{enabled:true}},{reviewers:['sol']}));
 const c=config(dir,{teamFile:file});
 assert.equal(c.executors.terra.reasoning_effort,'low');assert.equal(c.effort_source.terra,'config');
 // 저장소가 적은 리뷰어 순서를 유지하되 팀 파일이 끈 Grok은 뺀다.
 assert.deepEqual(c.review.reviewers,['sol','sonnet']);
 assert.equal(c.team.reviewers_from,'config');
});

test('a team file that enables nothing usable, or disables the configured default worker, is refused',t=>{
 const {dir,team:file}=temp(t);
 write(file,team({sol:{enabled:true}}));
 assert.throws(()=>config(dir,{teamFile:file}),/TEAM_FILE_EMPTY.*implementing/);
 write(file,team({terra:{enabled:true}}));
 assert.throws(()=>config(dir,{teamFile:file}),/TEAM_FILE_EMPTY.*reviewers/);
 write(path.join(dir,'hyperfusion.config.json'),{external:{default:'grok',available:['grok','terra']}});
 write(file,team({terra:{enabled:true},sol:{enabled:true}}));
 assert.throws(()=>config(dir,{teamFile:file}),/TEAM_FILE_CONFLICT.*grok/);
});

test('team file validation names the bad field',t=>{
 const {dir,team:file}=temp(t);
 const bad=[[team({gpt5:{enabled:true}}),/unknown member gpt5/],[team({terra:{enabled:'yes'}}),/terra\.enabled/],
  [team({terra:{enabled:true,reasoning_effort:'max'}}),/terra\.reasoning_effort/],[team({terra:{enabled:true,sandbox:false}}),/unknown keys sandbox/],
  [team({terra:{enabled:true},sol:{enabled:false}},{reviewers:['sol']}),/reviewers must be enabled.*sol/],
  [{version:2,members:{}},/version must be 1/],[{...team({}),lead:'fable'},/unknown keys lead/]];
 for(const [v,re] of bad)assert.throws(()=>validateTeam(v),re);
 fs.writeFileSync(file,'{not json');
 assert.throws(()=>config(dir,{teamFile:file}),/TEAM_FILE_INVALID.*not valid JSON/);
});

test('a draft enables installed members only, and drift shows what no longer matches',()=>{
 const roster=[{member:'terra',installed:true},{member:'grok',installed:false,reason:'미설치'},{member:'sol',installed:true}];
 const d=draftTeam(roster,{executors:{terra:{model:'gpt-6.1-terra'}},review:{reviewers:['sol','grok']}},{at:new Date(0)});
 assert.deepEqual(d.members.terra,{enabled:true,model:'gpt-6.1-terra'});
 assert.deepEqual(d.members.grok,{enabled:false,note:'미설치'});
 assert.deepEqual(d.reviewers,['sol']);
 validateTeam(d);
 const now=[{member:'terra',installed:false},{member:'grok',installed:true},{member:'sol',installed:true}];
 assert.deepEqual(teamDrift(d,now),{enabled_not_installed:['terra'],installed_not_enabled:['grok']});
});

test('setup-doctor --write-team drafts from installed CLIs, refuses to overwrite, and warns about drift',t=>{
 const f=fixture(t,{initialize:false}),file=path.join(f.temp,'home','team.json');
 const env={...process.env,HF_TEAM_FILE:file,HF_GROK_BIN:path.join(f.temp,'missing-grok')};
 const out=JSON.parse(execFileSync(process.execPath,[doctor,f.root,'--write-team'],{encoding:'utf8',env}));
 assert.equal(out.team.written,true);
 const draft=JSON.parse(fs.readFileSync(file,'utf8'));
 assert.equal(draft.members.grok.enabled,false);assert.equal(draft.members.terra.enabled,true);
 const again=spawnSync(process.execPath,[doctor,f.root,'--write-team'],{encoding:'utf8',env});
 assert.notEqual(again.status,0);assert.match(again.stdout,/TEAM_FILE_EXISTS/);
 // 손으로 Grok을 켰지만 설치돼 있지 않으면 doctor가 알린다.
 draft.members.grok={enabled:true};fs.writeFileSync(file,JSON.stringify(draft));
 const drift=JSON.parse(execFileSync(process.execPath,[doctor,f.root],{encoding:'utf8',env}));
 assert.deepEqual(drift.team.drift.enabled_not_installed,['grok']);
 assert.ok(drift.warnings.some(w=>w.includes('team file enables workers that are not installed')));
 assert.deepEqual(drift.team.applied.enabled.includes('grok'),true);
 // --force면 다시 쓴다.
 execFileSync(process.execPath,[doctor,f.root,'--write-team','--force'],{encoding:'utf8',env});
 assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).members.grok.enabled,false);
});

test('init refuses a worker the team file disabled',t=>{
 const f=fixture(t,{initialize:false}),file=path.join(f.temp,'team.json');
 write(file,team({terra:{enabled:true},sonnet:{enabled:true},sol:{enabled:true},grok:{enabled:false}}));
 const old=process.env.HF_TEAM_FILE;process.env.HF_TEAM_FILE=file;
 t.after(()=>{if(old===undefined)delete process.env.HF_TEAM_FILE;else process.env.HF_TEAM_FILE=old;});
 assert.throws(()=>run(f.root,'init',{...f.brief,executor:'grok'}),/not enabled.*grok/i);
});
