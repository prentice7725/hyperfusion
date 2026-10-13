import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './support.mjs';
import {run} from '../scripts/fusion-state.mjs';
import {read} from '../scripts/artifact.mjs';
import {consult} from '../scripts/executor-bridge.mjs';
import {result as validateResult,environmentFailure} from '../scripts/contracts.mjs';

// R2에서 나온 두 가지: 샌드박스가 막아서 실패한 테스트가 complete 결과를 거절시키던 것,
// 공유 git 설정이 바뀌면 `.git` 경로를 범위 예외로 받을 수 없어 복구할 길이 없던 것.

const base={task_id:'T',round:1,status:'complete',summary:'done',files_read:[],files_changed:[],commands_run:[],unresolved:[],risks:[],needs_lead_decision:false,recommended_next_action:'review'};
const withTests=tests=>({...base,tests});

test('a test blocked by the worker sandbox may be reported as failed with a reason next to a complete result',()=>{
 const blocked={command:'npm test',status:'fail',environment_error:'EPERM: spawn blocked by the sandbox'};
 assert.doesNotThrow(()=>validateResult(withTests([blocked,{command:'npm run lint',status:'pass'}]),'T',1));
 assert.equal(environmentFailure(blocked),true);
 assert.throws(()=>validateResult(withTests([{command:'npm test',status:'fail'}]),'T',1),/Contradictory complete result/,'a failure with no reason still contradicts complete');
 assert.throws(()=>validateResult(withTests([{command:'npm test',status:'fail',environment_error:' '}]),'T',1),/environment_error/);
 assert.throws(()=>validateResult(withTests([{command:'npm test',status:'pass',environment_error:'EPERM'}]),'T',1),/environment_error/,'only a failure can carry a reason');
 assert.throws(()=>validateResult(withTests([{command:'npm test',status:'not_run',environment_error:'EPERM'}]),'T',1),/environment_error/);
 assert.equal(environmentFailure({command:'x',status:'fail'}),false);
});

test('an environment failure still reaches the lead and is not counted as a pass',async t=>{
 const f=fixture(t,{initialize:false});
 fs.writeFileSync(path.join(f.root,'hyperfusion.config.json'),JSON.stringify({review:{by:'delegate',strategy:'lead-gated-adaptive',auto_apply:true}}));
 run(f.root,'init',{...f.brief,executor:'grok'});
 f.begin();
 const out=f.finish({...f.result(),tests:[{command:'npm test',status:'fail',environment_error:'EPERM: sandbox refused to spawn node'}]});
 assert.equal(out.phase,'REVIEW','the round is accepted instead of failing as contradictory');
 const task=(...parts)=>path.join(f.control,'tasks',f.brief.task_id,...parts);
 assert.equal(read(task('raw-result-1.json')).tests[0].environment_error,'EPERM: sandbox refused to spawn node');
 const review=run(f.root,'delegate-review',{});
 await consult(f.root,review.consult_id);
 const gate=run(f.root,'consult-finish',{quiescent:true});
 assert.equal(gate.review.status,'lead_gate','the lead decides; the controller does not wave the round through');
 assert.deepEqual(read(task('lead-packet-1.json')).environment_failures,[{command:'npm test',environment_error:'EPERM: sandbox refused to spawn node'}]);
});

const gitConfig=(f,...args)=>f.git('config',...args);
const touchConfig=f=>gitConfig(f,'branch.main.remote','origin');
const recoverWith=(f,token,list)=>run(f.root,'recover',{token,quiescent:true,reason:'git config changed outside the worker',allow_out_of_scope:list});

test('a shared git config change during a round can be recovered with a recorded exception',t=>{
 const f=fixture(t);
 f.begin();
 touchConfig(f);
 const failed=f.finish(f.result());
 assert.equal(failed.phase,'RECOVERY_REQUIRED');
 assert.ok(failed.last_errors.some(e=>/Out of scope: \.git\/config/.test(e)),JSON.stringify(failed.last_errors));
 assert.ok(failed.last_errors.some(e=>/allow_out_of_scope \[\{path:"\.git\/config"/.test(e)),'the error names the way out');
 const token=f.state().writer.token;
 assert.throws(()=>recoverWith(f,token,[{path:'.git/config'}]),/allow_out_of_scope/,'a reason is still required');
 recoverWith(f,token,[{path:'.git/config',reason:'git branch tracking written by the lead'}]);
 assert.equal(f.state().scope_exceptions[0].path,'.git/config');
 f.begin();
 fs.writeFileSync(path.join(f.root,'a.txt'),'fixed');
 assert.equal(f.finish(f.result(['a.txt'])).phase,'REVIEW','the accepted config no longer stops the next round');
});

test('hooks and other .git paths are never accepted as scope exceptions',t=>{
 const f=fixture(t);
 f.begin();
 const token=f.state().writer.token;
 for(const p of ['.git/hooks/pre-commit','.git/HEAD','.git/objects/x','.git','.GIT/config','.git/config/../hooks/x'])
  assert.throws(()=>recoverWith(f,token,[{path:p,reason:'because'}]),/Invalid allow_out_of_scope/,p);
});

test('a git config that can run commands is not accepted, and an accepted exception stops counting once one appears',t=>{
 const f=fixture(t);
 f.begin();
 gitConfig(f,'core.fsmonitor','/tmp/evil-hook');
 const failed=f.finish(f.result());
 assert.equal(failed.phase,'RECOVERY_REQUIRED');
 const token=f.state().writer.token;
 assert.throws(()=>recoverWith(f,token,[{path:'.git/config',reason:'trust me'}]),/entries that can run commands \(core\.fsmonitor/);
 assert.equal(f.state().scope_exceptions?.length??0,0,'nothing was recorded');
 // 위험한 항목을 지우면 같은 파일을 받을 수 있다.
 gitConfig(f,'--unset','core.fsmonitor');
 touchConfig(f);
 recoverWith(f,token,[{path:'.git/config',reason:'fsmonitor removed; only branch tracking remains'}]);
 // 받아들인 뒤에 일꾼이 위험한 항목을 넣으면 예외는 더 이상 인정되지 않는다.
 f.begin();
 gitConfig(f,'alias.pwn','!sh -c evil');
 const again=f.finish(f.result());
 assert.equal(again.phase,'RECOVERY_REQUIRED');
 assert.ok(again.last_errors.some(e=>/Out of scope: \.git\/config/.test(e)),'the exception does not cover a command-running entry added later');
});
