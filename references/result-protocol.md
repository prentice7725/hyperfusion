# 결과 계약

필드: task_id, round, status, summary, files_read, files_changed, commands_run, tests, unresolved, risks, needs_lead_decision, recommended_next_action. 경로는 저장소 상대 경로이고 files_changed는 이번 라운드 변경만이다. 테스트는 실제로 돌린 `{command, status}`만 넣는다.

status: complete, blocked, needs_decision, failed. complete에는 실패 테스트, 미해결 항목, 리드 결정 요청이 있을 수 없다. needs_decision은 needs_lead_decision=true가 필요하다.

리드는 일꾼과 자식 프로세스가 모두 끝난 뒤 `{token, quiescent:true, result}`로 finish 한다. 컨트롤러는 task_id/round, 선언된 변경 파일과 실제 스냅샷 차이, 범위, HEAD, index를 대조한다. 거짓 신고는 RECOVERY_REQUIRED이며 lease는 복구 때까지 유지된다. 테스트 통과는 컨트롤러가 증명하지 않으므로 리드의 독립 검증이 필수다.
