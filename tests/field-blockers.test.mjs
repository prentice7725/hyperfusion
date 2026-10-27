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
