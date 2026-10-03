import fs from 'node:fs';
import path from 'node:path';
import {isMain} from './platform.mjs';
import {read} from './artifact.mjs';
import {adapter} from './adapters/index.mjs';
import {config} from './executor-config.mjs';

// 작업 종류·난이도로 배치표 규칙을 고르고, 과거 실적과 설치 상태로 순서를 조정한다.
// 결과는 투입 순서(candidates)와 근거(reason)다. 리드는 이를 기록하고 필요하면 명시 지정으로 덮어쓴다.
export function matchRule(rules,brief) {
 return rules.find(r=>(r.kind===undefined||r.kind===brief.task_kind)&&(r.difficulty===undefined||r.difficulty.includes(brief.difficulty)));
}

// .fusion/metrics/*.json에서 (작업 종류, 일꾼)별로 "참여한 작업 중 pass를 받은 비율"을 센다.
export function history(root,kind) {
 const dir=path.join(root,'.fusion/metrics'),stats={};
 if(!fs.existsSync(dir))return stats;
 for(const f of fs.readdirSync(dir).filter(x=>x.endsWith('.json'))){
  let m;try{m=read(path.join(dir,f));}catch{continue;}
  if((m.task_kind??null)!==(kind??null)||!Array.isArray(m.review_outcomes))continue;
  for(const e of new Set(m.review_outcomes.map(r=>r.owner).filter(o=>o!=='lead'))){
   stats[e]??={tasks:0,passed:0};stats[e].tasks++;
   if(m.review_outcomes.some(r=>r.owner===e&&r.verdict==='pass'))stats[e].passed++;
  }
 }
 return stats;
}

export function route(root,c,brief,{probe=true}={}) {
 const rule=matchRule(c.routing.rules,brief);
 if(!rule)throw Error('No routing rule matches; add a fallback rule without kind');
 const notes=[`rule: ${rule.kind??'*'}/${rule.difficulty?.join('|')??'*'} → ${rule.executors.join(' > ')}${rule.why?' ('+rule.why+')':''}`];
 // 배치표에 없지만 고용된 일꾼은 맨 뒤 예비 인력으로 둔다.
 let order=[...rule.executors.filter(e=>c.external.available.includes(e)),...c.external.available.filter(e=>!rule.executors.includes(e))];
 const stats=c.routing.learn?history(root,brief.task_kind):{};
 const demoted=order.filter(e=>{const s=stats[e];return s&&s.tasks>=c.routing.min_samples&&s.passed/s.tasks<c.routing.demote_below;});
 if(demoted.length){order=[...order.filter(e=>!demoted.includes(e)),...demoted];notes.push('demoted by track record: '+demoted.map(e=>`${e} ${stats[e].passed}/${stats[e].tasks}`).join(', '));}
 const unavailable={};
 if(probe)for(const e of order){try{adapter(e).probe(c.executors[e]??{});}catch(err){unavailable[e]=err.message;}}
 const candidates=order.filter(e=>!(e in unavailable));
 if(Object.keys(unavailable).length)notes.push('skipped (not installed or unsupported): '+Object.keys(unavailable).join(', '));
 if(!candidates.length)throw Error('ADAPTER_UNAVAILABLE: no routed executor is installed: '+JSON.stringify(unavailable));
 return {executor:candidates[0],candidates,task_kind:brief.task_kind??null,difficulty:brief.difficulty??null,stats,unavailable,reason:notes.join('; ')};
}

if(isMain(import.meta.url)) {
 try{
  const [root,file]=process.argv.slice(2);if(!root||!file)throw Error('Usage: router.mjs REPO_ROOT BRIEF.json');
  console.log(JSON.stringify(route(root,config(root),read(file)),null,2));
 }catch(e){console.error(e.message);process.exitCode=1;}
}
