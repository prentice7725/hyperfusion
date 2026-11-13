# Antigravity 호스트에서 리드로 쓰기

Antigravity(agy)에서 HyperFusion을 실행하면 agy가 돌리는 모델이 리드가 된다. agy는 Gemini 말고 Claude·gpt-oss도 제공하므로 리드 계열은 호스트가 아니라 모델로 정한다. Gemini 4 Argon이 리드면 리드 계열은 google이다. 이때 Sol이 APEX를 맡고, Sonnet은 외부 전문가(grant 필요), Haiku는 자동 구현자가 되며, AGY 일꾼은 예비가 된다. agy에서 Opus를 고르면 팀은 Claude Code와 같다.

**이 호스트는 일부만 실측했다(2026-10-27, agy CLI 1.4.7, Windows 11).** 훅이 리드 모델을 보고하고 쓰기·push·완화 변수·하위 에이전트·`manage_task`를 막는 것은 확인했지만, 일꾼 라운드와 훅 시간 초과는 확인하지 않았으므로 리드 등급은 C다. 위임 자동 승인과 takeover가 꺼지고, 모든 라운드는 교차 계열 리뷰를 거친 뒤 리드 판정으로 닫는다. 등급은 운영자가 실측을 마친 뒤에만 `HF_ALLOW_LEAD_GRADE=B`로 올린다.

## 설치

1. 스킬: 이 저장소 폴더를 플러그인이나 `~/.gemini/config/skills/hyperfusion`으로 둔다(`agy plugins install` 또는 심볼릭 링크).
2. 훅: 스킬 폴더에서 `node scripts/lead-guard.mjs --print-settings --host antigravity`를 실행하고, 출력의 두 항목(`hyperfusion-guard`, `hyperfusion-usage`)을 `~/.gemini/config/hooks.json`에 합친다. 저장소의 `.agents/hooks.json`이 아니라 사용자 설정에 둔다. agy는 훅 명령을 셸 없이 공백으로 나누고 따옴표를 글자 그대로 넘기므로(Windows 1.4.7 실측) 출력의 경로에는 따옴표가 없다. 스킬 경로에 공백이 있으면 `--print-settings`가 거절하니 공백 없는 경로로 옮긴다. 훅이 실패하면 그 도구 호출은 막힌다.
3. 모델 고정: `--model`이나 `/model`로 리드 모델을 고정한다. 고정하지 않으면 훅이 `"auto"`를 보고할 수 있고, `"auto"`는 `unknown`이라 위임 승인이 꺼진다. 대화형으로 띄운 세션은 설정 파일의 기본 모델을 보고한 사례가 있으니 init 결과의 `lead_identity.model`을 확인한다.
4. 리뷰 설정: 비 Claude 리드는 `review.strategy: "lead-gated-adaptive"`가 필요하다. 저장소의 `hyperfusion.config.json`에 `{"review":{"by":"delegate","strategy":"lead-gated-adaptive"}}`를 둔다. 없으면 init이 `ADAPTIVE_REVIEW`로 거절한다.
5. 확인: 작업을 시작하기 전에 `run_command`를 한 번 쓰고 init을 실행한다. init은 최근 훅 관측과 훅이 보고한 리드 모델(`lead_identity`)을 기록한다. 관측이 없거나 모델 보고가 없으면 `LEAD_MODEL_UNKNOWN`으로 거절하므로, 운영자가 agy를 띄우기 전에 `HF_LEAD_MODEL`을 정한다.

## 가드가 하는 일

agy 훅은 이벤트 이름을 주지 않으므로 명령에 `--event`를 붙인다. 훅의 작업 폴더는 저장소가 아니라 `hooks.json`이 있는 폴더라서, 저장소는 `workspacePaths`와 도구 인자의 경로로 찾는다.

| 도구 | 작업 중 처리 |
| --- | --- |
| `write_to_file`, `replace_file_content`, `multi_replace_file_content`, `write_file`, `edit_file` | 경로 인자(`Path`, `TargetFile` 등)로 저장소를 찾아 lease·단계 규칙을 적용한다. 경로가 없으면 작업 폴더 기준으로 막는다 |
| `run_command` | Claude Code와 같은 Bash 규칙. 이전 버전의 `BypassSandbox:true`는 이 스킬의 컨트롤러 명령(`executor-bridge`, `autopilot`, `smoke`, `fusion-state`)에만 허용한다. 1.5.6에는 이 인자가 없다 |
| `call_mcp_tool`, `mcp_<server>_<tool>` | `mcp__server__tool`로 바꿔 읽기 전용 허용 목록으로 판정한다 |
| `invoke_subagent`, `define_subagent`, `send_message`, `manage_task`(`send_input`·`kill`) | 막는다 |
| `read_file`, `view_file`, `list_dir`, `grep_search` 등 읽기 도구 | 허용 |
| 그 밖의 도구 | 쓰기로 보고 막는다 |

가드는 모든 경로에서 결정을 출력한다. 1.5.6에서 빈 출력에 exit 0이면 도구가 실행되고, `{}`는 이유 없이 막힌다(실측). 입력을 못 읽거나 판정이 예외를 내면 PreToolUse는 `deny`, Stop은 `stop`을 출력한다.

