# 실패 처리

없는 어댑터, 깨진 Git 저장소, 스키마 오류, 범위 밖 수정, HEAD/index 변경, 중단된 변경, 트리 drift는 명시적 실패다. 성공으로 바꾸지 않는다. 결과를 반환해 쓰기 권한이 끝난 일꾼에게 명령을 더 보내지 않는다.

begin 전의 brief/프로브 오류는 시도를 소모하지 않는다. lease 발급 후의 dispatch 오류는 시도를 소모한다. 검증 실패는 원본 결과와 스냅샷을 보존하고, 리드가 확인 후 recover 한다. control.lock은 동시 컨트롤러 명령을 막는다.

브리지 오류는 writer와 라운드별 실행 증거를 보존한다. 같은 라운드에서 브리지를 다시 실행하지 않는다. 거절된 명령을 다른 일꾼이나 권한 우회 플래그(`--yolo`, `--dangerously-skip-permissions`)로 다시 시도하지 않는다.

## 사용량·요금 한도 (`PROVIDER_LIMIT`)

일꾼이나 리뷰어의 실행이 실패하면 브리지는 두 곳에서 한도 문구를 찾는다.
- **어디서 찾는가**
  - 그 실행의 stderr 끝부분.
  - CLI가 낸 오류 메시지. Codex는 `error`·`turn.failed` 이벤트, Claude는 `is_error` 결과, Grok은 오류 envelope다.
- **어떤 문구인가:** "usage limit", "rate limit reached/exceeded", "insufficient_quota", "exceeded your current quota", "RESOURCE_EXHAUSTED", "Too Many Requests", "credit balance is too low" 같은 것이다.
- **찾지 않는 곳:** 성공한 실행이나, 일꾼이 작업하며 쓴 메시지는 보지 않는다. 한도를 다루는 작업이라 그 단어를 썼다고 일꾼을 빼면 안 된다.

한도 문구를 찾으면:
- 오류 문구 앞에 `PROVIDER_LIMIT: <일꾼> hit a usage or rate limit`이 붙는다.
- 작업 폴더에 기록이 남는다. 구현 라운드는 `limit-failure-N.json`, 리뷰·상담은 `limit-failure-consult-<id>-<member>.json`이다.
- 같은 CLI의 일꾼과 리뷰어는 이 작업이 끝날 때까지 쓰지 않는다. 예를 들어 Codex가 한도에 걸리면 Terra, Luna, Sol이 모두 빠진다.
  - **구현:** `begin`의 자동 선택과 라우팅이 그 CLI를 건너뛴다. 복구하면 `ALTERNATIVE_REQUIRED`로 간다. 리드 게이트는 REDO를 권하지 않고, `lead-decision`도 REDO를 거절한다.
  - **위임 리뷰:** 기본 리뷰어 순서에서 건너뛴다. 다음 라운드에도 처음부터 다른 리뷰어를 부른다. 리드가 그 리뷰어를 직접 지정하면 거절한다.
  - 자동 복구는 전처럼 한도 실패를 재시도하지 않는다(`NON_RETRYABLE`).

한도는 보통 몇 시간 단위로 풀리고, 그사이 재시도는 같은 실패만 되풀이한다. 그래서 같은 작업 안에서는 되살리지 않는다. 새 작업은 기록 없이 시작한다. 샌드박스 실패(`sandbox-failure-N.json`)도 같은 방식으로 CLI를 빼지만, 리뷰어는 빼지 않는다.

결과 없이 끝난 라운드(시간 초과, 결과 파일 없는 비정상 종료)는 복구할 때 결과 실패로 센다. 같은 일꾼이 연속 두 번 그러면 복구 뒤 단계가 REDO가 아니라 `ALTERNATIVE_REQUIRED`다. REDO 단계에서는 일꾼을 바꿀 수 없으므로, 세지 않으면 같은 일꾼의 시간 초과가 라운드 예산이 바닥날 때까지 이어진다. 복구는 그 일꾼의 세션도 버린다. 다음 라운드는 새 세션으로 시작한다. 시간 초과로 죽인 Grok 세션을 이어받으면 Grok이 세션을 여는 단계(`session_create`)에서 멈추기 때문이다.

자동 reset --hard, clean, stash, checkout, commit, push, 삭제는 없다. brief나 감사 산출물에 인증정보나 전체 대화 기록을 넣지 않는다. 일꾼이 없다고 리드가 조용히 구현하지 않는다. takeover는 기록된 이유와 lease가 있어야 하며 실패하면 BLOCKED다.
