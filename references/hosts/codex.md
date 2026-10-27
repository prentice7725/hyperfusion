# Codex 호스트에서 리드로 쓰기

Codex CLI에서 HyperFusion을 실행하면 Codex의 모델(예: GPT 6.1 Astra, Sol)이 리드가 된다. 팀은 리드 계열(openai)을 기준으로 다시 짜인다. Sonnet이 APEX(외부 최상위)가 되고, Sol은 전문가 자리(grant 필요)를 맡으며, Luna는 예비가 된다. 리드와 같은 모델은 일꾼 자리를 내놓는다(Sol 리드면 Sol은 일꾼이 아니다).

**이 호스트는 일부만 실측했다(2026-10-27, Codex CLI 0.164.0, Windows 11).** 훅이 리드 모델을 보고하고 쓰기·push·완화 변수·하위 에이전트·MCP 쓰기를 막는 것은 확인했지만, `write_stdin`이 훅을 거치지 않고 훅 오류에서 도구가 실행되므로(fail-open) 리드 등급은 C다. 위임 자동 승인과 takeover가 꺼지고, 모든 라운드는 교차 계열 리뷰를 거친 뒤 리드 판정으로 닫는다. 운영자는 실측을 마친 뒤에만 `HF_ALLOW_LEAD_GRADE=B`로 올린다(호스트를 띄우기 전에 정한다. 리드가 셸에서 설정하면 가드가 막는다).

## 설치

1. 스킬: 이 저장소 폴더를 `~/.agents/skills/hyperfusion`으로 심볼릭 링크한다. Codex는 링크된 스킬 폴더를 따라간다.
2. 훅: 스킬 폴더에서 `node scripts/lead-guard.mjs --print-settings --host codex`를 실행하고, 출력의 `hooks`를 `~/.codex/hooks.json`에 합친다. 저장소의 `.codex/`가 아니라 사용자 설정에 둔다.
3. 신뢰: Codex는 관리형이 아닌 훅을 정의의 해시로 신뢰한다(`~/.codex/config.toml`의 `[hooks.state.'<hooks.json 경로>:<이벤트>:<n>:<m>']`). 시작할 때 묻는 신뢰를 받거나 `/hooks`에서 신뢰해야 돈다. 정의를 바꾸면 해시가 바뀌어 다시 신뢰해야 한다. 0.164.0에서는 프로젝트 `.codex/hooks.json`을 신뢰해도 `/hooks` 목록에 보이지 않았다.
4. 리뷰 설정: 비 Claude 리드는 `review.strategy: "lead-gated-adaptive"`가 필요하다. 없으면 init이 `ADAPTIVE_REVIEW: a non-Claude lead requires review.strategy lead-gated-adaptive`로 거절한다. 저장소의 `hyperfusion.config.json`에 `{"review":{"by":"delegate","strategy":"lead-gated-adaptive"}}`를 둔다.
5. 샌드박스: Windows의 Codex 샌드박스(`workspace-write`) 안에서는 node가 자식 프로세스를 띄우지 못한다(`spawnSync … EPERM`). 컨트롤러는 git과 일꾼을 띄우므로 init이 `GIT_CONFIG_UNREADABLE`로 실패한다. 컨트롤러 명령(`fusion-state.mjs`, `executor-bridge.mjs`)은 샌드박스 밖 실행(`require_escalated`)으로 승인한다. 승인을 기다리는 동안 15초 관측 창이 지나면 init이 `LEAD_MODEL_UNKNOWN`이 되므로 바로 승인하거나 세션 동안 허용한다.
6. 확인: 작업을 시작하기 전에 Bash 도구를 한 번 쓰고 init을 실행한다. init은 최근 Bash PreToolUse 훅 관측(`hooks_observed`)과 훅이 보고한 리드 모델(`lead_identity`)을 기록한다. 관측이 없거나 훅이 모델을 보고하지 않으면 init은 `LEAD_MODEL_UNKNOWN`으로 거절한다(기본 Opus로 가정하지 않는다). 이때는 운영자가 Codex를 띄우기 전에 `HF_LEAD_MODEL`을 정한다.

운영자 환경변수(`HF_LEAD_MODEL`, `HF_ALLOW_LEAD_GRADE`, `HF_STATE_DIR` 등)는 Codex의 셸과 훅 프로세스에 그대로 오지 않을 수 있다. Codex CLI는 공유 app-server 데몬에서 도구와 훅을 실행하며, 데몬이 이미 떠 있으면 새 터미널에서 정한 값이 셸에도 훅에도 보이지 않았다(0.164.0 실측). 값을 바꾸려면 모든 Codex 세션을 닫아 데몬을 내린 뒤 그 환경에서 다시 띄우고, Codex 셸에서 `node -e "console.log(process.env.HF_LEAD_MODEL)"`로 확인한다.

