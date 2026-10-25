# 검수 프로토콜

리뷰 대상은 현재 라운드만이 아니라 첫 일꾼 시작 스냅샷(`base-1`) 대비 최종 누적 변경이다. 위임 문맥의 `changed_files`는 누적 목록, `round_changed_files`는 이번 라운드 목록이다. `unattributed_changes`는 어느 검증된 일꾼 라운드의 최종 내용에도 일치하지 않는 파일이며 복구 후 남은 라운드 밖 변경도 포함한다. 리드는 직접 리뷰할 때도 이 파일까지 확인한다. 위험 경로 검사도 누적 목록에 적용된다. 복구로 유지한 변경은 위임 정책의 자동 승인 대상이 아니고, 최종 검증은 누적 승인 근거 없이 이를 닫지 않는다.

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

"같은 사유"는 문장이 아니라 **수용 기준 ID**로 판정한다. 반려 사유에 `AC2` 같은 ID가 있으면 ID만 비교하므로 `"AC2: 빈 입력에서 예외"`와 `"AC2 still broken"`은 같은 사유다. ID가 없으면 대소문자·문장부호·공백을 걸러낸 문장으로 비교한다. 그래서 반려 사유는 항상 기준 ID로 시작한다. 수용 테스트 실패는 `Acceptance: <명령>`으로 기록되어 같은 명령이면 같은 사유가 된다.

참고 신호(점수 3 이상이면 전략·일꾼 적합성 재검토): 서브시스템 경계 3개 +2, 원인 불명 테스트 실패 +2, 복잡한 영속/동시성/마이그레이션 상태 +2, 파일 8개 +1, 약 400줄 변경 +1, 툴체인 영향 +1. 판정 입력의 `complexity` 객체로 넘긴다. 반복 회귀나 `complex_state`는 hard 신호다.

권한 거절은 권한 문제로 다룬다. 다른 일꾼에게 넘겨 우회하지 않는다. 검수는 수용 기준과 실질 위험을 입증할 만큼만 하고, 일꾼의 전체 실행 기록을 기계적으로 다시 읽지 않는다.

## 위임 리뷰 (`review.by: "delegate"`)

리드는 Opus 그대로 두고, 라운드 리뷰만 다른 모델에게 맡긴다. Opus가 diff를 정독하는 비용이 리드 토큰에서 가장 크기 때문이다.

```json
{"review": {"by": "delegate", "reviewers": ["sol", "sonnet", "antigravity", "grok", "luna"], "auto_apply": true}}
```

1. `finish` 후 REVIEW에서 `fusion-state.mjs delegate-review REPO [INPUT.json]`을 실행한다. 입력은 생략할 수 있다. `{"executors":["sol"]}`로 리뷰어를 지정할 수 있다.
2. 반환된 명령(브리지 `--consult <id>`)을 한 번 실행하고, `consult-finish REPO {"quiescent":true}`를 호출한다.
3. `auto_apply: true`(기본)면 리뷰어의 판정(pass/redo/alternative/decision), 반려 사유, 파일·줄 지적이 그대로 적용된다. `false`면 `pending_review`로 남는다. 리드가 `review {"adopt":true}`로 채택하거나 자기 판정을 내린다.

### 위험 경로

설정 `review.risk_paths`(기본: auth, migrations, `*.sql`, security, `.github/workflows`)에 맞는 파일을 라운드가 바꾸면 리드가 직접 확인한다. classic은 위임 리뷰의 pass를 `pending_review`(`reason:"risk_paths"`)로 남기고, adaptive는 그 라운드의 리뷰 계획을 중요 작업으로 올리며(`review-plan-N.json`의 `risk`, 패킷의 `risk_paths`) APPROVE에 `diff_reviewed`·`tests_checked`·`changed_scope`를 요구한다. 판정은 컨트롤러 기록(`validation-N.json`의 변경 파일)으로만 한다.

### 반려 근거

LLM 리뷰어는 맞는 코드를 결함으로 판정하는 편향이 있다. 그래서 위임 리뷰의 `redo`·`alternative`는 **줄 위치가 있는(line ≥ 1) blocker 또는 major 지적**이 하나 이상 있어야 그대로 적용한다.

