# External-First + Universal Supervisor v0.3

신규 작업에서 `hyperfusion.v03.config.example.json`을 `hyperfusion.config.json`으로 복사해 명시적으로 켠다. classic 설정과 진행 중 작업은 자동 이행하지 않는다. 설정은 init 때 고정된다. 설치된 전역 스킬을 이 저장소 코드로 자동 교체하지 않는다.

## 구현자와 판정

자동 구현 후보는 Grok, Antigravity, Luna다. Haiku는 reserve를 명시적으로 끄거나 해당 작업에서 직접 지정할 때만 사용한다. Sonnet과 Sol은 자동 탐색·신입 우대·교체 후보에 들어가지 않는다. 팀의 `owns`나 설정의 모델 이름은 구현 승인이 아니다.

`init`에서 `task_criticality`는 `standard|important|apex`, `assignment_strategy`는 `external_primary|dual_review|sonnet_implementation|sol_apex`다. Sonnet 전문 구현은 important/sonnet_implementation, Sol 구현은 apex/sol_apex와 비어 있지 않은 `assignment_reason`을 사용한다. controller grant는 한 라운드에만 소비되며, 외부 저장소 설정이나 워커 결과·감시 이벤트로 만들지 않는다. Sonnet 기본 라운드 상한은 계속 3회이며, APEX Sol도 작업당 최대 3개 승인 라운드로 제한한다.

| 실제 라운드 작성자 | 필수 독립 리뷰 |
|---|---|
| Grok/Antigravity 일반, Haiku, 승인된 Sonnet | Sol medium |
| Luna | Sonnet high |
| Grok/Antigravity 중요 또는 dual_review | Sol medium + Sonnet high, 동일 digest에서 각각 PASS |
| 승인된 APEX Sol | 호스트 리드의 실제 diff·테스트·변경 범위 직접 리뷰 |

`delegate-review → bridge --consult → consult-finish` 이후 필수 결과는 별도로 보존되고 `LEAD_DECISION_REQUIRED`에서 멈춘다. `auto_apply:true`, `review {adopt:true}`, autopilot은 이 게이트를 건너뛰지 못한다. 승인 입력은 `decision`, `rationale`, `baseline_digest`, `contract_change`다. `APPROVE`는 VERIFY만 열며 CLOSE에는 계속 수용 검사와 quiescence가 필요하다. Sol 직접 리뷰 승인에는 `diff_reviewed:true`, 이름을 명시한 `tests_checked`, `changed_scope`도 필요하다.

컨트롤러 명령을 호출한 호스트가 실제 Opus인지 프로세스 출력이나 모델 이름 문자열로 인증할 수는 없다. 모델 신원은 호스트 통합이 보증해야 한다. 현재 기록은 `authority.model_verified:false`, 실제로 관측하지 않은 모델은 null이며, boolean 입력만으로 '실제 Opus 독립 기술 리뷰 완료'라고 인증하지 않는다. 제어 폴더는 작업 폴더 밖에 두지만 이는 OS 수준 접근 격리의 대체물이 아니다.

## 로컬 감시

```powershell
node scripts/fusion-state.mjs status C:\path\repo --monitor
node scripts/fusion-state.mjs monitor C:\path\repo --once
node scripts/fusion-state.mjs monitor C:\path\repo --watch
```

`status --summary`의 기존 필드는 그대로다. 관측은 성공이나 진행률이 아니다. `STARTING/ACTIVE/QUIET/WAITING/EXITED/ERROR/UNKNOWN`은 작업 phase와 별개다. 브리지는 1초마다 로컬 관측을 갱신하며 기본 120초 무신호는 QUIET 경고만 만든다. 종료·timeout·interrupt 시 타이머를 정리한다. WAITING은 검증된 스트림/훅 증거가 있어야 한다. 현재 어댑터는 공식 structured telemetry를 연동했다고 주장하지 않으며 `structured_events:not-enabled`, `telemetry_limited:true`, 도구 수 null인 출력·프로세스 폴백을 사용한다. CLI help에 없는 스트리밍 플래그나 글로벌 훅을 추가하지 않는다.

`controlPath/tasks/<task>/` 아래 `activity-<tag>.ndjson`, `monitor-<tag>.json`, `alerts-<tag>.json`을 저장한다. implement/review/consult는 같은 supervisor를 사용하고, 상담 tag는 consult ID와 멤버 ID를 포함한다. 컨트롤러가 task/round/run/executor/role을 부여하며 CLI JSON은 비신뢰 데이터다. UTF-8은 완성된 newline 프레임에서만 디코딩하고, 과대 프레임은 다음 newline까지 폐기한다. 불완전한 마지막 프레임을 완료 이벤트로 취급하지 않는다.

