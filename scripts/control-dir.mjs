import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {isWin} from './platform.mjs';
import {printError} from './cli.mjs';

// 제어 파일(상태, brief, 스냅샷, lease, 지표)이 사는 곳.
//
// 일꾼의 편집 도구는 작업 폴더 안만 건드릴 수 있다. 제어 파일이 작업 폴더 안(.fusion/)에 있으면 일꾼이
// brief의 범위를 넓히거나 기준선을 고쳐 컨트롤러의 판정을 바꿀 수 있다. 그래서 기본 위치는 작업 폴더 밖이다.
//
//   기본            ~/.hyperfusion/state/<저장소 이름>-<경로 해시>/
//   HF_STATE_DIR    위의 부모 폴더를 바꾼다.
//   레거시          예전 버전이 만든 <저장소>/.fusion/ 이 있으면 migrate 전까지 그대로 쓴다(새 작업은 막는다).

const sha256=v=>crypto.createHash('sha256').update(v).digest('hex');

export const stateHome=()=>process.env.HF_STATE_DIR||path.join(os.homedir(),'.hyperfusion','state');

// 저장소를 가리키는 안정적인 이름. 같은 저장소는 어디서 불러도(대소문자, 심볼릭 링크 포함) 같은 이름이다.
export function repoId(root) {
  const real=fs.realpathSync.native(root);
  const canonical=isWin?real.toLowerCase():real;
  const name=path.basename(real).replace(/[^A-Za-z0-9._-]/g,'_').slice(0,40)||'repo';
  return `${name}-${sha256(canonical).slice(0,12)}`;
}

export const legacyDir=root=>path.join(root,'.fusion');
const externalDir=root=>path.join(stateHome(),repoId(root));

// 레거시 폴더에 예전 기록이 있는가(빈 locks 폴더만 있는 것은 기록으로 치지 않는다).
const hasLegacyRecords=root=>['state.json','project.json','tasks','locks/writer.json','locks/control.lock']
  .some(f=>fs.existsSync(path.join(legacyDir(root),f)));

export function controlRoot(root) {
  const external=externalDir(root);
  if(fs.existsSync(external))return external;
  return hasLegacyRecords(root)?legacyDir(root):external;
}
export const isLegacy=root=>controlRoot(root)===legacyDir(root);
export const controlPath=(root,...parts)=>path.join(controlRoot(root),...parts);

// 제어 폴더 안의 하위 폴더(tasks, metrics 등)도 심볼릭 링크로 바꿔치기돼 있으면 쓰지 않는다. 쓰기 전에 부르는 단일 검사다.
export function assertPlainDir(dir) {
  // 폴더와 그 부모(tasks/<task>의 tasks)를 본다. 더 위는 제어 폴더 자체이고, 그건 ensureControl이 확인한다.
  for(const d of [dir,path.dirname(dir)]){
    let st;
    try{st=fs.lstatSync(d);}catch(e){if(e.code==='ENOENT')continue;throw e;}
    if(st.isSymbolicLink())throw Error('Symlink protocol directory forbidden: '+d);
  }
}

// 제어 폴더를 만들고(없으면) 심볼릭 링크가 아닌지 확인한다. 쓰는 쪽은 모두 이걸 거친다.
export function ensureControl(root) {
  const dir=controlRoot(root);
  assertPlainDir(dir);
  fs.mkdirSync(path.join(dir,'locks'),{recursive:true,mode:0o700});
  for(const p of [dir,path.join(dir,'locks'),path.join(dir,'tasks'),path.join(dir,'metrics')]){
    assertPlainDir(p);
  }
  return dir;
}

// Metadata locks share retry and dead-owner recovery. Writer leases remain separate.
export {acquireLock} from './lock.mjs';

const listFiles=(base,rel='')=>fs.readdirSync(path.join(base,rel),{withFileTypes:true}).flatMap(entry=>{
  const next=path.join(rel,entry.name);
  return entry.isDirectory()?listFiles(base,next):[next];
});

// 레거시 .fusion을 작업 폴더 밖으로 옮긴다. 복사해서 모든 파일의 해시를 확인한 뒤에만 원본을 지운다.
// 진행 중인 lease와 상태도 그대로 옮겨지므로 recover 같은 이어가기가 새 위치에서 계속된다.
export function migrate(root) {
  const from=legacyDir(root);
  const to=externalDir(root);
  if(!hasLegacyRecords(root))throw Error('Nothing to migrate: no records in '+from);
  if(fs.existsSync(to))throw Error(`Already migrated: ${to} exists. Inspect it and remove ${from} by hand if it is stale`);
  if(fs.existsSync(path.join(from,'locks/control.lock')))throw Error('control.lock exists: a controller may be running, or one crashed. Confirm, then see recovery-protocol.md');
  if(fs.lstatSync(from).isSymbolicLink())throw Error('Symlink protocol directory forbidden');

  fs.mkdirSync(to,{recursive:true,mode:0o700});
  fs.cpSync(from,to,{recursive:true,errorOnExist:true,force:false});
  const files=listFiles(from);
  for(const rel of files){
    const same=fs.existsSync(path.join(to,rel))&&sha256(fs.readFileSync(path.join(from,rel)))===sha256(fs.readFileSync(path.join(to,rel)));
    if(!same){
      fs.rmSync(to,{recursive:true,force:true});
      throw Error('Copy verification failed for '+rel+'; nothing was removed');
    }
  }
  fs.rmSync(from,{recursive:true,force:true});
  return {from,to,files:files.length};
}

// 사용법: node control-dir.mjs path REPO  → 제어 폴더 위치를 출력한다(복구 절차에서 쓴다).
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const [action,target]=process.argv.slice(2);
  if(action!=='path'||!target)throw Error('Usage: control-dir.mjs path REPO');
  console.log(controlRoot(path.resolve(target)));
 }catch(e){printError(e);}
}
