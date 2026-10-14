# Changelog

버전 표기: 패키지 릴리스(`package.json`)와 별개로 저장 스키마(4), 아키텍처 식별자(`opus-lead-v0.3`), wire protocol(`hyperfusion-opus-lead-v0.5`)은 따로 움직인다. 날짜는 해당 버전이 `package.json`에 처음 들어간 날이다(0.10.0 이전은 기록이 없다). 병합됐지만 아직 버전이 붙지 않은 변경은 맨 위 Unreleased에 둔다.

## Unreleased

## 0.24.0 — 2026-10-14

- Codex 외부 쓰기 경로가 상태·CLI 설정·스킬·Git 메타데이터와 겹치면 거절한다. 부모·자식·링크·아직 없는 보호 경로와 linked worktree의 공통 Git 디렉터리도 검사한다. 빈 운영자 벤더 목록은 설정 오류다.
- 호스트 사용량에 sidechain/subagent와 별도 subagent JSONL을 포함하며 역할별 수치를 기록한다. 끝의 미완성 줄은 재시도하고 토큰 메타데이터만 저장하는 증분 읽기를 추가했다.
- A/B 기준군과 HF군에 같은 측정 창을 제공하고 고정 fixture 10개(Java 2개, Java/Spring MVC 1개 포함)를 추가했다. 시작 트리·fixture·scope·사용량 구성이 같아야 비교한다. 원시 토큰 수를 유지하면서 입력 등가 가중치와 명시적 가격표에 따른 전체 Claude 비용 추정을 제공한다. 실제 파일럿 절감 수치는 없다.
- Codex resume은 probe가 확인한 subcommand에 안전 옵션을 배치한다. 필요한 옵션이 없으면 stateless로 남는다. Luna smoke는 호환 버전에서 REDO까지 실행하며 대역 CLI도 resume 위치를 검사한다. 실제 CLI 호환성과 OS 경계는 이 로컬 환경에서 미검증이다.

## 0.23.0 — 2026-10-14

- AGY 모델 계열과 effort를 분리했다. Gemini 계열+강도는 하나의 슬러그로 합쳐 보내고 중복 effort 플래그는 생략한다. pinned effort는 기본값·자동 난이도로 덮어쓰지 않고 명시 충돌은 거절한다. 모델 목록 검사는 최종 선택 슬러그에 적용한다.
- AGY 구현용 models_by_difficulty 옵트인을 추가하고 기존 모델 기본값은 유지한다. Gemini headless의 low/medium/high와 Enterprise Claude 모델의 max를 구분한다. 없는 계정/effort 슬러그는 lease 전에 거절한다.
- 구현·리뷰·상담의 모델 계열/강도와 usage_by_model_effort 집계를 추가했다. 원래 모델 집계도 유지하며 미지정 항목은 null이다. 기존 Argon 패치는 최신 registry·모델 목록 검사·dispatch 검증에 맞게 재작업했다. 실제 AGY CLI 추론·접근 권한과 토큰 절감은 미검증이다.

- CI 회귀 수정: Codex 대역의 JSONL 전환 후 autopilot decision 테스트가 옛 stdout 문자열을 치환하려다 아무것도 바꾸지 못했다. 공유 대역에 명시적 review-decision 모드를 추가하고 실제 JSONL → 위임 리뷰 → DECISION_REQUIRED 흐름을 별도 회귀 테스트로 검증한다.

## 0.22.0 — 2026-10-14

- Codex JSONL의 thread·최종 메시지·turn 완료를 검증하고 실제 사용량을 기록한다. cached input은 input의 부분집합으로 이중 합산하지 않는다. 호환 resume 도움말 확인 뒤 구현 세션만 작업 단위로 재개하고 상담·리뷰는 새 읽기 전용 세션을 유지한다. 미지원 재개는 stateless로 남고 실패·불완전 이벤트는 거절한다.
- 운영자 전용 Codex 캐시 writable roots·network 옵션, Claude/Grok 작업 난이도별 max-turns 설정을 추가했다. 기본 턴 상한 40과 supervisor 예산은 유지한다.
- allowed_vendors와 운영자 HF_ALLOWED_VENDORS를 구현·리뷰·상담·실행 직전 공통 경로에 적용한다. 방화벽·DLP가 아닌 협력형 실행 정책이며, 임의 모델 제공자 검증은 하지 않는다.
- 벤더·바이너리·기본 모델·인증 접두사·능력·effort·예산·팀 역할을 built-in registry로 모았다. generic CLI/ACP는 미구현이며 새 CLI에는 여전히 검증된 어댑터가 필요하다. classic low 코드 기본 순서에도 Luna를 넣어 팀 역할과 맞췄다.
- SKILL은 classic 흐름부터 읽도록 정리하고 영어 짧은 실행 안내를 추가했다. 세 언어 README와 메타데이터·여섯 팀원 표기를 갱신했다. 대형 상태 머신 전체 분리와 전체 references 번역은 하지 않았다. 공개 커밋 이메일은 새 로컬 커밋에서 noreply를 사용하며 기존 이력은 재작성하지 않는다.

