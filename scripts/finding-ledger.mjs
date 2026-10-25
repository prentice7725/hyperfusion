import fs from 'node:fs';
import path from 'node:path';
import {hash,read,immutable,snapshot} from './artifact.mjs';
import {safePath} from './contracts.mjs';
import {criterionIds,acTable} from './ac-trace.mjs';
import {ignoredManifest,ignoredChanges} from './acceptance.mjs';

const LIMIT=256*1024;
const optional=(dir,name)=>{try{return read(path.join(dir,name));}catch{return null;}};
const observationName=file=>`finding-observation-${hash(file).slice(0,24)}.json`;
const clip=(s,n=500)=>String(s??'').slice(0,n);
const normalized=p=>typeof p==='string'?p.replaceAll('\\','/').replace(/^(\.\/)+/,''):null;
const inScope=(file,scope)=>scope.some(p=>file===p||file.startsWith(p+'/'));
const forbidden=file=>file.split('/').some(p=>/^\.env(?:\.|$)/i.test(p)||/^(?:secrets|\.npmrc|\.yarnrc(?:\.yml)?)$/i.test(p));

// Read only bounded, scoped, ordinary source files matching a controller snapshot.
// Never follow a symlink, read secrets, or read a live writer's tree on inspection.
function sourceLines(root,post,file,scope) {
 if(!safePath(file)||forbidden(file)||!inScope(file,scope)||post?.files?.[file]?.kind!=='file')return null;
 try{
  let current=root;
  for(const part of file.split('/')){current=path.join(current,part);if(fs.lstatSync(current).isSymbolicLink())return null;}
  if(fs.statSync(current).size>LIMIT)return null;
  const bytes=fs.readFileSync(current);
  if(hash(bytes)!==post.files[file].sha256||bytes.includes(0))return null;
  return bytes.toString('utf8').replaceAll('\r\n','\n').split('\n');
 }catch{return null;}
}
function locations(lines,context) {
 if(!lines||!context||!Number.isSafeInteger(context.length)||context.length<1||context.length>5)return [];
 const out=[];
 for(let i=0;i+context.length<=lines.length;i++)if(hash(lines.slice(i,i+context.length).join('\n'))===context.hash)out.push(i+context.offset+1);
 return out;
}

export function findingCriteria(f,blocking=[]) {
 const explicit=Array.isArray(f?.ac_ids)?f.ac_ids:[];
 const ids=criterionIds([...explicit,f?.issue]);
 const fallback=criterionIds(blocking);
 return (ids.length?ids:fallback.length===1?fallback:[]).sort();
}

function observation(source,f,index,post) {
 const file=normalized(f?.file),line=Number.isSafeInteger(f?.line)&&f.line>0?f.line:null;
 const issue=typeof f?.issue==='string'?f.issue.trim():'';
 const evidence=typeof f?.evidence==='string'?f.evidence:null;
 const id=hash(JSON.stringify([source.file,source.sha256,index]));
 return {source_id:id,source_file:source.file,source_sha256:source.sha256,index,
  reviewer:source.reviewer,round:source.round,digest:source.digest,verdict:source.verdict,
  ac_ids:findingCriteria(f,source.blocking),file:safePath(file)?file:null,line,
  file_sha256:post?.files?.[file]?.sha256??null,issue:clip(issue,1500),issue_hash:hash(issue),
  severity:typeof f?.severity==='string'?f.severity:'unknown',suggestion:clip(f?.suggestion,1000),
  evidence_hash:evidence===null?null:hash(evidence),evidence:clip(evidence,500)};
}

export function captureFindings(root,state,dir,source,post) {
 try{
  const raw=fs.readFileSync(path.join(dir,source.file)),sha256=hash(raw);
  const brief=optional(dir,`brief-${source.round}.json`)??optional(dir,'initial-brief.json');
  const rows=(source.findings??[]).map((f,index)=>{
   const row=observation({...source,sha256},f,index,post);
   const lines=row.file&&sourceLines(root,post,row.file,brief?.scope?.paths??[]);
   if(lines&&row.line&&row.line<=lines.length){
    const start=Math.max(0,row.line-3),end=Math.min(lines.length,row.line+2);
    const context={hash:hash(lines.slice(start,end).join('\n')),length:end-start,offset:row.line-1-start};
    row.context={...context,unique:locations(lines,context).length===1};
   }
   return row;
  });
  const file=observationName(source.file);
  if(!fs.existsSync(path.join(dir,file)))immutable(path.join(dir,file),{revision:1,task_id:state.task_id,source_file:source.file,source_sha256:sha256,rows});
  return {status:'recorded',file};
 }catch{return {status:'unavailable',source_file:source.file};}
}

