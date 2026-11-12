# 외부 저장소에서 들여올 것 (설계 초안)

상태: HF-I09는 구현했다(`scripts/resume-packet.mjs`, `tests/resume-disposition.test.mjs`). HF-I08은 초안이고 0단계 측정 전이다. 번호 HF-I08, HF-I09는 가칭이다.

HF-I09 구현에서 정한 것과 바뀐 것:
- `packet_revision`은 2로 올렸다.
- 구현자의 완료 기록(`completion-N`)이 있고 멈춘 이유가 남은 writer 잠금(`PROCESS_SHUTDOWN_UNVERIFIED`)뿐이면 `evidence_present`로 둔다. 표대로면 `shutdown_unverified`인데, [정산](reconciliation.md)의 중단 경계 표는 이 경우를 "finish 한 번"으로 처리한다. 경계별 처분값은 `reconciliation-crash` 테스트가 고정한다.
- 리뷰 정산 기록 도중 멈춘 경우는 컨트롤러 잠금이 남아 `shutdown_unverified`다. 표의 "불확실한 의도"보다 거칠지만, 먼저 컨트롤러가 멈췄는지 확인하라는 뜻이라 어긋나지 않는다.

두 저장소의 README를 읽고 뽑은 아이디어다. 코드는 보지 않았고 가져오지도 않는다.

