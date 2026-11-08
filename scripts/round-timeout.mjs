// 일꾼 한 번 실행의 기본 상한. 설정 executors.<이름>.timeout_ms가 있으면 그 값이 이긴다.
// 구현 라운드는 40분이다. L03 HF에서 Grok은 20분 동안 추론 15번과 도구 71번(테스트 300초, 출력 대기 180초 포함)을 쓰고도 끝내지 못했다.
// 리뷰·상담은 읽기 전용이라 20분 그대로 둔다.
export const ROUND_TIMEOUT_MS={implement:2400000,consult:1200000};
export const defaultTimeout=role=>role==='implement'?ROUND_TIMEOUT_MS.implement:ROUND_TIMEOUT_MS.consult;
