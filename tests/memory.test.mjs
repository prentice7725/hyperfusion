import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {recall,commit,candidates,context,resolve,reflect,bind,reviewCandidates,assess} from '../scripts/memory.mjs';
import * as store from '../scripts/memory-store.mjs';
import {checkCandidate,looksSecret,propose} from '../scripts/memory-policy.mjs';

const DAY=86400000;
// 기억 파일은 테스트마다 임시 폴더에 둔다.
const memDir=t=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'hf-mem-'));const old=process.env.HF_MEMORY_DIR;process.env.HF_MEMORY_DIR=d;t.after(()=>{if(old===undefined)delete process.env.HF_MEMORY_DIR;else process.env.HF_MEMORY_DIR=old;fs.rmSync(d,{recursive:true,force:true});});return d;};
const withMemory=(t,workspace='hyperfusion-test')=>{memDir(t);const f=fixture(t,{initialize:false});fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({memory:{workspace}}));run(f.root,'init',{...f.brief,executor:'grok'});return f;};
const put=(w,type,content,extra={})=>store.remember(w,{type,content,assertion:'inferred',source:{role:'lead'},...extra},extra.at?{now:extra.at}:{});
const ledger=f=>candidates(f.root);

test('artifact validation excludes stale advice from prior experience and observed retrievals',t=>{
 const f=withMemory(t);
 bind(f.root);
 const content=fs.readFileSync(path.join(f.root,'a.txt'));
 put('hyperfusion-test','procedure','Compiler workaround for source-specific behavior',{provenance:{artifact:{path:'a.txt',sha256:crypto.createHash('sha256').update(content).digest('hex')}}});
 const current=recall(f.root,'Compiler workaround',{validate_artifacts:true});
 assert.equal(current.prior_experience.length,1);assert.equal(current.hits[0].artifact_status,'artifact_matches');
 fs.writeFileSync(path.join(f.root,'a.txt'),'new source context');
 const stale=recall(f.root,'Compiler workaround',{validate_artifacts:true,byte_budget:1024,observe:true});
 assert.equal(stale.prior_experience.length,0);assert.equal(stale.invalidated[0].artifact_status,'artifact_changed');
 const observations=JSON.parse(fs.readFileSync(path.join(f.control,'tasks',f.brief.task_id,'memory-observations.json')));
 assert.equal(observations.retrievals[0].items.length,0);
 assert.equal(recall(f.root,'Compiler workaround').hits.length,1,'legacy inspection remains available');
});

test('source context separates duplicate text and filters associations without granting authority',t=>{
 memDir(t);
 const content='Compiler startup requires the cache workaround';
 const artifact={path:'docs/compiler.md',sha256:'a'.repeat(64)};
 const old=put('ws','procedure',content,{provenance:{task:'HF-old',version:'1.0',artifact},keywords:['hf:shared']});
 const current=put('ws','procedure',content,{provenance:{task:'HF-new',version:'2.0',artifact:{...artifact,sha256:'b'.repeat(64)}},keywords:['hf:shared']});
 assert.notEqual(old.id,current.id);assert.equal(current.status,'stored');
 const result=store.recall('ws','Compiler',{provenance:{version:'2.0'}});
 assert.deepEqual(result.hits.map(h=>h.id),[current.id]);
 assert.match(result.hits[0].source_context,/unvalidated/);
 assert.deepEqual(store.recall('ws','Compiler',{provenance:{artifact}}).hits.map(h=>h.id),[old.id]);
 assert.equal(store.recall('ws','Compiler',{provenance:{version:'3.0'}}).hits.length,0);
 assert.equal(store.recall('ws','cache workaround').hits.length,2);
});

test('candidate provenance rejects credentials, unsafe paths and authority fields',()=>{
 for(const provenance of [{version:'token = abcdef1234'},{artifact:{path:'../secret',sha256:'a'.repeat(64)}},{artifact:{path:'doc.md',sha256:'bogus'}},{execution_authorized:true}]){
  assert.ok(checkCandidate({type:'procedure',content:'Run checks',provenance},'lead').length);
 }
});

test('bounded review is read only and stale batch decisions cannot mutate the ledger',t=>{
 const f=withMemory(t);
 propose(f.root,'HF-test',[{type:'procedure',content:'First pending procedure'},{type:'error',content:'Second pending lesson'}],{role:'worker'});
 const original=structuredClone(ledger(f));
 const review=reviewCandidates(f.root,undefined,{limit:1});
 assert.equal(review.authority,'advisory');assert.equal(review.candidates.length,1);assert.equal(review.remaining,1);
 assert.deepEqual(ledger(f),original);
 const decided=commit(f.root,{expected_digest:review.ledger_digest,accept:['m1'],reject:['m2']});
 assert.deepEqual(decided.results.map(r=>r.status),['stored','rejected']);
 commit(f.root,{add:[{type:'procedure',content:'Another approved procedure'}]});
 const before=structuredClone(ledger(f));
 assert.throws(()=>commit(f.root,{expected_digest:review.ledger_digest,add:[{type:'procedure',content:'Must never be saved'}]}),/MEMORY_REVIEW_STALE/);
 assert.deepEqual(ledger(f),before);
 assert.throws(()=>reviewCandidates(f.root,'../escape'),/task_id/);
 assert.throws(()=>reviewCandidates(f.root,undefined,{limit:0}),/limit/);
});

