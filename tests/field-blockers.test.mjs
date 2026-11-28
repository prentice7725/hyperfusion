import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {consult} from '../scripts/executor-bridge.mjs';
import {autopilot} from '../scripts/autopilot.mjs';
import {read} from '../scripts/artifact.mjs';
import {config,consultExecutorOptions} from '../scripts/executor-config.mjs';
import {assertCommandLine,windowsCommandLineLength,isWin} from '../scripts/platform.mjs';
import {schemaFor,extractResult} from '../scripts/adapters/common.mjs';
import {dispatch as agyDispatch,oversizeHint} from '../scripts/adapters/antigravity.mjs';
import {parse as grokParse} from '../scripts/adapters/grok.mjs';
import * as contract from '../scripts/contracts.mjs';

// KF3/KF4a field run: blockers found under lead-gated-adaptive review.
const task=(f,...parts)=>path.join(f.control,'tasks',f.brief.task_id,...parts);

// ── 1. agy command line ────────────────────────────────────────────
const agyBrief=extra=>({task_id:'T',round:2,repo_root:'/tmp/r',objective:'o',scope:{paths:['src'],allowed_expansion:'ask-lead'},constraints:[],success_criteria:['AC1'],
 allowed_actions:['read','edit','test'],forbidden_actions:['commit'],evidence_required:[],...extra});
const agyCli={executable:'agy',prefix_args:[],supports:{'--print-timeout':true,'--new-project':true}};
const promptFile=path.join('/tmp','ctl','prompt-2.txt');

test('agy gets its JSON schema as a file path, not as a command-line string',()=>{
 const brief=agyBrief({});
 const d=agyDispatch(brief,{token:'x',owner:'antigravity'},{session:null,resume:false,probe:agyCli,promptFile,options:{}});
 const value=d.cli.args[d.cli.args.indexOf('--json-schema')+1];
 assert.equal(value,path.join('/tmp','ctl','prompt-2.schema.json'));
 assert.deepEqual(d.cli.extra_files,[{path:value,content:JSON.stringify(schemaFor(brief))}]);
 assert.ok(!d.cli.args.some(a=>a.includes('"properties"')&&a!==d.cli.args[d.cli.args.indexOf('-p')+1]),'no inline schema in argv');
 assert.throws(()=>agyDispatch(brief,{token:'x',owner:'antigravity'},{session:null,resume:false,probe:agyCli,options:{}}),/promptFile/);
});

test('the Windows command-line count follows the real argument quoting',()=>{
 assert.equal(windowsCommandLineLength('a',['']),'a'.length+1+2);
 assert.equal(windowsCommandLineLength('a',['plain']),1+1+5);
 assert.equal(windowsCommandLineLength('a',['two words']),1+1+11);
 assert.equal(windowsCommandLineLength('a',['say "hi"']),1+1+12);
 assert.equal(windowsCommandLineLength('a',['dir\\ x\\']),1+1+10);
 assert.equal(windowsCommandLineLength('a',['back\\"q']),1+1+11);
 // A JSON prompt is mostly quotes; each one costs an escape character.
 const json=JSON.stringify({k:'v'.repeat(10)});
 assert.ok(windowsCommandLineLength('a',[json])>json.length+3);
});

test('an oversized agy prompt names the brief fields that grew and the way out',()=>{
 const big='x'.repeat(30000);
 const brief=agyBrief({lead_feedback:[`Acceptance command \`npm test\` exited with 1. Make it pass. Output tail:\n${big}`]});
 const hint=oversizeHint(brief);
 assert.match(hint,/lead_feedback \(\d{5} chars\)/);
 assert.match(hint,/REASSIGN_OTHER/);
 assert.throws(()=>assertCommandLine('agy',['-p',big+big],{windows:true,hint:()=>hint}),e=>/Command line too long for Windows \(\d+ chars, limit 32000\)/.test(e.message)&&e.message.includes('lead_feedback'));
 assert.doesNotThrow(()=>assertCommandLine('agy',['-p',big+big],{windows:false}));
 if(isWin)assert.throws(()=>agyDispatch(brief,{token:'x',owner:'antigravity'},{session:null,resume:false,probe:agyCli,promptFile,options:{}}),/lead_feedback/);
});