Stop은 정상 종료(`model_stop`, `NO_TOOL_CALL`)이고 `fullyIdle:true`일 때만, 같은 대화·단계·라운드에서 한 번 이어 가게 한다(`{"decision":"continue"}`). 오류·취소·한도 종료는 막지 않는다. 상태 줄은 넣지 않는다. `PreInvocation`의 `injectSteps`는 모델 호출마다 리드 컨텍스트에 들어가 토큰을 늘리기 때문이다.

## 일꾼과 리드 구분

agy에는 훅만 끄는 플래그가 없다. 일꾼 agy도 `~/.gemini/config/hooks.json`을 읽으므로, 브리지가 일꾼 프로세스에 lease 토큰의 해시(`HF_WORKER_LEASE`)나 상담 ID(`HF_WORKER_CONSULT`)를 넘기고 가드는 이 값이 현재 lease·상담과 맞을 때만 일꾼으로 본다.

## 실측

실측 절차는 [antigravity-field-test.md](antigravity-field-test.md)에 있다. agy 세션에 그대로 넘겨 실행시키고, 결과 보고로 등급을 정한다.

## 1.5.6 실측 (2026-11-12)

헤드리스(`agy -p --output-format json`)로 T1~T10을 돌렸다. 기록은 [antigravity-field-2026-11-12.md](antigravity-field-2026-11-12.md)에 있다.

- 훅이 없으면 init이 `LEAD_MODEL_UNKNOWN`으로 거절한다. Opus 리드로 넘어가지 않는다.
- `modelName`은 고정한 모델 ID다. 고정하지 않아도 설정의 기본 모델 ID(예: `gemini-4-argon-medium`)가 오고 `"auto"`나 표시 이름은 오지 않았다.
- init의 `lead_identity`는 google, host-hook, C등급이다. 위임 요청은 `DELEGATION`, `HF_LEAD_MODEL` 충돌은 `LEAD_IDENTITY_CONFLICT`로 거절된다.
- 작업 중 리드의 편집, `git push`, `HF_ALLOW_*`, `invoke_subagent`, `manage_task`의 `send_input`·`kill`은 막히고 읽기는 허용된다. MCP는 재지 않았다.
- agy 일꾼도 같은 `hooks.json`을 읽지만 lease 표식으로 일꾼으로 인식돼 쓰기와 `finish`가 통과했다. Haiku 일꾼 라운드도 정상이었다.
- REVIEW에서 `NO_TOOL_CALL`로 멈추면 한 번 이어 가고 두 번째는 멈춘다. `continuationActive`는 이어 간 뒤에도 `false`라서 가드는 자체 기록으로만 한 번을 센다. 오류·취소 종료는 재지 않았다.
- 없는 스크립트, 30초 시간 초과, 잘못된 JSON은 모두 도구를 막는다. 빈 출력만 통과한다.
- 다른 계열(Claude, gpt-oss)로 모델을 바꾸면 다음 `begin`이 `LEAD_FAMILY_CHANGED`로 거절된다. 같은 계열 교체는 `lead_model_changes`에 남는다.
- 가드 한 번에 0.7~0.9초가 걸린다.
- 헤드리스 agy는 허용 규칙이 없는 명령을 자동으로 거절한다. 세션 한정 `--settings '{"permissions":{"allow":["command(<명령 전체>)"]}}'`는 명령 줄 전체가 정확히 같을 때만 맞았다(`command(node)`는 `node x y`에 맞지 않는다). 파일 편집은 `--mode accept-edits`로 허용했다.

등급은 C 그대로다. 런북은 pre_block과 model_identity가 모두 "예"일 때만 C보다 높은 등급을 권하는데, MCP를 재지 않아 pre_block이 부분이다.

## 알려진 한계

- 훅이 0이 아닌 코드로 끝나거나 30초를 넘기면 도구 호출이 막힌다(1.4.7, 1.5.6 실측). AionCore는 1.3.1에서 약 30초 뒤 도구가 실행되는 것을 관찰했다. 경계는 여전히 컨트롤러의 스냅샷·drift 검사·수용 테스트다.
- agy는 저장소의 `.agents/hooks.json`을 신뢰 확인 없이 바로 실행한다(1.4.7 실측). 작업 중에는 가드가 저장소 수정을 막지만, 작업이 없을 때 바뀐 저장소 훅은 다음 세션에 그대로 돈다.
- 실측한 도구 이름(1.5.6): `run_command`(`CommandLine`, `WaitMsBeforeAsync`), `read_file`(`Path`, 디렉터리 목록도 이것으로 읽는다), `write_file`(`Path`, `Content`, `Overwrite`), `edit_file`(`Path`, `Target`, `Replacement`, 여러 줄 편집 포함), `invoke_subagent`, `manage_task`(`Action`). `list_dir`, `grep_search`, 여러 곳 편집 도구는 나오지 않았다. 버전마다 달라질 수 있다.
- transcript(`~/.gemini/antigravity-cli/brain/<대화 ID>/.system_generated/logs/transcript_full.jsonl`)는 단계마다 `input_tokens`·`cache_read_tokens`·`output_tokens`를 남기지만 모델 이름은 없다. 파서를 만들면 모델은 같은 대화·단계의 훅 기록에서 가져와야 한다. 파서는 아직 없어서 리드 사용량은 미측정(unknown)으로 남는다.
- 실측하지 않은 항목: MCP 도구, 오류·취소·한도 Stop, 일꾼의 자식 프로세스 쓰기, App·IDE.
