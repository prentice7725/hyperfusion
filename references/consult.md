# 상담: advisor와 committee

Paseo의 `/paseo-advisor`, `/paseo-committee`를 이 프로토콜에 맞게 들여온 기능이다. 일꾼을 **읽기 전용**으로 불러 판단 근거만 받는다. writer lease를 잡지 않고 구현 예산도 쓰지 않는다. 대신 작업당 위원 실행 4회(`CONSULT_CAP`) 상한이 있다.

| 모드 | 인원 | 쓰는 때 | 기대 효과 |
|---|---|---|---|
| `advisor` | 1 | REVIEW에서 Opus가 diff를 꼼꼼히 읽기 전에 다른 일꾼에게 먼저 검사시킬 때. PLAN에서 계획을 점검받을 때 | Opus가 읽을 양이 줄고, 자기 작업을 자기가 검사하는 일이 없다 |
| `committee` | 2 (서로 다른 일꾼) | 같은 반려가 반복될 때, 교체 전에 원인과 계획부터 받을 때 | 다음 일꾼에게 "다시 해"가 아니라 근본 원인과 실행 계획을 넘긴다 |

## 사용

```json
{"mode":"advisor","question":"이 diff가 AC1, AC2를 만족하나? 빠진 경계 조건은?","focus":["src/auth/refresh.ts"]}
```

1. `fusion-state.mjs consult REPO INPUT.json` → `consult_id`, 위원 명단, 실행할 `command`/`args`.
2. 반환된 명령을 **한 번** 실행한다(`executor-bridge.mjs REPO --consult c1`). 위원들이 병렬로 돈다.
3. `fusion-state.mjs consult-finish REPO {"quiescent":true}` → 위원별 결과(`findings`, `root_cause`, `plan`, `recommended_verdict`, `confidence`).
4. 결과는 참고 자료다. 판정은 리드가 직접 한다. `findings`의 `{file, line, issue}`는 그대로 다음 brief의 `lead_feedback` 항목(`{file, line, comment}`)으로 옮길 수 있다.

- 허용 단계: PLAN, REVIEW, REDO, ALTERNATIVE_REQUIRED, DECISION_REQUIRED. writer가 있으면 안 된다.
- 상담이 열려 있는 동안은 `status`와 `consult-finish` 외 모든 동작이 막힌다.
- `executors`를 생략하면 배치 순서에서 **방금 일한 일꾼을 뒤로** 미루고 설치된 일꾼을 고른다. 이름을 주면 그 일꾼이 설치돼 있어야 한다.
- 위원은 매번 새 세션이다. 구현 세션을 오염시키지 않는다.
- 위원에게는 목표, 범위, 수용 기준, 최근 반려 사유, 직전 결과, 변경 파일 목록과 `git diff HEAD`(12,000자까지)가 들어간다. 새로 만든 파일은 diff에 없으니 위원이 직접 읽는다.

## 읽기 전용 보증

| 일꾼 | 실행 방식 |
|---|---|
| Sonnet | `--tools Read,Glob,Grep`. 편집 도구도 Bash도 없다 |
| Antigravity | `--mode plan` |
| Grok | 편집 허용 규칙 없음, `--deny Edit(**)`, `--deny Bash(*)` |

CLI 규칙은 버전마다 다를 수 있어서 **실제 보증은 상담 전후 스냅샷 비교**다. 트리가 바뀌었으면 그 상담의 답변은 전부 버리고(`violated:true`, `touched` 파일 목록), 단계는 RECOVERY_REQUIRED가 된다. 리드는 바뀐 파일을 보고 recover 한다. 위반한 일꾼은 router 실적에서 실패 한 건으로 잡혀 순위가 내려간다.

## 자동 권고

같은 반려 사유가 반복돼 ALTERNATIVE_REQUIRED가 되면 상태에 `hint: {suggest:"consult", mode:"committee"}`가 붙는다. 다음 일꾼을 투입하기 전에 위원회로 원인부터 보라는 뜻이다. 강제는 아니다.