// ── 2. reviewer finding field names ────────────────────────────────
// Shape seen from Grok 1.0.x: prose, then the result object glued on, with `detail` where the contract says `issue`.
const GROK_REVIEW='I read src/kf3.mjs and the tests. One defect remains.'
 +JSON.stringify({task_id:'KF3',consult_id:'c2',member:'m1',summary:'AC2 fails on empty input',
  findings:[{file:'src/kf3.mjs',line:42,severity:'blocker',detail:'parseRows throws on an empty file instead of returning []',suggestion:'return [] when the file is empty'}],
  root_cause:'',plan:[],recommended_verdict:'redo',confidence:'high',blocking_criteria:['AC2']});

test('a Grok review that says detail instead of issue is accepted as issue',()=>{
 const envelope=JSON.stringify({text:GROK_REVIEW,stopReason:'end_turn',sessionId:'s1'});
 const parsed=grokParse(envelope,{cli:{session_id:'s1'}});
 const v=contract.consultResult(parsed.result,'KF3','c2','m1','review');
 assert.equal(v.findings[0].issue,'parseRows throws on an empty file instead of returning []');
 assert.equal('detail' in v.findings[0],false);
 assert.equal(contract.rejectionEvidence(v.recommended_verdict,v.findings),true);
});

test('finding validation stays strict apart from the detail alias',()=>{
 const base=extractResult(GROK_REVIEW);
 const withFinding=f=>({...base,findings:[{file:'src/kf3.mjs',line:42,severity:'blocker',suggestion:'',...f}]});
 assert.throws(()=>contract.consultResult(withFinding({}),'KF3','c2','m1','review'),/Invalid consult findings/);
 assert.throws(()=>contract.consultResult(withFinding({detail:7}),'KF3','c2','m1','review'),/Invalid consult findings/);
 assert.throws(()=>contract.consultResult(withFinding({detail:'  '}),'KF3','c2','m1','review'),/Invalid consult findings/);
 assert.throws(()=>contract.consultResult(withFinding({description:'x'}),'KF3','c2','m1','review'),/Invalid consult findings/);
 assert.throws(()=>contract.consultResult(withFinding({detail:'x',severity:'high'}),'KF3','c2','m1','review'),/Invalid consult findings/);
 const both=contract.consultResult(withFinding({issue:'kept',detail:'extra'}),'KF3','c2','m1','review');
 assert.equal(both.findings[0].issue,'kept');
 // suggestion은 빠진 경우만 채운다. 문자열이 아닌 값은 여전히 거절한다.
 for(const suggestion of [null,7,['x'],{}])
  assert.throws(()=>contract.consultResult(withFinding({issue:'x',suggestion}),'KF3','c2','m1','review'),/Invalid consult findings/,JSON.stringify(suggestion));
});

// Shape seen from Grok 4.7 on 2026-11-27 (HF-L01 c3/c4): findings with no suggestion field at all.
// Both reviews were discarded as invalid and rerun (~30 minutes); one of them was a pass.
test('a Grok review whose findings omit suggestion is accepted with an empty suggestion',()=>{
 const text='라운드 4 변경을 성공 기준과 대조해 읽기 전용으로 검토합니다.\n\n'+JSON.stringify({task_id:'KF3',consult_id:'c3',member:'m1',summary:'AC2 still leaks a multi-line secret',
  findings:[{severity:'blocker',file:'src/kf3.mjs',line:264,issue:'AC2: the line-count fallback returns the secret unmasked'},{file:'src/kf3.mjs',line:10,severity:'minor',issue:'comment is stale'}],
  root_cause:'',plan:[],recommended_verdict:'redo',confidence:'high',blocking_criteria:['AC2']});
 const parsed=grokParse(JSON.stringify({text,stopReason:'end_turn',sessionId:'s1'}),{cli:{session_id:'s1'}});
 const v=contract.consultResult(parsed.result,'KF3','c3','m1','review');
 assert.deepEqual(v.findings.map(f=>f.suggestion),['','']);
 assert.equal(v.findings[0].issue,'AC2: the line-count fallback returns the secret unmasked');
 assert.equal(contract.rejectionEvidence(v.recommended_verdict,v.findings),true);
 // A pass with a finding that omits suggestion is kept too (c4 was a pass that got discarded).
 const pass=contract.consultResult({...extractResult(text),consult_id:'c4',recommended_verdict:'pass',blocking_criteria:[],findings:[{file:'src/kf3.mjs',line:1,severity:'minor',issue:'nit'}]},'KF3','c4','m1','review');
 assert.equal(pass.recommended_verdict,'pass');
 assert.equal(pass.findings[0].suggestion,'');
});