- classic: 근거 없는 반려는 `auto_apply:true`여도 적용하지 않고 `pending_review`(`evidence:false`)로 남긴다. 리드가 `review {"adopt":true}`로 그대로 적용하거나 자기 판정을 낸다.
- adaptive: 기록에 `evidence:false`가 붙고 패킷의 `unsupported_rejections`에 남는다. 근거 없는 반려뿐이면 추천이 비어 있다. 리드는 REDO하거나, 직접 diff를 읽고 `overrule_reason`, `diff_reviewed:true`, `tests_checked`, `changed_scope`를 적어 APPROVE한다(`overruled_reviews`, 뒤집힌 자리는 `lead_filled_seats`). 근거가 있는 반려는 리드 혼자 뒤집지 못한다. 다른 의견이 필요하면 `LEAD_DECISION_REQUIRED`에서 구현자와 이미 판정한 리뷰어를 뺀 모델을 `executors`로 지정하고 `substitution_reason`을 적어 `delegate-review`를 다시 연다(라운드당 위임 리뷰 2회 한도 안). 교체된 반려는 지우지 않고 `superseded:true`로 남는다. 대체 리뷰어가 같은 digest에서 pass하면, 리드가 직접 diff를 읽고 `overrule_reason`, `diff_reviewed:true`, `tests_checked`, `changed_scope`를 적어 APPROVE할 수 있다. 대체 리뷰어도 반려하면 승인할 수 없다.
- 일꾼이 미완료로 보고해 컨트롤러가 바꾼 반려와 수용 테스트 실패 반려는 그 자체가 근거다.

## 옵트인 Adaptive Review (`review.strategy: "lead-gated-adaptive"`)

`strategy`가 없으면 위 위임 리뷰가 그대로다. 실패한 리뷰어의 다음 후보, `auto_apply`, 라운드당 재시도 상한도 바뀌지 않는다. `strategy`가 켜지면 `auto_apply`와 `review {"adopt":true}`는 판정을 적용하지 않는다.

최소 원칙은 하나다: **라운드를 구현한 모델은 그 라운드를 리뷰하지 않는다.** 나머지는 상황(한도, 장애)에 맞춰 바꾸고, 최종 판정은 리드가 한다.

`strategy`를 켜면 기본 리뷰어와 자리 수는 설정의 `reviewers` 순서가 아니라 **그 라운드의 실제 작성자**로 정해진다. 배정은 init의 `task_criticality`(`standard|important|apex`)와 `assignment_strategy`(`external_primary|dual_review`)로 컨트롤러 기록 `assignment.json`에 고정된다. 저장소 설정, 브리프, 워커 JSON으로 자리 수를 줄이거나 리뷰어를 바꿀 수 없다. 바꾸는 건 리드의 `delegate-review`뿐이며 사유가 남는다.

| 라운드 작성자 | 리뷰어 |
|---|---|
| grok, antigravity, haiku, sonnet, lead | sol. 추론 강도 medium |
| grok이 important, apex, `dual_review`, 또는 위험 경로 | sol medium + sonnet high |
| antigravity, haiku, 승인된 sonnet이 important, apex, `dual_review`, 또는 위험 경로 | sol medium + grok xhigh |
| luna가 important, apex, `dual_review`, 또는 위험 경로 | sonnet high + grok xhigh |
| luna | sonnet high |
| sol | 위임 리뷰어 없음. 라운드가 끝나면 `LEAD_DECISION_REQUIRED`에서 리드가 diff, 관련 테스트, 변경 범위를 확인하고 `lead-decision`을 남긴다 |

합의되지 않은 판정은 pass로 합치지 않는다. 리드의 `review` 명령으로 빠진 리뷰를 대신하지 않는다.

위 표는 새 Grok 사용 팀의 `cross-vendor-pairs-v1` 배정에 적용된다. init/begin의 `review_preview`는 잠정 계획이며 실제 위험 경로를 검사한 뒤 최종 라운드 계획을 고정한다. 두 리뷰어는 같은 digest를 서로의 판정 없이 병렬 검토한다. 이전 배정 및 Grok 미포함/금지 팀은 `legacy-v1` 규칙을 유지한다. [전체 규칙](review-pairs.md).

