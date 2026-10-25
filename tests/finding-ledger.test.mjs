import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {hash} from '../scripts/artifact.mjs';
import {findingLedger,findingSummary,captureFindings,recordFindingMap,revisionPacket,findingCriteria,safeFindingSummary} from '../scripts/finding-ledger.mjs';
import {compactView} from '../scripts/lead-view.mjs';
import {consultResult} from '../scripts/contracts.mjs';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {consult} from '../scripts/executor-bridge.mjs';

const finding={file:'src/a.txt',line:3,severity:'major',issue:'AC1: handle empty input',suggestion:'Add an empty-input guard'};
const body='one\ntwo\nthree\nfour\nfive\nsix\nseven';
const put=(dir,name,data)=>fs.writeFileSync(path.join(dir,name),JSON.stringify(data));
function setup(t,text=body){
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'hf-findings-')),root=path.join(temp,'root'),dir=path.join(temp,'control');
 fs.mkdirSync(path.join(root,'src'),{recursive:true});fs.mkdirSync(dir);
 t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 fs.writeFileSync(path.join(root,'src/a.txt'),text);
 const state={task_id:'HF-test',iteration:1,post_digest:'digest-1',reviews:[],consults:[]};
 const post={digest:state.post_digest,files:{'src/a.txt':{kind:'file',sha256:hash(text)}}};
 const brief={scope:{paths:['src']},success_criteria:['AC1: input is safe']};
 put(dir,'post-1.json',post);put(dir,'initial-brief.json',brief);put(dir,'brief-1.json',brief);
 return {temp,root,dir,state,post,brief};
}
function review(f,{id='c1',reviewer='sol',verdict='redo',findings=[finding],round=1,digest='digest-1',capture=true}={}){
 const member='m1',file=`consult-result-${id}-${member}.json`;
 put(f.dir,`consult-${id}.json`,{id,mode:'review',members:[{member,executor:reviewer}]});
 put(f.dir,`consult-${id}-base.json`,{digest});
 put(f.dir,`consult-${id}-${member}.json`,{prompt:JSON.stringify({brief:{task_id:f.state.task_id,round}})});
 put(f.dir,`consult-${id}-finish.json`,{id,violated:false});f.state.consults.push({id,violated:false});
 put(f.dir,file,{task_id:f.state.task_id,consult_id:id,member,recommended_verdict:verdict,findings,blocking_criteria:verdict==='pass'?[]:['AC1']});
 if(capture)captureFindings(f.root,f.state,f.dir,{file,round,digest,reviewer,verdict,blocking:['AC1'],findings},f.post);
 return file;
}

test('exact duplicate defects display once with both raw reviewer records and original provenance',t=>{
 const f=setup(t);const a=review(f),b=review(f,{id:'c2',reviewer:'sonnet'});
 const ledger=findingLedger(f.state,f.dir);
 assert.equal(ledger.authoritative,false);assert.equal(ledger.issues.length,1);assert.equal(ledger.observation_count,2);
 assert.deepEqual(ledger.issues[0].observations.map(r=>r.source_file),[a,b]);
 assert.ok(ledger.issues[0].observations.every(r=>r.source_sha256&&r.file_sha256&&r.context?.hash));
 assert.deepEqual(ledger.issues[0].ac_ids,['AC1']);assert.equal(ledger.issues[0].disposition,'unresolved');
});

test('distinct evidence, locations and ACs stay distinct, even when their wording matches',t=>{
 const f=setup(t);review(f,{findings:[finding,{...finding,line:4},{...finding,evidence:'different failing case'},{...finding,ac_ids:['AC2'],issue:'AC2: handle empty input'}]});
 assert.equal(findingLedger(f.state,f.dir).issues.length,4);
});

test('different phrasings and unlocated findings are not merged by guesswork',t=>{
 const f=setup(t);review(f,{findings:[{...finding,line:0},{...finding,line:0},finding,{...finding,issue:'AC1: validate missing input'}]});
 assert.equal(findingLedger(f.state,f.dir).issues.length,4);
});

