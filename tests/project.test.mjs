import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {execute} from '../scripts/executor-bridge.mjs';
import {read} from '../scripts/artifact.mjs';
import * as project from '../scripts/project.mjs';

// 기획 문서 하나와 2단계 마일스톤을 가진 프로젝트. Antigravity는 UI가 없어서 뺀다.
const plan=(over={})=>({
 name:'Mado Ilbo',summary:'신문 웹진 MVP',sources:['docs/GDD.md'],
 team:[
  {member:'sonnet',role:'핵심 구현',owns:['code:medium|high','tests'],why:'로직이 까다로움'},
  {member:'luna',role:'쉬운 구현·소규모 수정',owns:['code:low','docs'],why:'빠르고 저렴'},
  {member:'grok',role:'삽화 애셋',owns:['image-asset'],why:'이미지 생성'},
  {member:'sol',role:'리뷰 전담',owns:[],why:'Opus와 다른 계열의 교차 검증'}],
 excluded:[{member:'antigravity',why:'UI 작업이 없음'}],
 milestones:[
  {id:'M1',title:'기반',goal:'기사 모델',checkpoint:['기사 CRUD 테스트 통과'],tasks:[{id:'T1',title:'기사 모델',kind:'code',difficulty:'high'},{id:'T2',title:'README',kind:'docs'}]},
  {id:'M2',title:'삽화',goal:'표지 이미지',checkpoint:['표지 3종'],tasks:[{id:'T3',title:'표지',kind:'image-asset'}]}],
 risks:['기사 스키마 미확정'],questions:['로그인 필요?'],...over});
const setup=t=>{const f=fixture(t,{initialize:false});fs.mkdirSync(path.join(f.root,'docs'));fs.writeFileSync(path.join(f.root,'docs/GDD.md'),'# GDD');return f;};
// 이후 begin/finish가 같은 작업 ID를 쓰도록 fixture의 brief도 바꿔 둔다.
const task=(f,id,extra={})=>{const out=run(f.root,'init',{...f.brief,task_id:id,...extra});f.brief.task_id=id;return out;};
const close=f=>{f.begin();f.finish();f.review('pass');run(f.root,'verify',{acceptance_satisfied:true,tests:[{command:'npm test',status:'pass'}]});};
const approved=t=>{const f=setup(t);project.propose(f.root,plan());project.approve(f.root,{user_message:'그대로 가자'});return f;};

