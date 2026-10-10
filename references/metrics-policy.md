# 지표 정책 — classic 및 v0.3

v0.3의 주 지표는 `sum(전체 Claude 토큰, 실패 작업 포함) / 성공 작업 수`다. Opus·Sonnet·Haiku를 따로 기록하고 implementation/review/consult를 모두 포함한다. classic의 `lead_tokens_per_success`는 호환 필드로 유지한다. 성공률, 회귀, 사람 개입, 소요 시간, 외부 실행기 비용도 함께 비교한다.

호스트가 관측한 작업 전체 사용량은 `metrics.mjs REPO TASK_USAGE.json`으로 전달한다.

```json
{"source":"host task-usage export", "lead_tokens":1234, "lead_model":"claude-opus-5-5"}
```

계획·검수·재지시·실패·takeover를 포함한 실측값만 넣는다. 실제 관측 모델이 없으면 Opus로 귀속하지 않는다. 설정의 목표 모델명은 실행 증거가 아니다. 자동 재집계는 이미 기록한 호스트 관측을 보존하며, 라운드별 `decision_usage`를 호스트 작업 합계에 이중 합산하지 않는다.

실행기 사용량은 tag별 한 호출로 합친다. vendor `modelUsage`가 있으면 실제 모델별 집계에 우선 사용하고, 없으면 해당 호출의 모델을 사용한다. 토큰은 보고된 total 또는 완전한 input/output/cache 합계다. 실패 launch와 미측정 호출을 0으로 만들지 않는다. 관련 모델이나 사용량이 불명확하면 합계는 null이다. 비용은 클라이언트 보고이며 실제 청구액이나 가격 추정이 아니다.

기록 항목에는 작업 종류·난이도, 변경 줄 수, 배치 근거, 구현 라운드(Sol 포함), 리뷰·상담 호출, 재시도, 필수 리뷰 격차, 모델·실행기별 사용량과 비용, 호출별 소요 시간이 포함된다. `diff_lines`는 시작 snapshot/commit 대비 근사치이고, 기존 변경이 섞일 수 있다. `worker_usage`는 기존 구현 산출물 필드이며 전체 호출은 `run_usage`로 확인한다.

`metrics.mjs --aggregate M1.json M2.json ...` 또는 metrics 폴더로 코호트를 집계한다. 실패 작업도 비용 분자에 넣는다. 성공이 없거나 사용량 커버리지가 불완전하면 성공당 지표는 null이다. 난이도별 집계와 변경 줄 수 중앙값도 기록한다. 작은 파일럿 결과를 통계적 증명으로 해석하지 않는다.

작업이 CLOSE 또는 BLOCKED로 끝나면 `metrics.mjs`를 실행한다. router는 이 기록으로 실행기 실적을 학습한다. 상세 필드와 미검증 항목은 [범용 Supervisor 운영 문서](universal-supervisor.md#사용량-측정)를 따른다.
