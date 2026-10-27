import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// POSIX와 Windows 차이를 여기 한 곳에 모은다.
export const isWin=process.platform==='win32';

const canon=p=>{let v;try{v=fs.realpathSync.native(p);}catch{v=path.resolve(p);}return isWin?v.toLowerCase():v;};
// Windows는 드라이브 문자 대소문자, 8.3 짧은 경로, 슬래시 방향이 달라도 같은 경로다.
export const samePath=(a,b)=>canon(a)===canon(b);
export const isMain=url=>!!process.argv[1]&&samePath(fileURLToPath(url),process.argv[1]);

const SCRIPT=/\.(c|m)?js$/i;
// .js/.mjs 진입점은 node로 실행하므로 실행 비트가 필요 없다.
const executable=f=>{try{if(!fs.statSync(f).isFile())return false;if(!isWin&&!SCRIPT.test(f))fs.accessSync(f,fs.constants.X_OK);return true;}catch{return false;}};

// npm이 만든 .cmd 래퍼에서 실제 진입점(.js 또는 .exe)을 꺼낸다.
// cmd.exe를 거치면 JSON 프롬프트의 따옴표·%·^가 깨지므로 래퍼를 직접 실행하지 않는다.
export function unwrapShim(file) {
 const text=fs.readFileSync(file,'utf8');
 const m=[...text.matchAll(/"%~?dp0%?\\([^"]+?\.(?:c?js|mjs|exe))"/gi)].at(-1);
 if(!m)return null;
 const target=path.join(path.dirname(file),...m[1].split(/[\\/]/));
 return fs.existsSync(target)?target:null;
}

// 실행 파일을 찾아 {executable, prefix_args}로 돌려준다. 스크립트 진입점은 현재 node로 실행한다.
export function resolveExecutable(name,binary) {
 const exts=isWin?[...(process.env.PATHEXT||'.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map(e=>e.toLowerCase()),'']:[''];
 const dirs=/[\\/]/.test(binary)?['']:(process.env.PATH||'').split(path.delimiter).filter(Boolean);
 let found;
 for(const d of dirs){for(const e of exts){const f=path.resolve(d,binary+e);if(executable(f)){found=f;break;}}if(found)break;}
 if(!found)throw Error(`ADAPTER_UNAVAILABLE: ${name} executable not found`);
 found=fs.realpathSync(found);
 if(SCRIPT.test(found))return {executable:process.execPath,prefix_args:[found]};
 if(isWin&&/\.(cmd|bat)$/i.test(found)){
  const target=unwrapShim(found);
  if(!target)throw Error(`ADAPTER_UNAVAILABLE: ${name} is a batch wrapper (${found}) whose entry point could not be found; set its HF_*_BIN to the .exe or the CLI's .js entry file`);
  return SCRIPT.test(target)?{executable:process.execPath,prefix_args:[target]}:{executable:target,prefix_args:[]};
 }
 return {executable:found,prefix_args:[]};
}

// 일꾼 프로세스 트리 종료. POSIX는 프로세스 그룹, Windows는 taskkill /T.
// Windows에서는 PID 재사용 위험 때문에 일꾼이 아직 살아 있을 때만 죽인다.
export function killTree(child,{force=false,alive=true}={}) {
 if(!child?.pid)return;
 if(isWin){
  if(!alive)return;
  try{execFileSync('taskkill',['/pid',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});}catch{}
  return;
 }
 try{process.kill(-child.pid,force?'SIGKILL':'SIGTERM');}catch(e){if(e.code!=='ESRCH')throw e;}
}

// Windows에서 백신·인덱서가 파일을 잡고 있으면 rename이 잠깐 EPERM/EBUSY로 실패한다.
export function renameWithRetry(from,to) {
 for(let i=0;;i++){
  try{fs.renameSync(from,to);return;}
  catch(e){if(!isWin||!['EPERM','EBUSY','EACCES'].includes(e.code)||i>=20)throw e;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);}
 }
}

// Node(libuv)가 Windows 명령줄을 만드는 방식대로 센다. 공백·따옴표가 있는 인자는 따옴표로 감싸고, 안의 "는 \"로,
// " 앞이나 끝에 오는 \는 두 배로 늘린다. JSON 프롬프트는 따옴표가 많아 글자 수만 세면 실제 길이보다 작게 나온다.
function quotedLength(arg) {
 const s=String(arg);
 if(!s)return 2;
 if(!/[\s"]/.test(s))return s.length;
 let n=s.length+2,slashes=0;
 for(const ch of s){
  if(ch==='\\'){slashes++;continue;}
  if(ch==='"')n+=slashes+1;
  slashes=0;
 }
 return n+slashes;
}
export const windowsCommandLineLength=(executable,args)=>[executable,...args].reduce((n,a,i)=>n+quotedLength(a)+(i?1:0),0);
export const WINDOWS_COMMAND_LINE_MAX=32000;
// Windows 명령줄은 32767자 제한이 있다. 프롬프트를 인자로 넘기는 일꾼은 미리 막는다.
// hint는 넘쳤을 때만 부르는 함수다. 무엇이 커졌고 어떻게 줄이는지 일꾼별로 알려 준다.
export function assertCommandLine(executable,args,{windows=isWin,hint=null}={}) {
 if(!windows)return;
 const length=windowsCommandLineLength(executable,args);
 if(length>WINDOWS_COMMAND_LINE_MAX)throw Error(`Command line too long for Windows (${length} chars, limit ${WINDOWS_COMMAND_LINE_MAX}); `+(hint?.()??'shorten the brief'));
}
