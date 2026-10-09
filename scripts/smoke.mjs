import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {run} from './fusion-state.mjs';
import {execute} from './executor-bridge.mjs';
import {read} from './artifact.mjs';
import {controlPath} from './control-dir.mjs';

// 어댑터 계약 스모크: 일꾼 CLI에 아주 작은 작업 하나를 실제로 시켜, 플래그·출력 형식·결과 계약·파일 변경이
// 지금 설치된 CLI 버전에서도 맞는지 확인한다. 이 바닥에서 자주 깨지는 건 모델보다 CLI 플래그다.
// 대상 저장소는 건드리지 않는다. 임시 저장소와 임시 제어 폴더에서만 돈다. 실제 모델을 부르므로 비용이 든다.

const FILE='hf-smoke.txt';
const BRIEF={task_id:'hf-smoke',objective:`Replace ${FILE} with exactly "ok" followed by a newline. Change nothing else.`,
 scope:{paths:[FILE]},constraints:[],success_criteria:[`AC1: ${FILE} is exactly ok followed by a newline`],allowed_actions:['read','edit'],task_kind:'code',difficulty:'low'};

async function one(name,{timeoutMs}) {
 const started=Date.now();
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'hf-smoke-')),root=path.join(temp,'repo');fs.mkdirSync(root);
 const saved=process.env.HF_STATE_DIR;process.env.HF_STATE_DIR=path.join(temp,'state');
 let stage='setup';
 try{
  const git=(...args)=>execFileSync('git',['-C',root,...args],{stdio:'pipe'});
  git('init');git('config','user.name','HyperFusion smoke');git('config','user.email','smoke@example.invalid');
  fs.writeFileSync(path.join(root,FILE),'pending\n');git('add','.');git('commit','-m','smoke baseline');
  // 설정 파일은 커밋하지 않는다(일꾼 변경으로 보이지 않게 .git/info/exclude에 넣는다).
  fs.appendFileSync(path.join(root,'.git','info','exclude'),'\nhyperfusion.config.json\n');
  fs.writeFileSync(path.join(root,'hyperfusion.config.json'),JSON.stringify({external:{default:name,available:[name]},executors:{[name]:{timeout_ms:timeoutMs}}}));
  stage='init';run(root,'init',BRIEF);
  stage='begin';run(root,'begin',BRIEF);
  stage='execute';await execute(root,{timeoutMs});
  stage='finish';
  const token=read(controlPath(root,'state.json')).writer.token;
  const s=run(root,'finish',{token,quiescent:true});
  if(s.phase!=='REVIEW')throw Error(`finish ended in ${s.phase}: ${(s.last_errors??[]).join('; ')}`);
  stage='output';
  const text=fs.readFileSync(path.join(root,FILE),'utf8');
  if(text.replace(/\r\n/g,'\n')!=='ok\n')throw Error(`${FILE} is ${JSON.stringify(text.slice(0,40))}, expected "ok\\n"`);
  return {executor:name,ok:true,ms:Date.now()-started};
 }catch(e){
  return {executor:name,ok:false,stage,error:e.message.slice(0,500),ms:Date.now()-started};
 }finally{
  if(saved===undefined)delete process.env.HF_STATE_DIR;else process.env.HF_STATE_DIR=saved;
  fs.rmSync(temp,{recursive:true,force:true});
 }
}

// 일꾼을 하나씩 차례로 돌린다(동시에 돌리면 어느 CLI가 깨졌는지 헷갈린다).
export async function smoke(names,{timeoutMs=180000}={}) {
 const results=[];
 for(const name of names)results.push(await one(name,{timeoutMs}));
 return results;
}
