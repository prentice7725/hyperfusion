# Changelog

버전 표기: 패키지 릴리스(`package.json`)와 별개로 저장 스키마(4), 아키텍처 식별자(`opus-lead-v0.3`), wire protocol(`hyperfusion-opus-lead-v0.5`)은 따로 움직인다. 날짜는 해당 버전이 `package.json`에 처음 들어간 날이다(0.10.0 이전은 기록이 없다). 병합됐지만 아직 버전이 붙지 않은 변경은 맨 위 Unreleased에 둔다.

## Unreleased

- `acceptance_commands`가 없는 작업은 구현자와 다른 계열의 통과 리뷰가 있어야 닫힌다. 리드가 구현자와 같은 계열이면(Claude 리드의 Sonnet·Haiku·takeover 라운드) 리드의 pass를 REVIEW에서 `SAME_FAMILY_REVIEW`로 거절한다(redo·alternative·decision은 그대로). `verify`는 이번 라운드를 통과시킨 리뷰(리드 리뷰, 위임 리뷰, 리드 게이트의 위임 판정)의 계열을 보고, 전부 구현자와 같은 계열이면 `SAME_FAMILY_VERIFICATION`으로 거절하며 리뷰어와 계열을 알려 준다. 이 경우를 고치도록 `delegate-review`·`consult-finish`를 VERIFY에서도 받는다(`state-actions.md` 재생성). Claude 리드가 Grok·Luna 결과를 직접 리뷰한 것은 그대로 닫히고, Sonnet·Haiku·takeover 결과는 `delegate-review`가 필요하다. 컨트롤러가 직접 돌린 수용 증거가 없을 때 구현과 검증이 같은 오해를 공유하는 길을 막는다. 수용 명령이 있는 작업은 바뀌지 않는다.
- 위임 리뷰어가 보호된 수용 테스트 본문을 받는다(`context.acceptance_tests`: `verification.protect`에 맞는 파일의 본문·SHA-256·수용 명령, 합계 12,000자 상한). 테스트는 리드가 일꾼보다 먼저 써서 diff에 나오지 않았고, 리뷰어는 "diff가 AC를 만족하는가"만 봤다. 이제 "테스트가 objective와 모든 AC를 충실히 검사하는가"도 판정하며, AC를 검사하지 않는 테스트·동어반복 단언·잘못된 이유로 통과하는 테스트는 테스트 파일의 줄을 가리키는 지적으로 `decision`을 권고한다(보호된 테스트는 일꾼이 고칠 수 없다). AC와 테스트를 같은 모델이 쓸 때 공유하는 오해를 다른 계열이 걸러 내려는 것이다. 보호가 없는 작업과 상담(advisor·committee)은 그대로다.

## 0.30.0 — 2026-10-27

