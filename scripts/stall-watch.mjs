// 일꾼 정지 관측(관측 전용). 일꾼을 끊지 않고, 라운드의 성공·실패도 바꾸지 않는다.
// 컨트롤러가 직접 본 진행 신호(출력 바이트, 프로세스 트리의 CPU 시간, 작업 트리 변경)가 모두 멈춘 구간을 기록한다.
// 일꾼이 "살아 있다"고 보고하는 값은 쓰지 않는다. 멈춘 모델은 보고를 못 하고, 헛도는 모델은 보고를 계속하기 때문이다.
// 목적은 기준 시간을 정하는 것이다. 구간을 그대로 남기므로 "5분이면 끊었을까, 10분이면?"을 나중에 다시 계산할 수 있다.
import fs from 'node:fs';
import path from 'node:path';
import {isMain} from './platform.mjs';
import {controlPath} from './control-dir.mjs';

export const STALL_SIGNALS=['output','cpu','tree'];
export const STALL_DEFAULTS={minGapMs:120000,firstSignalMs:300000,stallMs:600000,maxGaps:32};
export const stallFile=tag=>`stall-${tag}.json`;

const iso=ms=>new Date(ms).toISOString();

export function createStallWatch({startedAt=Date.now(),minGapMs=STALL_DEFAULTS.minGapMs,firstSignalMs=STALL_DEFAULTS.firstSignalMs,stallMs=STALL_DEFAULTS.stallMs,maxGaps=STALL_DEFAULTS.maxGaps}={}) {
 for(const v of [minGapMs,firstSignalMs,stallMs,maxGaps])if(!Number.isSafeInteger(v)||v<1)throw Error('Invalid stall watch limit');
 if(maxGaps>256)throw Error('Invalid stall watch limit: exceeds bounded storage capacity');
 const signals=Object.fromEntries(STALL_SIGNALS.map(s=>[s,{available:false,count:0,last_at:null}]));
 // 출력은 브리지가 파이프를 직접 읽으므로 항상 볼 수 있다. CPU와 작업 트리는 첫 관측이 성공해야 볼 수 있다고 적는다.
 signals.output.available=true;
 const gaps=[];let dropped=0,maxGap=0;
 let last=startedAt,first=null,wouldStop=null,finished=null;
 let cpu=new Map(),cpuSeeded=false;

 function closeGap(at,endedBy) {
  const ms=at-last;
  if(ms>maxGap)maxGap=ms;
  if(ms<minGapMs)return;
  const gap={from:iso(last),to:iso(at),ms,before_first_signal:first===null,ended_by:endedBy};
  if(gaps.length<maxGaps){gaps.push(gap);return;}
  // 상한을 넘으면 가장 짧은 구간을 버린다. 기준을 정할 때 필요한 것은 긴 구간이다.
  dropped++;
  let shortest=0;for(let i=1;i<gaps.length;i++)if(gaps[i].ms<gaps[shortest].ms)shortest=i;
  if(gaps[shortest].ms<gap.ms){gaps.splice(shortest,1);gaps.push(gap);}
 }

 function progress(signal,at=Date.now()) {
  if(finished||!signals[signal]||!Number.isFinite(at)||at<last)return;
  closeGap(at,signal);
  if(wouldStop&&!wouldStop.resumed_at){wouldStop.resumed_at=iso(at);wouldStop.resumed_by=signal;wouldStop.resumed_after_ms=at-Date.parse(wouldStop.at);}
  last=at;first??=at;
  signals[signal].available=true;signals[signal].count++;signals[signal].last_at=iso(at);
 }

 return {
  progress,
  available(signal,value=true){if(signals[signal])signals[signal].available=value;},
  // 프로세스 표 한 번의 관측. 이미 보던 프로세스의 CPU 시간이 늘었거나 새 프로세스가 생겼으면 진행으로 본다.
  // CPU 시간은 초 단위로 내려서 비교한다. Linux의 ps는 초 단위이고 Windows는 100ns 단위라, 그대로 두면
  // Windows에서는 멈춘 프로세스의 타이머 깨어남까지 진행으로 잡혀 같은 실행이 OS마다 다르게 기록된다.
  processes(rows,at=Date.now()) {
   if(finished||!Array.isArray(rows))return;
   let moved=false,known=false;const next=new Map();
   for(const p of rows){
    if(!Number.isSafeInteger(p?.pid)||typeof p.created!=='string')continue;
    const key=p.pid+'\0'+p.created,prev=cpu.get(key);
    const seconds=Number.isFinite(p.cpu_ms)?Math.floor(p.cpu_ms/1000):null;
    if(seconds!==null)known=true;
    if(prev===undefined){if(cpuSeeded)moved=true;}
    else if(seconds!==null&&prev!==null&&seconds>prev)moved=true;
    next.set(key,seconds??prev??null);
   }
   // 끝난 프로세스는 버린다. 긴 라운드에서 도구 자식이 수천 개 생겨도 표가 커지지 않는다.
   cpu=next;
   if(known)signals.cpu.available=true;
   if(rows.length)cpuSeeded=true;
   if(moved)progress('cpu',at);
  },
  // 기준을 처음 넘은 순간 한 번만 돌려준다. 끊는 모드였다면 실행이 거기서 끝났을 것이므로 한 번만 기록한다.
  tick(at=Date.now()) {
   if(finished||wouldStop)return null;
   const flat=at-last,threshold=first===null?firstSignalMs:stallMs;
   if(flat<threshold)return null;
   wouldStop={kind:first===null?'no_first_signal':'stalled',at:iso(at),flat_ms:flat,threshold_ms:threshold,after_start_ms:at-startedAt,resumed_at:null,resumed_by:null,resumed_after_ms:null};
   return {...wouldStop};
  },
  finish(at=Date.now(),outcome=null) {
   if(!finished){closeGap(at,'exit');finished={at,outcome};}
   return this.report();
  },
  report(at=Date.now()) {
   const end=finished?.at??at;
   return {
    version:1,
    mode:'observe-only',
    thresholds:{min_gap_ms:minGapMs,first_signal_ms:firstSignalMs,stall_ms:stallMs},
    started_at:iso(startedAt),
    ended_at:finished?iso(finished.at):null,
    wall_ms:Math.max(0,end-startedAt),
    first_signal_at:first===null?null:iso(first),
    last_progress_at:iso(last),
    signals:structuredClone(signals),
    max_gap_ms:Math.max(maxGap,finished?0:Math.max(0,end-last)),
    gaps:gaps.map(g=>({...g})),
    gaps_dropped:dropped,
    would_stop:wouldStop?{...wouldStop}:null,
    outcome:finished?.outcome??null,
    declares_success:false
   };
  }
 };
}

