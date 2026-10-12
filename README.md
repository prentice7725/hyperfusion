# HyperFusion

한국어 | [日本語](README.ja.md)

**Claude Opus 5.5는 지시하고 검수만 하고, 코드는 다른 모델들이 쓴다.** 구현과 테스트를 Sonnet·Haiku·Grok·Antigravity·Luna에게 시키고, 리뷰는 Sol에게 맡길 수 있는 Claude Code 스킬이다.

> **버전.** 패키지 릴리스는 `0.20.0`(`package.json`)이다. **v0.3**은 그 위에 얹은 운영 프로필(External-First + 범용 감시)의 이름이고, 저장 스키마 4, 아키텍처 식별자 `opus-lead-v0.3`, wire protocol `hyperfusion-opus-lead-v0.5`는 패키지 버전과 별개의 호환성 식별자다(정본은 `scripts/versions.mjs`). 버전별 변경은 [CHANGELOG](CHANGELOG.md).

## 왜 만들었나

1. **토큰 절약.** 비싼 모델(Opus)이 코드를 쓰고 테스트를 돌리며 로그를 읽는 데 토큰을 태우는 건 낭비다. Opus는 계획, 반려, 최종 검수만 하고, 구현과 테스트 반복은 더 싼 모델이나 다른 구독의 모델이 한다. 성공한 작업당 Opus 토큰을 핵심 지표로 재고 기록한다.
2. **리드만 상대하면 된다.** 여러 에이전트를 한 화면에서 관리하는 도구는 이미 있다. 이 스킬은 반대로 사용자가 **Opus 하나만 상대하고, 일꾼 관리는 Opus가 한다.** 일꾼의 "다 했어요"를 믿지 않고, 빈 반려 없이 구체적인 명령서로 갈구고, 같은 실수를 두 번 하면 다른 일꾼으로 교체한다.

## 팀

| 팀원 | 모델 | 기본 역할 |
|---|---|---|
| **Opus (리드)** | claude-opus-5-5 | 팀 구성, 계획, 반려, 최종 검수. 일꾼이 남아 있는 한 코드를 쓰지 않는다 |
| Sonnet | claude-sonnet-5-5 | 중·고난도 코드, 테스트, 리팩터 |
| Haiku | claude-haiku-5-5 | 쉬운 코드, 문서, 테스트 보강 (Sonnet과 같은 Claude Code CLI) |
| Grok | Grok CLI | 이미지 애셋, 쉬운 구현 |
| Antigravity | agy | UI·프론트엔드, 문서 (이미지 생성 기능 없음) |
| Luna | gpt-6-luna (Codex) | 소규모 수정, 기계적 대량 편집, 이미지 애셋 보조 |
| Sol | gpt-6.1-sol (Codex) | 리뷰·위원회 상담 전담. 코드는 쓰지 않음 |

기본 배치는 출발점이다. 프로젝트마다 리드가 바꾸고, 종류·난이도별 실적에 시간 감쇠와 재탐색을 적용해 배치를 조정한다. 설치되지 않은 일꾼은 건너뛴다. 실행 전 CLI 확인이 일시적으로 실패하면 시도 예산을 쓰지 않고 재시도할 수 있고, 담당 일꾼의 실행 파일이 사라지면 다른 일꾼으로 교체할 수 있다.

## 한 작업의 흐름

```text
리드: 계획(brief + 수용 명령) → init → begin
일꾼: 단일 writer로 구현 → 결과 보고
컨트롤러: finish(스냅샷 diff, 수용 테스트 직접 실행, 프로세스 종료 확인)
리뷰: 구현하지 않은 다른 모델이 읽기 전용으로 검토
리드: 판정(pass / redo / alternative / decision / takeover) → verify → CLOSE
```

CLOSE까지 가야 성공이다. 어느 단계에서든 지금 칠 명령은 `node scripts/fusion-state.mjs next <저장소>`가 알려 준다.

## 특징

**배치와 팀**

