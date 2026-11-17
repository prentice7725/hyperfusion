import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {recall,commit,context,bind,ruleCandidates} from '../scripts/memory.mjs';
import * as store from '../scripts/memory-store.mjs';

const W='hyperfusion-test';
const memDir=t=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'hf-mem-'));const old=process.env.HF_MEMORY_DIR;process.env.HF_MEMORY_DIR=d;t.after(()=>{if(old===undefined)delete process.env.HF_MEMORY_DIR;else process.env.HF_MEMORY_DIR=old;fs.rmSync(d,{recursive:true,force:true});});return d;};
const withMemory=t=>{memDir(t);const f=fixture(t,{initialize:false});fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({memory:{workspace:W}}));run(f.root,'init',{...f.brief,executor:'grok'});bind(f.root);return f;};
// 같은 내용을 작업마다 다시 저장하면 병합되며 출처(작업 ID)가 쌓인다.
const lesson='rule modules imported a scene module and broke the layering check';
const put=(content,task,{type='error',executor='terra'}={})=>store.remember(W,{type,content,assertion:'inferred',keywords:[],source:{role:'worker',executor,task}});
const sha=text=>crypto.createHash('sha256').update(text).digest('hex');
const storeFile=()=>path.join(process.env.HF_MEMORY_DIR,W+'.json');

test('only active error fragments from two or more distinct tasks are candidates',t=>{
 const f=withMemory(t);
 const a=put(lesson,'HF-1').id;put(lesson,'HF-1');               // 같은 작업 두 번: 아직 후보가 아니다
 assert.equal(ruleCandidates(f.root).candidates.length,0);
 put(lesson,'HF-2',{executor:'luna'});
 put('worker forgot to run the formatter before finishing','HF-1',{type:'procedure'});put('worker forgot to run the formatter before finishing','HF-3',{type:'procedure'});
 const r=ruleCandidates(f.root);
 assert.deepEqual(r.candidates.map(c=>c.id),[a]);
 assert.deepEqual(r.candidates[0].tasks,['HF-1','HF-2']);assert.deepEqual(r.candidates[0].workers,['terra','luna']);
 assert.match(r.digest,/^[a-f0-9]{64}$/);
 // 검토 대기·기각 조각은 후보가 아니다
 store.resolve(W,{reject:[a]});
 assert.equal(ruleCandidates(f.root).candidates.length,0);
});

test('rule-candidates does not change the store file',t=>{
 const f=withMemory(t);
 put(lesson,'HF-1');put(lesson,'HF-2');
 const before=fs.readFileSync(storeFile());
 ruleCandidates(f.root);ruleCandidates(f.root,{enforced:true});
 assert.deepEqual(fs.readFileSync(storeFile()),before);
});

test('a stale digest or an invalid enforce entry records nothing',t=>{
 const f=withMemory(t);
 const id=put(lesson,'HF-1').id;put(lesson,'HF-2');
 const {digest}=ruleCandidates(f.root);
 const art={path:'a.txt',sha256:sha(fs.readFileSync(path.join(f.root,'a.txt')))};
 const before=fs.readFileSync(storeFile());
 assert.throws(()=>commit(f.root,{rules:{expected_digest:'0'.repeat(64),enforce:[{id,kind:'static',ref:'eslint no-restricted-imports',artifact:art}]}}),/MEMORY_RULES_STALE/);
 assert.throws(()=>commit(f.root,{rules:{expected_digest:digest,enforce:[{id,kind:'static',ref:'eslint no-restricted-imports'}]}}),/artifact/);
 assert.throws(()=>commit(f.root,{rules:{expected_digest:digest,enforce:[{id,kind:'static',ref:'x',artifact:{path:'../a.txt',sha256:art.sha256}}]}}),/artifact/);
 assert.throws(()=>commit(f.root,{rules:{expected_digest:digest,enforce:[{id,kind:'static',ref:'x',artifact:{path:'a.txt',sha256:'nothex'}}]}}),/artifact/);
 assert.throws(()=>commit(f.root,{rules:{expected_digest:digest,enforce:[{id,kind:'lint',ref:'x',artifact:art}]}}),/kind must be static or test/);
 // 하나가 틀리면 앞의 유효한 항목도 적지 않는다
 assert.throws(()=>commit(f.root,{rules:{expected_digest:digest,enforce:[{id,kind:'static',ref:'x',artifact:art}],not_enforceable:[{id:'fmissing',reason:'r'}]}}),/unknown memory/);
 assert.deepEqual(fs.readFileSync(storeFile()),before);
});

