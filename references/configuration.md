# 설정

v0.3 신규 작업용 설정은 [hyperfusion.v03.config.example.json](../hyperfusion.v03.config.example.json), 실제 동작과 한계는 [universal-supervisor.md](universal-supervisor.md)를 따른다. classic 기본값은 하위 호환용이다. 새 정책을 사용하려면 명시적으로 선택한다.

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
- `executors.antigravity.sandbox:false`는 바깥 샌드박스 안에서 agy `--sandbox`가 시작되지 못할 때만 쓴다(`sandbox_apply: Operation not permitted`). 저장소 안의 설정 파일은 일꾼이나 복제한 저장소가 쓴 것일 수 있으므로, **운영자가 환경변수 `HF_ALLOW_UNSANDBOXED=1`을 직접 설정해야만** 받아들여진다(없으면 설정 오류). 허용해도 상담·리뷰는 항상 `--sandbox`로 실행한다. 끄면 구현 라운드의 agy 터미널 실행이 제한되지 않는다는 점을 사용자에게 알린다.
- `lead: sol|astra` 등 main 브랜치(Codex 리드) 설정은 거절한다. 조용히 변환하지 않는다.

| 역할 | 누구 | 예산 |
|---|---|---|
| 리드 | Claude Opus 5.5 (호스트) | 계획·검수 무제한, 코드 작성은 takeover 1회 |
| 일꾼 | Grok (`grok`) | 3라운드 |
| 일꾼 | Antigravity (`agy`) | 3라운드 |
| 일꾼 | Sonnet (`claude --model claude-sonnet-5-5`) | 3라운드 |
| auto | 배치표 + 실적 + 설치 상태로 선택 | — |

## 모델과 작업 상한

`executors.sonnet.model`은 실제 `--model` 인자로 전달한다. Grok·Antigravity의 model은 설치된 CLI가 정확한 `--model` 옵션을 광고할 때만 전달하고, 지원하지 않으면 preflight에서 거절한다. `lead_model`은 `claude-opus-*` 모델 ID를 받으며 기본값은 `claude-opus-5-5`다. 대상 모델 ID를 설정해도 호스트 모델 자체를 바꾸지는 않는다.

`routing.half_life_days`는 실적 반감기(기본 90일), `routing.explore_every`는 강등된 일꾼을 첫 후보로 다시 쓰는 주기(기본 10, 0이면 비활성)다. `limits`로 작업 단위 상한을 설정한다: `{"max_cost_usd": 1.5, "max_wall_ms": 900000}`. init brief의 `limits`가 같은 키를 덮어쓰고, 진행 중 작업의 상한은 고정된다. 비용의 미측정 값과 단일 라운드 초과 한계는 [operations.md](operations.md)를 참고한다.

## 리뷰 주체

`"review": {"by": "lead" | "delegate", "reviewers": ["sol","sonnet","antigravity","grok","luna","haiku"], "auto_apply": true}`. 기본은 `lead`(Opus가 직접 리뷰)다. `delegate`면 다른 모델이 읽기 전용으로 판정하고 그 판정이 적용된다. `strategy: "lead-gated-adaptive"`에서는 `auto_apply`가 판정을 VERIFY로 넘기지 않는다. Codex 팀원 설정은 `executors.sol` / `executors.luna`의 `model`과 `reasoning_effort`(minimal|low|medium|high|xhigh)로 한다. 기본 모델은 sol `gpt-6.1-sol`, luna `gpt-6-luna`이다. 실행 파일은 `HF_CODEX_BIN`. 자세한 건 [review-protocol.md](review-protocol.md).

## 기억 계층

`"memory": {"workspace": "<프로젝트별 이름>", "recall_limit": 8, "enabled": true}`. workspace가 없으면 꺼진다. 외부 서버 없이 `~/.hyperfusion/memory/<workspace>.json`에 저장한다(`HF_MEMORY_DIR`로 위치 변경). 자세한 건 [memory.md](memory.md).

## 알림