// 기록 하나를 다시 읽어 "끊었다면 어땠을까"를 판단한다. 기준을 바꿔 다시 계산할 수 있다(stallMs, firstSignalMs).
export function judgeStall(record,{stallMs=record?.thresholds?.stall_ms,firstSignalMs=record?.thresholds?.first_signal_ms}={}) {
 const gaps=Array.isArray(record?.gaps)?record.gaps:[];
 const hit=gaps.filter(g=>g.ms>=(g.before_first_signal?firstSignalMs:stallMs)).sort((a,b)=>Date.parse(a.from)-Date.parse(b.from))[0]??null;
 if(!hit)return {verdict:'none',gap:null,saved_ms:0};
 const threshold=hit.before_first_signal?firstSignalMs:stallMs;
 const stopAt=Date.parse(hit.from)+threshold;
 const ok=record.outcome?.ok===true;
 // 신호가 다시 움직였거나 끝내 성공한 실행이면 끊은 것이 잘못이다. 실패로 끝난 실행이면 그만큼의 시간을 아꼈을 것이다.
 if(hit.ended_by!=='exit')return {verdict:'false_positive_resumed',gap:hit,saved_ms:0};
 if(ok)return {verdict:'false_positive_finished',gap:hit,saved_ms:0};
 return {verdict:'would_save',gap:hit,saved_ms:Math.max(0,Date.parse(record.ended_at??hit.to)-stopAt)};
}

