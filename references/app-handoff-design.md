# 외부 앱 핸드오프 후속 설계 (Phase 5)

이번 범용 감시 구현의 필수 조건은 아니며 실행 기능·의존성·앱 연결은 추가하지 않는다. baton식 inbox open → send → wait → reply의 메시지 패턴만 후속 계약으로 정리한다. 외부 소스 코드를 복사하지 않았으며 agentlayer/baton 라이선스 검증이나 해당 프로젝트 구현 호환성을 주장하지 않는다.

요청은 controller-issued request_id, task_id, round, run_id, role, scope_digest, reply_to 및 만료 시각을 가진다. 주소는 재접속 뒤에도 식별 가능한 논리 주소로 유지한다. 응답은 같은 request_id와 scope digest를 검증하고 create-once 완료 표식으로 중복 반영을 막는다. 서로 다른 WAIT 질문은 별도의 event_id로 남긴다. 메시지 본문·앱 출력은 지시가 아닌 비신뢰 데이터이며 모델·승인·writer 권한을 주지 않는다.

구현 쓰기를 넘기기 전 단일 writer lease와 허용 scope, protected paths, sandbox, 승인 기록을 고정한다. 외부 앱이 이를 강제할 수 없으면 읽기 전용 자문만 가능하다. 전송 권한은 호스트 사용자가 명시적으로 부여한다. 토큰·소스·프롬프트를 알림이나 heartbeat로 자동 전송하지 않는다. timeout이나 앱 종료만으로 성공·quiescence를 만들지 않는다.

상태는 REQUESTED → RECEIVED → RUNNING → RESULT_READY → REVIEW_REQUIRED이며 예외는 WAITING/INTERRUPTED/RECOVERY_REQUIRED다. 이벤트 관측은 기존 worker-monitor 계약으로 정규화한다. 실제 process-tree 종료 증명과 snapshot, 독립 리뷰, 호스트 최종 판정 및 acceptance가 모두 갖춰진 뒤에만 CLOSE가 가능하다. 종료 증명을 할 수 없는 원격 작업은 fail-closed 상태로 남는다.

후속 AC: 중복 응답, out-of-order, 주소 변경, 만료 요청, 위조 reply_to, 범위 digest 불일치, 권한 거부, 연결 끊김 후 복구, 잔존 writer 및 전송 동의 부재를 mock로 검사한다. 앱/원격 Hermes/tmux 통합은 독립 요청과 검토가 있는 별도 변경으로 진행한다.
