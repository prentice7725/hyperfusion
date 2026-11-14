// 일꾼 단독 시험: 큰 과제 하나를 일꾼 하나에게 한 라운드만 시키고 숨김 시험으로 채점한다.
// 리드와 리뷰어는 부르지 않는다. 배치표를 고칠 근거를 모으려고 둔다(references/worker-capability-trial.md).
// 실제 모델을 부르므로 비용이 든다. 흐름은 scripts/smoke.mjs와 같다: init → begin → 브리지 → finish.
//
//   node tools/worker-trial.mjs run HF-L01 ../trials/l01-terra-1 --worker terra --label terra --out trials.jsonl
//   node tools/worker-trial.mjs run HF-L01 ../trials/l01-h4-1 --worker antigravity --model gemini-4-hydrogen --effort high --label hydrogen --out trials.jsonl
//   node tools/worker-trial.mjs summary trials.jsonl
import fs from 'node:fs';
import path from 'node:path';
import {run} from '../scripts/fusion-state.mjs';
import {execute} from '../scripts/executor-bridge.mjs';
import {read} from '../scripts/artifact.mjs';
import {controlPath} from '../scripts/control-dir.mjs';
import {prepareHistoryFixture,LARGE_CASES} from '../scripts/benchmark-fixtures.mjs';
import {scoreTrial,defaultHiddenDir} from '../scripts/benchmark-quality.mjs';
import {MEMBERS} from '../scripts/member-registry.mjs';
import {printError} from '../scripts/cli.mjs';
import {isMain} from '../scripts/platform.mjs';

const USAGE_KEYS=['model','model_family','reasoning_effort','wall_ms','input_tokens','output_tokens','cached_input_tokens','cache_read_input_tokens','cache_creation_input_tokens','reasoning_output_tokens','total_tokens','total_cost_usd','num_turns'];
const optional=file=>fs.existsSync(file)?read(file):null;

// 한 번의 시험. 어느 단계에서 깨져도 기록 한 줄을 돌려준다(실패한 시험을 빼면 통과율이 부풀려진다).
// defer이면 일꾼 라운드까지만 돌리고 finish(수용 테스트)와 채점은 settle로 미룬다. 여러 일꾼을 동시에 돌릴 때
// 수용 테스트·숨김 시험이 서로 CPU를 빼앗아 시간 제한에 걸리지 않게 하려는 것이다. writer lease에는 만료가 없어
// finish를 나중에 불러도 된다.
export async function trial({caseId,target,worker,model,effort,label,source,hidden=defaultHiddenDir(),cases=LARGE_CASES,timeoutMs=60*60*1000,defer=false}) {
 if(!MEMBERS[worker]?.implement)throw Error(`worker-trial: ${worker} is not an implementing worker (${Object.keys(MEMBERS).filter(n=>MEMBERS[n].implement).join(', ')})`);
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1000)throw Error('worker-trial: timeout must be at least one second');
 const record={case_id:caseId,label:label??worker,worker,requested_model:model??null,requested_effort:effort??null,started_at:new Date().toISOString(),
  stage:'prepare',error:null,phase:null,acceptance_passed:null,worker_status:null,usage:null,score:null};
 const started=Date.now();
 let root=null;
 try{
  const fixture=prepareHistoryFixture(caseId,target,{source,cases});
  root=fixture.root;record.repo=root;record.fixture_id=fixture.fixture_id;record.baseline_status=fixture.baseline_status;
  if(fixture.baseline_status!=='red')throw Error(`acceptance baseline is ${fixture.baseline_status}, expected red`);
  // prepare가 hyperfusion.config.json을 .gitignore에 넣어 두므로 일꾼 변경으로 잡히지 않는다.
  fs.writeFileSync(path.join(root,'hyperfusion.config.json'),JSON.stringify({external:{default:worker,available:[worker]},
   executors:{[worker]:{timeout_ms:timeoutMs,...(model?{model}:{}),...(effort?{reasoning_effort:effort}:{})}}},null,1));
  const brief=read(fixture.brief_file);
  const dir=controlPath(root,'tasks',brief.task_id);
  record.task_id=brief.task_id;
  record.stage='init';run(root,'init',brief);
  record.stage='begin';run(root,'begin',brief);
  record.stage='execute';
  try{await execute(root,{timeoutMs,proveQuiescence:true});}
  finally{
   // 브리지가 실패해도 남긴 시간·토큰 기록은 가져온다.
   const usage=optional(path.join(dir,'usage-1.json'));
   if(usage)record.usage=Object.fromEntries(USAGE_KEYS.filter(k=>usage[k]!==undefined).map(k=>[k,usage[k]]));
  }
  record.stage='executed';
 }catch(e){record.error=String(e.message??e).slice(0,500);}
 record.worker_ms=Date.now()-started;
 if(defer){record.settled=false;record.total_ms=record.worker_ms;return record;}
 return settle(record,{hidden,cases});
}

