# 일꾼 런타임 (Grok, Antigravity, Sonnet)

설치·인증된 CLI를 Linux·macOS·Windows에서 쓴다. doctor는 실행 파일, 버전, 필수 플래그만 확인하고 모델 호출이나 인증은 확인하지 않는다. 인증 실패는 실제 호출에서 드러난다. 오류를 없애려고 소프트웨어를 설치하거나 인증정보를 복사하거나 계정 설정을 바꾸지 않는다.

## 공통

- 브리지는 셸 없이 실행한다. stdout/stderr는 각각 8 MiB, 호출당 기본 20분(`executors.<이름>.timeout_ms`로 조정), 40턴 상한. timeout/중단 시 POSIX는 프로세스 그룹에 SIGTERM 후 SIGKILL, Windows는 `taskkill /T /F`로 트리를 끝낸다.
- `launch-N.json`(create-once)이 같은 라운드의 중복 실행을 막는다. `process-N.json`, `envelope-N.json`에 PID와 원본 출력을 남긴다.
- 성공해도 lease는 유지된다. 리드가 빠져나간 자손 프로세스가 없음을 확인한 뒤 finish 한다.
- 결과는 공통 result 계약으로 검증한다. 오류 envelope, 세션 불일치, 미완료 중단, JSON 아님은 전부 실패다.
- `executor_bash_rules`(선택): 테스트·린트·빌드·읽기 전용 조회 모양의 규칙만 받는다(`Bash(npm test*)`, `Bash(node --test*)`, `Bash(pytest*)`, `Bash(git diff*)` 등). 와일드카드는 맨 끝의 `*` 하나만, 셸 메타문자(`; & | < > ` + "`" + ` $ ( )`)·따옴표·줄바꿈·인터프리터·네트워크 도구(`node *`, `sh -c`, `curl`)·`npm *`처럼 열린 규칙은 `init` 때 거절된다. 모양 제한은 `HF_BASH_POLICY=permissive`로만 풀 수 있다.
- **브리지는 dispatch 파일을 믿지 않는다.** 실행 직전에 brief와 상태로 같은 요청을 다시 만들어 실행 파일, 인자, 프롬프트가 하나라도 다르면 `DISPATCH_TAMPERED`로 멈춘다(상담도 읽기 전용 brief인지 확인). 일꾼에게는 필요한 환경변수만 넘긴다(`HF_ENV_PASS` 참고).
- **전송 마스킹:** 무결성 확인 뒤, 실제 stdin·prompt 파일·Antigravity `-p` 인자로 보내기 직전에 공통 마스킹을 적용한다. brief·diff·이전 결과·기억의 이메일, IPv4/IPv6, 알려진 키·토큰 형식, 비밀번호/비밀값 할당, PEM 개인키를 가린다. JSON 안에 다시 인코딩된 JSON도 처리한다. 원본 dispatch는 로컬 감사용으로 보존하고 `redaction-*.json`에는 종류별 개수만 남긴다. 필수 작업 ID·경로·CLI 규칙에 민감값이 있으면 바꾸어 전송하지 않고 `REDACTION_UNSAFE`로 거절한다. CLI 도움말 프로브도 실행과 동일한 벤더별 환경변수 허용 목록을 쓴다. 벤더 인증값은 인증을 위해 유지한다.
- **자동 정지 확인:** 오토파일럿이 실행하는 브리지는 프로세스 표를 관측해 PID·생성 시각으로 자손을 추적하고, 종료 뒤 남은 프로세스가 없는지 다시 확인하여 `quiescence-*.json`에 기록한다. 확인 실패·남은 자손·불확실한 종료에서는 자동 finish하지 않는다. 부모 연결을 끊고 관측 사이에 빠져나간 자손까지 완전하게 추적하는 OS 격리는 아니며, 수동 실행에는 기존 리드 정지 확인 절차가 계속 적용된다.

## Grok (`grok`)