test('PASS/rejection and severity disagreements remain visible inside a grouped issue',t=>{
 const f=setup(t);review(f);review(f,{id:'c2',reviewer:'sonnet',verdict:'pass',findings:[{...finding,severity:'minor'}]});
 const issue=findingLedger(f.state,f.dir).issues[0];assert.equal(issue.disagreement,true);
 assert.deepEqual(issue.observations.map(r=>r.verdict),['redo','pass']);assert.equal(issue.disposition,'unresolved');
});

test('line shifts use a unique saved context in controller-produced maps without resolving the defect',t=>{
 const f=setup(t);review(f);const original=findingLedger(f.state,f.dir).issues[0].id;
 const text='header A\nheader B\n'+body;fs.writeFileSync(path.join(f.root,'src/a.txt'),text);
 f.state.iteration=2;f.state.post_digest='digest-2';f.state.reviews=[{verdict:'redo',blocking_criteria:['AC1: input unsafe']}];
 const post={digest:'digest-2',files:{'src/a.txt':{kind:'file',sha256:hash(text)}}};
 put(f.dir,'post-2.json',post);put(f.dir,'brief-2.json',f.brief);recordFindingMap(f.root,f.state,f.dir,post);
 const issue=findingLedger(f.state,f.dir).issues[0];assert.equal(issue.id,original);
 assert.deepEqual(issue.observations[0].current_location,{status:'mapped',line:5,context_hash:issue.observations[0].context.hash});
 assert.equal(issue.disposition,'unresolved');assert.equal(issue.requires_current_review,true);
 const packet=revisionPacket(f.state,f.dir);assert.equal(packet.feedback[0].line,5);assert.deepEqual(packet.scope,f.brief.scope);
 assert.ok(packet.feedback.some(v=>typeof v==='string'&&v.includes('Unmet: AC1')));
});

test('ambiguous moved context stays unlocated and is never treated as a fix',t=>{
 const f=setup(t);review(f);
 const text=body+'\nseparator\n'+body;fs.writeFileSync(path.join(f.root,'src/a.txt'),text);
 f.state.iteration=2;f.state.post_digest='digest-2';put(f.dir,'brief-2.json',f.brief);
 const post={digest:'digest-2',files:{'src/a.txt':{kind:'file',sha256:hash(text)}}};put(f.dir,'post-2.json',post);recordFindingMap(f.root,f.state,f.dir,post);
 const row=findingLedger(f.state,f.dir).issues[0].observations[0];assert.equal(row.current_location.status,'ambiguous');
 assert.equal(row.current_location.line,null);assert.match(revisionPacket(f.state,f.dir).feedback[0],/re-locate/);
});

test('same source file on a new digest never carries a reviewer PASS or closes an old finding',t=>{
 const f=setup(t);review(f);f.state.iteration=2;f.state.post_digest='digest-2';
 put(f.dir,'post-2.json',{...f.post,digest:'digest-2'});review(f,{id:'c2',verdict:'pass',findings:[],round:2,digest:'digest-2'});
 assert.equal(findingLedger(f.state,f.dir).issues[0].disposition,'unresolved');
 assert.equal(findingLedger(f.state,f.dir).issues[0].requires_current_review,true);
});

