import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {hash} from '../scripts/artifact.mjs';
import {evidencePacket,evidenceSearch} from '../scripts/evidence-index.mjs';
import {CASES,compareRepeated} from '../scripts/benchmark.mjs';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';

const put=(dir,name,data)=>fs.writeFileSync(path.join(dir,name),typeof data==='string'?data:JSON.stringify(data));
function setup(t,state={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hf-evidence-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 return {dir,state:{task_id:'HF-test',iteration:1,phase:'VERIFY',post_digest:'digest-1',consults:[],...state}};
}
// A long passing log with one failure far from the end, as a reviewer would rarely see it.
const longLog=Array.from({length:400},(_,i)=>i===37?'not ok 38 - AC2 rejects empty token':`ok ${i+1} - case ${i+1}`).join('\n');
const passing={stage:'finish',round:1,status:'pass',quiescent:true,tree_changed:[],results:[{command:'node t.mjs',status:'pass',exit_code:0,output_bytes:16,output_tail:'ok 1 - all good\n'}]};
function review(f,{id,reviewer,verdict,findings}){
 const member='m1';
 put(f.dir,`consult-${id}.json`,{id,mode:'review',members:[{member,executor:reviewer}]});
 put(f.dir,`consult-${id}-base.json`,{digest:'digest-1'});
 put(f.dir,`consult-${id}-${member}.json`,{prompt:JSON.stringify({brief:{task_id:'HF-test',round:1}})});
 put(f.dir,`consult-${id}-finish.json`,{id,violated:false});f.state.consults.push({id,violated:false});
 put(f.dir,`consult-result-${id}-${member}.json`,{task_id:'HF-test',consult_id:id,member,recommended_verdict:verdict,findings,blocking_criteria:verdict==='pass'?[]:['AC1']});
}
const codes=packet=>packet.signals.map(s=>s.code);

test('a clean round pushes no signals but still names the raw evidence it read',t=>{
 const f=setup(t);put(f.dir,'acceptance-1-finish.json',passing);
 const packet=evidencePacket(f.state,f.dir);
 assert.equal(packet.authoritative,false);assert.deepEqual(packet.signals,[]);assert.equal(packet.signal_count,0);
 assert.deepEqual(packet.pointers,[{file:'acceptance-1-finish.json',sha256:hash(fs.readFileSync(path.join(f.dir,'acceptance-1-finish.json')))}]);
});

test('missing acceptance evidence is a signal, never an implicit pass',t=>{
 const f=setup(t);
 assert.deepEqual(codes(evidencePacket(f.state,f.dir)),['ACCEPTANCE_NOT_RECORDED']);
});

test('failed, truncated, unquiet and tree-changing acceptance runs are all surfaced with pointers',t=>{
 const f=setup(t);
 put(f.dir,'acceptance-1-finish.json',{...passing,status:'fail',quiescent:false,tree_changed:['dist/x.js'],
  results:[{command:'node t.mjs',status:'fail',exit_code:1,output_bytes:90000,output_sha256:'f'.repeat(64),output_tail:longLog.split('\n').slice(30,60).join('\n')}]});
 const packet=evidencePacket(f.state,f.dir);
 assert.deepEqual(codes(packet).sort(),['ACCEPTANCE_FAILED','ACCEPTANCE_NOT_QUIESCENT','ACCEPTANCE_TREE_CHANGED','OUTPUT_TRUNCATED']);
 const failed=packet.signals.find(s=>s.code==='ACCEPTANCE_FAILED');
 assert.equal(failed.first_failure.text,'not ok 38 - AC2 rejects empty token');assert.equal(failed.first_failure.tail_line,8);
 assert.equal(failed.source.file,'acceptance-1-finish.json');assert.match(failed.source.sha256,/^[a-f0-9]{64}$/);
 assert.equal(packet.signals.find(s=>s.code==='OUTPUT_TRUNCATED').output_bytes,90000);
});

test('worker environment failures, reported failures, open items and file mismatches are pushed',t=>{
 const f=setup(t);put(f.dir,'acceptance-1-finish.json',passing);
 put(f.dir,'raw-result-1.json',{status:'complete',files_changed:['a.txt','ghost.txt'],unresolved:['edge case'],risks:[],needs_lead_decision:false,
  tests:[{command:'npm test',status:'fail',environment_error:'spawn EPERM'},{command:'node x.mjs',status:'fail'},{command:'node y.mjs',status:'pass'}]});
 put(f.dir,'validation-1.json',{changed:['a.txt','b.txt']});
 const packet=evidencePacket(f.state,f.dir);
 assert.deepEqual(codes(packet),['ENVIRONMENT_FAILURE','WORKER_REPORTED_TEST_FAILURE','WORKER_OPEN_ITEMS','CHANGED_FILES_MISMATCH']);
 const mismatch=packet.signals.at(-1);
 assert.deepEqual(mismatch.undeclared,['b.txt']);assert.deepEqual(mismatch.claimed_not_changed,['ghost.txt']);
});

test('a blocking finding from only one of two reviewers and a verdict split are pushed',t=>{
 const f=setup(t,{review_results:{1:[{executor:'sol',verdict:'redo',ok:true},{executor:'sonnet',verdict:'pass',ok:true}]}});
 put(f.dir,'acceptance-1-finish.json',passing);
 review(f,{id:'c1',reviewer:'sol',verdict:'redo',findings:[{file:'a.txt',line:2,severity:'major',issue:'AC1: empty input crashes'}]});
 review(f,{id:'c2',reviewer:'sonnet',verdict:'pass',findings:[{file:'a.txt',line:9,severity:'minor',issue:'AC1: naming'}]});
 const packet=evidencePacket(f.state,f.dir);
 assert.deepEqual(codes(packet),['REVIEW_VERDICT_DISAGREEMENT','SINGLE_REVIEWER_BLOCKING']);
 const single=packet.signals[1];
 assert.equal(single.reviewer,'sol');assert.deepEqual(single.ac_ids,['AC1']);assert.equal(single.source.file,'consult-result-c1-m1.json');
});

test('acceptance test changes, controller errors and unreadable artifacts are not hidden',t=>{
 const f=setup(t,{acceptance_test_changes:['test/a.test.mjs'],last_errors:['ACCEPTANCE_NOT_QUIESCENT: pid 4']});
 put(f.dir,'acceptance-1-finish.json','{not json');
 const packet=evidencePacket(f.state,f.dir);
 assert.deepEqual(codes(packet).sort(),['ACCEPTANCE_NOT_RECORDED','ACCEPTANCE_TEST_CHANGED','ARTIFACT_UNREADABLE','CONTROLLER_ERRORS']);
});

test('signals beyond the per-code cap become explicit omitted counts with sources',t=>{
 const f=setup(t);put(f.dir,'acceptance-1-finish.json',passing);
 put(f.dir,'raw-result-1.json',{status:'complete',tests:Array.from({length:25},(_,i)=>({command:`t${i}`,status:'fail',environment_error:'EPERM'}))});
 const packet=evidencePacket(f.state,f.dir);
 assert.equal(packet.signal_count,25);assert.equal(packet.signals.length,20);
 assert.equal(packet.omitted.ENVIRONMENT_FAILURE.count,5);assert.equal(packet.omitted.ENVIRONMENT_FAILURE.sources[0].file,'raw-result-1.json');
});

test('search ranks the buried failure first and points at its exact lines and hash',t=>{
 const f=setup(t);
 put(f.dir,'acceptance-1-finish.json',{...passing,status:'fail',results:[{command:'node t.mjs',status:'fail',output_bytes:longLog.length,output_tail:longLog}]});
 put(f.dir,'raw-result-1.json',{summary:'Implemented token parsing',tests:[]});
 const out=evidenceSearch(f.state,f.dir,'empty token rejects');
 assert.equal(out.authoritative,false);
 const top=out.hits[0];
 assert.equal(top.file,'acceptance-1-finish.json');assert.equal(top.pointer,'/results/0/output_tail');
 assert.deepEqual(top.lines,[33,40]);assert.match(top.text,/not ok 38 - AC2 rejects empty token/);
 assert.equal(top.sha256,hash(fs.readFileSync(path.join(f.dir,'acceptance-1-finish.json'))));
});

test('search omits whole hits beyond the byte budget, keeping pointers, and redacts secrets',t=>{
 const f=setup(t);
 put(f.dir,'raw-result-1.json',{summary:'token failure',risks:Array.from({length:6},(_,i)=>`token failure ${i} ${'x'.repeat(300)}`),notes:'token failure api_key=sk-ant-api03-abcdefghijklmnopqrstuvwx'});
 const out=evidenceSearch(f.state,f.dir,'token failure',{limit:8,byteBudget:900});
 assert.ok(out.hits.length>=1);assert.ok(out.omitted.length>=1);assert.ok(out.used_bytes<=900);
 assert.ok(out.omitted.every(o=>o.file==='raw-result-1.json'&&o.sha256&&o.pointer));
 const all=evidenceSearch(f.state,f.dir,'token failure',{limit:50,byteBudget:200000});
 assert.ok(all.hits.some(h=>h.pointer==='/notes'));
 assert.ok(all.hits.every(h=>!h.text.includes('sk-ant-api03')));
});

test('search excludes dispatch prompts and state, filters by round and rejects bad input',t=>{
 const f=setup(t);
 put(f.dir,'dispatch-1.json',{prompt:'needle'});put(f.dir,'raw-result-1.json',{summary:'needle one'});put(f.dir,'raw-result-2.json',{summary:'needle two'});
 assert.deepEqual(evidenceSearch(f.state,f.dir,'needle').hits.map(h=>h.file),['raw-result-1.json','raw-result-2.json']);
 assert.deepEqual(evidenceSearch(f.state,f.dir,'needle',{round:2}).hits.map(h=>h.file),['raw-result-2.json']);
 assert.throws(()=>evidenceSearch(f.state,f.dir,'  '),/EVIDENCE_QUERY_EMPTY/);
 assert.throws(()=>evidenceSearch(f.state,f.dir,'abc def',{limit:0}),/EVIDENCE_LIMIT_INVALID/);
 assert.throws(()=>evidenceSearch(f.state,f.dir,'abc def',{byteBudget:10}),/EVIDENCE_BUDGET_INVALID/);
});

test('search skips symlinked artifacts instead of following them',t=>{
 const f=setup(t);const outside=path.join(f.dir,'..',`hf-evidence-outside-${process.pid}.json`);
 fs.writeFileSync(outside,JSON.stringify({summary:'needle outside'}));t.after(()=>fs.rmSync(outside,{force:true}));
 try{fs.symlinkSync(outside,path.join(f.dir,'raw-result-1.json'));}catch{t.skip('symlinks unavailable on this host');return;}
 const out=evidenceSearch(f.state,f.dir,'needle');
 assert.deepEqual(out.hits,[]);assert.deepEqual(out.skipped,[{file:'raw-result-1.json',reason:'not_regular_file'}]);
});

test('CLI evidence actions are read-only and do not change task state',t=>{
 const f=fixture(t);
 const before=fs.readFileSync(path.join(f.control,'state.json'),'utf8');
 const listing=()=>fs.readdirSync(path.join(f.control,'tasks',f.brief.task_id)).sort();
 const files=listing();
 const packet=run(f.root,'evidence');
 assert.equal(packet.task_id,'HF-test');assert.ok(Array.isArray(packet.signals));
 const search=run(f.root,'evidence-search',{query:'objective bounded'});
 assert.equal(search.task_id,'HF-test');
 assert.equal(fs.readFileSync(path.join(f.control,'state.json'),'utf8'),before);
 assert.deepEqual(listing(),files);
 assert.equal(fs.existsSync(path.join(f.control,'locks/control.lock')),false);
});

test('repeated comparison reports planted-defect detection and keeps unknowns separate',()=>{
 const rows=arm=>CASES.map(c=>({case_id:c.case_id,success:true,comparison:{arm,repetition:1,order:arm==='current'?1:2}}));
 const a=rows('current'),b=rows('candidate');
 a[0].buried_defect_detected=true;a[1].buried_defect_detected=false;b[0].buried_defect_detected=true;b[1].buried_defect_detected=true;b[2].buried_defect_detected='yes';
 const result=compareRepeated(a,b,null,{repetitions:1});
 assert.deepEqual(result.current.defect_detection,{planted:2,detected:1,missed:1,unknown:CASES.length-2});
 assert.deepEqual(result.candidate.defect_detection,{planted:2,detected:2,missed:0,unknown:CASES.length-2});
 assert.equal(compareRepeated(rows('current'),rows('candidate'),null,{repetitions:1}).current.defect_detection,null);
});
