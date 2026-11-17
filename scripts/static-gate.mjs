// 정적 검사 관문(references/static-gate.md). 린트·타입 검사처럼 어느 작업에나 걸리는 규칙을 컨트롤러가 직접 돌린다.
// 실행은 수용 테스트와 같은 감독 실행기(acceptance.mjs의 runCommands)를 쓴다. 여기에는 판정과 문구만 둔다.
// 정적 검사 통과는 리뷰 통과나 AC 증명이 아니다. 실패하면 되돌릴 근거가 될 뿐이다.

export const STATIC_TIMEOUT_MS=120000;
export const STATIC_TAIL_BYTES=4096;

const tail=text=>{const b=Buffer.from(String(text??''),'utf8');return b.length<=STATIC_TAIL_BYTES?b.toString('utf8'):b.subarray(b.length-STATIC_TAIL_BYTES).toString('utf8').replace(/^�+/,'');};

// 손대지 않은 트리에서의 결과를 판정한다. 받을 수 있으면 null, 아니면 "CODE: 설명" 문자열.
// dirty: 명령이 바꾼 경로(비어 있으면 바꾸지 않았다).
export function staticBaselineError(results,dirty=[]) {
 if(dirty.length)return `STATIC_DIRTY: running static_commands on the untouched tree changed it (${dirty.join(', ')}); drop auto-fix flags such as --fix, restore the tree, then retry`;
 const unrunnable=results.filter(r=>r.status==='not_run'||r.timed_out===true||!!r.error||['PROCESS_TABLE_UNAVAILABLE','PROCESS_TABLE_TIMEOUT','ACCEPTANCE_SUPERVISOR_FAILED','OUTPUT_LIMIT'].includes(r.code));
 if(unrunnable.length)return 'STATIC_UNVERIFIED: static commands could not run to completion ('
  +unrunnable.map(r=>`${r.command}: ${r.timed_out?'timed out':r.error??r.code??r.status}`).join('; ')+'); fix the command or raise static_timeout_ms, then retry';
 const failed=results.filter(r=>r.status!=='pass');
 if(failed.length)return 'STATIC_BASELINE_FAILING: static_commands must pass on the untouched tree, otherwise they cannot tell new violations from old ones. '
  +'Narrow them to paths that already pass (for example src/rules instead of the whole repository). '
  +failed.map(r=>`\`${r.command}\` exited with ${r.exit_code}. Output tail:\n${tail(r.output_tail).trim()||'(no output)'}`).join('\n');
 return null;
}

// 반려 사유. 같은 명령으로 두 번 되돌아가면 반복 반려 규칙(criterionKeys)이 같은 사유로 본다.
export const staticCriteria=failed=>failed.map(r=>'STATIC: '+r.command);

// 재지시 항목. 수용 실패의 failureFeedback과 같은 모양이다.
export function staticFeedback(results) {
 return results.filter(r=>r.status!=='pass').map(r=>{
  const why=r.timed_out?'timed out':r.error?`could not start (${r.error})`:`exited with ${r.exit_code}${r.signal?' / '+r.signal:''}`;
  return `Static check \`${r.command}\` ${why}. Fix the reported problems in your changes; do not edit lint or type-check configuration or add disable comments. Output tail:\n${tail(r.output_tail).trim()||'(no output)'}`;
 });
}

// VERIFY가 finish 때의 기록을 다시 쓸 수 있는지. 수용 테스트의 passingAcceptanceRecord와 같은 조건이다.
export function passingStaticRecord(record,commands,round,digest) {
 if(record?.kind!=='static'||record.status!=='pass'||record.quiescent!==true||record.round!==round||record.tree_digest!==digest)return false;
 if(!commands?.length||!Array.isArray(record.commands)||!Array.isArray(record.results))return false;
 if(record.commands.length!==commands.length||record.results.length!==commands.length)return false;
 return commands.every((command,i)=>{
  const result=record.results[i];
  return record.commands[i]===command&&result?.command===command&&result.status==='pass'&&result.quiescence?.quiescent===true;
 });
}
