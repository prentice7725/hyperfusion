# 복구

새 작업에서 init의 `reconciliation` 권한을 고정한 경우 [명시적 재개 정산](reconciliation.md)의 읽기 전용 `reconcile` 조회와 명시적 적용을 사용할 수 있다. 기존 작업에 권한을 추가하지 않으며, 불확실한 의도 영수증은 재실행하지 않는다. 아래 수동 복구 경로와 기존 종료 증명 조건은 유지된다.

후속 `begin`은 직전 라운드의 `post_digest`와 현재 트리를 비교한다. 범위 안 파일을 Bash로 썼더라도 일치하지 않으면 새 lease·시도 예산을 쓰기 전에 `RECOVERY_REQUIRED`로 멈춘다. 프리플라이트 도중 생긴 변경도 같은 방식으로 멈춘다. 쓰기 프로세스가 없음을 확인하고 누적 diff를 검토한 뒤 `recover`에 `quiescent:true`와 `reason`을 준다(lease가 없으면 token은 필요 없다). 복구는 확인한 현재 digest를 다음 시작의 기대값으로 기록하며, 변경을 일꾼이 쓴 것으로 인정하거나 승인하지 않는다.

1. 상태, lock, 최신 brief, 결과, 라운드별 스냅샷, 실제 diff/status를 본다. 오래된 타임스탬프는 writer가 멈췄다는 증거가 아니다.
2. `launch-N.json`, `process-N.json`, `envelope-N.json`으로 브리지와 일꾼 프로세스(POSIX는 프로세스 그룹, Windows는 프로세스 트리)가 모두 끝났는지 확인한다. Windows에서는 `process-N.json`의 pid를 부모로 가진 프로세스가 남았는지 직접 본다. 빠져나간 자손도 확인한다. 정지를 확인할 수 없으면 lock을 유지하고 BLOCKED로 보고한다.
3. 컨트롤러가 죽어 control.lock이 남았으면: lock에는 소유자(pid, 호스트, 시각)가 적혀 있다. 같은 호스트에서 그 프로세스가 이미 없으면 다음 명령이 알아서 치운다. 살아 있거나 다른 호스트면 `EEXIST … held by pid N on HOST`로 거절하므로, 실행 중인 컨트롤러가 없음을 확인하고 기록한 뒤 그 파일만 지운다. writer.json을 지워 lease를 훔치지 않는다. `recover`에 token, `quiescent:true`, 근거 있는 reason을 넘긴다. 스냅샷 후 lease를 놓고 남은 예산 안에서 라우팅한다.
4. launch 표식을 재실행하거나, 카운터를 초기화하거나, 저장된 세션을 새 세션으로 바꾸지 않는다. 같은 작업을 archive/re-init 해서 예산을 리셋하지 않는다.
5. 소스의 자동 되돌리기는 없다. 사용자 변경을 보존한다. 다른 스키마(main 브랜치 포함)의 상태는 status로 읽고, 프로세스 정지를 확인한 뒤 reason과 함께 archive만 할 수 있다.

## 예: 남은 writer.json 처리 (Windows PowerShell)

`setup-doctor`가 `RECOVERY_REQUIRED: writer.json owner=... task=... round=...`를 보여 줄 때.

```powershell
$HF = "$env:USERPROFILE\.claude\skills\hyperfusion"
$REPO = "C:\workspace\대상저장소"

# 0) 제어 폴더 위치 (작업 폴더 밖에 있다)
$CTRL = node "$HF\scripts\control-dir.mjs" path $REPO

# 1) 상태와 lease 확인 (token은 writer.json에 있다)
node "$HF\scripts\fusion-state.mjs" status $REPO
Get-Content "$CTRL\locks\writer.json"

# 2) 일꾼·컨트롤러가 정말 끝났는지 확인. 남아 있으면 여기서 멈추고 원인부터 본다.
Get-Process grok, claude, agy -ErrorAction SilentlyContinue
git -C $REPO status --short   # 일꾼이 남긴 변경 확인

# 3) stdin으로 입력을 넘겨 복구
$token = (Get-Content "$CTRL\locks\writer.json" | ConvertFrom-Json).token
@{ token = $token; quiescent = $true; reason = "프로세스 없음 확인, diff 검토함" } | ConvertTo-Json | node "$HF\scripts\fusion-state.mjs" recover $REPO -
```

