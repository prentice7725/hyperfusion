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

`review.risk_paths`는 바뀌면 리드가 직접 확인해야 하는 경로 글롭이다. 기본은 `["**/auth/**","**/migrations/**","**/*.sql","**/security/**",".github/workflows/**"]`, `[]`이면 끈다. 라운드의 변경 파일이 하나라도 맞으면 classic에서는 위임 리뷰의 pass를 `auto_apply`여도 바로 적용하지 않고, adaptive에서는 그 라운드를 [중요 작업의 독립 페어](review-pairs.md)로 리뷰하며 APPROVE에 리드의 직접 리뷰(`diff_reviewed`, `tests_checked`, `changed_scope`)를 요구한다. 설정은 init 때 고정되며 기록된 작업 등급(`assignment.json`)은 바꾸지 않는다.

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
| `HF_AGY_ALLOW_UNLISTED_MODEL=1` | `executors.antigravity.model`이 `agy models` 목록에 없어도 실행한다(agy가 조용히 기본 모델로 돌 수 있다). 목록이 늦게 갱신되는 새 모델을 쓸 때만 켠다 |
| `HF_CODEX_HOME` | `quota-policy.mjs collect-codex`가 Codex 세션 기록을 찾을 위치(기본 `CODEX_HOME`, 없으면 `~/.codex`) |
| `HF_NOTIFY_ALLOW_HTTP=1` | 로컬이 아닌 평문 http 알림 주소를 허용 |
| `HF_ACCEPTANCE_IGNORED_ALLOW` | 수용 테스트의 "무시된 파일이 바뀌었는지" 비교에서 뺄 디렉터리 하위 glob(쉼표 구분, 최대 8개). 예: `dist/**,node_modules/.vite/vitest/**`. 저장소의 설정 파일로는 켤 수 없고 환경변수만 받는다(일꾼이 고칠 수 있는 파일이 자기 감시를 풀면 안 된다). `/**`로 끝나고 디렉터리 이름에 와일드카드가 없어야 하며, `node_modules` 전체나 의존성 폴더(`node_modules/dep/**`)는 거절한다. `node_modules/` 아래는 `.`으로 시작하는 캐시 폴더만 된다. 이 저장소에서만 켜려면 그 저장소의 세션 환경에만 넣는다 |

## 제어 폴더 위치

상태·brief·스냅샷·lease·지표는 작업 폴더 밖 `~/.hyperfusion/state/<저장소 이름>-<경로 해시>/`에 저장된다(`HF_STATE_DIR`로 부모 폴더 변경). 일꾼의 편집 도구가 닿지 못해야 범위 검사가 의미가 있기 때문이다. 예전 버전이 만든 `<저장소>/.fusion/`은 `node fusion-state.mjs migrate REPO`로 옮긴다(해시 검증 후 원본 삭제). 옮기기 전에는 새 작업이 `LEGACY_CONTROL_DIR`로 거절된다. 위치는 `node control-dir.mjs path REPO`로 확인한다.

## 일꾼 능력과 모델