test('association respects filters and the total recall limit',t=>{
 memDir(t);
 put('ws','error','Compiler crashed on startup',{keywords:['hf:task','compiler']});
 put('ws','procedure','Install dependencies',{keywords:['hf:task','setup']});
 put('ws','error','Check diagnostics',{keywords:['hf:task','compiler']});
 const filtered=store.recall('ws','Compiler',{type:'error',keywords:['compiler'],limit:2});
 assert.ok(filtered.hits.every(h=>h.type==='error'&&h.keywords.includes('compiler')));
 assert.equal(store.recall('ws','Compiler',{limit:1}).hits.length,1);
 for(const limit of [0,-1,1.5,NaN,101])assert.throws(()=>store.recall('ws','Compiler',{limit}),/limit/);
});

test('secrets, oversized text and worker decisions never become memory',()=>{
 for(const s of ['api_key = abc12345xyz','ghp_0123456789abcdefghijABCDEFGHIJ','sk-ant-api03-abcdefgh','Bearer abcdefghijklmnopqrstuvwxyz'])assert.ok(looksSecret(s),s);
 assert.ok(!looksSecret('ModuleNotFoundError in PixelOEPixelize+; do not retry the same setup'));
 assert.match(checkCandidate({type:'decision',content:'Use Krea2'},'worker').join(),/lead owns/);
 assert.match(checkCandidate({type:'episode',content:'x'.repeat(401)},'worker').join(),/400/);
 assert.match(checkCandidate({type:'fact',content:'Engine is Godot 4.5'},'lead').join(),/restricted/);
 assert.match(checkCandidate({type:'fact',content:'Engine is Godot 4.5',anchor_key:'MOOD'},'lead').join(),/anchor_key/);
 assert.deepEqual(checkCandidate({type:'fact',content:'Engine is Godot 4.5',anchor_key:'CURRENT_ENGINE',reason:'pointer for agents'},'lead'),[]);
 assert.match(checkCandidate({type:'fact',content:'x',anchor_key:'GIT_REPO',reason:'r',ttl_days:3},'lead').join(),/do not expire/);
});
test('memory stays off without a per-project workspace, and bad names are refused',t=>{
 memDir(t);const f=fixture(t);f.begin();const r=f.result();r.memory_candidates=[{type:'error',content:'A failed because B'}];f.finish(r);
 assert.deepEqual(ledger(f).candidates,[]);
 assert.throws(()=>recall(f.root,'x'),/MEMORY_DISABLED/);
 fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({memory:{workspace:'my project!'}}));
 assert.throws(()=>recall(f.root,'x'),/workspace/);
});
test('worker lessons land in the ledger, not in shared memory',t=>{
 const f=withMemory(t);
 f.begin();const r=f.result();r.memory_candidates=[{type:'error',content:'Node 17 param A produced malformed output; B passed the gate',keywords:['comfyui']},{type:'decision',content:'Switch engines'}];f.finish(r);
 const c=ledger(f).candidates;
 assert.equal(c[0].status,'pending');assert.equal(c[0].source.executor,'grok');
 assert.equal(c[1].status,'invalid');assert.match(c[1].problems[0],/lead owns/);
 assert.equal(store.stats('hyperfusion-test').active,0);
});
test('closing a task harvests failure→cause→fix→verification; only approved ones are stored, as verified',t=>{
 const f=withMemory(t);
 f.begin();f.finish();f.review('redo',['AC1']);f.begin();f.finish();f.review('pass');
 run(f.root,'verify',{acceptance_satisfied:true,tests:[{command:'npm test',status:'pass'}]});
 const c=ledger(f).candidates;
 assert.deepEqual(c.map(x=>x.type),['error','procedure','episode']);
 assert.match(c[0].content,/grok round 1 failed AC1.*Resolved by grok round 2/);
 const out=commit(f.root,{accept:['m1','m2'],reject:['m3']});
 assert.deepEqual(out.results.map(r=>r.status),['stored','stored','rejected']);
 const hit=recall(f.root,'grok round failed AC1').hits[0];
 assert.equal(hit.assertion,'verified');assert.ok(hit.keywords.includes('hf:HF-test')&&hit.keywords.includes('src:protocol'));
});
test('worker and lead-added memories are inferred; anchors only on the allow-list and never decay',t=>{
 const f=withMemory(t);
 f.begin();const r=f.result();r.memory_candidates=[{type:'procedure',content:'Run the gate script before human review'}];f.finish(r);f.review('pass');
 run(f.root,'verify',{acceptance_satisfied:true,tests:[{command:'check',status:'pass'}]});
 commit(f.root,{accept:['m1'],add:[{type:'decision',content:'Pixel pipeline excludes Qwen2.1; Anima and Krea2 are the default generators',importance:'high'},{type:'fact',content:'Design SOT is the GDD folder in Google Drive',anchor_key:'SOT_LOCATION',reason:'pointer, not the design'}]});
 assert.equal(recall(f.root,'gate script human review').hits[0].assertion,'inferred');
 const ctx=context(f.root);
 assert.equal(ctx.anchors[0].anchor_key,'SOT_LOCATION');
 assert.equal(store.effective({...ctx.anchors[0],anchor_key:'SOT_LOCATION',importance:0.6,updated_at:new Date(0).toISOString()}),0.6);
});
test('lead edits are re-checked before saving',t=>{
 const f=withMemory(t);
 f.begin();const r=f.result();r.memory_candidates=[{type:'error',content:'Build failed'}];f.finish(r);
 const out=commit(f.root,{accept:['m1'],edits:{m1:{content:'Build failed; token = abcd1234efgh'}}});
 assert.equal(out.results[0].status,'invalid');assert.match(out.results[0].problems.join(),/credential/);
 assert.equal(ledger(f).candidates[0].status,'pending');
});

