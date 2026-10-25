import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
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
function review(f,{id,reviewer,verdict,findings,mode='review',round=1}){
 const member='m1';
 put(f.dir,`consult-${id}.json`,{id,mode,members:[{member,executor:reviewer}]});
 put(f.dir,`consult-${id}-base.json`,{digest:'digest-1'});
 put(f.dir,`consult-${id}-${member}.json`,{prompt:JSON.stringify({brief:{task_id:'HF-test',round}})});
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

test('a failure excerpt from before the tail is pushed with the failed command, masked',t=>{
 const f=setup(t);
 put(f.dir,'acceptance-1-finish.json',{...passing,status:'fail',results:[{command:'node t.mjs',status:'fail',exit_code:1,output_bytes:90000,
  output_tail:'ok 99 - fine',output_failure_line:12,output_failure_excerpt:'not ok 3 - token api_key=plain-head-secret\n  at a.js:1'}]});
 const failed=evidencePacket(f.state,f.dir).signals.find(s=>s.code==='ACCEPTANCE_FAILED');
 assert.equal(failed.first_failure,null);assert.equal(failed.head_failure.output_line,12);
 assert.match(failed.head_failure.text,/^not ok 3 - token/);assert.doesNotMatch(JSON.stringify(failed),/plain-head-secret/);
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
 const out=evidenceSearch(f.state,f.dir,'token failure',{limit:8,byteBudget:2000});
 assert.ok(out.hits.length>=1);assert.ok(out.omitted.length>=1);assert.ok(out.used_bytes<=2000);
 assert.ok(out.omitted.every(o=>o.file==='raw-result-1.json'&&o.sha256&&o.pointer));
 const all=evidenceSearch(f.state,f.dir,'token failure',{limit:50,byteBudget:200000});
 assert.ok(all.hits.some(h=>h.pointer==='/notes'));
 assert.ok(all.hits.every(h=>!h.text.includes('sk-ant-api03')));
});

test('field-aware search masks secret fields of every JSON type while retaining raw hashes and pointers',t=>{
 const f=setup(t);
 const value={password:'plain-unmarked-password',nested:{DB_PASSWORD:'plain-db-password',api_key:'plain-api-key',access_token:'plain-access-token',private_key:{body:'plain-key-body'}},secret:123456789,token:['plain-token'],summary:'ordinary searchable evidence'};
 put(f.dir,'raw-result-1.json',value);
 const before=fs.readFileSync(path.join(f.dir,'raw-result-1.json'));
 const out=evidenceSearch(f.state,f.dir,'password api_key access_token private_key secret token',{limit:50});
 assert.ok(out.hits.length>=7);
 for(const secret of ['plain-unmarked-password','plain-db-password','plain-api-key','plain-access-token','plain-key-body','123456789','plain-token'])assert.ok(!JSON.stringify(out).includes(secret),secret);
 assert.ok(out.hits.some(h=>h.pointer==='/nested/private_key'&&h.text==='[REDACTED:secret]'));
 assert.ok(out.hits.every(h=>h.sha256===hash(before)));
 assert.deepEqual(fs.readFileSync(path.join(f.dir,'raw-result-1.json')),before);
});

test('unsafe JSON field names cannot leak through raw JSON pointers',t=>{
 const f=setup(t);
 put(f.dir,'raw-result-1.json',{'password=unmarked-field-name-secret':'needle'});
 put(f.dir,'raw-result-2.json',{'alice@example.com':'needle'});
 put(f.dir,'raw-result-3.json',{summary:'needle safe'});
 const out=evidenceSearch(f.state,f.dir,'needle');
 assert.deepEqual(out.hits.map(h=>h.file),['raw-result-3.json']);
 assert.ok(out.skipped.every(s=>s.reason==='redaction_unsafe'));
 assert.ok(!JSON.stringify(out).includes('unmarked-field-name-secret'));
 assert.ok(!JSON.stringify(out).includes('alice@example.com'));
});

test('all packet display fields redact secrets and controller error truncation names count and state source',t=>{
 const errors=Array.from({length:8},(_,i)=>`error ${i} password="controller secret ${i}"`);
 const f=setup(t,{last_errors:errors});
 put(f.dir,'acceptance-1-finish.json',{...passing,results:[{command:'test password="command secret"',status:'fail',output_tail:'failed api_key=plain-tail-secret',output_bytes:999}]});
 put(f.dir,'raw-result-1.json',{tests:[{command:'test token=plain-command-token',status:'fail',environment_error:'EIO password="environment secret"'}]});
 const rawHash=hash(fs.readFileSync(path.join(f.dir,'acceptance-1-finish.json')));
 const packet=evidencePacket(f.state,f.dir),text=JSON.stringify(packet);
 for(const secret of ['command secret','plain-tail-secret','plain-command-token','environment secret',...errors.map((_,i)=>`controller secret ${i}`)])assert.ok(!text.includes(secret),secret);
 const error=packet.signals.find(s=>s.code==='CONTROLLER_ERRORS');
 assert.equal(error.errors.length,5);assert.equal(error.count,8);assert.equal(error.omitted,3);assert.equal(error.state_pointer,'/last_errors');
 assert.equal(packet.signals.find(s=>s.code==='ACCEPTANCE_FAILED').source.sha256,rawHash);
});

test('consult round filtering validates request provenance instead of using the consult number',t=>{
 const f=setup(t);
 review(f,{id:'c7',reviewer:'sol',verdict:'redo',findings:[{issue:'needle reviewer defect'}]});
 const name='consult-result-c7-m1.json',bytes=fs.readFileSync(path.join(f.dir,name));
 const out=evidenceSearch(f.state,f.dir,'needle',{round:1});
 assert.equal(out.hits[0].file,name);assert.equal(out.hits[0].round,1);assert.equal(out.hits[0].sha256,hash(bytes));
 assert.deepEqual(evidenceSearch(f.state,f.dir,'needle',{round:7}).hits,[]);
 put(f.dir,'consult-c7-m1.json',{prompt:JSON.stringify({brief:{task_id:'other-task',round:1}})});
 const invalid=evidenceSearch(f.state,f.dir,'needle',{round:1});
 assert.deepEqual(invalid.hits,[]);assert.deepEqual(invalid.skipped,[{file:name,reason:'consult_provenance'}]);
 put(f.dir,'consult-c7-m1.json',{prompt:JSON.stringify({brief:{task_id:'HF-test',round:1}})});
 put(f.dir,name,{task_id:'HF-test',consult_id:'c8',member:'m1',findings:[{issue:'needle forged'}]});
 assert.equal(evidenceSearch(f.state,f.dir,'needle').skipped[0].reason,'consult_provenance');
});

test('advisor and committee consult results remain searchable with validated rounds',t=>{
 const f=setup(t);
 review(f,{id:'c8',reviewer:'sol',mode:'advisor',round:2,verdict:'redo',findings:[{issue:'needle advisor evidence'}]});
 review(f,{id:'c9',reviewer:'sonnet',mode:'committee',round:3,verdict:'redo',findings:[{issue:'needle committee evidence'}]});
 const all=evidenceSearch(f.state,f.dir,'needle');
 assert.deepEqual(all.hits.map(h=>[h.file,h.round]),[['consult-result-c8-m1.json',2],['consult-result-c9-m1.json',3]]);
 assert.deepEqual(evidenceSearch(f.state,f.dir,'needle',{round:2}).hits.map(h=>h.file),['consult-result-c8-m1.json']);
 assert.deepEqual(evidenceSearch(f.state,f.dir,'needle',{round:3}).hits.map(h=>h.file),['consult-result-c9-m1.json']);
 put(f.dir,'consult-c8.json',{id:'c8',mode:'unknown',members:[{member:'m1',executor:'sol'}]});
 assert.equal(evidenceSearch(f.state,f.dir,'needle').skipped[0].reason,'consult_provenance');
});

test('multiline redaction preserves raw line ranges across chunks and packet failure locations',t=>{
 const f=setup(t);
 const lines=['begin','-----BEGIN PRIVATE KEY-----',...Array.from({length:10},(_,i)=>`secret-body-${i}`),'-----END PRIVATE KEY-----','password="quoted','secret second line"','ok','needle failed at original line 17','end'];
 const log=lines.join('\r\n');
 put(f.dir,'acceptance-1-finish.json',{...passing,results:[{command:'test',status:'fail',output_tail:log}]});
 const out=evidenceSearch(f.state,f.dir,'needle');
 assert.deepEqual(out.hits[0].lines,[17,18]);assert.match(out.hits[0].text,/needle failed at original line 17/);
 const display=JSON.stringify(evidenceSearch(f.state,f.dir,'redacted needle',{limit:50}));
 assert.ok(!display.includes('secret-body-'));assert.ok(!display.includes('secret second line'));
 const failure=evidencePacket(f.state,f.dir).signals.find(s=>s.code==='ACCEPTANCE_FAILED').first_failure;
 assert.equal(failure.tail_line,17);assert.equal(failure.text,lines[16]);
});

test('deep or chunk-heavy JSON is skipped atomically and later files remain searchable',t=>{
 const f=setup(t);
 put(f.dir,'raw-result-1.json','{"a":'.repeat(6000)+'"needle nested"'+'}'.repeat(6000));
 put(f.dir,'raw-result-2.json',{summary:Array.from({length:5001},()=> 'needle too many')});
 put(f.dir,'raw-result-3.json',{summary:'needle safe'});
 const before=fs.readdirSync(f.dir).map(file=>[file,hash(fs.readFileSync(path.join(f.dir,file)))]);
 const out=evidenceSearch(f.state,f.dir,'needle');
 assert.deepEqual(out.hits.map(h=>h.file),['raw-result-3.json']);
 assert.deepEqual(out.skipped,[{file:'raw-result-1.json',reason:'depth_limit'},{file:'raw-result-2.json',reason:'chunk_limit'}]);
 assert.deepEqual(fs.readdirSync(f.dir).map(file=>[file,hash(fs.readFileSync(path.join(f.dir,file)))]),before);
});

test('the entire UTF-8 search response fits its budget, including omitted and skipped metadata',t=>{
 const f=setup(t);
 put(f.dir,'raw-result-1.json',{notes:Array.from({length:50},(_,i)=>`needle ${i} ${'한글'.repeat(300)}`)});
 for(let i=2;i<=80;i++)put(f.dir,`raw-result-${i}.json`,'{broken');
 for(const byteBudget of [512,900,2000,12000]){
  const out=evidenceSearch(f.state,f.dir,'needle',{limit:50,byteBudget});
  assert.ok(Buffer.byteLength(JSON.stringify(out))<=byteBudget);
  assert.equal(out.used_bytes,Buffer.byteLength(JSON.stringify(out)));
  assert.equal(out.omitted_count,out.omitted.length+out.metadata_omitted.omitted);
  assert.equal(out.skipped_count,out.skipped.length+out.metadata_omitted.skipped);
  assert.equal(out.hits.length+out.omitted_count,50);
  assert.equal(out.skipped_count,79);
  assert.ok(out.metadata_omitted.skipped>0);
 }
 assert.throws(()=>evidenceSearch(f.state,f.dir,'needle'.repeat(200),{byteBudget:512}),/EVIDENCE_RESPONSE_BUDGET/);
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

test('CLI search writes exactly the budgeted compact JSON response',t=>{
 const f=fixture(t),query=path.join(f.temp,'query.json');
 put(f.temp,'query.json',{query:'objective bounded',byte_budget:512});
 const result=spawnSync(process.execPath,['scripts/fusion-state.mjs','evidence-search',f.root,query],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
 const out=JSON.parse(result.stdout);
 assert.equal(Buffer.byteLength(result.stdout),out.used_bytes);assert.ok(out.used_bytes<=512);
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
