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
// 실제 출력 형식(이 PC의 Codex). 코드 2는 그대로 받은 것이고, 5는 같은 형식에 이슈의 오류 코드를 넣은 것이다.
const line=code=>`windows sandbox failed: CreateProcessAsUserW failed: ${code} (msg) | cwd=C:\\workspace | cmd=cmd.exe /c echo HF_SANDBOX_OK | env_u16_len=4228 | si_flags=256 | creation_flags=134743040`;
const DENIED=line(5);
// 이 PC에서 패키지판 pwsh로 실제로 나온 출력 그대로.
const MSIX_DENIED='windows sandbox failed: CreateProcessAsUserW failed: 5 (액세스가 거부되었습니다.) | cwd=C:\\Users\\seung | cmd=pwsh -NoProfile -Command "Write-Output HF_SANDBOX_OK" | env_u16_len=4059 | si_flags=256 | creation_flags=134743040';
// behavior는 대역 안에서 실행되는 코드다. target은 샌드박스 안에서 띄우라고 받은 셸이다.
// help가 'windows'면 `sandbox --help`에 windows 하위 명령을 내보이는 버전을 흉내 낸다.
function fakeCodex(t,behavior,{help=''}={}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hf-codex-sbx-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'codex.mjs');
 fs.writeFileSync(file,[
  `import fs from 'node:fs';`,
  `const a=process.argv.slice(2);`,
  `if(a.includes('--help')){console.log(${JSON.stringify(help==='windows'?'Commands:\n  macos\n  linux\n  windows  Run a command under the Windows sandbox':'Usage: codex sandbox [OPTIONS] [COMMAND]...')});process.exit(0);}`,
  `const s=a.indexOf('sandbox'),target=a[s+1]==='windows'?a[s+2]:a[s+1];`,
  `fs.appendFileSync(${JSON.stringify(path.join(dir,'calls.log'))},JSON.stringify(a)+'\\n');`,
  behavior].join('\n'));
 return {cli:{executable:process.execPath,prefix_args:[file]},calls:()=>fs.readFileSync(path.join(dir,'calls.log'),'utf8').trim().split('\n').map(l=>JSON.parse(l))};
}
const win={platform:'win32',env:{},shells:{pwsh:null}};

test('the self-test passes only when the sandboxed shell really printed the mark, in the syntax the installed Codex takes',t=>{
 const ok=fakeCodex(t,`console.log('HF_SANDBOX_OK');`);
 assert.deepEqual(windowsSandboxSelfTest(ok.cli,win),{status:'ok',checked:['cmd.exe','pwsh']});
 assert.deepEqual(ok.calls()[0].slice(0,2),['sandbox','cmd.exe'],'this version takes the command right after sandbox');
 const newer=fakeCodex(t,`console.log('HF_SANDBOX_OK');`,{help:'windows'});
 windowsSandboxSelfTest(newer.cli,win);
 assert.deepEqual(newer.calls()[0].slice(0,3),['sandbox','windows','cmd.exe'],'a version with a windows subcommand gets it');
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
 // 실측: cmd.exe는 뜨고 패키지판(MSIX) pwsh만 CreateProcessAsUserW failed: 5로 막혔다(codex-cli 0.162.0).
 const msix=fakeCodex(t,`if(target==='pwsh'){console.error(${JSON.stringify(MSIX_DENIED)});process.exit(1);}console.log('HF_SANDBOX_OK');`);
 const pwsh='C:\\Users\\seung\\AppData\\Local\\Microsoft\\WindowsApps\\Microsoft.PowerShell_8wekyb3d8bbwe\\pwsh.exe';
 assert.throws(()=>windowsSandboxSelfTest(msix.cli,{...win,shells:{pwsh}}),e=>{
  assert.match(e.message,/could not start pwsh \(C:.*Microsoft\.PowerShell_8wekyb3d8bbwe.*pwsh\.exe, the packaged Store\/MSIX build\)/);
  assert.match(e.message,/Remove-AppxPackage/);
  return true;
 });
 // pwsh를 PATH에서 못 찾아도 이름으로 점검하므로 막힌다(별칭은 파일 확인에서 놓칠 수 있다).
 assert.throws(()=>windowsSandboxSelfTest(msix.cli,win),/could not start pwsh inside/);
});

test('pwsh that is not installed is skipped, not counted as a failure',t=>{
 const absent=fakeCodex(t,`if(target==='pwsh'){console.error(${JSON.stringify(line(2))});process.exit(1);}console.log('HF_SANDBOX_OK');`);
 assert.deepEqual(windowsSandboxSelfTest(absent.cli,win),{status:'ok',checked:['cmd.exe']});
});

test('a launch that failed only because the program was not found does not block the worker',t=>{
 // 이 PC에서 실제로 나온 출력: 점검 문법이 버전과 안 맞아 "windows"를 프로그램으로 실행하려다 파일 없음(2)으로 끝났다.
 const notFound=fakeCodex(t,`console.error(${JSON.stringify(line(2))});process.exit(1);`);
 const r=windowsSandboxSelfTest(notFound.cli,win);
 assert.equal(r.status,'unverified');
 assert.match(r.reason,/CreateProcessAsUserW failed: 2/,'doctor shows what Codex said');
 assert.equal(SANDBOX_FAILURE.test(line(2)),false);
 assert.equal(SANDBOX_FAILURE.test(line(5)),true);
 assert.equal(SANDBOX_FAILURE.test(line(1312)),true);
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
 assert.deepEqual(seen.calls()[0].slice(0,3),['-c','windows.sandbox="unelevated"','sandbox'],'the self-test uses the same mode as the rounds');
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
