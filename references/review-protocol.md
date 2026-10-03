# 검수 프로토콜

변경이 끝난 뒤 리드가 실제 diff와 관련 내용을 독립적으로 본다. 일꾼의 요약은 단서일 뿐 증거가 아니다. 판정 입력:

```json
{"verdict":"redo","rationale":"...","blocking_criteria":["AC2"],"commands_run":["git diff","npm test"],"independent_diff_review":true}
```

- `pass` 외 판정은 `blocking_criteria`가 비어 있으면 거절된다.
- `pass`는 결과 status가 complete일 때만 가능하다.

| 판정 | 다음 |
|---|---|
| pass | VERIFY. 리드가 수용 테스트를 직접 돌린다 |
| redo | 같은 일꾼, 같은 세션. 예산이 없으면 교체/takeover/BLOCKED |
| alternative (`escalate` 별칭) | 다른 일꾼. 생략 시 배치 순서상 다음 일꾼. 예산 있는 다른 일꾼이 없으면 거절 |
| decision | 리드가 설계/요구사항 결정 후 같은 일꾼 REDO |
| takeover | 모든 일꾼이 소진됐을 때만. 아니면 거절 |

## 자동 교체 규칙

같은 일꾼이 연속 두 라운드에서 같은 `blocking_criteria`를 받으면, 예산 있는 다른 일꾼이 있을 경우 `redo`여도 ALTERNATIVE_REQUIRED로 넘어간다. 같은 실수를 세 번 시키지 않는다. 일꾼이 한 명뿐이면 예산 끝까지 같은 일꾼을 돌린다.

참고 신호(점수 3 이상이면 전략·일꾼 적합성 재검토): 서브시스템 경계 3개 +2, 원인 불명 테스트 실패 +2, 복잡한 영속/동시성/마이그레이션 상태 +2, 파일 8개 +1, 약 400줄 변경 +1, 툴체인 영향 +1. 판정 입력의 `complexity` 객체로 넘긴다. 반복 회귀나 `complex_state`는 hard 신호다.

권한 거절은 권한 문제로 다룬다. 다른 일꾼에게 넘겨 우회하지 않는다. 검수는 수용 기준과 실질 위험을 입증할 만큼만 하고, 일꾼의 전체 실행 기록을 기계적으로 다시 읽지 않는다.
