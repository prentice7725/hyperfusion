# 위임 계약 (brief)

리드가 모든 설계 결정을 소유한다. 정확한 상대 경로(glob 금지), 최소한의 관련 맥락, 라운드 간 바뀌지 않는 기준 ID를 쓴다.

```json
{
  "task_id": "HF-20261003-001",
  "objective": "중복 refresh 요청 제거. 리드가 auth refresh 흐름 확인함.",
  "scope": {"paths": ["src/auth", "tests/auth"], "allowed_expansion": "ask-lead"},
  "constraints": ["공개 API와 기존 미커밋 변경 보존"],
  "success_criteria": ["AC1: 동시 호출자가 refresh 하나를 공유", "AC2: 실패 시 in-flight 상태 초기화"],
  "allowed_actions": ["read", "edit", "test", "lint", "build"],
  "forbidden_actions": ["commit", "push", "deploy", "release", "scope-expansion"],
  "evidence_required": ["files_changed", "commands_run", "test_results", "remaining_risks"],
  "executor_bash_rules": ["Bash(npm test*)"],
  "task_kind": "code",
  "difficulty": "medium"
}
```

`prior_experience`(선택, 최대 12개 `{type, content, id?, assertion?}`)는 리드가 AnchorMind에서 찾아 SOT·Git과 대조한 과거 기억이다. 일꾼에게는 brief·저장소·lead_feedback보다 우선순위가 낮다고 명시해 전달된다. 기각된 기억과 비밀값은 넣을 수 없다([memory.md](memory.md)).

`task_kind`/`difficulty`는 배치 힌트다([routing.md](routing.md)). 종류가 섞인 작업은 쪼갠다.

## 재지시 명령서 (`lead_feedback`)

PLAN 이후의 모든 일꾼 begin(REDO, ALTERNATIVE_REQUIRED)에는 비어 있지 않은 `lead_feedback` 문자열 배열이 필수다. 직전 반려의 `blocking_criteria`를 실행 가능한 명령으로 바꿔 쓴다.

```json
{"lead_feedback": [
  "AC2 미충족: src/auth/refresh.ts의 catch 블록에서 inFlight를 null로 되돌려라",
  "tests/auth/refresh.test.ts에 거절 후 재시도 케이스를 추가하고 통과시켜라",
  "공개 함수 시그니처를 바꾸지 마라. 지난 라운드에서 바꾼 것을 되돌려라"
]}
```

나쁜 예: `["다시 해봐"]`, `["테스트 고쳐"]`. 무엇을, 어디서, 어떤 기준으로가 없으면 명령이 아니다.

직전 리뷰를 그대로 넘기려면 `"lead_feedback": "@review"`를 쓴다. blocker·major 지적은 `{file, line, comment}`로, 반려 사유는 `Unmet: …`로 펼쳐진다. 위임 리뷰와 함께 쓰면 리드가 diff를 다시 읽지 않아도 된다.

위치를 정확히 짚을 때는 문자열 대신 `{file, line?, comment}`를 쓴다(Orca의 diff 주석 방식). 상담 결과의 findings를 그대로 옮기기 좋다.

```json
{"lead_feedback": [
  {"file": "src/auth/refresh.ts", "line": 42, "comment": "거절 시 inFlight를 null로 되돌려라"},
  "공개 함수 시그니처를 바꾸지 마라"
]}
```

## 교체 시

다른 일꾼에게는 현재 트리 상태, 이전 일꾼이 바꾼 것, 남은 반려 사유, 리드의 결정을 brief로 준다. 이전 일꾼의 대화 기록은 넘기지 않는다. 범위의 경로는 하위 항목을 포함한다. 생성 산출물이 테스트에 필요하면 범위에 넣는다. submodule은 거절한다.