function sources(state,dir,warnings,names) {
 const out=[];
 for(const file of names){
  const consult=/^consult-result-(c\d+)-(m\d+)\.json$/.exec(file),manual=/^review-(\d+)(?:-verify)?\.json$/.exec(file);
  if(!consult&&!manual)continue;
  try{
   const raw=read(path.join(dir,file));
   if(consult){
    const [,id,member]=consult,meta=optional(dir,`consult-${id}.json`);
    if(meta?.mode!=='review')continue;
    if(raw.task_id!==state.task_id||raw.consult_id!==id||raw.member!==member)throw Error('provenance');
    const finish=optional(dir,`consult-${id}-finish.json`);
    if(finish?.violated){warnings.push({code:'VOIDED_REVIEW',file});continue;}
    const request=optional(dir,`consult-${id}-${member}.json`);
    const brief=JSON.parse(request?.prompt??'null')?.brief;
    const reviewer=meta.members?.find(m=>m.member===member)?.executor;
    if(!reviewer||brief?.task_id!==state.task_id||!Number.isSafeInteger(brief.round))throw Error('assignment');
    out.push({file,sha256:hash(fs.readFileSync(path.join(dir,file))),round:brief.round,
     digest:optional(dir,`consult-${id}-base.json`)?.digest??null,reviewer,
     verdict:raw.recommended_verdict,blocking:raw.blocking_criteria??[],findings:raw.findings??[],
     pending:!finish||!(state.consults??[]).some(c=>c.id===id&&!c.violated)});
   }else{
    // Adopted/delegated records point to the raw consult, so do not count twice.
    if(raw.consult_id)continue;
    out.push({file,sha256:hash(fs.readFileSync(path.join(dir,file))),round:Number(manual[1]),
     digest:raw.reviewed_digest??optional(dir,`post-${manual[1]}.json`)?.digest??null,
     reviewer:raw.reviewed_by??'lead',verdict:raw.verdict,blocking:raw.blocking_criteria??[],findings:raw.findings??[]});
   }
  }catch{warnings.push({code:'REVIEW_SOURCE_UNREADABLE',file});}
 }
 return out;
}

export function findingLedger(state,dir) {
 const warnings=[],groups=new Map(),rows=[],names=fs.readdirSync(dir).sort(),resolutionFiles=new Map();
 // One fresh directory inventory per call. Index annotations once rather than
 // scanning the same names again for every issue; their evidence is still read
 // and validated below on every inspection, with no cached approval result.
 for(const file of names){
  const match=/^finding-resolution-(F-[a-f0-9]{24})-/.exec(file);
  if(!match||!file.endsWith('.json'))continue;
  const files=resolutionFiles.get(match[1])??[];files.push(file);resolutionFiles.set(match[1],files);
 }
 const map=optional(dir,`finding-map-${state.iteration}.json`);
 for(const source of sources(state,dir,warnings,names)){
  const post=optional(dir,`post-${source.round}.json`);
  const cached=optional(dir,observationName(source.file));
  const cacheValid=cached?.revision===1&&cached.task_id===state.task_id&&cached.source_sha256===source.sha256;
  const findings=Array.isArray(source.findings)?source.findings:[];
  if(!Array.isArray(source.findings))warnings.push({code:'FINDINGS_INVALID',file:source.file});
  for(const [index,f] of findings.entries()){
   const row=observation(source,f,index,post),context=cacheValid&&Array.isArray(cached.rows)?cached.rows.find(r=>r?.source_id===row.source_id):null;
   if(context?.file_sha256===row.file_sha256&&context?.file===row.file&&context?.line===row.line&&context?.issue_hash===row.issue_hash)row.context=context.context??null;
   row.pending=!!source.pending;
   const mapping=map?.revision===1&&map.digest===state.post_digest?map.locations?.[row.source_id]:null;
   row.current_location=mapping??{status:row.digest===state.post_digest?'original':'unmapped',line:row.digest===state.post_digest?row.line:null};
   rows.push(row);
   // Exact duplicate display grouping only. Unlocated/unknown evidence stays separate.
   const key=row.file&&row.line&&row.digest&&row.file_sha256
    ?JSON.stringify([row.ac_ids,row.file,row.line,row.digest,row.file_sha256,row.issue_hash,row.evidence_hash])
    :row.source_id;
   const id='F-'+hash(key).slice(0,24),group=groups.get(id)??{id,file:row.file,line:row.line,ac_ids:row.ac_ids,issue:row.issue,
    evidence_hash:row.evidence_hash,observations:[],disposition:'unresolved'};
   group.observations.push(row);groups.set(id,group);
  }
 }
 for(const group of groups.values()){
  group.disagreement=new Set(group.observations.map(r=>r.verdict)).size>1||new Set(group.observations.map(r=>r.severity)).size>1;
  group.requires_current_review=group.observations.some(r=>r.digest!==state.post_digest);
  const resolutions=resolutionFiles.get(group.id)??[];
  group.resolution_records=resolutions;
  for(const file of resolutions){
   const r=optional(dir,file);
   if(validResolution(r,group,state,dir)){
    group.disposition='fixed';group.resolution={file,digest:r.digest,reason:r.reason,evidence:[r.acceptance_file,r.review_file]};
   }else warnings.push({code:'RESOLUTION_STALE_OR_INVALID',file});
  }
 }
 return {revision:1,task_id:state.task_id,digest:state.post_digest??null,authoritative:false,
  issues:[...groups.values()],source_count:new Set(rows.map(r=>r.source_file)).size,observation_count:rows.length,warnings,
  note:'Presentation only. Raw reviews, prior rejections and mandatory digest/panel checks remain authoritative.'};
}
const hashFile=(dir,file)=>{try{return typeof file==='string'&&path.basename(file)===file?hash(fs.readFileSync(path.join(dir,file))):null;}catch{return null;}};

