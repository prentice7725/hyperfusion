import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {hostGrade,leadIdentity,leadPowers,assertLeadFamily,LEAD_MODEL_ENV,LEAD_GRADE_ENV} from '../scripts/lead-host.mjs';
import {rememberHost} from '../scripts/lead-usage.mjs';
import {config} from '../scripts/executor-config.mjs';
import {decide,decideModelSwitch,settingsSnippet,relaxationEnv} from '../scripts/lead-guard.mjs';
import {FAMILY_RULES_POLICY} from '../scripts/review-plan.mjs';
import * as project from '../scripts/project.mjs';

const CHECK=`node -e "const s=require('fs').readFileSync('a.txt','utf8');if(s!=='fixed'){console.error('a.txt is '+s);process.exit(3)}"`;
const withEnv=(t,values)=>{
 const old=Object.fromEntries(Object.keys(values).map(k=>[k,process.env[k]]));
 for(const [k,v] of Object.entries(values))process.env[k]=v;
 t.after(()=>{for(const [k,v] of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
};
const adaptive=(f,extra={})=>fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({review:{by:'delegate',strategy:'lead-gated-adaptive'},...extra}));
// 호스트 훅이 방금 보낸 것처럼 기록한다. init 직전의 Bash PreToolUse가 있어야 관측으로 인정된다.
const hostEvent=(root,input,at=Date.now())=>rememberHost(root,{session_id:'lead-session',...input},at);

test('only a verified host with observed hooks earns a grade above C',()=>{
 assert.equal(hostGrade('claude-code',{hooks_observed:true}),'A');
 assert.equal(hostGrade('claude-code',{hooks_observed:false}),'C');
 // 문서상 능력이 있어도 실측 전 호스트는 C다.
 assert.equal(hostGrade('codex',{hooks_observed:true}),'C');
 assert.equal(hostGrade('antigravity',{hooks_observed:true}),'C');
 assert.equal(hostGrade(null,{hooks_observed:true}),'C');
 assert.deepEqual(leadPowers({enforced:false,grade:'C'}),{delegation:true,takeover:true});
 assert.deepEqual(leadPowers({enforced:true,grade:'C',family:'openai'}),{delegation:false,takeover:false});
 assert.deepEqual(leadPowers({enforced:true,grade:'B',family:'openai'}),{delegation:true,takeover:true});
 assert.deepEqual(leadPowers({enforced:true,grade:'B',family:'unknown'}),{delegation:false,takeover:true});
});

test('the lead comes from the host, then the operator, never from a repository config',t=>{
 const f=fixture(t,{initialize:false});
 const c=config(f.root);
 assert.equal(c.lead_model_source,'default');
 const plain=leadIdentity(f.root,c,{env:{}});
 assert.deepEqual([plain.model,plain.source,plain.enforced],['claude-opus-5-5','config',false]);
 const astra=leadIdentity(f.root,c,{env:{[LEAD_MODEL_ENV]:'gpt-6.1-astra'}});
 assert.deepEqual([astra.model,astra.family,astra.source,astra.grade,astra.enforced],['gpt-6.1-astra','openai','operator-env','C',true]);
 assert.equal(leadIdentity(f.root,c,{env:{[LEAD_MODEL_ENV]:'gpt-6.1-astra',[LEAD_GRADE_ENV]:'B'}}).grade,'B');
 assert.throws(()=>leadIdentity(f.root,c,{env:{[LEAD_GRADE_ENV]:'S'}}),/must be A, B or C/);
 // 저장소 설정이 Opus를 적었는데 리드가 다른 계열이면 거절한다.
 fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({lead_model:'claude-opus-5-5'}));
 assert.throws(()=>leadIdentity(f.root,config(f.root),{env:{[LEAD_MODEL_ENV]:'gpt-6.1-astra'}}),/cannot choose the lead family/);
 fs.rmSync(path.join(f.root,'hyperfusion.config.json'));
 // 호스트 훅이 보고한 모델이 우선이고, 운영자 값과 계열이 다르면 거절한다.
 hostEvent(f.root,{hook_event_name:'SessionStart',model:'claude-opus-5-5'});
 hostEvent(f.root,{hook_event_name:'PreToolUse',tool_name:'Bash'});
 const hooked=leadIdentity(f.root,config(f.root),{env:{}});
 assert.deepEqual([hooked.model,hooked.source,hooked.host,hooked.grade],['claude-opus-5-5','host-hook','claude-code','A']);
 assert.throws(()=>leadIdentity(f.root,config(f.root),{env:{[LEAD_MODEL_ENV]:'gemini-4-argon'}}),/LEAD_IDENTITY_CONFLICT/);
});

test('a lead family change between rounds is refused; a same-family change is only recorded',t=>{
 const f=fixture(t,{initialize:false});
 hostEvent(f.root,{hook_event_name:'SessionStart',model:'gpt-6.1-astra',hook_host:'codex'});
 hostEvent(f.root,{hook_event_name:'PreToolUse',tool_name:'Bash',hook_host:'codex'});
 const lead=leadIdentity(f.root,config(f.root),{env:{}});
 assert.deepEqual([lead.host,lead.source,lead.grade],['codex','host-hook','C']);
 assert.equal(assertLeadFamily(f.root,lead),null);
 hostEvent(f.root,{hook_event_name:'PostModelSwitch',to_model:'gpt-6.1-sol',hook_host:'codex'});
 hostEvent(f.root,{hook_event_name:'PreToolUse',tool_name:'Bash',hook_host:'codex'});
 assert.equal(assertLeadFamily(f.root,lead).model,'gpt-6.1-sol');
 hostEvent(f.root,{hook_event_name:'PostModelSwitch',to_model:'claude-sonnet-5-5',hook_host:'codex'});
 hostEvent(f.root,{hook_event_name:'PreToolUse',tool_name:'Bash',hook_host:'codex'});
 assert.throws(()=>assertLeadFamily(f.root,lead),/LEAD_FAMILY_CHANGED/);
 // 훅으로 정한 비 Claude 리드는 관측이 끊기면 라운드를 열지 않는다.
 assert.throws(()=>assertLeadFamily(f.root,lead,{at:Date.now()+60000}),/LEAD_MODEL_UNOBSERVED/);
 assert.equal(assertLeadFamily(f.root,{...lead,source:'operator-env'},{at:Date.now()+60000}),null);
});

test('an operator-chosen Codex lead starts a family-rules task without delegation or takeover',t=>{
 withEnv(t,{[LEAD_MODEL_ENV]:'gpt-6.1-astra'});
 let f=fixture(t,{initialize:false});adaptive(f);
 const s=run(f.root,'init',{...f.brief,executor:'grok'});
 assert.equal(s.configuration.lead_model,'gpt-6.1-astra');assert.equal(s.configuration.lead,'host');
 assert.equal(s.configuration.lead_takeover,false);
 assert.deepEqual([s.lead_identity.family,s.lead_identity.source,s.lead_identity.grade],['openai','operator-env','C']);
 assert.equal(s.assignment.review_policy,FAMILY_RULES_POLICY);
 // Grok 작업의 첫 리뷰어는 리드와 다른 계열의 frontier인 Sonnet이다.
 assert.deepEqual(s.review_preview.reviewers,['sonnet']);
 f=fixture(t,{initialize:false});adaptive(f);
 const input={...f.brief,executor:'grok',acceptance_commands:[CHECK],acceptance_map:{AC1:[CHECK]},delegation:{policy:'standard-auto',reason:'single-file fix'}};
 assert.throws(()=>run(f.root,'init',input),/grade C lead/);
 f=fixture(t,{initialize:false});adaptive(f,{external:{default:'luna',available:['luna']},review:{by:'delegate',strategy:'lead-gated-adaptive',reviewers:['sol']}});
 assert.throws(()=>run(f.root,'init',{...f.brief,executor:'luna'}),/TEAM_SINGLE_FAMILY/);
});

test('the lead guard locks the lead family and refuses lead-set relaxations',t=>{
 const f=fixture(t);
 const switchTo=to_model=>decideModelSwitch({hook_event_name:'PreModelSwitch',cwd:f.root,from_model:'claude-opus-5-5',to_model});
 assert.equal(switchTo('claude-sonnet-5-5'),null);
 assert.equal(switchTo('gpt-6.1-sol').hookSpecificOutput.permissionDecision,'deny');
 assert.equal(switchTo('mystery-model').hookSpecificOutput.permissionDecision,'deny');
 for(const command of ['HF_ALLOW_UNSANDBOXED=1 node x','export HF_LEAD_MODEL=gemini-4-argon','env HF_ALLOWED_VENDORS=openai node y']){
  assert.ok(relaxationEnv(command),command);
  assert.equal(decide({tool_name:'Bash',tool_input:{command},cwd:f.root}).hookSpecificOutput.permissionDecision,'deny',command);
 }
 assert.equal(relaxationEnv('grep -rn HF_ALLOW_UNSANDBOXED scripts'),false);
 const hooks=settingsSnippet().hooks;
 for(const entry of hooks.PreToolUse)assert.equal(entry.hooks[0].onFailure,'block');
 assert.equal(hooks.PreModelSwitch[0].hooks[0].onFailure,'block');
 assert.match(hooks.PostModelSwitch[0].hooks[0].command,/lead-usage\.mjs" --hook$/);
 // 상태 표시·문맥 주입은 실패해도 진행한다.
 assert.equal(hooks.Stop[0].hooks[0].onFailure,undefined);
});

test('a non-Claude lead plans projects by family rules instead of Claude presets',t=>{
 withEnv(t,{[LEAD_MODEL_ENV]:'gpt-6.1-astra'});
 const f=fixture(t,{initialize:false});fs.mkdirSync(path.join(f.root,'docs'));fs.writeFileSync(path.join(f.root,'docs/GDD.md'),'# GDD');
 const plan=(team,excluded,over={})=>({name:'Demo',summary:'demo',sources:['docs/GDD.md'],team,excluded,
  milestones:[{id:'M1',title:'base',goal:'model',checkpoint:['tests pass'],tasks:[{id:'T1',title:'model',kind:'code',difficulty:'low'}]}],...over});
 const member=(m,owns=[])=>({member:m,role:'worker',owns,why:'test'});
 const all=[member('grok',['code:low']),member('sonnet'),member('luna'),member('sol')];
 const rest=[{member:'antigravity',why:'no UI'},{member:'haiku',why:'not needed'}];
 assert.throws(()=>project.validatePlan(f.root,plan(all,rest,{preset:'claude-codex'})),/assumes a Claude lead/);
 const ok=plan(all,rest);project.validatePlan(f.root,ok);
 assert.equal(ok.review.strategy,'lead-gated-adaptive');
 // 리드와 같은 계열만 남는 팀은 배타적 리뷰를 할 수 없다.
 assert.throws(()=>project.validatePlan(f.root,plan([member('luna',['code:low']),member('sol')],[...rest,{member:'grok',why:'x'},{member:'sonnet',why:'x'}])),/TEAM_SINGLE_FAMILY/);
});
