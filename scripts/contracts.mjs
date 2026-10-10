import {checkPrior} from './memory-policy.mjs';
import {checkBashRules} from './bash-policy.mjs';
import {checkAcceptanceMap} from './ac-trace.mjs';
const requireThat=(v,m)=>{if(!v)throw Error(m);};
const str=v=>typeof v==='string'&&v.trim().length>0;
const strs=v=>Array.isArray(v)&&v.every(str);
// 저장소 기준 상대 경로. 일꾼이 보고하는 경로(files_changed 등)와 리뷰어의 지적 위치에 쓴다. 스냅샷과 글자 그대로 비교하므로 글롭은 따지지 않는다.
// '.'와 './src'는 git이 돌려주는 경로와 절대 일치하지 않아 모든 변경이 범위 밖이 되므로 거절한다.
// .git/.fusion 구분은 대소문자와 Windows의 끝 점·공백, 8.3 짧은 이름(GIT~1)까지 같은 것으로 본다.
const PROTECTED=/^(?:\.git|\.fusion|git~\d+|fusion~\d+)$/i;
const CONTROL=/[\u0000-\u001f\u007f]/;
export function reportedPath(v) {
 return str(v)&&!v.startsWith('/')&&!v.includes('\\')&&!CONTROL.test(v)&&!/^[A-Za-z]:/.test(v)
  &&!v.split('/').some(x=>['..','.',''].includes(x)||PROTECTED.test(x.replace(/[. ]+$/,'')));
}
// 범위(scope)와 allow_out_of_scope에 쓰는 엄격한 경로. 쓰기 권한이 이 값으로 열리므로 글롭, 홈(~), NTFS 스트림(:), 끝 점·공백을 모두 거절한다.
export function safePath(v) {
 return reportedPath(v)&&!/[*?\[\]{}:~]/.test(v)&&!v.split('/').some(x=>x!==x.trimEnd()||x.endsWith('.')||/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(x));
}
export function brief(v) {
 v={...v,scope:{...v?.scope,allowed_expansion:v?.scope?.allowed_expansion??'ask-lead'},
  forbidden_actions:v?.forbidden_actions??['commit','push','deploy','release','scope-expansion'],
  evidence_required:v?.evidence_required??['files_changed','commands_run','test_results','remaining_risks']};
 requireThat(v&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(v.task_id),'Invalid task_id');
 requireThat(str(v.objective),'Missing objective');
 requireThat(v.scope&&Array.isArray(v.scope.paths)&&v.scope.paths.length&&v.scope.allowed_expansion==='ask-lead','Invalid bounded scope');
 const badPath=v.scope.paths.find(p=>!safePath(p));
 requireThat(badPath===undefined,`Invalid bounded scope: '${badPath}' is not a repository-relative path (no '.', '..', '.git', '.fusion', empty or trailing-slash segments)`);
 for(const k of ['constraints','success_criteria','allowed_actions','forbidden_actions','evidence_required'])requireThat(strs(v[k]),'Invalid '+k);
 requireThat(v.success_criteria.length>0,'Acceptance criteria empty');
 requireThat(v.allowed_actions.every(x=>['read','edit','test','lint','build'].includes(x)),'Unsupported action');
 for(const k of ['commit','push','deploy','release','scope-expansion'])requireThat(v.forbidden_actions.includes(k),'Missing forbidden action '+k);
 for(const k of ['files_changed','commands_run','test_results','remaining_risks'])requireThat(v.evidence_required.includes(k),'Missing evidence '+k);
 // 라우팅 힌트. 없으면 기본 규칙으로 간다.
 requireThat(v.task_kind===undefined||['code','ui','image-asset','tests','refactor','docs'].includes(v.task_kind),'Invalid task_kind');
 requireThat(v.difficulty===undefined||['low','medium','high'].includes(v.difficulty),'Invalid difficulty');
 // 수용 테스트. 컨트롤러가 finish 직후와 VERIFY에서 직접 실행한다. 리드가 쓴 brief에서만 받는다.
 requireThat(v.acceptance_commands===undefined||(Array.isArray(v.acceptance_commands)&&v.acceptance_commands.length>0&&v.acceptance_commands.length<=10
  &&v.acceptance_commands.every(x=>str(x)&&x.length<=500&&!CONTROL.test(x))),'Invalid acceptance_commands (1-10 single-line commands)');
 requireThat(v.acceptance_timeout_ms===undefined||(Number.isSafeInteger(v.acceptance_timeout_ms)&&v.acceptance_timeout_ms>0&&v.acceptance_timeout_ms<=3600000),'Invalid acceptance_timeout_ms');
 requireThat(v.acceptance_artifacts===undefined||(strs(v.acceptance_artifacts)&&v.acceptance_artifacts.length<=20&&v.acceptance_artifacts.every(g=>reportedPath(g.replace(/\*\*?|\?/g,'x'))&&!/^(?:\*\*\/)*\*{1,2}$/.test(g))),'Invalid acceptance_artifacts (repository-relative globs, not "**")');
 requireThat(v.acceptance_baseline_green===undefined||(str(v.acceptance_baseline_green)&&v.acceptance_baseline_green.length<=300),'acceptance_baseline_green must be a short reason (why the commands already pass before any change)');
 requireThat(v.acceptance_commands!==undefined||(v.acceptance_timeout_ms===undefined&&v.acceptance_artifacts===undefined&&v.acceptance_baseline_green===undefined),'acceptance options need acceptance_commands');
 // AC 추적: 어떤 수용 명령이 어떤 수용 기준(AC ID)을 증명하는지. 선택 항목이다.
 checkAcceptanceMap(v);
 checkPrior(v.prior_experience);
 // 일꾼에게 열어 줄 Bash 규칙은 작업을 시작하기 전에 거른다(디스패치 때 한 번 더 확인한다).
 checkBashRules(v.executor_bash_rules);
 return v;
}
export function result(v,task_id,round) {
 requireThat(v&&v.task_id===task_id&&v.round===round,'Result provenance mismatch');
 requireThat(['complete','blocked','needs_decision','failed'].includes(v.status),'Invalid status');
 requireThat(str(v.summary),'Missing summary');
 for(const k of ['files_read','files_changed','commands_run','unresolved','risks']) requireThat(strs(v[k]),'Invalid '+k);
 requireThat(v.files_changed.every(reportedPath)&&v.files_read.every(reportedPath),'Invalid result paths');
 requireThat(typeof v.needs_lead_decision==='boolean'&&str(v.recommended_next_action),'Invalid decision fields');
 requireThat(v.status!=='needs_decision'||v.needs_lead_decision,'Decision flag missing');
 requireThat(Array.isArray(v.tests)&&v.tests.every(x=>str(x.command)&&['pass','fail','not_run'].includes(x.status)),'Invalid tests');
 requireThat(v.status!=='complete'||(!v.needs_lead_decision&&!v.unresolved.length&&!v.tests.some(t=>t.status==='fail')),'Contradictory complete result');
 // 기억 후보는 덤으로 받는 선택 항목이다. 모양이 틀려도 라운드를 실패시키지 않는다(장부에 올릴 때 걸러서 사유와 함께 남긴다).
 requireThat(v.memory_candidates===undefined||Array.isArray(v.memory_candidates),'Invalid memory_candidates (a list of up to 3)');
 return v;
}
export function review(v) {
 requireThat(v&&['pass','redo','alternative','escalate','decision','takeover'].includes(v.verdict),'Invalid verdict');
 requireThat(str(v.rationale)&&strs(v.blocking_criteria)&&strs(v.commands_run),'Invalid review evidence');
 requireThat(v.independent_diff_review===true,'Independent diff review required');
 requireThat(v.verdict!=='pass'||v.blocking_criteria.length===0,'Cannot pass blocking criteria');
 // 반려에는 반드시 구체적인 반려 사유가 있어야 한다. "다시 해" 같은 빈 반려는 받지 않는다.
 requireThat(v.verdict==='pass'||v.blocking_criteria.length>0,'Rejection requires concrete blocking criteria');
 return v;
}
// 다음 라운드 명령서. 이전 라운드 반려 사유를 일꾼에게 그대로 들이민다.
// 문자열 또는 diff 위치를 짚는 {file, line?, comment}. 상담 findings를 그대로 옮겨 쓸 수 있다.
export function feedback(v) {
 const item=x=>str(x)||(x&&typeof x==='object'&&reportedPath(x.file)&&str(x.comment)&&(x.line===undefined||(Number.isInteger(x.line)&&x.line>=0))&&Object.keys(x).every(k=>['file','line','comment'].includes(k)));
 requireThat(Array.isArray(v)&&v.length>0&&v.every(item),'Re-dispatch requires lead_feedback: concrete orders for the worker (strings or {file, line?, comment})');
 return v;
}
export function consultResult(v,task_id,consult_id,member,mode) {
 requireThat(v&&v.task_id===task_id&&v.consult_id===consult_id&&v.member===member,'Consult provenance mismatch');
 requireThat(str(v.summary)&&typeof v.root_cause==='string'&&Array.isArray(v.plan)&&v.plan.every(x=>typeof x==='string'),'Invalid consult fields');
 requireThat(['pass','redo','alternative','decision','none'].includes(v.recommended_verdict)&&['low','medium','high'].includes(v.confidence),'Invalid consult verdict');

 if(mode==='review'){
  requireThat(v.recommended_verdict!=='none'&&Array.isArray(v.blocking_criteria)&&v.blocking_criteria.every(str),'Review needs a verdict and blocking_criteria');
  requireThat(v.recommended_verdict==='pass'?v.blocking_criteria.length===0:v.blocking_criteria.length>0,'Review verdict and blocking_criteria disagree');
 }
 requireThat(Array.isArray(v.findings)&&v.findings.every(f=>f&&reportedPath(f.file)&&Number.isInteger(f.line)&&f.line>=0&&['blocker','major','minor','nit'].includes(f.severity)&&str(f.issue)&&typeof f.suggestion==='string'),'Invalid consult findings');
 return v;
}
// 반려 사유를 비교할 열쇠. AC1 같은 수용 기준 ID가 있으면 그 ID만 본다(표현이 바뀌어도 같은 사유).
// ID가 없으면 대소문자·문장부호·공백을 걸러낸 문장으로 비교한다.
export function criterionKeys(text) {
 const ids=String(text).match(/\bAC\d+\b/gi);
 if(ids)return [...new Set(ids.map(x=>x.toUpperCase()))];
 return [String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim()];
}
const keysOf=list=>new Set(list.flatMap(criterionKeys));
export function escalation(reviews,resultFailures=0,flags={}) {
 const last=reviews.slice(-2);
 const repeated=last.length===2&&[...keysOf(last[0].blocking_criteria)].some(k=>keysOf(last[1].blocking_criteria).has(k));
 const score=(flags.three_subsystems?2:0)+(flags.unexplained_failure?2:0)+(flags.complex_state?2:0)+(flags.eight_files?1:0)+(flags.large_diff?1:0)+(flags.toolchain?1:0);
 const hard=repeated||resultFailures>=2||flags.repeated_regression===true||flags.complex_state===true||flags.strategy_blocked===true;
 return {hard,score,recommendation:hard?'review_strategy_or_alternative':score>=3?'inspect_capability':'resume_current'};
}