function validResolution(r,group,state,dir) {
 if(r?.revision!==1||r.finding_id!==group.id||r.digest!==state.post_digest||r.round!==state.iteration||!Array.isArray(r.source_ids)||r.source_ids.length!==group.observations.length||!group.observations.every(o=>r.source_ids.includes(o.source_id)&&o.digest!==r.digest))return false;
 if(!r.acceptance_sha256||!r.review_sha256||r.acceptance_sha256!==hashFile(dir,r.acceptance_file)||r.review_sha256!==hashFile(dir,r.review_file))return false;
 const acceptance=optional(dir,r.acceptance_file),review=optional(dir,r.review_file);
 return acceptance?.tree_digest===r.digest&&acceptance.round===r.round&&acceptance.status==='pass'&&acceptance.quiescent===true&&acceptance.results?.length>0&&acceptance.results.every(row=>row.status==='pass'&&row.quiescence?.quiescent===true)
  &&(review?.verdict==='pass'&&review.reviewed_digest===r.digest&&review.round===r.round||review?.decision==='APPROVE'&&review.baseline_digest===r.digest&&review.round===r.round);
}

export function recordFindingMap(root,state,dir,post) {
 try{
  const ledger=findingLedger(state,dir),scope=optional(dir,`brief-${state.iteration}.json`)?.scope?.paths??[];
  const mapped=Object.create(null),cache=new Map();
  for(const row of ledger.issues.flatMap(g=>g.observations)){
   if(!row.file)continue;
   if(post.files[row.file]?.sha256===row.file_sha256){mapped[row.source_id]={status:'unchanged',line:row.line};continue;}
   if(!cache.has(row.file))cache.set(row.file,sourceLines(root,post,row.file,scope));
   const hits=row.context?.unique?locations(cache.get(row.file),row.context):[];
   mapped[row.source_id]=hits.length===1?{status:'mapped',line:hits[0],context_hash:row.context.hash}:hits.length>1?{status:'ambiguous',line:null,candidates:hits.slice(0,10)}:{status:'unmapped',line:null};
  }
  immutable(path.join(dir,`finding-map-${state.iteration}.json`),{revision:1,task_id:state.task_id,digest:post.digest,locations:mapped});
 }catch{/* A failed observation cannot alter finish, review or approval. */}
}

export function findingSummary(ledger,limit=12) {
 const unresolved=ledger.issues.filter(g=>g.disposition!=='fixed');
 return {authoritative:false,total:ledger.issues.length,unresolved:unresolved.length,
  displayed:unresolved.slice(0,limit).map(g=>({id:g.id,file:g.file,line:g.line,ac_ids:g.ac_ids,issue:clip(g.issue),
   disagreement:g.disagreement,requires_current_review:g.requires_current_review,
   sources:g.observations.slice(0,8).map(r=>({file:r.source_file,index:r.index,reviewer:r.reviewer,round:r.round,digest:r.digest,verdict:r.verdict,severity:r.severity,current_location:r.current_location})),omitted_sources:Math.max(0,g.observations.length-8)})),
  omitted:Math.max(0,unresolved.length-limit),warnings:ledger.warnings.slice(0,10)};
}

