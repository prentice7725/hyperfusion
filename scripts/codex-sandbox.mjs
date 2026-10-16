import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {git} from './artifact.mjs';
import {stateHome} from './control-dir.mjs';
import {spawnSync} from 'node:child_process';
import {workerEnv} from './worker-env.mjs';

// Resolve existing ancestors too: protected directories need not exist yet.
export function canonicalPath(input) {
 let target=path.resolve(input),tail=[];
 while(!fs.existsSync(target)) {tail.unshift(path.basename(target));const up=path.dirname(target);if(up===target)break;target=up;}
 // Native realpath expands Windows 8.3 names as well as junction targets.
 // Git can report a long common-dir while TEMP still uses RUNNER~1.
 const real=path.join(fs.realpathSync.native(target),...tail);
 return process.platform==='win32'?real.toLowerCase():real;
}
const contains=(a,b)=>{const rel=path.relative(a,b);return rel===''||(!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep));};
export function protectedRoots(repoRoot,env=process.env) {
 const home=os.homedir();
 const roots=[stateHome(),env.HF_STATE_DIR,path.join(home,'.hyperfusion','state'),path.join(home,'.claude'),path.join(home,'.codex'),
  env.CODEX_HOME,env.CLAUDE_CONFIG_DIR,env.HF_SKILL,process.env.CODEX_HOME,process.env.CLAUDE_CONFIG_DIR,process.env.HF_SKILL,
  path.resolve(fileURLToPath(new URL('..',import.meta.url)))].filter(Boolean);
 if(repoRoot){
  roots.push(path.join(repoRoot,'.git'),path.join(repoRoot,'.fusion'));
  roots.push(...git(repoRoot,['rev-parse','--git-common-dir','--git-dir']).trim().split(/\r?\n/).map(p=>path.resolve(repoRoot,p)));
 }
 return roots.map(canonicalPath);
}
// Operator environment only: repository config/worker output cannot widen it.
export function sandboxArgs({consult=false,repoRoot}={},env=process.env) {
 if(consult)return windowsSandboxArgs(env);
 const args=[...windowsSandboxArgs(env)];
 if(env.HF_CODEX_WRITABLE_ROOTS!==undefined){
  let roots;try{roots=JSON.parse(env.HF_CODEX_WRITABLE_ROOTS);}catch{throw Error('CODEX_SANDBOX: writable roots must be a JSON array');}
  if(!Array.isArray(roots)||roots.length>20||roots.some(r=>typeof r!=='string'||!path.isAbsolute(r)||!fs.existsSync(r)||!fs.statSync(r).isDirectory()))throw Error('CODEX_SANDBOX: writable roots must be existing absolute directories');
  const resolved=[...new Set(roots.map(r=>fs.realpathSync.native(r)))];
  if(resolved.some(r=>r===path.parse(r).root))throw Error('CODEX_SANDBOX: filesystem root cannot be writable');
  const protectedPaths=protectedRoots(repoRoot,env);
  if(resolved.some(r=>protectedPaths.some(p=>contains(canonicalPath(r),p)||contains(p,canonicalPath(r)))))throw Error('CODEX_SANDBOX: writable root overlaps protected control, skill, Git or CLI configuration paths');
  args.push('-c','sandbox_workspace_write.writable_roots='+JSON.stringify(resolved));
 }
 if(env.HF_CODEX_NETWORK_ACCESS!==undefined){
  if(!['0','1'].includes(env.HF_CODEX_NETWORK_ACCESS))throw Error('CODEX_SANDBOX: network access must be 0 or 1');
  args.push('-c','sandbox_workspace_write.network_access='+(env.HF_CODEX_NETWORK_ACCESS==='1'));
 }
 return args;
}

// ── Windows 샌드박스 ─────────────────────────────────────────────────────────
// Codex는 Windows에서 셸 명령과 파일 수정을 전용 샌드박스 사용자로 실행한다. 그 사용자로 프로세스를 띄우지 못하면
// (CreateProcessAsUserW failed: 5 등) 라운드 전체가 아무것도 못 하고 끝난다. Store판 pwsh(WindowsApps)나
// elevated 샌드박스 준비 단계(setup refresh) 실패가 흔한 원인이다(openai/codex #28730, #35871, #9062, #10601, #50772).
// 막는 것은 권한 거부(5 ERROR_ACCESS_DENIED, 1312)와 샌드박스 준비 단계 실패뿐이다. 실제 Windows 출력 예:
//   windows sandbox failed: CreateProcessAsUserW failed: 2 (지정된 파일을 찾을 수 없습니다.) | cwd=... | cmd=...
// 2(파일 없음)는 실행할 프로그램을 못 찾은 것이라 샌드박스가 막았다는 증거가 아니다(점검 문법이 버전과 안 맞을 때도 나온다).
// 5·1312·setup refresh 문구는 openai/codex 이슈에서 가져왔고 이 PC의 출력으로 확인한 것은 2뿐이다.
export const SANDBOX_FAILURE=/CreateProcess(?:AsUser|WithLogon)W failed: (?:5|1312)\b|setup refresh (?:failed|had errors)|helper_unknown_error/i;
const SANDBOX_ERROR=/windows sandbox(?: failed)?:.*/i;
export const WINDOWS_SANDBOX_ENV='HF_CODEX_WINDOWS_SANDBOX';
export const SANDBOX_HINT=`If the shell is the Microsoft Store PowerShell (a path under WindowsApps), install PowerShell from the MSI or winget instead. `
 +`Or the operator may set ${WINDOWS_SANDBOX_ENV}=unelevated (weaker isolation; the controller still checks scope) and retry. Retrying unchanged fails the same way; use another worker meanwhile`;