- CI: Windows 작업은 테스트 파일을 하나씩 돌려(호스트 전체 프로세스 확인이 서로 섞이지 않게) 약 35분 걸렸다. 이제 Windows 테스트를 러너 4대로 나눠 돌린다(`HF_TEST_SHARD=i/n`, `node --test --test-shard`). 러너마다 호스트가 따로라 직렬 규칙은 그대로이고, `acceptance-security` 통합 테스트와 저장소 전체 회귀 단계는 한 번씩만 돈다. 샤드 값이 `i/n` 꼴이 아니면 `npm test`가 바로 실패한다.
- 실측 수정(KF3/KF4a, `lead-gated-adaptive`, Windows). ① agy: REDO 라운드에서 `Command line too long for Windows (33162 chars)`로 일꾼을 띄우지 못했다. 측정해 보니 라운드마다 커지는 것은 `lead_feedback`(수용 실패 출력, 실패한 명령 하나에 약 6천 자)이고 스키마는 약 1.3천 자로 고정이다. `--json-schema`는 이제 작업 폴더의 스키마 파일 경로로 넘긴다(agy `--help`의 "schema string or path"). agy 1.4.8 텍스트 print 모드는 프롬프트를 `-p` 인자로만 받으므로(`-p -`는 글자 `-`를 프롬프트로 쓰고, stdin은 출력도 stream-json으로 바꾸는 `--input-format stream-json`뿐) 프롬프트는 명령줄에 남긴다. 대신 길이를 Node가 실제로 만드는 Windows 따옴표 규칙대로 세고(JSON의 `"`마다 `\` 하나), 넘치면 가장 큰 brief 필드와 크기, 줄이는 방법(`lead_feedback` 줄이기, 파일로 프롬프트를 읽는 일꾼으로 `REASSIGN_OTHER`)을 알려 준다. ② 리뷰 지적에서 `issue` 대신 `detail`을 쓴 Grok 결과를 거절하던 것을, `issue`가 없고 `detail`이 문자열일 때만 `issue`로 옮겨 받는다. 다른 검사는 그대로다. ③ 리드가 `contract_change:true`로 기록한 결정의 사유를 리뷰어·상담 문맥 `contract_corrections`로 넘기고, 고친 계약으로 판정하라고 지시한다. 라운드 사이 drift를 막는 `ADAPTIVE_REVIEW: frozen review plan does not match this round snapshot` 검사는 그대로다. ④ 일꾼이 `blocked`·`needs_decision`·`failed`를 보고해도 트리를 바꿨으면 컨트롤러가 수용 명령을 돌려 증거로 남긴다. 실패해도 일꾼의 질문을 덮는 자동 REDO는 하지 않고, 미완료 결과의 승인 거절(리드 리뷰·`lead-decision`·위임 리뷰의 pass→redo)은 그대로다. 오토파일럿은 그런 라운드에서 리뷰어를 쓰지 않고 `AUTOPILOT_WORKER_INCOMPLETE`로 멈추며, `AUTOPILOT_ACCEPTANCE_UNVERIFIED`는 이번 라운드에 실제로 돌린 수용 결과가 실패했거나 증명이 없을 때만 나온다. ⑤ `executors.<grok|sonnet|haiku>.consult_max_turns`로 리뷰·상담 실행의 턴 상한을 따로 줄 수 있다(브리지 검증도 같은 값). `recover`가 lease 토큰을 못 받으면 `RECOVER_TOKEN` 오류로 begin 출력의 `token`과 `locks/writer.json`의 `token`을 가리킨다(토큰 값은 싣지 않고, 상태도 바꾸지 않는다). 수용 명령의 종료 증명(`ACCEPTANCE_NOT_QUIESCENT`, 출처 불명 프로세스 검사)은 그대로다.
- 실측 수정(Codex CLI 0.164.0·agy 1.4.7, Windows 11). agy는 훅 명령을 셸 없이 공백으로 나누고 따옴표를 글자 그대로 넘겨서, `--print-settings --host antigravity`가 만든 `node "C:/…"`가 `MODULE_NOT_FOUND`로 실패했고 그 때문에 `run_command`가 막혔다. 이제 경로를 따옴표 없이 쓰고, 공백·따옴표가 든 스킬 경로로는 설정을 만들지 않는다. agy의 실제 읽기 도구 `read_file`이 허용 목록에 없어 작업 중 리드가 파일을 읽지 못했다. 이제 허용한다. Codex는 `write_stdin`에 PreToolUse를 걸지 않아 허용된 셸에 입력을 넣으면 가드를 우회할 수 있었다. 이제 작업 중에 대화형 셸·REPL(`pwsh`, `bash`, `cmd /k`, 인자 없는 `node`·`python` 등)을 띄우는 명령을 막는다. `write_stdin`은 빈 입력(오래 도는 명령의 출력 폴링)만 허용한다(init·begin·브리지가 이 경로로 끝나므로 전부 막으면 흐름이 깨진다). 하위 에이전트 도구의 보고 이름 `collaborationspawn_agent`도 우회 도구로 본다. 등급은 두 호스트 모두 C 그대로다. 호스트 문서와 실측 절차서에 실측 결과를 적었다: Codex Windows 샌드박스 안의 자식 프로세스 EPERM(컨트롤러 명령은 샌드박스 밖 승인 필요), 공유 app-server 데몬 때문에 운영자 환경변수가 셸·훅에 오지 않는 문제, 비 Claude 리드의 adaptive 리뷰 설정 필요, archive 입력 파일, 보관한 `task_id` 재사용 불가, PowerShell의 `$CLAUDECODE`, agy가 저장소 훅을 신뢰 확인 없이 실행하는 점, transcript 위치와 사용량 필드.
- 일꾼·리뷰어 지시문의 `lead`가 `Claude Opus 5.5`로 고정돼 있었다. 이제 작업에 기록된 리드 모델(`lead_identity`)의 표시 이름을 쓴다(예: Codex 리드면 `GPT 6.1 Astra`, 등록되지 않은 모델은 id 그대로). 컨트롤러가 작업 설정의 `lead_model`을 brief에 넣고 지시문에는 이름만 보이며, 브리지 검증도 같은 값을 작업 기록에서 다시 넣는다. 프로젝트 팀 구성 보고서의 리드 줄도 같다. Opus 리드의 지시문은 이전과 같다.
- Claude 일꾼(Sonnet·Haiku) 구현 지시문에 쓸 수 있는 Bash 패턴과 금지 형태(파이프·리다이렉트·`2>&1`·`;`·`&&`·서브셸·환경변수 접두)를 적고, 거부된 호출 하나가 라운드 전체를 실패시킨다고 알린다. 맞지 않는 명령(수용 명령 포함)은 돌리지 말고 `not_run`으로 보고하게 한다. `executor_bash_rules`가 없으면 셸을 쓰지 말라고 하고 "직접 돌려 보라"는 문장을 뺀다. 실측에서 Haiku가 수용 명령에 파이프를 붙였다가 거부돼 맞게 고친 라운드를 두 번 잃었고, 수정 뒤 같은 브리프로 첫 라운드에 거부 없이 통과했다. 거부를 실패로 보는 규칙은 그대로다.
- 수정: `coding_policy`를 켠 작업에서 브리지가 dispatch를 다시 만들 때 정책을 빼서 지시문이 달라졌고, 모든 구현 라운드가 `DISPATCH_TAMPERED`로 일꾼을 띄우지 못했다. 브리지 검증도 begin과 같이 작업 설정의 `coding_policy`를 넣는다. 실제 Haiku 일꾼 실측에서 발견했고, 브리지까지 실행하는 회귀 테스트를 추가했다.
- Antigravity 실측 절차서 `references/hosts/antigravity-field-test.md`를 추가했다(훅 입력·도구 이름 채취, 작업 중 차단, lease 표시값, Stop·SessionStart, 훅 실패, 모델 전환, transcript 샘플).
- 리드 식별: 호스트 훅이 리드 모델을 보고하지 않고 운영자 `HF_LEAD_MODEL`도 없으면, 호스트가 Claude Code라는 근거(최근 Claude Code 훅 관측 또는 Claude Code 셸의 `CLAUDECODE=1`)가 있을 때만 설정의 Opus를 리드로 쓴다. 근거가 없거나 Codex·agy 훅이 모델 없이 관측되면 init과 프로젝트 계획이 `LEAD_MODEL_UNKNOWN`으로 거절한다. 훅을 신뢰하지 않은 Codex 리드가 Claude 리드로 취급되던 위험을 막는다. Claude Code 안에서의 동작은 그대로다. Codex 실측 절차서 `references/hosts/codex-field-test.md`를 추가했다.
- 범용화 4단계(Antigravity 리드, 실측 전 C 등급): `node scripts/lead-guard.mjs --print-settings --host antigravity`가 `~/.gemini/config/hooks.json`용 항목(`hyperfusion-guard`, `hyperfusion-usage`)을 출력한다. agy 훅은 이벤트 이름이 없어 `--event`로 받고, 입력(`toolCall`, `workspacePaths`, `conversationId`, `modelName`)을 공통 형식으로 바꿔 같은 가드 판정을 쓴 뒤 agy 형식(`{decision}`)으로 돌려준다. 쓰기 도구는 경로 인자로 lease·단계 규칙을 적용하고, `run_command`의 `BypassSandbox:true`는 이 스킬의 컨트롤러 명령에만 허용한다. `call_mcp_tool`·`mcp_<server>_<tool>`은 MCP 읽기 전용 목록으로 판정하고, `invoke_subagent`·`define_subagent`·`send_message`·`manage_task`(`send_input`·`kill`)와 이름을 모르는 도구는 작업 중에 막는다. Stop은 정상 종료이고 `fullyIdle`일 때만 같은 대화·단계·라운드에서 한 번 이어 가게 하고, 상태 줄은 리드 토큰을 늘리므로 넣지 않는다. 사용량 훅은 호스트와 리드 모델을 기록하고 사용량은 미측정으로 남긴다. 도구·인자 이름은 문서와 다른 에이전트의 실측 보고를 따랐고 실제 agy로 실측하지 않았다. `references/hosts/antigravity.md`에 설치 절차와 실측 항목이 있다.
- 범용화 3단계(Codex 리드, 실측 전 C 등급): `node scripts/lead-guard.mjs --print-settings --host codex`가 `~/.codex/hooks.json`용 훅을 출력한다. Codex 가드는 `apply_patch` 패치 본문의 경로로 lease·단계 규칙을 적용하고, 경로를 못 읽으면 작업 폴더 기준으로 막는다. `write_stdin`·`spawn_agent`와 이름을 모르는 도구는 작업 중에 막고 `update_plan`·`view_image`는 허용한다. Codex에는 `stop_hook_active`가 없어 같은 `turn_id`에서 Stop을 한 번만 막는다. 일꾼 `codex exec`는 `-c features.hooks=false`로 사용자 훅을 끄고, 끌 수 없는 관리형 훅에 대비해 브리지가 일꾼에 lease 토큰 해시(`HF_WORKER_LEASE`)나 상담 ID(`HF_WORKER_CONSULT`)를 넘기면 가드가 현재 lease·상담과 맞을 때만 일꾼으로 본다. 사용량 훅은 `--host codex`로 호스트와 리드 모델을 기록하되, transcript 형식을 확인하지 않았으므로 리드 사용량은 미측정으로 남긴다. 설치·신뢰 절차와 한계는 `references/hosts/codex.md`에 있다. 실제 Codex로 실측하지 않았다.
- 범용화 2단계: 리드는 호스트가 정한다(`lead-host.mjs`). 출처는 호스트 훅이 남긴 모델(Claude Code SessionStart의 `model`, PostModelSwitch의 `to_model`) → 운영자 `HF_LEAD_MODEL` → 설정의 Opus 순이며, 둘의 계열이 다르면 거절한다. 저장소 설정은 `lead:'opus'`만 받고, `lead_model`을 직접 적었다면 그 계열이 리드와 같아야 한다. 리드 식별과 등급(A·B·C)은 `lead_identity`로 상태에 남고 작업 동안 고정된다(R7). `begin`은 라운드마다 관측된 리드 계열이 같은지 보고, 다르면 거절하며 같은 계열 안의 변경은 `lead_model_changes`에 기록한다. 비 Claude 리드는 실측 전 C 등급이라 위임 승인과 takeover가 꺼진다(운영자 `HF_ALLOW_LEAD_GRADE`로만 올림). Claude Code 리드의 기존 동작(HOOKS_NOT_OBSERVED 경고)은 그대로다. `guard:settings`의 막는 가드는 `onFailure:"block"`이 되고, `PreModelSwitch`가 진행 중 작업의 리드를 다른 계열로 바꾸지 못하게 하며, `PostModelSwitch`가 모델 변경을 기록한다. 리드 Bash 가드는 `HF_ALLOW_*`·`HF_LEAD_*`·`HF_ALLOWED_VENDORS` 설정을 막는다. 프로젝트 계획은 비 Claude 리드에서 Claude용 프리셋을 거절하고 계열 규칙으로 리뷰어를 검사한다. 기존 설치는 `npm run guard:settings` 출력을 다시 병합해야 한다.
- 범용화 1단계: 컨트롤러가 일꾼 이름 대신 리드 계열에 따른 역할(`team-roles.mjs`)로 판단한다. APEX 구현자(외부 최상위), 전문가 구현자(`sonnet_implementation`·`REASSIGN_TO_SONNET`), grant 전용 일꾼, 예비 일꾼(`claude_reserve`), 위임 가능한 작성자를 리드 모델에서 계산한다. Opus 리드는 지금과 같다(Sol·Sonnet·Haiku, 기존 테스트 전부 통과). 비 Claude 리드는 `family-rules-v1`로 리뷰하고 배정에 팀(리드 모델·후보)을 기록하며, adaptive 리뷰가 아니면 init을 거절한다. Codex 리드(Astra)에서는 Sol이 전문가, Sonnet이 APEX가 되고, Sol 구현은 기존과 같은 workspace-write grant로만 열린다. 전략 이름(`sol_apex`, `sonnet_implementation`, `reassign_to_sonnet`)과 상태 기록 형식은 그대로다. 리드 모델은 아직 설정의 Opus뿐이며, 호스트에서 리드를 정하는 것은 다음 단계다. 레지스트리는 회사 접두사(`claude-`, `gpt-<숫자>`, `gemini-`, `grok-`)로 등록되지 않은 모델의 계열만 정한다.
- 범용화 1단계 준비: 모델 레지스트리(`model-registry.mjs`)와 팀 구성 함수(`team-composer.mjs`)를 추가했다. 계열(family)은 모델을 만든 회사로 판정하고, 레지스트리에 없는 모델·`"auto"`는 `unknown`(누구와도 독립이 아님)이다. `compose`는 리드 계열을 기준으로 역할을 나누고, 리드를 포함해 계열이 둘 미만이면 `TEAM_SINGLE_FAMILY`로 거절한다. `familyReviewPlan`(`family-rules-v1`)은 작성자와 독립인 계열 수로 리뷰 자리 수를 정한다. Opus 리드에서 `cross-vendor-pairs-v1`의 리뷰어·강도와 같은 결과를 내는지 표 기반 테스트로 확인했다. `legacy-v1`은 AGY만 있고 Grok이 없는 팀에서 Luna·Haiku·Sonnet의 중요 작업이 한 자리라 일반 규칙과 다르므로, 기존 정책은 계속 `review-plan.mjs`가 계산한다. 아직 컨트롤러에 연결하지 않았으며 동작 변화는 없다.

## 0.29.0 — 2026-10-25

- 위임 리뷰어(`delegate-review`)는 일꾼의 주장을 받지 않는다. `context.last_result`에는 `status`, `files_changed`, `unresolved`, `needs_lead_decision`만 남고 요약·테스트 보고·위험 평가는 `claims_withheld`에 키 이름만 남는다. `recent_reviews`도 이전 반려 기준만 주고 이전 판정·사유는 뺀다. 테스트 결과는 컨트롤러가 돌린 `controller_acceptance`로 본다. advisor·committee 상담은 그대로다
- `lead-decision`에 선택 입력 `finding_dispositions`(`[{finding_id, bucket, reason}]`): 리드가 이번 라운드 지적(`finding_summary`의 `F-…`)을 `act`·`consider`·`noted`·`dismissed`·`contract_misread`로 분류하고 사유를 남긴다. 기록에는 지적을 낸 리뷰어와 심각도가 붙는다. `act`가 있으면 APPROVE는 거절되고, `@findings` 전달 패킷은 `dismissed`·`noted` 지적을 빼고(`withheld_by_lead`) 나머지에 리드 메모를 붙인다. 반려 기준(`Unmet:`)은 그대로 넘긴다. 지표 `review_dispositions`가 리뷰어별 처분 수와 `actionable_rate`를 센다. 승인 조건·필수 리뷰 자리는 바뀌지 않는다

## 0.28.0 — 2026-10-25

- 선택적 일꾼 코딩 정책: 설정 `coding_policy:"ponytail"`이면 구현 라운드 지시문에 고정된 Ponytail 규칙(MIT, 커밋 고정, 결과 JSON과 충돌하는 문장 제거)을 덧붙이고 정책 id·해시를 프롬프트에, `coding_policy`를 지표에 남긴다. 생략·위험은 `risks`로 보고하게 한다. 기본은 꺼짐이며 리뷰·상담에는 붙이지 않는다. 효과는 미측정이다.
- 재검수용 `round-diff`: 2라운드부터 begin이 HEAD와 다른 텍스트 파일의 내용(파일당 512KiB, 합계 4MiB 이내)을 `round-base-N.json`에 남기고, 읽기 전용 `fusion-state.mjs round-diff REPO`가 이번 라운드 시작 이후 바뀐 줄만 unified diff로 보여 준다. 기준 기록이 없거나 라운드 스냅샷과 맞지 않으면 알리고 diff를 내지 않는다. 리뷰 단계의 `next`가 명령을 안내한다. 판정·승인 근거가 아니며 승인은 여전히 누적 diff 전체를 대상으로 한다.
- 실패한 수용 명령은 저장되는 출력 꼬리(마지막 4000자)보다 앞에서 처음 나온 실패 줄과 그 뒤 최대 19줄(2000자 이내)을 `output_failure_line`/`output_failure_excerpt`로 함께 기록한다. 다음 라운드 수용 피드백, 리드 리뷰 문맥, `evidence`의 `ACCEPTANCE_FAILED.head_failure`, `evidence-search`가 이를 쓴다. 판정에는 쓰지 않는 보조 증거이며 통과한 명령의 기록 형태는 그대로다.
- 리드 가드가 MCP 도구(`mcp__*`)도 검사한다. 진행 중인 작업이나 일꾼 lease가 있는 동안 읽기 전용으로 확인된 도구(Serena의 심볼 조회·검색·파일 읽기, GitHub MCP의 저장소·이슈·PR·CI 조회, Context7 문서 조회, Google Drive 검색·읽기)와 운영자가 `HF_LEAD_MCP_ALLOW`에 정확한 이름으로 적은 도구만 통과시키고, 나머지는 Edit/Write와 같은 조건에서 막는다. `npm run guard:settings`에 `mcp__.*` PreToolUse 항목이 추가됐으므로 기존 설치도 병합해야 한다. 판단 기준 저장소는 Bash 가드처럼 cwd이며, MCP 서버가 다른 경로를 다루는지는 확인하지 않는다.
- 지적 원장은 호출마다 디렉터리를 한 번만 읽어 해결 주석을 색인한다. 원본 해시·현재 라운드·수용/리뷰 근거는 여전히 매번 검증한다. 선택적 `tools/profile-controller.mjs`는 snapshot·ignoredManifest·원장 로컬 시간을 실측하고, 작업 유형별 brief 예시와 `tools/preflight-brief.mjs`는 기존 계약을 정적으로 검사한다. 모델 시간 절감·실행 자격·승인을 주장하거나 새 권한을 만들지 않는다.

- 지원 Node를 24 이상으로 올렸다. `engines`, setup doctor 검사, CI 매트릭스(Ubuntu·Windows × Node 24)와 문서를 맞췄다. Node 20은 더 이상 검사하지 않는다.
- 증거 회수 실험 도구: 읽기 전용 `evidence`는 수용 실패·출력 잘림·환경 실패·변경 파일 불일치·리뷰 판정 불일치·단독 차단 지적 등 위험 신호를 원본 산출물 해시와 함께 항상 올린다. `evidence-search`는 컨트롤러 증거를 매 호출 메모리 BM25로 검색하며 마스킹·바이트 예산·생략 포인터를 적용한다. 반복 A/B 비교에 `buried_defect_detected` 집계를 추가했다. 승인 권한·상태 변경은 없고 실모델 절감 효과는 미측정이다.

## 0.27.0 — 2026-10-24

- 컨트롤러 git 호출은 여전히 매번 유효 설정을 다시 읽어 코드를 실행할 수 있는 항목을 끄지만, 한 번의 `snapshot` 안에서는 설정을 한 번만 읽어 그 안의 git 호출(5회)에 같이 쓴다. 그 사이에는 설정을 끈 git과 파일 읽기만 돌고 저장소 코드는 돌지 않으며, snapshot이 끝나거나 실패하면 버린다. 가장 느린 테스트에서 설정 읽기가 253회에서 77회로 줄었다.
- 같은 동작 안에서 방금 찍은 스냅샷을 수용 명령의 실행 전 상태(init·finish·verify), 리뷰어용 수용 결과(delegate-review), 자동 반려 판정(consult-finish), 수용 실패 반려의 트리 확인(실행 직후 digest)에 다시 쓴다. 그 사이에는 컨트롤러 코드만 돌며, 사이에 생긴 변경은 수용 명령의 변경으로 잡혀 더 엄격해진다. 동작 경계와 probe 뒤 재확인은 그대로다. 가장 느린 테스트의 스냅샷이 44회에서 32회 이하로 줄었다.

- Windows 프로세스 표 조회가 Node 프로세스마다 PowerShell 하나를 띄워 두고 재사용한다. 매번 `powershell.exe`와 CIM 모듈을 새로 띄우던 비용(이 PC에서 조회당 약 1.7~2.2초)이 약 0.23초로 줄었다. 조회 결과(CIM 스냅숏)·시간 제한·실패 시 닫힘은 그대로이고, 상주 PowerShell과 그 자손은 표에서 제외되며 Node가 끝나면 함께 끝난다.

- 리드 고정 비용 줄이기(B01·B02 실측에서 리드 턴의 약 40%가 막힌 명령과 우회에 쓰였다): 쉬운(`low`) 작업이고 수용 명령이 init에서 red로 확인되면 `next`와 SKILL.md가 `autopilot`을 권한다. 첫 `begin`은 입력이 없으면 init brief를 쓰고, `begin` 출력은 일꾼 stdin 대신 "stdin 없이 브리지만 실행"을 안내한다. 명령줄 브리지는 오토파일럿과 같은 프로세스 트리 정지 증명을 하고, 증명되면 `finish_command`를 출력한다. `finish`·`consult-finish`·`recover`·`review`·`verify`는 짧은 입력을 옵션(`--token`, `--quiescent`, `--verdict` 등)으로도 받는다. 파일과 옵션에 같은 칸이 있으면 거절한다. 실제 절감 효과는 재측정 전까지 미확인이다.

- Audit follow-up: consolidate the three README introductions into a capability summary. This core branch contains HF-I01–HF-I05 and HF-I07 only; isolated parallel implementation remains a separately reviewed draft pending the G4 measurement gate.

- Node 24 상태 마이그레이션에서 새 목적지 디렉터리에 대한 `cpSync`의 EEXIST를 피하도록 항목별 배타 복사를 적용했다. 기존 목적지 덮어쓰기 금지·해시 검증·writer lease 보존은 유지한다.

- HF-I07: 출처·버전 필터, 선택적 아티팩트 해시 검증, 근거 포인터를 보존하는 제한 회수 패킷, 장부 해시 기반 일괄 검토와 검색·브리프 포함·리드 보고 유용성 지표를 추가했다. 수정된 후보는 원래의 verified 표시를 상속하지 않는다.
- 반복 A/B 비교는 30쌍의 원시 결과와 조건을 보존하고 누락된 사용량·비용·품질 자료를 미확인으로 처리한다. 실모델 절감률이나 자동 출시를 주장하지 않는다.
- Windows 작업공간 예약·CLOSE·통합 경로 비교에 기존 정규화 함수를 적용해 같은 경로의 대소문자·구분자 차이로 예약이 거부되던 문제를 수정했다.

- HF-I05: 기존 상담·리뷰에 최대 두 슬롯의 실행 대기열과 init 고정 `read_only` 범위·초점·실행자 계획을 추가했다. 추가 분석은 승인된 ID만 한 번씩 선택하고 기존 상담 횟수·시간·관측 비용 한도를 유지한다.
- 필수 리뷰의 전체 공통 근거·동일 digest·필수 자리와 medium 구현/xhigh 지정 리뷰 구분을 보존한다. 각 실행 직전 트리·writer·수용 실행·컨트롤러·예산을 재검사하며, 성공한 형제 결과를 남기고 종료 미확인 시 정산과 후속 쓰기를 차단한다. 병렬 구현·자동 통합과 실제 모델 절감 효과는 포함하지 않는다.

- HF-I04: 기존 마일스톤에 정적 `depends_on`·직렬 준비 상태·결정적 dry-run을 추가했다. 승인 시 범위·AC·명령·예산을 고정하고 변경된 계획을 init/begin에서 거절한다. 기존 무의존성 계획과 체크포인트 확인은 유지한다.
- 공유 작업은 검증된 CLOSE 영수증으로, 격리 작업은 별도 부모 통합 작업의 CLOSE·현재 수용 증거·정확한 파일 통합과 명시적 영수증으로 의존성을 충족한다. 자동 병합·동적 그래프·병렬 구현은 추가하지 않는다.

- HF-I03 리뷰 지적 원장과 읽기 전용 `findings`·`revision-packet`, 명시적 `@findings` 수정 지시를 추가했다. 원본·반려 이력과 필수 리뷰 자리를 보존하며 정확한 중복만 표시상 묶는다. 문맥 해시가 유일하게 일치할 때만 줄 이동을 기록한다.
- `resolve-finding`은 새 digest의 수용 테스트·AC·프로세스 종료·리뷰 승인 근거가 있는 경우에만 관찰 주석을 남긴다. 승인 권한은 추가하지 않으며 새 라운드나 변경된 증거는 주석을 무효화한다. 실제 모델 절감률은 미측정이다.

- HF-I02 중단 행렬을 확장했다. 실제 컨트롤러/브리지 프로세스를 디스패치, 작업자 종료·결과·완료 증거, 리뷰 결과·정산, 검증·CLOSE·수용 실행 직전 경계에서 종료하고 원래 작업 ID·시도·권한·반려 이력·사용자 변경을 보존하는지 검사한다. `npm run test:recovery`로 직렬 실행한다.
- 검증 산출물만 저장된 VERIFY와 `ended_at` 없이 저장된 CLOSE/BLOCKED를 별도 정지 사유로 노출한다. 이 경계의 읽기 전용 조회는 verify 재실행이나 새 작업 시작을 안내하지 않는다. 자동 검증·정산 권한은 추가하지 않았다.

- HF-I02 명시적 재개 정산: 새 작업 init에서만 `reconciliation` 권한을 고정하고 감독 종료가 증명된 결과에 완료 해시를 남긴다. `reconcile` 기본 조회는 읽기 전용이며, `apply:true`는 최신 프로세스·트리·증거를 확인한 뒤 기존 finish/consult-finish만 호출한다. 자동 재개·승인·verify는 수행하지 않는다.
- 작업 의도/결과 영수증으로 반복 정산을 막는다. 완료 증거 누락, 변경된 트리·결과, 살아 있거나 확인 불가한 프로세스와 중간 정산은 정지한다. raw-result 저장 직후와 finish 상태 저장 직후 실제 컨트롤러 종료 테스트를 추가했다. 전체 플랫폼 중단 행렬과 실제 모델 검증은 미완료다.

- HF-I01 계측: 작업 지표와 벤치마크에 승인 자격 관측 범위·정책 승인·정지 사유·역할/모델/effort별 launch 전송 시도를 집계한다. 병렬 리뷰의 좌석 시간과 대기 시간을 구분하며 Grok xhigh 시간을 따로 표시한다. 실패·미확인 사용량 규칙은 유지한다.
- 오토파일럿 저널의 초기 단계를 기록하고 완전한 구간만 단계별 시간으로 집계한다. verify 후 저널이 완성되면 종료 지표의 관찰 필드만 갱신한다. 구버전·불완전 기록과 호스트 모델 호출 수는 미확인으로 남긴다.

- HF-I01/HF-I02 첫 관찰 단계: 기존 위임 승인 조건에 고정 진단 코드를 추가하고 `diagnose` 읽기 전용 명령으로 노출한다. 기존 설명·판정은 유지하며 CLI·autopilot 승인 거절에도 진단을 보존한다.
- `resume` 읽기 전용 패킷은 정책·시도·증거 존재 여부를 제한된 출력으로 복원한다. 실행·상담 재실행을 안내하지 않고 구버전·불확실한 프로세스를 명시한다. 자동 재개·정산, 시간·전송 벤치마크 집계와 실제 모델 평가는 후속 작업이다.

## 0.26.0 — 2026-10-17

- 새 Grok 사용 adaptive 작업의 리뷰 정책을 init에 고정한다. 중요한 작업·명시적 이중 리뷰·위험 경로에서 Grok 구현은 Sol+Sonnet, Luna 구현은 Sonnet+Grok, AGY·Haiku·Sonnet 구현은 Sol+Grok 페어를 사용한다. 일반 작업은 기존 독립 리뷰어 1명, Sol APEX는 리드 직접 리뷰를 유지한다.
- Grok 구현·일반 상담의 medium과 페어 리뷰 자리의 xhigh를 분리하고 dispatch·사용량에 선택 강도를 남긴다. 리뷰어는 같은 digest를 독립적으로 병렬 검토하며 충돌·누락은 리드 게이트에 남는다. 근거 있는 전원 반려에만 기존 redo_delegation을 적용한다. 새 정책의 대체 리뷰어도 구현자 및 다른 리뷰어와 같은 벤더로 자리를 채우지 못한다.
- init/begin에 잠정 review_preview를 제공하고 리드 지시서·한/영/일 README·검토 문서를 갱신한다. 이전 배정과 Grok 미포함/금지 팀은 기존 정책을 유지한다. 실제 모델의 지연·판정 품질은 미측정이다.

- Grok 일반 기본 effort를 medium으로 낮추고 classic·External-First의 모든 난이도·미분류 구현과 일반 리뷰·상담에 적용한다(위의 지정 페어 리뷰 자리는 역할별 xhigh). 일반/adaptive 예제와 세 언어 README도 갱신했다. 일반 명시적 effort·null과 진행 중 작업의 고정된 설정은 보존하며, 실제 지연 개선은 미측정이다.

- Codex(Luna·Sol)의 Windows 샌드박스가 셸을 띄우지 못하는 문제(`CreateProcessAsUserW failed: 5`): 라운드가 아무것도 못 하고 "못 했다"로 끝나 리드가 직접 일꾼을 바꿔야 했다. 이제 Codex 일꾼을 고르기 전(설치 확인, 상담·리뷰 선발, doctor)에 모델 호출 없이 `codex sandbox cmd.exe /c echo HF_SANDBOX_OK`와 `codex sandbox pwsh ...`(pwsh는 이름으로 점검하고, 설치돼 있지 않으면 건너뛴다. `windows` 하위 명령은 `codex sandbox --help`에 있을 때만 붙인다)로 확인하고, 권한 거부(코드 5·1312)나 샌드박스 준비 실패 문구가 보이면 `ADAPTER_UNAVAILABLE: CODEX_WINDOWS_SANDBOX`로 그 일꾼을 사용 불가로 둬 라운드를 쓰지 않고 다른 일꾼으로 넘어간다. 판단할 수 없으면(하위 명령 없음, 시간 초과) 막지 않는다. 라운드 중 명령 실행 결과에 거부가 나오면 `CODEX_WINDOWS_SANDBOX`로 라운드를 실패시키고 자동 복구는 다시 시도하지 않는다. 운영자는 `HF_CODEX_WINDOWS_SANDBOX=elevated|unelevated`로 샌드박스 방식을 고를 수 있다(저장소 설정으로는 불가). 실제 Windows(codex-cli 0.162.0)에서 원인을 확인했다: cmd.exe·Windows PowerShell은 뜨고 패키지판(Store/MSIX) pwsh만 `CreateProcessAsUserW failed: 5`로 막혔다. `winget install --id Microsoft.PowerShell --source winget`도 이 패키지판을 설치하므로, 안내 문구는 패키지 제거와 GitHub의 MSI 설치를 권한다. 그 PC의 Codex에는 `windows` 하위 명령이 없었고, 그때 나는 코드 2(파일 없음)는 막지 않는다. 코드 1312와 준비 실패 문구는 openai/codex 이슈에서 가져왔다. vitest EPERM처럼 셸은 뜨고 그 안의 자식 프로세스가 막히는 경우는 기존 `environment_error` 보고로 남는다.
- 반려 위임(`redo_delegation`): 승인 권한(`delegation`)과 별개로, 리드가 init에서 STANDARD 작업에 한해 "근거가 분명한 반려는 리드를 거치지 않고 같은 일꾼에게 돌려보내도 된다"고 허락할 수 있다(`max_redos` 1~2, 기본 2). 필수 리뷰어 전원이 같은 라운드 digest에서 redo로 일치하고, 막는 기준이 brief의 AC ID를 가리키며, `scope.paths` 안 파일·줄의 blocker/major 지적이 있고, 같은 AC 재반려가 아니며, 계약·트리·예산·일꾼 라운드 상한이 맞을 때만 컨트롤러가 REDO를 `delegated-policy`로 기록하고 REDO로 보낸다. 하나라도 부족하면 이유를 패킷 `note`에 붙여 리드 게이트로 간다. 이 권한으로는 승인·교체·범위 변경을 하지 못한다. 리드 패킷에 `delegated_redos`(반려 이력과 같은 AC가 아직 반려 중인지), `report`에 `redos_by_policy`를 더했다. 실제 일꾼·리뷰어 모델로 돌려 본 것은 아니다(대역 CLI로 수동 흐름과 오토파일럿 흐름을 확인).
- 개인정보 마스킹이 이미지 파일 이름을 이메일로 오인하던 문제: `icon@16.png`, `logo@2x.png`, `hero@1.5x.webp` 같은 해상도 표기 파일명이 `[REDACTED:email]`로 바뀌었다. 로컬 부분이 `/`를 허용해서 `assets/icon@16.png`가 경로째 지워졌고, `scope.paths`·`files_changed` 같은 경로 필드에서는 `REDACTION_UNSAFE: rename it before dispatch`로 디스패치 자체가 막혔다. 이제 `@` 뒤가 "해상도 표기(`16`, `2x`, `1.5x`) + 이미지 확장자(png, webp, svg 등)"이면 이메일로 보지 않는다(그런 주소는 존재할 수 없다). 좁게 잡았으므로 `alice@example.com.txt`나 `bob@2x.com`은 그대로 마스킹된다.
- Antigravity가 셸 권한이 없는데 테스트를 돌리라는 지시에서 멈추던 문제: 헤드리스 agy는 허용 목록 밖의 명령이 한 번이라도 거부되면 결과 없이 끝난다. 그런데 공통 구현 지시문의 "Write the code, run the tests, fix what fails"가 agy에게도 그대로 가서, 같은 프롬프트의 "셸을 쓰지 말라"와 정면으로 부딪혔다(허용 목록이 없는 경우와 수용 명령이 없는 경우 모두). agy에게는 이 문장을 "바꾼 파일을 읽어서 확인하라, 테스트는 컨트롤러가 돌린다"로 바꿔 보내고, 목적·성공 기준·lead_feedback에 "npm test를 돌려라"가 있어도 셸 규칙이 우선한다고 적는다. 허용 목록이 있을 때 수용 명령을 허용하면서 금지하던 모순도 "수용 명령은 제외"로 정리했다. 다른 일꾼의 지시문은 그대로다. 실제 agy로 돌려 본 것은 아니다(프롬프트 내용과 모순 제거까지 확인).
- agy 목줄 보강(AionUi 백엔드 AionCore의 agy 실측을 읽고 HyperFusion에 해당하는 것만 가져왔다):
  - 그룹 밖으로 빠져나간 자식 정리: agy의 도구 자식은 저마다 자기 프로세스 그룹을 만들어, 그룹 kill로는 agy만 죽고 자식은 고아로 남았다. 그러면 정지 증명이 실패해 라운드가 `RECOVERY_REQUIRED`로 끝나고 정리는 리드 몫이었다. 이제 오토파일럿 브리지는 종료 뒤 남은 자손 중 감독 중에 관측한 바로 그 프로세스(PID·생성 시각 일치)만 SIGKILL하고 `quiescence-*.json`의 `reaped`에 남긴 뒤 다시 확인한다. PID가 재사용된 것은 건드리지 않고, 정리하지 못한 것은 예전처럼 증명 실패다. 같은 모양(자식을 detached로 띄우고 끝나는 부모)으로 재현해 확인했다. 수용 명령 실행기는 바꾸지 않았다.
  - 새 agy 대화에 `--new-project`: 도움말에 그 플래그가 있을 때만, 재개가 아닌 실행에 붙인다. 없으면 agy가 전역으로 활성화된 다른 프로젝트의 workspace 플러그인을 읽는다. 일꾼 환경의 `PWD`는 저장소 루트로 고정한다(환경 정리에서 빠져 있었다).
  - 저장소의 agy 훅·스킬 감시: `.agents/`, `.agent/`, `_agents/`, `_agent/`를 gitignore돼 있어도 스냅샷에 넣어, 라운드 중 일꾼이 `hooks.json`을 심으면 범위 밖 변경으로 멈춘다. doctor는 이미 있는 `hooks.json`·`skills`를 경고한다.
  - 모델 없는 agy 실행에 `--effort`를 보내지 않는다: agy는 강도를 모델 ID에서 읽는다. 지금까지는 모델을 정하지 않아도 기본 강도(high)나 난이도별 강도가 `--effort`로 나갔고, dispatch·사용량에도 그 강도가 적용된 것처럼 기록됐다. 이제 모델이 없으면 강도를 빼고 `null`로 기록한다. 운영자가 모델 없이 `reasoning_effort`만 적은 설정은 `EFFORT_NEEDS_MODEL`로 막는다. Gemini 모델의 suffix 처리와 custom/Claude 모델의 `--effort`는 그대로다.
  - 실제 agy로 돌려 본 것은 아니다. `--new-project`·`PWD`의 효과는 AionCore 소스의 실측 주석을 근거로 한다. agy PreToolUse 훅으로 매 호출을 판정하는 방식(명령 허용 목록·쓰기 범위·비밀 파일 읽기 거부)은 실제 agy 확인이 먼저라 이번에 넣지 않았다.

## 0.25.0 — 2026-10-14

- red-first에도 `verification.protect`를 허용하고 init 이후 보호 계약 변경을 거절한다. 보호 테스트 수정은 수용 명령 실행 전에 복구로 보내며, 기존 비보호 테스트 변경도 리뷰에 표시하고 위임 자동 승인을 막는다. CLOSE에는 독립 리뷰와 명시적 변경 사유가 필요하다. 파일명·명령 진입점 검사는 보수적 휴리스틱이며 모든 테스트 의존성을 증명하지 않는다.
- Claude·Grok의 구현·리뷰·상담에 일반 비밀 경로 Read deny를 추가한다. Bash·검색·다른 도구까지 막는 파일시스템 경계는 아니다. Codex 제품의 최신 read-deny 지원과 현재 어댑터의 미설정을 구분해 기록한다.
- init·doctor·report·metrics에 최근 Bash PreToolUse 훅 관측을 남긴다. 15초 안의 usage 훅 이벤트는 모든 가드 설치·실행의 증명이 아니며, 미관측은 경고다. 진행 중 작업·lease에서 알려진 커밋·푸시·강제 리셋·재귀 강제 삭제 Bash 형태를 차단한다.
- 에이전트 간 지시·보고는 영어로 통일하고 저장소 지시 파일의 경로·해시를 dispatch에 기록한다. scope·커밋·푸시·컨트롤러 규칙은 brief 우선이며 충돌은 판단 요청으로 반환한다. 리뷰 재작업률은 redo/alternative 판정 비율이고 사람의 작업 시간으로 표시하지 않는다.

## 0.24.0 — 2026-10-14

- Windows의 긴 경로·8.3 짧은 경로를 native realpath로 정규화해 linked worktree의 공통 Git 보호 경로를 동일하게 인식한다. Resume smoke의 cwd도 파일시스템 정체성으로 비교하고, 경로/스모크 회귀 검사를 전체 CI 앞에서 실행한다.

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