기본 상한은 활동 400건/256KiB, 알림 64건, 중복 키 512개다. 상세 텍스트는 redaction 후 240자로 제한한다. terminal 중복 키는 유지하고 per-event ID는 제한된 창에서 중복 제거한다. 같은 identity로 다시 열면 reducer·카운터·중복·알림을 복원하고 다른 run identity 재사용은 거절한다. 종료가 확인된 30일 이전의 관측 파일만 다음 open에서 정리하며 결과·writer·snapshot·launch 증거는 삭제하지 않는다. 감시 파일의 symlink·과대 크기는 거절한다. 지원 OS에서 파일 0600/폴더 0700이며 Windows ACL을 보장한다고 주장하지 않는다.

## Quota, effort, 최종 패킷

`node scripts/quota-policy.mjs REPO record QUOTA.json`으로 운영자 관측을 기록하고 `REPO status`로 조회한다. provider는 anthropic/openai/xai/google, source는 user_manual/supported_tool/unknown이다. collected_at, ttl_ms, reset_at, window, unit을 보존하며 잔량 누락·TTL 만료·reset 경과는 unknown/stale로 남긴다. xai는 검증된 자동 조회 도구가 없어 user_manual만 받는다. `supported_tool`이라는 저장 필드 자체는 실제 도구 연결을 증명하지 않는다. quota 조회 모델 호출은 없다. 신입·탐색 우대가 fresh exhaustion의 뒤쪽 배치를 되돌리지 않도록 최종 정렬한다.

Grok/AGY 난이도별 effort를 기본 설정에 적용하고 운영자가 직접 지정한 값은 보존한다. Sonnet 중요 구현/리뷰는 high, Sol APEX/리뷰는 medium이다. CLI flag 미지원은 preflight 오류이며 의미를 추측해 성공으로 처리하지 않는다. `setup-doctor`의 help/version 검사와 실제 인증·모델 smoke는 구분한다.

`lead-packet-N.json`은 task/round/owner/model/effort/criticality/commit/digest, 기준 목록, acceptance 및 검수 격차, quota, 사용량, 근거 파일 위치와 추천 액션을 담는다. diff·stdout/stderr 본문을 리드 패킷에 넣지 않는다. 근거가 많은 경우 2KB를 넘을 수 있으며 의미를 없애기 위해 필수 검수 증거를 잘라내지 않는다. `consumed_usage`는 기존 호환 필드이며 구현 호출 사용량이다. `implementation_usage`와 별도의 source/total_tokens를 받는 `decision_usage`로 구분한다. 호스트 전체 사용량과 라운드별 결정 사용량을 이중 합산하지 않는다.

## 사용량 측정

metrics는 implementation, review, consult 및 실패 launch를 tag별 한 호출로 합친다. 토큰은 vendor total 또는 input/output/cache의 완전한 보고만 사용한다. 모델별 vendor modelUsage가 있으면 실행기 이름보다 우선하며, 모델이 확인되지 않은 Claude 호출은 모델별 합계를 null로 유지한다. 누락·실패 호출의 토큰/비용은 null이다. APEX Sol도 구현 라운드 수에 포함한다. 기존 worker_usage는 구현 산출물 호환 필드이며 전체 호출은 run_usage, usage_by_executor, usage_by_model에서 확인한다.

호스트의 작업 전체 관측 입력은 `{"source":"host ledger","lead_tokens":1234,"lead_model":"claude-opus-5-5"}`로 metrics에 별도 전달한다. 실제 관측 model이 없으면 Opus 토큰으로 귀속하지 않는다. 설정의 target model을 실제 호출 증거로 대신하지 않는다. 자동 재집계는 이미 기록한 호스트 관측을 보존한다. `claude_tokens_per_success`와 모델별 성공당 집계는 실패 작업 비용도 분자에 넣고, 하나라도 미측정이면 null이다. 가격 추정이나 billed cost 주장은 하지 않는다.

## 검증과 제한

`npm test`는 Windows에서 파일을 순차 실행하고 다른 OS에서는 파일 동시 실행을 2로 제한한다. Windows CIM의 호스트 전체 프로세스 목록을 공유하는 병렬 테스트가 서로의 orphan 검사에 영향을 주지 않도록 격리한다. 제품의 종료 증명·fail-closed 조건과 테스트 내용은 유지한다. acceptance security integration은 첫 검사가 통과한 뒤 별도로 실행한다. CI는 Windows/Linux × Node20/24다. 로컬 PASS는 실제 CI 또는 인증·실모델 smoke PASS와 같지 않다. live smoke는 별도 옵트인 때만 수행한다. main 병합·release·배포는 별도 허가 없이는 실행하지 않는다.
