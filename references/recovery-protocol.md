# 복구

1. 상태, lock, 최신 brief, 결과, 라운드별 스냅샷, 실제 diff/status를 본다. 오래된 타임스탬프는 writer가 멈췄다는 증거가 아니다.
2. `launch-N.json`, `process-N.json`, `envelope-N.json`으로 브리지와 일꾼 프로세스(POSIX는 프로세스 그룹, Windows는 프로세스 트리)가 모두 끝났는지 확인한다. Windows에서는 `process-N.json`의 pid를 부모로 가진 프로세스가 남았는지 직접 본다. 빠져나간 자손도 확인한다. 정지를 확인할 수 없으면 lock을 유지하고 BLOCKED로 보고한다.
3. 컨트롤러가 죽어 control.lock이 남았으면, 실행 중인 컨트롤러가 없음을 확인하고 기록한 뒤 그 파일만 지운다. writer.json을 지워 lease를 훔치지 않는다. `recover`에 token, `quiescent:true`, 근거 있는 reason을 넘긴다. 스냅샷 후 lease를 놓고 남은 예산 안에서 라우팅한다.
4. launch 표식을 재실행하거나, 카운터를 초기화하거나, 저장된 세션을 새 세션으로 바꾸지 않는다. 같은 작업을 archive/re-init 해서 예산을 리셋하지 않는다.
5. 소스의 자동 되돌리기는 없다. 사용자 변경을 보존한다. 다른 스키마(main 브랜치 포함)의 상태는 status로 읽고, 프로세스 정지를 확인한 뒤 reason과 함께 archive만 할 수 있다.

## 예: 남은 writer.json 처리 (Windows PowerShell)

`setup-doctor`가 `RECOVERY_REQUIRED: writer.json owner=... task=... round=...`를 보여 줄 때.

```powershell
$HF = "$env:USERPROFILE\.claude\skills\hyperfusion"
$REPO = "C:\workspace\대상저장소"

# 1) 상태와 lease 확인 (token은 writer.json에 있다)
node "$HF\scripts\fusion-state.mjs" status $REPO
Get-Content "$REPO\.fusion\locks\writer.json"

# 2) 일꾼·컨트롤러가 정말 끝났는지 확인. 남아 있으면 여기서 멈추고 원인부터 본다.
Get-Process grok, claude, agy -ErrorAction SilentlyContinue
git -C $REPO status --short   # 일꾼이 남긴 변경 확인

# 3) 입력 파일 작성 후 복구
$token = (Get-Content "$REPO\.fusion\locks\writer.json" | ConvertFrom-Json).token
@{ token = $token; quiescent = $true; reason = "프로세스 없음 확인, diff 검토함" } | ConvertTo-Json | Set-Content -Encoding utf8 "$env:TEMP\hf-recover.json"
node "$HF\scripts\fusion-state.mjs" recover $REPO "$env:TEMP\hf-recover.json"
```

- `status` 결과의 `schema_version`이 4가 아니면(main 브랜치나 이전 버전이 만든 작업) `recover` 대신 `archive`를 쓴다. 입력은 같고 명령만 `archive`다.
- `state.json`이 CLOSE/ARCHIVED인데 writer.json만 남았다면 init 직후나 begin 도중 컨트롤러가 죽은 경우다. 프로세스가 없음을 확인한 뒤 `archive`로 정리한다.
- writer.json을 손으로 지우지 않는다. 남은 변경을 되돌릴지 여부는 리드가 diff를 보고 정한다.

## 범위 밖에 남은 파일

복구는 일꾼이 남긴 변경을 자동으로 되돌리지 않는다. 그래서 라운드가 범위 밖 파일 때문에 실패한 뒤 그 파일이 남아 있으면, 컨트롤러는 그 파일을 기억해 두고 **다음 라운드에서도 계속 막는다**(`Earlier out-of-scope changes still present`). 아래 둘 중 하나를 해야 한다.

1. **되돌린다.** 리드가 diff를 보고 그 파일을 직접 되돌린 뒤 `recover`한다. 다음 라운드가 깨끗한 기준선에서 시작한다.
2. **알고 받아들인다.** `recover`에 `allow_out_of_scope: [{"path":"b.txt","reason":"사용자가 이 수정에 b.txt도 포함하라고 했다"}]`를 준다. 사유가 필수이고 기록(`scope_exceptions`)으로 남는다.

마지막 관문인 `verify`는 라운드 단위가 아니라 **최초 기준선과 비교해** 허용 범위(시작 brief와 모든 라운드 brief의 범위 + 예외) 밖에 남은 변경이 있으면 거절한다. 라운드 사이에 사용자가 다른 파일을 고친 경우도 여기서 걸린다. 그 변경이 의도된 것이면 `verify`에 같은 `allow_out_of_scope`를 줄 수 있다. 되돌리는 쪽이면 작업이 다시 한 라운드 필요하다.
