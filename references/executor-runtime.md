# 일꾼 런타임 (Grok, Antigravity)

설치·인증된 CLI를 POSIX에서 쓴다. doctor는 실행 파일, 버전, 필수 플래그만 확인하고 모델 호출이나 인증은 확인하지 않는다. 인증 실패는 실제 호출에서 드러난다. 오류를 없애려고 소프트웨어를 설치하거나 인증정보를 복사하거나 계정 설정을 바꾸지 않는다.

## 공통

- 브리지는 셸 없이 실행하고 stdin은 닫는다. stdout/stderr는 각각 8 MiB, 호출당 20분, 40턴 상한. timeout/중단 시 프로세스 그룹에 SIGTERM 후 SIGKILL.
- `launch-N.json`(create-once)이 같은 라운드의 중복 실행을 막는다. `process-N.json`, `envelope-N.json`에 PID와 원본 출력을 남긴다.
- 성공해도 lease는 유지된다. 리드가 빠져나간 자손 프로세스가 없음을 확인한 뒤 finish 한다.
- 결과는 공통 result 계약으로 검증한다. 오류 envelope, 세션 불일치, 미완료 중단, JSON 아님은 전부 실패다.
- `executor_bash_rules`(선택): `["Bash(npm test*)"]` 같은 좁은 규칙만. `Bash(*)`나 commit/push/deploy 규칙은 금지. 리드가 실제로 확인한 테스트·빌드 명령에서 고른다.

## Grok (`grok`)

- 헤드리스는 stdin을 프롬프트로 읽지 않는다. 브리지가 `.fusion/tasks/<id>/prompt-N.txt`를 만들고 `--prompt-file`로 넘긴다.
- 인자: `--output-format json --cwd REPO --max-turns 40`, 첫 라운드 `--session-id <UUID>`(컨트롤러가 미리 발급), 이후 `--resume <UUID>`.
- 권한: edit 허용 시 scope 경로마다 `--allow Edit(path)`, `--allow Edit(path/**)`. 항상 `--deny`로 `.fusion`/`.git` 편집과 git commit/push/reset/clean/stash/checkout/add 차단. `--yolo`나 `bypassPermissions`는 쓰지 않는다.
- 스키마 강제가 없으므로 최종 `text`가 결과 JSON 자체이거나 마지막 ```json 블록이어야 한다. `stopReason`이 `end_turn`이 아니면(예: max_turns) 실패. `sessionId`가 발급한 UUID와 다르면 실패.
- 사용량: `usage`, `modelUsage`, `num_turns`, `total_cost_usd`(클라이언트 추정치)를 `usage-N.json`에 기록.

## Antigravity (`agy`)

- 모든 플래그는 `-p` 앞에 오고 프롬프트는 `-p`의 인자다.
- 인자: `--output-format json --json-schema <결과 스키마> --add-dir REPO`, edit 허용 시 `--mode accept-edits`, 기본 `--sandbox`, 재개 시 `--conversation <id>`.
- 대화 ID는 CLI가 발급한다. 첫 라운드 envelope의 `conversation_id`를 `session-N.json`에 남기고 finish에서 상태에 묶는다. 이후 다른 ID로 바꾸려면 recovery가 필요하다.
- agy에는 명령 단위 허용 규칙이 없어 `executor_bash_rules`는 dispatch에 `ignored_bash_rules`로 기록만 된다. 터미널 제한은 `--sandbox`뿐이다. `--dangerously-skip-permissions`는 쓰지 않는다. 권한 때문에 막히면 실패로 보고하고 우회하지 않는다.
- `error` 필드, 실패성 `status`, `conversation_id` 부재는 실패. `structured_output`이 없으면 `response`에서 결과 JSON을 찾는다.
- 비용은 보고되지 않으므로 null로 둔다.

## 하지 말 것

"가장 최근 세션"으로 재개하지 않는다(`--continue`, `-c` 금지). 잃어버린 세션을 새 세션으로 대체하지 않는다. 한 일꾼의 전체 대화 기록을 다른 일꾼에게 복사하지 않는다. 교체 시에는 현재 트리, 리드의 결정, 남은 반려 사유만 brief로 준다.