// ── 3. reviewers see lead contract corrections ─────────────────────
const adaptive=(t,executor='grok')=>{
 const f=fixture(t,{initialize:false,executor});
 fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({review:{by:'delegate',strategy:'lead-gated-adaptive',auto_apply:true}}));
 run(f.root,'init',{...f.brief,executor});
 return f;
};
const delegate=async f=>{const c=run(f.root,'delegate-review',{});await consult(f.root,c.consult_id);return {c,out:run(f.root,'consult-finish',{quiescent:true})};};
const reviewBrief=(f,c,member='m1')=>JSON.parse(read(task(f,`consult-${c.consult_id}-${member}.json`)).prompt).brief;

test('a contract correction recorded by the lead reaches the next round\'s reviewers',async t=>{
 const f=adaptive(t);
 f.begin();f.finish();f.mode('review-redo');
 const first=await delegate(f);
 assert.equal(reviewBrief(f,first.c).consult.context.contract_corrections,undefined);
 run(f.root,'lead-decision',{decision:'REDO',rationale:'AC1 means a.txt holds "fixed" with no newline; the task doc was wrong',baseline_digest:f.state().post_digest,contract_change:true});
 f.mode('ok');f.begin();f.finish();
 const second=await delegate(f);
 const corrections=reviewBrief(f,second.c).consult.context.contract_corrections;
 assert.deepEqual(corrections,[{round:1,decision:'REDO',rationale:'AC1 means a.txt holds "fixed" with no newline; the task doc was wrong'}]);
 const sent=JSON.parse(read(task(f,`consult-${second.c.consult_id}-m1.json`)).prompt);
 assert.ok([...sent.result_rules,...sent.instructions].some(x=>/contract_corrections/.test(x)),'reviewers are told to judge against the corrected contract');
});

test('a decision the lead recorded with decide reaches the next round reviewers',async t=>{
 // L03 HF: Sol re-raised the same two settled contract points three rounds running, and each one stopped at DECISION_REQUIRED.
 const f=fixture(t,{initialize:false});writeConfig(f,{review:{by:'delegate'}});
 run(f.root,'init',{...f.brief,executor:'grok'});
 f.begin();f.finish();f.mode('review-decision');
 const first=await delegate(f);
 assert.equal(f.state().phase,'DECISION_REQUIRED');
 assert.equal(reviewBrief(f,first.c).consult.context.contract_corrections,undefined);
 const decision='HF_LEAD_GRADE stays an operator override: the protected test fixes it. Do not report it again.';
 run(f.root,'decide',{decision});
 f.mode('ok');f.begin();f.finish();
 const second=await delegate(f);
 assert.deepEqual(reviewBrief(f,second.c).consult.context.contract_corrections,[{round:1,decision,source:'lead decide'}]);
});

test('the frozen review plan still refuses a round whose snapshot drifted',async t=>{
 const f=adaptive(t);
 f.begin();f.finish();
 run(f.root,'delegate-review',{});
 const s=f.state();
 const prior=read(task(f,'review-plan-1.json'));
 fs.writeFileSync(task(f,'review-plan-1.json'),JSON.stringify({...prior,baseline_digest:'0'.repeat(64)}));
 s.open_consult=null;fs.writeFileSync(path.join(f.control,'state.json'),JSON.stringify(s));
 assert.throws(()=>run(f.root,'delegate-review',{}),/ADAPTIVE_REVIEW: frozen review plan does not match this round snapshot/);
});

// ── 4. acceptance for incomplete results ───────────────────────────
const CHECK=`node -e "const s=require('fs').readFileSync('a.txt','utf8');if(s!=='fixed'){console.error('a.txt is '+s);process.exit(3)}"`;
const incomplete=(f,status,files)=>({...f.result(files),status,unresolved:['which output format?'],needs_lead_decision:status==='needs_decision',recommended_next_action:'lead decision'});

