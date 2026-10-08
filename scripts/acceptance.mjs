import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {git,hash} from './artifact.mjs';
import {workerEnv} from './worker-env.mjs';

// 수용 테스트: brief의 acceptance_commands를 컨트롤러가 직접 실행하고 종료 코드와 출력 해시를 남긴다.
// 증거가 "리드가 적어 넣은 기록"이 아니라 "실제 실행 결과"가 된다.
//
// 테스트를 돌린다는 것은 저장소 코드를 실행한다는 뜻이다. 스냅샷은 .gitignore된 파일 대부분을 보지 않으므로
// (node_modules/dep/index.js, dist/ 등) 일꾼이 그곳에 심은 코드가 컨트롤러 권한으로 실행될 수 있다(H2의 남은 부분).
// 그래서 실행 전에 무시된 파일 목록과 메타데이터를 라운드 시작 때와 비교하고, 바뀐 것이 있으면 자동 실행하지 않는다.
// 명령은 리드가 쓴 brief에서만 온다. 저장소 안의 설정 파일은 일꾼이 고칠 수 있으므로 명령 출처로 쓰지 않는다.

// 테스트가 만드는 산출물 중 실행되지 않는 것. 비교에서 뺀다. 실행될 수 있는 산출물(dist/, __pycache__ 등)은 넣지 않는다.
export const DEFAULT_ARTIFACTS=['coverage/**','.nyc_output/**','**/.pytest_cache/**','test-results/**','node_modules/.cache/**','**/*.log','.coverage','.coverage.*'];
export const MAX_IGNORED=200000;
const TAIL=4000;

export function globRegex(glob) {
 let re='';
 for(let i=0;i<glob.length;i++){
  const ch=glob[i];
  if(ch==='*'&&glob[i+1]==='*'){
   i++;
   if(glob[i+1]==='/'){i++;re+='(?:.*/)?';}else re+='.*';
  }
  else if(ch==='*')re+='[^/]*';
  else if(ch==='?')re+='[^/]';
  else re+=ch.replace(/[.+^${}()|[\]\\]/g,'\\$&');
 }
 return new RegExp('^'+re+'$');
}

// 무시된 파일의 목록과 메타데이터(크기, 수정·변경 시각, 모드, inode). 내용 해시는 node_modules 크기 때문에 쓰지 않는다.
// 변경 시각(ctime)은 utimes로 되돌릴 수 없어서 수정 시각만 되돌린 위장도 잡힌다.
export function ignoredManifest(root,artifacts=[]) {
 const skip=[...DEFAULT_ARTIFACTS,...artifacts].map(globRegex);
 const names=git(root,['ls-files','-z','--others','--ignored','--exclude-standard']).split('\0').filter(Boolean);
 if(names.length>MAX_IGNORED)return {overflow:true,count:names.length,files:{}};
 const files={};
 for(const name of names){
  if(name==='.fusion'||name.startsWith('.fusion/')||skip.some(r=>r.test(name)))continue;
  try{
   const st=fs.lstatSync(path.join(root,name));
   files[name]=`${st.isSymbolicLink()?'l':'f'}:${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.mode}:${st.ino}`;
  }catch(e){if(e.code!=='ENOENT')throw e;}
 }
 return {overflow:false,count:names.length,files};
}

export function ignoredChanges(a,b) {
 if(!a||!b||a.overflow||b.overflow)return ['(ignored files exceed the watch limit of '+MAX_IGNORED+')'];
 return [...new Set([...Object.keys(a.files),...Object.keys(b.files)])].filter(k=>a.files[k]!==b.files[k]).sort();
}

// 명령을 차례로 실행한다. 일꾼과 같은 걸러진 환경변수를 쓴다(리드의 비밀값을 테스트 코드에 넘기지 않는다).
// 바이트코드 캐시를 쓰지 않게 해서 실행 산출물이 무시된 파일 비교를 흔들지 않게 한다.
export function runCommands(root,commands,{timeout_ms=600000}={}) {
 const env={...workerEnv('acceptance'),CI:'1',PYTHONDONTWRITEBYTECODE:'1'};
 return commands.map(command=>{
  const started=Date.now();
  const r=spawnSync(command,{cwd:root,shell:true,env,timeout:timeout_ms,windowsHide:true,maxBuffer:64*1024*1024});
  const out=Buffer.concat([r.stdout??Buffer.alloc(0),r.stderr??Buffer.alloc(0)]);
  const timed_out=r.error?.code==='ETIMEDOUT';
  const text=out.toString('utf8');
  return {command,exit_code:r.status,signal:r.signal??null,timed_out,error:r.error&&!timed_out?r.error.message:null,
   status:r.status===0&&!r.error?'pass':'fail',duration_ms:Date.now()-started,
   output_sha256:hash(out),output_bytes:out.length,output_tail:text.length>TAIL?text.slice(-TAIL):text};
 });
}

// 실패한 명령을 다음 라운드 명령서(lead_feedback) 항목으로 바꾼다.
export function failureFeedback(results) {
 return results.filter(r=>r.status!=='pass').map(r=>{
  const why=r.timed_out?'timed out':r.error?`could not start (${r.error})`:`exited with ${r.exit_code}${r.signal?' / '+r.signal:''}`;
  return `Acceptance command \`${r.command}\` ${why}. Make it pass. Output tail:\n${r.output_tail.trim()||'(no output)'}`;
 });
}