// 일꾼 라운드가 끝난 기록을 마무리한다: finish(수용 테스트)를 부르고 숨김 시험으로 채점한다.
// 이미 finish를 지난 저장소(마무리 도중 끊긴 경우)는 finish를 다시 부르지 않고 상태만 읽는다.
export async function settle(record,{hidden=defaultHiddenDir(),cases=LARGE_CASES}={}) {
 const out={...record,settled:true},started=Date.now(),root=record.repo;
 if(record.stage==='executed'){
  try{
   out.stage='finish';
   let state=read(controlPath(root,'state.json'));
   if(state.phase==='EXECUTING')state=run(root,'finish',{token:state.writer.token,quiescent:true});
   out.phase=state.phase;out.acceptance_passed=state.phase==='REVIEW';
   out.worker_status=optional(controlPath(root,'tasks',record.task_id,'result-1.json'))?.status??null;
   out.stage='done';
  }catch(e){out.error=String(e.message??e).slice(0,500);}
 }
 // 채점은 일꾼이 남긴 트리로 한다. 브리지나 finish가 깨졌어도 트리가 있으면 채점한다.
 if(root&&fs.existsSync(path.join(root,'.git'))&&!['prepare','init','begin'].includes(record.stage)){
  try{
   const s=await scoreTrial(record.case_id,root,{hidden,cases});
   out.score={hidden_files:s.hidden.files,hidden_passed:s.hidden.passed,hidden_failed:s.hidden.failed.length,hidden_crashed:s.hidden.crashed.length,
    all_hidden_passed:s.hidden_passed,scope_violations:s.scope.count,scope_files:s.scope.files.slice(0,20),changed_files:s.changed_files};
  }catch(e){out.score_error=String(e.message??e).slice(0,300);}
 }
 out.total_ms=(record.worker_ms??0)+(Date.now()-started);
 return out;
}

const median=list=>{const v=list.filter(n=>Number.isFinite(n)).sort((a,b)=>a-b);return v.length?v[Math.floor((v.length-1)/2)]:null;};
// label별 요약. 채점하지 못한 시험은 통과로도 실패로도 세지 않고 unscored로 따로 센다.
export function summarize(records) {
 const labels=[...new Set(records.map(r=>r.label))];
 return labels.map(label=>{
  const mine=records.filter(r=>r.label===label),scored=mine.filter(r=>r.score);
  return {label,trials:mine.length,errored:mine.filter(r=>r.error).length,unscored:mine.length-scored.length,
   acceptance_passed:mine.filter(r=>r.acceptance_passed===true).length,
   all_hidden_passed:scored.filter(r=>r.score.all_hidden_passed).length,
   hidden_tests_passed:scored.reduce((n,r)=>n+r.score.hidden_passed,0),
   hidden_tests_total:scored.reduce((n,r)=>n+r.score.hidden_passed+r.score.hidden_failed,0),
   scope_violation_trials:scored.filter(r=>r.score.scope_violations>0).length,
   median_worker_wall_min:(m=>m===null?null:Math.round(m/6000)/10)(median(mine.map(r=>r.usage?.wall_ms))),
   by_case:Object.fromEntries([...new Set(mine.map(r=>r.case_id))].map(c=>[c,mine.filter(r=>r.case_id===c).map(r=>r.score?`${r.score.hidden_passed}/${r.score.hidden_passed+r.score.hidden_failed}${r.score.scope_violations?' scope!':''}`:'unscored')]))};
 });
}
export const readRecords=file=>fs.readFileSync(file,'utf8').split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));

if(isMain(import.meta.url)){
 try{
  const [cmd,...rest]=process.argv.slice(2);
  const flag=name=>{const i=rest.indexOf(name);return i>=0?rest[i+1]:undefined;};
  if(cmd==='run'&&rest[0]&&rest[1]&&flag('--worker')){
   const minutes=flag('--timeout-min')?Number(flag('--timeout-min')):60;
   const record=await trial({caseId:rest[0],target:rest[1],worker:flag('--worker'),model:flag('--model'),effort:flag('--effort'),label:flag('--label'),
    source:flag('--source'),hidden:flag('--hidden'),timeoutMs:Math.round(minutes*60000),defer:rest.includes('--defer-settle')});
   if(flag('--out'))fs.appendFileSync(flag('--out'),JSON.stringify(record)+'\n');
   console.log(JSON.stringify(record,null,2));
   process.exitCode=record.error?1:0;
  }else if(cmd==='settle'&&rest[0]){
   // 미룬 기록(JSON 파일) 하나를 마무리해 출력한다.
   console.log(JSON.stringify(await settle(read(rest[0]),{hidden:flag('--hidden')}),null,2));
  }else if(cmd==='summary'&&rest[0])console.log(JSON.stringify(summarize(readRecords(rest[0])),null,2));
  else throw Error('Usage: worker-trial.mjs run CASE NEW_REPO --worker NAME [--model ID] [--effort LEVEL] [--label NAME] [--source HYPERFUSION_CLONE] [--hidden DIR] [--timeout-min 60] [--defer-settle] [--out FILE.jsonl] | settle RECORD.json [--hidden DIR] | summary FILE.jsonl');
 }catch(e){printError(e);}
}
