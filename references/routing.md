# 일꾼 배치 (routing)

v0.3은 [External-First 운영 안내](universal-supervisor.md)를 따른다. 아래는 classic 기본 배치다. External-First의 자동 제외 정책은 initial, 신규 후보 탐색, 교체와 lease 발급에 모두 적용하며, 명시 grant 없는 Sonnet/Sol과 reserve Haiku를 fallback에 다시 넣지 않는다.

리드는 작업마다 일꾼을 능동적으로 고른다. 감으로 고르지 않고 **능력(caps)으로 거르기 → 배치표 순서 → 실적 → 설치 상태** 순으로 결정하며, 결정 근거를 `state.routing.reason`에 남긴다.

## brief 힌트

```json
{"task_kind": "code", "difficulty": "high"}
```

- `task_kind`: `code`, `ui`, `image-asset`, `tests`, `refactor`, `docs` (생략 가능)
- `difficulty`: `low`, `medium`, `high` (생략 가능)

리드가 계획 단계에서 판단해 적는다. 큰 작업에 종류가 섞여 있으면 **작업을 쪼개서** 각각 init 한다(예: 아이콘 생성은 image-asset 작업, 화면 연결은 ui 작업). 한 작업 안에서 일꾼마다 종류를 바꾸지 않는다.

## 능력(caps)으로 거르기

배치는 이름이 아니라 능력으로 후보를 거른다. 작업 종류마다 필요한 능력이 하나 있다: `code`→`code`, `tests`→`tests`, `refactor`→`refactor`, `ui`→`ui`, `docs`→`docs`, `image-asset`→`image-gen`. 기본 능력은 Grok·Luna가 `code, tests, refactor, ui, docs, image-gen`, Antigravity·Sonnet·Haiku가 `code, tests, refactor, ui, docs`(이미지 생성 없음)다.

설정의 `executors.<이름>.caps`로 덮어쓴다. 예를 들어 이미지 생성이 되는 새 모델로 바꿨다면 그 일꾼의 caps에 `image-gen`을 넣기만 하면 되고, 배치표를 고칠 필요가 없다. 능력이 없는 일꾼은 배치표에 적혀 있어도 거르고 `lacks <능력>: <일꾼>`을 근거에 남긴다. 사용자가 직접 쓴 `routing.rules`에 능력 없는 일꾼을 적으면 실수로 보고 설정 검증에서 거절한다.

```json
"executors": {
  "haiku": {"model": "claude-haiku-5-5", "caps": ["code", "tests", "docs"]},
  "antigravity": {"model": "<새 Gemini 모델>", "caps": ["code", "ui", "docs"]}
}
```

일꾼은 CLI(어댑터), 모델은 설정값이다. 같은 CLI의 새 모델(예: Antigravity의 새 Gemini, Claude Code의 새 Claude 모델)은 어댑터를 새로 짤 필요 없이 `model`만 바꾸면 된다(CLI가 `--model`을 지원해야 한다).

## 기본 배치표

| task_kind | difficulty | 투입 순서 | 이유 |
|---|---|---|---|
| image-asset | * | Grok → Luna | 이미지 생성 능력(`image-gen`)이 있는 일꾼 |
| code | medium, high | Sonnet → Grok → Antigravity | 까다로운 구현은 Sonnet |
| code | low | Grok → Haiku → Antigravity → Sonnet | 쉬운 구현은 빠른 일꾼부터 |
| tests | * | Sonnet → Grok → Antigravity | 테스트 설계·디버깅 |
| refactor | * | Sonnet → Antigravity → Grok | 넓은 범위 리팩터 |
| ui | * | Antigravity → Sonnet → Grok | 프론트엔드·UI |
| docs | * | Antigravity → Haiku → Grok → Sonnet | 가벼운 일꾼부터 |
| (없음) | * | Sonnet → Grok → Antigravity | 기본 |

첫 번째로 맞는 규칙만 쓴다. 배치표에 없지만 고용되고 능력이 있는 일꾼은 맨 뒤 예비 인력이 된다. 능력이 없는 일꾼은 예비 인력으로도 넣지 않는다. 이 표는 출발점일 뿐 측정된 사실이 아니다. `hyperfusion.config.json`의 `routing.rules`로 통째로 바꿀 수 있다.

## 실적 반영

제어 폴더의 `metrics/*.json`에서 같은 `(task_kind, difficulty)`의 실적을 집계한다. 난이도가 없는 이전 지표는 난이도가 없는 작업에만 반영한다. 기록 시각부터 `half_life_days`(기본 90일)의 반감기로 가중치를 줄인다. 시각이 없는 이전 기록은 현재 표본으로 취급한다. 첫 일꾼의 표본 가중치는 1, 실패한 작업을 이어받은 일꾼은 0.5다. 통과 점수는 자기 라운드 수의 역수로 계산한다. 가중 표본이 `min_samples`(기본 3) 이상이고 점수가 `demote_below`(기본 0.4) 미만이면 뒤로 민다.

`explore_every`(기본 10)번째 같은 종류·난이도 작업에서는 강등된 일꾼도 번갈아 첫 후보로 배치한다.

**신입 우대(cold start).** 실적이 없는 새 일꾼은 배치표 뒤쪽에 있으면 영영 기회를 못 받는다. 그래서 그 종류·난이도에 실적 있는 일꾼이 있을 때, `newcomer_every`(기본 4)번째 작업마다 표본이 `min_samples`보다 적은 일꾼 중 가장 적은 쪽을 첫 후보로 시켜 본다(`newcomer trial first pick`). 실패하면 평소처럼 반려·교체되므로 비용은 한 라운드로 제한된다. 아무도 실적이 없는 처음에는 배치표 순서 그대로다. 0이면 끈다. 0이면 탐색을 끄고, `routing.learn:false`면 학습 전체를 끈다. 명시적인 executor 지정은 계속 우선한다.

CLOSE/BLOCKED 전이에서 컨트롤러가 지표를 자동 기록한다. 리드 사용량을 추가할 때만 `metrics.mjs`를 다시 호출한다.

## 설치 상태

auto 배치 시 순서대로 CLI를 프로브하고 없는 일꾼은 건너뛴다(사유 기록). 아무도 없으면 `ADAPTER_UNAVAILABLE`로 실패한다. 리드가 대신 구현하지 않는다.

## 교체 순서

- `alternative` 판정 후 `begin`에 `executor`를 생략하면, 배치 순서에서 **방금 반려된 일꾼 다음**부터 돌아가며 예산 있는 일꾼을 투입한다.
- 같은 반려 사유 2연속 → 자동 ALTERNATIVE_REQUIRED → 위와 같은 순서.
- 리드가 `executor`를 명시하면 그대로 따른다. init에서 명시하면 `routing.mode:"explicit"`이고 router 추천은 근거에 함께 기록된다.

## 수동 확인

```sh
node $HF_SKILL/scripts/router.mjs $HF_REPO BRIEF.json
```
상태를 바꾸지 않고 배치 결과와 근거만 출력한다.