**리뷰어 교체.** 기본 리뷰어가 한도·장애로 끝내지 못하면 패널은 `reviewer_failed`로 게이트에 오른다. 리드는 그 게이트에서 `delegate-review`를 다시 부른다.

- 끝난 리뷰는 남고 빈 자리만 채운다. 실패한 리뷰어는 기본값에서 빠지며, 한도가 풀렸으면 이름을 적어 다시 쓸 수 있다.
- 기본 리뷰어가 아닌 모델은 `executors`와 `substitution_reason`으로 넣는다. 작성자 자신과 `lead`는 거절한다. 새 페어 정책은 구현자와 같은 벤더, 다른 리뷰어와 같은 벤더도 거절한다. 이전 정책은 같은 회사 모델을 허용하되 패킷의 `same_family_reviewers`에 남긴다.
- 라운드당 위임 리뷰 상한(2회)은 그대로다. 판정이 난 패널(누구도 실패하지 않은 라운드)은 다시 위임하지 않는다.
- 같은 일꾼이 직전 반려와 같은 수용 기준(AC ID)으로 또 반려되면 패킷의 `repeated_criteria`에 남고 추천이 `REASSIGN_OTHER`로 바뀐다. 그래도 같은 일꾼에게 `REDO`하려면 `keep_owner_reason`을 적는다. APEX(Sol) 라운드와 넘길 일꾼이 없을 때는 적용하지 않는다.
- 남은 리뷰어가 없으면 리드가 `lead-decision`에서 `diff_reviewed:true`, `tests_checked`, `changed_scope`를 적고 빈 자리를 직접 채워 APPROVE한다(`lead_filled_seats`). 끝낸 리뷰어 중 pass가 아닌 판정이 있으면 승인되지 않는다.

## 옵트인 구현 역할 (Sonnet / Sol)

`lead-gated-adaptive`가 아니면 Sonnet은 지금처럼 구현할 수 있고 Sol은 구현할 수 없다. 전략을 켠 작업은 다르다.

- 자동 배치, 교체, newcomer, explore는 Sonnet과 Sol을 고르지 않는다. `executor: "sonnet"`이나 `executor: "sol"`만으로 구현 권한이 생기지 않는다.
- `assignment_strategy: "sonnet_implementation"`은 `task_criticality: "important"`일 때만 init에서 Sonnet 구현 한 라운드를 연다. 강도는 high다.
- `assignment_strategy: "sol_apex"`는 `task_criticality: "apex"`일 때만 init에서 Sol 구현 한 라운드를 연다. sandbox는 `workspace-write`, 강도는 medium이다. 리뷰와 상담의 Sol은 `read-only`다.
- 그 라운드가 시작되면 승인은 소모된다. 다음 Sonnet 라운드는 `lead-decision`의 `REASSIGN_TO_SONNET` 또는 `REDO`가 만들거나, 게이트 밖에서 `grant-implement`에 `strategy: "reassign_to_sonnet"`이 있어야 한다. 다음 Sol 라운드는 같은 APEX 작업에서 `REDO` 또는 `grant-implement`의 `strategy: "sol_apex"`로 다시 승인해야 한다. APEX 작업을 Sonnet으로 바꾸지 않는다.
- 승인 기록은 `implement-grant-<revision>.json`이다. 상태와 기록이 다르면 라운드를 시작하지 않는다. 브리프나 워커 JSON의 같은 필드는 거절한다. 리드 결정이 승인을 만들어도 워커는 바로 시작하지 않는다.
- Sonnet이 구현한 중요한 라운드는 새 페어 정책에서 Sol+Grok, 이전 정책에서는 Sol이 리뷰한다. Sol이 구현한 라운드는 위임 리뷰어가 없고 리드 게이트로 간다.

## 옵트인 리드 최종 판정

`lead-gated-adaptive`에서 필수 리뷰가 끝나거나, 리뷰어가 리드뿐인 Sol 라운드가 끝나면 단계는 `LEAD_DECISION_REQUIRED`다. 컨트롤러는 diff 본문을 복사하지 않고 `lead-packet-<라운드>.json`에 파일 위치와 추천 액션만 남긴다. 모델은 호출하지 않는다.

