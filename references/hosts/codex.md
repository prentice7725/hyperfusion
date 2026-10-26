# Codex 호스트에서 리드로 쓰기

Codex CLI에서 HyperFusion을 실행하면 Codex의 모델(예: GPT 6.1 Astra, Sol)이 리드가 된다. 팀은 리드 계열(openai)을 기준으로 다시 짜인다. Sonnet이 APEX(외부 최상위)가 되고, Sol은 전문가 자리(grant 필요)를 맡으며, Luna는 예비가 된다. 리드와 같은 모델은 일꾼 자리를 내놓는다(Sol 리드면 Sol은 일꾼이 아니다).

**이 호스트는 아직 실측하지 않았다.** 그래서 리드 등급은 C다. 위임 자동 승인과 takeover가 꺼지고, 모든 라운드는 교차 계열 리뷰를 거친 뒤 리드 판정으로 닫는다. 운영자는 실측을 마친 뒤에만 `HF_ALLOW_LEAD_GRADE=B`로 올린다(호스트를 띄우기 전에 정한다. 리드가 셸에서 설정하면 가드가 막는다).

## 설치

1. 스킬: 이 저장소 폴더를 `~/.agents/skills/hyperfusion`으로 심볼릭 링크한다. Codex는 링크된 스킬 폴더를 따라간다.
2. 훅: 스킬 폴더에서 `node scripts/lead-guard.mjs --print-settings --host codex`를 실행하고, 출력의 `hooks`를 `~/.codex/hooks.json`에 합친다. 저장소의 `.codex/`가 아니라 사용자 설정에 둔다.
3. 신뢰: Codex는 관리형이 아닌 훅을 정의의 해시로 신뢰한다. `/hooks`에서 새 항목을 검토하고 신뢰해야 돈다. 설정을 바꾸면 다시 신뢰해야 한다.
4. 확인: 작업을 시작하기 전에 Bash 도구를 한 번 쓰고 init을 실행한다. init은 최근 Bash PreToolUse 훅 관측(`hooks_observed`)과 훅이 보고한 리드 모델(`lead_identity`)을 기록한다. 관측이 없으면 리드 모델을 알 수 없으므로 운영자가 `HF_LEAD_MODEL`을 정해야 한다.

## 가드가 하는 일

| 도구 | 작업 중 처리 |
| --- | --- |
| `apply_patch`(Edit·Write) | 패치 본문의 `*** Update/Add/Delete File:` 경로로 저장소를 찾아 lease·단계 규칙을 적용한다. 경로를 못 읽으면 작업 폴더 기준으로 막는다 |
| `Bash` | Claude Code와 같은 위험 명령 차단, 완화 환경변수(`HF_ALLOW_*`, `HF_LEAD_*`, `HF_ALLOWED_VENDORS`) 설정 차단 |
| `mcp__*` | 읽기 전용 허용 목록 밖은 막는다 |
| `write_stdin`, `spawn_agent` | 막는다. 이미 허용된 셸 입력은 PreToolUse를 다시 거치지 않고, 하위 에이전트는 컨트롤러를 거치지 않는다 |
| `update_plan`, `view_image` | 허용 |
| 그 밖의 도구 | 쓰기로 보고 막는다 |

Stop은 Codex에 `stop_hook_active`가 없으므로 같은 턴(`turn_id`)에서 한 번만 막는다.

## 일꾼과 리드 구분

일꾼 `codex exec`에는 `-c features.hooks=false`를 넘겨 사용자 훅을 끈다. 관리형 훅(`requirements.toml`)은 이 값으로 꺼지지 않으므로, 브리지는 일꾼 프로세스에 lease 토큰의 해시(`HF_WORKER_LEASE`)나 상담 ID(`HF_WORKER_CONSULT`)를 넘기고 가드는 이 값이 현재 lease·상담과 맞을 때만 일꾼으로 본다. 리드는 셸 명령으로 자기 호스트 프로세스의 환경을 바꿀 수 없다.

## 알려진 한계

- Codex 훅은 오류·시간 초과·잘못된 출력에서 도구를 막지 않는다(fail-open). 가드는 조기 경보이고 경계는 컨트롤러의 스냅샷·drift 검사·수용 테스트다.
- 호스트 도구(WebSearch 등)는 훅을 거치지 않는다.
- 훅의 `model`은 활성 모델의 이름(slug)이며 실제 백엔드 모델을 검증한 값이 아니다. 하위 에이전트 훅은 부모 `session_id`를 쓴다.
- Codex transcript 형식은 확인하지 않았다. 리드 사용량은 미측정(unknown)으로 남는다.
- 실측해야 할 항목: 훅 미신뢰·변경·중단, 관리형 훅 환경의 일꾼 구분, `write_stdin`, 하위 에이전트 모델 혼입, 라운드 도중 리드 수정, 리드의 가드 끄기 시도, 작업 재개, 모델 전환. Codex CLI와 desktop은 따로 기록한다.
