import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {windowsSandboxSelfTest,windowsSandboxArgs,sandboxArgs,SANDBOX_FAILURE} from '../scripts/codex-sandbox.mjs';
import {luna,parseEvents,diagnose} from '../scripts/adapters/codex.mjs';
import {NON_RETRYABLE} from '../scripts/delegation.mjs';

// Codex의 Windows 샌드박스가 셸을 띄우지 못하는 문제(CreateProcessAsUserW failed: 5). 실제 Windows가 아니므로
// 대역 codex로 `codex sandbox windows ...`의 성공·실패를 흉내 내고, 판정 로직만 확인한다.
const DENIED='windows sandbox: runner error: CreateProcessAsUserW failed: 5';
// behavior는 대역 안에서 실행되는 코드다. target은 샌드박스 안에서 띄우라고 받은 셸이다.
function fakeCodex(t,behavior) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hf-codex-sbx-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'codex.mjs');
 fs.writeFileSync(file,[
  `import fs from 'node:fs';`,
  `const a=process.argv.slice(2),target=a[a.indexOf('sandbox')+2]??'';`,
  `fs.appendFileSync(${JSON.stringify(path.join(dir,'calls.log'))},JSON.stringify(a)+'\\n');`,
  behavior].join('\n'));
 return {cli:{executable:process.execPath,prefix_args:[file]},calls:()=>fs.readFileSync(path.join(dir,'calls.log'),'utf8').trim().split('\n').map(l=>JSON.parse(l))};
}
const win={platform:'win32',env:{},shells:{pwsh:null}};

test('the self-test passes only when the sandboxed shell really printed the mark',t=>{
 const ok=fakeCodex(t,`console.log('HF_SANDBOX_OK');`);
 assert.deepEqual(windowsSandboxSelfTest(ok.cli,win),{status:'ok',checked:['cmd.exe']});
 assert.deepEqual(ok.calls()[0].slice(0,3),['sandbox','windows','cmd.exe']);
 assert.equal(windowsSandboxSelfTest(ok.cli,{...win,platform:'linux'}).status,'skipped','only Windows has this sandbox');
});

test('an access-denied launch blocks the worker with the cause and the way out',t=>{
 const bad=fakeCodex(t,`console.error(${JSON.stringify(DENIED)});console.error('cmd.exe /c echo HF_SANDBOX_OK');process.exit(1);`);
 assert.throws(()=>windowsSandboxSelfTest(bad.cli,win),e=>{
  assert.match(e.message,/^ADAPTER_UNAVAILABLE: CODEX_WINDOWS_SANDBOX: Codex could not start cmd\.exe inside its Windows sandbox/);
  assert.match(e.message,/HF_CODEX_WINDOWS_SANDBOX=unelevated/);
  assert.ok(NON_RETRYABLE.test(e.message),'automatic recovery must not retry it');
  return true;
 },'the echoed command line in the error is not mistaken for success');
 // cmd.exe는 되지만 Store판 pwsh가 막히는 경우
 const store=fakeCodex(t,`if(target.includes('WindowsApps')){console.error(${JSON.stringify(DENIED)});process.exit(1);}console.log('HF_SANDBOX_OK');`);
 const pwsh='C:\\\\Program Files\\\\WindowsApps\\\\Microsoft.PowerShell_7\\\\pwsh.exe';
 assert.throws(()=>windowsSandboxSelfTest(store.cli,{...win,shells:{pwsh}}),/could not start .*pwsh\.exe \(this pwsh is the Microsoft Store build\)/);
});

test('when the result cannot be judged the worker is not blocked',t=>{
 const old=fakeCodex(t,`console.error("error: unrecognized subcommand 'sandbox'");process.exit(2);`);
 const r=windowsSandboxSelfTest(old.cli,win);
 assert.equal(r.status,'unverified');
 assert.match(r.reason,/gave no result/);
});

test('the operator chooses the Windows sandbox mode; anything else is refused',t=>{
 assert.deepEqual(windowsSandboxArgs({}),[]);
 assert.deepEqual(windowsSandboxArgs({HF_CODEX_WINDOWS_SANDBOX:'unelevated'}),['-c','windows.sandbox="unelevated"']);
 assert.throws(()=>windowsSandboxArgs({HF_CODEX_WINDOWS_SANDBOX:'off'}),/must be elevated or unelevated/);
 // 읽기 전용 상담·리뷰도 같은 샌드박스로 셸을 띄운다
 assert.deepEqual(sandboxArgs({consult:true},{HF_CODEX_WINDOWS_SANDBOX:'unelevated'}),['-c','windows.sandbox="unelevated"']);
 const seen=fakeCodex(t,`console.log('HF_SANDBOX_OK');`);
 windowsSandboxSelfTest(seen.cli,{...win,env:{HF_CODEX_WINDOWS_SANDBOX:'unelevated'}});
 assert.deepEqual(seen.calls()[0].slice(0,4),['-c','windows.sandbox="unelevated"','sandbox','windows'],'the self-test uses the same mode as the rounds');
});

const events=(...items)=>[{type:'thread.started',thread_id:'th_1'},...items,
 {type:'item.completed',item:{type:'agent_message',text:JSON.stringify({task_id:'T',round:1,status:'blocked'})}},
 {type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}].map(e=>JSON.stringify(e)).join('\n');

test('a round whose commands the sandbox refused fails with the cause, instead of a quiet "could not do it"',()=>{
 const denied=events({type:'item.completed',item:{type:'command_execution',command:'pwsh -c "npm test"',aggregated_output:DENIED,exit_code:-1,status:'failed'}});
 assert.throws(()=>parseEvents(denied,{cli:{}}),e=>/^CODEX_WINDOWS_SANDBOX: .*CreateProcessAsUserW failed: 5/.test(e.message)&&NON_RETRYABLE.test(e.message));
 // 일꾼이 글로만 언급한 것은 실패가 아니다
 const mentioned=events({type:'item.completed',item:{type:'agent_message',text:'note: windows sandbox: setup refresh failed is a known issue'}});
 assert.doesNotThrow(()=>parseEvents(mentioned,{cli:{}}));
 assert.match(diagnose('',`error: ${DENIED}`),/CODEX_WINDOWS_SANDBOX/);
 assert.equal(diagnose('ok','fine'),null);
 assert.ok(SANDBOX_FAILURE.test('Rejected("Failed to create unified exec process: helper_unknown_error: setup refresh had errors")'));
});

test('off Windows the preflight costs nothing and never blocks',()=>{
 if(process.platform==='win32')return;
 assert.deepEqual(luna.preflight({root:process.cwd()}),{status:'skipped',reason:'not Windows'});
});