test('context capture normalizes Windows paths and does not read secret or out-of-scope files',t=>{
 const f=setup(t);review(f,{findings:[{...finding,file:'src\\a.txt'}]});
 assert.equal(findingLedger(f.state,f.dir).issues[0].file,'src/a.txt');
 fs.writeFileSync(path.join(f.root,'src/.env'),'TOKEN=never-read');
 f.post.files['src/.env']={kind:'file',sha256:hash('TOKEN=never-read')};put(f.dir,'post-1.json',f.post);
 const original=fs.readFileSync;let secretReads=0;
 try{
  fs.readFileSync=function(file,...args){if(String(file).endsWith('.env')){secretReads++;throw Error('Forbidden secret read');}return original.call(this,file,...args);};
  review(f,{id:'c2',findings:[{...finding,file:'src/.env',line:1},{...finding,file:'../outside.txt'}]});
 }finally{fs.readFileSync=original;}
 assert.equal(secretReads,0);
 const secret=findingLedger(f.state,f.dir).issues.find(g=>g.file==='src/.env');assert.equal(secret.observations[0].context,null);
});

test('corrupt context/resolution caches cannot hide or rewrite raw rejection evidence',t=>{
 const f=setup(t);const source=review(f);
 const name=fs.readdirSync(f.dir).find(n=>n.startsWith('finding-observation-'));
 fs.writeFileSync(path.join(f.dir,name),'broken JSON');
 let ledger=findingLedger(f.state,f.dir);assert.equal(ledger.issues[0].issue,finding.issue);
 put(f.dir,`finding-resolution-${ledger.issues[0].id}-fake.json`,{revision:1,finding_id:ledger.issues[0].id,digest:f.state.post_digest,source_ids:{length:1}});
 ledger=findingLedger(f.state,f.dir);assert.equal(ledger.issues[0].disposition,'unresolved');
 assert.ok(ledger.warnings.some(r=>r.code==='RESOLUTION_STALE_OR_INVALID'));
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,source))).recommended_verdict,'redo');
});

test('ledger inventories the directory once and preserves sorted resolution records without caching evidence',t=>{
 const f=setup(t);review(f,{findings:Array.from({length:40},(_,i)=>({...finding,issue:`AC1: defect ${i}`}))});
 const baseline=findingLedger(f.state,f.dir),ids=baseline.issues.map(g=>g.id);
 for(const id of ids){
  put(f.dir,`finding-resolution-${id}-z.json`,{});
  fs.writeFileSync(path.join(f.dir,`finding-resolution-${id}-a.json`),'broken JSON');
 }
 put(f.dir,'finding-resolution-F-000000000000000000000000-unused.json',{});
 const original=fs.readdirSync;let inventories=0,ledger;
 try{
  fs.readdirSync=function(dir,...args){if(path.resolve(dir)===path.resolve(f.dir))inventories++;return original.call(this,dir,...args);};
  ledger=findingLedger(f.state,f.dir);
 }finally{fs.readdirSync=original;}
 assert.equal(inventories,1);assert.equal(ledger.issues.length,40);assert.equal(ledger.observation_count,40);
 for(const g of ledger.issues){
  assert.deepEqual(g.resolution_records,[`finding-resolution-${g.id}-a.json`,`finding-resolution-${g.id}-z.json`]);
  assert.equal(g.disposition,'unresolved');
 }
 assert.equal(ledger.warnings.filter(w=>w.code==='RESOLUTION_STALE_OR_INVALID').length,80);
 const added=`finding-resolution-${ids[0]}-b.json`;put(f.dir,added,{});
 assert.deepEqual(findingLedger(f.state,f.dir).issues[0].resolution_records,[`finding-resolution-${ids[0]}-a.json`,added,`finding-resolution-${ids[0]}-z.json`]);
 assert.deepEqual(ledger.issues.map(g=>g.observations),baseline.issues.map(g=>g.observations));
});

