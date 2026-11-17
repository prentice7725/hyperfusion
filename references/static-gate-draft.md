# 정적 검사 관문과 규칙 후보 (설계 초안)

상태: 초안. 구현도 실측도 하지 않았다. 번호 HF-I11, HF-I12는 가칭이다.

## 왜 필요한가

지금 일꾼의 결과를 거르는 기계 검사는 수용 테스트 하나다([operations](operations.md#수용-테스트-자동-실행)). 수용 테스트를 통과한 뒤의 문제(타입 오류, 금지한 패턴, 구조 규칙 위반)는 리뷰어 모델이 읽어서 찾고, 리드가 판정한다. 같은 실수가 되풀이되면 기억에 `error`로 적어 다음 지시서에 글로 넣는다([memory](memory.md)).

글로 부탁한 규칙은 일꾼이 어길 수 있고, 어겼는지 확인하는 데 리뷰어와 리드의 토큰이 든다. 기계가 확인할 수 있는 것은 기계에게 내린다.

| 항목 | 하는 일 |
|---|---|
| HF-I11 정적 검사 관문 | 린트·타입 검사 같은 명령을 컨트롤러가 finish 때 직접 돌리고, 실패하면 리뷰 없이 되돌린다 |
| HF-I12 규칙 후보 | 여러 작업에서 되풀이된 실패를 모아 "기계 검사로 바꿀 후보"로 리드에게 보여 주고, 바꾼 것은 기억에서 내린다 |

HF-I12는 HF-I11이 있어야 쓸모가 있다. HF-I11만 먼저 넣어도 된다.

두 항목 모두 승인 권한을 바꾸지 않는다. 정적 검사 통과는 리뷰 통과가 아니고, 규칙 후보는 제안일 뿐이다.

---

## HF-I11 정적 검사 관문

### 수용 테스트와 무엇이 다른가

| | 수용 테스트 (`acceptance_commands`) | 정적 검사 (`static_commands`) |
|---|---|---|
| 확인하는 것 | 이 작업이 요구한 동작 | 어느 작업에나 걸리는 규칙 |
| 시작 전 트리에서 | **실패해야** 한다(red-first) | **통과해야** 한다 |
| 수용 기준(AC)과의 연결 | `acceptance_map`으로 잇는다 | 잇지 않는다 |
| 실패하면 | 리뷰 없이 같은 일꾼에게 되돌린다 | 같다 |

수용 테스트를 red-first로 받는 이유는 "처음부터 통과하는 검사는 아무것도 가르지 못한다"는 것이다. 정적 검사는 반대다. 처음부터 실패하는 린트는 일꾼이 만든 위반과 원래 있던 위반을 가르지 못한다. 그래서 두 종류를 한 필드에 섞지 않는다.

### 작업지시서

```json
{
  "static_commands": ["npm run typecheck", "npx eslint src --max-warnings 0"],
  "static_timeout_ms": 120000,
  "static_protect": ["eslint.config.js", "tsconfig.json"]
}
```

- `static_commands`: 한 줄 명령 1~5개, 각각 500자까지. `acceptance_commands`와 같은 검증을 쓴다. 없으면 이 기능은 꺼져 있고 지금과 똑같이 동작한다.
- `static_timeout_ms`: 전체 제한 시간. 기본 120초, 최대 10분.
- `static_protect`: 일꾼이 바꾸면 안 되는 설정 파일의 경로 패턴. `static_commands`가 있으면 하나 이상 적어야 한다(아래 "규칙을 끄는 길 막기").
- 명령은 리드가 쓴 작업지시서에서만 받는다. 저장소의 `hyperfusion.config.json`은 일꾼이 고칠 수 있으므로 출처가 아니다. 수용 테스트와 같은 규칙이다.

### 시작할 때: 통과하는지 먼저 본다

init(또는 명령이 처음 정해지는 begin)에서 손대지 않은 트리로 한 번 돌린다.

| 결과 | 처리 |
|---|---|
| 모두 통과 | `static_baseline: {status:"green"}`을 남기고 진행한다 |
| 하나라도 실패 | `STATIC_BASELINE_FAILING`으로 시작하지 않는다. 실패 출력의 끝 4KB를 보여 준다 |
| 명령이 트리를 바꿈 | `STATIC_DIRTY`로 시작하지 않는다(`--fix` 같은 자동 수정 명령을 막는다) |
| 실행할 수 없음(명령 없음, 시간 초과) | `STATIC_UNVERIFIED`로 시작하지 않는다 |

원래 위반이 있는 저장소에서는 리드가 명령의 대상을 좁혀서 통과하는 범위만 건다(예: 전체가 아니라 `src/rules`만). "원래 있던 위반은 눈감고 새 위반만 잡기"는 넣지 않는다. 출력을 비교해야 하는데, 도구마다 출력 형식이 달라 결정적으로 비교할 수 없다.

작업 도중에 `static_commands`를 바꾸면 수용 테스트와 같이 다룬다. 손대지 않은 트리가 더는 없으므로 `status:"unchecked"`로 적고 리드에게 보인다.

### finish에서

순서는 이렇다.

```text
결과 검증 → 범위 검사 → 보호 파일 검사 → 정적 검사 → 수용 테스트 → (둘 다 통과하면) 리뷰
```

- 정적 검사가 실패해도 수용 테스트는 돌린다. 일꾼이 두 가지 실패를 한 번의 재지시로 받게 하기 위해서다. 드는 것은 컨트롤러의 실행 시간뿐이고 모델 토큰은 들지 않는다.
- 둘 중 하나라도 실패하면 리뷰어를 부르지 않고 같은 일꾼에게 REDO로 되돌린다. 지금의 수용 실패 처리(`applyReview`, `reviewed_by:"controller"`)를 그대로 쓴다.
- 반려 사유는 `STATIC: <명령>`이다. 같은 명령으로 두 번 되돌아간 일꾼은 지금의 "같은 실패 반복 시 교체" 규칙에 걸린다.
- 재지시에는 실패한 명령과 출력의 끝 4KB를 붙인다(`static_feedback`). 수용 실패의 `acceptance_feedback`과 같은 모양이다.
- 일꾼이 미완료(`blocked`, `needs_decision`)라고 보고했으면 자동으로 되돌리지 않고 증거로만 리드에게 보인다. 수용 테스트와 같다.
- 리드가 직접 구현한 라운드(takeover)는 기록만 하고 리드가 판정한다.
- 기록은 `static-N-finish.json`에 남긴다: 명령별 종료 코드, 소요 시간, 출력 SHA-256, 끝 4KB, 종료 증거.

### VERIFY와 CLOSE

- VERIFY에서 finish 때의 통과 기록을 재사용하는 조건은 수용 테스트와 같다(트리와 무시된 파일이 그대로이고 종료 증거가 있음). 아니면 다시 돌린다.
- 정적 검사가 통과하지 않은 작업은 CLOSE하지 않는다(`STATIC_NOT_PASSING`).
- `verification.json`에 `static` 항목을 따로 둔다. AC 표(`ac_table`)에는 넣지 않는다.
- 위임 자동 승인(`standard-auto`)은 정적 검사 통과를 조건에 더한다. 조건이 늘 뿐 줄지 않는다.

### 규칙을 끄는 길 막기

린트와 타입 검사의 설정은 저장소 안 파일이다. 일꾼이 규칙을 끄면 검사는 통과한다. 두 가지로 막는다.

1. **보호 파일.** `static_protect`에 든 파일이 작업 시작 뒤 바뀌면 정적 검사를 돌리지 않고 `STATIC_CONFIG_CHANGED`로 리드에게 올린다. 자동으로 되돌리지 않는다. 설정을 고쳐야 하는 작업일 수 있어서 리드가 판단한다. 수용 테스트 파일이 바뀌었을 때의 처리(`acceptance-integrity`)와 같은 길이다.
2. **줄 단위 예외.** `// eslint-disable-next-line` 같은 줄 단위 끄기는 컨트롤러가 찾지 않는다. 도구마다 문법이 달라서다. 대신 도구의 기능으로 막으라고 문서에 적는다(ESLint의 `noInlineConfig`, `--report-unused-disable-directives` 등). 이것은 리드가 명령을 쓸 때의 책임이다.

보호 파일은 `scope.paths` 밖에 있어야 한다. 범위 안의 파일을 보호 파일로 적으면 검증에서 거절한다. `verification.protect`와 같은 규칙이다.

### 실행 안전

수용 테스트와 같은 실행기를 쓴다. 새로 만들지 않는다.

- 별도 감독 프로세스에서 돌리고, 끝난 뒤 남은 자손 프로세스가 없음을 확인한다. 확인하지 못하면 RECOVERY_REQUIRED다.
- 일꾼과 같은 걸러진 환경변수로 돌린다. 리드의 비밀값은 넘어가지 않는다.
- 무시된 파일(`node_modules` 등)이 라운드 시작 뒤 바뀌었으면 돌리지 않고 `skipped`로 리드에게 보인다. 린터는 `node_modules`의 코드를 실행하므로 수용 테스트와 같은 위험이 있다.
- 명령이 추적 파일을 만들거나 바꾸면 RECOVERY_REQUIRED다.
- 실행 중 표식은 `locks/acceptance.json`을 같이 쓴다. 정적 검사와 수용 테스트가 동시에 돌지 않는다.

### 지표

작업 지표에 더한다.

| 필드 | 뜻 |
|---|---|
| `static_returns` | 정적 검사 실패로 컨트롤러가 되돌린 횟수 |
| `static_ms` | 정적 검사에 쓴 시간 합 |
| `static_config_changes` | 보호 파일 변경으로 리드에게 올라간 횟수 |

### 하지 않는 것

- 린터나 규칙을 HyperFusion이 고르거나 설치하는 일. 저장소에 이미 있는 명령을 돌릴 뿐이다.
- 자동 수정(`--fix`)
- 원래 있던 위반과 새 위반을 출력으로 가르는 일
- 정적 검사 통과를 리뷰 통과나 AC 증명으로 치는 일

### 바뀌는 파일

| 파일 | 변경 |
|---|---|
| `scripts/contracts.mjs` | `static_commands`, `static_timeout_ms`, `static_protect` 검증 |
| `scripts/fusion-state.mjs` | init의 기준 검사, finish·verify의 실행과 되돌리기, 보호 파일 검사 |
| `scripts/acceptance.mjs` | 실패 출력 묶음을 두 종류가 같이 쓰게 정리 |
| `scripts/metrics.mjs` | 지표 세 개 |
| `references/operations.md`, `delegation-protocol.md`, `state-schema.json` | 설명과 스키마 |
| `tests/static-gate.test.mjs` | 새 테스트 |

### 테스트로 고정할 것

- `static_commands`가 없으면 기존 테스트가 그대로 통과한다.
- 시작 전 트리에서 실패하는 명령, 트리를 바꾸는 명령, 실행할 수 없는 명령은 각각의 코드로 시작이 거절된다.
- `static_protect`가 없거나 범위 안의 파일을 가리키면 검증에서 거절된다.
- finish에서 정적 검사만 실패하면 리뷰어가 불리지 않고 같은 일꾼에게 REDO가 간다. 재지시에 실패 출력이 들어 있다.
- 정적 검사와 수용 테스트가 함께 실패하면 재지시 한 번에 둘 다 들어 있다.
- 같은 명령으로 두 번 되돌아가면 교체 규칙이 걸린다.
- 보호 파일이 바뀌면 정적 검사가 돌지 않고 리드에게 올라간다. REDO가 자동으로 가지 않는다.
- 미완료 결과와 takeover 라운드는 자동으로 되돌리지 않는다.
- 정적 검사가 통과하지 않으면 CLOSE와 위임 자동 승인이 막힌다.
- 무시된 파일이 바뀌었으면 돌리지 않고 `skipped`다.

### 받아들이는 조건

실측 전에는 절감을 주장하지 않는다. 정적 검사를 걸 수 있는 저장소(타입 검사나 린트가 이미 있는 곳)에서 같은 작업 묶음을 켜고 끄고 돌려 아래를 본다.

- 성공한 작업당 리드 입력 환산 토큰과 리뷰어 호출 횟수가 줄어야 한다.
- 숨김 시험 통과, `wrong_closes`, `escaped_regressions`, `scope_violations`가 같거나 나아야 한다.
- 라운드 수가 늘어 전체 시간이 길어지는 것은 받아들인다. 얼마나 늘었는지 함께 적는다.

이 저장소에는 린터도 타입 검사도 없어서 여기서는 잴 수 없다. 먼저 쓸 곳은 hf-game-studio로 만든 게임 저장소다. Phaser 템플릿에 `npm run typecheck`(`tsc --noEmit`)가 이미 있다.

---

## HF-I12 규칙 후보

### 풀려는 문제

되풀이된 실패는 지금 기억에 `error` 조각으로 쌓이고, 리드가 회수해 다음 지시서의 `prior_experience`에 글로 넣는다. 이 길에는 비용이 세 번 든다. 리드가 회수하고 대조하는 토큰, 일꾼 프롬프트에 실리는 글, 그래도 어겼을 때 리뷰어가 찾아내는 토큰이다.

기계가 확인할 수 있는 실패라면 정적 검사나 테스트로 바꾸는 편이 싸다. 바꾼 뒤에는 그 조각을 지시서에 실을 필요가 없다. 이 항목은 "어느 조각이 바꿀 만한가"를 리드에게 보여 주고, 바꾼 결과를 기억에 적는다.

### 후보를 고르는 규칙

`memory.mjs rule-candidates REPO`가 읽기 전용으로 목록을 준다. 모델을 부르지 않는다.

후보가 되는 조건은 모두 만족해야 한다.

- 종류가 `error`다.
- 활성 상태이고 `rejected`나 `needs_review`가 아니다.
- **서로 다른 작업 둘 이상**에서 나왔다. 조각의 `sources`에 든 작업 ID로 센다(같은 내용이 다시 저장되면 병합되면서 출처가 쌓인다).
- 아직 `enforced_by`도 `not_enforceable`도 없다.

출처 작업 수가 많은 순으로, 같으면 최근 것부터 최대 10개를 준다.

```json
{"candidates": [
  {"id": "f1a2b3c4", "content": "code/medium: terra round 1 failed AC2 — imported a scene module from a rule module …",
   "tasks": ["HF-12", "HF-19", "HF-23"], "workers": ["terra", "luna"], "last_seen": "2026-11-16T…"}
], "remaining": 3, "digest": "<목록의 SHA-256>"}
```

**한계.** 병합은 토큰 유사도 0.8 이상일 때만 일어난다. 같은 실수를 다른 말로 적은 조각은 따로 남아 후보에 오르지 않는다. 의미가 같은지를 모델로 판단하는 길은 넣지 않는다.

### 리드의 결정

후보마다 리드가 셋 중 하나를 고른다. 기존 `commit`에 `rules` 필드를 더하고, 같은 컨트롤러 잠금 아래에서 `expected_digest`를 확인한다.

```json
{"rules": {
  "expected_digest": "<rule-candidates가 준 값>",
  "enforce": [{"id": "f1a2b3c4", "kind": "static",
               "ref": "eslint: no-restricted-imports (rules → scenes)",
               "artifact": {"path": "eslint.config.js", "sha256": "…"}}],
  "not_enforceable": [{"id": "f9e8d7c6", "reason": "판단이 필요한 설계 문제"}]
}}
```

| 결정 | 뜻 | 조각에 남는 것 |
|---|---|---|
| `enforce` | 이 실패는 이제 기계 검사가 잡는다 | `enforced_by: {kind, ref, artifact, at}` |
| `not_enforceable` | 기계로 확인할 수 없다. 기억에 계속 둔다 | `not_enforceable: {reason, at}` |
| 아무것도 안 함 | 다음에 다시 후보로 나온다 | 없음 |

- `kind`는 `static`(정적 검사 명령이 잡음) 또는 `test`(테스트가 잡음)다.
- `artifact`는 그 규칙이 들어 있는 저장소 파일의 경로와 SHA-256이다. 필수다. 규칙이 실제로 있다는 근거이고, 나중에 사라졌는지 확인하는 데 쓴다. 형식은 기억의 `provenance.artifact`와 같다.
- `enforce`는 **규칙을 만드는 일을 하지 않는다.** 규칙은 보통의 HyperFusion 작업으로 먼저 만든다(아래). `enforce`는 만든 뒤에 그 사실을 적는 것이다.

### 규칙은 보통의 작업으로 만든다

규칙을 더하는 일은 red-first와 잘 맞는다. 리드가 이렇게 지시한다.

- 수용 테스트: "규칙을 어기는 예시 파일에 검사 명령을 돌리면 실패한다"를 확인하는 테스트. 규칙이 없는 지금은 이 테스트가 실패한다.
- 범위: 린트 설정 파일과 그 테스트.
- 이 작업 자체에는 그 설정 파일을 `static_protect`에 넣지 않는다(고치는 것이 목적이므로).

이 작업이 CLOSE되면 리드가 `enforce`로 조각에 적는다. 다음 작업부터는 `static_commands`에 그 명령을 넣는다.

### 회수에서 내린다

`enforced_by`가 붙은 조각은 `recall`과 `context`의 결과에서 빠진다. 지시서에 실리지 않는다. 기계 검사가 같은 것을 잡으므로 글로 다시 말할 까닭이 없다.

빠진 조각은 지우지 않는다. `recall`은 개수만 알린다(`enforced_omitted: 4`). `rule-candidates --enforced`로 목록을 본다.

**다시 올린다.** `recall`이나 `context`에서 `--validate-artifacts`를 켰을 때, `enforced_by.artifact`의 파일이 없거나 해시가 달라졌으면 그 조각을 다시 결과에 넣고 `enforcement_stale`로 표시한다. 규칙이 지워졌거나 바뀌었을 수 있으므로 리드가 확인한다. 해시가 달라졌다고 규칙이 사라진 것은 아니다. 설정 파일은 다른 이유로도 바뀐다. 확인한 뒤 `enforce`를 새 해시로 다시 적으면 된다.

`--validate-artifacts`를 켜지 않으면 확인하지 않는다. 그 경우 규칙이 조용히 사라져도 조각이 돌아오지 않는다는 점을 문서에 적는다.

### 하지 않는 것

- 모델이 규칙을 제안하거나 쓰는 일(리드가 고르고, 규칙은 작업으로 만든다)
- 조각의 말이 달라도 같은 실수로 묶는 일
- 규칙이 실제로 그 실패를 잡는지의 검증. `enforce`는 리드의 확인을 적을 뿐이다. 검증은 규칙을 만든 작업의 수용 테스트가 한다
- `error` 밖의 종류(`procedure`, `decision`)를 후보로 올리는 일

### 바뀌는 파일

| 파일 | 변경 |
|---|---|
| `scripts/memory-store.mjs` | `ruleCandidates`, `enforced_by`·`not_enforceable` 기록, `recall`·`context`에서 빼기와 다시 올리기 |
| `scripts/memory-provenance.mjs` | `enforced_by.artifact` 확인 |
| `scripts/memory.mjs` | `rule-candidates` 명령, `commit`의 `rules` 처리 |
| `references/memory.md`, `memory-recall.md` | 절차와 한계 |
| `tests/memory-rules.test.mjs` | 새 테스트 |

### 테스트로 고정할 것

- 출처 작업이 하나뿐인 조각, `error`가 아닌 조각, 검토 대기·기각 조각은 후보가 아니다.
- `expected_digest`가 다르면 아무것도 기록되지 않는다.
- `artifact`가 없거나 경로·해시 형식이 틀린 `enforce`는 거절된다.
- `enforce`된 조각은 `recall`·`context`에 나오지 않고 개수만 나온다. 저장 파일에서 지워지지 않는다.
- `--validate-artifacts`에서 파일이 없거나 해시가 다르면 `enforcement_stale`로 다시 나온다.
- `not_enforceable`인 조각은 후보에서 빠지고 회수에는 그대로 나온다.
- `rule-candidates`는 저장 파일을 바꾸지 않는다(전후 바이트 비교).
- 두 필드가 없는 기존 저장 파일에서 기존 테스트가 그대로 통과한다.

### 받아들이는 조건

- `enforce`한 조각과 같은 실패가 그 뒤의 작업에서 리뷰 반려로 다시 나오지 않아야 한다. 나오면 그 규칙이 잡지 못한 것이므로 `enforce`를 되돌린다.
- 지시서의 `prior_experience` 길이가 줄어야 한다.
- 숨김 시험 통과와 `wrong_closes`가 나빠지지 않아야 한다.

표본이 쌓이려면 같은 저장소에서 작업이 여러 번 돌아야 한다. 기억 계층을 쓰는 저장소 하나에서 먼저 본다.

---

## 정할 것

1. 정적 검사가 실패했을 때 수용 테스트도 돌릴지. 초안은 돌린다(재지시 한 번에 둘 다 알려 준다). 수용 테스트가 오래 걸리는 저장소에서는 건너뛰는 편이 나을 수 있다.
2. `static_protect`를 필수로 둘지. 초안은 필수다. 빼면 일꾼이 설정을 고쳐 통과시키는 길이 열린다.
3. 규칙 후보의 문턱. 초안은 서로 다른 작업 둘 이상이다.
4. `static_commands`를 작업마다 리드가 적게 할지, 저장소별로 한 번 승인해 두고 `"@repo"`로 불러 쓰게 할지. 초안은 작업마다 적는다. 불러 쓰기는 리드 토큰을 조금 아끼지만 승인된 명령을 저장소 밖에 둘 자리가 따로 필요하다.