## 가드가 하는 일

| 도구 | 작업 중 처리 |
| --- | --- |
| `apply_patch`(Edit·Write) | 패치 본문의 `*** Update/Add/Delete File:` 경로로 저장소를 찾아 lease·단계 규칙을 적용한다. 경로를 못 읽으면 작업 폴더 기준으로 막는다 |
| `Bash`(실제 도구는 `exec_command`) | Claude Code와 같은 위험 명령 차단, 완화 환경변수(`HF_ALLOW_*`, `HF_LEAD_*`, `HF_ALLOWED_VENDORS`) 설정 차단. 대화형 셸·REPL(`pwsh`, `bash`, `cmd /k`, 인자 없는 `node`·`python` 등)을 띄우는 것도 막는다 |
| `mcp__*` | 읽기 전용 허용 목록 밖은 막는다. 훅에 오는 이름은 `mcp__codex_apps__google_drive__create_folder`처럼 서버 이름이 정규화돼 있다 |
| `write_stdin` | 입력이 있으면 막고, 빈 입력(`chars:""`, 오래 도는 명령의 출력 폴링)은 허용한다. 단 0.164.0은 이 도구에 PreToolUse를 걸지 않으므로 지금은 대화형 셸을 띄우는 단계에서 막는 것이 실제 차단이다 |
| `spawn_agent`(보고 이름 `collaborationspawn_agent`) | 막는다. 하위 에이전트는 컨트롤러를 거치지 않는다 |
| `update_plan`, `view_image` | 허용 |
| 그 밖의 도구 | 쓰기로 보고 막는다 |

Stop은 Codex에 `stop_hook_active`가 없으므로 같은 턴(`turn_id`)에서 한 번만 막는다.

## 일꾼과 리드 구분

일꾼 `codex exec`에는 `-c features.hooks=false`를 넘겨 사용자 훅을 끈다. 관리형 훅(`requirements.toml`)은 이 값으로 꺼지지 않으므로, 브리지는 일꾼 프로세스에 lease 토큰의 해시(`HF_WORKER_LEASE`)나 상담 ID(`HF_WORKER_CONSULT`)를 넘기고 가드는 이 값이 현재 lease·상담과 맞을 때만 일꾼으로 본다. 리드는 셸 명령으로 자기 호스트 프로세스의 환경을 바꿀 수 없다.

## 실측

실측 절차는 [codex-field-test.md](codex-field-test.md)에 있다. Codex 세션에 그대로 넘겨 실행시키고, 결과 보고로 등급을 정한다.

## 알려진 한계

- Codex 훅은 오류에서 도구를 막지 않는다(fail-open). 가드 스크립트가 없을 때 "hook exited with code 1"이 뜨고 `apply_patch`가 그대로 실행됐다(0.164.0 실측). 시간 초과·잘못된 출력은 아직 실측하지 않았다. 가드는 조기 경보이고 경계는 컨트롤러의 스냅샷·drift 검사·수용 테스트다.
- `write_stdin`은 훅을 거치지 않는다. 대화형 셸을 띄우는 단계는 막지만, 표준 입력을 읽어 실행하는 임의의 프로그램(`node -e "…stdin…"` 등)까지 모두 알아볼 수는 없다.
- 호스트 도구(WebSearch 등)는 훅을 거치지 않는다.
- 훅의 `model`은 활성 모델의 이름(slug)이며 실제 백엔드 모델을 검증한 값이 아니다. `/model` 전환은 다음 도구 호출의 훅에 반영된다(`gpt-6.1-sol` → `gpt-6-luna` 확인). 0.164.0의 `/model` 목록에는 OpenAI 모델만 있다. 하위 에이전트 훅은 부모 `session_id`를 쓴다.
- Codex transcript(`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`)의 `event_msg/token_count` 행에 `total_token_usage`·`last_token_usage`가 있고 모델 이름은 `turn_context` 행에 있다. 파서는 아직 없어서 리드 사용량은 미측정(unknown)으로 남는다.
- 실측하지 않은 항목: 훅 시간 초과·잘못된 출력, 관리형 훅 환경의 일꾼 구분, Codex 일꾼(luna·sol)의 `features.hooks=false`, 작업 재개(`codex resume`), 운영자 `HF_LEAD_MODEL` 충돌, desktop 앱.
