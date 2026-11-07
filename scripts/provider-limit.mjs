// 사용량·요금 한도에 걸려 실패한 실행을 알아본다. 실패한 실행의 stderr와 CLI가 돌려준 오류 메시지만 본다.
// 일꾼이 작업하며 쓴 출력(코드, 문서)은 보지 않는다. 한도를 다루는 작업이 그 단어를 쓴다고 일꾼을 빼면 안 된다.
// 한 번 걸린 CLI는 이 작업 동안 쓰지 않는다. 한도는 보통 몇 시간 단위로 풀리고, 그사이 재시도는 같은 실패를 되풀이한다.
export const LIMIT_TEXT=/usage[ _-]?limit|rate[ _-]?limit(?:ed|[ _-]?(?:reached|exceeded|error))|insufficient[ _-]?quota|exceeded (?:your|the) (?:current )?quota|quota (?:exceeded|exhausted)|resource[ _-]?exhausted|too many requests|out of credits|credit balance is too low/i;
export const limitFailureFile=tag=>`limit-failure-${tag}.json`;
export const LIMIT_FAILURE_FILE=/^limit-failure-.+\.json$/;

// 한도 문구가 있는 첫 줄(최대 200자). 없으면 null.
export function limitHit(text) {
 const line=String(text??'').split(/\r?\n/).find(l=>LIMIT_TEXT.test(l));
 return line?line.trim().slice(0,200):null;
}