`lead-decision` 입력은 `decision`, 비어 있지 않은 `rationale`, 그 라운드의 `baseline_digest`, `contract_change`(boolean)다. `decision`은 `APPROVE`, `REDO`(`REDO_SAME_OWNER`는 같은 의미), `REASSIGN_TO_SONNET`, `REASSIGN_OTHER`, `ESCALATE`, `BLOCK`이다. writer lease가 남아 있으면 거절한다. 트리가 라운드 digest와 다르면 `RECOVERY_REQUIRED`다.

- `APPROVE`는 필수 리뷰가 모두 같은 digest에서 pass일 때만 `VERIFY`로 간다. 하나라도 실패하거나 갈리면 pass로 합치지 않는다. Sol 라운드는 추가로 `diff_reviewed:true`, 비어 있지 않은 `tests_checked`, 비어 있지 않은 `changed_scope`가 있어야 한다. `APPROVE`는 `CLOSE`가 아니다. `verify`와 수용 증거가 그대로 필요하다.
- `REDO`는 같은 작성자의 다음 라운드다. Sonnet이나 Sol이면 소모된 승인 자리에 새 한 라운드 승인을 남기고, 시작은 `begin`이 한다. **작성자가 라운드 상한에 닿았으면(일꾼당 3라운드, Sol APEX는 상한 도달) `REDO`를 받지 않는다.** 받아 두면 REDO 단계에서 다음 `begin`이 `round cap reached`로 막혀 갇히기 때문이다. 대신 `LEAD_DECISION: <일꾼> has no round budget left`와 함께 남은 길(`REASSIGN_OTHER`의 후보, `REASSIGN_TO_SONNET`, `ESCALATE`, `BLOCK`)을 알려 주고 아무것도 기록하지 않는다. 리드 패킷도 이 경우 추천을 `REDO`에서 `REASSIGN_OTHER`(후보가 없으면 그다음 길)로 바꾸고 `note`에 이유를 적는다.
- `REASSIGN_TO_SONNET`은 `ALTERNATIVE_REQUIRED`와 Sonnet 승인, `required_reviewer:"sol"`이다. 다음 `begin`은 그 Sonnet에 묶인다. APEX Sol 작업에서는 거절한다.
- `REASSIGN_OTHER`의 선택 작성자는 grok, antigravity, haiku, luna다. 빠지면 기존 교체 순서를 쓴다.
- `ESCALATE`는 `DECISION_REQUIRED`, `BLOCK`은 `BLOCKED`다.

### 지적별 처분 (`finding_dispositions`, 선택)

리드는 판정과 함께 이번 라운드 지적을 하나씩 분류할 수 있다. 리드 패킷의 `finding_summary.displayed[].id`(`F-…`)를 쓴다.

```json
{"decision":"REDO","rationale":"AC1 fails on empty input","baseline_digest":"…","contract_change":false,
 "finding_dispositions":[{"finding_id":"F-…","bucket":"act","reason":"empty input crashes"},
                         {"finding_id":"F-…","bucket":"dismissed","reason":"the caller validates input upstream"}]}
```

| bucket | 뜻 | 다음 일꾼에게 |
|---|---|---|
| `act` | 이번 작업에서 고친다 | 리드 메모와 함께 전달 |
| `consider` | 실제 문제지만 고칠지 다음 일꾼이 판단한다 | 전달 |
| `noted` | 기록만 한다 | 전달하지 않음 |
| `dismissed` | 기각. 가정일 뿐이거나 리뷰어가 문맥을 몰랐다 | 전달하지 않음 |
| `contract_misread` | 리뷰어가 아니라 브리프·수용 기준이 모호했다. 다음 라운드 전에 계약을 고친다 | 전달 |