`executors.<이름>.caps`: 그 일꾼이 맡을 수 있는 작업 능력(`code`, `tests`, `refactor`, `ui`, `docs`, `image-gen`). 생략하면 기본값을 쓴다. `executors.<이름>.model`: 같은 CLI로 부를 모델. 기존 CLI의 새 모델은 이 두 줄로 지정하지만 새 CLI에는 검증된 어댑터가 필요하다([routing.md](routing.md#능력caps으로-거르기)). `routing.newcomer_every`(기본 4, 0이면 끔)는 실적 없는 일꾼에게 가끔 첫 기회를 주는 주기다.

## 공통 벤더 허용 정책 (0.22.0)

`allowed_vendors:["anthropic","openai"]`는 구현·리뷰·상담 후보를 함께 제한한다. 생략하면 기존 풀을 유지하며 빈 배열은 모든 일꾼을 차단한다. 이름은 `anthropic`, `openai`, `xai`, `google`만 받고 중복·오타는 거절한다. 빈 `HF_ALLOWED_VENDORS`나 빈 목록 항목은 설정 오류다. 전체 차단은 저장소의 `allowed_vendors:[]`로 명시한다. 운영자 환경변수 `HF_ALLOWED_VENDORS=anthropic,openai`와 교집합으로 적용하므로 저장소에서 상한을 넓힐 수 없다. 자동 배치·명시 지정·실행 직전 bridge에서 재검사하고, 미허용 팀원은 팀 초안에서 제외한다.

CLI registry의 기본 벤더 기준이며 임의 model override의 실 제공자, CLI 내부 MCP·프록시·추가 네트워크 요청 또는 이미 실행 중인 호스트 리드는 검증하거나 차단하지 않는다. 방화벽·DLP 대신이 아니다. 업무상 외부 전송을 완전히 막아야 하면 별도의 운영자 네트워크·CLI 정책도 필요하다.

## Codex 캐시·네트워크와 턴 상한

`HF_CODEX_WRITABLE_ROOTS`는 이미 있는 절대 디렉터리의 JSON 배열, `HF_CODEX_NETWORK_ACCESS`는 `0` 또는 `1`이다. `HF_CODEX_WINDOWS_SANDBOX`(`elevated` 또는 `unelevated`)는 Windows에서 Codex 샌드박스 방식을 고르며 구현·리뷰·상담 모두에 적용된다([Codex 운영 안내](codex-runtime.md)의 Windows sandbox). 구현에만 적용하며 읽기 전용 리뷰·상담에는 전달하지 않는다. 저장소의 동명 실행기 옵션은 권한을 넓히지 못한다. 홈 전체, 상태·CLI 설정·스킬·Git 메타데이터와 겹치는 경로(부모·자식·링크 포함)는 거절한다. 캐시는 스냅샷 검증 밖이므로 소스나 인증 폴더를 허용하지 말 것. [Codex 운영 안내](codex-runtime.md)를 따른다.

Claude/Grok만 `executors.<이름>.max_turns` 및 `max_turns_by_difficulty:{low:20,medium:40,high:80}`를 받는다(1~1000, 명시 상한 우선). 생략 시 40이며 supervisor 시간·라운드 예산은 바뀌지 않는다. Codex/AGY에 이 옵션을 주면 지원하지 않는 계약으로 거절한다.

Haiku(`haiku`)는 Sonnet과 같은 Claude Code CLI(`HF_CLAUDE_BIN`)를 `--model claude-haiku-5-5`로 부른다. 세션과 시도 예산은 Sonnet과 따로다.

`executors.<이름>.reasoning_effort`: 일꾼의 추론 강도. 일꾼 CLI마다 플래그와 받는 값이 다르다.

| 일꾼 | CLI 플래그 | 값 |
|---|---|---|
| Sonnet, Haiku (Claude Code) | `--effort` | `low`, `medium`, `high`, `xhigh`, `max` |
| Antigravity Gemini (agy) | effort를 포함한 `--model` 슬러그(모델이 없으면 보내지 않음) 또는 custom/Claude 모델의 `--effort` | `low`, `medium`, `high` |
| Grok | `--reasoning-effort` | `low`, `medium`, `high`, `xhigh`, `max` (도움말에 값 목록이 없어 Claude와 같게 둠) |
| Luna, Sol (Codex) | `-c model_reasoning_effort=…` | `minimal`, `low`, `medium`, `high`, `xhigh` |

기본값은 Sonnet `high`, Haiku `max`, Antigravity `high`, Grok `medium`, Luna `xhigh`, Sol `medium`이다. Grok 구현과 일반 리뷰·상담은 모든 난이도(누락 포함)에서 기본 `medium`이며 난이도로 자동 상승하지 않는다. 단, 새 adaptive 페어 정책의 Grok 리뷰 자리에는 역할별 `xhigh`가 적용되며 전역 기본값이나 이후 구현 라운드는 바뀌지 않는다. 설정에 값을 적으면 일반 기본값을 덮어쓰고, `null`을 적으면 일반 플래그를 넘기지 않고 CLI 기본값을 쓴다(필수 리뷰 역할의 강도는 해제하지 않음). 목록 밖의 값은 `EFFORT_UNSUPPORTED` 설정 오류다. 설정했는데 설치된 CLI 도움말에 그 플래그가 없으면 조용히 무시하지 않고 `ADAPTER_UNAVAILABLE`로 거절한다. CLI가 받아들이는지는 `setup-doctor.mjs --smoke`로 확인한다.

기존 설정에 `executors.grok.reasoning_effort:"xhigh"`를 적었다면 그 명시값은 유지된다. 새 기본값을 사용하려면 해당 키를 지우거나 `"medium"`으로 바꾸고 새 작업을 init한다. 진행 중 작업의 고정된 설정은 변경하지 않는다. CLI 기본값으로 위임하는 `null`은 `medium` 지정과 다르다.

## AGY 모델 계열과 effort 분리 (Argon)

```json
{"executors":{"antigravity":{"sandbox":true,"model":"gemini-4-argon","reasoning_effort":"high"}}}
```

`model`은 모델 계열이고 `reasoning_effort`는 추론 강도다. 위 설정은 `--model gemini-4-argon-high` 하나로 전달하며 중복 `--effort`를 넣지 않는다. `model:"gemini-4-argon-medium"`처럼 완성된 Gemini 슬러그를 주면 suffix의 effort를 기록하고 자동 난이도 조정으로 덮어쓰지 않는다. 명시적으로 `reasoning_effort:"high"`를 함께 주면 `EFFORT_CONFLICT`로 거절한다. `null`도 이미 고정된 suffix를 지우지는 않는다. suffix 없는 모델과 effort null은 그대로 CLI에 전달하고 사용량 강도를 미측정으로 남긴다.

`model`이 없으면 effort를 보내지 않는다. agy는 강도를 모델 ID에서 읽고, 모델을 정하지 않은 실행에 준 `--effort`는 효과가 확인되지 않는다. 기본 강도(Antigravity `high`)와 난이도별 자동 강도는 모델이 없으면 빠지고 CLI 기본값으로 돌며, dispatch·사용량 기록의 강도도 `null`(미측정)이다. 운영자가 모델 없이 `reasoning_effort`만 적으면 `EFFORT_NEEDS_MODEL` 설정 오류다(`models_by_difficulty`가 있으면 허용하고, 그 표에 없는 난이도는 같은 방식으로 강도가 빠진다).

Gemini headless는 `low|medium|high`를 받는다. `xhigh`는 거절하며, Enterprise AGY의 `claude-opus-*`/`claude-sonnet-*` 지정 모델은 공식 문서에 따라 별도 `max`를 허용한다. custom/Claude 모델에는 Gemini suffix를 만들어 붙이지 않고 기존 `--effort`를 유지한다. [headless CLI](https://www.antigravity.google/docs/cli/headless/)와 [Enterprise model/effort](https://www.antigravity.google/docs/enterprise)를 기준으로 한다.

선택한 실제 Gemini 슬러그를 `agy models`로 검사한다. 없는 슬러그는 lease·시도 소모 전에 `MODEL_UNLISTED`로 거절하고 다른 모델로 자동 다운그레이드하지 않는다. 목록 조회 실패는 기존대로 `unverified`, 운영자 `HF_AGY_ALLOW_UNLISTED_MODEL=1`은 `skipped`로 기록한다. 모델 목록에 있다는 것은 계정 인증·잔량이나 실제 추론 성공의 증명이 아니다.

구현 작업의 모델 계열도 난이도별로 고를 수 있다(AGY 전용, suffix 없는 모델 계열만 허용):

```json
{"executors":{"antigravity":{"sandbox":true,"models_by_difficulty":{"low":"gemini-3.8-flash","medium":"gemini-3.8-flash","high":"gemini-4-argon"}}}}
```

매핑에 없는 난이도와 상담·리뷰는 기본 `model`을 사용한다. External-First 기본 effort는 low/medium/high이며, 명시적 effort 또는 pinned 모델은 우선한다. classic은 기존 기본 effort high를 유지하므로 필요하면 명시한다. 실제 계정 목록에 해당 effort 슬러그가 없으면 실패한다. 이 옵션은 기본 설정이나 계정의 AGY 설정을 변경하지 않는다.

dispatch·사용량에 `model`, `model_family`, `reasoning_effort`를 따로 기록하고 `usage_by_model_effort`로 분리한다. dispatch 선택 근거이며 실제 제공자 모델 인증이나 청구액이 아니다. 모델 미지정 호출은 family를 null로 유지한다.
