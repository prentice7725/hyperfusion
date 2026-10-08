# 상태와 실행 명령

`node SKILL/scripts/fusion-state.mjs ACTION REPO_ROOT [INPUT.json|-]`. JSON 파일이나 stdin(`-`)을 받는다. `--executor NAME`은 init에서만 받는다.

| 동작 / 상태 | 입력 / 결과 |
|---|---|
| init | (프로젝트가 있으면 승인된 상태 + 현재 마일스톤의 계획된 작업 ID만, 팀 설정 고정) brief(+task_kind, difficulty), 선택 executor 또는 auto → PLAN, 기준 스냅샷, 고정된 설정, 배치 결과(`routing`) |
| begin (PLAN) | 기본 일꾼에게 lease와 dispatch |
| begin (REDO) | 같은 일꾼·같은 세션. `lead_feedback` 필수 |
| begin (ALTERNATIVE_REQUIRED) | `executor` 생략 시 배치 순서상 다음 일꾼, 지정 시 그 일꾼. `lead_feedback` 필수. 기존 세션이 있으면 재개 |
| begin (TAKEOVER_REQUIRED) | `takeover_reason` 필수. 리드가 lease를 받음 |
| finish | token, quiescent:true, 선택 result(생략하면 브리지의 result-N.json) → REVIEW 또는 RECOVERY_REQUIRED. 브리지가 남긴 세션 ID를 묶음 |
| review | 판정/근거/증거 → 다음 단계. `{"adopt":true}`면 보류된 위임 판정 채택 |
| decide | decision → 같은 일꾼 REDO(예산 내) |
| verify | acceptance_satisfied:true, 실제 통과 테스트 → CLOSE. brief에 `acceptance_commands`가 있으면 컨트롤러가 직접 돌린 결과가 증거이고 `tests`는 선택이다(finish 직후 실행이 통과했고 트리가 그대로면 재사용). 무시된 파일이 바뀌어 실행을 건너뛰었으면 확인 후 `acceptance_trust_ignored:true`. 여기서 실패하면 REDO로 되돌린다. 최초 기준선과 비교해 허용 범위 밖 변경이 남아 있으면 거절한다. 알고 받아들일 때만 `allow_out_of_scope: [{path, reason}]` |
| recover | token(보유 시), quiescent:true, reason, 선택 `allow_out_of_scope: [{path, reason}]`(범위 밖에 남은 파일을 알고 받아들일 때) |
| archive | quiescent:true, reason, token(보유 시) → ARCHIVED |
| consult | mode(advisor/committee), question, focus?, executors? → 읽기 전용 상담 dispatch. [consult.md](consult.md) |
| delegate-review | REVIEW에서 다른 모델에게 읽기 전용 리뷰를 맡김(executors? 생략 시 review.reviewers 순서, 구현자 제외) |
| consult-finish | quiescent:true → 위원별 결과. 트리가 바뀌었으면 답변 폐기 후 RECOVERY_REQUIRED |
| status | 기본은 전체 상태. `--summary`면 task_id·phase·owner·remaining·next_action만 출력 |
| report | 현재 작업의 라운드별 담당·판정·소요 시간·비용. 과거 작업은 입력에 task_id 지정 |

일꾼 begin은 lease와 시도를 쓰기 전에 CLI를 프로브한다. 반환된 `command`/`args`(executor-bridge)를 라운드당 한 번 실행한다. RESULT_READY 후에도 lease는 유지되고, 리드가 정지 확인 후 finish 한다.

예산: Grok 3, Antigravity 3, Sonnet 3, Luna 3, 리드 takeover 1 → 최대 13 변경 라운드. lease 획득 후 중단은 시도를 소모한다. 일꾼 소진 시 순서: 예산 있는 다른 일꾼 → (다른 일꾼이 없으면) 같은 일꾼 → 리드 takeover(허용 시) → BLOCKED.

스키마 v4가 Opus 리드 구조다. `lead_target_model`은 설정한 Opus 모델 ID(기본 `claude-opus-5-5`), `lead_model:null`은 실제 호스트 모델이 확인되지 않았다는 뜻이다. 테스트: `node --test SKILL/tests/*.test.mjs`. 대역 CLI는 프로세스/프로토콜 동작만 검증한다.

## 설치되지 않은 일꾼, 끝난 작업, 정산 기록

- **설치 여부:** `external.available`에 있어도 CLI가 설치돼 있지 않으면 그 일꾼은 교체 후보와 "예산이 남았다"는 판단에서 빠진다. 컨트롤러 호출마다 새로 확인하므로 나중에 설치하면 바로 반영된다. 교체할 일꾼이 하나도 없으면 같은 단계에 갇히지 않고 takeover 또는 BLOCKED로 넘어간다. `status`의 `unavailable`에 사유가 나온다.
- **끝난 작업:** CLOSE, BLOCKED, ARCHIVED가 되면 다음 작업을 `init`할 수 있다. 막힌 작업을 정리하려고 archive를 거칠 필요가 없고, archive 해도 프로젝트에는 `blocked`/`closed` 결과가 그대로 남는다.
- **정산:** 작업이 CLOSE나 BLOCKED가 되는 순간(begin, review, decide, recover, verify 어느 경로든) 지표 기록, 프로젝트 마일스톤 갱신, 기억 후보 추출이 한 번 실행된다. 하나가 실패해도 나머지는 계속하고, 실패는 상태의 `metrics_error`, `project_error`, `memory_error`에 남는다. 이 필드가 있으면 router 학습이나 프로젝트 진행이 일부 빠진 것이니 확인한다.
- **선택 기능의 실패:** 기억 장부 기록이 실패해도 검증을 통과한 라운드는 버려지지 않는다(`memory_error`만 남는다).

상태별 허용 동작의 정본은 `scripts/state-policy.mjs`, 생성 문서는 [state-actions.md](state-actions.md)다. `npm run docs:states`로 문서와 스키마의 phase 목록을 생성한다. 오류·타임라인·잠금·작업 상한·병렬 worktree 사용법은 [operations.md](operations.md)를 참고한다.
