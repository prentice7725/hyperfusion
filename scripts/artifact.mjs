import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {samePath,renameWithRetry} from './platform.mjs';
import {assertPlainDir} from './control-dir.mjs';
export const hash = v => crypto.createHash('sha256').update(v).digest('hex');
// PowerShell 5.1의 Set-Content -Encoding utf8은 BOM을 붙인다. 입력 JSON의 BOM은 무시한다.
export const read = f => JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
export function atomic(f,v) {
  assertPlainDir(path.dirname(f));
  fs.mkdirSync(path.dirname(f),{recursive:true});
  assertPlainDir(path.dirname(f));
  const tmp=f+'.'+crypto.randomUUID()+'.tmp';
  const fd=fs.openSync(tmp,'wx',0o600);
  try { fs.writeFileSync(fd,JSON.stringify(v,null,2)+'\n'); fs.fsyncSync(fd); } finally {fs.closeSync(fd);}
  renameWithRetry(tmp,f);
}
export function immutable(f,v) {
  assertPlainDir(path.dirname(f));
  fs.mkdirSync(path.dirname(f),{recursive:true});
  assertPlainDir(path.dirname(f));
  fs.writeFileSync(f,JSON.stringify(v,null,2)+'\n',{flag:'wx',mode:0o600});
}
// 저장소의 .git/config는 일꾼이 고칠 수 있는 입력이다. core.fsmonitor나 filter.*.clean, diff 외부 도구가 설정돼 있으면
// 컨트롤러가 `git status`/`git diff`를 부르는 것만으로 그 명령이 컨트롤러 권한으로 실행된다. 그래서 컨트롤러의 git은
// 코드를 실행할 수 있는 설정을 모두 꺼서 부른다. 설정 파일을 읽는 것은 코드를 실행하지 않는다.
const RUNNABLE=/^(filter\.[^\n]+\.(clean|smudge|process)|diff\.[^\n]+\.(command|textconv)|merge\.[^\n]+\.driver)$/;
const NEUTRAL=['-c','core.fsmonitor=false','-c','core.pager=cat','-c','core.untrackedCache=false','-c','diff.external=','-c','core.sshCommand=false'];
const gitEnv={...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0',GIT_EXTERNAL_DIFF:'',GIT_PAGER:'cat'};
const cache=new Map();
function neutralArgs(root) {
 let stamp=null;
 try{const st=fs.statSync(path.join(root,'.git','config'));if(st.isFile())stamp=`${st.mtimeMs}:${st.size}`;}catch{}
 const hit=cache.get(root);
 if(stamp&&hit?.stamp===stamp)return hit.args;
 const args=[...NEUTRAL];
 try{
  const out=execFileSync('git',[...NEUTRAL,'-C',root,'config','-z','--get-regexp','^(filter|diff|merge)\\.'],{encoding:'utf8',env:gitEnv,windowsHide:true,stdio:['ignore','pipe','ignore']});
  for(const entry of out.split('\0').filter(Boolean)){
   const key=entry.split('\n')[0];
   if(!RUNNABLE.test(key))continue;
   args.push('-c',`${key}=`);
   if(key.startsWith('filter.'))args.push('-c',key.replace(/\.[^.]+$/,'.required')+'=false');
  }
 }catch{/* 일치하는 설정이 없으면 git이 1로 끝난다 */}
 if(stamp)cache.set(root,{stamp,args});
 return args;
}
export function git(root,args) {return execFileSync('git',[...neutralArgs(root),'-C',root,...args],{encoding:'utf8',maxBuffer:64*1024*1024,env:gitEnv,windowsHide:true});}
// 사람이 읽는 diff는 외부 diff 도구와 textconv를 쓰지 않는다.
export const SAFE_DIFF=['--no-ext-diff','--no-textconv'];
export function repo(input) {
 const root=fs.realpathSync.native(git(input,['rev-parse','--show-toplevel']).trim());
 if(!samePath(input,root)) throw Error('Use repository root');
 return root;
}
const MAX_GUARD_BYTES=8*1024*1024;
const entryOf=f=>{
 const st=fs.lstatSync(f);
 if(st.isDirectory())return null;
 if(st.isSymbolicLink())return {kind:'symlink',mode:st.mode&0o777,sha256:hash(fs.readlinkSync(f))};
 // 아주 큰 파일은 내용 대신 크기와 수정 시각으로 본다(훅이나 설정이 그렇게 클 수는 없다).
 return {kind:'file',mode:st.mode&0o777,sha256:st.size>MAX_GUARD_BYTES?hash(`${st.size}:${st.mtimeMs}`):hash(fs.readFileSync(f))};
};
const walk=(dir,limit=5000)=>{
 const out=[];
 const visit=d=>{
  let items;try{items=fs.readdirSync(d,{withFileTypes:true});}catch{return;}
  for(const it of items){if(out.length>=limit)return;const p=path.join(d,it.name);if(it.isDirectory())visit(p);else out.push(p);}
 };
 visit(dir);
 return out;
};

// git이 무시하는 곳이나 .git 안에 심어 두면 나중에 사람이나 도구가 실행하는 파일들. 스냅샷에 항상 넣는다.
// - .git/config, .git/hooks/*, .git/info/*: 훅과 설정(다음 commit, status 때 코드가 실행된다)
// - .env*, .npmrc, .yarnrc*: 비밀값과 패키지 설치 설정
// - node_modules/.bin/*: 테스트나 빌드가 실행하는 실행 파일
// - .husky, .githooks, .vscode: 훅과 에디터 자동 실행 작업
export function guardFiles(root) {
 const out={};
 const add=(file,key)=>{try{const e=entryOf(file);if(e)out[key]=e;}catch(e){if(e.code!=='ENOENT')throw e;}};
 let common=null;
 try{common=path.resolve(root,git(root,['rev-parse','--git-common-dir']).trim());}catch{}
 if(common){
  for(const f of ['config','config.worktree','info/exclude','info/attributes'])add(path.join(common,f),`.git/${f}`);
  for(const f of walk(path.join(common,'hooks')))add(f,'.git/'+path.relative(common,f).split(path.sep).join('/'));
 }
 const rel=f=>path.relative(root,f).split(path.sep).join('/');
 let top=[];try{top=fs.readdirSync(root);}catch{}
 for(const name of top)if(/^\.env(\..*)?$/.test(name)||['.npmrc','.yarnrc','.yarnrc.yml','.pnpmfile.cjs'].includes(name))add(path.join(root,name),name);
 for(const dir of ['.husky','.githooks','.vscode','node_modules/.bin'])for(const f of walk(path.join(root,dir)))add(f,rel(f));
 return out;
}

export function snapshot(root) {
 const files={};
 const names=[...new Set(git(root,['ls-files','-z','--cached','--others','--exclude-standard']).split('\0').filter(Boolean))].sort();
 for(const name of names) {
   if(name==='.fusion'||name.startsWith('.fusion/')) continue;
   const f=path.join(root,name);
   try {
     const st=fs.lstatSync(f);
     if(st.isDirectory()) throw Error('Submodules/directories unsupported by M0: '+name);
     files[name]={kind:st.isSymbolicLink()?'symlink':'file',mode:st.mode&0o777,sha256:hash(st.isSymbolicLink()?fs.readlinkSync(f):fs.readFileSync(f))};
   } catch(e) {if(e.code==='ENOENT') files[name]=null;else throw e;}
 }
 Object.assign(files,guardFiles(root));
 const head=git(root,['rev-parse','HEAD']).trim();
 const status=git(root,['status','--porcelain=v1','-z','--untracked-files=all','--','.',':(exclude).fusion']);
 const index_hash=hash(git(root,['ls-files','--stage','-z']));
 return {head,status,index_hash,files,digest:hash(JSON.stringify({head,status,index_hash,files}))};
}
export function changes(a,b) {
 return [...new Set([...Object.keys(a.files),...Object.keys(b.files)])].filter(k=>JSON.stringify(a.files[k]??null)!==JSON.stringify(b.files[k]??null)).sort();
}

// 저장소 설정 중 명령을 실행할 수 있는 항목과 활성 훅을 알려 준다(실행 전 점검용 경고).
// 컨트롤러의 git 호출은 이 항목들을 꺼서 부르지만, 사람이 같은 저장소에서 git을 쓰면 그대로 실행된다.
export function riskyGitConfig(root) {
 const found=[];
 let out='';
 try{out=execFileSync('git',[...NEUTRAL,'-C',root,'config','-z','--local','--list'],{encoding:'utf8',env:gitEnv,windowsHide:true,stdio:['ignore','pipe','ignore']});}catch{}
 for(const entry of out.split('\0').filter(Boolean)){
  const [key,...rest]=entry.split('\n'),value=rest.join('\n');
  if(/^core\.(fsmonitor|hookspath|sshcommand|editor|pager)$/i.test(key)&&value&&value!=='false')found.push(`${key}=${value.slice(0,80)}`);
  else if(/^(filter\.[^.]+\.(clean|smudge|process)|diff\.[^.]+\.(command|textconv)|merge\.[^.]+\.driver)$/i.test(key))found.push(`${key}=${value.slice(0,80)}`);
  else if(/^alias\./i.test(key)&&value.startsWith('!'))found.push(`${key}=${value.slice(0,80)}`);
  else if(/^include(if\.[^.]+)?\.path$/i.test(key))found.push(`${key}=${value.slice(0,80)}`);
 }
 for(const [key] of Object.entries(guardFiles(root)))if(/^\.git\/hooks\//.test(key)&&!key.endsWith('.sample'))found.push(`active hook ${key}`);
 return found;
}
