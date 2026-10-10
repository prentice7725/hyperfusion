# v0.3 구현 및 검증 기록 — 2026-10-10

사용자가 HyperFusion 자체 변경을 이 세션에서 직접 구현하도록 명시적으로 허용했다. 기존 작업 트리의 v0.3 초안을 이어서 수정했으며, 외부 실행기로 코드·문맥을 전송하지 않았다. 이 기록은 실제 Opus 실행 또는 Opus 독립 검수가 완료됐다는 주장이 아니다.

## 구현 범위

| 영역 | 이번 보완 | 검증 근거 |
| --- | --- | --- |
| 범용 감시 | partial UTF-8/NDJSON 프레임, 과대 이벤트 폐기, 실제 QUIET tick, 재시작 복구, 중복·순서 역전 처리, 저장량·보존 기한 | worker-monitor, monitor-bridge, v03-regression |
| 배정·권한 | fallback·탐색·프로젝트에서도 Sonnet/Sol 승인 및 Haiku reserve 유지, dispatch 직전 승인 재검증, APEX 3라운드 제한 | role-gate, router, v03-regression |
| 리뷰·최종 판정 | 라운드 실제 owner별 필수 리뷰, 이중 리뷰, Sonnet 재배정·Sol 재리뷰, 최종 게이트, APEX 직접 리뷰 근거 | adaptive-review, lead-decision, role-gate |
| Quota·effort | 출처·TTL·reset·unknown 분리, 만료 경계, 소진된 실행기의 탐색 우대 차단, 기존 CLI 지원 확인 유지 | quota-policy, v03-regression, router |
| 계측 | 구현·리뷰·상담·실패 호출, Sol 구현, cache 토큰, 실제 vendor 모델별 사용량, 호스트 관측 보존, 실패 포함 성공당 Claude 토큰 | metrics |
| 설정·문서 | 프로젝트 strategy 전달, opt-in 설정 예제, 운영·계측 문서, Phase 5 앱 핸드오프 설계 | project, 상태 문서 생성 검증 |

v0.3은 [설정 예제](../hyperfusion.v03.config.example.json)의 `external-first` 및 `lead-gated-adaptive`를 명시적으로 켜서 사용한다. 기존 classic 작업에 새 정책을 소급 적용하지 않는다. 명령과 저장 계약은 [범용 Supervisor 운영 문서](universal-supervisor.md)에 정리했다.

## 검증 결과

전체 `npm test`의 첫 단계는 358개 중 356 PASS, 1 FAIL, 1 SKIP였다(약 19분 42초). SKIP은 opt-in 실 CLI 검사다. FAIL은 `worker_rounds`에 Sol 키를 모든 classic 작업에도 추가한 호환성 오류였다. 실제 Sol 구현 호출이 있는 작업에만 해당 키를 추가하도록 수정한 뒤, 실패한 기존 테스트와 Sol/vendor 계측 회귀 3개가 모두 PASS했다. 전체 npm 명령을 수정 후 다시 실행하지 않았으므로 최초 실행의 실패를 숨기거나 전체 npm PASS로 표시하지 않는다.

첫 단계 실패로 npm의 `&&` 후반이 생략되어 `node --test tests/acceptance-security.integration.mjs`를 별도로 실행했고 9개가 모두 PASS했다. Windows에서 프로세스 조회가 과도하게 겹치지 않도록 파일 동시 실행을 2로 제한했으며, 기존 보안 integration 실행은 유지했다.

직접 수정 전후의 핵심 통합 회귀 검사 51개가 통과했다. 추가 계측·쿼터 검사 9개, 모니터 검사 18개, quota TTL/탐색 경계 검사 2개도 통과했다. 이 실행들은 일부 테스트가 중복되므로 합쳐서 독립 테스트 수로 보고하지 않는다. 상태 문서 생성 검증과 `git diff --check`도 통과했다.

원본 로그는 이 세션의 `v03-validation` 산출물 폴더에 보존했다. 전체 로그 `hf-v03-full-20261010.log`, 수정 재검사 `hf-v03-compatibility-final.log`, 보안 검사 `hf-v03-security-final.log`를 구분해 확인한다.

최종 코드에서 `metrics`, `worker-monitor`, `v03-regression`, `quota-policy` 네 파일을 함께 재실행해 32/32 PASS했다(`hf-v03-final-focused.log`). 기준 HEAD는 `781d4863f3db15f7a5a4c620e79db05299548e83`이다. 이 검증 기록은 작업 브랜치 커밋 전에 작성했다.

## 남은 실제 환경 검증

- CI 설정은 Windows/Linux × Node 20/24지만 이번 세션에서는 Windows/Node 24 로컬 검사만 수행했다. 새 CI 실행 URL은 없다.
- 실 CLI 인증·모델 smoke는 실행하지 않았다. 이전 doctor의 help/version 확인은 실모델 성공 증거가 아니다.
- 공식 structured telemetry 연결은 아직 사용하지 않는다. 현재 모든 어댑터는 프로세스·출력 관측 fallback이며 실제 도구 수와 작업 진행률을 추정하지 않는다.
- 최종 판단은 컨트롤러의 호스트 승인 기록으로 강제한다. 호스트가 실제 Opus인지 이 CLI가 독립적으로 인증하지 못하므로 `model_verified:false`를 기록한다. AC25/AC28의 실제 Opus 호출·독립 검수 증명은 미확인이다.
- Phase 5는 [후속 설계](app-handoff-design.md)만 작성했다. 앱 연결·외부 전송·라이선스 검증 또는 소스 재사용은 수행하지 않았다.

위 항목은 로컬 mock PASS와 구분해야 한다. 이후 사용자가 작업 브랜치의 커밋·push를 명시적으로 요청했다. main 병합·release·배포는 이번 요청에 포함되지 않는다.
