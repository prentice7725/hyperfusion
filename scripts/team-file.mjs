// 이 컴퓨터의 팀 파일(~/.hyperfusion/team.json). 어떤 일꾼을 쓸지와 일꾼별 모델·강도를 컴퓨터 단위로 정한다.
// 저장소 밖에 두는 운영자 파일이다. 저장소 설정과 합칠 때는 쓸 수 있는 일꾼을 좁히거나 저장소 설정이 비워 둔 값을 채우기만 한다.
// 보안 완화(샌드박스 해제 등)나 리드 선택은 이 파일로 할 수 없다.
// 초안은 setup-doctor --write-team이 설치된 CLI를 보고 만든다. 사람이 고친 뒤에는 이 파일이 기준이다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {read,atomic} from './artifact.mjs';
import {MEMBERS} from './member-registry.mjs';

export const TEAM_FILE_ENV='HF_TEAM_FILE';
export const TEAM_FILE_VERSION=1;
const MEMBER_KEYS=['enabled','model','reasoning_effort','note'];
const TOP_KEYS=['version','generated_at','note','members','reviewers'];
const MODEL=/^[\w.:/-]{1,80}$/;

// HF_TEAM_FILE=off면 팀 파일을 쓰지 않는다(시험과 일회성 실행용). 값이 있으면 그 경로, 없으면 ~/.hyperfusion/team.json.
export function teamFilePath(env=process.env) {
 const v=env[TEAM_FILE_ENV]?.trim();
 if(v==='off')return null;
 return v||path.join(os.homedir(),'.hyperfusion','team.json');
}

const bad=(file,why)=>Object.assign(Error(`TEAM_FILE_INVALID: ${file}: ${why}`),{code:'TEAM_FILE_INVALID'});
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);

export function validateTeam(v,file='team.json') {
 if(!plain(v))throw bad(file,'must be a JSON object');
 const extra=Object.keys(v).filter(k=>!TOP_KEYS.includes(k));
 if(extra.length)throw bad(file,'unknown keys '+extra.join(', '));
 if(v.version!==TEAM_FILE_VERSION)throw bad(file,`version must be ${TEAM_FILE_VERSION}`);
 if(!plain(v.members))throw bad(file,'members must be an object');
 for(const [name,m] of Object.entries(v.members)){
  if(!MEMBERS[name])throw bad(file,`unknown member ${name} (known: ${Object.keys(MEMBERS).join(', ')})`);
  if(!plain(m))throw bad(file,`members.${name} must be an object`);
  const unknown=Object.keys(m).filter(k=>!MEMBER_KEYS.includes(k));
  if(unknown.length)throw bad(file,`members.${name} has unknown keys ${unknown.join(', ')}`);
  if(typeof m.enabled!=='boolean')throw bad(file,`members.${name}.enabled must be true or false`);
  if(m.model!==undefined&&!(typeof m.model==='string'&&MODEL.test(m.model)))throw bad(file,`members.${name}.model is not a model id`);
  if(m.reasoning_effort!==undefined&&!(MEMBERS[name].efforts??[]).includes(m.reasoning_effort))
   throw bad(file,`members.${name}.reasoning_effort must be one of ${(MEMBERS[name].efforts??[]).join(', ')}`);
  if(m.note!==undefined&&typeof m.note!=='string')throw bad(file,`members.${name}.note must be a string`);
 }
 if(v.reviewers!==undefined){
  if(!Array.isArray(v.reviewers)||!v.reviewers.length||new Set(v.reviewers).size!==v.reviewers.length)throw bad(file,'reviewers must be a non-empty list without repeats');
  const off=v.reviewers.filter(n=>v.members[n]?.enabled!==true);
  if(off.length)throw bad(file,'reviewers must be enabled members: '+off.join(', '));
 }
 return v;
}

// 파일이 없으면 null(팀 파일 없이 예전처럼 동작한다).
export function loadTeam(file=teamFilePath()) {
 if(!file||!fs.existsSync(file))return null;
 let v;
 try{v=read(file);}catch(e){throw bad(file,'not valid JSON ('+e.message+')');}
 return validateTeam(v,file);
}

export const enabledMembers=team=>Object.keys(team.members).filter(n=>team.members[n].enabled);