test('an enforced fragment leaves recall and context with only a count, and stays in the store',t=>{
 const f=withMemory(t);
 const id=put(lesson,'HF-1').id;put(lesson,'HF-2');
 const art={path:'a.txt',sha256:sha(fs.readFileSync(path.join(f.root,'a.txt')))};
 assert.equal(recall(f.root,'scene module layering').hits.length,1);
 const out=commit(f.root,{rules:{expected_digest:ruleCandidates(f.root).digest,enforce:[{id,kind:'static',ref:'eslint no-restricted-imports (rules -> scenes)',artifact:art}]}});
 assert.deepEqual(out.rules,[{id,status:'enforced'}]);
 const r=recall(f.root,'scene module layering');
 assert.equal(r.hits.length,0);assert.equal(r.enforced_omitted,1);assert.equal(r.prior_experience.length,0);
 assert.equal(context(f.root).enforced_omitted,1);
 assert.equal(ruleCandidates(f.root).candidates.length,0);
 const listed=ruleCandidates(f.root,{enforced:true}).enforced;
 assert.equal(listed[0].id,id);assert.equal(listed[0].enforced_by.artifact.path,'a.txt');
 assert.ok(JSON.parse(fs.readFileSync(storeFile())).fragments.some(x=>x.id===id&&x.enforced_by));
 // 규칙 파일이 그대로면 확인해도 돌아오지 않는다
 assert.equal(recall(f.root,'scene module layering',{validate_artifacts:true}).hits.length,0);
});

test('validate-artifacts brings an enforced fragment back as enforcement_stale when the rule file changed or vanished',t=>{
 const f=withMemory(t);
 const id=put(lesson,'HF-1').id;put(lesson,'HF-2');
 fs.writeFileSync(path.join(f.root,'rules.cfg'),'no-restricted-imports');
 const art={path:'rules.cfg',sha256:sha('no-restricted-imports')};
 commit(f.root,{rules:{expected_digest:ruleCandidates(f.root).digest,enforce:[{id,kind:'static',ref:'layering rule',artifact:art}]}});
 fs.writeFileSync(path.join(f.root,'rules.cfg'),'');
 const changed=recall(f.root,'scene module layering',{validate_artifacts:true});
 assert.equal(changed.hits.length,1);assert.equal(changed.hits[0].enforcement_stale,true);
 assert.equal(context(f.root,{validate_artifacts:true}).core.find(x=>x.id===id)?.enforcement_stale,true);
 // 확인하지 않으면 조용히 빠진 채다
 assert.equal(recall(f.root,'scene module layering').hits.length,0);
 fs.rmSync(path.join(f.root,'rules.cfg'));
 assert.equal(recall(f.root,'scene module layering',{validate_artifacts:true}).hits[0]?.enforcement_stale,true);
 // 새 해시로 다시 적으면 다시 빠진다
 fs.writeFileSync(path.join(f.root,'rules.cfg'),'no-restricted-imports v2');
 commit(f.root,{rules:{expected_digest:ruleCandidates(f.root).digest,enforce:[{id,kind:'static',ref:'layering rule',artifact:{path:'rules.cfg',sha256:sha('no-restricted-imports v2')}}]}});
 assert.equal(recall(f.root,'scene module layering',{validate_artifacts:true}).hits.length,0);
});

test('a not_enforceable fragment leaves the candidates but stays in recall',t=>{
 const f=withMemory(t);
 const id=put(lesson,'HF-1').id;put(lesson,'HF-2');
 const out=commit(f.root,{rules:{expected_digest:ruleCandidates(f.root).digest,not_enforceable:[{id,reason:'needs a design judgment'}]}});
 assert.deepEqual(out.rules,[{id,status:'not_enforceable'}]);
 assert.equal(ruleCandidates(f.root).candidates.length,0);
 assert.equal(recall(f.root,'scene module layering').hits.length,1);
});

test('a store without the new fields behaves as before',t=>{
 const f=withMemory(t);
 put(lesson,'HF-1');
 const r=recall(f.root,'scene module layering');
 assert.equal(r.hits.length,1);assert.equal(r.enforced_omitted,undefined);
 assert.equal(context(f.root).enforced_omitted,undefined);
});
