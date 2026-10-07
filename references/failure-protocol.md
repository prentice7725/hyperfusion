# 실패 처리

없는 어댑터, 깨진 Git 저장소, 스키마 오류, 범위 밖 수정, HEAD/index 변경, 중단된 변경, 트리 drift는 명시적 실패다. 성공으로 바꾸지 않는다. 결과를 반환해 쓰기 권한이 끝난 일꾼에게 명령을 더 보내지 않는다.

begin 전의 brief/프로브 오류는 시도를 소모하지 않는다. lease 발급 후의 dispatch 오류는 시도를 소모한다. 검증 실패는 원본 결과와 스냅샷을 보존하고, 리드가 확인 후 recover 한다. control.lock은 동시 컨트롤러 명령을 막는다.

브리지 오류는 writer와 라운드별 실행 증거를 보존한다. 같은 라운드에서 브리지를 다시 실행하지 않는다. 거절된 명령을 다른 일꾼이나 권한 우회 플래그(`--yolo`, `--dangerously-skip-permissions`)로 다시 시도하지 않는다.

자동 reset --hard, clean, stash, checkout, commit, push, 삭제는 없다. brief나 감사 산출물에 인증정보나 전체 대화 기록을 넣지 않는다. 일꾼이 없다고 리드가 조용히 구현하지 않는다. takeover는 기록된 이유와 lease가 있어야 하며 실패하면 BLOCKED다.