- 헤드리스는 stdin을 프롬프트로 읽지 않는다. 브리지가 제어 폴더의 `tasks/<id>/prompt-N.txt`를 만들고 `--prompt-file`로 넘긴다.
- 인자: `--output-format json --cwd REPO --max-turns 40`, 첫 라운드 `--session-id <UUID>`(컨트롤러가 미리 발급), 이후 `--resume <UUID>`.
- 권한: edit 허용 시 scope 경로마다 `--allow Edit(path)`, `--allow Edit(path/**)`. 항상 `--deny`로 `.git`·`.fusion`·제어 폴더 절대 경로의 Edit/Write(중첩 포함)와 git 변경 명령(`git -C dir push`처럼 옵션이 끼어든 모양 포함), curl/wget/ssh/sudo 같은 도구를 차단. `--yolo`나 `bypassPermissions`는 쓰지 않는다.
- 스키마 강제가 없으므로 최종 `text`가 결과 JSON 자체이거나 마지막 ```json 블록이어야 한다. `stopReason`이 `end_turn`이 아니면(예: max_turns) 실패. `sessionId`가 발급한 UUID와 다르면 실패.
- 사용량: `usage`, `modelUsage`, `num_turns`, `total_cost_usd`(클라이언트 추정치)를 `usage-N.json`에 기록.

## Antigravity (`agy`)

- 모든 플래그는 `-p` 앞에 오고 프롬프트는 `-p`의 인자다.
- 인자: `--output-format json --json-schema <결과 스키마> --add-dir REPO`, edit 허용 시 `--mode accept-edits`, 기본 `--sandbox`, 재개 시 `--conversation <id>`.
- 대화 ID는 CLI가 발급한다. 첫 라운드 envelope의 `conversation_id`를 `session-N.json`에 남기고 finish에서 상태에 묶는다. 이후 다른 ID로 바꾸려면 recovery가 필요하다.
- 설치된 agy가 `--print-timeout`을 지원하면 브리지 timeout보다 30초 짧게 넘긴다(기본 1170s). agy가 스스로 끝내면 강제 종료 대신 정상 envelope가 남는다.
- agy는 Go 형식 도움말(`Usage of agy.EXE:`)을 stderr로 출력한다. 프로브는 stdout과 stderr를 합쳐서 확인한다.
- agy에는 명령 단위 허용 규칙이 없어 `executor_bash_rules`는 dispatch에 `ignored_bash_rules`로 기록만 된다. 터미널 제한은 `--sandbox`뿐이다. `--dangerously-skip-permissions`는 쓰지 않는다. 권한 때문에 막히면 실패로 보고하고 우회하지 않는다.
- `error` 필드, 실패성 `status`, `conversation_id` 부재는 실패. `structured_output`이 없으면 `response`에서 결과 JSON을 찾는다.
- 비용은 보고되지 않으므로 null로 둔다.

## Sonnet (`claude --model claude-sonnet-5-5`)

- 리드(Opus)와 별개인 Claude Code 하위 프로세스다. 리드의 대화 맥락을 공유하지 않으며, 리드가 직접 쓰는 것으로 치지 않는다.
- 인자: `-p --model claude-sonnet-5-5 --safe-mode --output-format json --json-schema <결과 스키마> --permission-mode dontAsk --max-turns 40`, 첫 라운드 `--session-id <UUID>`, 이후 `--resume <UUID>`. 프롬프트는 stdin.
- 도구: Read/Glob/Grep(+edit 허용 시 Edit/Write)과 `executor_bash_rules`에 있는 Bash만 허용. Agent/Task/Skill/MCP와 git 변경 명령은 금지. `--safe-mode`로 사용자 플러그인·훅·메모리를 끄므로 필요한 저장소 지침은 brief에 직접 넣는다.
- `structured_output`을 검증한다. 오류 envelope, 세션 불일치, `permission_denials`는 실패다.
- `--max-turns`는 일부 버전의 `--help`에 표시되지 않아 프로브하지 않는다(2.1.288에서 확인). 인자로는 넘기며, 인식하지 못하는 버전이면 실행이 실패로 끝난다.
- 실행 파일 경로는 `HF_CLAUDE_BIN`(기본 `claude`).

## Codex: Sol과 Luna (`codex exec`)

같은 CLI로 두 팀원을 만든다. 모델과 권한만 다르다.
- **Sol**(`gpt-6.1-sol`): 리뷰·상담 전용, 구현 lease를 받지 않음, 항상 `--sandbox read-only`.
- **Luna**(`gpt-6-luna`): 구현 일꾼. 구현 라운드는 `--sandbox workspace-write`, 상담·리뷰는 `read-only`. 커밋 같은 저장소 조작은 sandbox가 막지 않으므로 HEAD/index 스냅샷 검사로 잡는다. 세션은 라운드마다 새로 열고, 이전 지적은 `lead_feedback`로 넘긴다.
- 모델: `executors.sol.model`, `executors.luna.model`(기본값은 설치 환경에서 실제 ID를 확인할 것), 추론 강도 `reasoning_effort`.
- 인자: `exec --sandbox <read-only|workspace-write> --cd REPO --output-schema <스키마 파일> [--ephemeral] -m MODEL [-c model_reasoning_effort="…"] -`. 프롬프트는 stdin(`-`)으로 넘긴다. 스키마 파일은 브리지가 실행 직전에 만든다.
- `codex exec`는 진행 상황을 stderr로, 최종 메시지만 stdout으로 낸다. stdout의 JSON을 리뷰 계약으로 검증한다.
- 프로브는 `codex exec --help`로 필수 플래그(`--sandbox`, `--output-schema`, `--cd`)를 확인한다. 세션은 이어 쓰지 않는다(리뷰마다 새로).
- 사용량은 stderr로만 나와서 기록하지 않는다(null).

## Windows

- **실행 파일 찾기**: PATH와 PATHEXT(.exe, .cmd …)로 찾는다. npm이 만든 `.cmd` 래퍼는 cmd.exe를 거치지 않고 안의 실제 진입점(.js → 현재 node로 실행, 또는 .exe)을 꺼내 직접 실행한다. cmd.exe는 JSON 프롬프트의 따옴표·`%`·`^`를 망가뜨리기 때문이다. 진입점을 못 찾으면 `HF_GROK_BIN`/`HF_AGY_BIN`/`HF_CLAUDE_BIN`에 .exe나 .js 진입점 경로를 직접 넣는다.
- **프로세스 정리**: Windows에는 프로세스 그룹이 없다. 일꾼이 살아 있을 때만 `taskkill /T /F`로 트리를 끝낸다(PID 재사용 때문에 죽은 PID에는 쓰지 않는다). 따라서 **일꾼이 먼저 정상 종료한 뒤 남은 자손 프로세스는 브리지가 잡지 못한다.** finish 전에 리드가 확인한다. 예: PowerShell `Get-CimInstance Win32_Process | ? ParentProcessId -eq <process-N.json의 pid>`.
- **명령줄 길이**: Antigravity는 프롬프트를 명령줄 인자로 받는데 Windows는 약 32,000자 제한이 있다. 넘으면 lease 획득 전에 거절하므로 brief를 줄인다.
- **경로 표기**: 일꾼이 `src\a.ts`처럼 역슬래시로 보고해도 브리지가 `src/a.ts`로 맞춘 뒤 검증한다.
- **알려진 문제**: agy `-p`가 TTY 없는 Windows 환경에서 멈춘다는 보고가 있다([antigravity-cli#318](https://github.com/google-antigravity/antigravity-cli/issues/318)). 브리지는 파이프로 실행하므로 해당 버전에서는 timeout까지 기다리게 된다. `executors.antigravity.timeout_ms`를 짧게(예: 300000) 잡아 두면 빨리 실패하고 router가 다음 일꾼으로 넘긴다. Grok Build CLI의 Windows 지원 여부는 확인하지 못했다.
- 파일 권한(0600)은 Windows에서 적용되지 않는다. 제어 폴더(`~/.hyperfusion/state`)는 사용자 프로필 아래에 두고 공유 폴더에 두지 않는다.

## 하지 말 것

"가장 최근 세션"으로 재개하지 않는다(`--continue`, `-c` 금지). 잃어버린 세션을 새 세션으로 대체하지 않는다. 한 일꾼의 전체 대화 기록을 다른 일꾼에게 복사하지 않는다. 교체 시에는 현재 트리, 리드의 결정, 남은 반려 사유만 brief로 준다.
