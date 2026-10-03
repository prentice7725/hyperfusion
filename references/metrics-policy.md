# 지표: 성공 작업당 Opus 리드 토큰

주 지표: `sum(리드 토큰, 실패 작업 포함) / 성공 작업 수`. 리드가 덜 일할수록 좋다. 일꾼 토큰을 줄이는 것은 목표가 아니다. 일꾼이 많이 읽고 많이 테스트해서 리드 토큰이 줄면 그게 맞는 방향이다. 다만 일꾼 비용과 소요 시간은 가드레일로 계속 기록한다.

`metrics.mjs REPO [TASK_USAGE.json]`:
```json
{"source":"host task-usage export", "lead_tokens":1234}
```
계획, 검수, 재지시, 실패, takeover를 모두 포함한 실측값만 넣는다. 추정치 금지. 없으면 null.

기록 항목: 작업 종류·난이도, 배치 방식(auto/explicit)과 처음 배치된 일꾼, 일꾼별 판정 결과(`review_outcomes`, router 학습에 사용), 일꾼별 라운드 수, 일꾼 보고 사용량, 일꾼 비용 추정(Grok·Sonnet만 보고, Antigravity는 null이므로 섞이면 합계도 null), 검수 라운드, 교체 횟수, takeover 여부, 소요 시간.

`metrics.mjs --aggregate M1.json M2.json ...`로 코호트 비율과 takeover 비율을 낸다. 성공이 없거나 사용량 커버리지가 불완전하면 null이다. 비교 기준은 Opus 단독 수행이며 성공률, 회귀, 사람 개입, 시간, 일꾼 비용을 함께 본다. 8~12개 작업은 파일럿 신호일 뿐 통계적 증명이 아니다.

**작업이 끝나면(CLOSE, BLOCKED 모두) 반드시 `metrics.mjs`를 실행한다.** router가 이 기록으로 일꾼 실적을 배운다.