// 운영자 환경변수로만 고른다(저장소 설정·일꾼 출력으로는 바꾸지 못한다). 읽기 전용 상담·리뷰도 같은 샌드박스로 셸을 띄우므로 모두에 적용한다.
export function windowsSandboxArgs(env=process.env) {
 const v=env[WINDOWS_SANDBOX_ENV];
 if(v===undefined||v==='')return [];
 if(!['elevated','unelevated'].includes(v))throw Error(`CODEX_SANDBOX: ${WINDOWS_SANDBOX_ENV} must be elevated or unelevated`);
 return ['-c',`windows.sandbox="${v}"`];
}

const MARK='HF_SANDBOX_OK';
// PATH에서 pwsh.exe를 찾는다. Codex가 이 셸을 쓰면 cmd.exe가 되는 것만으로는 부족하다.
function findPwsh(env) {
 for(const dir of String(env.PATH??env.Path??'').split(path.delimiter).filter(Boolean)){
  const f=path.join(dir,'pwsh.exe');
  try{if(fs.statSync(f).isFile())return f;}catch{}
 }
 return null;
}
// 모델을 부르지 않고 `codex sandbox windows <셸> ...`로 샌드박스 안에서 프로세스가 뜨는지 본다.
// 실패 문구가 보일 때만 막는다. 하위 명령이 없거나 시간이 초과되는 등 판단할 수 없으면 unverified로 두고 막지 않는다.
// 하위 명령 문법이 버전마다 다르다: `codex sandbox <명령>`(이 PC의 버전) 또는 `codex sandbox windows <명령>`.
// 잘못 고르면 "windows"를 실행할 프로그램으로 받아 파일 없음(2)으로 끝난다. 도움말에 windows 하위 명령이 있을 때만 붙인다.
function sandboxCommand(cli,env) {
 const r=spawnSync(cli.executable,[...(cli.prefix_args??[]),'sandbox','--help'],{encoding:'utf8',timeout:15000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe'],windowsHide:true,env:workerEnv('luna',env)});
 return /^\s+windows\b/m.test(`${r.stdout??''}\n${r.stderr??''}`)?['sandbox','windows']:['sandbox'];
}
export function windowsSandboxSelfTest(cli,{root,platform=process.platform,env=process.env,shells}={}) {
 if(platform!=='win32')return {status:'skipped',reason:'not Windows'};
 const pwsh=shells?shells.pwsh:findPwsh(env);
 const command=sandboxCommand(cli,env);
 const targets=[['cmd.exe','/c','echo',MARK],...(pwsh?[[pwsh,'-NoProfile','-Command','Write-Output '+MARK]]:[])];
 const checked=[];
 for(const target of targets){
  const r=spawnSync(cli.executable,[...(cli.prefix_args??[]),...windowsSandboxArgs(env),...command,...target],
   {cwd:root,encoding:'utf8',timeout:30000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe'],windowsHide:true,env:workerEnv('luna',env)});
  const out=`${r.stdout??''}\n${r.stderr??''}`;
  const failure=out.split(/\r?\n/).find(l=>SANDBOX_FAILURE.test(l));
  if(failure){
   const store=/[\\/]WindowsApps[\\/]/i.test(target[0])?' (this pwsh is the Microsoft Store build)':'';
   throw Error(`ADAPTER_UNAVAILABLE: CODEX_WINDOWS_SANDBOX: Codex could not start ${target[0]}${store} inside its Windows sandbox (access denied: "${failure.trim().slice(0,200)}"). ${SANDBOX_HINT}`);
  }
  if(!out.split(/\r?\n/).some(l=>l.trim()===MARK)){
   const said=out.match(SANDBOX_ERROR)?.[0];
   return {status:'unverified',reason:`codex ${command.join(' ')} ${target[0]} gave no result (${said?said.slice(0,200):r.error?.code??'exit '+r.status})`,checked};
  }
  checked.push(target[0]);
 }
 return {status:'ok',checked};
}
