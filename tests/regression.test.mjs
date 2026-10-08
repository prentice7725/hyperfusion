import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {consult} from '../scripts/executor-bridge.mjs';
import {read} from '../scripts/artifact.mjs';
import {safePath,brief as validateBrief} from '../scripts/contracts.mjs';
import {EXECUTORS,config} from '../scripts/executor-config.mjs';
import {route} from '../scripts/router.mjs';
import {measure} from '../scripts/metrics.mjs';
import * as project from '../scripts/project.mjs';

// 코드 리뷰에서 재현으로 확인된 결함들. 각 테스트는 고치기 전에 실패해야 한다.

const writeConfig=(f,value)=>fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify(value));
const grind=(f,rounds)=>{for(let i=0;i<rounds;i++){f.begin();f.finish();f.review('redo',['AC'+i]);}};
const memDir=t=>{
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'hf-reg-mem-'));
 const old=process.env.HF_MEMORY_DIR;process.env.HF_MEMORY_DIR=d;
 t.after(()=>{if(old===undefined)delete process.env.HF_MEMORY_DIR;else process.env.HF_MEMORY_DIR=old;fs.rmSync(d,{recursive:true,force:true});});
};

// ── HIGH 1: 설치 안 된 일꾼이 available에 있으면 작업이 멈춘다 ────────────

test('an uninstalled worker in "available" does not trap the task when the installed one is spent (explicit)',t=>{
 const f=fixture(t,{initialize:false});
 process.env.HF_CODEX_BIN=path.join(f.temp,'no-codex');
 writeConfig(f,{external:{default:'grok',available:['grok','luna']}});
 run(f.root,'init',{...f.brief,executor:'grok'});
 grind(f,3);
 assert.equal(f.state().phase,'TAKEOVER_REQUIRED');
 assert.equal(f.begin({takeover_reason:'only grok is installed and it failed three times'}).transport,'lead-takeover');
});
test('the same holds when the router picked the worker (auto)',t=>{
 const f=fixture(t,{initialize:false});
 process.env.HF_CODEX_BIN=path.join(f.temp,'no-codex');
 writeConfig(f,{external:{default:'auto',available:['grok','luna']}});
 run(f.root,'init',f.brief);
 assert.equal(f.state().initial_executor,'grok');
 grind(f,3);
 assert.equal(f.state().phase,'TAKEOVER_REQUIRED');
});
test('a worker that disappears after init is skipped, and the task moves on instead of getting stuck',t=>{
 const f=fixture(t,{initialize:false});
 writeConfig(f,{external:{default:'grok',available:['grok','luna']}});
 run(f.root,'init',{...f.brief,executor:'grok'});
 grind(f,3);
 assert.equal(f.state().phase,'ALTERNATIVE_REQUIRED');
 process.env.HF_CODEX_BIN=path.join(f.temp,'gone');
 assert.throws(()=>f.begin(),/No installed alternative/);
 assert.equal(f.state().phase,'TAKEOVER_REQUIRED');
 assert.equal(f.begin({takeover_reason:'luna vanished'}).transport,'lead-takeover');
});
test('only workers that are installed count as "still has budget" when ordering a takeover',t=>{
 const f=fixture(t,{initialize:false});
 writeConfig(f,{external:{default:'grok',available:['grok','luna']}});
 run(f.root,'init',{...f.brief,executor:'grok'});
 f.begin();f.finish();
 assert.throws(()=>f.review('takeover'),/Workers still have budget \(grok, luna\)/);
 process.env.HF_CODEX_BIN=path.join(f.temp,'no-codex');
 assert.throws(()=>f.review('takeover'),/Workers still have budget \(grok\)/);
});

// ── HIGH 2: 실패한 라운드의 범위 밖 변경이 CLOSE까지 남는다 ───────────────

const stray=f=>{
 f.begin();
 fs.writeFileSync(path.join(f.root,'b.txt'),'stray');
 assert.equal(f.finish(f.result(['b.txt'])).phase,'RECOVERY_REQUIRED');
 return f.state().writer.token;
};
const recoverRound=(f,token,extra={})=>run(f.root,'recover',{token,quiescent:true,reason:'worker stopped; diff inspected',...extra});
const goodRound=f=>{f.begin();fs.writeFileSync(path.join(f.root,'a.txt'),'fixed');return f.finish(f.result(['a.txt']));};

