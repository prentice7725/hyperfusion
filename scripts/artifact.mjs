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
const RUNNABLE=/^(filter\.[^\n]+\.(clean|smudge|process)|diff\.[^\n]+\.(command|textconv)|merge\.[^\n]+\.driver)$/i;
const NEUTRAL=['-c','core.fsmonitor=false','-c','core.pager=cat','-c','core.untrackedCache=false','-c','diff.external=','-c','core.sshCommand=false'];
const gitEnv={...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0',GIT_EXTERNAL_DIFF:'',GIT_PAGER:'cat'};
// Git applies includes, conditional includes and worktree config to normal commands.
// Read that same effective configuration, not just the main .git/config. A parent
// file's mtime/size cannot invalidate a changed include or worktree-local setting.
// Re-read before each Git invocation, or once per synchronous snapshot (pinGitConfig);
// configuration errors must fail closed.
function effectiveConfig(root) {
 try{
  const fields=execFileSync('git',[...NEUTRAL,'-C',root,'config','--show-scope','--includes','-z','--list'],{encoding:'utf8',maxBuffer:64*1024*1024,env:gitEnv,windowsHide:true,stdio:['ignore','pipe','ignore']}).split('\0');
  if(fields.pop()!==''||fields.length%2)throw Error('Invalid config inventory');
  const entries=[];
  for(let i=0;i<fields.length;i+=2)entries.push({scope:fields[i],entry:fields[i+1]});
  return entries;
 }catch(cause){throw Error('GIT_CONFIG_UNREADABLE: cannot inspect effective Git configuration',{cause});}
}
function neutralArgs(root) {
 const args=[...NEUTRAL];
 for(const {entry} of effectiveConfig(root)){
  const key=entry.split('\n')[0];
  if(!RUNNABLE.test(key))continue;
  args.push('-c',`${key}=`);
  if(/^filter\./i.test(key))args.push('-c',key.replace(/\.[^.]+$/,'.required')+'=false');
 }
 return args;
}
// 한 번의 동기 읽기 묶음(snapshot)은 설정을 한 번만 읽어 그 안의 git 호출에 같이 쓴다. 묶음 안에서는 설정을 끈 git과
// 파일 읽기만 돌고 일꾼·수용 명령 같은 저장소 코드는 돌지 않는다. 묶음이 끝나면 버리므로 다음 호출은 다시 읽는다.
let pinned=null;
function pinGitConfig(root,read) {
 if(pinned)return read();
 pinned={root,args:neutralArgs(root)};
 try{return read();}finally{pinned=null;}
}
export function git(root,args) {return execFileSync('git',[...(pinned?.root===root?pinned.args:neutralArgs(root)),'-C',root,...args],{encoding:'utf8',maxBuffer:64*1024*1024,env:gitEnv,windowsHide:true});}
// 사람이 읽는 diff는 외부 diff 도구와 textconv를 쓰지 않는다.
export const SAFE_DIFF=['--no-ext-diff','--no-textconv'];
// 한 프로세스 안에서 같은 저장소를 수없이 확인한다(run, execute, autopilot이 매번 부른다). 성공한 확인만 기억하되,
// 루트 바로 아래 `.git` 항목(종류, 장치, inode, 파일이면 크기·mtime)이 그대로일 때만 다시 쓴다. `.git`을 지우거나
// 바꿔치면 지문이 달라져 git으로 다시 확인한다. 디렉터리의 mtime은 git이 쓸 때마다 변하므로 지문에 넣지 않는다.
const repoCache=new Map();
function gitEntryStamp(real) {
 try{
  const st=fs.lstatSync(path.join(real,'.git'));
  return [st.isDirectory()?'d':st.isFile()?'f':'x',st.dev,st.ino,...(st.isFile()?[st.size,st.mtimeMs]:[])].join(':');
 }catch{return null;}
}
export function repo(input) {
 let real=null,stamp=null;
 try{real=fs.realpathSync.native(input);stamp=gitEntryStamp(real);}catch{}
 const hit=real&&stamp?repoCache.get(real):null;
 if(hit&&hit.stamp===stamp&&samePath(input,hit.root))return hit.root;
 const root=fs.realpathSync.native(git(input,['rev-parse','--show-toplevel']).trim());
 if(!samePath(input,root)) throw Error('Use repository root');
 if(real&&stamp)repoCache.set(real,{stamp,root});
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
// - .agents, .agent, _agents, _agent: agy가 workspace에서 읽는 hooks.json과 skills(라운드 중에 명령이 실행된다)
export const AGENT_DIRS=['.agents','.agent','_agents','_agent'];
// 저장소에 들어 있는 agy 훅·스킬. agy는 라운드마다 이것을 읽어 실행하므로, 저장소 내용이 일꾼 실행 중 명령을 돌릴 수 있다.
export function agentCustomizations(root) {
 const out=[];
 for(const dir of AGENT_DIRS){
  for(const name of ['hooks.json','skills']){
   const rel=`${dir}/${name}`;
   try{fs.lstatSync(path.join(root,rel));out.push(rel);}catch{}
  }
 }
 return out;
}
export function guardFiles(root,common,gitDir) {
 const out={};
 const add=(file,key)=>{try{const e=entryOf(file);if(e)out[key]=e;}catch(e){if(e.code!=='ENOENT')throw e;}};
 // snapshot passes both directories from its single rev-parse. A linked worktree
 // has its own config.worktree under --git-dir, outside --git-common-dir.
 if(common===undefined||gitDir===undefined){
  const dirs=git(root,['rev-parse','--git-common-dir','--git-dir']).split('\n').map(line=>line.replace(/\r$/,''));
  common=path.resolve(root,dirs[0]);gitDir=path.resolve(root,dirs[1]);
 }
 if(common){
  for(const f of ['config','info/exclude','info/attributes'])add(path.join(common,f),`.git/${f}`);
  add(path.join(common,'config.worktree'),samePath(common,gitDir)?'.git/config.worktree':'.git/common/config.worktree');
  if(!samePath(common,gitDir))add(path.join(gitDir,'config.worktree'),'.git/config.worktree');
  for(const f of walk(path.join(common,'hooks')))add(f,'.git/'+path.relative(common,f).split(path.sep).join('/'));
 }
 const rel=f=>path.relative(root,f).split(path.sep).join('/');
 // 자기 자신까지 무시하는 .gitignore도 감시한다. 숨긴 테스트 코드가 비교에서 사라지는 것을 막는다.
 const ignores=git(root,['ls-files','-z','--others','--ignored','--exclude-standard','--','.gitignore','**/.gitignore']).split('\0').filter(Boolean);
 for(const name of ignores)add(path.join(root,name),name);
 let top=[];try{top=fs.readdirSync(root);}catch{}
 for(const name of top)if(/^\.env(\..*)?$/.test(name)||['.npmrc','.yarnrc','.yarnrc.yml','.pnpmfile.cjs'].includes(name))add(path.join(root,name),name);
 for(const dir of ['.husky','.githooks','.vscode',...AGENT_DIRS,'node_modules/.bin'])for(const f of walk(path.join(root,dir)))add(f,rel(f));
 return out;
}

// HEAD, common Git directory and the active worktree directory in one call.
function headAndCommon(root) {
 try{
  const [head,common,gitDir]=git(root,['rev-parse','HEAD','--git-common-dir','--git-dir']).split('\n').map(line=>line.replace(/\r$/,''));
  if(head&&common&&gitDir)return {head,common:path.resolve(root,common),gitDir:path.resolve(root,gitDir)};
 }catch{}
 return {head:git(root,['rev-parse','HEAD']).trim(),common:undefined};
}

export function snapshot(root) {return pinGitConfig(root,()=>readSnapshot(root));}
function readSnapshot(root) {
 const files={};
 const {head,common:gitCommon,gitDir}=headAndCommon(root);
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
 Object.assign(files,guardFiles(root,gitCommon,gitDir));
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
 let entries;
 try{entries=effectiveConfig(root);}catch{return ['git config unreadable (GIT_CONFIG_UNREADABLE)'];}
 // Scope exceptions concern repository-owned configuration. Global/system
 // defaults (e.g. installed Git LFS) are still neutralized for controller calls,
 // but must not prohibit accepting an unrelated local branch-tracking change.
 for(const {scope,entry} of entries){
  if(!['local','worktree'].includes(scope))continue;
  const [key,...rest]=entry.split('\n'),value=rest.join('\n');
  if(/^core\.(fsmonitor|hookspath|sshcommand|editor|pager)$/i.test(key)&&value&&value!=='false')found.push(`${key}=${value.slice(0,80)}`);
  else if(RUNNABLE.test(key))found.push(`${key}=${value.slice(0,80)}`);
  else if(/^alias\./i.test(key)&&value.startsWith('!'))found.push(`${key}=${value.slice(0,80)}`);
  else if(/^(include|includeif\.[^\n]+)\.path$/i.test(key))found.push(`${key}=${value.slice(0,80)}`);
 }
 for(const [key] of Object.entries(guardFiles(root)))if(/^\.git\/hooks\//.test(key)&&!key.endsWith('.sample'))found.push(`active hook ${key}`);
 return found;
}