test('a changed tree is acceptance-tested even when the worker reports needs_decision, and still cannot pass',t=>{
 const f=fixture(t);f.brief.acceptance_commands=[CHECK];
 f.begin();fs.writeFileSync(path.join(f.root,'a.txt'),'fixed');
 f.finish(incomplete(f,'needs_decision',['a.txt']));
 const s=f.state();
 assert.equal(s.phase,'REVIEW');
 assert.deepEqual([s.acceptance.round,s.acceptance.stage,s.acceptance.status,s.acceptance.quiescent],[1,'finish','pass',true]);
 assert.equal(read(task(f,s.acceptance.file)).results[0].exit_code,0);
 assert.throws(()=>f.review('pass'),/Incomplete result cannot pass/);
});

test('a failing acceptance run on a blocked result is evidence for the lead, not an automatic REDO',t=>{
 const f=fixture(t);f.brief.acceptance_commands=[CHECK];
 f.begin();fs.writeFileSync(path.join(f.root,'a.txt'),'half done');
 f.finish(incomplete(f,'blocked',['a.txt']));
 const s=f.state();
 assert.equal(s.phase,'REVIEW');
 assert.equal(s.acceptance.status,'fail');assert.equal(s.acceptance.round,1);
 assert.equal(s.reviews.length,0,'the worker\'s question is not overwritten by a controller redo');
});

// 2026-11-28 benchmark L03/L05: the worker reported failed (no lead question), acceptance failed, and autopilot stopped for the lead.
// Such a round now goes back to the same worker once, like a complete round with a failing acceptance run.
const failedReport=(f,files)=>({...f.result(files),status:'failed',unresolved:['the acceptance run was interrupted; the rest is unverified'],needs_lead_decision:false,recommended_next_action:'rerun the acceptance test'});

test('a failed report with a failing acceptance run and no lead question returns to the same worker once',t=>{
 const f=fixture(t);f.brief.acceptance_commands=[CHECK];
 f.begin();fs.writeFileSync(path.join(f.root,'a.txt'),'half done');
 f.finish(failedReport(f,['a.txt']));
 let s=f.state();
 assert.equal(s.phase,'REDO');assert.equal(s.acceptance.status,'fail');
 const order=s.reviews.at(-1);
 assert.equal(order.reviewed_by,'controller');assert.equal(order.worker_status,'failed');
 assert.match(order.rationale,/^The worker reported failed\. Acceptance commands failed/);
 assert.deepEqual(order.blocking_criteria,['Acceptance: '+CHECK]);
 // The next order carries the failing output, and the same worker gets it.
 f.begin({lead_feedback:'@review'});
 assert.equal(f.state().owner,s.owner);
 assert.match(read(path.join(f.control,'tasks',f.brief.task_id,'brief-2.json')).lead_feedback.join('\n'),/a\.txt is half done/);
 // A second failed report in a row is not returned again: it waits for the lead with the evidence.
 fs.writeFileSync(path.join(f.root,'a.txt'),'still half done');
 f.finish(failedReport(f,['a.txt']));
 s=f.state();
 assert.equal(s.phase,'REVIEW');assert.equal(s.acceptance.status,'fail');assert.equal(s.acceptance.round,2);
 assert.equal(s.reviews.length,1,'only the first failed round was returned automatically');
});

test('a failed report that asks the lead, or passes acceptance, is not returned automatically',t=>{
 const asks=fixture(t);asks.brief.acceptance_commands=[CHECK];
 asks.begin();fs.writeFileSync(path.join(asks.root,'a.txt'),'half done');
 asks.finish({...failedReport(asks,['a.txt']),needs_lead_decision:true});
 assert.equal(asks.state().phase,'REVIEW');assert.equal(asks.state().reviews.length,0);
 const passes=fixture(t);passes.brief.acceptance_commands=[CHECK];
 passes.begin();fs.writeFileSync(path.join(passes.root,'a.txt'),'fixed');
 passes.finish(failedReport(passes,['a.txt']));
 assert.equal(passes.state().phase,'REVIEW');assert.equal(passes.state().acceptance.status,'pass');assert.equal(passes.state().reviews.length,0);
});

test('an incomplete result with no change runs no acceptance',t=>{
 const f=fixture(t);f.brief.acceptance_commands=[CHECK];
 f.begin();f.finish(incomplete(f,'failed',[]));
 assert.notEqual(f.state().acceptance?.round,1);
});

