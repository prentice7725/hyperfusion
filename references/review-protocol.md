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

## 위임 리뷰 (`review.by: "delegate"`)

리드는 Opus 그대로 두고, 라운드 리뷰만 다른 모델에게 맡긴다. Opus가 diff를 정독하는 비용이 리드 토큰에서 가장 크기 때문이다.

```json
{"review": {"by": "delegate", "reviewers": ["codex", "sonnet", "antigravity", "grok"], "auto_apply": true}}
```

1. `finish` 후 REVIEW에서 `fusion-state.mjs delegate-review REPO [INPUT.json]`을 실행한다. 입력은 생략할 수 있다. `{"executors":["codex"]}`로 리뷰어를 지정할 수 있다.
2. 반환된 명령(브리지 `--consult <id>`)을 한 번 실행하고, `consult-finish REPO {"quiescent":true}`를 호출한다.
3. `auto_apply: true`(기본)면 리뷰어의 판정(pass/redo/alternative/decision), 반려 사유, 파일·줄 지적이 그대로 적용된다. `false`면 `pending_review`로 남는다. 리드가 `review {"adopt":true}`로 채택하거나 자기 판정을 내린다.

규칙:
- **자기 작업은 자기가 리뷰하지 않는다.** 리뷰어는 그 라운드를 구현한 일꾼과 달라야 한다. 리드가 takeover로 직접 쓴 코드도 다른 모델이 리뷰한다.
- **리뷰어 우선순위:** 기본 순서는 Codex(GPT, 리드와 다른 계열이라 교차 검증에 가장 유리) → Sonnet → Antigravity → Grok이다. 설치 안 된 리뷰어는 건너뛴다. Codex는 리뷰·상담만 하고 구현 lease는 받지 않는다.
- **리뷰는 읽기 전용이다.** 상담과 같은 장치로 돌고, 전후 스냅샷이 다르면 판정을 버리고 RECOVERY_REQUIRED로 간다.
- **리드 전용 판정:** 리뷰어는 `takeover`를 낼 수 없다. `decision`을 내면 DECISION_REQUIRED가 되어 설계 판단은 리드가 한다.
- **미완료 보고:** 일꾼이 미완료(`blocked` 등)라고 보고한 라운드는 리뷰어가 pass를 줘도 redo(`worker reported …`)로 바뀐다.
- **판정 형식:** pass가 아닌데 반려 사유가 비어 있는 판정은 형식 오류로 버린다. 리뷰어가 실패하면 다음 리뷰어를 부르거나 리드가 직접 본다. 라운드당 위임 리뷰는 2회까지이고, 상담 예산(4회)과는 별개다.
- **보류되는 판정:** 적용할 수 없는 판정(예: 교체할 일꾼이 없는데 alternative)은 강제하지 않는다. 사유와 함께 보류하고 리드가 결정한다.
- **리드의 덮어쓰기:** 리드는 언제든 `review`로 자기 판정을 내릴 수 있다. 위임 판정을 덮어쓰면 `overrode`로 기록되고 metrics의 `lead_overrides`에 집계된다.
- **최종 관문:** VERIFY(수용 테스트 직접 실행)는 여전히 리드 몫이다. 위임 리뷰가 pass를 내도 리드가 테스트를 돌려 통과해야 CLOSE다.

다음 라운드 지시: `begin`에 `"lead_feedback": "@review"`를 주면 직전 리뷰의 blocker·major 지적이 `{file, line, comment}`로, 반려 사유가 `Unmet: …`로 그대로 전달된다. 리드가 diff를 다시 읽고 지시를 쓰지 않아도 된다.
