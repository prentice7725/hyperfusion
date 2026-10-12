// 테스트(또는 아무 명령)가 만드는 하위 프로세스를 세어 어디서 많이 뜨는지 보여 준다.
// Windows에서는 프로세스 하나가 git 25~32ms, node 38~45ms라 개수가 곧 시간이다. 줄이기 전후를 같은 방법으로 비교하려고 둔다.
//
//   node tools/count-spawns.mjs                  # npm test를 돌려 요약을 출력
//   node tools/count-spawns.mjs -- node --test tests/state.test.mjs
//   node tools/count-spawns.mjs --keep run.jsonl # 원본 기록(JSONL)도 남긴다
//
// 원리: NODE_OPTIONS="--import 이 파일"로 하위 node 프로세스까지 child_process의 생성 함수를 감싸 한 줄씩 기록한다.
// 센 숫자는 OS와 무관하다(Linux에서 세어도 Windows의 호출 횟수와 같다). 시간은 OS마다 다르다.
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const SELF=fileURLToPath(import.meta.url);

// ── 기록 쪽: --import로 불려 올 때 ──
function install(log,rootArg) {
 // 스택 프레임의 경로는 file:// URL이라 슬래시다. Windows 경로(역슬래시)와 맞추려고 둘 다 슬래시로 바꾼다.
 const norm=x=>String(x).replaceAll('\\','/'),rootDir=norm(rootArg),self=norm(SELF);
 const caller=()=>{
  const chain=[];
  for(const f of (new Error().stack||'').split('\n').slice(2)){
   const m=/\(?(?:file:\/\/)?([^()\s]+?):(\d+):\d+\)?$/.exec(f.trim());
   if(!m)continue;
   const file=m[1].replace(/^\/+(?=[A-Za-z]:)/,'');
   if(file.startsWith(rootDir)&&file!==self&&!file.includes('/node_modules/'))chain.push(file.slice(rootDir.length).replace(/^\//,'')+':'+m[2]);
   if(chain.length>=5)break;
  }
  return chain.length?chain.join(' < '):'(unknown)';
 };
 const label=(cmd,args)=>{
  const base=path.basename(String(cmd??'')).replace(/\.(exe|cmd)$/i,'');
  const a=Array.isArray(args)?args.map(String):[];
  let sub='';
  if(base==='git'){for(let i=0;i<a.length;i++){if(a[i]==='-c'||a[i]==='-C'){i++;continue;}if(!a[i].startsWith('-')){sub=a[i];break;}}}
  else if(base==='node')sub=path.basename(a.find(x=>!x.startsWith('-'))??'');
  return base+(sub?' '+sub:'');
 };
 const wrap=(name,pick)=>{
  const original=cp[name];
  cp[name]=function(...args){
   try{const [cmd,a]=pick(args);fs.appendFileSync(log,JSON.stringify({cmd:label(cmd,a),at:caller()})+'\n');}catch{}
   return original.apply(this,args);
  };
 };
 for(const n of ['spawn','spawnSync','execFile','execFileSync'])wrap(n,a=>[a[0],Array.isArray(a[1])?a[1]:[]]);
 wrap('fork',a=>[process.execPath,[a[0],...(Array.isArray(a[1])?a[1]:[])]]);
 for(const n of ['exec','execSync'])wrap(n,a=>{const p=String(a[0]).split(/\s+/);return [p[0],p.slice(1)];});
 syncBuiltinESMExports();
}

// ── 집계 쪽 ──
function top(counter,total,limit) {
 return [...counter.entries()].sort((a,b)=>b[1]-a[1]).slice(0,limit)
  .map(([k,v])=>`${String(v).padStart(7)} ${(v*100/total).toFixed(1).padStart(5)}%  ${k}`).join('\n');
}
export function summarize(rows) {
 const total=rows.length,count=f=>{const c=new Map();for(const r of rows){const k=f(r);c.set(k,(c.get(k)??0)+1);}return c;};
 const git=rows.filter(r=>r.cmd.startsWith('git'));
 // 사슬의 첫 칸이 생성 지점이다. snapshot·repo 같은 artifact.mjs 안의 도우미가 만든 것이면, 그것을 부른 바깥 지점을 센다.
 const caller=r=>r.at.split(' < ').find(x=>!x.startsWith('scripts/artifact.mjs:'))??r.at;
 return [`총 ${total}개, 그 중 git ${git.length}개 (${total?(git.length*100/total).toFixed(1):0}%)`,
  '\n[명령별]',top(count(r=>r.cmd),total,12),
  '\n[생성을 요청한 곳] (artifact.mjs 안의 git 헬퍼는 건너뛰고, 그것을 부른 바깥 지점을 센다)',top(count(caller),total,15)].join('\n');
}

if(process.env.CS_LOG){
 install(process.env.CS_LOG,process.env.CS_ROOT||process.cwd());
} else if(process.argv[1]&&fileURLToPath(new URL('file://'+path.resolve(process.argv[1]).replaceAll('\\','/').replace(/^([A-Za-z]):/,'/$1:')))===SELF){
 const args=process.argv.slice(2);
 let keep=null;
 if(args[0]==='--keep'){keep=path.resolve(args[1]);args.splice(0,2);}
 if(args[0]==='--')args.shift();
 const command=args.length?args:['npm','test'];
 const log=keep??path.join(fs.mkdtempSync(path.join(os.tmpdir(),'count-spawns-')),'spawns.jsonl');
 fs.rmSync(log,{force:true});
 const r=cp.spawnSync(command[0],command.slice(1),{stdio:['inherit','inherit','inherit'],shell:process.platform==='win32'&&/^(npm|npx)$/.test(command[0]),
  env:{...process.env,CS_LOG:log,CS_ROOT:process.cwd(),NODE_OPTIONS:`${process.env.NODE_OPTIONS??''} --import ${pathToImport(SELF)}`.trim()}});
 const rows=fs.existsSync(log)?fs.readFileSync(log,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l)):[];
 console.log('\n'+summarize(rows));
 if(!keep)fs.rmSync(path.dirname(log),{recursive:true,force:true});
 process.exit(r.status??1);
}
function pathToImport(file) {return process.platform==='win32'?'file:///'+file.replaceAll('\\','/'):file;}
