import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {read} from '../scripts/artifact.mjs';
import * as contract from '../scripts/contracts.mjs';
import {consult} from '../scripts/executor-bridge.mjs';
import {staticBaselineError,passingStaticRecord} from '../scripts/static-gate.mjs';

// 정적 검사 대역: lint.json이 strict면 a.txt에 TODO가 있을 때 실패한다. 설정을 끄면(strict:false) 통과한다.
const LINT=`node -e "const fs=require('fs');const c=JSON.parse(fs.readFileSync('lint.json','utf8'));if(c.strict&&fs.readFileSync('a.txt','utf8').includes('TODO')){console.error('a.txt:1 no-todo');process.exit(1)}"`;
// 수용 대역: a.txt가 fixed로 시작해야 한다.
const ACC=`node -e "if(!require('fs').readFileSync('a.txt','utf8').startsWith('fixed')){console.error('not fixed');process.exit(3)}"`;
const art=(f,name)=>read(path.join(f.control,'tasks',f.brief.task_id,name));
// 정적 필드는 init에만 넘긴다(뒤 브리프가 빠뜨려도 이어받는지 같이 본다). 나머지 필드는 매 라운드 브리프에 둔다.
const setup=(t,extra={},{lint='{"strict":true}',config=null,ignore=null}={})=>{
 const f=fixture(t,{initialize:false});
 for(const [k,v] of Object.entries(extra))if(!k.startsWith('static_')&&k!=='delegation')f.brief[k]=v;
 fs.writeFileSync(path.join(f.root,'lint.json'),lint);
 if(config)fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify(config));
 if(ignore)fs.writeFileSync(path.join(f.root,'.gitignore'),ignore);
 f.git('add','.');f.git('commit','-m','lint config');
 const input={...f.brief,executor:'grok',static_commands:[LINT],static_protect:['lint.json'],...extra};
 return {f,input};
};
const started=(t,extra,opts)=>{const {f,input}=setup(t,extra,opts);run(f.root,'init',input);return f;};
const write=(f,v)=>fs.writeFileSync(path.join(f.root,'a.txt'),v);

test('the brief takes static_commands only with protected config outside the scope',()=>{
 const b={task_id:'T',objective:'o',scope:{paths:['src']},constraints:[],success_criteria:['AC1'],allowed_actions:['edit']};
 assert.throws(()=>contract.brief({...b,static_commands:['npm run lint']}),/static_commands need static_protect/);
 assert.throws(()=>contract.brief({...b,static_commands:['npm run lint'],static_protect:['src/.eslintrc']}),/static_protect overlaps scope\.paths/);
 assert.throws(()=>contract.brief({...b,static_protect:['eslint.config.js']}),/static options need static_commands/);
 assert.throws(()=>contract.brief({...b,static_commands:['a','b','c','d','e','f'],static_protect:['x']}),/Invalid static_commands/);
 assert.throws(()=>contract.brief({...b,static_commands:['a\nb'],static_protect:['x']}),/Invalid static_commands/);
 assert.throws(()=>contract.brief({...b,static_commands:['a'],static_protect:['x'],static_timeout_ms:600001}),/Invalid static_timeout_ms/);
 assert.equal(contract.brief({...b,static_commands:['npm run lint'],static_protect:['eslint.config.js']}).static_commands.length,1);
});

test('init refuses static commands that fail, change the tree or cannot finish on the untouched tree',t=>{
 let {f,input}=setup(t,{},{lint:'{"strict":true}'});
 write(f,'base TODO');f.git('commit','-am','todo');
 assert.throws(()=>run(f.root,'init',input),/STATIC_BASELINE_FAILING[\s\S]*no-todo/);
 ({f,input}=setup(t,{static_commands:[`node -e "require('fs').writeFileSync('a.txt','fixed')"`]}));
 assert.throws(()=>run(f.root,'init',input),/STATIC_DIRTY/);
 ({f,input}=setup(t,{static_commands:[`node -e "setTimeout(()=>{},5000)"`],static_timeout_ms:300}));
 assert.throws(()=>run(f.root,'init',input),/STATIC_UNVERIFIED/);
 ({f,input}=setup(t));
 assert.equal(run(f.root,'init',input).static_baseline.status,'green');
});