test('a stray file from a failed round is flagged again in the next round instead of being absorbed into its baseline',t=>{
 const f=fixture(t);
 recoverRound(f,stray(f));
 const s=goodRound(f);
 assert.equal(s.phase,'RECOVERY_REQUIRED');
 assert.ok(s.last_errors.some(e=>/Earlier out-of-scope changes still present: b\.txt/.test(e)),JSON.stringify(s.last_errors));
});
test('reverting the stray file lets the task finish normally',t=>{
 const f=fixture(t);
 recoverRound(f,stray(f));
 fs.rmSync(path.join(f.root,'b.txt'));
 assert.equal(goodRound(f).phase,'REVIEW');
 f.review('pass');
 assert.equal(run(f.root,'verify',{acceptance_satisfied:true,tests:[{command:'t',status:'pass'}]}).phase,'CLOSE');
});
test('the lead can knowingly accept an out-of-scope file, with a reason, and it is recorded',t=>{
 const f=fixture(t);
 const token=stray(f);
 assert.throws(()=>recoverRound(f,token,{allow_out_of_scope:[{path:'b.txt'}]}),/reason/);
 assert.throws(()=>recoverRound(f,token,{allow_out_of_scope:[{path:'../x',reason:'r'}]}),/allow_out_of_scope/);
 recoverRound(f,token,{allow_out_of_scope:[{path:'b.txt',reason:'the user asked for b.txt as part of this fix'}]});
 assert.equal(goodRound(f).phase,'REVIEW');
 f.review('pass');
 run(f.root,'verify',{acceptance_satisfied:true,tests:[{command:'t',status:'pass'}]});
 assert.equal(f.state().phase,'CLOSE');
 assert.equal(f.state().scope_exceptions[0].path,'b.txt');
});
test('verify is the last line of defence: it compares everything to the original baseline',t=>{
 const f=fixture(t);
 recoverRound(f,stray(f),{allow_out_of_scope:[{path:'b.txt',reason:'accepted'}]});
 goodRound(f);f.review('pass');
 const stateFile=path.join(f.control,'state.json');
 const tampered=read(stateFile);tampered.scope_exceptions=[];fs.writeFileSync(stateFile,JSON.stringify(tampered));
 const evidence={acceptance_satisfied:true,tests:[{command:'t',status:'pass'}]};
 assert.throws(()=>run(f.root,'verify',evidence),/Out-of-scope changes since the baseline: b\.txt/);
 assert.equal(f.state().phase,'VERIFY');
 assert.equal(run(f.root,'verify',{...evidence,allow_out_of_scope:[{path:'b.txt',reason:'accepted at verify'}]}).phase,'CLOSE');
 assert.equal(read(path.join(f.control,'tasks/HF-test/verification.json')).allow_out_of_scope[0].path,'b.txt');
});
test('a user edit made between rounds is caught by verify, not silently shipped',t=>{
 const f=fixture(t);
 f.begin();f.finish();f.review('redo',['AC1']);
 fs.writeFileSync(path.join(f.root,'notes.txt'),'unrelated edit between rounds');
 goodRound(f);f.review('pass');
 assert.throws(()=>run(f.root,'verify',{acceptance_satisfied:true,tests:[{command:'t',status:'pass'}]}),/notes\.txt/);
});

// ── MEDIUM 3: BLOCKED 작업이 체크포인트에서 "보관"으로 바뀐다 ──────────────

