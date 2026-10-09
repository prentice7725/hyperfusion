import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {read} from '../scripts/artifact.mjs';
import * as contract from '../scripts/contracts.mjs';
import {globRegex,runCommands} from '../scripts/acceptance.mjs';

// a.txt가 'fixed'가 아니면 실패한다. 대역 일꾼은 edit 모드에서만 a.txt를 고친다.
const CHECK=`node -e "const s=require('fs').readFileSync('a.txt','utf8');if(s!=='fixed'){console.error('a.txt is '+s);process.exit(3)}"`;
const art=(f,name)=>read(path.join(f.control,'tasks',f.brief.task_id,name));
const accepted=f=>art(f,f.state().acceptance.file);
const withIgnored=(f,ignore,files)=>{
 fs.writeFileSync(path.join(f.root,'.gitignore'),ignore.join('\n')+'\n');
 for(const [p,v] of Object.entries(files)){fs.mkdirSync(path.dirname(path.join(f.root,p)),{recursive:true});fs.writeFileSync(path.join(f.root,p),v);}
 f.git('add','.gitignore');f.git('commit','-m','ignore');
};

test('acceptance commands run after finish and their result is the verification evidence',async t=>{
 const f=fixture(t);f.brief.acceptance_commands=[CHECK];
 f.mode('edit');f.begin();await f.bridge();
 const s=f.state();assert.equal(s.phase,'REVIEW');assert.equal(s.acceptance.status,'pass');
 const r=accepted(f).results[0];
 assert.equal(r.exit_code,0);assert.match(r.output_sha256,/^[0-9a-f]{64}$/);assert.equal(r.command,CHECK);
 f.review('pass');
 assert.throws(()=>run(f.root,'verify',{}),/acceptance_satisfied/);
 assert.equal(run(f.root,'verify',{acceptance_satisfied:true}).phase,'CLOSE');
 const v=art(f,'verification.json');assert.equal(v.acceptance.status,'pass');assert.equal(v.acceptance.reused,'acceptance-1-finish.json');
});

test('a failing acceptance command returns the round to the same worker with the output, before any lead review',async t=>{
 const f=fixture(t);f.brief.acceptance_commands=[CHECK];
 f.begin();await f.bridge();
 const s=f.state();
 assert.equal(s.phase,'REDO');assert.equal(s.acceptance.status,'fail');
 const last=s.reviews.at(-1);assert.equal(last.reviewed_by,'controller');assert.deepEqual(last.blocking_criteria,['Acceptance: '+CHECK]);
 const d=f.begin({lead_feedback:'@review'});
 assert.equal(s.owner,'grok');assert.equal(f.state().owner,'grok');
 const orders=art(f,'brief-2.json').lead_feedback.join('\n');
 assert.match(orders,/exited with 3/);assert.match(orders,/a\.txt is base/);
 assert.ok(d.prompt.includes('acceptance_commands'));
});

test('acceptance runs without the lead\'s secrets',()=>{
 process.env.HF_TEST_SECRET_TOKEN='s3cret';
 try{
  const [r]=runCommands(process.cwd(),['node -e "process.exit(process.env.HF_TEST_SECRET_TOKEN?1:0)"']);
  assert.equal(r.status,'pass');
 }finally{delete process.env.HF_TEST_SECRET_TOKEN;}
});

test('planted gitignored code blocks automatic execution until the lead trusts it',async t=>{
 const f=fixture(t,{initialize:false});
 const marker=path.join(f.temp,'ran.txt');
 withIgnored(f,['node_modules/'],{'node_modules/dep/index.js':'module.exports=1'});
 run(f.root,'init',{...f.brief,executor:'grok'});
 f.brief.acceptance_commands=[`node -e "require('fs').appendFileSync(process.argv[1],'x')" "${marker}"`];
 // 이 명령은 처음부터 통과한다(red-first 대상이 아님). 기준 트리 확인으로 한 번 실행된다.
 f.brief.acceptance_baseline_green='marker command for the ignored-file test';
 f.mode('edit');f.begin();
 assert.equal(fs.readFileSync(marker,'utf8'),'x','baseline check ran once');
 fs.writeFileSync(path.join(f.root,'node_modules/dep/index.js'),'require("child_process");module.exports=2');
 await f.bridge();
 const s=f.state();
 assert.equal(s.phase,'REVIEW','a skipped run is shown to the lead, not bounced');
 assert.equal(s.acceptance.status,'skipped');assert.deepEqual(accepted(f).ignored_changes,['node_modules/dep/index.js']);
 assert.equal(fs.readFileSync(marker,'utf8'),'x','the command never ran after the planted change');
 f.review('pass');
 assert.throws(()=>run(f.root,'verify',{acceptance_satisfied:true}),/not run.*node_modules\/dep\/index\.js/);
 assert.equal(f.state().phase,'VERIFY');
 assert.equal(run(f.root,'verify',{acceptance_satisfied:true,acceptance_trust_ignored:true}).phase,'CLOSE');
 assert.equal(fs.readFileSync(marker,'utf8'),'xx');
 assert.deepEqual(accepted(f).trusted_ignored_changes,['node_modules/dep/index.js']);
});

test('test outputs in known artifact folders do not block acceptance',async t=>{
 const f=fixture(t,{initialize:false});
 withIgnored(f,['coverage/','*.log'],{'coverage/old.json':'{}'});
 run(f.root,'init',{...f.brief,executor:'grok'});
 f.brief.acceptance_commands=[CHECK];
 f.mode('edit');f.begin();
 fs.writeFileSync(path.join(f.root,'coverage/old.json'),'{"new":1}');fs.writeFileSync(path.join(f.root,'debug.log'),'x');
 await f.bridge();
 assert.equal(f.state().acceptance.status,'pass');
});