- **팀 구성 → 승인 → 마일스톤 → 체크포인트.** 기획 문서를 읽은 리드가 누가 무엇을 맡을지 팀을 짜서 보고하고, 승인 전에는 작업이 시작되지 않는다. 마일스톤이 끝나면 보고하고, 확인을 받아야 다음으로 넘어간다. → [project](references/project.md)
- **능력 기반 배치.** 이름이 아니라 능력(`caps`: code, ui, docs, image-gen…)으로 후보를 거르고, 내 저장소의 실적(반려율)으로 순서를 정한다. 새 모델은 설정에 모델과 능력 한 줄이면 붙고, 실적 없는 신입은 가끔 먼저 시켜 본다. 트위터 벤치마크 말고 내 작업에서 잘하는 놈이 일을 더 받는다. → [routing](references/routing.md)
- **계약 스모크.** `setup-doctor.mjs --smoke`가 일꾼마다 임시 저장소에서 아주 작은 작업을 실제로 시켜 CLI 플래그·출력 형식·결과 계약이 맞는지 본다. CLI 업데이트 뒤 누가 고장 났는지 바로 나온다. → [operations](references/operations.md#doctor-계약-스모크)

**일꾼을 믿지 않고 확인하기**

- **일꾼 말은 믿지 않는다.** 변경 파일, 테스트 통과 주장은 스냅샷 diff와 컨트롤러의 재실행으로만 인정한다. 거짓 신고는 복구 단계로 간다.
- **엄격한 반려.** 반려에는 사유가 필수고, 재지시에는 파일·줄 단위의 명령서가 필수다. 같은 수용 기준(AC1…)으로 두 번 반려되면 일꾼을 교체한다. 일꾼당 3라운드, 리드 takeover는 모든 일꾼이 소진된 뒤 1회뿐이다.
- **red-first 수용 테스트.** 컨트롤러가 수용 명령을 직접 돌린다. 시작할 때 손대지 않은 트리에서 실패하는지 먼저 확인해서, 처음부터 통과하는 엉터리 관문을 막는다. 리팩터링처럼 처음부터 통과해야 정상인 작업은 **보존 검증**(`verification:{kind:"preserve",protect:[...]}`)으로, 테스트·픽스처가 작업 내내 바뀌지 않았음을 컨트롤러가 스냅샷으로 증명한다.
- **AC 추적표와 PR 초안.** `acceptance_map`으로 수용 기준(AC1…)과 그걸 증명하는 명령을 잇는다. 끝나면 AC별 판정표와 PR 설명 초안(`pr-draft.md`)을 남긴다. 커밋·푸시는 여전히 사용자가 지시한다.
- **리뷰 위임.** 라운드 리뷰를 Sol 같은 다른 모델이 읽기 전용으로 하고 판정을 적용한다. Opus가 diff를 정독하는 토큰을 아낀다. 리뷰어는 diff(최대 100,000자)와 컨트롤러가 직접 돌린 수용 테스트 결과를 받고, 셸밖에 없는 Codex 리뷰어도 읽기 전용 명령으로 파일을 연다. 구현한 모델은 자기 리뷰를 할 수 없다. → [review](references/review-protocol.md)
- **상담.** 일꾼 한 명(advisor)이 diff를 먼저 검사하거나, 두 명(committee)이 반복 실패의 원인을 분석한다. 읽기 전용이며 상담 전후 스냅샷으로 보증한다. → [consult](references/consult.md)

**리드의 부담 줄이기**

- **짧은 출력과 `next`.** 명령줄 출력은 기본이 compact 보기다(전체는 `--full`). `next`는 지금 단계에서 칠 명령 한 줄과, token·digest 같은 컨트롤러가 아는 값을 미리 채운 입력 틀을 준다.
- **재량권(opt-in).** 리드가 init에서 작업 단위로 `delegation`을 주면, 컨트롤러가 조건을 전부 확인했을 때 STANDARD 라운드를 승인하고(`delegated-policy`로 기록), 일시 장애로 결과 없이 끝난 일꾼 실행을 되돌려 다시 시도하고, 못 끝낸 리뷰어를 다른 회사 모델로 바꾼다. 조건이 하나라도 모자라면 리드 게이트에서 멈춘다. 재량권이 없는 작업은 지금까지처럼 멈춘다. → [universal-supervisor](references/universal-supervisor.md#위임-승인-재량권)
- **오토파일럿.** `autopilot`이 라운드 실행과 독립 위임 리뷰를 자동으로 진행한다(아래 [설치와 사용](#설치와-사용)). `report`의 `lead_load`는 리드가 직접 판정한 횟수와 컨트롤러가 승인한 횟수, 리드가 읽어야 했던 게이트 수, 자동·수동 복구 수를 보여 준다.
- **요약 뒤에도 이어 가기.** 리드 가드의 SessionStart 훅이 대화가 요약되거나 새 세션이 시작될 때 진행 중인 작업과 다음 명령을 한 번 알려 준다. 작업이 없으면 아무것도 넣지 않는다.
- **내장 기억 계층.** 시행착오(에러, 절차, 경험)를 외부 서버 없이 로컬에 쌓아 다음 세션과 다른 일꾼에게 넘긴다. 쓰기와 읽기 모두 리드의 승인을 거치고, 비밀값은 저장하지 않는다. → [memory](references/memory.md)
- **알림.** `HF_NOTIFY_URL`(예: ntfy)로 일꾼 완료나 리드 판단이 필요할 때 휴대폰 푸시를 받는다. 본문은 상태만 담는다.

**안전과 감사**

- **단일 writer와 감사 기록.** 한 번에 한 일꾼만 쓰고, 라운드마다 스냅샷과 산출물이 남는다. 중단되면 복구 절차로 이어간다. 자동 commit·push·배포는 없다.
- **리드 가드 훅.** lease가 걸려 있거나 일꾼 예산이 남은 동안 리드의 Edit/Write를 차단하고(PreToolUse), 리드 차례인 작업을 두고 턴을 끝내려 하면 한 번 막는다(Stop). 규칙을 지시가 아니라 차단으로 강제한다. → [operations](references/operations.md#리드-가드-훅)
- **독립 worktree와 작업 상한.** 작업마다 상태와 writer lease를 격리해 병렬 실행하고, 보고된 비용과 경과 시간에 상한을 둔다. 결과는 각각 검수한 뒤 통합한다. → [병렬 실행·상한](references/operations.md)
- **Linux·macOS·Windows.**

## v0.3: External-First와 범용 감시 (옵트인)

`hyperfusion.v03.config.example.json`을 대상 저장소의 `hyperfusion.config.json`으로 복사해 명시적으로 켠다. 기존 classic 설정·진행 중 작업은 자동으로 바뀌지 않는다. 자세한 내용은 [universal-supervisor](references/universal-supervisor.md).

- **External-First 배치.** 자동 구현은 Grok·Antigravity·Luna가 맡는다. Sonnet(중요/재배정 라운드)과 Sol(APEX 라운드)은 라운드별 grant가 있을 때만 구현하며, 자동 폴백·신입 우대는 이 둘을 고르지 않는다.
- **작성자별 리뷰.** 원칙은 하나, 구현한 모델은 자기 라운드를 리뷰하지 않는다. 기본은 Grok/AGY 일반 → Sol, Luna → Sonnet, 중요 작업 → Sol + Sonnet 이중 PASS. 리뷰어가 한도·장애로 막히면 리드가 사유를 적고 다른 모델로 바꿔 끼우고, 남은 리뷰어가 없으면 리드가 직접 diff를 읽고 채운다. 반려에 동의하지 않으면 리드가 사유를 적고 다른 모델에게 재검토를 맡기고, 대체 리뷰어가 pass하면 직접 검토한 뒤 뒤집을 수 있다. 결과는 `LEAD_DECISION_REQUIRED`에서 멈추고, `auto_apply`·`review {adopt}`·autopilot도 호스트 리드의 최종 판정 게이트를 건너뛰지 못한다(리드가 init에서 재량권을 준 작업만 예외다).
- **범용 로컬 감시.** 모든 implement/review/consult 호출을 같은 supervisor가 관측한다(`status --monitor`, `monitor --once|--watch`). 무신호는 QUIET 경고일 뿐이며 진행률·성공을 만들어 내지 않는다. 호출 모델은 따로 부르지 않는다.
- **사용량 계측과 쿼터.** 구현·검수·상담·실패 호출과 APEX Sol을 포함해 기록하고, 미측정은 `null`로 둔다. 쿼터는 `scripts/quota-policy.mjs`로 기록한다. 운영자가 직접 적거나(`record`), Codex가 자기 세션 기록에 남긴 `rate_limits`를 읽어 openai 잔량을 기록한다(`collect-codex`, 네트워크·모델 없음). 기록은 출처와 유효 시간이 지나면 '모름'으로 취급한다.
- **기본 추론 강도.** Sonnet high, Haiku max, Antigravity high, Grok xhigh, Luna xhigh, Sol medium. 설정 `reasoning_effort`로 덮어쓰고 `null`이면 플래그를 넘기지 않는다.
- 호스트가 실제 Opus인지는 인증할 수 없으므로 `authority.model_verified:false`로 기록한다.

## 보안

일꾼이 사용자 파일을 마음대로 건드리지 못하게 여러 겹으로 막는다. 다만 이것은 **협업 통제이지 OS 샌드박스가 아니다.**

- 제어 파일(상태, brief, 스냅샷)은 작업 폴더 밖 `~/.hyperfusion/state/`에 둔다(`HF_STATE_DIR`로 변경). 일꾼이 범위를 스스로 넓힐 수 없다.
- 스냅샷이 `.git` 설정·훅, `.env`, 무시된 `.gitignore`, `node_modules/.bin`까지 본다. 컨트롤러의 git은 저장소 설정으로 코드가 실행되지 않게 호출한다.
- 브리지는 실행 직전에 요청을 다시 만들어 대조한다. 일꾼에게는 필요한 환경변수만 넘긴다.
- Bash 허용 규칙은 테스트·린트·빌드 모양만 받는다. 샌드박스 해제 같은 완화는 저장소 설정이 아니라 운영자의 환경변수로만 켠다([configuration](references/configuration.md#보안-관련-환경변수)).
- 읽기 전용 상담·리뷰는 도구의 샌드박스가 아니라 전후 스냅샷 비교로 보증한다(어긴 답변은 버린다). Antigravity의 `--sandbox`는 터미널만 제한하고 파일 쓰기 도구는 막지 못한다.

셸을 쓸 수 있는 일꾼은 작업 폴더 밖 파일에 닿을 수 있고, 스냅샷 비교는 저장소 밖에 쓴 것을 잡지 못한다. 이미 무시된 일반 의존성 파일(예: `node_modules/dep/index.js`)의 내용 변경은 스냅샷이 감시하지 않는다. 컨트롤러가 수용 테스트를 직접 돌릴 때는 무시된 파일의 메타데이터를 비교해 바뀌었으면 실행하지 않는다([operations](references/operations.md#수용-테스트-자동-실행)). 이전 버전에서 올라오면 `fusion-state.mjs migrate <저장소>`를 한 번 실행한다. 자세한 건 [configuration](references/configuration.md), [recovery](references/recovery-protocol.md).

## 설치와 사용

필요한 것: Node.js 20+, Git, **초기 커밋이 있는 Git 저장소**(원격 없이 로컬 전용이어도 된다), 설치·인증된 `claude`, `grok`, `agy`, `codex` 중 하나 이상.

```sh
# Linux / macOS
git clone https://github.com/prentice7725/hyperfusion.git ~/.claude/skills/hyperfusion
```

```powershell
# Windows (PowerShell)
git clone https://github.com/prentice7725/hyperfusion.git "$env:USERPROFILE\.claude\skills\hyperfusion"
```

Claude Code에서 Opus 5.5를 고르고:

```text
/hyperfusion <작업 내용>
/hyperfusion --executor sonnet <작업 내용>
```

리드가 [SKILL.md](SKILL.md)에 따라 컨트롤러와 브리지를 호출한다. 먼저 `node scripts/setup-doctor.mjs <저장소>`로 설치 상태를 점검한다. 설정은 대상 저장소의 `hyperfusion.config.json`(예시: `hyperfusion.config.example.json`).

**리드 가드 훅 설치(권장).** `npm run guard:settings`가 이 PC의 절대 경로로 된 훅 설정(PreToolUse, Stop, SessionStart)을 출력한다. 그 `hooks` 항목을 `~/.claude/settings.json`(또는 대상 저장소의 `.claude/settings.json`)에 합친다. 훅을 이미 설치했다면 출력의 `SessionStart` 항목만 더하면 된다.

**오토파일럿.** 초기화된 작업은 `node scripts/fusion-state.mjs autopilot <저장소>`로 라운드 실행과 독립 위임 리뷰를 자동 진행할 수 있다. 리드가 정한 `acceptance_commands`가 있어야 하고, 기준 트리에서 실패가 확인된(red) 명령이어야 한다(보존 검증 작업은 반대로 이미 통과가 확인돼야 한다). classic 리뷰에서는 `review.auto_apply:true`도 필요하다(`lead-gated-adaptive`는 어차피 리드 게이트에서 멈추므로 요구하지 않는다). VERIFY·설계 결정·BLOCKED·takeover에서 리드에게 제어를 돌려주며, 정지·스냅샷·예산·검증 확인에 실패하면 멈춘다. 리드가 재량권을 준 작업은 컨트롤러가 승인한 라운드의 verify까지 이어 간다([운영 설명](references/operations.md#오토파일럿)).

수용 테스트도 자식 프로세스 종료를 확인한다. 종료 증거가 없으면 RECOVERY_REQUIRED에서 멈추고 리드의 정지 확인을 기다린다. 작업 시간 상한은 수용 테스트와 최종 검증에도 적용된다.

외부로 보내는 brief·diff·이전 결과에는 이메일·IP·키·비밀번호 패턴 마스킹이 기본 적용된다. 인증에 필요한 벤더 환경변수는 유지한다. CLI가 직접 읽어 보내는 저장소 파일까지 가리는 DLP 기능은 아니므로, 회사 코드 사용 시 파일 접근과 외부 전송 정책도 별도로 통제해야 한다([전송 범위](references/operations.md#외부-전송-마스킹)).

## 문서

처음이면 [runtime](references/runtime.md)(명령)과 [configuration](references/configuration.md)(설정)부터 본다.

| 주제 | 문서 |
|---|---|
| 상태와 명령 | [runtime](references/runtime.md) · [state-actions](references/state-actions.md)(자동 생성) · [state-schema](references/state-schema.json) · [operations](references/operations.md)(운영·오토파일럿·훅·수용 테스트) |
| 설정 | [configuration](references/configuration.md)(환경변수 포함) |
| 일꾼 | [executor-runtime](references/executor-runtime.md)(Windows 포함) · [routing](references/routing.md) |
| 계약 | [delegation-protocol](references/delegation-protocol.md)(brief) · [result-protocol](references/result-protocol.md) |
| 검수 | [review-protocol](references/review-protocol.md) · [consult](references/consult.md) · [universal-supervisor](references/universal-supervisor.md)(v0.3·재량권) |
| 실패와 복구 | [failure-protocol](references/failure-protocol.md) · [recovery-protocol](references/recovery-protocol.md) |
| 프로젝트·기억·지표 | [project](references/project.md) · [memory](references/memory.md) · [metrics-policy](references/metrics-policy.md) |
| 설계 메모와 과거 기록 | [app-handoff-design](references/app-handoff-design.md)(후속 설계) · [archive](references/archive/README.md)(시점별 검증·감사 기록) |

## 테스트와 한계

```sh
npm test
```

자동 테스트가 상태 기계, 일꾼 어댑터, 배치, 리뷰 위임, 재량권과 자동 복구, 기억 계층, 프로젝트 흐름, 보안, 마스킹과 오토파일럿을 확인한다. 실제 CLI 스모크 1개는 `HF_LIVE=1`일 때만 실행한다. GitHub Actions는 Ubuntu·Windows × Node 20·24에서 실행하도록 구성돼 있다. Windows에서는 테스트 파일을 순차 실행하고(다른 OS는 병렬도 2), 실제 고아 프로세스를 만드는 회귀 테스트는 병렬 테스트 뒤에 따로 돌려 프로세스 목록 간섭을 피한다. Windows에서는 프로세스 생성 횟수가 곧 시간이라, `npm run spawns`가 테스트(또는 지정한 명령)가 만드는 하위 프로세스를 명령별·호출 지점별로 세어 보여 준다.

**테스트의 `grok`/`agy`/`claude`/`codex`는 대역 CLI다.** 실제 모델 호출, 인증, 이미지 생성은 이 저장소의 테스트로 검증되지 않았다. 설치된 CLI에 필요한 플래그가 없으면 실행 전에 `ADAPTER_UNAVAILABLE`로 거절한다. CLI 플래그는 [Grok Build](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md), [Antigravity CLI](https://antigravity.google/docs/cli/headless), [Claude Code](https://code.claude.com/docs/en/headless) 문서를 기준으로 했다. 재량권의 자동 복구가 "다시 해도 같은 실패"를 가려내는 문구 판별은 대역 CLI 기준이라, 실제 CLI에서 처음 몇 번은 `recovery-*.json`의 `reason`을 확인하는 것이 좋다.

라이선스는 [MIT](LICENSE).

## 참고한 것

- [Orca](https://github.com/stablyai/orca), [Paseo](https://github.com/getpaseo/paseo): advisor/committee, 줄 단위 피드백, 알림. worktree 경쟁은 단일 작업 트리 원칙과 맞지 않아 들이지 않았다.
- [AnchorMind](https://github.com/jinho-von-choi/memento-mcp): 기억 계층의 설계(중복 병합, 모순 검토, 감쇠, 출처 표시). 붙지 않고 설계만 들여와 직접 구현했다.
- [cli-dispatch](https://github.com/rbinar/cli-dispatch): 다른 회사 CLI에 일을 맡기는 비슷한 플러그인. agy 모델명 검증, 컴팩션 뒤 상태 주입, Codex 잔량 읽기를 참고했다. worktree 패치 방식은 단일 writer 원칙과 맞지 않아 들이지 않았다.
