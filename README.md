# HyperFusion

한국어 | [日本語](README.ja.md)

**Claude Opus 5.5가 리드**를 맡고, **Grok·Antigravity·Sonnet이 일꾼**으로 구현과 테스트를 전부 수행하는 Claude Code 스킬. 리드는 작업 종류와 난이도를 보고 일꾼을 골라 투입한다(이미지 애셋은 Grok, 까다로운 코딩은 Sonnet, UI는 Antigravity…).

리드는 계획·반려·최종 검수만 한다. 일꾼에게 예산이 남아 있는 한 리드는 코드를 쓰지 않는다. 반려할 때는 구체적 명령서를 붙여야 하고, 같은 실수를 두 번 하는 일꾼은 다른 일꾼으로 교체된다. 일꾼의 "다 했어요"는 스냅샷 diff와 리드의 재실행으로만 인정된다.

> v0.2.1까지는 GPT-6.1 Sol(Codex)이 리드, Claude Code가 일꾼인 구조였다. v0.4부터 역할을 뒤집어 Opus가 리드를 맡는다.

## v0.2.1 평가 요약

| 항목 | 평가 |
|---|---|
| 상태 기계·writer lease·스냅샷 감사 | 견고함. create-once 산출물, 원자적 상태 저장, 범위/HEAD/index 검증, 중복 실행 방지가 잘 설계됨 → **그대로 계승** |
| 실행자 다양성 | Claude 하나뿐. Grok·Antigravity는 `ADAPTER_UNAVAILABLE`로만 존재 → 사실상 단일 일꾼이라 alternative 경로가 죽어 있었음 |
| 리드의 개입 | Luna helper + takeover 경로가 있어 리드 측이 일을 떠안기 쉬움 |
| 반려 품질 | 반려 사유 없이도 redo 가능 → 같은 실수를 반복시켜도 막을 장치 없음 |
| 코드 가독성 | 한 줄에 로직을 몰아넣은 압축 스타일. 동작은 맞지만 리뷰 비용이 큼 |
| 테스트 | 36개 통과. 대역 CLI로 프로세스/프로토콜만 검증하며 실제 모델 호출은 없음(정직하게 명시됨) |

## 리뷰 위임 (v0.8)

리드는 Opus 그대로 두고, 라운드 리뷰만 다른 모델에게 맡기는 옵션이다(`"review": {"by": "delegate"}`). Opus가 diff를 정독하는 비용이 리드 토큰에서 가장 크기 때문이다.

- **판정 적용:** 리뷰어가 읽기 전용으로 diff를 보고 판정(pass/redo/alternative/decision), 반려 사유, 파일·줄 지적을 낸다. 컨트롤러가 그 판정을 그대로 적용한다(`auto_apply: false`면 리드가 채택하거나 덮어쓴다).
- **리뷰어 순서:** 기본은 **Codex**(GPT, 리드와 다른 계열이라 교차 검증에 가장 유리) → Sonnet → Antigravity → Grok이다. 설치 안 된 리뷰어는 건너뛴다. Codex는 리뷰·상담만 하고 코드는 쓰지 않는다.
- **자기 리뷰 금지:** 그 라운드를 구현한 일꾼은 리뷰어가 될 수 없다. 리드가 takeover로 직접 쓴 코드도 다른 모델이 리뷰한다.
- **리드에게 남는 것:** takeover, 설계 결정(decision), 최종 VERIFY(테스트 직접 실행), 그리고 언제든 덮어쓸 권한이다. 덮어쓴 횟수는 metrics의 `lead_overrides`에 남는다.
- **지시 재사용:** 다음 라운드는 `"lead_feedback": "@review"`로 리뷰어의 지적을 그대로 넘긴다.
- **안전장치:** 리뷰어가 트리를 건드리면 판정을 버린다. 형식이 틀리거나 실패하면 다음 리뷰어로 넘어가고(라운드당 2회), 그래도 안 되면 리드가 본다. 적용할 수 없는 판정은 보류한다.

자세한 건 [review-protocol](references/review-protocol.md).

## 일꾼 배치 (v0.4)

| 작업 | 1순위 → 예비 |
|---|---|
| 이미지 애셋 (`image-asset`) | Grok → Antigravity |
| 중·고난도 코드 (`code` medium/high) | Sonnet → Grok → Antigravity |
| 쉬운 코드 (`code` low) | Grok → Antigravity → Sonnet |
| 테스트 / 리팩터 | Sonnet → … |
| UI / 문서 | Antigravity → … |

