import {readInput,printError} from './cli.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {isMain} from './platform.mjs';
import {read} from './artifact.mjs';
import {adapter} from './adapters/index.mjs';
import {config,EXECUTORS,KIND_NEEDS,canDo,externalFirst,routingPolicy,automaticImplementer,DIFFICULTY_EFFORT} from './executor-config.mjs';
import {controlPath} from './control-dir.mjs';
import {quotaReport,exhaustedExecutors} from './quota-policy.mjs';

// 작업 종류·난이도로 배치표 규칙을 고르고, 과거 실적과 설치 상태로 순서를 조정한다.
// 결과는 투입 순서(candidates)와 근거(reason)다. 리드는 이를 기록하고 필요하면 명시 지정으로 덮어쓴다.
export function matchRule(rules,brief) {
 return rules.find(r=>(r.kind===undefined||r.kind===brief.task_kind)&&(r.difficulty===undefined||r.difficulty.includes(brief.difficulty)));
}

// 제어 폴더의 metrics/*.json에서 (작업 종류, 일꾼)별로 "참여한 작업 중 pass를 받은 비율"을 센다.
export function history(root,kind,{difficulty,halfLifeDays=90,now=Date.now()}={}) {
 const dir=controlPath(root,'metrics'),stats=Object.create(null);
 let samples=0;
 if(!fs.existsSync(dir))return stats;
 for(const f of fs.readdirSync(dir).filter(x=>x.endsWith('.json'))){
  let m;try{m=read(path.join(dir,f));}catch{continue;}
  if((m.task_kind??null)!==(kind??null)||(m.difficulty??null)!==(difficulty??null)||!Array.isArray(m.review_outcomes))continue;
  samples++;
  const date=Date.parse(m.ended_at??m.started_at),age=Number.isFinite(date)?Math.max(0,now-date):0;
  const weight=Math.pow(0.5,age/(halfLifeDays*86400000));
  const first=m.initial_executor??m.review_outcomes[0]?.owner;
  // 지표 파일은 일꾼이 만든 값을 담을 수 있다. 실제 일꾼 이름만 센다(__proto__ 같은 키로 객체를 오염시키지 못하게).
  for(const e of new Set(m.review_outcomes.map(r=>r.owner).filter(o=>EXECUTORS.includes(o)))){
   stats[e]??={tasks:0,passed:0,weighted_tasks:0,weighted_score:0};stats[e].tasks++;
   const rounds=m.review_outcomes.filter(r=>r.owner===e),pass=rounds.findIndex(r=>r.verdict==='pass');
   // Later workers inherit failed tasks, so their samples carry less weight.
   const exposure=weight*(e===first?1:0.5);
   stats[e].weighted_tasks+=exposure;
   if(pass>=0){stats[e].passed++;stats[e].weighted_score+=exposure/(pass+1);}
  }
  // 읽기 전용 상담에서 트리를 건드린 일꾼은 실패 한 건으로 친다.
  for(const c of Array.isArray(m.consults)?m.consults:[])if(c?.violated&&Array.isArray(c.members))for(const x of c.members){if(!EXECUTORS.includes(x?.executor))continue;stats[x.executor]??={tasks:0,passed:0,weighted_tasks:0,weighted_score:0};stats[x.executor].tasks++;stats[x.executor].weighted_tasks+=weight;}
 }
 Object.defineProperty(stats,'sample_count',{value:samples});
 return stats;
}

