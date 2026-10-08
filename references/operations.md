# 운영 명령과 작업 상한

## 입력·상태·타임라인

컨트롤러·프로젝트·기억 쓰기 명령·router·metrics의 JSON 입력은 파일이나 stdin(`-`)으로 받는다. PowerShell 예:

```powershell
@{ token = $token; quiescent = $true } | ConvertTo-Json | node scripts/fusion-state.mjs finish $REPO -
node scripts/fusion-state.mjs status $REPO --summary
node scripts/fusion-state.mjs report $REPO
@{ task_id = 'previous-task' } | ConvertTo-Json | node scripts/fusion-state.mjs report $REPO -
node scripts/metrics.mjs --aggregate $REPO
```

`report`는 JSON으로 라운드별 담당·결과·판정·반려 기준·실행 시간·보고 비용을 반환한다. 이전 산출물에 시간·비용이 없으면 null이다. 전체 stdout/stderr는 포함하지 않는다. `--aggregate`는 저장소 경로 하나 또는 기존 지표 파일 목록을 받는다. worktree 지표는 해당 worktree 경로로 집계한다.

CLI 실패의 stderr는 `{code, message, next_action}` JSON이다. doctor는 체크 결과의 `error`에 같은 구조를 넣고, CLI 버전·도움말·누락 옵션은 제어 폴더의 `doctor/probes-*.json`에 보관한다. 출력의 `probe_file`로 찾는다. 도움말은 dispatch나 리드의 일반 상태 출력에 포함하지 않는다.

짧은 메타데이터 잠금은 pid·호스트·시각·토큰을 기록하고 최대 500ms 동안 재시도한다. 같은 호스트의 죽은 pid를 확인할 때만 치운다. 다른 호스트·살아 있는 프로세스·소유자 불명인 잠금은 자동으로 치우지 않는다. writer lease는 재시도·TTL 회수 대상이 아니다.

## 리드 가드 훅

"lease가 걸린 동안 리드는 트리를 수정하지 않는다"와 "일꾼 예산이 남으면 리드는 코드를 쓰지 않는다"를 Claude Code의 PreToolUse 훅으로 강제한다. `npm run guard:settings`가 이 PC의 절대 경로로 된 훅 설정을 출력하고, 그 `hooks` 항목을 `~/.claude/settings.json`(또는 대상 저장소의 `.claude/settings.json`)에 합친다.

훅은 `Edit`, `Write`, `MultiEdit`, `NotebookEdit`의 대상 파일이 속한 Git 저장소의 제어 폴더를 읽는다.

| 상태 | 판정 |
|---|---|
| 상태 없음, 또는 CLOSE·BLOCKED·ARCHIVED | 허용 |
| 일꾼이 writer lease를 잡고 있음 | 차단 |
| lease 없이 진행 중인 단계(PLAN, REVIEW, VERIFY, TAKEOVER_REQUIRED 등) | 차단, 다음 동작 안내 |
| takeover로 리드가 lease를 받음 | 허용 |
| 상태 파일을 읽을 수 없음 | 차단 |

Git 저장소 밖의 파일(스크래치 패드의 입력 JSON 등)은 막지 않는다. 일꾼 Sonnet은 `--safe-mode`로 떠서 사용자 훅이 꺼지므로 이 훅에 막히지 않는다. Bash·PowerShell을 통한 쓰기는 검사하지 않는다. 그 경로는 기존 보호 파일 스냅샷과 라운드 diff 검사가 잡는다.

## 수용 테스트 자동 실행

brief에 `acceptance_commands`를 넣으면 컨트롤러가 명령을 직접 실행한다.

| 시점 | 동작 |
|---|---|
| finish 직후(결과가 complete일 때) | 실행 후 `acceptance-N-finish.json`에 종료 코드, 소요 시간, 출력 SHA-256과 끝부분 4KB를 남긴다. 실패하면 리뷰 없이 실패 출력을 붙여 같은 일꾼에게 REDO로 돌린다(같은 실패 반복 시 일반 반려처럼 교체). 리드 takeover 라운드는 기록만 하고 리드가 판정한다 |
| VERIFY | finish 실행이 통과했고 트리와 무시된 파일이 그대로면 그 결과를 재사용한다. 아니면 다시 실행한다. 실패하면 REDO로 돌린다 |

`status --summary`에 마지막 실행 결과가 나온다. 컨트롤러가 되돌린 라운드는 리뷰 기록의 `reviewed_by`가 `controller`이고 지표에는 `acceptance_returns`로 센다.

테스트 실행은 저장소 코드 실행이다. 그래서 다음을 지킨다.