test('lead-gated APPROVE stays refused for an incomplete result with passing acceptance',async t=>{
 const f=adaptive(t);
 f.begin({acceptance_commands:[CHECK]});fs.writeFileSync(path.join(f.root,'a.txt'),'fixed');
 f.finish(incomplete(f,'needs_decision',['a.txt']));
 assert.equal(f.state().acceptance.status,'pass');
 const {out}=await delegate(f);
 assert.equal(out.review.recommendation,'REDO');
 assert.throws(()=>run(f.root,'lead-decision',{decision:'APPROVE',rationale:'r',baseline_digest:f.state().post_digest,contract_change:false,diff_reviewed:true,tests_checked:['CHECK'],changed_scope:['a.txt']}),/an incomplete result cannot be approved/);
});

const greenAfterInit=f=>{const mark=path.join(f.temp,'green');return {cmd:`node -e "process.exit(require('fs').existsSync(process.argv[1])?0:1)" "${mark}"`,flip:()=>fs.writeFileSync(mark,'1')};};
const autopilotTask=t=>{
 const f=fixture(t,{initialize:false}),g=greenAfterInit(f);f.brief.acceptance_commands=[g.cmd];
 run(f.root,'init',{...f.brief,executor:'grok'});g.flip();return f;
};

test('autopilot stops for the lead on an incomplete result after real acceptance evidence',async t=>{
 const f=autopilotTask(t);f.mode('edit');
 const cli=process.env.HF_GROK_BIN;
 fs.writeFileSync(cli,fs.readFileSync(cli,'utf8').replace("if(mode==='edit'){","if(mode==='edit'){result.status='needs_decision';result.needs_lead_decision=true;result.unresolved=['which format?'];"));
 const out=await autopilot(f.root);
 assert.equal(out.reason,'AUTOPILOT_WORKER_INCOMPLETE',JSON.stringify(out));
 const s=f.state();
 assert.deepEqual([s.acceptance.round,s.acceptance.status],[1,'pass']);
 assert.equal(s.open_consult,undefined,'no reviewer was spent');
});

// 2026-11-28 L03: round 1 reported failed with a failing acceptance run and autopilot stopped. Now the controller returns it and autopilot goes on.
test('autopilot keeps going after a failed report with a failing acceptance run',async t=>{
 const f=fixture(t,{initialize:false});f.brief.acceptance_commands=[CHECK];
 run(f.root,'init',{...f.brief,executor:'grok'});f.mode('edit');
 const cli=process.env.HF_GROK_BIN;
 fs.writeFileSync(cli,fs.readFileSync(cli,'utf8').replace("if(mode==='edit'){fs.writeFileSync('a.txt','fixed');result.files_changed=['a.txt'];}",
  "if(mode==='edit'){const first=request.result_template.round===1;fs.writeFileSync('a.txt',first?'half done':'fixed');result.files_changed=['a.txt'];if(first){result.status='failed';result.needs_lead_decision=false;result.unresolved=['acceptance run interrupted'];}}"));
 const out=await autopilot(f.root);
 assert.ok(!['AUTOPILOT_WORKER_INCOMPLETE','AUTOPILOT_ACCEPTANCE_UNVERIFIED'].includes(out.reason),JSON.stringify(out));
 const s=f.state();
 assert.equal(s.reviews[0].reviewed_by,'controller');assert.equal(s.reviews[0].worker_status,'failed');assert.equal(s.reviews[0].round,1);
 assert.ok(s.iteration>=2,'round 2 ran');
 assert.deepEqual([s.acceptance.round,s.acceptance.status],[2,'pass']);
});

// 2026-11-10 L05 run 4: a worker "failed" only because the host blocked its tests; the reviewer should judge it, not the lead.
test('autopilot sends an environment-only failed result to the reviewer after real acceptance evidence',async t=>{
 const f=autopilotTask(t);f.mode('edit');
 const cli=process.env.HF_GROK_BIN;
 fs.writeFileSync(cli,fs.readFileSync(cli,'utf8').replace("if(mode==='edit'){","if(mode==='edit'){result.status='failed';result.tests=[{command:'npm test',status:'not_run',environment_error:'the sandbox refused process-table access'}];"));
 const out=await autopilot(f.root);
 assert.notEqual(out.reason,'AUTOPILOT_WORKER_INCOMPLETE',JSON.stringify(out));
 const s=f.state();
 assert.deepEqual([s.acceptance.round,s.acceptance.status],[1,'pass']);
 assert.equal(read(path.join(f.control,'tasks',f.brief.task_id,'raw-result-1.json')).reported_status,'failed');
 assert.match(s.reviews.at(-1)?.commands_run?.join(' ')??'',/delegated read-only review/,JSON.stringify(out));
});