const plan=()=>({
 name:'Mado Ilbo',summary:'MVP',sources:['docs/GDD.md'],
 team:[
  {member:'sonnet',role:'핵심 구현',owns:['code:medium|high','tests'],why:'로직이 까다로움'},
  {member:'luna',role:'쉬운 구현',owns:['code:low','docs'],why:'빠르고 저렴'},
  {member:'grok',role:'삽화',owns:['image-asset'],why:'이미지 생성'},
  {member:'sol',role:'리뷰',owns:[],why:'교차 검증'}],
 excluded:[{member:'antigravity',why:'UI 없음'}],
 milestones:[
  {id:'M1',title:'기반',goal:'기사 모델',checkpoint:['CRUD 통과'],tasks:[{id:'T1',title:'기사 모델',kind:'code',difficulty:'high'},{id:'T2',title:'README',kind:'docs'}]},
  {id:'M2',title:'삽화',goal:'표지',checkpoint:['표지 3종'],tasks:[{id:'T3',title:'표지',kind:'image-asset'}]}]
});
const approved=t=>{
 const f=fixture(t,{initialize:false});
 fs.mkdirSync(path.join(f.root,'docs'));fs.writeFileSync(path.join(f.root,'docs/GDD.md'),'# GDD');
 project.propose(f.root,plan());project.approve(f.root,{user_message:'go'});return f;
};
const task=(f,id)=>{const out=run(f.root,'init',{...f.brief,task_id:id});f.brief.task_id=id;return out;};
const closeTask=f=>{f.begin();f.finish();f.review('pass');run(f.root,'verify',{acceptance_satisfied:true,tests:[{command:'t',status:'pass'}]});};
// 팀의 일꾼 셋이 각각 3라운드를 다 쓰게 해서 takeover 직전까지 만든다.
const exhaustWorkers=f=>{
 for(const [i,e] of ['sonnet','luna','grok'].entries()){
  if(i)f.begin({executor:e});else f.begin();
  f.finish();f.review('redo',['A'+i]);
  for(let k=0;k<2;k++){f.begin();f.finish();f.review('redo',['B'+i+k]);}
 }
 assert.equal(f.state().phase,'TAKEOVER_REQUIRED');
};
const blockTask=f=>{
 exhaustWorkers(f);
 f.begin({takeover_reason:'all failed'});f.finish();f.review('redo');
 assert.equal(f.state().phase,'BLOCKED');
};
const taskStatus=(f,id)=>project.loadProject(f.root).milestones.flatMap(m=>m.tasks).find(x=>x.id===id).status;

