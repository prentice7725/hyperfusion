# Antigravity 호스트에서 리드로 쓰기

Antigravity(agy)에서 HyperFusion을 실행하면 agy가 돌리는 모델이 리드가 된다. agy는 Gemini 말고 Claude·gpt-oss도 제공하므로 리드 계열은 호스트가 아니라 모델로 정한다. Gemini 4 Argon이 리드면 리드 계열은 google이다. 이때 Sol이 APEX를 맡고, Sonnet은 외부 전문가(grant 필요), Haiku는 자동 구현자가 되며, AGY 일꾼은 예비가 된다. agy에서 Opus를 고르면 팀은 Claude Code와 같다.

**이 호스트는 아직 실측하지 않았다.** 그래서 리드 등급은 C다. 위임 자동 승인과 takeover가 꺼지고, 모든 라운드는 교차 계열 리뷰를 거친 뒤 리드 판정으로 닫는다. 등급은 운영자가 실측을 마친 뒤에만 `HF_ALLOW_LEAD_GRADE=B`로 올린다.

## 설치

1. 스킬: 이 저장소 폴더를 플러그인이나 `~/.gemini/config/skills/hyperfusion`으로 둔다(`agy plugins install` 또는 심볼릭 링크).
2. 훅: 스킬 폴더에서 `node scripts/lead-guard.mjs --print-settings --host antigravity`를 실행하고, 출력의 두 항목(`hyperfusion-guard`, `hyperfusion-usage`)을 `~/.gemini/config/hooks.json`에 합친다. 저장소의 `.agents/hooks.json`이 아니라 사용자 설정에 둔다.
3. 모델 고정: `--model`이나 `/model`로 리드 모델을 고정한다. 고정하지 않으면 훅이 `"auto"`를 보고할 수 있고, `"auto"`는 `unknown`이라 위임 승인이 꺼진다.
4. 확인: 작업을 시작하기 전에 `run_command`를 한 번 쓰고 init을 실행한다. init은 최근 훅 관측과 훅이 보고한 리드 모델(`lead_identity`)을 기록한다. 관측이 없거나 모델 보고가 없으면 `LEAD_MODEL_UNKNOWN`으로 거절하므로, 운영자가 agy를 띄우기 전에 `HF_LEAD_MODEL`을 정한다.

## 가드가 하는 일

agy 훅은 이벤트 이름을 주지 않으므로 명령에 `--event`를 붙인다. 훅의 작업 폴더는 저장소가 아니라 `hooks.json`이 있는 폴더라서, 저장소는 `workspacePaths`와 도구 인자의 경로로 찾는다.

| 도구 | 작업 중 처리 |
| --- | --- |
| `write_to_file`, `replace_file_content`, `multi_replace_file_content`, `write_file`, `edit_file` | 경로 인자(`Path`, `TargetFile` 등)로 저장소를 찾아 lease·단계 규칙을 적용한다. 경로가 없으면 작업 폴더 기준으로 막는다 |
| `run_command` | Claude Code와 같은 Bash 규칙. `BypassSandbox:true`는 이 스킬의 컨트롤러 명령(`executor-bridge`, `autopilot`, `smoke`, `fusion-state`)에만 허용한다 |
| `call_mcp_tool`, `mcp_<server>_<tool>` | `mcp__server__tool`로 바꿔 읽기 전용 허용 목록으로 판정한다 |
| `invoke_subagent`, `define_subagent`, `send_message`, `manage_task`(`send_input`·`kill`) | 막는다 |
| `view_file`, `list_dir`, `grep_search` 등 읽기 도구 | 허용 |
| 그 밖의 도구 | 쓰기로 보고 막는다 |

Stop은 정상 종료(`model_stop`, `NO_TOOL_CALL`)이고 `fullyIdle:true`일 때만, 같은 대화·단계·라운드에서 한 번 이어 가게 한다(`{"decision":"continue"}`). 오류·취소·한도 종료는 막지 않는다. 상태 줄은 넣지 않는다. `PreInvocation`의 `injectSteps`는 모델 호출마다 리드 컨텍스트에 들어가 토큰을 늘리기 때문이다.

## 일꾼과 리드 구분

agy에는 훅만 끄는 플래그가 없다. 일꾼 agy도 `~/.gemini/config/hooks.json`을 읽으므로, 브리지가 일꾼 프로세스에 lease 토큰의 해시(`HF_WORKER_LEASE`)나 상담 ID(`HF_WORKER_CONSULT`)를 넘기고 가드는 이 값이 현재 lease·상담과 맞을 때만 일꾼으로 본다.

## 알려진 한계

- 훅 실패·시간 초과의 동작은 문서에 없다. AionCore는 agy 1.3.1에서 약 30초 뒤 도구가 실행되는 것을 관찰했다(fail-open으로 본다). 경계는 컨트롤러의 스냅샷·drift 검사·수용 테스트다.
- 도구 이름과 인자 이름은 문서와 다른 에이전트의 실측 보고를 따랐다. 버전마다 달라질 수 있다.
- transcript 파서는 넣지 않았다. 리드 사용량은 미측정(unknown)으로 남는다.
- 실측해야 할 항목: 훅 실패·시간 초과, `"auto"`와 표시 이름 모델 값, 실제 도구 이름과 인자, `manage_task` 입력 우회, 훅 cwd와 `workspacePaths`, `terminationReason` 값과 Stop 반복 방지, 샌드박스 기본값과 브리지 실행, transcript 행 형식. App·CLI·IDE는 따로 기록한다.