| 항목 | 출처 | 들여오는 것 | 건드리는 곳 |
|---|---|---|---|
| HF-I08 상시 답변 | [vectorize-io/hindsight](https://github.com/vectorize-io/hindsight)의 mental model, observation | 리드가 한 번 확인한 답을 검색 없이 다시 쓴다 | 기억 계층 |
| HF-I09 재개 처분 | [mvschwarz/openrig](https://github.com/mvschwarz/openrig)의 복원 결과 보고 | 재개 패킷에 고정된 처분값 하나를 붙인다 | `resume` |

둘은 서로 의존하지 않는다. HF-I09가 작고 위험이 낮으니 먼저 해도 된다.

공통 원칙은 지금과 같다.

- 기억과 재개 패킷은 참고 자료다. 승인, CLOSE, 재실행 권한을 주지 않는다.
- 컨트롤러는 모델을 부르지 않는다. 외부 서버, DB, 임베딩을 쓰지 않는다.
- 자동 승인, 자동 재개는 없다.

---

## HF-I08 상시 답변

### 풀려는 문제

지금 리드는 작업마다 `recall`로 기억을 찾고, 찾은 조각을 정본·Git과 대조한 뒤에야 `brief.prior_experience`에 넣는다([memory-recall](memory-recall.md)). 같은 저장소에서 "여기서는 어떻게 검증하나" 같은 질문은 작업마다 되풀이되는데, 검색과 대조도 그때마다 다시 한다.

상시 답변은 그 대조를 한 번만 하게 한다. 리드가 승인한 답을 저장해 두고, 근거 조각이 바뀌지 않는 동안에는 `context`에서 그대로 꺼낸다.

### 먼저 잴 것 (0단계)

[memory.md](memory.md)에 적힌 대로 회수 효과는 아직 실측하지 않았다. 되풀이되는 회수가 실제로 리드 토큰을 쓰는지 모르는 채로 기능을 더하지 않는다.

기존 도구만으로 작업 10개 이상에서 아래를 모은다. 새 코드는 필요 없다.

| 잴 것 | 어디서 |
|---|---|
| 작업당 `recall` 횟수, 돌려받은 바이트 | `--observe` 영수증, `--byte-budget` 패킷 |
| 회수한 조각이 brief에 실제로 들어간 비율 | 작업 지표의 `memory` |
| 들어간 조각이 도움이 된 비율 | `assess`의 `helpful` / `unhelpful` |
| 서로 다른 작업에서 같은 조각이 다시 회수된 비율 | 영수증의 조각 ID |

**멈추는 조건:** 같은 조각이 다시 회수되는 비율이 낮거나(예: 20% 미만), 회수가 리드 입력 환산 토큰에서 차지하는 몫이 작으면(예: 2% 미만) 여기서 그만둔다. 문턱 숫자는 0단계를 시작하기 전에 정해 이 문서에 적고, 결과를 본 뒤에는 바꾸지 않는다.

### 데이터

워크스페이스 파일(`~/.hyperfusion/memory/<workspace>.json`)에 `standing` 배열을 더한다. 없는 파일은 빈 배열로 읽으므로 `version`은 올리지 않는다.

```json
{
  "id": "s1a2b3c4",
  "key": "HOW_TO_VERIFY",
  "content": "npm test 뒤에 npm run test:recovery를 따로 돌린다. 복구 테스트는 직렬 실행이다.",
  "sources": [{"id": "f9e8d7c6", "fingerprint": "<내용 SHA-256>"}],
  "source_digest": "<sources를 정렬해 이은 것의 SHA-256>",
  "approved_at": "2026-11-12T00:00:00.000Z",
  "status": "current"
}
```

- `key`는 허용 목록에서만 고른다. anchor와 같은 방식이다. 처음에는 넷만 둔다.

| key | 답하는 질문 |
|---|---|
| `HOW_TO_VERIFY` | 이 저장소에서 변경을 어떻게 검증하나 |
| `KNOWN_PITFALLS` | 여기서 되풀이된 실패와 피하는 법 |
| `ENVIRONMENT_NOTES` | 실행 환경에서 알아야 할 것 |
| `WORKER_NOTES:<일꾼>` | 그 일꾼이 이 저장소에서 자주 반려된 이유 |

- `content`는 600자까지. 비밀 패턴 검사(`looksSecret`)를 그대로 거친다.
- `sources`는 하나 이상이어야 하고, 모두 활성 상태이며 `rejected`가 아닌 조각이어야 한다. 근거 없는 답은 저장하지 않는다.
- key 하나에 `current`는 하나뿐이다. 새로 승인하면 이전 것은 archive로 간다.

### 쓰는 길: 리드만, 명시적으로

1. `memory.mjs standing-draft REPO KEY`가 그 key에 맞는 조각을 골라 **초안 재료**를 돌려준다. 읽기 전용이다. 고르는 규칙은 결정적이다.
   - `HOW_TO_VERIFY`: `procedure` 조각 중 verified 우선, 감쇠 점수 상위 6개
   - `KNOWN_PITFALLS`: `error` 조각 중 `merge_count`가 1 이상이거나 verified인 것 상위 6개
   - `ENVIRONMENT_NOTES`: `fact`·`episode` 조각 중 만료되지 않은 것 상위 6개
   - `WORKER_NOTES:<일꾼>`: 키워드 `by:<일꾼>`이 붙은 `error`·`episode` 상위 6개
2. 리드가 재료를 정본·Git과 대조하고 문장을 쓴다. 문장은 리드가 쓴다. 컨트롤러는 요약하지 않는다.
3. 기존 `commit`에 `standing` 필드를 더해 저장한다. 같은 컨트롤러 잠금 아래에서 돈다.

```json
{"standing": [{"key": "HOW_TO_VERIFY", "content": "…", "sources": ["f9e8d7c6"], "expected_digest": "<standing-draft가 준 값>"}]}
```

`expected_digest`가 지금 조각 상태와 다르면 통째로 거절한다(`MEMORY_STANDING_STALE`). 후보 일괄 검토의 `expected_digest`와 같은 방식이다.

문장을 리드가 직접 쓰면 그만큼 리드 토큰이 든다. 싼 일꾼에게 읽기 전용 상담([consult](consult.md))으로 초안을 맡기는 길은 2단계로 미룬다. 1단계에서 상시 답변이 실제로 쓰이는지 본 뒤에 정한다.

### 읽는 길

- `memory.mjs context REPO`의 결과에 `standing`을 더한다. `current`인 것만 내용과 함께 준다.
- 낡은 것은 내용 없이 `{id, key, status:"stale", reason}`만 준다.
- 상시 답변을 읽어도 근거 조각의 회수 횟수나 사용 시각을 올리지 않는다. 제한 회수 패킷과 같다.
- brief에 넣을 때는 `prior_experience`에 `{id:"s…", type:"standing", content}`로 넣는다. `MAX_PRIOR`(12) 안에서 센다.
- `--observe`와 `assess`가 `s…` ID도 받게 한다. 그래야 쓰임새를 잴 수 있다.

### 낡음 판정

읽을 때마다 `source_digest`를 다시 계산해 비교한다. 아래 중 하나면 `stale`로 표시하고 내용을 주지 않는다.

| 이유 코드 | 조건 |
|---|---|
| `SOURCE_CHANGED` | 근거 조각의 내용 지문이 달라졌다(병합으로 바뀐 경우 포함) |
| `SOURCE_GONE` | 근거 조각이 archive로 갔거나 `forget`됐다 |
| `SOURCE_DISPUTED` | 근거 조각이 `needs_review`나 `rejected`가 됐다 |
| `SOURCE_EXPIRED` | 근거 조각이 만료됐다 |
| `ARTIFACT_CHANGED` | `--validate-artifacts`를 켰고, 근거 조각의 artifact 해시가 지금 파일과 다르다 |

읽기는 파일을 고치지 않는다. `stale` 표시는 계산해서 보여 줄 뿐이고, 저장된 `status`는 `reflect`가 돌 때 고친다. `reflect`는 낡은 답을 지우지 않고 개수만 보고한다. 리드가 새로 승인하거나 `forget`으로 치운다.

근거 조각이 그대로여도 정본이 바뀌었을 수 있다. 지문 일치는 "리드가 본 것과 같은 조각"이라는 뜻이지 "지금도 옳다"는 뜻이 아니다. `context` 출력의 안내문에 이 점을 그대로 적는다.

### 함께 넣을 작은 것: 지지·반박 횟수

hindsight의 observation은 새 증거가 오면 믿음을 덮어쓰지 않고 강화하거나 약화한다. 지금 저장소는 병합할 때 `sources`와 `merge_count`를 쌓지만, 반박은 `resolve`로 한쪽을 `rejected`로 돌리면 기록이 흩어진다.

- `resolve`에서 `keep`이 있으면, 살아남은 조각에 `disputed_by: [{id, task, at}]`를 더한다.
- `view`에 `support`(= `sources` 개수)와 `disputes`(= `disputed_by` 개수)를 내보낸다.
- 순위에는 쓰지 않는다. 보여 주기만 한다. 순위에 넣을지는 0단계와 같은 방식으로 따로 잰 뒤 정한다.

### 하지 않는 것

- 임베딩, 의미 유사도, 모델이 쓰는 자동 요약
- 일꾼이 상시 답변을 제안하거나 읽는 길(일꾼은 지금처럼 brief로만 받는다)
- 다른 워크스페이스의 답 공유
- git 이력에서 초기 기억 뽑기(따로 다룬다)

### 바뀌는 파일

| 파일 | 변경 |
|---|---|
| `scripts/memory-store.mjs` | `standing` 읽기·쓰기, `standingDraft`, 낡음 계산, `context`·`reflect`·`stats` 확장, `resolve`의 `disputed_by` |
| `scripts/memory-policy.mjs` | `STANDING_KEYS`, 길이·비밀·근거 검사 |
| `scripts/memory.mjs` | `standing-draft` 명령, `commit`의 `standing` 처리 |
| `scripts/memory-observations.mjs` | `s…` ID 받기 |
| `references/memory.md`, `memory-recall.md` | 절차와 한계 |
| `tests/memory-standing.test.mjs` | 새 테스트 |

### 테스트로 고정할 것

- 허용 목록 밖 key, 근거 없는 답, 600자 초과, 비밀 패턴은 거절된다.
- `rejected`·`needs_review`·만료 조각은 근거가 될 수 없다.
- `expected_digest`가 다르면 아무것도 저장되지 않는다.
- 근거 조각을 병합·`forget`·`resolve`·만료시키면 각각 맞는 이유 코드로 `stale`이 되고 내용이 나오지 않는다.
- `context`와 `standing-draft`는 저장 파일을 바꾸지 않는다(전후 바이트 비교).
- 같은 key를 다시 승인하면 이전 답은 archive에 남는다.
- `standing`이 없는 기존 파일을 읽고 써도 기존 테스트가 그대로 통과한다.

### 받아들이는 조건

0단계와 같은 작업 묶음을 상시 답변을 켜고 다시 돌린다. [증거 회수 실험](evidence-retrieval-experiment.md)의 규칙을 따른다.

- 성공한 작업당 리드 입력 환산 토큰이 줄어야 한다.
- 숨김 시험 통과, `wrong_closes`, `escaped_regressions`, `scope_violations`가 같거나 나아야 한다.
- 낡은 답이 brief에 들어간 경우가 한 번이라도 있으면 실패다.

---

## HF-I09 재개 처분

### 풀려는 문제

`fusion-state.mjs resume`이 주는 패킷([resume-packet.mjs](../scripts/resume-packet.mjs))에는 이유 코드가 열네 가지 있고, 여러 개가 함께 나온다. 리드는 그 조합을 읽고 어느 문서의 어느 절차로 갈지 스스로 정해야 한다. 중단된 뒤 다시 깨어난 리드가 가장 먼저 쓰는 토큰이 여기서 나간다.

openrig는 복원할 때 노드마다 `resumed`, `fresh-primed`, `awaiting-decision`, `attention_required`, `failed` 중 하나를 보고한다. 같은 생각으로, 이유 코드 조합을 **처분값 하나**로 줄여 준다. 이유 코드는 그대로 둔다.

### 처분값

위에서부터 먼저 맞는 것 하나를 고른다.

| 순서 | `disposition` | 조건 (이유 코드) | 리드가 갈 곳 |
|---|---|---|---|
| 1 | `unreadable` | `LEGACY_STATE`, `PHASE_UNKNOWN`, `ROUND_INVALID`, `ARTIFACT_INVALID`, `INITIAL_BRIEF_UNAVAILABLE` | [복구](recovery-protocol.md) 1번. 상태를 믿지 않는다 |
| 2 | `recovery_required` | `RECOVERY_REQUIRED` | [복구](recovery-protocol.md)의 `recover` |
| 3 | `outcome_uncertain` | `DISPATCH_OUTCOME_UNCERTAIN`, `VERIFICATION_OUTCOME_UNCERTAIN`, `TERMINAL_SETTLEMENT_INCOMPLETE` | [정산](reconciliation.md)의 "Uncertainty". 다시 돌리지 않는다 |
| 4 | `shutdown_unverified` | `PROCESS_SHUTDOWN_UNVERIFIED`, `CONTROLLER_LOCK_PRESENT`, `ACCEPTANCE_PENDING` | [복구](recovery-protocol.md) 2~3번. 프로세스 종료 확인 |
| 5 | `evidence_present` | `EXISTING_LAUNCH`, `EXISTING_CONSULT`만 남았다 | `reconcile` 미리보기(권한이 있을 때), 없으면 수동 정산 |
| 6 | `continue` | 이유 코드 없음, 종료 단계 아님 | `next_action` 그대로 |
| 7 | `settled` | 이유 코드 없음, 종료 단계 | 할 일 없음 |

이름을 고른 기준: 패킷이 증명하지 못하는 것을 이름이 말하지 않게 한다. `resumed`나 `finished` 같은 말은 쓰지 않는다. 파일이 있다는 것은 종료, 수용, 승인의 증거가 아니다.

### 참여자별 흔적

지금 패킷은 `artifacts`에 파일 이름과 `present / missing / invalid`를 평평하게 준다. 리드는 이름 규칙을 알아야 누구의 것인지 읽을 수 있다. 같은 정보를 참여자별로 묶어 준다.

```json
"participants": [
  {"role": "implementer", "member": "terra", "trace": "result_recorded"},
  {"role": "consult", "member": "sol", "trace": "launched_only"},
  {"role": "consult", "member": "sonnet", "trace": "completion_recorded"}
]
```

`trace`는 현재 라운드의 파일 유무만으로 정한다. 위에서부터 먼저 맞는 것이다.

| `trace` | 조건 |
|---|---|
| `invalid` | 그 참여자의 파일 중 하나라도 `invalid` |
| `completion_recorded` | `completion-…` 있음 |
| `result_recorded` | `result-N` 또는 `consult-result-…` 있음 |
| `launched_only` | `launch-…` 있음, 결과 없음 |
| `not_launched` | `launch-…` 없음 |

구현자의 이름은 `state.owner`, 상담 참여자는 `open_consult.members`에서 온다. 지금처럼 최대 6명이다.

### 출력

```json
{
  "packet_revision": 2,
  "disposition": "shutdown_unverified",
  "disposition_basis": ["PROCESS_SHUTDOWN_UNVERIFIED"],
  "participants": [],
  "reason_codes": ["EXISTING_LAUNCH", "PROCESS_SHUTDOWN_UNVERIFIED"],
  "auto_resume": false
}
```

- `disposition_basis`는 그 처분을 고르게 한 이유 코드만 담는다.
- `reason_codes`, `artifacts`, `next_action`, `evidence_note`는 그대로 둔다. `packet_revision`만 2로 올린다.
- `lead_required`의 계산도 그대로다.

### 지키는 것

- `resume`은 지금처럼 읽기 전용이다. 잠금, 프로세스 조회, 파일 쓰기가 없다.
- 처분값은 이유 코드에서만 계산한 표시다. 컨트롤러의 어느 판단도 처분값을 읽지 않는다. `reconcile`의 조건은 바뀌지 않는다.
- `continue`는 "이유 코드가 없다"는 뜻일 뿐이다. 프로세스가 끝났다는 증명이 아니다. `evidence_note`가 이 점을 계속 말한다.
- 새 이유 코드가 생겼는데 표에 넣지 않았으면 `unreadable`로 떨어지게 한다. 모르는 코드를 `continue`로 흘리지 않는다.

### 바뀌는 파일

| 파일 | 변경 |
|---|---|
| `scripts/resume-packet.mjs` | 순수 함수 `disposition(reasons, phase)`, `participants(state, artifacts)`, `packet_revision: 2` |
| `references/recovery-protocol.md`, `reconciliation.md` | 처분값별로 어느 절로 가는지 한 줄씩 |
| `tests/resume-disposition.test.mjs` | 새 테스트 |

지금 `scripts/`와 `tests/`에서 재개 패킷의 `packet_revision` 값을 읽어 분기하는 곳은 없다(2026-11-12 `grep` 확인). 구현할 때 다시 확인한다.

### 테스트로 고정할 것

- 이유 코드 열네 가지 각각이 표의 처분값으로 간다.
- 여러 코드가 섞이면 표의 순서가 이긴다(예: `EXISTING_LAUNCH` + `RECOVERY_REQUIRED` → `recovery_required`).
- 표에 없는 코드가 섞이면 `unreadable`이다.
- 이유 코드 목록과 표가 어긋나면 테스트가 실패한다(코드가 늘면 표도 고치게).
- `resume` 전후로 제어 폴더의 파일이 바이트 단위로 같다.
- 기존 `reconciliation`·`reconciliation-crash` 테스트가 그대로 통과한다.

### 받아들이는 조건

[정산 문서](reconciliation.md)의 중단 경계 표에 있는 경우마다, 처분값이 가리키는 절차가 그 표의 "Restart disposition"과 같아야 한다. 하나라도 다르면 표나 순서를 고친다. 토큰 절감은 주장하지 않는다. 재개가 드물어 잴 표본이 모자라다.

### 나중에 볼 것: 자리(seat)

openrig는 역할 주소를 고정하고, 그 자리를 채우는 세션만 바꾼다. 여기서는 일꾼을 바꿀 때 반려 이력이 일꾼 이름에 묶여 있는지, 역할([team-roles.mjs](../scripts/team-roles.mjs))에 묶여 있는지가 관련된다. 지금 배치가 이 구분 때문에 손해를 보는지 확인하지 않았으므로 이 초안에는 넣지 않는다.

---

## 정할 것

1. HF-I08 0단계의 멈추는 문턱(재회수 비율, 리드 토큰 몫). 재기 전에 정한다.
2. `WORKER_NOTES`를 처음부터 넣을지. [배치](routing.md)가 이미 반려 기록을 쓰므로 겹칠 수 있다.
3. HF-I09의 `packet_revision`을 올릴지, 필드만 더하고 1로 둘지.