test('an ignored change after a passing run forces a rerun, and a failure at VERIFY goes back to the worker',async t=>{
 const f=fixture(t,{initialize:false});
 withIgnored(f,['cache/'],{});
 run(f.root,'init',{...f.brief,executor:'grok'});
 f.brief.acceptance_commands=[`node -e "process.exit(require('fs').existsSync('cache/bad')?1:0)"`];
 f.brief.acceptance_baseline_green='guards against a planted cache file';
 f.mode('edit');f.begin();await f.bridge();
 assert.equal(f.state().acceptance.status,'pass');
 f.review('pass');
 fs.mkdirSync(path.join(f.root,'cache'));fs.writeFileSync(path.join(f.root,'cache/bad'),'1');
 assert.throws(()=>run(f.root,'verify',{acceptance_satisfied:true}),/not run.*cache\/bad/);
 const s=run(f.root,'verify',{acceptance_satisfied:true,acceptance_trust_ignored:true});
 assert.equal(s.phase,'REDO');assert.equal(s.reviews.at(-1).reviewed_by,'controller');
 assert.equal(art(f,'review-1-verify.json').verdict,'redo');
});

test('an acceptance command that dirties the tree needs recovery',async t=>{
 const f=fixture(t);
 // 기준 트리에서는 실패(red)하고, 일꾼이 고친 뒤에만 보고서 파일을 쓰는 명령.
 f.brief.acceptance_commands=[`node -e "const fs=require('fs');if(fs.readFileSync('a.txt','utf8')!=='fixed')process.exit(1);fs.writeFileSync('out.txt','report')"`];
 f.mode('edit');f.begin();await f.bridge();
 const s=f.state();
 assert.equal(s.phase,'RECOVERY_REQUIRED');assert.match(s.last_errors[0],/changed the tree: out\.txt/);
});

test('acceptance fields are validated in the brief',t=>{
 const f=fixture(t,{initialize:false});
 const b=extra=>()=>contract.brief({...f.brief,...extra});
 assert.doesNotThrow(b({acceptance_commands:['npm test'],acceptance_timeout_ms:60000,acceptance_artifacts:['dist/**']}));
 for(const bad of [[],[''],['npm test\nrm -rf /'],Array(11).fill('npm test'),'npm test'])assert.throws(b({acceptance_commands:bad}),/acceptance_commands/);
 for(const glob of ['**','**/*','*','../x/**','/abs/**'])assert.throws(b({acceptance_commands:['npm test'],acceptance_artifacts:[glob]}),/acceptance_artifacts/);
 assert.throws(b({acceptance_timeout_ms:1000}),/need acceptance_commands/);
 assert.ok(globRegex('**/*.log').test('a/b/c.log'));assert.ok(globRegex('**/*.log').test('c.log'));
 assert.ok(globRegex('coverage/**').test('coverage/a/b.json'));assert.ok(!globRegex('coverage/**').test('src/coverage.js'));
});

// ── red-first: 처음부터 통과하는 수용 테스트는 관문이 되지 못한다 ───────────────

test('acceptance commands that already pass on the untouched tree are refused unless the lead says why',t=>{
 const f=fixture(t,{initialize:false});
 const green={...f.brief,executor:'grok',acceptance_commands:['node -e "process.exit(0)"']};
 assert.throws(()=>run(f.root,'init',green),/ACCEPTANCE_ALREADY_GREEN/);
 assert.equal(fs.existsSync(path.join(f.control,'state.json')),false,'nothing was started');
 const s=run(f.root,'init',{...green,acceptance_baseline_green:'refactor: existing tests must keep passing'});
 assert.equal(s.acceptance_baseline.status,'green-acknowledged');
});

test('a failing baseline is recorded as red, with the evidence kept',t=>{
 const f=fixture(t,{initialize:false});
 const s=run(f.root,'init',{...f.brief,executor:'grok',acceptance_commands:[CHECK]});
 assert.equal(s.acceptance_baseline.status,'red');
 assert.equal(art(f,s.acceptance_baseline.file).results[0].status,'fail');
});

test('the baseline check also runs when acceptance commands first appear at the first begin',t=>{
 const f=fixture(t);
 assert.throws(()=>f.begin({acceptance_commands:['node -e "process.exit(0)"']}),/ACCEPTANCE_ALREADY_GREEN/);
 assert.equal(f.state().iteration,0);assert.equal(f.state().writer,null);
 f.begin({acceptance_commands:[CHECK]});
 assert.equal(f.state().acceptance_baseline.status,'red');
});

test('a baseline run that changes the tree is refused',t=>{
 const f=fixture(t,{initialize:false});
 assert.throws(()=>run(f.root,'init',{...f.brief,executor:'grok',acceptance_commands:[`node -e "require('fs').writeFileSync('out.txt','x');process.exit(1)"`]}),/ACCEPTANCE_DIRTY.*out\.txt/);
});

test('acceptance commands changed after work started are marked unchecked',async t=>{
 const f=fixture(t);
 f.mode('edit');f.begin({acceptance_commands:[CHECK]});await f.bridge();
 f.review('redo',['AC1']);
 f.begin({acceptance_commands:[CHECK,'node -e "process.exit(0)"']});
 assert.equal(f.state().acceptance_baseline.status,'unchecked');
});
