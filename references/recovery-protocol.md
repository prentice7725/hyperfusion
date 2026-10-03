# 복구

1. 상태, lock, 최신 brief, 결과, 라운드별 스냅샷, 실제 diff/status를 본다. 오래된 타임스탬프는 writer가 멈췄다는 증거가 아니다.
2. `launch-N.json`, `process-N.json`, `envelope-N.json`으로 브리지와 일꾼 프로세스(POSIX는 프로세스 그룹, Windows는 프로세스 트리)가 모두 끝났는지 확인한다. Windows에서는 `process-N.json`의 pid를 부모로 가진 프로세스가 남았는지 직접 본다. 빠져나간 자손도 확인한다. 정지를 확인할 수 없으면 lock을 유지하고 BLOCKED로 보고한다.
3. 컨트롤러가 죽어 control.lock이 남았으면, 실행 중인 컨트롤러가 없음을 확인하고 기록한 뒤 그 파일만 지운다. writer.json을 지워 lease를 훔치지 않는다. `recover`에 token, `quiescent:true`, 근거 있는 reason을 넘긴다. 스냅샷 후 lease를 놓고 남은 예산 안에서 라우팅한다.
4. launch 표식을 재실행하거나, 카운터를 초기화하거나, 저장된 세션을 새 세션으로 바꾸지 않는다. 같은 작업을 archive/re-init 해서 예산을 리셋하지 않는다.
5. 소스의 자동 되돌리기는 없다. 사용자 변경을 보존한다. 다른 스키마(main 브랜치 포함)의 상태는 status로 읽고, 프로세스 정지를 확인한 뒤 reason과 함께 archive만 할 수 있다.