- `status` 결과의 `schema_version`이 4가 아니면(main 브랜치나 이전 버전이 만든 작업) `recover` 대신 `archive`를 쓴다. 입력은 같고 명령만 `archive`다.
- `state.json`이 CLOSE/ARCHIVED인데 writer.json만 남았다면 init 직후나 begin 도중 컨트롤러가 죽은 경우다. 프로세스가 없음을 확인한 뒤 `archive`로 정리한다.
- writer.json을 손으로 지우지 않는다. 남은 변경을 되돌릴지 여부는 리드가 diff를 보고 정한다.

## 범위 밖에 남은 파일

복구는 일꾼이 남긴 변경을 자동으로 되돌리지 않는다. 그래서 라운드가 범위 밖 파일 때문에 실패한 뒤 그 파일이 남아 있으면, 컨트롤러는 그 파일을 기억해 두고 **다음 라운드에서도 계속 막는다**(`Earlier out-of-scope changes still present`). 아래 둘 중 하나를 해야 한다.

1. **되돌린다.** 리드가 diff를 보고 그 파일을 직접 되돌린 뒤 `recover`한다. 다음 라운드가 깨끗한 기준선에서 시작한다.
2. **알고 받아들인다.** `recover`에 `allow_out_of_scope: [{"path":"b.txt","reason":"사용자가 이 수정에 b.txt도 포함하라고 했다"}]`를 준다. 사유가 필수이고 기록(`scope_exceptions`)으로 남는다.

**공유 git 설정.** `git push -u`·`checkout -b`의 추적 설정, `worktree add`, 같은 저장소를 쓰는 다른 worktree, 사람이 친 `git config`는 일꾼이 아니어도 `.git/config`를 바꾼다. 스냅샷이 이 파일의 해시를 라운드 앞뒤로 비교하므로 `Out of scope: .git/config`로 잡힌다(`.git/config`, `.git/config.worktree`, `.git/info/exclude`, `.git/info/attributes`). 되돌릴 수 없는 변경이면 위의 2번처럼 `allow_out_of_scope: [{"path":".git/config","reason":"..."}]`로 받는다. 이 네 파일만 가능하고 **훅(`.git/hooks/*`)과 그 밖의 `.git` 경로는 어떤 경우에도 받지 않는다**(코드라서). 설정은 명령을 실행할 수 있으므로(`core.fsmonitor`, `!` 별칭, 필터·diff·merge 드라이버, `include`) 지금 그런 항목이 하나라도 있으면 받지 않고 항목을 알려 준다(`git config --unset`으로 지운 뒤 다시). 받은 뒤에 그런 항목이 생기면 예외는 더 이상 인정되지 않는다.

연결 worktree에서는 `.git/config.worktree`가 그 worktree의 실제 Git 폴더에 있는 전용 설정을 뜻한다. 공통 Git 폴더에 있는 주 worktree의 `config.worktree`도 `.git/common/config.worktree`로 감시하지만, 이 경로는 범위 예외로 받지 않는다. 설정 위험 검사는 저장소·worktree와 그 설정이 include한 파일을 함께 확인하고, 점이 포함된 드라이버·조건부 include 이름도 검사한다. 전역·시스템 기본 설정은 로컬 설정 예외를 막는 사유로 쓰지 않지만, 컨트롤러 Git 실행에서는 그 설정의 실행 가능한 드라이버도 무력화한다. 실제 적용 설정을 읽을 수 없으면 `GIT_CONFIG_UNREADABLE`로 중단하고 설정 예외도 거절한다.

마지막 관문인 `verify`는 라운드 단위가 아니라 **최초 기준선과 비교해** 허용 범위(시작 brief와 모든 라운드 brief의 범위 + 예외) 밖에 남은 변경이 있으면 거절한다. 라운드 사이에 사용자가 다른 파일을 고친 경우도 여기서 걸린다. 그 변경이 의도된 것이면 `verify`에 같은 `allow_out_of_scope`를 줄 수 있다. 되돌리는 쪽이면 작업이 다시 한 라운드 필요하다.
