import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {execute} from '../scripts/executor-bridge.mjs';
import {result as validateResult,environmentFailure} from '../scripts/contracts.mjs';
import {ACCEPTANCE} from '../scripts/adapters/common.mjs';
import {MEMBERS} from '../scripts/member-registry.mjs';

// 2026-11-04 L01: Terra가 Codex의 Windows 샌드박스에 세 라운드 연속 막혔고 리드가 매번 손으로 복구했다.
// 한 번 막히면 그 작업에서는 같은 CLI(Codex: Terra, Luna)를 쓰지 않고 다른 일꾼으로 넘긴다.
const task=(f,name)=>path.join(f.control,'tasks',f.brief.task_id,name);
const codex=name=>MEMBERS[name]?.binary==='codex';

test('a worker may report a sandbox-blocked test as not_run with its reason',()=>{
 const base={task_id:'T',round:1,status:'complete',summary:'s',files_read:[],files_changed:[],commands_run:[],unresolved:[],risks:[],needs_lead_decision:false,recommended_next_action:'review'};
 const blocked={command:'node --test',status:'not_run',environment_error:'spawn EPERM'};
 assert.equal(validateResult({...base,tests:[blocked]},'T',1).tests[0].status,'not_run');
 assert.equal(environmentFailure(blocked),true);
 assert.throws(()=>validateResult({...base,tests:[{...blocked,status:'pass'}]},'T',1),/environment_error needs status fail or not_run/);
});

test('a Codex sandbox failure in the bridge moves the task off every Codex worker',async t=>{
 const f=fixture(t,{executor:'terra'});
 f.mode('codex-sandbox-denied');
 f.begin();
 await assert.rejects(execute(f.root),/CODEX_WINDOWS_SANDBOX/);
 const record=JSON.parse(fs.readFileSync(task(f,'sandbox-failure-1.json'),'utf8'));
 assert.equal(record.cli,'codex');assert.equal(record.source,'bridge');
 const after=run(f.root,'recover',{token:f.state().writer.token,quiescent:true,reason:'bridge failed with CODEX_WINDOWS_SANDBOX; worker stopped'});
 assert.equal(after.phase,'ALTERNATIVE_REQUIRED');
 const unavailable=run(f.root,'status',{}).unavailable;
 for(const name of ['terra','luna'])assert.match(unavailable[name]??'',/CODEX_WINDOWS_SANDBOX/,name);
 assert.equal(unavailable.grok,undefined);
 f.mode('ok');
 const next=f.begin({executor:'auto'}).executor;
 assert.equal(codex(next),false,next);
});

test('a Codex worker that reports spawn EPERM is not sent back, and the lead cannot REDO it',async t=>{
 const f=fixture(t,{initialize:false,executor:'terra'});
 fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({review:{by:'delegate',strategy:'lead-gated-adaptive'}}));
 run(f.root,'init',{...f.brief,executor:'terra'});
 f.begin();
 const r=f.result();r.tests=[{command:'node --test',status:'not_run',environment_error:'Error: spawn EPERM (the sandbox blocked child processes)'}];
 f.finish(r);
 assert.equal(JSON.parse(fs.readFileSync(task(f,'sandbox-failure-1.json'),'utf8')).source,'worker-report');
 f.mode('review-redo');
 const c=run(f.root,'delegate-review',{});
 const {consult}=await import('../scripts/executor-bridge.mjs');await consult(f.root,c.consult_id);
 const out=run(f.root,'consult-finish',{quiescent:true}).review;
 assert.notEqual(out.recommendation,'REDO');
 assert.throws(()=>run(f.root,'lead-decision',{decision:'REDO',rationale:'AC1 fails',baseline_digest:f.state().post_digest,contract_change:false}),/CODEX_WINDOWS_SANDBOX/);
});

test('other environment failures and non-Codex workers do not block a CLI',t=>{
 const f=fixture(t,{executor:'terra'});
 f.begin();
 const r=f.result();r.tests=[{command:'node --test',status:'fail',environment_error:'network unreachable'}];
 f.finish(r);
 assert.equal(fs.existsSync(task(f,'sandbox-failure-1.json')),false);
 const g=fixture(t);
 g.begin();
 const s=g.result();s.tests=[{command:'node --test',status:'fail',environment_error:'spawn EPERM'}];
 g.finish(s);
 assert.equal(fs.existsSync(task(g,'sandbox-failure-1.json')),false,'grok does not run under the Codex sandbox');
});

test('workers are told that new source files are expected, only stray files are not',()=>{
 assert.match(ACCEPTANCE,/no stray untracked files/);
 assert.match(ACCEPTANCE,/new source files the task needs are expected and stay unstaged/);
 assert.doesNotMatch(ACCEPTANCE,/no new untracked files/);
});