- brief의 `task_kind`, `difficulty`로 규칙을 고르고, 설치 안 된 일꾼은 건너뛴다.
- 같은 종류 작업에서 pass 비율이 낮은 일꾼(표본 3개 이상, 40% 미만)은 자동으로 뒤로 밀린다.
- 반려·교체 시 배치 순서상 다음 일꾼이 들어간다. 리드는 `--executor`로 언제든 직접 지정할 수 있다.
- 배치표는 측정값이 아닌 출발점이며 `hyperfusion.config.json`의 `routing.rules`로 바꾼다. 자세한 건 [routing](references/routing.md).
- Grok의 이미지 생성은 공개 자료에 언급되지만 공식 문서로 확인하지 못했다. 결과 파일은 스냅샷 diff로 검증되므로, 애셋이 실제로 범위 안에 생기지 않으면 통과할 수 없다.

## 기억 계층: AnchorMind 설계를 들여온 내장 작업기억 (v0.7)

[AnchorMind](https://github.com/jinho-von-choi/memento-mcp)에 붙지 않고, 그 설계를 벤치마킹해 HyperFusion 안에 직접 구현했다. 외부 서버나 DB 없이 `~/.hyperfusion/memory/<workspace>.json`에 저장한다. 일꾼이 세션을 새로 열 때마다 끊기던 시행착오("이 에러 지난번에 해결했지", "여기선 이렇게 검증했지")를 다음 세션과 다른 일꾼에게 넘기는 공유 경험층이다. Drive(설계 정본), Git(구현), Notion(관제) 구조는 건드리지 않는다.

| 들여온 아이디어 | 구현 |
|---|---|
| 7종 fragment, workspace 격리 | 1~2문장(400자) 단위, 프로젝트별 파일. 쓰기마다 잠금 + 원자적 저장 |
| 중복 병합 | 같은 종류·유사도 0.8 이상·숫자와 버전 동일 → 병합(중요도↑, 출처 누적, verified 우선) |
| 모순 탐지 + 검토 대기열 | 주제가 겹치는데 부정어나 숫자·버전이 다르면 `needs_review`. 리드가 `resolve` 하기 전엔 일꾼에게 안 감. 기각된 내용은 다시 저장되지 않음 |
| importance 감쇠·재공고화·TTL | 종류별 반감기, 다시 쓰이면 감쇠가 처음부터 다시 시작, `ttl_days` 만료. `reflect`가 만료되거나 잊힌 추정 기억을 보관함으로 옮김 |
| 연상 확산 | 상위 결과와 링크됐거나 같은 작업에서 나온 기억을 낮은 점수로 함께 꺼냄 |
| 검색 | BM25 계열 어휘 점수 × 감쇠된 중요도 × 신뢰도. 한글은 글자 bigram 색인 |

| 경로 | 동작 |
|---|---|
| 읽기 | 리드가 `memory.mjs recall`로 찾은 기억을 SOT·Git과 대조한 뒤 brief의 `prior_experience`로 넘김. 일꾼에게는 "brief·저장소보다 우선순위 낮음, 확인 후 사용"으로 전달 |
| 쓰기 후보 | 일꾼 결과의 `memory_candidates`(최대 3개) + 작업 종료 시 리뷰 기록에서 자동 추출한 "실패 → 원인 → 수정 → 검증" |
| 쓰기 확정 | 리드가 `memory.mjs commit`으로 승인한 것만 저장. 검증 통과 작업에서 프로토콜이 뽑은 것만 `verified`, 나머지는 `inferred` |
| 차단 | 일꾼의 decision/preference/relation 제안, 400자 초과, 비밀값 패턴, 허용 목록 밖 anchor, workspace 미설정(기능 꺼짐) |

- **일꾼이 직접 쓰지 않는 이유:** 처음 잘못 저장된 기억은 저장소가 스스로 거르지 못한다. 그래서 쓰기도 읽기도 리드를 거친다.
- **검색의 한계:** 임베딩이 없어서 뜻은 같지만 단어가 다른 기억은 놓칠 수 있다. 키워드로 보완한다.

자세한 건 [memory](references/memory.md).

## Orca·Paseo에서 들여온 것 (v0.5)

[Orca](https://github.com/stablyai/orca)와 [Paseo](https://github.com/getpaseo/paseo)를 벤치마킹했다. 둘 다 여러 코딩 에이전트를 한곳에서 부리는 앱/데몬이다. 그중 이 스킬의 단일 writer·감사 구조와 맞는 것만 가져왔다.

| 기능 | 출처 | 내용 |
|---|---|---|
| advisor | Paseo `/paseo-advisor` | 다른 일꾼이 읽기 전용으로 diff를 먼저 검사하고 findings(파일·줄·심각도)를 낸다. Opus는 그걸 단서로 검수해 읽을 양을 줄인다 |
| committee | Paseo `/paseo-committee` | 서로 다른 일꾼 둘이 병렬로 근본 원인과 실행 계획을 낸다. 같은 실수가 반복되면 상태에 권고(`hint`)가 붙는다 |
| 줄 단위 피드백 | Orca diff annotate | `lead_feedback`에 `{file, line, comment}`. 상담 findings를 그대로 넘길 수 있다 |
| 알림 | 둘 다 | `HF_NOTIFY_URL`(예: ntfy)로 일꾼 완료, 상담 완료, 리드 판단 필요 시 휴대폰 푸시 |

상담은 writer lease 없이 돌고 구현 예산을 쓰지 않는다(작업당 위원 실행 4회 상한). 읽기 전용은 CLI 설정(Sonnet은 읽기 도구만, agy `--mode plan`, Grok 편집·셸 deny)에 더해 **상담 전후 스냅샷 비교**로 보증한다. 트리를 건드린 상담은 답변을 버리고 복구로 넘어가며, 그 일꾼은 router 실적이 깎인다. 자세한 건 [consult](references/consult.md).

**들여오지 않은 것**
- **Orca의 worktree 경쟁(같은 brief를 여러 일꾼에게 동시에 시키고 승자 채택):** 가장 탐나는 기능이지만, 단일 작업 트리라는 핵심 불변식을 바꿔야 한다. 의존성 설치·Windows 심볼릭 링크 문제도 있어 다음 단계로 미뤘다.
- **작업 DAG:** 다음 단계로 미뤘다.
- **모바일 앱·음성·내장 브라우저·원격 접속:** 스킬 범위 밖이다.

## v0.3에서 바뀐 것

| 기능 | 상태 |
|---|---|
| 리드 | Claude Opus 5.5 (`claude-opus-5-5`), Claude Code 호스트 |
| Grok 어댑터 | 구현. `--prompt-file`, `--output-format json`, `--session-id`/`--resume`, scope 기반 `--allow Edit(...)`, git 변경 명령 `--deny` |
| Antigravity 어댑터 | 구현. `--json-schema` 구조화 출력, CLI 발급 `conversation_id`로 재개, 기본 `--sandbox` |
| Sonnet 어댑터 (v0.4) | 구현. Claude Code `-p --model claude-sonnet-5-5`, `--json-schema`, `--safe-mode`, `dontAsk` |
| auto-routing (v0.4) | 구현. 배치표 + 실적 + 설치 상태 |
| 일꾼 예산 | 일꾼당 3라운드(v0.2.1은 2), 리드 takeover 1회 |
| takeover 조건 | 모든 일꾼이 소진됐을 때만. 그 전엔 컨트롤러가 거절 |
| 빈 반려 금지 | 반려에 `blocking_criteria` 필수, 재지시에 `lead_feedback` 필수 |
| 자동 교체 | 같은 반려 사유 2연속이면 다른 일꾼으로 강제 교대 |
| Luna | 제거. Claude 일꾼은 `sonnet`으로만 고용(리드 Opus와 별도 프로세스) |
| 실제 Grok/agy/Sonnet 인증·모델 호출 | 이 패키지의 테스트로 검증되지 않음 |

CLI 플래그는 xAI의 [Grok Build headless 문서](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md)와 [Antigravity CLI headless 문서](https://antigravity.google/docs/cli/headless), [Claude Code headless 문서](https://code.claude.com/docs/en/headless)를 기준으로 했다. 설치된 버전에 필요한 플래그가 없으면 preflight에서 거절하며, 플래그를 약하게 바꿔 우회하지 않는다.

## 설치와 사용

Node.js 20 이상, Git, 초기 커밋이 있는 대상 저장소(Linux·macOS·Windows), 그리고 설치·인증된 `grok`, `agy`, `claude` 중 하나 이상이 필요하다.

```sh
# Linux / macOS
git clone https://github.com/prentice7725/hyperfusion.git ~/.claude/skills/hyperfusion
```

```powershell
# Windows (PowerShell)
git clone https://github.com/prentice7725/hyperfusion.git "$env:USERPROFILE\.claude\skills\hyperfusion"
```

Windows에서는 npm `.cmd` 래퍼를 자동으로 풀어서 실행하고, 프로세스 정리는 `taskkill /T`로 한다. 일꾼이 먼저 끝난 뒤 남은 자손 프로세스는 자동으로 못 잡으니 리드가 확인해야 하고, agy가 TTY 없이 멈추는 알려진 문제가 있어 `executors.antigravity.timeout_ms`를 짧게 두길 권한다. 자세한 건 [일꾼 런타임의 Windows 절](references/executor-runtime.md#windows).

Claude Code(Opus 5.5 선택)에서:

```text
/hyperfusion <작업 내용>
/hyperfusion --executor sonnet <작업 내용>
```

독립 실행형 명령이나 daemon은 없다. 리드가 `SKILL.md`에 따라 brief를 쓰고 컨트롤러와 브리지를 호출한다. 기본 일꾼과 정책은 대상 저장소의 `hyperfusion.config.json`으로 정한다(예시: `hyperfusion.config.example.json`). 실행 파일 경로는 `HF_GROK_BIN`, `HF_AGY_BIN`, `HF_CLAUDE_BIN`으로 바꿀 수 있다.

자세한 순서: [SKILL.md](SKILL.md), [runtime](references/runtime.md), [일꾼 런타임](references/executor-runtime.md), [배치](references/routing.md).

## 테스트

```sh
npm test
```

121개 테스트가 리뷰 위임(Codex 우선 배정, 자기 리뷰 금지, 판정 자동 적용·보류·채택·덮어쓰기 기록, `@review` 지시 전달, 리뷰어 실패 시 교체·라운드 상한, 형식 오류 판정 폐기, 미완료 라운드 pass 차단, 읽기 전용 위반 폐기, takeover 코드 리뷰, Codex 구현 금지·설정 검증), 기억 계층(비밀값·크기·권한 차단, 후보 장부, 프로토콜 자동 추출, 리드 승인 저장, verified/inferred, 중복 병합, 모순 검토 대기열, 감쇠·재공고화·TTL, 연상 확산, 한글 검색, workspace 격리, 파일 잠금),  상담(advisor/committee) 실행·읽기 전용 위반 적발·상담 중 잠금·예산, 줄 단위 피드백, 알림 전송, Windows 경로 처리(.cmd 래퍼 해석, .js 진입점, 역슬래시 경로, 명령줄 길이)와 Grok/Antigravity/Sonnet 정상 실행, 작업별 배치·설치 상태 반영·실적 기반 강등·교체 순서, 세션 재개, 중복 실행 차단, 오류·timeout·출력 상한·결과 검증, 빈 반려 거절, 같은 실수 반복 시 교체, 일꾼이 남아 있을 때 takeover 거절, 예산 소진 후 단 1회 takeover, 거짓 변경 신고 적발, 리드/일꾼 사용량 분리 집계를 확인한다. GitHub Actions가 Ubuntu·Windows × Node 20·24에서 실행한다. 테스트의 `grok`/`agy`/`claude`/`codex`는 명시적으로 표시된 대역이며 실제 모델을 호출하지 않는다.

## 완료보고 진단

대상 저장소 `.fusion/tasks/<task_id>/`:

- `dispatch-N.json`: 일꾼, CLI 인자, 세션
- `envelope-N.json`: 종료 코드, 중단 이유, 원본 stdout/stderr
- `result-N.json`, `session-N.json`, `usage-N.json`: 검증된 결과, 세션 ID, 일꾼 보고 사용량
- `review-N.json`: 리드 판정과 반려 사유
- `.fusion/state.json`: 단계, 배치 결과와 근거(`routing`), 일꾼별 남은 예산, 교체 이력
- `.fusion/metrics/<task_id>.json`: router가 학습하는 작업별 기록

## 운영 원칙

writer는 한 명이다. lock은 협업 통제이며 OS 샌드박스가 아니다. 자동 commit/push/deploy/release, 범위 확장, 파괴적 복구는 없다.

목표 지표는 **성공 작업당 Opus 리드 토큰**이다. 실패 작업도 분자에 포함한다. 일꾼 비용과 소요 시간은 별도 가드레일로 기록한다(Antigravity는 비용을 보고하지 않으므로 null). 작업이 끝날 때마다 `metrics.mjs`를 돌려야 router가 실적을 배운다. 측정되지 않은 값은 null이다.

실행 로그·세션·인증정보는 이 저장소에 포함하지 않는다. `.fusion/`은 대상 저장소의 비공개 로컬 작업 기록이다.