// 저장소 설정(v)에 팀 파일을 합친다. explicit은 저장소 설정 파일이 직접 적은 값이다.
// - 일꾼 명단과 리뷰어 명단은 팀 파일이 켠 일꾼으로 좁힌다. 저장소 설정이 리뷰어를 적지 않았으면 팀 파일의 리뷰어 순서를 쓴다.
// - 모델과 강도는 저장소 설정 파일이 적지 않은 일꾼에 팀 파일 값을 쓴다(내장 기본값보다 앞선다).
// 돌려주는 값은 효과 기록이다. 상태와 doctor 출력에 남긴다.
// explicit: {reviewers:boolean, models:Set, efforts:Set}
export function applyTeam(v,team,{file,explicit={}}={}) {
 const models=explicit.models??new Set(),efforts=explicit.efforts??new Set();
 const on=new Set(enabledMembers(team));
 const before=[...v.external.available];
 v.external.available=before.filter(n=>on.has(n));
 if(!v.external.available.length)throw Object.assign(Error(`TEAM_FILE_EMPTY: ${file} enables none of the implementing workers (${before.join(', ')})`),{code:'TEAM_FILE_EMPTY'});
 if(v.external.default!=='auto'&&!on.has(v.external.default))
  throw Object.assign(Error(`TEAM_FILE_CONFLICT: hyperfusion.config.json picks ${v.external.default} as the default worker but ${file} disables it`),{code:'TEAM_FILE_CONFLICT'});
 const filled=[];
 for(const n of on){
  const m=team.members[n];
  if(m.model===undefined&&m.reasoning_effort===undefined)continue;
  v.executors[n]??={};
  if(m.model!==undefined&&!models.has(n)){v.executors[n].model=m.model;filled.push(n+'.model');}
  if(m.reasoning_effort!==undefined&&!efforts.has(n)){v.executors[n].reasoning_effort=m.reasoning_effort;filled.push(n+'.reasoning_effort');}
 }
 const reviewers=explicit.reviewers||!team.reviewers?v.review.reviewers.filter(n=>on.has(n)):[...team.reviewers];
 if(!reviewers.length)throw Object.assign(Error(`TEAM_FILE_EMPTY: ${file} enables none of the reviewers (${v.review.reviewers.join(', ')})`),{code:'TEAM_FILE_EMPTY'});
 v.review.reviewers=reviewers;
 return {file,enabled:[...on],removed:before.filter(n=>!on.has(n)),filled,reviewers_from:explicit.reviewers||!team.reviewers?'config':'team-file'};
}

// 설치 점검 결과(installationRoster)로 초안을 만든다. 설치된 일꾼은 켜고, 없는 일꾼은 끄고 이유를 적는다.
export function draftTeam(roster,configuration,{at=new Date()}={}) {
 const members={};
 for(const r of roster){
  const o=configuration?.executors?.[r.member]??{};
  members[r.member]={enabled:r.installed,
   ...(o.model!=null?{model:o.model}:MEMBERS[r.member].model?{model:MEMBERS[r.member].model}:{}),
   ...(r.installed?{}:{note:r.reason??'not installed'})};
 }
 const on=Object.keys(members).filter(n=>members[n].enabled);
 const reviewers=(configuration?.review?.reviewers??[]).filter(n=>on.includes(n));
 return {version:TEAM_FILE_VERSION,generated_at:at.toISOString(),
  note:'Edit enabled, model and reasoning_effort, then rerun setup-doctor. Workers not listed here are not used.',
  members,...(reviewers.length?{reviewers}:{})};
}

export function writeTeam(file,team,{force=false}={}) {
 if(!file)throw Error(`TEAM_FILE_OFF: ${TEAM_FILE_ENV}=off; set a path to write a team file`);
 if(fs.existsSync(file)&&!force)throw Object.assign(Error(`TEAM_FILE_EXISTS: ${file} already exists; edit it, or rerun with --force to replace it`),{code:'TEAM_FILE_EXISTS'});
 validateTeam(team,file);
 atomic(file,team);
 return file;
}

// 팀 파일과 실제 설치가 어긋난 곳. 켰지만 설치되지 않은 일꾼과, 설치됐지만 꺼진(또는 빠진) 일꾼.
export function teamDrift(team,roster) {
 const installed=new Set(roster.filter(r=>r.installed).map(r=>r.member));
 return {
  enabled_not_installed:enabledMembers(team).filter(n=>!installed.has(n)),
  installed_not_enabled:[...installed].filter(n=>team.members[n]?.enabled!==true)
 };
}