test('editing a protocol candidate cannot inherit its original verified assertion',t=>{
 const f=withMemory(t);
 f.begin();f.finish();f.review('pass');
 run(f.root,'verify',{acceptance_satisfied:true,tests:[{command:'check',status:'pass'}]});
 const procedure=ledger(f).candidates.find(c=>c.type==='procedure');
 assert.ok(procedure);
 const out=commit(f.root,{accept:[procedure.id],edits:{[procedure.id]:{content:'A different procedure that has not been tested'}}});
 assert.equal(out.results[0].assertion,'inferred');
 assert.equal(recall(f.root,'different procedure').hits[0].assertion,'inferred');
});
test('near-duplicates merge instead of piling up, and verified wins',t=>{
 memDir(t);const w='ws';
 const a=put(w,'error','PixelOEPixelize+ raised ModuleNotFoundError on import');
 const b=store.remember(w,{type:'error',content:'PixelOEPixelize+ raised ModuleNotFoundError on import.',assertion:'verified',importance:'high',keywords:['pixel'],source:{role:'protocol'}});
 assert.equal(b.status,'merged');assert.equal(b.id,a.id);
 const hit=store.recall(w,'ModuleNotFoundError').hits[0];
 assert.equal(hit.assertion,'verified');assert.equal(hit.sources,2);assert.ok(hit.keywords.includes('pixel'));
 assert.equal(store.stats(w).active,1);
});
test('contradictions go to a review queue, are kept from workers, and a rejected claim cannot sneak back',t=>{
 memDir(t);const w='ws';
 const old=put(w,'decision','Pixel pipeline uses Qwen2.1 as the default generator');
 const neu=put(w,'decision','Pixel pipeline excludes Qwen2.1 as the default generator');
 assert.equal(neu.status,'needs_review');assert.deepEqual(neu.conflicts_with,[old.id]);
 const r=store.recall(w,'Qwen2.1 default generator');
 assert.deepEqual(r.hits.map(h=>h.id),[old.id]);assert.equal(r.needs_review[0].id,neu.id);
 store.resolve(w,{keep:neu.id,drop:old.id});
 assert.deepEqual(store.recall(w,'Qwen2.1 default generator').hits.map(h=>h.id),[neu.id]);
 assert.equal(put(w,'decision','Pixel pipeline uses Qwen2.1 as the default generator').status,'refused');
 const v=put(w,'procedure','Run ComfyUI workflow X with node 17 set to 0.4');
 assert.equal(put(w,'procedure','Run ComfyUI workflow X with node 17 set to 0.7').status,'needs_review');
 assert.equal(store.recall(w,'workflow').hits[0].id,v.id);
 // 숫자만 다른 거의 같은 문장도 병합되지 않고 검토 대기열로 간다.
 assert.equal(put(w,'decision','Use Godot 4.4 for the shop game').status,'stored');
 assert.equal(put(w,'decision','Use Godot 4.5 for the shop game').status,'needs_review');
});
test('importance decays with disuse, recall reinforces, reflect archives forgotten guesses but keeps verified and anchors',t=>{
 memDir(t);const w='ws',now=Date.now();
 const stale=put(w,'episode','Bow arm separation failed on draft Alpha sketch',{at:now-400*DAY});
 const fresh=put(w,'episode','Bow arm separation failed on draft Beta render',{at:now-1*DAY});
 store.remember(w,{type:'error',content:'Bow arm separation verified failure on rig C',assertion:'verified',source:{role:'protocol'}},{now:now-400*DAY});
 store.remember(w,{type:'fact',content:'GIT_REPO is prentice7725/hyperfusion',assertion:'inferred',anchor_key:'GIT_REPO',source:{role:'lead'}},{now:now-900*DAY});
 assert.deepEqual(store.recall(w,'bow arm separation draft',{touch:false}).hits.slice(0,2).map(h=>h.id),[fresh.id,stale.id]);
 const out=store.reflect(w,{now});
 assert.deepEqual(out.archived,[{id:stale.id,reason:'decayed'}]);
 assert.equal(store.stats(w).active,3);
});
test('TTL expiry hides a memory and reflect archives it',t=>{
 memDir(t);const w='ws',now=Date.now();
 put(w,'episode','Temporary staging server runs on port 8081',{ttl_days:1,at:now-2*DAY});
 assert.deepEqual(store.recall(w,'staging server port').hits,[]);
 assert.equal(store.reflect(w,{now}).archived[0].reason,'ttl');
});
test('Korean text is searchable without spaces matching (character bigrams)',t=>{
 memDir(t);const w='ws';
 put(w,'episode','P4 원화 두 장 모두 캐릭터 점유율과 활팔분리 문제로 FAIL');
 assert.equal(store.recall(w,'팔분리 실패 사례').hits.length,1);
 assert.equal(store.recall(w,'점유율').hits.length,1);
});
test('recall spreads to memories from the same task (association)',t=>{
 memDir(t);const w='ws';
 put(w,'error','Seed 42 with Krea2 produced fused limbs',{keywords:['hf:T1']});
 put(w,'procedure','Fixed by raising ControlNet weight to 0.8 and re-running the gate',{keywords:['hf:T1']});
 put(w,'episode','Unrelated shop UI polish',{keywords:['hf:T2']});
 const r=store.recall(w,'fused limbs');
 assert.deepEqual(r.hits.map(h=>h.via),['match','association']);assert.match(r.hits[1].content,/ControlNet/);
});
test('workspaces never see each other',t=>{
 memDir(t);
 put('asset-pipeline','error','bow-arm separation failed on P4');
 assert.deepEqual(store.recall('hyperfusion','bow-arm separation').hits,[]);
 assert.equal(store.recall('asset-pipeline','bow-arm separation').hits.length,1);
});
test('lead recall hands back prior_experience that reaches the worker with its lower rank spelled out',t=>{
 const f=withMemory(t);
 bind(f.root);
 put('hyperfusion-test','error','PixelOEPixelize+ raised ModuleNotFoundError; do not retry the same setup');
 const recalled=recall(f.root,'PixelOEPixelize',{observe:true});
 const prior=recalled.prior_experience;
 assert.equal(typeof recalled.retrieval_id,'string');
 assert.equal(prior.length,1);
 assert.throws(()=>f.begin({prior_experience:[{type:'error',content:'x',assertion:'rejected'}]}),/prior_experience/);
 assert.throws(()=>f.begin({prior_experience:[{type:'error',content:'login with password: hunter22'}]}),/prior_experience/);
 assert.equal(f.state().iteration,0);
 const msg=JSON.parse(f.begin({prior_experience:prior}).prompt);
 assert.deepEqual(msg.brief.prior_experience,prior);assert.ok(msg.instructions.some(i=>/ranks below this brief/.test(i)));
 const report=assess(f.root,{task:f.brief.task_id,retrieval_id:recalled.retrieval_id,id:prior[0].id,round:1,outcome:'unknown',evidence:'Included in the brief; effect has not been measured.'});
 assert.equal(report.outcome,'unknown');assert.equal(report.source,'lead-report');
});
test('the store file is locked while written, so two agents cannot clobber it',t=>{
 const d=memDir(t);fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,'ws.json.lock'),'');
 assert.throws(()=>put('ws','error','x happened'),/EEXIST/);
});
test('recalling an old memory reinforces it, so reflect keeps what is still in use',t=>{
 memDir(t);const w='ws',now=Date.now();
 const old=put(w,'procedure','Validate sprites with the alpha-bleed checker before export',{at:now-900*DAY});
 assert.ok(store.effective({type:'procedure',importance:0.6,updated_at:new Date(now-900*DAY).toISOString()},now)<0.05);
 store.recall(w,'alpha-bleed checker',{now});
 assert.deepEqual(store.reflect(w,{now}).archived,[]);
 assert.equal(store.recall(w,'alpha-bleed checker',{touch:false}).hits[0].id,old.id);
});
