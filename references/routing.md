# 일꾼 배치 (routing)

리드는 작업마다 일꾼을 능동적으로 고른다. 감으로 고르지 않고 **배치표 규칙 → 실적 → 설치 상태** 순으로 결정하며, 결정 근거를 `state.routing.reason`에 남긴다.

## brief 힌트

```json
{"task_kind": "code", "difficulty": "high"}
```

- `task_kind`: `code`, `ui`, `image-asset`, `tests`, `refactor`, `docs` (생략 가능)
- `difficulty`: `low`, `medium`, `high` (생략 가능)

리드가 계획 단계에서 판단해 적는다. 큰 작업에 종류가 섞여 있으면 **작업을 쪼개서** 각각 init 한다(예: 아이콘 생성은 image-asset 작업, 화면 연결은 ui 작업). 한 작업 안에서 일꾼마다 종류를 바꾸지 않는다.

## 기본 배치표

| task_kind | difficulty | 투입 순서 | 이유 |
|---|---|---|---|
| image-asset | * | Grok → Luna | 이미지 생성은 Grok과 Luna만 가능 |
| code | medium, high | Sonnet → Grok → Antigravity | 까다로운 구현은 Sonnet |
| code | low | Grok → Antigravity → Sonnet | 쉬운 구현은 Grok부터 |
| tests | * | Sonnet → Grok → Antigravity | 테스트 설계·디버깅 |
| refactor | * | Sonnet → Antigravity → Grok | 넓은 범위 리팩터 |
| ui | * | Antigravity → Sonnet → Grok | 프론트엔드·UI |
| docs | * | Antigravity → Grok → Sonnet | 가벼운 일꾼부터 |
| (없음) | * | Sonnet → Grok → Antigravity | 기본 |

첫 번째로 맞는 규칙만 쓴다. 배치표에 없지만 고용된 일꾼은 맨 뒤 예비 인력이 된다. 단, Antigravity CLI와 Sonnet(Claude Code)에는 이미지 생성 기능이 없어서 `image-asset` 작업에는 예비 인력으로도 넣지 않고, `image-asset` 규칙에 이 둘을 적으면 설정 검증에서 거절된다. 이 표는 출발점일 뿐 측정된 사실이 아니다. `hyperfusion.config.json`의 `routing.rules`로 통째로 바꿀 수 있다.

## 실적 반영

제어 폴더의 `metrics/*.json`에서 같은 `(task_kind, difficulty)`의 실적을 집계한다. 난이도가 없는 이전 지표는 난이도가 없는 작업에만 반영한다. 기록 시각부터 `half_life_days`(기본 90일)의 반감기로 가중치를 줄인다. 시각이 없는 이전 기록은 현재 표본으로 취급한다. 첫 일꾼의 표본 가중치는 1, 실패한 작업을 이어받은 일꾼은 0.5다. 통과 점수는 자기 라운드 수의 역수로 계산한다. 가중 표본이 `min_samples`(기본 3) 이상이고 점수가 `demote_below`(기본 0.4) 미만이면 뒤로 민다.

`explore_every`(기본 10)번째 같은 종류·난이도 작업에서는 강등된 일꾼도 번갈아 첫 후보로 배치한다. 0이면 탐색을 끄고, `routing.learn:false`면 학습 전체를 끈다. 명시적인 executor 지정은 계속 우선한다.

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