export function safeFindingSummary(state,dir) {
 try{return findingSummary(findingLedger(state,dir));}
 catch{return {authoritative:false,total:null,unresolved:null,displayed:[],warnings:[{code:'FINDING_LEDGER_UNAVAILABLE'}]};}
}

// 리드의 지적별 처분. act는 이번 작업에서 고칠 것, consider는 고칠지 다음 일꾼이 판단할 것, noted는 기록만, dismissed는 기각,
// contract_misread는 리뷰어 잘못이 아니라 브리프·수용 기준이 모호했다는 뜻이다. 승인 근거가 아닌 관찰 기록이다.
export const FINDING_BUCKETS=['act','consider','noted','dismissed','contract_misread'];
const FORWARDED_BUCKETS=['act','consider','contract_misread'];
export function findingDispositions(state,dir,list) {
 const fail=reason=>{throw Error('LEAD_DECISION: finding_dispositions '+reason);};
 if(!Array.isArray(list)||!list.length||list.length>64)fail('must be a non-empty array of at most 64 entries');
 const issues=findingLedger(state,dir).issues,seen=new Set();
 return list.map(d=>{
  if(!d||typeof d!=='object'||Array.isArray(d)||Object.keys(d).some(k=>!['finding_id','bucket','reason'].includes(k)))fail('entries take only finding_id, bucket and reason');
  if(typeof d.finding_id!=='string'||!/^F-[a-f0-9]{24}$/.test(d.finding_id))fail('need a finding_id from the finding summary (F-…)');
  if(!FINDING_BUCKETS.includes(d.bucket))fail('bucket must be one of '+FINDING_BUCKETS.join(', '));
  const reason=typeof d.reason==='string'?d.reason.trim():'';
  if(!reason||reason.length>1000)fail(`need a reason of at most 1000 characters for ${d.finding_id}`);
  if(seen.has(d.finding_id))fail(`repeat ${d.finding_id}`);
  seen.add(d.finding_id);
  // 이번 라운드 digest에서 끝난 리뷰의 지적만 처분한다. 이전 라운드 지적은 현재 리뷰가 다시 봐야 한다.
  const current=issues.find(g=>g.id===d.finding_id)?.observations.filter(r=>r.round===state.iteration&&r.digest===state.post_digest&&!r.pending)??[];
  if(!current.length)fail(`${d.finding_id} is not a finding reviewed on this round's digest`);
  return {finding_id:d.finding_id,bucket:d.bucket,reason,reviewers:[...new Set(current.map(r=>r.reviewer))].sort(),
   severities:[...new Set(current.map(r=>r.severity))].sort()};
 });
}

export function revisionPacket(state,dir) {
 const ledger=findingLedger(state,dir),view=findingSummary(ledger,16),last=state.reviews?.at(-1);
 const feedback=[];
 // 리드가 이번 라운드에 기각하거나 기록만 한 지적은 다음 일꾼에게 넘기지 않는다. 반려 사유(Unmet)는 그대로 넘긴다.
 const decided=optional(dir,`lead-decision-${state.iteration}.json`);
 const disposed=new Map((decided?.baseline_digest===state.post_digest?decided.finding_dispositions??[]:[]).map(d=>[d.finding_id,d]));
 const withheld=[];
 for(const issue of ledger.issues.filter(g=>g.disposition!=='fixed').filter(g=>{
  const d=disposed.get(g.id);
  if(d&&!FORWARDED_BUCKETS.includes(d.bucket)){withheld.push({finding_id:g.id,bucket:d.bucket});return false;}
  return true;
 }).slice(0,16)){
  const row=issue.observations.at(-1),location=row.current_location;
  const line=['original','unchanged','mapped'].includes(location.status)?location.line:null;
  const d=disposed.get(issue.id),note=d?` [lead: ${d.bucket} — ${clip(d.reason,200)}]`:'';
  const comment=clip(`${issue.id} ${issue.ac_ids.join(' ')}: ${issue.issue}${row.suggestion?' → '+row.suggestion:''}${issue.disagreement?' [review disagreement: inspect all sources]':''}${note}`,800);
  if(issue.file&&line)feedback.push({file:issue.file,line,comment});
  else feedback.push(`${comment} [historical location ${issue.file??'unknown'}:${issue.line??'?'}; re-locate before editing]`);
 }
 for(const criterion of (last?.blocking_criteria??[]).slice(0,12))feedback.push(clip(`Unmet: ${criterion}`,500));
 for(const item of (last?.acceptance_feedback??[]).slice(0,8))feedback.push(clip(typeof item==='string'?item:JSON.stringify(item),600));
 if(!feedback.length)throw Error('REVISION_PACKET_EMPTY: no unresolved findings or rejection to forward');
 feedback.push('This packet is non-authoritative. Preserve the original scope, unresolved rejection history and required cumulative review. Missing/truncated evidence requires lead inspection.');
 return {revision:1,task_id:state.task_id,round:state.iteration,digest:state.post_digest??null,scope:optional(dir,`brief-${state.iteration}.json`)?.scope??null,
  finding_summary:view,blocking_criteria:(last?.blocking_criteria??[]).slice(0,12),omitted_blockers:Math.max(0,(last?.blocking_criteria?.length??0)-12),
  ...(withheld.length?{withheld_by_lead:withheld}:{}),feedback};
}