test('indexed annotations still validate fresh hashes, round and every source before showing fixed',t=>{
 const f=setup(t);review(f);const issue=findingLedger(f.state,f.dir).issues[0];
 f.state.iteration=2;f.state.post_digest='digest-2';
 const acceptance='acceptance-2-finish.json',reviewFile='review-2.json';
 const record={tree_digest:'digest-2',round:2,status:'pass',quiescent:true,results:[{status:'pass',quiescence:{quiescent:true}}]};
 put(f.dir,acceptance,record);put(f.dir,reviewFile,{verdict:'pass',reviewed_digest:'digest-2',round:2,findings:[]});
 const annotation={revision:1,finding_id:issue.id,digest:'digest-2',round:2,reason:'current evidence',source_ids:issue.observations.map(o=>o.source_id),acceptance_file:acceptance,acceptance_sha256:hash(fs.readFileSync(path.join(f.dir,acceptance))),review_file:reviewFile,review_sha256:hash(fs.readFileSync(path.join(f.dir,reviewFile)))};
 for(const suffix of ['z','a'])put(f.dir,`finding-resolution-${issue.id}-${suffix}.json`,annotation);
 let current=findingLedger(f.state,f.dir).issues[0];
 assert.equal(current.disposition,'fixed');assert.equal(current.resolution.file,`finding-resolution-${issue.id}-z.json`);
 put(f.dir,acceptance,{...record,status:'fail'});
 current=findingLedger(f.state,f.dir).issues[0];assert.equal(current.disposition,'unresolved');
 put(f.dir,acceptance,record);f.state.iteration=3;
 assert.equal(findingLedger(f.state,f.dir).issues[0].disposition,'unresolved');
});

test('summaries are bounded and keep explicit pointers to omitted sources and blockers',t=>{
 const f=setup(t);review(f,{findings:Array.from({length:25},(_,i)=>({...finding,issue:'AC1: issue '+i}))});
 const view=findingSummary(findingLedger(f.state,f.dir));assert.equal(view.displayed.length,12);assert.equal(view.omitted,13);
 f.state.reviews=[{blocking_criteria:Array.from({length:20},(_,i)=>'AC1: blocker '+i)}];
 const packet=revisionPacket(f.state,f.dir);assert.equal(packet.omitted_blockers,8);assert.equal(packet.finding_summary.omitted,9);
 assert.ok(packet.feedback.length<=37);assert.equal(packet.finding_summary.authoritative,false);
});

test('compact CLI results omit duplicate transcripts while retaining review counts and finding summary',()=>{
 const out={results:[{member:'m1',executor:'sol',recommended_verdict:'redo',findings:[finding]}],finding_summary:{total:1}};
 const view=compactView('consult-finish',out);assert.equal(view.results[0].findings,1);assert.equal(out.results[0].findings[0],finding);
 assert.deepEqual(view.finding_summary,{total:1});assert.match(view.omitted,/results/);
});

test('AC extraction is conservative and optional finding fields retain the old result contract',()=>{
 assert.deepEqual(findingCriteria({issue:'unsafe'},['AC1','AC2']),[]);
 assert.deepEqual(findingCriteria({issue:'unsafe'},['AC1: unsafe']),['AC1']);
 const raw={task_id:'T',consult_id:'c1',member:'m1',summary:'review',root_cause:'',plan:[],recommended_verdict:'redo',blocking_criteria:['AC1'],confidence:'high',findings:[{...finding,ac_ids:['AC1'],evidence:'empty argument'}]};
 assert.equal(consultResult(raw,'T','c1','m1','review'),raw);
 assert.throws(()=>consultResult({...raw,findings:[{...finding,ac_ids:['unknown']}]},'T','c1','m1','review'),/Invalid optional/);
});

test('ledger observation errors stay non-authoritative and do not manufacture an empty PASS',()=>{
 const summary=safeFindingSummary({task_id:'x'},path.join(os.tmpdir(),'missing-hf-findings-dir'));
 assert.equal(summary.total,null);assert.equal(summary.authoritative,false);assert.equal(summary.warnings[0].code,'FINDING_LEDGER_UNAVAILABLE');
});

