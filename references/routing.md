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
| image-asset | * | Grok → Antigravity | Grok Build는 CLI 안에서 이미지 생성 지원이 알려져 있음(설치 버전에서 확인 필요) |
| code | medium, high | Sonnet → Grok → Antigravity | 까다로운 구현은 Sonnet |
| code | low | Grok → Antigravity → Sonnet | 쉬운 구현은 Grok부터 |
| tests | * | Sonnet → Grok → Antigravity | 테스트 설계·디버깅 |
| refactor | * | Sonnet → Antigravity → Grok | 넓은 범위 리팩터 |
| ui | * | Antigravity → Sonnet → Grok | 프론트엔드·UI |
| docs | * | Antigravity → Grok → Sonnet | 가벼운 일꾼부터 |
| (없음) | * | Sonnet → Grok → Antigravity | 기본 |

첫 번째로 맞는 규칙만 쓴다. 배치표에 없지만 고용된 일꾼은 맨 뒤 예비 인력이 된다. 이 표는 출발점일 뿐 측정된 사실이 아니다. `hyperfusion.config.json`의 `routing.rules`로 통째로 바꿀 수 있다.

## 실적 반영

`.fusion/metrics/*.json`(매 작업 종료 시 `metrics.mjs`로 기록)에서 같은 `task_kind`에 대해 일꾼별로 "참여한 작업 중 pass 판정을 받은 비율"을 센다. 표본이 `min_samples`(기본 3) 이상이고 비율이 `demote_below`(기본 0.4) 미만이면 그 일꾼을 순서 맨 뒤로 민다. 제외하지는 않는다. `routing.learn:false`로 끈다.

그래서 **CLOSE든 BLOCKED든 작업이 끝나면 항상 `metrics.mjs`를 돌린다.** 안 돌리면 router가 배우지 못한다.

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