export function resolveFinding(c,input) {
 const fail=reason=>{throw Error('FINDING_RESOLUTION: '+reason);};
 if(c.writerHeld()||c.s.open_consult||!['VERIFY','CLOSE'].includes(c.s.phase))fail('requires a settled round with current review approval');
 if(typeof input.finding_id!=='string'||!/^F-[a-f0-9]{24}$/.test(input.finding_id)||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>1000)fail('finding_id and a bounded reason are required');
 const s=c.s,dir=c.taskdir(),ledger=findingLedger(s,dir),issue=ledger.issues.find(g=>g.id===input.finding_id);
 if(!issue||!issue.ac_ids.length||issue.observations.some(r=>r.digest===s.post_digest||r.pending))fail('requires a settled prior-digest finding with mapped AC ids');
 if(snapshot(c.root).digest!==s.post_digest)fail('tree drift');
 const a=s.acceptance,acceptance=a?.file?c.optional(a.file):null;
 if(a?.round!==s.iteration||a.status!=='pass'||a.quiescent!==true||a.tree_digest!==s.post_digest||acceptance?.tree_digest!==s.post_digest||!acceptance?.results?.length||!acceptance.results.every(r=>r.status==='pass'&&r.quiescence?.quiescent===true))fail('new passing controller acceptance with shutdown proof is required');
 const brief=c.optional(`brief-${s.iteration}.json`),ignored=a.ignored_after?c.optional(a.ignored_after):null;
 if(!ignored||ignoredChanges(ignored,ignoredManifest(c.root,brief?.acceptance_artifacts)).length)fail('acceptance ignored inputs changed or are unproven');
 const table=acTable(brief,acceptance.results);
 if(issue.ac_ids.some(id=>!table.some(row=>row.id===id&&row.status==='PASS')))fail('every finding AC needs current passing command evidence');
 const classic=s.reviews?.findLast(r=>r.verdict==='pass'&&r.round===s.iteration&&r.reviewed_digest===s.post_digest);
 const lead=s.lead_decision?.decision==='APPROVE'&&s.lead_decision.round===s.iteration&&s.lead_decision.baseline_digest===s.post_digest?s.lead_decision:null;
 const review_file=lead?lead.file:classic?fs.existsSync(path.join(dir,`review-${s.iteration}-verify.json`))?`review-${s.iteration}-verify.json`:`review-${s.iteration}.json`:null;
 if(!review_file||!hashFile(dir,review_file))fail('current-digest review approval is required');
 const approval=c.optional(review_file);
 if(!(approval?.verdict==='pass'&&approval.reviewed_digest===s.post_digest||approval?.decision==='APPROVE'&&approval.baseline_digest===s.post_digest))fail('approval artifact does not match the current digest');
 const file=`finding-resolution-${issue.id}-${s.post_digest.slice(0,16)}.json`;
 const record={revision:1,finding_id:issue.id,digest:s.post_digest,round:s.iteration,reason:input.reason.trim(),
  source_ids:issue.observations.map(r=>r.source_id),acceptance_file:a.file,acceptance_sha256:hashFile(dir,a.file),review_file,review_sha256:hashFile(dir,review_file),authoritative:false};
 const prior=optional(dir,file);
 if(prior){if(JSON.stringify(prior)!==JSON.stringify(record))fail('resolution already recorded; original record preserved');return {status:'RECORDED',file,authoritative:false};}
 immutable(path.join(dir,file),record);return {status:'RECORDED',file,authoritative:false};
}