- 명령은 리드가 쓴 brief에서만 받는다. 저장소의 `hyperfusion.config.json`은 일꾼이 고칠 수 있으므로 명령 출처가 아니다.
- 일꾼과 같은 걸러진 환경변수로 실행한다. 리드의 비밀값은 넘어가지 않는다. `CI=1`, `PYTHONDONTWRITEBYTECODE=1`을 붙인다.
- 스냅샷이 보지 않는 무시된 파일(`node_modules/dep/index.js`, `dist/` 등)은 라운드 시작 때 목록과 메타데이터(크기, 수정·변경 시각, 모드, inode)를 남기고 실행 직전에 비교한다. 바뀐 것이 있으면 실행하지 않고 `skipped`로 리드에게 보인다. 리드가 확인한 뒤 `verify`에 `acceptance_trust_ignored:true`를 주면 실행한다. 무시된 파일이 20만 개를 넘으면 비교할 수 없어 같은 방식으로 건너뛴다.
- 실행되지 않는 테스트 산출물(`coverage/`, `.nyc_output/`, `.pytest_cache/`, `test-results/`, `node_modules/.cache/`, `*.log`, `.coverage`)은 비교에서 뺀다. 빌드 산출물처럼 실행되는 것은 기본으로 빼지 않는다. 일꾼의 빌드가 `dist/`를 다시 만드는 작업이면 brief의 `acceptance_artifacts`에 알고 적는다.
- 명령이 추적 파일이나 무시되지 않은 새 파일을 만들면 RECOVERY_REQUIRED가 된다. 테스트 출력은 `.gitignore`에 넣는다.

변경 시각 비교는 수정 시각만 되돌린 위장은 잡지만 내용 해시는 아니다. 일꾼 CLI가 저장소 안 무시된 위치에 자기 파일을 쓰면 매번 건너뛰게 되므로 그 경로를 `acceptance_artifacts`에 적는다.

## 비용·시간 상한

설정의 `limits` 또는 init brief의 `limits`:

```json
{"limits": {"max_cost_usd": 1.5, "max_wall_ms": 900000}}
```

init 시각부터 전체 경과 시간을 세고, 구현·상담·리뷰의 보고된 비용을 합산한다. 상한에 도달하면 다음 begin은 BLOCKED로 정산되고 새 일꾼을 시작하지 않는다. 브리지도 실행 직전 검사하고, 일꾼 timeout을 남은 시간으로 줄인다. 중단된 실행의 lease는 자동으로 해제하지 않고 기존 복구 절차를 따른다. 이미 나온 결과는 finish·review·verify로 검수할 수 있다.

비용은 청구액이 아니라 CLI 보고액이다. Antigravity와 보고되지 않은 비용을 0으로 추정하지 않으며 `budget.cost_complete:false`로 표시한다. 보고된 비용만으로 상한에 도달해도 다음 호출은 막는다. 실행 중의 비용은 실시간으로 알 수 없어 한 라운드가 비용 상한을 넘길 수 있다. 시간 제한은 컨트롤러 호출과 감독 중인 프로세스에 적용되며 리드의 대화 자체를 종료하지 않는다.

## 독립 worktree 병렬 작업

```sh
node scripts/worktree.mjs create REPO task-A
node scripts/worktree.mjs create REPO task-B
node scripts/worktree.mjs list REPO
```

반환된 각 `workspace`에서 init부터 검수까지 실행한다. 각 worktree의 상태·스냅샷·writer lease는 별도 제어 디렉터리에 저장되어 병렬 실행할 수 있다. 시작점은 원본 저장소의 HEAD이며 미커밋 소스 변경은 복사하지 않는다. 로컬 `hyperfusion.config.json`만 정책 보존을 위해 복사한다.

원본 프로젝트의 승인·마일스톤을 worktree 사이에서 자동 정산하지 않는다. 각 worktree는 독립 작업이고 사용자가 승인한 계획에 따라 리드가 조정한다. 기억 워크스페이스를 공유하려면 기존 `memory.mjs bind` 절차를 거친다. worktree 경쟁의 승자 선택, 자동 merge, 자동 commit은 구현하지 않는다. 실제 변경을 원본에 반영하기 전에 결과를 각각 검수한다.

종료 후 `remove REPO TASK_ID INPUT.json|-`에 `{"quiescent":true}`를 넘긴다. 남은 writer, 상담, 미완료 상태 또는 Git 변경·미추적 파일이 있으면 삭제하지 않는다. 강제 삭제 없이 변경을 보존한다. 작업 제어 기록은 삭제하지 않는다.

## 실제 CLI 스모크

```powershell
$env:HF_LIVE = '1'
$env:HF_LIVE_EXECUTOR = 'sonnet'
npm run test:live
```

임시 저장소에서 파일 하나를 실제 모델로 고치고 finish·review·verify까지 확인한다. HF_LIVE가 1일 때만 실행하며 기본 테스트와 CI에서는 건너뛴다. 지정한 CLI의 설치·인증과 모델 호출 비용이 필요하다. HF_LIVE_EXECUTOR는 grok·antigravity·sonnet·luna 중 하나다.