- 모든 항목에 사유가 필요하다. 기각 사유는 리드 판단을 사용자가 되짚을 수 있게 하는 신뢰 장치다.
- 이번 라운드 digest에서 끝난 리뷰의 지적만 받는다. 없는 ID, 중복, 다른 키는 거절하고 아무것도 기록하지 않는다.
- `act`가 하나라도 있으면 APPROVE는 거절된다.
- 처분은 관찰 기록이다. 승인 조건, 근거 있는 반려, 필수 리뷰 자리는 바꾸지 않는다. 반려 기준(`Unmet:`)은 처분과 관계없이 전달된다.
- 지표 `review_dispositions.by_reviewer`가 리뷰어별 처분 수와 `actionable_rate`(act+consider / contract_misread를 뺀 전체)를 센다. 리뷰어 순서를 실적으로 정할 근거로 쓴다.

기록은 `lead-decision-<라운드>.json`이다. 기준선 digest, 계약 변경 여부, 사유, 그리고 `usage-<라운드>.json`이 있으면 그 사용량을 담는다. 파일이 없으면 사용량을 0으로 만들지 않는다. 오토파일럿은 이 단계에서 멈춘다.

규칙:
- **자기 작업은 자기가 리뷰하지 않는다.** 리뷰어는 그 라운드를 구현한 일꾼과 달라야 한다. 리드가 takeover로 직접 쓴 코드도 다른 모델이 리뷰한다.
- **리뷰어 우선순위:** 기본 순서는 Sol(GPT-6.1 Sol via Codex, 리드와 다른 계열이라 교차 검증에 가장 유리) → Sonnet → Antigravity → Grok → Luna이다. 설치 안 된 리뷰어는 건너뛴다. `strategy`가 없으면 Sol은 리뷰·상담만 하고 구현 lease는 받지 않는다. 옵트인 APEX 라운드는 위의 구현 역할을 따른다. 프로젝트가 있으면 승인된 팀의 리뷰어 순서를 쓴다.
- **리뷰는 읽기 전용이다.** 상담과 같은 장치로 돌고, 전후 스냅샷이 다르면 판정을 버리고 RECOVERY_REQUIRED로 간다.
- **리뷰어에게 결론을 주지 않는다.** 위임 리뷰의 `last_result`는 상태, 바꾼 파일, 일꾼이 인정한 미해결 항목만 담고 요약·테스트 보고·위험 평가는 `claims_withheld`로 키 이름만 남긴다. `recent_reviews`는 이전 반려 기준만 담는다. 테스트는 컨트롤러가 직접 돌린 `controller_acceptance`로 판단한다. 상담(advisor, committee)은 원인 분석에 필요하므로 전체 보고를 받는다.
- **리드 전용 판정:** 리뷰어는 `takeover`를 낼 수 없다. `decision`을 내면 DECISION_REQUIRED가 되어 설계 판단은 리드가 한다.
- **미완료 보고:** 일꾼이 미완료(`blocked` 등)라고 보고한 라운드는 리뷰어가 pass를 줘도 redo(`worker reported …`)로 바뀐다.
- **판정 형식:** pass가 아닌데 반려 사유가 비어 있는 판정은 형식 오류로 버린다. 리뷰어가 실패하면 다음 리뷰어를 부르거나 리드가 직접 본다. 라운드당 위임 리뷰는 2회까지이고, 상담 예산(4회)과는 별개다.
- **보류되는 판정:** 적용할 수 없는 판정(예: 교체할 일꾼이 없는데 alternative)은 강제하지 않는다. 사유와 함께 보류하고 리드가 결정한다.
- **리드의 덮어쓰기:** 리드는 언제든 `review`로 자기 판정을 내릴 수 있다. 위임 판정을 덮어쓰면 `overrode`로 기록되고 metrics의 `lead_overrides`에 집계된다.
- **최종 관문:** VERIFY(수용 테스트 직접 실행)는 여전히 리드 몫이다. 위임 리뷰가 pass를 내도 리드가 테스트를 돌려 통과해야 CLOSE다.

다음 라운드 지시: `begin`에 `"lead_feedback": "@review"`를 주면 직전 리뷰의 blocker·major 지적이 `{file, line, comment}`로, 반려 사유가 `Unmet: …`로 그대로 전달된다. 리드가 diff를 다시 읽고 지시를 쓰지 않아도 된다.