test('a blocked task lets the next task of the milestone start, and the checkpoint still shows it as blocked',t=>{
 const f=approved(t);
 task(f,'T1');blockTask(f);
 assert.equal(taskStatus(f,'T1'),'blocked');
 task(f,'T2');closeTask(f);
 assert.equal(taskStatus(f,'T1'),'blocked');
 const cp=project.checkpoint(f.root).report;
 assert.match(cp,/\| T1 기사 모델 \| ⛔ 막힘 \|/);assert.match(cp,/## 막힌 작업/);
});
test('archiving a blocked or closed project task does not rewrite what happened to it',t=>{
 const f=approved(t);
 task(f,'T1');blockTask(f);
 run(f.root,'archive',{quiescent:true,reason:'cleanup'});
 assert.equal(taskStatus(f,'T1'),'blocked');
 task(f,'T2');closeTask(f);
 run(f.root,'archive',{quiescent:true,reason:'cleanup'});
 assert.equal(taskStatus(f,'T2'),'closed');
});

// ── MEDIUM 4: 승인용 보고서의 "1순위"가 실제 배치와 다르다 ────────────────

test('the report\'s first pick is exactly what the router would choose, including tasks without a difficulty',t=>{
 const f=fixture(t,{initialize:false});
 fs.mkdirSync(path.join(f.root,'docs'));fs.writeFileSync(path.join(f.root,'docs/GDD.md'),'# GDD');
 // Sonnet은 tests만, Luna는 code:low를 맡는다. 난이도 없는 code 작업을 느슨하게 매칭하면 Luna로 잘못 나온다.
 const p=plan();
 p.team=[
  {member:'sonnet',role:'테스트',owns:['tests'],why:'테스트 설계'},
  {member:'luna',role:'쉬운 구현',owns:['code:low','docs'],why:'빠르고 저렴'},
  {member:'grok',role:'삽화',owns:['image-asset'],why:'이미지 생성'},
  {member:'sol',role:'리뷰',owns:[],why:'교차 검증'}];
 const tasks=[
  {id:'R1',title:'one',kind:'code'},{id:'R2',title:'two',kind:'code',difficulty:'low'},{id:'R3',title:'three',kind:'tests'},
  {id:'R4',title:'four',kind:'ui'},{id:'R5',title:'five',kind:'docs',difficulty:'high'},{id:'R6',title:'six',kind:'code',difficulty:'high'}];
 p.milestones=[{id:'M1',title:'기반',goal:'g',checkpoint:['c'],tasks}];
 project.propose(f.root,p);
 const stored=project.loadProject(f.root);
 const base=config(f.root);
 const report=project.teamReport(f.root);
 for(const x of tasks){
  const row=report.split('\n').find(l=>l.startsWith(`| ${x.id} `));
  assert.ok(row,`row for ${x.id}`);
  const shown=row.split('|').map(cell=>cell.trim()).filter(Boolean).at(-1);
  const chosen=route(f.root,{...base,routing:{...base.routing,rules:project.teamRules(stored)}},{task_kind:x.kind,difficulty:x.difficulty},{probe:false}).executor;
  assert.equal(shown,chosen,`${x.id} ${x.kind}/${x.difficulty??'-'}`);
 }
 assert.match(report,/\| R1 one \| code \| - \| sonnet \|/);
});
test('a task nobody owns exactly is reported as a warning, not silently matched to someone loosely',t=>{
 const f=fixture(t,{initialize:false});
 fs.mkdirSync(path.join(f.root,'docs'));fs.writeFileSync(path.join(f.root,'docs/GDD.md'),'# GDD');
 const p=plan();p.milestones[0].tasks=[{id:'T1',title:'one',kind:'code'},{id:'T2',title:'two',kind:'code',difficulty:'high'}];
 const out=project.propose(f.root,p);
 assert.ok(out.warnings.some(w=>w.startsWith('T1:')),JSON.stringify(out.warnings));
 assert.ok(!out.warnings.some(w=>w.startsWith('T2:')),JSON.stringify(out.warnings));
});

// ── 문서 모순 ─────────────────────────────────────────────────────────

test('SKILL.md does not forbid a worker that the code supports',()=>{
 const skill=fs.readFileSync(new URL('../SKILL.md',import.meta.url),'utf8');
 assert.doesNotMatch(skill,/`luna`는 일꾼 이름이 아니다/);
 const line=skill.split('\n').find(l=>l.includes('/hyperfusion --executor'));
 for(const name of EXECUTORS)assert.ok(line.includes(name),`--executor list is missing ${name}`);
 assert.match(skill,/sol.*(리뷰|상담)/);
});
test('README does not claim Luna was removed without saying it came back',()=>{
 for(const file of ['../README.md','../README.ja.md']){
  const text=fs.readFileSync(new URL(file,import.meta.url),'utf8');
  const row=text.split('\n').find(l=>/^\| Luna \| (제거|削除)/.test(l));
  assert.equal(row,undefined,`${file}: stale "Luna removed" row`);
 }
});

// ── 지표·수확·정산 ────────────────────────────────────────────────────

test('a metrics failure is reported instead of swallowed, and the task still closes',t=>{
 const f=fixture(t);
 fs.writeFileSync(path.join(f.control,'metrics'),'not a directory');
 f.begin();f.finish();f.review('pass');
 const s=run(f.root,'verify',{acceptance_satisfied:true,tests:[{command:'t',status:'pass'}]});
 assert.equal(s.phase,'CLOSE');
 assert.match(s.metrics_error,/./);
});
test('reaching BLOCKED through decide or recover also records metrics and settles the project task',t=>{
 // decide 경로: takeover 라운드 뒤 리드가 decision을 내면 BLOCKED가 된다.
 const a=fixture(t,{initialize:false});
 writeConfig(a,{external:{default:'grok',available:['grok']}});
 run(a.root,'init',{...a.brief,executor:'grok'});
 grind(a,3);a.begin({takeover_reason:'x'});a.finish();a.review('decision');
 assert.equal(run(a.root,'decide',{decision:'give up'}).phase,'BLOCKED');
 // measure()를 직접 부르면 파일이 생기므로, 컨트롤러가 이미 남겼는지 먼저 본다.
 assert.ok(fs.existsSync(path.join(a.control,'metrics/HF-test.json')),'metrics written when decide ended the task');
 // recover 경로: takeover 라운드가 형식 오류로 끝나 복구하면 BLOCKED가 된다.
 const b=approved(t);
 task(b,'T1');
 exhaustWorkers(b);
 b.begin({takeover_reason:'x'});
 const token=b.state().writer.token;
 assert.equal(b.finish({}).phase,'RECOVERY_REQUIRED');
 assert.equal(run(b.root,'recover',{token,quiescent:true,reason:'lead round invalid; inspected'}).phase,'BLOCKED');
 assert.equal(taskStatus(b,'T1'),'blocked');
 assert.ok(fs.existsSync(path.join(b.control,'metrics/T1.json')));
});
test('a failing memory ledger cannot break finish or leave a closed task active in the project',t=>{
 memDir(t);
 const f=approved(t);
 writeConfig(f,{memory:{workspace:'regression'}});
 task(f,'T1');
 const ledger=path.join(f.control,'tasks/T1/memory-candidates.json');
 fs.mkdirSync(ledger);
 f.begin();
 const r=f.result();r.memory_candidates=[{type:'error',content:'A failed because B'}];
 assert.equal(f.finish(r).phase,'REVIEW');
 assert.match(f.state().memory_error,/./);
 f.review('pass');
 const s=run(f.root,'verify',{acceptance_satisfied:true,tests:[{command:'t',status:'pass'}]});
 assert.equal(s.phase,'CLOSE');
 assert.equal(taskStatus(f,'T1'),'closed');
});

// ── 위임 리뷰: 복구가 필요한 상태에서 잘못된 안내 ────────────────────────

test('when the tree changed before a delegated review, the lead is told to recover, not to adopt',async t=>{
 const f=fixture(t,{initialize:false});
 writeConfig(f,{review:{by:'delegate'}});
 run(f.root,'init',{...f.brief,executor:'grok'});
 f.begin();f.finish();
 fs.writeFileSync(path.join(f.root,'a.txt'),'changed after the round finished');
 const c=run(f.root,'delegate-review',{});
 await consult(f.root,c.consult_id);
 const out=run(f.root,'consult-finish',{quiescent:true});
 assert.equal(f.state().phase,'RECOVERY_REQUIRED');
 assert.equal(out.review.status,'recovery_required');
 assert.match(out.review.next_action,/recover/);
 assert.equal(f.state().pending_review??null,null);
});

// ── 입력 검사 ─────────────────────────────────────────────────────────

test('"." and "./src" are not valid scope paths, and the error names the culprit',()=>{
 for(const bad of ['.','./src','src/.','a//b','src/']){
  assert.equal(safePath(bad),false,bad);
 }
 assert.equal(safePath('src/a.js'),true);
 const base={task_id:'T',objective:'o',constraints:[],success_criteria:['AC1'],allowed_actions:['read'],forbidden_actions:['commit','push','deploy','release','scope-expansion'],evidence_required:['files_changed','commands_run','test_results','remaining_risks']};
 assert.throws(()=>validateBrief({...base,scope:{paths:['src','./lib'],allowed_expansion:'ask-lead'}}),/Invalid bounded scope.*\.\/lib/);
});

// ── 하드코딩된 일꾼 목록 ───────────────────────────────────────────────

test('worker lists come from EXECUTORS, so a new worker needs no scattered edits',t=>{
 const f=fixture(t);f.begin();
 assert.deepEqual(Object.keys(measure(f.root).worker_rounds),EXECUTORS);
 for(const file of ['scripts/executor-bridge.mjs','scripts/metrics.mjs']){
  const text=fs.readFileSync(new URL('../'+file,import.meta.url),'utf8');
  assert.doesNotMatch(text,/\['grok','antigravity','sonnet'(,'luna')?\]/,file);
 }
});

test('every implementer in EXECUTORS has a team catalog entry, so the roster cannot silently omit one',()=>{
 assert.deepEqual([...project.MEMBERS].sort(),[...EXECUTORS,'sol'].sort());
});