- Codex(Luna·Sol) 라운드가 매번 형식 오류로 끝나던 버그 수정(#38이 만든 회귀): Codex 어댑터의 `strictSchema`는 선택 항목도 모두 필수로 바꿔 보내서, Codex는 `environment_error`를 해당 없는 테스트마다 빈 문자열(`""`)로 채워 냈다. #38의 검사는 빈 문자열을 "사유가 있는데 실패가 아님"으로 보고 `Invalid tests`로 거절했다. 이제 빈 값(`""`, 공백, `null`)은 "없음"으로 받는다. 사유 없는 `fail`은 여전히 `complete`와 모순이고, 사유가 있는데 실패가 아닌 테스트는 여전히 거절한다. 지시문에도 해당 없으면 필드를 빼거나 비우라고 적었다. 결과 스키마의 선택 항목은 `memory_candidates`, `keywords`, `environment_error` 셋뿐이며(새 선택 항목을 더하면 시험이 실패해 Codex의 빈 값을 받는지 확인하게 한다), 나머지 둘은 이미 빈 값을 받는다.
## 0.21.0 — 2026-10-13

- 리드 사용량 자동 회계: Claude Code 종료 훅의 로컬 transcript에서 실제 모델별 input/output/cache를 수집한다. 메시지 중복·세션 재개·연속 작업 귀속을 처리하고 종료 지표를 보정한다. 원문은 저장하지 않으며 수동 관측이 우선하고 누락은 미측정이다.
- 설치된 CLI만으로 팀 초안 생성, 미설치 팀원 propose/approve 거절, doctor 프리셋 추천을 추가했다. 사용자 승인된 Claude+Codex 프로젝트는 low Luna, medium/high Sonnet 구현 grant와 Sol/Sonnet 교차 리뷰를 기본으로 한다. 명시적 배치는 보존한다.
- 고정 A/B 과제 10개와 paired 실측 지표 비교 CLI를 추가했다. 미측정·scope 불일치는 절감률을 내지 않는다. 실제 모델 A/B는 미실행이며 절감 효과를 주장하지 않는다. 영어·한국어·일본어 README와 운영 문서를 갱신했다.

- README를 기본 영어(`README.md`), 한국어(`README.ko.md`), 일본어(`README.ja.md`)로 제공한다. 언어 전환 링크, 최신 Git 설정 보강·누적 리뷰·라운드 사이 drift 검사·PR 초안 동작, Sol APEX 예외와 실제 CLI 검증 한계를 함께 갱신했다.
- 라운드 사이 변경 누락 수정: 후속 `begin`은 현재 트리를 직전 `post_digest`와 비교하고, 프리플라이트 도중 변경도 확인한다. 불일치하면 lease·시도 예산을 쓰기 전에 `RECOVERY_REQUIRED`로 멈춘다. `recover`는 확인한 트리의 digest를 다음 시작 기준으로 기록한다. 리뷰·위험 경로·최종 검증·PR 초안은 `base-1` 대비 최종 누적 변경을 보며, 어느 검증된 일꾼 라운드의 최종 내용에도 일치하지 않는 파일은 `unattributed_changes`로 표시한다. 이전 일꾼 파일을 라운드 밖에서 덮어쓴 경우도 포함한다. 이 변경은 위임 정책의 자동 승인을 막고, 누적 리뷰의 승인 근거가 없는 채 `verify`로 닫을 수 없다. 처음 일꾼이 시작하기 전 사용자 변경은 보존한다.
- Git 설정 보안 보강: 컨트롤러가 include·조건부 include·worktree 설정까지 포함한 실제 적용 설정을 Git 호출 직전에 다시 읽고 실행 가능한 filter/diff/merge 항목을 무력화한다. `.git/config`의 mtime·크기만 보던 설정 캐시는 제거했다(설정 조회 프로세스가 늘지만 include 변경을 놓치지 않는다). 설정 조회 실패는 `GIT_CONFIG_UNREADABLE`로 중단한다. 연결 worktree의 전용 `config.worktree`를 별도로 감시하고, 점이 포함된 드라이버·조건부 include 이름도 위험 검사에 포함한다. HEAD·두 Git 폴더의 rev-parse는 계속 한 번에 구한다.
- 스냅샷의 git 호출 줄이기: `snapshot()`이 HEAD와 공통 git 폴더(`--git-common-dir`)를 `rev-parse` 두 번으로 구하던 것을 한 번(`rev-parse HEAD --git-common-dir`)으로 합쳤다. 한 번에 구하지 못하면(옛 git, HEAD 없음) 예전처럼 따로 부르므로 오류와 동작은 그대로다. 스냅샷 digest와 보호 파일 점검 대상은 바뀌지 않았다(같은 저장소와 링크된 worktree에서 이전 구현과 digest가 같음을 확인했다). 같은 방법으로 센 `npm test`의 하위 프로세스: 15,598개 → 13,673개(−1,925개, −12.3%), `git rev-parse` 4,249개 → 2,336개. Windows에서 git 호출 하나는 25~32ms다. 캐시를 쓰지 않아 `.git` 바꿔치기에 낡은 값이 남을 일이 없다.
- 샌드박스 오류로 실패한 테스트(R2): 일꾼의 샌드박스·환경이 막아서 돌지 못한 테스트를 `status:"fail"`에 `environment_error`(사유)를 붙여 보고하면 `complete`와 함께 받는다(전에는 "Contradictory complete result"로 거절돼 라운드가 RECOVERY_REQUIRED로 멈췄다). 통과로 세지 않는다: 위임 승인은 거절하고, 리드 패킷에 `environment_failures`로 올라가며, 수용 명령은 컨트롤러가 직접 돌린다. 사유 없는 `fail`은 여전히 모순이다. 일꾼 결과 스키마와 지시문에 필드를 추가했다.
- 공유 git 설정 복구 길(R2): `.git/config`, `.git/config.worktree`, `.git/info/exclude`, `.git/info/attributes`가 라운드 중에 바뀌면(`push -u`·`checkout -b` 추적 설정, `worktree add`, 다른 worktree) 범위 밖으로 잡혀 `allow_out_of_scope`로도 받을 수 없던 문제를 고쳤다. 이 네 파일만 사유와 함께 예외로 받는다. 훅과 그 밖의 `.git` 경로는 계속 받지 않는다. 설정에 명령을 실행할 수 있는 항목(`core.fsmonitor`, `!` 별칭, 필터·드라이버, `include` 등)이 있으면 받지 않고, 받은 뒤에 그런 항목이 생기면 예외 효력이 사라진다. 일꾼이 라운드 중 `.git/config`를 바꾸면 오류가 복구 방법을 알려 준다.
- 라운드 상한에 닿은 일꾼의 같은 일꾼 REDO(R2): #36에서 이미 고쳤다. `lead-decision`이 REDO를 거절하고 교체(REASSIGN)를 요구하며, 리드 패킷의 추천도 교체로 바뀐다.

- 작업 상태 한 줄: `HF ▸ 작업 │ 단계 │ 일꾼 라운드/상한 │ 다음 동작`을 `scripts/status-line.mjs` 한 곳에서 만들어 세 곳이 같은 문장을 쓴다. ① `fusion-state.mjs line REPO`(읽기 전용, 잠금 없음, 작업이 없으면 출력 없음), ② lead-guard의 UserPromptSubmit 훅(`systemMessage`라서 사용자 화면에만 보이고 모델 컨텍스트에는 들어가지 않으며 아무것도 막지 않는다), ③ 프롬프트 위 띠 모드 `mods/hf-status`(Bash 호출 뒤·턴 끝·세션 시작에 `line`을 다시 읽고, 줄이 바뀌면 숨김을 풀며, `.claude-plugin/marketplace.json`으로 설치한다). 라운드 상한에 닿은 일꾼은 `상한`으로 표시된다. 띠는 터미널·데스크톱 앱에서만 그려지고 VS Code는 띠 자리를 보장하지 않으므로 UserPromptSubmit 훅이 공통 경로다. `npm run guard:settings` 출력에 `UserPromptSubmit` 항목이 늘었으니, 훅을 이미 설치했다면 그 항목을 설정에 합친다.

## 0.20.0 — 2026-10-12

- 문서 정리: README(한·일)를 현재 기능에 맞춰 다시 썼다(한 작업의 흐름, 재량권·자동 복구·보존 검증·짧은 출력과 `next`·리드 가드 훅·Codex 잔량 읽기를 반영하고, 문서 안내 표를 추가했다). 오토파일럿 설명이 `auto_apply` 필수와 red 전제로 남아 있던 곳(`operations.md`, README, SKILL.md)을 고쳤다. 특정 시점의 검증·감사 기록 3건(`reaudit-v0.10.0`, `improvements-v0.11.0`, `v03-implementation-status`)은 `references/archive/`로 옮겨 '현재 규칙이 아님'을 밝혔다. CHANGELOG는 Unreleased에 쌓여 있던 병합분을 0.20.0으로 묶고 0.11.0 이후 날짜를 달았다. 패키지 버전을 0.20.0으로 올렸다.
- Windows에서 수용 테스트가 이따금 `ACCEPTANCE_NOT_QUIESCENT: Supervised processes remain (csrss.exe …, wininit.exe …, services.exe …)`로 멈추던 문제의 원인을 고쳤다. Windows는 죽은 부모의 PID를 자식의 `ParentProcessId`에 그대로 남기고 PID를 빠르게 재사용한다. 감독하는 프로세스의 PID가 부팅 때 죽은 프로세스의 PID와 같고 그 프로세스가 이미 끝나 표에서 사라지면, 그 옛 PID를 부모로 가진 시스템 프로세스(csrss, wininit, 그 아래 svchost 수십 개)가 우리 자손으로 잡혔다. 이제 자손 판정은 뿌리가 표에 없어도 뿌리의 생성 시각(표 → 처음 관측한 값 → 감독 시작 시각 순)보다 먼저 태어난 프로세스를 자손으로 세지 않는다. 시작 시각 앞에 2초 여유를 둬 Linux `lstart`의 초 단위 절단은 닫는 쪽으로 기운다. 진짜 잔존 자식(시작 뒤에 태어난 것)은 그대로 잡힌다. 또한 오토파일럿이 RECOVERY_REQUIRED로 멈출 때 반환값에 `last_errors`(최대 3개)를 함께 담아, 호출한 쪽과 CI 로그에서 멈춘 이유가 바로 보이게 했다.
- 테스트가 만드는 하위 프로세스 줄이기(Windows CI 속도): 테스트 한 번이 프로세스 18,906개를 만들고 그 중 git이 86%였다(Windows에서 git은 25~32ms, node는 38~45ms). 두 곳을 고쳐 3,458개(18.3%)를 줄였다. 테스트 픽스처가 저장소를 매번 `init`·`config`×2·`add`·`commit`으로 만들던 것을 파일당 한 번 만든 템플릿의 복사로 바꿨고, `repo()`는 성공한 확인을 기억하되 루트 아래 `.git` 항목의 지문(종류·장치·inode, 파일이면 크기·mtime)이 그대로일 때만 쓴다. `.git`을 지우거나 바꿔치면 git에 다시 묻고, 하위 폴더 거절은 기억하지 않는다. 스냅샷 digest와 그 계산은 건드리지 않았다.
- `tools/count-spawns.mjs`(`npm run spawns`): 명령이 만드는 하위 프로세스를 하위 node 프로세스까지 세어 명령별·호출 지점별로 요약한다. 줄이기 전후를 같은 방법으로 비교하는 용도.
- 컴팩션 뒤 작업 상태 주입: lead-guard에 SessionStart 훅(`startup|resume|compact`)을 추가했다. 대화가 요약되거나 새 세션이 시작될 때 저장소에 끝나지 않은 작업이 있으면 작업 id, 단계, 다음 동작과 `next` 명령을 한 번 넣는다. 작업이 없거나 상태를 읽지 못하면 아무것도 넣지 않는다. `npm run guard:settings`가 출력하는 설정에 포함되므로, 이미 훅을 설치했다면 출력의 `SessionStart` 항목을 설정에 합친다.
- 리드 부담 요약: `report`에 `lead_load`를 추가했다. 이미 남은 산출물에서 리드 판정 수, 재량권 아래 컨트롤러 승인 수, 리드가 읽어야 했던 게이트 수, 자동·수동 복구 수를 센다. 새 기록은 만들지 않는다.
- Codex 잔량 자동 읽기: `quota-policy.mjs REPO collect-codex`가 Codex의 로컬 세션 기록에서 마지막 `rate_limits`를 읽어 openai 잔량을 `supported_tool`로 기록한다(네트워크·모델 없음, 숫자 필드만). 기록 시각을 `collected_at`으로 쓰고 30분이 지나면 stale이다. 소진(0%)이 확인되면 라우팅이 Luna를 순서 뒤로 미룬다(다른 후보가 있을 때만).
- agy 로그아웃 안내: 실패한 agy 실행의 출력에서 로그인 문제를 알아보면 오류에 `AGY_NOT_SIGNED_IN`과 조치(`agy`를 한 번 직접 실행해 로그인)를 덧붙이고, 자동 복구는 이를 다시 시도하지 않는다. 실행 전 점검은 매번 최대 35초가 들어 넣지 않았다.
- Antigravity 모델 검증: agy는 모르는 `--model`을 받으면 오류 없이 기본 모델로 돈다. `executors.antigravity.model`을 정했으면 프로브가 `agy models` 목록(slug와 표시 이름, 대소문자·기호 무시)과 맞춰 보고, 없으면 실행 전에 `MODEL_UNLISTED`로 막는다. 어느 모델이 구현·리뷰했는지가 판정 근거라서 조용한 대체를 허용하지 않는다. 목록을 못 얻으면(옛 agy, 로그인 전, 시간 초과) 막지 않고 dispatch 기록의 `model_check`에 `unverified`와 이유를 남긴다. 운영자는 `HF_AGY_ALLOW_UNLISTED_MODEL=1`로 검사를 끌 수 있다.
- agy `--sandbox` 설명 바로잡기: `--sandbox`는 터미널만 제한하고 파일 쓰기 도구는 막지 못한다. 상담·리뷰의 읽기 전용은 컨트롤러의 전후 스냅샷 비교가 강제한다(저장소가 바뀌면 그 답변을 버린다). 저장소 밖에 쓰는 것은 잡지 못한다. 동작은 바뀌지 않았고 코드 주석과 문서만 고쳤다.

## 0.19.0 — 2026-10-11

- 보존(preserve) 검증 계약: 리팩터링처럼 수정 전에도 수용 명령이 통과하는 작업을 위해 brief에 `verification: {kind:"preserve", protect:[...]}`를 추가했다. red-first(명령이 틀린 결과를 가려낸다는 증거) 대신, 컨트롤러가 보호 경로(테스트·픽스처)의 파일이 작업을 시작한 뒤 하나도 바뀌지 않았음을 스냅샷으로 증명한다. 일꾼이 테스트를 약하게 고쳐 통과시키는 길을 막는다. 보호 경로는 작업 범위와 겹치면 안 되고(앞쪽이 와일드카드인 glob 포함), 실제 파일에 맞아야 하며, 명령은 이미 통과해야 한다(실패하면 red-first 작업). 리드가 범위 밖 변경을 받아들여도 보호는 풀리지 않고 verify도 거절한다. autopilot은 이 작업의 baseline이 `green-acknowledged`면 시작한다.
- 위임 승인과 보존 작업: 리드가 `delegation.allow_preserve:true`를 주고 `task_kind:"refactor"`일 때만 위임된다. 승인 조건에서 red-first 자리를 "보존 baseline 기록 + 보호 경로 불변"이 대신한다. `allow_preserve`는 보존 작업에만 쓸 수 있다. 위임 기록에 `allow_preserve`가 추가됐다.

## 0.18.0 — 2026-10-11

- 재량권(delegation)이 있는 작업의 자동 복구: autopilot이 일꾼 실행의 일시 장애를 컨트롤러 증거로 직접 되돌려 다시 시도한다(`auto-recover`). 결과 파일 없음, 실패한 실행의 프로세스 종료 증명, 트리가 라운드 시작과 같음이 모두 맞을 때만, 작업당 2번까지다. 권한·인증·한도·변조처럼 다시 해도 같은 실패(오류 문구, 종료 사유, stderr로 판별)와 일꾼이 트리를 바꾼 뒤의 실패는 지금처럼 쓰기 권한을 쥔 채 리드에게 올라간다. 결과 기록이 없는 라운드가 새로 열기로 한 일꾼 세션은 비워서 다음 라운드가 없는 세션을 이어받으려다 실패하지 않게 한다.
- 재량권이 있는 작업의 리뷰어 자동 교체(`auto-substitute-review`): 리뷰어가 못 끝내 게이트에 선 라운드에서, 이미 판정·실패한 리뷰어와 구현자 및 같은 회사 모델을 뺀 설치된 리뷰어로 `delegate-review`를 다시 연다. 라운드당 위임 리뷰 2회 한도는 그대로이고, 고를 모델이 없으면 이유와 함께 게이트에 남는다.

## 0.17.0 — 2026-10-11

- 리드가 읽는 출력 줄이기: 명령줄 출력이 기본으로 compact 보기가 됐다. `begin`이 찍던 일꾼 지시문 전문(`prompt`)과 프로브 결과(`cli`), 상태형 출력의 설정·라우팅·세션 전체는 리드가 쓰지 않으므로 빼고 `omitted`에 알린다(`state.json`, `dispatch-N.json`에 그대로 있음). 전부 보려면 `--full`. 한 작업의 init~lead-decision 출력은 약 23,500자에서 약 4,300자(82% 감소). `status`, `report`, `run()` 반환값은 바뀌지 않는다.
- `fusion-state.mjs next <저장소>`: 지금 단계에서 칠 명령 한 줄과, token·baseline_digest처럼 컨트롤러가 아는 값을 미리 채운 입력 틀을 돌려준다. 읽기 전용.
- `review.strategy: "lead-gated-adaptive"`에서는 autopilot이 `review.auto_apply:true`를 요구하지 않는다. adaptive는 `auto_apply`를 판정에 쓰지 않는데도 값을 요구해서 샘플 설정(`auto_apply:false`)으로는 autopilot이 시작되지 않았다. classic은 그대로 요구한다.
- 위임 승인(재량권): 리드가 init에서 `delegation: {policy:"standard-auto", reason, max_rounds?}`를 주면, STANDARD 작업의 라운드를 컨트롤러가 조건을 전부 확인했을 때 직접 승인하고(`policy-approve`) autopilot이 verify까지 이어 CLOSE에 닿는다. init에서만 받는 컨트롤러 기록이고, 이후 brief·저장소 설정·일꾼 출력으로는 못 만든다. adaptive 전략, STANDARD·external_primary, red-first, 모든 AC 매핑이 init 조건이다. 승인 조건은 위험 경로 없음, 필수 리뷰어 전원 같은 digest pass, 교체된 반려·같은 회사 리뷰·반복 반려 없음, 결과 complete, 컨트롤러 수용 테스트 PASS와 종료 증명, 계약 불변, 모든 AC 증명이다. 하나라도 부족하면 승인하지 않고 `POLICY_NOT_ELIGIBLE`과 이유를 돌려주며 리드 게이트에 남는다. 승인 기록은 `authority.source: delegated-policy`로 구분되고 PR 초안에도 표시된다. `next`가 승인 가능 여부와 이유를 보여 준다.
- 소유자 결정 기록: 리드가 작업 단위로 재량권을 줄 수 있다. 규칙은 `references/universal-supervisor.md`.

## 0.16.2 — 2026-10-11

- `fusion-state.mjs autopilot`가 아무 일도 하지 않고 종료 코드 13(`unsettled top-level await`)으로 끝나던 문제: `autopilot.mjs`가 `fusion-state.mjs`를 import하는데, `fusion-state.mjs`가 모듈 최상위에서 autopilot을 await해 서로 기다렸다. 명령줄 진입점을 함수로 빼서 모듈 평가가 먼저 끝나게 했다. 이제 `fusion-state.mjs autopilot <저장소>`가 그대로 동작한다.
- 수용 테스트가 일꾼의 `npm test`가 매 라운드 바꾸는 vitest 기록과 `dist/` 때문에 자주 건너뛰어지던 문제: 운영자가 환경변수 `HF_ACCEPTANCE_IGNORED_ALLOW`(쉼표로 구분한 디렉터리 하위 glob)를 켜면 그 경로만 무시된 파일 비교에서 뺀다. 예: `dist/**,node_modules/.vite/vitest/**`. 저장소 설정 파일로는 켤 수 없고, `node_modules` 전체·의존성 폴더·와일드카드 디렉터리·`/**`로 끝나지 않는 glob은 거절한다. 그 밖의 무시 파일 변경은 지금처럼 건너뛴다. 켠 라운드의 수용 기록에 `operator_ignored_allow`가 남고, 작업 도중에 켜도 기존 기준 기록과 어긋나지 않는다. 기본 비교 대상은 바꾸지 않았다.

## 0.16.1 — 2026-10-11

- Sol 리뷰 결과 형식이 OpenAI에서 400(`invalid_json_schema`, `properties.task_id`에 `type` 없음)으로 거절되던 문제: 결과 형식의 모든 `const`·`enum` 항목에 `type`(`string`/`integer`)을 함께 넣는다. Luna 구현 형식, 상담 형식도 같은 규칙이다.
- agy 리뷰가 셸 명령을 시도해 빈 응답으로 끝나던 문제: "읽기 전용 셸 명령 허용" 문장은 Codex(Sol·Luna)에게만 주고, Antigravity에는 파일 보기 도구만 쓰고 셸 명령은 쓰지 말라고 지시한다. 그 밖의 일꾼에는 셸 문장 없이 파일 읽기 도구로 읽으라고만 한다.

## 0.16.0 — 2026-10-11

- 수용 명령 정지 실패(`ACCEPTANCE_NOT_QUIESCENT`) 오류에 남은 프로세스의 이름·PID·부모와 출처 불명 여부를 최대 5개 표시한다. 리드가 무엇을 멈출지 바로 알 수 있다.
- Antigravity 대화 재개 시 이전 결과를 받던 문제: `--conversation`으로 재개하면 agy가 `structured_output`에 이전 라운드 결과를 그대로 돌려주고 새 결과는 응답 텍스트에만 넣는다. `structured_output`의 라운드(상담이면 `consult_id`·`member`)가 현재 실행과 다르면 응답 텍스트의 JSON을 쓰고, 그것도 맞지 않으면 실패로 처리한다.
- Codex 리뷰어가 파일을 읽지 못하던 문제: 상담·리뷰 지시문이 "디스크에 쓰는 명령 금지"만 적어 Sol이 셸 전체를 금지로 해석했다. 읽기는 필수이며 `cat`, `rg`, `git diff` 같은 읽기 전용 명령은 허용한다고 명시한다.
- 리뷰 근거 확대: 위원에게 넣는 diff 한도를 12,000자에서 100,000자로 올린다(Antigravity는 명령줄 길이 때문에 12,000자 유지, 잘리면 직접 읽으라고 안내). 이 라운드에 컨트롤러가 직접 돌린 수용 명령 결과(`controller_acceptance`)도 함께 넘긴다.
- adaptive 반려 재검토: 리드가 사유를 적고 다른 모델에게 다시 리뷰를 맡길 수 있다. 교체된 반려는 `superseded`로 남고, 대체 리뷰어가 pass하면 리드가 직접 검토한 뒤 뒤집어 승인할 수 있다. 구현한 모델은 여전히 리뷰하지 못한다.
- Antigravity 헤드리스 라운드: 명령은 끝날 때까지 기다리게 하고(백그라운드 실행·완료 알림 대기 금지), 수용 명령은 직접 돌리지 말고 컨트롤러에 맡기게 한다.
- 위험 경로 정책 `review.risk_paths`(기본: auth, migrations, `*.sql`, security, `.github/workflows`). 라운드가 이 경로를 바꾸면 classic은 위임 pass를 자동 적용하지 않고, adaptive는 중요 작업처럼 이중 리뷰하며 APPROVE에 리드의 직접 리뷰를 요구한다.
- 반려 근거 요구: 위임 리뷰의 redo/alternative는 줄 위치가 있는 blocker·major 지적이 있어야 그대로 적용한다. 없으면 classic은 자동 적용하지 않고 리드에게 넘기고, adaptive는 참고 의견으로 표시해 리드가 직접 리뷰 후 `overrule_reason`으로 뒤집을 수 있다.
- 리드 가드에 Stop 훅 추가: 리드 차례 단계(PLAN·REVIEW·VERIFY·REDO·ALTERNATIVE_REQUIRED·LEAD_DECISION_REQUIRED·열린 상담)에 작업을 둔 채 턴을 끝내려 하면 한 번 막고 다음 동작을 알려 준다. `npm run guard:settings` 출력에 함께 들어 있다.
- adaptive 모드에도 반복 반려 교체 규칙을 적용한다. 같은 일꾼이 같은 AC로 두 번 반려되면 lead-packet이 `REASSIGN_OTHER`를 권하고, 그래도 `REDO`하려면 `keep_owner_reason`이 필요하다.
- 리뷰어 교체: 최소 원칙은 "구현한 모델은 그 라운드를 리뷰하지 않는다" 하나로 두고, 나머지는 한도·장애에 맞춰 바꾼다. 필수 리뷰어가 실패하면 게이트에서 `delegate-review`를 다시 불러 빈 자리만 다른 모델로 채운다(`executors` + `substitution_reason`). 남은 리뷰어가 없으면 리드가 diff·테스트·범위를 적고 직접 채워 승인한다(`lead_filled_seats`). 끝낸 리뷰어의 반려는 뒤집지 못하고, 패킷에 계획·대체·같은 회사 리뷰어를 남긴다.
- AC 추적표: brief의 `acceptance_map`이 수용 기준 ID와 수용 명령을 잇는다. 실패한 명령은 AC ID가 붙은 반려 사유가 되고, CLOSE 때 AC별 판정(PASS/REVIEWED)을 남기며 매핑된 명령이 통과하지 않으면 닫지 않는다.
- CLOSE 때 제어 폴더에 PR 설명 초안 `pr-draft.md`를 만든다(변경 파일, AC 표, 라운드, 남은 위험). 커밋·푸시는 하지 않는다.

## 0.15.0 — 2026-10-10

- v0.3 명시적 External-First 프로필, 작성자별 필수/이중 리뷰, 라운드별 Sonnet·APEX Sol grant 및 호스트 최종 판정 게이트.
- 모든 implement/review/consult의 공통 로컬 감시: QUIET 주기 갱신, UTF-8/NDJSON 재동기화, identity별 재시작 복구, bounded 알림·중복 기록, 종료 관측 보존 정책. 진행률·성공을 생성하지 않는다.
- 재배정 경로에도 초기 배치와 같은 구현자 자격·Haiku reserve를 적용하고, grant를 bridge 실행 직전에 불변 controller 기록과 다시 비교한다.
- 구현·검수·상담·실패 호출과 APEX Sol을 포함한 전체 사용량 계측. Claude 모델별 성공당 토큰을 분리하고 미측정은 null로 보존한다.
- v0.3 운영 안내와 앱 핸드오프 후속 설계. Windows 테스트 파일은 순차 실행하고 다른 OS의 파일 병렬도는 2로 제한한다. 공유 프로세스 목록의 orphan 검사 간섭을 격리하며 제품 종료 증명 조건은 유지한다.
- 기본 추론 강도: Sonnet high, Haiku max, Antigravity high, Grok xhigh, Luna xhigh, Sol medium. 설정으로 덮어쓰고 `null`이면 플래그를 넘기지 않는다.
- 추론 강도(`reasoning_effort`)를 모든 일꾼에 적용: Claude Code(Sonnet·Haiku)와 agy는 `--effort`, Grok은 `--reasoning-effort`, Codex는 `model_reasoning_effort`. 일꾼마다 받는 값만 허용(`EFFORT_UNSUPPORTED`)하고, CLI에 플래그가 없으면 무시하지 않고 거절한다.
- 비밀번호 값 일부가 먼저 마스킹됐거나 사용자가 마스킹 표식을 넣었을 때 나머지 값이 그대로 전송되던 문제를 수정했다. 민감값 할당 전체를 다시 가린다.
- 수용 명령의 실행 전후 프로세스 표와 PID·생성 시각을 확인한다. 잔존 자손·새 고아 프로세스·조회 실패에서는 성공 증거를 만들지 않고 RECOVERY_REQUIRED에서 멈춘다. 실행 중 표식은 컨트롤러 중단 후에도 남고 리드의 정지 확인 전에는 새 실행·검증을 막는다.
- 수용 테스트의 기준 트리 검사·finish·verify에도 작업 시간 상한을 적용한다. 명령 timeout을 남은 시간으로 줄이고 상한 이후 명령과 성공 증거 재사용을 막는다. 정지가 확인된 예산 소진은 BLOCKED로 정산한다.
- Windows 감독 조회에서 입력 스트림을 닫고 시스템 CIM 모듈을 직접 로딩한다. CI에 감독 사전 점검을 추가했으며, 실제 고아 프로세스를 만드는 회귀 테스트는 병렬 테스트 뒤에 따로 실행해 안전 검사 간섭을 피한다.

## 0.14.0 — 2026-10-09

- Haiku 일꾼 추가(`haiku`, `claude-haiku-5-5`). Sonnet과 같은 Claude Code CLI를 모델만 바꿔 부르며 세션·예산은 따로다. 쉬운 코드와 문서 배치표의 두 번째 자리에서 시작하고, 자리는 실적으로 정해진다.
- 능력 기반 배치: 일꾼마다 능력(`caps`)을 두고 작업 종류에 필요한 능력으로 후보를 거른다. 설정 `executors.<이름>.caps`로 덮어쓰며, 새 모델은 모델과 능력 한 줄로 붙는다. 이름으로 박혀 있던 이미지 일꾼 목록을 능력으로 바꿨다.
- 신입 우대(cold start): 실적 없는 일꾼에게 `routing.newcomer_every`(기본 4)번째 작업마다 첫 기회를 준다.
- doctor 계약 스모크: `setup-doctor.mjs --smoke[=이름,…]`가 일꾼마다 임시 저장소에서 작은 작업을 실제로 시켜 CLI·출력·결과 계약을 확인한다.

## 0.13.0 — 2026-10-09

- red-first: 수용 명령이 처음 정해질 때 손대지 않은 트리에서 실패하는지 확인한다. 처음부터 통과하면 `ACCEPTANCE_ALREADY_GREEN`으로 거절하고, 이유가 있으면 `acceptance_baseline_green`. 오토파일럿은 red로 확인된 작업만 진행한다.
- "같은 반려 사유" 판정을 수용 기준 ID(AC1…) 기준으로 바꿨다. ID가 없으면 대소문자·문장부호를 무시한 문장 비교.
- 지표에 변경 줄 수(`diff_lines`)와 난이도별 집계(`by_difficulty`)를 넣어, 작은 작업의 리드 비용을 데이터로 판단할 수 있게 했다.
- Windows 프로세스 정지 확인: PID가 재사용된 부모를 가진 더 오래된 프로세스를 자손으로 세지 않고, 방금 끝난 프로세스가 목록에 잠깐 남는 경우 몇 번 다시 확인한다(Windows 최대 10초, 그래도 남으면 실패). 정지 확인 실패 메시지에 이유·남은 프로세스·확인 횟수를 남긴다.
- SKILL.md를 역할·원칙·절차만 남기고 줄이고 영어로 옮겼다(약 13KB → 6KB, 한국어보다 토큰이 적다). 사용자에게는 사용자의 언어로 답한다. 세부는 references로 옮겼다. "Drive SOT" 표현을 설명이 있는 "정본"으로 바꿨다.
- Windows 프로세스 조회의 시작 지연을 위한 제한 시간을 늘리고, 느린 조회 뒤에 관측 호출이 계속 쌓이는 문제를 수정했다. 확인 실패 시 정지하는 규칙은 유지하며, CI 실패 메시지에 실제 중단 사유를 남긴다.
- 외부 전송 직전 공통 마스킹: 이메일·IPv4/IPv6·키·토큰·비밀번호·PEM 개인키, 중첩/인코딩 JSON. 원본 감사 기록과 dispatch 무결성 확인은 유지하고 마스킹 장부에는 개수만 기록한다. 도움말 프로브에도 벤더별 환경변수 허용 목록을 적용한다.
- 오토파일럿: 수용 테스트와 독립 리뷰가 있는 작업의 라운드 루프를 대신 실행하며 VERIFY·설계 결정·BLOCKED·takeover와 안전 확인 실패에서 멈춘다. 배타적 실행 잠금, 유한 단계 수, 프로세스 정지 증거, 중복 launch 거절과 실행 장부를 추가했다.

## 0.12.0 — 2026-10-08

- 수용 테스트 자동 실행: brief의 `acceptance_commands`를 컨트롤러가 finish 직후와 VERIFY에서 직접 실행하고 종료 코드·출력 해시를 증거로 남긴다. 실패한 라운드는 리뷰 전에 실패 출력과 함께 같은 일꾼에게 되돌린다.
- H2 남은 부분 보완: 수용 테스트 실행 전 무시된 파일의 메타데이터를 라운드 시작 때와 비교해, 바뀌었으면 리드가 확인하기 전까지 실행하지 않는다. 일꾼과 수용 테스트에 `PYTHONDONTWRITEBYTECODE=1`.
- 리드 가드 훅(`scripts/lead-guard.mjs`): lease가 걸려 있거나 takeover가 아닌 진행 중 단계에서 리드의 Edit/Write를 차단한다. 설정은 `npm run guard:settings`.

## 0.11.0 — 2026-10-08

- 브리지 결과 자동 읽기, brief 고정값 자동 완성, stdin JSON, 요약 status로 리드 입력을 줄인다.
- 명시적 상태별 액션 표와 자동 생성 문서, 모델 설정 반영, 정확한 CLI 옵션 확인과 doctor 도움말 기록.
- 종류·난이도별 실적, 시간 감쇠, 라운드 수와 후속 배치 가중치, 강등된 일꾼의 재탐색.
- 공용 메타데이터 잠금, 라운드 타임라인, 저장소 전체 지표 집계, 구조화된 CLI 오류.
- 독립 worktree 병렬 실행, 작업 단위 비용·시간 상한, 명시적으로 켜는 실제 CLI 스모크.
- 이미지 애셋은 Grok → Luna로만 배치한다. Antigravity·Sonnet은 이미지 생성 기능이 없어 예비 인력으로도 넣지 않고, 이를 적은 설정·팀 담당은 거절한다.
- MIT 라이선스, 상태 문서의 CI 검증. 상세 사용법은 [operations](references/operations.md).

패키지 릴리스는 0.11.0이다. 저장 스키마 4, 아키텍처 식별자 `opus-lead-v0.3`, wire protocol `hyperfusion-opus-lead-v0.5`는 서로 다른 호환성 식별자여서 그대로 유지한다. 정본 상수는 `scripts/versions.mjs`에 있고 새 상태와 요청에는 package_version을 기록한다.

## 0.10.0

제어 파일을 작업 폴더 밖으로 이동하고 dispatch 재검증, 보호 파일 스냅샷, Bash·경로·환경변수·기억·알림 통제를 강화했다. 후속 재감사에서 정산·CLI 재시도·숨겨진 .gitignore·JSON 비밀값·Windows 실행 파일 문제를 고쳤다. [재감사 후속 보고서](references/archive/reaudit-v0.10.0.md).

## 0.9.1

설치되지 않은 일꾼, 이전 라운드의 범위 밖 변경, 종료 작업 정산, 팀 보고서와 배치의 불일치를 수정했다.

## 0.9

Luna가 Codex 구현 일꾼으로 복귀하고 Sol은 리뷰·상담을 전담한다.

## 0.4

Claude Opus가 리드, Sonnet이 일꾼인 역할 구성을 도입하고 자동 배치를 추가했다.

## 0.3

외부 실행자 어댑터와 구체적 반려, 반복 실패 시 교체, 모든 일꾼 소진 뒤 리드 takeover 구조를 도입했다. 당시 Luna 보조 역할은 제거됐다.

## 0.2.1

Codex 리드와 Claude 일꾼 구성이었다. 상태 기계, 단일 writer lease, 스냅샷 감사의 기반을 이후 버전에서 계승했다.