test('a static failure returns the round to the same worker without review, with the output in the next order',t=>{
 const f=started(t);
 f.begin();write(f,'fixed TODO');f.finish(f.result(['a.txt']));
 const s=f.state();
 assert.equal(s.phase,'REDO');assert.equal(s.static.status,'fail');
 const last=s.reviews.at(-1);
 assert.equal(last.reviewed_by,'controller');assert.deepEqual(last.blocking_criteria,['STATIC: '+LINT]);
 assert.match(last.static_feedback[0],/no-todo/);
 const record=art(f,'static-1-finish.json');assert.equal(record.results[0].exit_code,1);
 f.begin({lead_feedback:'@review'});
 assert.match(art(f,'brief-2.json').lead_feedback.join('\n'),/Static check[\s\S]*no-todo/);
 assert.equal(art(f,'brief-2.json').static_commands[0],LINT);
});

test('static and acceptance failures reach the worker together in one order',t=>{
 const f=started(t,{acceptance_commands:[ACC]});
 f.begin();write(f,'oops TODO');f.finish(f.result(['a.txt']));
 const last=f.state().reviews.at(-1);
 assert.deepEqual(last.blocking_criteria,['STATIC: '+LINT,'Acceptance: '+ACC]);
 assert.equal(last.static_feedback.length,1);assert.equal(last.acceptance_feedback.length,1);
 f.begin({lead_feedback:'@review'});
 const orders=art(f,'brief-2.json').lead_feedback.join('\n');
 assert.match(orders,/Static check/);assert.match(orders,/Acceptance command/);
});

test('the same static failure twice trips the repeated-rejection rule',t=>{
 const f=started(t);
 f.begin();write(f,'fixed TODO');f.finish(f.result(['a.txt']));
 assert.equal(f.state().phase,'REDO');
 f.begin({lead_feedback:'@review'});write(f,'fixed TODO again');f.finish(f.result(['a.txt']));
 const s=f.state();
 assert.notEqual(s.phase,'REDO');
 assert.ok(s.escalations.length>=1);
});

test('a changed protected config skips the static checks and goes to the lead, and CLOSE needs a reason',t=>{
 const f=started(t,{scope:{paths:['a.txt'],allowed_expansion:'ask-lead'}});
 f.begin();write(f,'fixed TODO');
 fs.writeFileSync(path.join(f.root,'lint.json'),'{"strict":false}');
 f.finish(f.result(['a.txt']));
 // lint.json은 범위 밖이므로 finish가 범위 위반으로 먼저 막는다. 리드가 허용한 뒤에야 관문이 돈다.
 assert.equal(f.state().phase,'RECOVERY_REQUIRED');
 run(f.root,'recover',{quiescent:true,reason:'lead inspected the config change',token:f.state().writer?.token,allow_out_of_scope:[{path:'lint.json',reason:'lead accepts the config change for this test'}]});
 f.begin();f.finish(f.result([]));
 const s=f.state();
 assert.equal(s.phase,'REVIEW');assert.equal(s.static.status,'config_changed');
 assert.deepEqual(s.static.config_changed,['lint.json']);
 assert.equal(s.reviews.filter(r=>r.reviewed_by==='controller').length,0);
 assert.match(s.last_errors.join(' '),/STATIC_CONFIG_CHANGED/);
 f.review('pass');
 assert.throws(()=>run(f.root,'verify',{acceptance_satisfied:true,tests:[{command:'manual',status:'pass'}]}),/STATIC_CONFIG_CHANGED/);
});

