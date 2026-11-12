import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {REASON_CODES,DISPOSITIONS,disposition,participants} from '../scripts/resume-packet.mjs';

// HF-I09: 재개 패킷의 이유 코드 조합을 처분값 하나로 줄인다. 표시일 뿐 권한이 아니다.
const EXPECTED={LEGACY_STATE:'unreadable',PHASE_UNKNOWN:'unreadable',ROUND_INVALID:'unreadable',ARTIFACT_INVALID:'unreadable',
 INITIAL_BRIEF_UNAVAILABLE:'unreadable',RECOVERY_REQUIRED:'recovery_required',DISPATCH_OUTCOME_UNCERTAIN:'outcome_uncertain',
 VERIFICATION_OUTCOME_UNCERTAIN:'outcome_uncertain',TERMINAL_SETTLEMENT_INCOMPLETE:'outcome_uncertain',
 PROCESS_SHUTDOWN_UNVERIFIED:'shutdown_unverified',CONTROLLER_LOCK_PRESENT:'shutdown_unverified',ACCEPTANCE_PENDING:'shutdown_unverified',
 EXISTING_LAUNCH:'evidence_present',EXISTING_CONSULT:'evidence_present'};
const contents=dir=>Object.fromEntries(fs.readdirSync(dir,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()).map(e=>{
 const file=path.join(e.parentPath??e.path,e.name);return [path.relative(dir,file),fs.readFileSync(file).toString('base64')];
}));

test('each of the fourteen reason codes maps to its disposition',()=>{
 assert.equal(REASON_CODES.length,14);
 assert.deepEqual(Object.keys(EXPECTED).sort(),[...REASON_CODES].sort());
 for(const code of REASON_CODES)assert.deepEqual(disposition([code],'REVIEW'),{disposition:EXPECTED[code],basis:[code]},code);
});

test('the disposition table and the packet source cover exactly the same reason codes',()=>{
 const table=DISPOSITIONS.flatMap(([,codes])=>codes);
 assert.equal(new Set(table).size,table.length);
 assert.deepEqual([...table].sort(),[...REASON_CODES].sort());
 // 패킷이 새 이유 코드를 내기 시작하면 목록과 표도 고치게 한다.
 const source=fs.readFileSync(new URL('../scripts/resume-packet.mjs',import.meta.url),'utf8');
 const pushed=[...new Set([...source.matchAll(/reasons\.push\('([A-Z_]+)'\)/g)].map(m=>m[1]))];
 assert.deepEqual(pushed.sort(),[...REASON_CODES].sort());
});

test('the earlier row wins when codes mix, and only the deciding codes are the basis',()=>{
 assert.deepEqual(disposition(['EXISTING_LAUNCH','RECOVERY_REQUIRED'],'RECOVERY_REQUIRED'),{disposition:'recovery_required',basis:['RECOVERY_REQUIRED']});
 assert.deepEqual(disposition(['CONTROLLER_LOCK_PRESENT','PROCESS_SHUTDOWN_UNVERIFIED','DISPATCH_OUTCOME_UNCERTAIN'],'EXECUTING'),{disposition:'outcome_uncertain',basis:['DISPATCH_OUTCOME_UNCERTAIN']});
 assert.equal(disposition(['LEGACY_STATE','RECOVERY_REQUIRED'],'RECOVERY_REQUIRED').disposition,'unreadable');
});

test('an unknown code is unreadable, never continue',()=>{
 assert.deepEqual(disposition(['SOMETHING_NEW'],'PLAN'),{disposition:'unreadable',basis:['SOMETHING_NEW']});
 assert.equal(disposition(['EXISTING_LAUNCH','SOMETHING_NEW'],'REVIEW').disposition,'unreadable');
});

test('no reason code means continue, or settled in a terminal phase',()=>{
 assert.deepEqual(disposition([],'PLAN'),{disposition:'continue',basis:[]});
 for(const phase of ['CLOSE','BLOCKED'])assert.equal(disposition([],phase).disposition,'settled');
});

test('a recorded worker completion turns a lone held lease into evidence_present, nothing else does',()=>{
 const held=['EXISTING_LAUNCH','PROCESS_SHUTDOWN_UNVERIFIED'];
 assert.equal(disposition(held,'EXECUTING').disposition,'shutdown_unverified');
 assert.deepEqual(disposition(held,'EXECUTING',{implementerCompleted:true}),{disposition:'evidence_present',basis:['EXISTING_LAUNCH']});
 // 컨트롤러 잠금이나 수용 표식이 함께 있으면 먼저 그쪽을 확인한다.
 assert.equal(disposition([...held,'CONTROLLER_LOCK_PRESENT'],'EXECUTING',{implementerCompleted:true}).disposition,'shutdown_unverified');
 assert.equal(disposition([...held,'ACCEPTANCE_PENDING'],'VERIFY',{implementerCompleted:true}).disposition,'shutdown_unverified');
});

test('participant traces come from the current round files only',()=>{
 const p=status=>({status});
 const s={iteration:2,owner:'terra',open_consult:{id:'c1',members:[{member:'sol'},{member:'sonnet'},{member:'grok'},{member:'../x'}]}};
 const artifacts={'launch-2.json':p('present'),'result-2.json':p('present'),'launch-1.json':p('present'),'completion-1.json':p('present'),
  'launch-consult-c1-sol.json':p('present'),
  'launch-consult-c1-sonnet.json':p('present'),'consult-result-c1-sonnet.json':p('present'),'completion-consult-c1-sonnet.json':p('present'),
  'launch-consult-c1-grok.json':p('invalid')};
 assert.deepEqual(participants(s,artifacts),[
  {role:'implementer',member:'terra',trace:'result_recorded'},
  {role:'consult',member:'sol',trace:'launched_only'},
  {role:'consult',member:'sonnet',trace:'completion_recorded'},
  {role:'consult',member:'grok',trace:'invalid'}]);
 assert.deepEqual(participants({iteration:0,owner:'grok'},{}),[{role:'implementer',member:'grok',trace:'not_launched'}]);
 assert.deepEqual(participants({iteration:null,owner:'grok'},{}),[]);
});

test('the packet carries the disposition and stays read-only',t=>{
 const f=fixture(t);f.begin();
 const before=contents(f.control),packet=run(f.root,'resume');
 assert.deepEqual(contents(f.control),before);
 assert.equal(packet.packet_revision,2);
 assert.equal(packet.disposition,'outcome_uncertain');
 assert.deepEqual(packet.disposition_basis,['DISPATCH_OUTCOME_UNCERTAIN']);
 assert.deepEqual(packet.participants,[{role:'implementer',member:'grok',trace:'not_launched'}]);
 assert.equal(packet.auto_resume,false);assert.equal(packet.lead_required,true);
 assert.match(packet.evidence_note,/does not establish/);
});
