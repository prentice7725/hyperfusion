# 설정

대상 저장소 루트의 `hyperfusion.config.json`(선택)을 읽는다. 없으면 다음을 쓴다.
```json
{
  "lead": "opus",
  "lead_model": "claude-opus-5-5",
  "lead_takeover": true,
  "external": {"default": "auto", "available": ["grok", "antigravity", "sonnet"]},
  "executors": {"antigravity": {"sandbox": true}},
  "routing": {"rules": "기본 배치표(routing.md)", "learn": true, "min_samples": 3, "demote_below": 0.4}
}
```

- `default: "auto"`면 작업마다 router가 일꾼을 고른다([routing.md](routing.md)). 호출 시 `--executor`가 그 작업의 선택을 덮어쓴다. 설정은 init 때 상태에 고정되며 진행 중 작업에는 영향이 없다.
- `available`은 사용자가 고용한 일꾼 명단이다. 한 명만 넣으면 교체 없이 그 일꾼을 예산 끝까지 돌린다.
- `lead_takeover:false`면 모든 일꾼이 모두 소진됐을 때 리드가 코드를 쓰지 않고 BLOCKED로 끝난다.
- `executors.<이름>.timeout_ms`: 일꾼 한 라운드의 상한(기본 1,200,000 = 20분). Windows에서 agy가 멈추는 문제가 있으면 짧게 잡는다.
- `executors.antigravity.sandbox:false`는 바깥 샌드박스 안에서 agy `--sandbox`가 시작되지 못할 때만 쓴다(`sandbox_apply: Operation not permitted`). 끄면 agy 터미널 실행은 제한되지 않는다는 점을 사용자에게 알린다.
- `lead: sol|astra` 등 main 브랜치(Codex 리드) 설정은 거절한다. 조용히 변환하지 않는다.

| 역할 | 누구 | 예산 |
|---|---|---|
| 리드 | Claude Opus 5.5 (호스트) | 계획·검수 무제한, 코드 작성은 takeover 1회 |
| 일꾼 | Grok (`grok`) | 3라운드 |
| 일꾼 | Antigravity (`agy`) | 3라운드 |
| 일꾼 | Sonnet (`claude --model claude-sonnet-5-5`) | 3라운드 |
| auto | 배치표 + 실적 + 설치 상태로 선택 | — |

## 알림

환경변수 `HF_NOTIFY_URL`을 설정하면 일꾼 라운드·상담이 끝날 때, 그리고 BLOCKED·TAKEOVER_REQUIRED·DECISION_REQUIRED가 될 때 그 URL로 POST 한다. [ntfy](https://ntfy.sh) 주소(예: `https://ntfy.sh/내-비밀-토픽`)를 쓰면 휴대폰 앱으로 바로 받는다. 본문은 작업 ID, 일꾼, 상태, 요약 한 줄뿐이며 코드나 출력은 보내지 않는다. 대상 저장소 설정 파일로는 켤 수 없다(저장소 내용이 외부 전송을 결정하지 못하게). 토픽 이름은 추측하기 어렵게 정한다.

환경변수 `HF_GROK_BIN`, `HF_AGY_BIN`, `HF_CLAUDE_BIN`은 실행 파일 경로다(공백 포함 가능). 셸 명령이나 추가 인자가 아니다.