test('an incomplete worker result is not returned automatically',t=>{
 let f=started(t);
 f.begin();write(f,'fixed TODO');
 f.finish({...f.result(['a.txt']),status:'blocked',needs_lead_decision:true,unresolved:['which rule applies?'],recommended_next_action:'ask lead'});
 assert.equal(f.state().phase,'REVIEW');assert.equal(f.state().static.status,'fail');
 assert.equal(f.state().reviews.length,0);
});

test('VERIFY reuses a passing finish record and keeps static checks out of the AC table',t=>{
 let f=started(t,{acceptance_commands:[ACC]});
 f.begin();write(f,'fixed');f.finish(f.result(['a.txt']));
 assert.equal(f.state().phase,'REVIEW');assert.equal(f.state().static.status,'pass');
 f.review('pass');
 assert.equal(run(f.root,'verify',{acceptance_satisfied:true}).phase,'CLOSE');
 const v=art(f,'verification.json');
 assert.equal(v.static.reused,'static-1-finish.json');assert.equal(v.acceptance.reused,'acceptance-1-finish.json');
 assert.equal(v.ac_table.some(r=>/STATIC/.test(JSON.stringify(r))),false);
});

test('changed ignored files skip the static checks instead of running repository code',t=>{
 const f=started(t,{},{ignore:'cache/\n'});
 f.begin();
 fs.mkdirSync(path.join(f.root,'cache'),{recursive:true});fs.writeFileSync(path.join(f.root,'cache','plugin.js'),'planted');
 write(f,'fixed');f.finish(f.result(['a.txt']));
 const s=f.state();
 assert.equal(s.static.status,'skipped');assert.equal(s.phase,'REVIEW');
 assert.ok(art(f,'static-1-finish.json').ignored_changes.includes('cache/plugin.js'));
});

test('delegated approval needs a current passing static run',async t=>{
 const CHECK=`node -e "const s=require('fs').readFileSync('a.txt','utf8');if(s!=='fixed'){process.exit(3)}"`;
 const {f,input}=setup(t,{acceptance_commands:[CHECK],acceptance_map:{AC1:[CHECK]},delegation:{policy:'standard-auto',reason:'single-file fix'}},
  {config:{review:{by:'delegate',strategy:'lead-gated-adaptive'}}});
 run(f.root,'init',input);
 f.mode('edit');f.begin();await f.bridge();f.mode('ok');
 assert.equal(f.state().static.status,'pass');
 const c=run(f.root,'delegate-review',{});await consult(f.root,c.consult_id);run(f.root,'consult-finish',{quiescent:true});
 // 정적 기록을 지우면 자동 승인 조건이 무너진다.
 const s=read(path.join(f.control,'state.json'));
 fs.writeFileSync(path.join(f.control,'tasks',f.brief.task_id,s.static.file),JSON.stringify({kind:'static',status:'fail'}));
 assert.throws(()=>run(f.root,'policy-approve',{}),/POLICY_NOT_ELIGIBLE[\s\S]*static/i);
});

test('helpers classify the baseline and the reusable record',()=>{
 const ok={command:'x',status:'pass',quiescence:{quiescent:true}};
 assert.equal(staticBaselineError([ok]),null);
 assert.match(staticBaselineError([ok],['a.txt']),/^STATIC_DIRTY/);
 assert.match(staticBaselineError([{command:'x',status:'fail',timed_out:true}]),/^STATIC_UNVERIFIED/);
 assert.match(staticBaselineError([{command:'x',status:'fail',exit_code:2,output_tail:'boom'}]),/^STATIC_BASELINE_FAILING[\s\S]*boom/);
 const rec={kind:'static',status:'pass',quiescent:true,round:1,tree_digest:'d',commands:['x'],results:[ok]};
 assert.equal(passingStaticRecord(rec,['x'],1,'d'),true);
 assert.equal(passingStaticRecord({...rec,kind:undefined},['x'],1,'d'),false);
 assert.equal(passingStaticRecord(rec,['x'],2,'d'),false);
});