test('roster lists every member with default role, model and install state',t=>{
 const f=setup(t);const r=project.roster(f.root);
 assert.deepEqual(r.map(x=>x.member),['sonnet','grok','antigravity','luna','sol']);
 assert.equal(r.find(x=>x.member==='sol').model,'gpt-6.1-sol');assert.equal(r.find(x=>x.member==='sol').implementer,false);
 assert.equal(r.find(x=>x.member==='luna').model,'gpt-6-luna');assert.ok(r.every(x=>x.installed));
});
test('a plan must decide on every member, give reasons, and keep Sol a reviewer',t=>{
 const f=setup(t);
 assert.throws(()=>project.propose(f.root,plan({excluded:[]})),/Decide on every member.*antigravity/);
 assert.throws(()=>project.propose(f.root,plan({sources:['docs/missing.md']})),/sources/);
 const bad=plan();bad.team[3]={...bad.team[3],owns:['code']};assert.throws(()=>project.propose(f.root,bad),/sol reviews/);
 const noWhy=plan();delete noWhy.team[0].why;assert.throws(()=>project.propose(f.root,noWhy),/role and why/);
 const both=plan({excluded:[{member:'sonnet',why:'x'},{member:'antigravity',why:'x'}]});assert.throws(()=>project.propose(f.root,both),/both on the team/);
});
test('the team report shows roles, models, exclusions, milestones and who goes first',t=>{
 const f=setup(t);const out=project.propose(f.root,plan());
 assert.equal(out.status,'PROPOSED');const r=out.report;
 assert.match(r,/팀 구성안 \(rev 1, 승인 대기\)/);
 assert.match(r,/\| sol \| gpt-6\.1-sol \| 리뷰 전담 \| 리뷰 \|/);
 // 표 칸 안의 '|'가 칸을 깨지 않는다.
 assert.ok(r.includes('`code:medium\\|high`'));for(const row of r.split('\n').filter(l=>l.startsWith('| sonnet')))assert.equal(row.split(/(?<!\\)\|/).length-2,6);
 assert.match(r,/\| antigravity \| UI 작업이 없음 \|/);
 assert.match(r,/\| T1 기사 모델 \| code \| high \| sonnet \|/);assert.match(r,/\| T2 README \| docs \| - \| luna \|/);
 assert.match(r,/리뷰: 위임 — sol → sonnet → luna → grok/);
 assert.match(r,/- \[ \] 기사 CRUD 테스트 통과/);assert.match(r,/로그인 필요\?/);
 assert.match(r,/승인 전에는 작업을 시작하지 않습니다/);
});
test('no task starts before the user approves, and approval needs the user\'s words',t=>{
 const f=setup(t);project.propose(f.root,plan());
 assert.throws(()=>task(f,'T1'),/PROJECT_NOT_APPROVED/);
 assert.throws(()=>project.approve(f.root,{}),/user's own approval/);
 assert.equal(project.approve(f.root,{user_message:'그대로 가자'}).active_milestone,'M1');
 const p=project.loadProject(f.root);assert.equal(p.history.at(-1).message,'그대로 가자');assert.equal(p.history.at(-1).by,'user');
});
test('only tasks of the active milestone can start, with the approved team frozen in',t=>{
 const f=approved(t);
 assert.throws(()=>task(f,'T3'),/not in milestone M1; planned: T1, T2/);
 assert.throws(()=>task(f,'T9'),/not in milestone M1/);
 const s=task(f,'T1');
 assert.equal(s.routing.task_kind,'code');assert.equal(s.initial_executor,'sonnet');
 assert.deepEqual(s.configuration.external.available,['sonnet','luna','grok']);
 assert.equal(s.configuration.review.by,'delegate');assert.deepEqual(s.configuration.review.reviewers,['sol','sonnet','luna','grok']);
 assert.deepEqual(s.project,{name:'Mado Ilbo',milestone:'M1',task:'T1'});
 assert.equal(project.status(f.root).milestones[0].tasks[0],'T1:active');
});
test('excluded members are never called in this project',t=>{
 const f=approved(t);
 assert.throws(()=>task(f,'T1',{executor:'antigravity'}),/not enabled/);
});
test('finishing a milestone forces a checkpoint report and the user\'s ack before the next one',async t=>{
 const f=approved(t);
 task(f,'T1');close(f);
 assert.equal(project.status(f.root).active_milestone,'M1');
 assert.ok(fs.existsSync(path.join(f.control,'metrics/T1.json')),'metrics written automatically at CLOSE');
 task(f,'T2');f.begin();f.finish();f.review('redo',['AC1']);f.begin();f.finish();f.review('pass');run(f.root,'verify',{acceptance_satisfied:true,tests:[{command:'check',status:'pass'}]});
 assert.deepEqual(project.status(f.root).checkpoint_due,['M1']);
 assert.throws(()=>task(f,'T3'),/PROJECT_CHECKPOINT_PENDING: M1/);
 assert.throws(()=>project.ack(f.root,{milestone:'M1',user_message:'ok'}),/run checkpoint first/);
 const cp=project.checkpoint(f.root);
 assert.match(cp.report,/체크포인트 M1: 기반/);
 assert.match(cp.report,/\| T1 기사 모델 \| ✅ 완료 \| sonnet×1 \| 1 \| 1회 \| - \|/);
 assert.match(cp.report,/\| T2 README \| ✅ 완료 \| luna×2 \| 2 \| 2회 \| - \|/);
 assert.match(cp.report,/\| luna \| 2 \| 1 \|/);assert.match(cp.report,/M2\. 삽화/);
 assert.throws(()=>task(f,'T3'),/PROJECT_CHECKPOINT_PENDING/);
 assert.equal(project.ack(f.root,{milestone:'M1',user_message:'다음으로'}).active_milestone,'M2');
 assert.equal(task(f,'T3').initial_executor,'grok');
});
test('a blocked task also settles, and the checkpoint flags it',t=>{
 const f=approved(t);
 project.amend(f.root,{drop_tasks:[{id:'T2',why:'문서는 나중에'}]});
 task(f,'T1');
 for(const [i,e] of ['sonnet','luna','grok'].entries()){if(i)f.begin({executor:e});else f.begin();f.finish();f.review('redo',['A'+i]);for(let k=0;k<2;k++){f.begin();f.finish();f.review('redo',['B'+i+k]);}}
 assert.equal(f.state().phase,'TAKEOVER_REQUIRED');
 f.begin({takeover_reason:'all failed'});f.finish();f.review('redo');
 assert.equal(f.state().phase,'BLOCKED');
 const cp=project.checkpoint(f.root).report;
 assert.match(cp,/⛔ 막힘/);assert.match(cp,/제외 — 문서는 나중에/);assert.match(cp,/## 막힌 작업/);assert.match(cp,/구성 조정 제안/);
});
test('changing the team needs re-approval; adding a task to the running milestone does not',t=>{
 const f=approved(t);
 const a=project.amend(f.root,{add_tasks:[{milestone:'M1',task:{id:'T1b',title:'기사 검색',kind:'code',difficulty:'low'}}]});
 assert.equal(a.needs_approval,false);assert.equal(a.status,'ACTIVE');assert.match(a.report,/T1b 기사 검색 _\(추가\)_/);
 assert.equal(task(f,'T1b').initial_executor,'luna');
 const b=project.amend(f.root,{team:plan().team.filter(x=>x.member!=='grok'),excluded:[{member:'antigravity',why:'UI 없음'},{member:'grok',why:'삽화는 외주'}],user_message:'grok은 빼자'});
 assert.equal(b.needs_approval,true);assert.equal(b.status,'PROPOSED');assert.match(b.report,/rev 2, 승인 대기/);assert.match(b.report,/\| grok \| 삽화는 외주 \|/);
 f.begin();f.finish();f.review('pass');run(f.root,'verify',{acceptance_satisfied:true,tests:[{command:'c',status:'pass'}]});
 assert.throws(()=>task(f,'T1'),/PROJECT_NOT_APPROVED/);
 project.approve(f.root,{user_message:'좋아'});
 assert.deepEqual(task(f,'T1').configuration.external.available,['sonnet','luna']);
 assert.match(project.teamReport(f.root),/T3 표지 \| image-asset \| - \| sonnet/);
});
test('a checkpoint ack can carry the user\'s team change',t=>{
 const f=approved(t);project.amend(f.root,{drop_tasks:[{id:'T2',why:'later'}]});
 task(f,'T1');close(f);project.checkpoint(f.root);
 const team=plan().team.map(x=>x.member==='luna'?{...x,owns:['code:low','docs','image-asset']}:x);
 const out=project.ack(f.root,{milestone:'M1',user_message:'luna한테 삽화도 맡겨',changes:{team}});
 assert.equal(out.amend.needs_approval,true);assert.throws(()=>task(f,'T3'),/PROJECT_NOT_APPROVED/);
 project.approve(f.root,{user_message:'ok'});
 assert.equal(task(f,'T3').initial_executor,'luna');
});
test('a completed project no longer gates tasks',t=>{
 const f=setup(t);project.propose(f.root,plan({milestones:[plan().milestones[0]]}));project.approve(f.root,{user_message:'go'});
 project.amend(f.root,{drop_tasks:[{id:'T2',why:'x'}]});task(f,'T1');close(f);project.checkpoint(f.root);
 assert.equal(project.ack(f.root,{milestone:'M1',user_message:'끝'}).status,'COMPLETE');
 assert.equal(run(f.root,'init',{...f.brief,task_id:'adhoc-1'}).phase,'PLAN');
});
test('Luna implements through Codex with workspace-write; Sol never takes the writer lease',async t=>{
 const f=fixture(t,{executor:'luna'});
 const d=f.begin();
 assert.equal(d.executor,'luna');assert.equal(d.cli.model,'gpt-6-luna');
 const a=d.cli.args;assert.equal(a[a.indexOf('--sandbox')+1],'workspace-write');assert.equal(a[a.indexOf('-m')+1],'gpt-6-luna');
 f.mode('edit');const out=await execute(f.root);f.finish(read(out.result_file));
 assert.equal(f.state().phase,'REVIEW');assert.equal(fs.readFileSync(path.join(f.root,'a.txt'),'utf8'),'fixed');
 assert.throws(()=>run(f.root,'init',{...f.brief,task_id:'x2',executor:'sol'}),/Existing unfinished|only reviews/);
});
test('Sol and Luna models can be overridden per project config',t=>{
 const f=fixture(t,{initialize:false});fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({executors:{luna:{model:'gpt-6-luna-mini'},sol:{model:'gpt-6.1-sol',reasoning_effort:'xhigh'}}}));
 assert.equal(project.roster(f.root).find(x=>x.member==='luna').model,'gpt-6-luna-mini');
 run(f.root,'init',{...f.brief,executor:'luna'});assert.equal(f.begin().cli.args.includes('gpt-6-luna-mini'),true);
});