test('autopilot reports unverified acceptance when the incomplete round really failed it',async t=>{
 const f=fixture(t,{initialize:false});f.brief.acceptance_commands=[CHECK];
 run(f.root,'init',{...f.brief,executor:'grok'});
 const cli=process.env.HF_GROK_BIN;
 fs.writeFileSync(cli,fs.readFileSync(cli,'utf8').replace("if(mode==='edit'){fs.writeFileSync('a.txt','fixed');","if(mode==='edit'){fs.writeFileSync('a.txt','half');result.status='blocked';result.unresolved=['stuck'];"));
 f.mode('edit');
 const out=await autopilot(f.root);
 assert.equal(out.reason,'AUTOPILOT_ACCEPTANCE_UNVERIFIED',JSON.stringify(out));
 assert.deepEqual([f.state().acceptance.round,f.state().acceptance.status],[1,'fail']);
});

// ── 5. smaller items ───────────────────────────────────────────────
const writeConfig=(f,v)=>fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify(v));

test('reviewers get their own turn limit',t=>{
 const f=fixture(t,{initialize:false});
 writeConfig(f,{executors:{grok:{max_turns:30,consult_max_turns:90},sonnet:{consult_max_turns:70}}});
 const c=config(f.root);
 assert.equal(consultExecutorOptions(c,'grok').max_turns,90);
 assert.equal(consultExecutorOptions(c,'sonnet').max_turns,70);
 assert.equal(consultExecutorOptions(c,'haiku').max_turns,undefined);
 assert.equal(consultExecutorOptions(c,'grok',{reasoning_effort:'high'}).reasoning_effort,'high');
 writeConfig(f,{executors:{luna:{consult_max_turns:80}}});assert.throws(()=>config(f.root),/TURN_LIMIT_UNSUPPORTED/);
 writeConfig(f,{executors:{grok:{consult_max_turns:0}}});assert.throws(()=>config(f.root),/configuration/);
 writeConfig(f,{executors:{grok:{consult_max_turns:1001}}});assert.throws(()=>config(f.root),/configuration/);
});

test('a consult launches the reviewer with the review turn limit',async t=>{
 const f=fixture(t,{initialize:false,executor:'antigravity'});
 writeConfig(f,{executors:{grok:{max_turns:30,consult_max_turns:90}}});
 run(f.root,'init',{...f.brief,executor:'antigravity'});
 f.begin();f.finish();
 const c=run(f.root,'consult',{mode:'advisor',question:'Does the change meet AC1?',executors:['grok']});
 await consult(f.root,c.consult_id);
 const args=read(path.join(f.temp,'fake-grok-args.json'));
 assert.equal(args[args.indexOf('--max-turns')+1],'90');
});

test('recover names where the writer token comes from without printing it',t=>{
 const f=fixture(t);f.begin();
 const token=f.state().writer.token;
 for(const bad of [undefined,'wrong']){
  assert.throws(()=>run(f.root,'recover',{quiescent:true,reason:'worker crashed',...(bad?{token:bad}:{})}),e=>{
   assert.match(e.message,/RECOVER_TOKEN/);
   assert.match(e.message,/begin/);
   assert.match(e.message,/locks[\\/]writer\.json/);
   assert.equal(e.message.includes(token),false);
   return true;
  });
 }
 assert.equal(f.state().phase,'EXECUTING','a refused recover changes nothing');
 assert.equal(run(f.root,'recover',{quiescent:true,reason:'worker crashed',token}).phase,'REDO');
});

test('a lead pass may omit blocking_criteria, and a bad review names the missing fields',()=>{
 const base={verdict:'pass',rationale:'Read the diff',commands_run:['git diff'],independent_diff_review:true};
 assert.deepEqual(contract.review({...base}).blocking_criteria,[]);
 assert.throws(()=>contract.review({...base,verdict:'redo'}),/Invalid review evidence: blocking_criteria/);
 assert.throws(()=>contract.review({verdict:'pass',independent_diff_review:true}),/Invalid review evidence: rationale .*commands_run/);
 assert.throws(()=>contract.review({...base,blocking_criteria:['AC1']}),/Cannot pass blocking criteria/);
});
