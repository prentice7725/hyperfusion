import {REVIEWERS} from './executor-config.mjs';
import {adapter} from './adapters/index.mjs';

export function installationRoster(configuration,probe=name=>adapter(name).probe(configuration.executors?.[name]??{})) {
 return REVIEWERS.map(member=>{
  try{probe(member);return {member,installed:true,reason:null};}
  catch(e){return {member,installed:false,reason:'미설치 또는 CLI 계약 불일치',code:e.code??'ADAPTER_UNAVAILABLE'};}
 });
}

// Recommendations do not mutate config or grant implementation permission.
export function recommendPreset(roster) {
 const installed=new Set(roster.filter(r=>r.installed).map(r=>r.member));
 const claude=installed.has('sonnet'),codex=installed.has('luna')&&installed.has('sol');
 const external=['grok','antigravity'].filter(e=>installed.has(e));
 if(claude&&codex&&!external.length)return {
  name:'claude-codex',reason:'Claude Code + Codex; no installed Grok/AGY',members:['sonnet','luna','sol'],requires_project_approval:true,
  review:{by:'delegate',strategy:'lead-gated-adaptive',reviewers:['sol','sonnet'],auto_apply:false},
  task_defaults:{low:{executor:'luna',task_criticality:'standard',assignment_strategy:'external_primary'},
   medium_high:{executor:'sonnet',task_criticality:'important',assignment_strategy:'sonnet_implementation'}},
  note:'Only approved project tasks receive controller Sonnet grants; standalone tasks still require explicit init grants. No automatic Sol APEX grant.'};
 if(claude&&codex&&external.length)return {name:'external-first',reason:'External workers and cross-company reviewers installed',
  members:[...external,'luna','sonnet','sol'],requires_project_approval:true,
  review:{by:'delegate',strategy:'lead-gated-adaptive',reviewers:['sol','sonnet'],auto_apply:false},
  note:'Use the v0.3 example and approve the team; Sonnet/Sol grants remain task-specific.'};
 const members=roster.filter(r=>r.installed).map(r=>r.member),workers=members.filter(e=>e!=='sol');
 return {name:workers.length?'classic-installed':'unavailable',members,requires_project_approval:true,
  reason:workers.length?'Use installed workers without assuming missing review adapters':'No usable implementation CLI installed',
  review:members.length>1?{by:'delegate',reviewers:members,auto_apply:false}:{by:'lead'},
  note:'Same-company review may be weaker. Probes verify CLI flags, not authentication, quota or live quality.'};
}

export function presetTaskInput(preset,input) {
 if(preset!=='claude-codex'||input.assignment_strategy!==undefined||input.task_criticality!==undefined)return input;
 if(input.executor!==undefined&&input.executor!=='auto')return input;
 const specialist=['medium','high'].includes(input.difficulty)&&input.task_kind!=='image-asset';
 return {...input,executor:specialist?'sonnet':'luna',task_criticality:specialist?'important':'standard',
  assignment_strategy:specialist?'sonnet_implementation':'external_primary',
  assignment_reason:'controller default from the user-approved claude-codex project preset'};
}