export function route(root,c,brief,{probe=true}={}) {
 const rule=matchRule(c.routing.rules,brief);
 if(!rule)throw Error('No routing rule matches; add a fallback rule without kind');
 const notes=[`rule: ${rule.kind??'*'}/${rule.difficulty?.join('|')??'*'} → ${rule.executors.join(' > ')}${rule.why?' ('+rule.why+')':''}`];
 // 배치표에 없지만 고용된 일꾼은 맨 뒤 예비 인력으로 둔다.
 let order=[...rule.executors.filter(e=>c.external.available.includes(e)),...c.external.available.filter(e=>!rule.executors.includes(e))];
 // 능력으로 거른다. 필요한 능력이 없는 일꾼은 예비 인력으로도 넣지 않는다(예: 이미지 생성 못 하는 일꾼은 이미지 작업 제외).
 const unable=order.filter(e=>!canDo(c,e,brief.task_kind));
 if(unable.length){order=order.filter(e=>!unable.includes(e));notes.push(`lacks ${KIND_NEEDS[brief.task_kind]}: ${unable.join(', ')}`);}
 // External-First: 승인 전용 일꾼과 예비 Claude 인력은 학습·탐색·신입 우대·예비 순서보다 먼저 빠진다.
 const policy=routingPolicy(c);
 const excluded=[];
 if(externalFirst(c)){
  const out=order.filter(e=>!automaticImplementer(c,e));
  if(out.length){order=order.filter(e=>!out.includes(e));excluded.push(...out);notes.push(`external-first excludes automatic ${out.join(', ')}`);}
 }
 // 확정된(fresh) 소진만 뒤로 민다. 지난 값이나 모르는 값은 순서를 바꾸지 않는다.
 const quota=quotaReport(root);
 const drained=exhaustedExecutors(quota,order);
 if(drained.length&&drained.length<order.length){order=[...order.filter(e=>!drained.includes(e)),...drained];notes.push('quota exhausted (fresh record): '+drained.join(', '));}
 const stats=c.routing.learn?history(root,brief.task_kind,{difficulty:brief.difficulty,halfLifeDays:c.routing.half_life_days}):{};
 const demoted=order.filter(e=>{const s=stats[e];return s&&s.weighted_tasks>=c.routing.min_samples&&s.weighted_score/s.weighted_tasks<c.routing.demote_below;});
 if(demoted.length){order=[...order.filter(e=>!demoted.includes(e)),...demoted];notes.push('demoted by track record: '+demoted.map(e=>`${e} ${stats[e].passed}/${stats[e].tasks}`).join(', '));}
 const unavailable={};
 if(probe)for(const e of order){try{adapter(e).probe(c.executors[e]??{});}catch(err){unavailable[e]=err.message;}}
 const candidates=order.filter(e=>!(e in unavailable));
 const every=c.routing.explore_every;
 if(c.routing.learn&&every>0&&(stats.sample_count+1)%every===0){
  const bench=demoted.filter(e=>candidates.includes(e));
  const explore=bench[Math.floor((stats.sample_count+1)/every-1)%bench.length];
  if(explore){candidates.splice(candidates.indexOf(explore),1);candidates.unshift(explore);notes.push('exploration first pick: '+explore);}
 }
 // 신입 우대(cold start): 실적이 쌓이지 않은 일꾼은 배치표 뒤에 있으면 영영 기회를 못 받는다.
 // 실적 있는 일꾼이 있을 때, newcomer_every번째 작업마다 표본이 가장 적은 신입을 먼저 시켜 본다. 실패하면 평소처럼 교체된다.
 const fresh=c.routing.newcomer_every;
 if(c.routing.learn&&fresh>0&&!notes.some(n=>n.startsWith('exploration'))&&(stats.sample_count+1)%fresh===0){
  const seen=e=>stats[e]?.tasks??0;
  const newcomers=candidates.filter(e=>seen(e)<c.routing.min_samples);
  if(newcomers.length&&newcomers.length<candidates.length&&!newcomers.includes(candidates[0])){
   const pick=newcomers.reduce((a,b)=>seen(b)<seen(a)?b:a);
   candidates.splice(candidates.indexOf(pick),1);candidates.unshift(pick);notes.push('newcomer trial first pick: '+pick);
  }
 }
 // Quota exhaustion must not be undone by exploration/newcomer promotion.
 if(drained.length)candidates.sort((a,b)=>Number(drained.includes(a))-Number(drained.includes(b)));
 if(Object.keys(unavailable).length)notes.push('skipped (not installed or unsupported): '+Object.keys(unavailable).join(', '));
 if(!candidates.length)throw Error('ADAPTER_UNAVAILABLE: no routed executor is installed: '+JSON.stringify(unavailable));
 const out={executor:candidates[0],candidates,task_kind:brief.task_kind??null,difficulty:brief.difficulty??null,stats,unavailable,reason:notes.join('; ')};
 if(policy!=='classic'){
  out.policy=policy;
  out.excluded=excluded;
  out.quota=Object.fromEntries(Object.entries(quota).map(([p,st])=>[p,{state:st.state,remaining:st.remaining??null}]));
  out.effort=effortFor(c,candidates[0],brief.difficulty);
 }
 return out;
}

// External-First에서 난이도별 강도. 운영자가 직접 적은 값이 있으면 그 값이 우선이다. CLI 지원은 어댑터 프로브가 다시 확인한다.
export function effortFor(c,executor,difficulty) {
 const configured=c?.executors?.[executor]?.reasoning_effort??null;
 const source=c?.effort_source?.[executor]??(configured?'config':'cli-default');
 const table=DIFFICULTY_EFFORT[executor];
 if(externalFirst(c)&&table&&difficulty&&table[difficulty]&&source==='default'){
  return {executor,reasoning_effort:table[difficulty],source:'difficulty',difficulty};
 }
 return {executor,reasoning_effort:configured,source,difficulty:difficulty??null};
}

if(isMain(import.meta.url)) {
 try{
  const [root,file]=process.argv.slice(2);if(!root||!file)throw Error('Usage: router.mjs REPO_ROOT BRIEF.json');
  console.log(JSON.stringify(route(root,config(root),readInput(file)),null,2));
 }catch(e){printError(e);}
}