환경변수 `HF_NOTIFY_URL`을 설정하면 일꾼 라운드·상담이 끝날 때, 그리고 BLOCKED·TAKEOVER_REQUIRED·DECISION_REQUIRED가 될 때 그 URL로 POST 한다. [ntfy](https://ntfy.sh) 주소(예: `https://ntfy.sh/내-비밀-토픽`)를 쓰면 휴대폰 앱으로 바로 받는다. 본문은 작업 ID, 일꾼, 라운드, 상태 같은 고정 형식뿐이다. 일꾼이 쓴 요약이나 오류 문장, 코드, 출력은 보내지 않는다(외부 서비스에 남을 수 있다). 평문 `http://`는 localhost에서만 허용하고, 그 밖은 `https://`여야 한다(꼭 필요하면 `HF_NOTIFY_ALLOW_HTTP=1`). 대상 저장소 설정 파일로는 켤 수 없다(저장소 내용이 외부 전송을 결정하지 못하게). 토픽 이름은 추측하기 어렵게 정한다.

환경변수 `HF_GROK_BIN`, `HF_AGY_BIN`, `HF_CLAUDE_BIN`은 실행 파일 경로다(공백 포함 가능). 셸 명령이나 추가 인자가 아니다.

## 보안 관련 환경변수

| 변수 | 의미 |
|---|---|
| `HF_STATE_DIR` | 제어 폴더의 부모 위치(아래 참고) |
| `HF_ENV_PASS` | 일꾼 프로세스에 추가로 넘길 환경변수 이름(쉼표 구분). 기본은 실행에 필요한 변수와 그 일꾼 벤더의 인증값(`XAI_*`, `ANTHROPIC_*`, `GOOGLE_*`, `OPENAI_*` 등)만 넘어간다. `GITHUB_TOKEN`, `AWS_*`, DB 주소는 넘어가지 않는다 |
| `HF_BASH_POLICY=permissive` | `executor_bash_rules`의 "검증 명령 모양" 제한만 푼다. 셸 메타문자, 인터프리터, 네트워크 도구는 계속 거절 |
| `HF_ALLOW_UNSANDBOXED=1` | `executors.antigravity.sandbox:false`를 받아들인다 |
| `HF_NOTIFY_ALLOW_HTTP=1` | 로컬이 아닌 평문 http 알림 주소를 허용 |

## 제어 폴더 위치

상태·brief·스냅샷·lease·지표는 작업 폴더 밖 `~/.hyperfusion/state/<저장소 이름>-<경로 해시>/`에 저장된다(`HF_STATE_DIR`로 부모 폴더 변경). 일꾼의 편집 도구가 닿지 못해야 범위 검사가 의미가 있기 때문이다. 예전 버전이 만든 `<저장소>/.fusion/`은 `node fusion-state.mjs migrate REPO`로 옮긴다(해시 검증 후 원본 삭제). 옮기기 전에는 새 작업이 `LEGACY_CONTROL_DIR`로 거절된다. 위치는 `node control-dir.mjs path REPO`로 확인한다.

## 일꾼 능력과 모델

`executors.<이름>.caps`: 그 일꾼이 맡을 수 있는 작업 능력(`code`, `tests`, `refactor`, `ui`, `docs`, `image-gen`). 생략하면 기본값을 쓴다. `executors.<이름>.model`: 같은 CLI로 부를 모델. 새 모델은 이 두 줄로 붙인다([routing.md](routing.md#능력caps으로-거르기)). `routing.newcomer_every`(기본 4, 0이면 끔)는 실적 없는 일꾼에게 가끔 첫 기회를 주는 주기다.

Haiku(`haiku`)는 Sonnet과 같은 Claude Code CLI(`HF_CLAUDE_BIN`)를 `--model claude-haiku-5-5`로 부른다. 세션과 시도 예산은 Sonnet과 따로다.

`executors.<이름>.reasoning_effort`: 일꾼의 추론 강도. 일꾼 CLI마다 플래그와 받는 값이 다르다.

| 일꾼 | CLI 플래그 | 값 |
|---|---|---|
| Sonnet, Haiku (Claude Code) | `--effort` | `low`, `medium`, `high`, `xhigh`, `max` |
| Antigravity (agy) | `--effort` | `low`, `medium`, `high`, `xhigh`, `max` |
| Grok | `--reasoning-effort` | `low`, `medium`, `high`, `xhigh`, `max` (도움말에 값 목록이 없어 Claude와 같게 둠) |
| Luna, Sol (Codex) | `-c model_reasoning_effort=…` | `minimal`, `low`, `medium`, `high`, `xhigh` |

기본값은 Sonnet `high`, Haiku `max`, Antigravity `high`, Grok `xhigh`, Luna `xhigh`, Sol `medium`이다. 설정에 값을 적으면 덮어쓰고, `null`을 적으면 플래그를 넘기지 않고 CLI 기본값을 쓴다(예전 CLI에 effort 플래그가 없을 때). 목록 밖의 값은 `EFFORT_UNSUPPORTED` 설정 오류다. 설정했는데 설치된 CLI 도움말에 그 플래그가 없으면 조용히 무시하지 않고 `ADAPTER_UNAVAILABLE`로 거절한다. CLI가 받아들이는지는 `setup-doctor.mjs --smoke`로 확인한다.
