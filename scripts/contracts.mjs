const requireThat=(v,m)=>{if(!v)throw Error(m);};
const str=v=>typeof v==='string'&&v.trim().length>0;
const strs=v=>Array.isArray(v)&&v.every(str);
export function safePath(v) {return str(v)&&!v.startsWith('/')&&!v.includes('\\')&&!v.includes('\0')&&!v.split('/').some(x=>['..','.git','.fusion',''].includes(x));}
export function brief(v) {
 requireThat(v&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(v.task_id),'Invalid task_id');
 requireThat(str(v.objective),'Missing objective');
 requireThat(v.scope&&Array.isArray(v.scope.paths)&&v.scope.paths.length&&v.scope.paths.every(safePath)&&v.scope.allowed_expansion==='ask-lead','Invalid bounded scope');
 for(const k of ['constraints','success_criteria','allowed_actions','forbidden_actions','evidence_required'])requireThat(strs(v[k]),'Invalid '+k);
 requireThat(v.success_criteria.length>0,'Acceptance criteria empty');
 requireThat(v.allowed_actions.every(x=>['read','edit','test','lint','build'].includes(x)),'Unsupported action');
 for(const k of ['commit','push','deploy','release','scope-expansion'])requireThat(v.forbidden_actions.includes(k),'Missing forbidden action '+k);
 for(const k of ['files_changed','commands_run','test_results','remaining_risks'])requireThat(v.evidence_required.includes(k),'Missing evidence '+k);
 return v;
}
export function result(v,task_id,round) {
 requireThat(v&&v.task_id===task_id&&v.round===round,'Result provenance mismatch');
 requireThat(['complete','blocked','needs_decision','failed'].includes(v.status),'Invalid status');
 requireThat(str(v.summary),'Missing summary');
 for(const k of ['files_read','files_changed','commands_run','unresolved','risks']) requireThat(strs(v[k]),'Invalid '+k);
 requireThat(v.files_changed.every(safePath)&&v.files_read.every(safePath),'Invalid result paths');
 requireThat(typeof v.needs_lead_decision==='boolean'&&str(v.recommended_next_action),'Invalid decision fields');
 requireThat(v.status!=='needs_decision'||v.needs_lead_decision,'Decision flag missing');
 requireThat(Array.isArray(v.tests)&&v.tests.every(x=>str(x.command)&&['pass','fail','not_run'].includes(x.status)),'Invalid tests');
 requireThat(v.status!=='complete'||(!v.needs_lead_decision&&!v.unresolved.length&&!v.tests.some(t=>t.status==='fail')),'Contradictory complete result');
 return v;
}
export function review(v) {
 requireThat(v&&['pass','redo','decision','escalate','alternative','takeover','helper','resume'].includes(v.verdict),'Invalid verdict');
 requireThat(str(v.rationale)&&strs(v.blocking_criteria)&&strs(v.commands_run),'Invalid review evidence');
 requireThat(v.independent_diff_review===true,'Independent diff review required');
 requireThat(v.verdict!=='pass'||v.blocking_criteria.length===0,'Cannot pass blocking criteria');
 return v;
}
export function escalation(reviews,resultFailures=0,flags={}) {
 const last=reviews.slice(-2);
 const repeated=last.length===2&&last[0].blocking_criteria.some(c=>last[1].blocking_criteria.includes(c));
 const score=(flags.three_subsystems?2:0)+(flags.unexplained_failure?2:0)+(flags.complex_state?2:0)+(flags.eight_files?1:0)+(flags.large_diff?1:0)+(flags.toolchain?1:0);
 const hard=repeated||resultFailures>=2||flags.repeated_regression===true||flags.complex_state===true||flags.strategy_blocked===true;
 return {hard,score,recommendation:hard?'review_strategy_or_alternative':score>=3?'inspect_capability':'resume_current'};
}