export function readStallRecords(dir) {
 const out=[];
 const scan=d=>{
  let names=[];try{names=fs.readdirSync(d,{withFileTypes:true});}catch{return;}
  for(const n of names){
   if(!n.isFile()||!/^stall-[\w-]+\.json$/.test(n.name))continue;
   const file=path.join(d,n.name);
   try{
    const st=fs.lstatSync(file);
    if(st.isSymbolicLink()||st.size>512*1024)continue;
    out.push({file,record:JSON.parse(fs.readFileSync(file,'utf8'))});
   }catch{/* 읽지 못한 기록은 건너뛴다 */}
  }
 };
 scan(dir);
 let subs=[];try{subs=fs.readdirSync(dir,{withFileTypes:true}).filter(n=>n.isDirectory());}catch{}
 for(const s of subs)scan(path.join(dir,s.name));
 return out.sort((a,b)=>String(a.record.started_at).localeCompare(String(b.record.started_at)));
}

const minutes=ms=>ms==null?'-':(ms/60000).toFixed(1)+'m';
export function formatStallReport(items,options={}) {
 if(!items.length)return 'stall records: none\n';
 const rows=items.map(({file,record:r})=>{
  const j=judgeStall(r,options);
  return [`${r.task_id??'?'} ${path.basename(file,'.json').slice(6)}`,`${r.executor??'?'}/${r.role??'?'}`,`wall ${minutes(r.wall_ms)}`,`max_gap ${minutes(r.max_gap_ms)}`,
   `signals ${STALL_SIGNALS.filter(s=>r.signals?.[s]?.available).join('+')||'none'}`,`outcome ${r.outcome?.ok===true?'ok':r.outcome?.reason??'failed'}`,
   j.verdict==='would_save'?`would_save ${minutes(j.saved_ms)}`:j.verdict].join(' | ');
 });
 const judged=items.map(i=>judgeStall(i.record,options));
 const count=v=>judged.filter(j=>j.verdict===v).length;
 const saved=judged.reduce((n,j)=>n+j.saved_ms,0);
 return rows.join('\n')+`\n---\nruns ${items.length} | would_save ${count('would_save')} (${minutes(saved)}) | false_positive ${count('false_positive_resumed')+count('false_positive_finished')} | none ${count('none')}\n`;
}

if(isMain(import.meta.url)){
 const args=process.argv.slice(2);
 const target=args.find(a=>!a.startsWith('--'));
 const number=name=>{const v=args.find(a=>a.startsWith(`--${name}=`));if(!v)return undefined;const n=Number(v.split('=')[1])*60000;if(!Number.isFinite(n)||n<=0)throw Error(`--${name} takes minutes`);return n;};
 try{
  if(!target)throw Error('Usage: node scripts/stall-watch.mjs REPO|DIR [--stall-min=N] [--first-signal-min=N] [--json]');
  // 저장소 경로를 주면 그 저장소의 제어 폴더를, 다른 폴더를 주면 그 폴더와 바로 아래 폴더를 읽는다.
  const dir=fs.existsSync(path.join(target,'.git'))?controlPath(target,'tasks'):target;
  const items=readStallRecords(dir);
  const options={...(number('stall-min')?{stallMs:number('stall-min')}:{}),...(number('first-signal-min')?{firstSignalMs:number('first-signal-min')}:{})};
  if(args.includes('--json'))console.log(JSON.stringify(items.map(i=>({file:i.file,...judgeStall(i.record,options),record:i.record})),null,2));
  else process.stdout.write(formatStallReport(items,options));
 }catch(e){console.error(e.message);process.exitCode=1;}
}
