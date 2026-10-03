# 상태와 실행 명령

`node SKILL/scripts/fusion-state.mjs ACTION REPO_ROOT [INPUT.json]`. 입력은 파일로만 넘긴다. `--executor NAME`은 init에서만 받는다.

| 동작 / 상태 | 입력 / 결과 |
|---|---|
| init | brief(+task_kind, difficulty), 선택 executor 또는 auto → PLAN, 기준 스냅샷, 고정된 설정, 배치 결과(`routing`) |
| begin (PLAN) | 기본 일꾼에게 lease와 dispatch |
| begin (REDO) | 같은 일꾼·같은 세션. `lead_feedback` 필수 |
| begin (ALTERNATIVE_REQUIRED) | `executor` 생략 시 배치 순서상 다음 일꾼, 지정 시 그 일꾼. `lead_feedback` 필수. 기존 세션이 있으면 재개 |
| begin (TAKEOVER_REQUIRED) | `takeover_reason` 필수. 리드가 lease를 받음 |
| finish | token, quiescent:true, result → REVIEW 또는 RECOVERY_REQUIRED. 브리지가 남긴 세션 ID를 묶음 |
| review | 판정/근거/증거 → 다음 단계 |
| decide | decision → 같은 일꾼 REDO(예산 내) |
| verify | acceptance_satisfied:true, 실제 통과 테스트 → CLOSE |
| recover | token(보유 시), quiescent:true, reason |
| archive | quiescent:true, reason, token(보유 시) → ARCHIVED |
| status | 상태, 다이제스트, 일꾼별 남은 예산 |

일꾼 begin은 lease와 시도를 쓰기 전에 CLI를 프로브한다. 반환된 `command`/`args`(executor-bridge)를 라운드당 한 번 실행한다. RESULT_READY 후에도 lease는 유지되고, 리드가 정지 확인 후 finish 한다.

예산: Grok 3, Antigravity 3, Sonnet 3, 리드 takeover 1 → 최대 10 변경 라운드. lease 획득 후 중단은 시도를 소모한다. 일꾼 소진 시 순서: 예산 있는 다른 일꾼 → (다른 일꾼이 없으면) 같은 일꾼 → 리드 takeover(허용 시) → BLOCKED.

스키마 v4가 Opus 리드 구조다. `lead_target_model`은 `claude-opus-5-5`, `lead_model:null`은 실제 호스트 모델이 확인되지 않았다는 뜻이다. 테스트: `node --test SKILL/tests/*.test.mjs`. 대역 CLI는 프로세스/프로토콜 동작만 검증한다.