test('explicit finding resolution needs new controller tests and review, without changing task authority',t=>{
 const f=fixture(t,{initialize:false});
 const check=`node -e "if(require('fs').readFileSync('a.txt','utf8')==='base')process.exit(1)"`;
 f.brief.acceptance_commands=[check];f.brief.acceptance_map={AC1:[check]};run(f.root,'init',{...f.brief,executor:'grok'});
 f.begin();fs.writeFileSync(path.join(f.root,'a.txt'),'candidate');f.finish(f.result(['a.txt']));f.git('diff','--','a.txt');
 run(f.root,'review',{verdict:'redo',rationale:'AC1 still incomplete',blocking_criteria:['AC1: finish implementation'],commands_run:['git diff'],independent_diff_review:true,findings:[{file:'a.txt',line:1,severity:'major',issue:'AC1: implement the final result',suggestion:'write fixed'}]});
 const dir=path.join(f.control,'tasks',f.brief.task_id),id=run(f.root,'findings',{full:true}).issues[0].id;
 assert.throws(()=>run(f.root,'resolve-finding',{finding_id:id,reason:'claimed fixed'}),/settled round/);
 const source=fs.readFileSync(path.join(dir,'review-1.json'),'utf8');
 f.begin({lead_feedback:'@findings'});
 const packet=JSON.parse(fs.readFileSync(path.join(dir,'revision-packet-2.json')));
 assert.ok(packet.feedback.some(v=>typeof v==='object'&&v.comment.includes(id)));assert.deepEqual(packet.scope.paths,['a.txt']);
 fs.writeFileSync(path.join(f.root,'a.txt'),'fixed');f.finish(f.result(['a.txt']));
 assert.equal(run(f.root,'findings',{full:true}).issues[0].disposition,'unresolved');
 assert.throws(()=>run(f.root,'resolve-finding',{finding_id:id,reason:'tests alone'}),/settled round/);
 f.git('diff','--','a.txt');assert.equal(fs.readFileSync(path.join(f.root,'a.txt'),'utf8'),'fixed');f.review('pass');
 const before=fs.readFileSync(path.join(f.control,'state.json'),'utf8');
 const input={finding_id:id,reason:'New controller AC1 command passed; current digest independently reviewed'};
 const out=run(f.root,'resolve-finding',input);assert.equal(out.authoritative,false);
 assert.deepEqual(run(f.root,'resolve-finding',input),out);
 assert.equal(fs.readFileSync(path.join(f.control,'state.json'),'utf8'),before);assert.equal(fs.readFileSync(path.join(dir,'review-1.json'),'utf8'),source);
 assert.equal(run(f.root,'findings',{full:true}).issues[0].disposition,'fixed');
 assert.equal(findingLedger({...f.state(),iteration:3},dir).issues[0].disposition,'unresolved','fixed status cannot carry to another round');
});

test('paired duplicate findings stay one display issue but cannot authorize an important-task approval',async t=>{
 const f=fixture(t,{initialize:false});
 fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({review:{by:'delegate',strategy:'lead-gated-adaptive'}}));
 run(f.root,'init',{...f.brief,executor:'grok',task_criticality:'important',assignment_reason:'mandatory pair'});
 f.begin();f.finish();f.mode('review-redo');
 const descriptor=run(f.root,'delegate-review',{});await consult(f.root,descriptor.consult_id);
 const out=run(f.root,'consult-finish',{quiescent:true});assert.equal(out.phase,'LEAD_DECISION_REQUIRED');
 assert.equal(out.finding_summary.total,1);assert.equal(out.finding_summary.displayed[0].sources.length,2);
 assert.equal(f.state().review_results[1].length,2);assert.ok(f.state().review_results[1].every(r=>r.verdict==='redo'));
 const before=f.state().phase;
 assert.throws(()=>run(f.root,'lead-decision',{decision:'APPROVE',rationale:'summary says one issue',baseline_digest:f.state().post_digest,contract_change:false,diff_reviewed:true,tests_checked:['review'],changed_scope:['a.txt']}));
 assert.equal(f.state().phase,before);assert.equal(run(f.root,'findings').unresolved,1);
});
