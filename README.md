# HyperFusion

한국어 | [日本語](README.ja.md)

**Claude Opus 5.5는 지시하고 검수만 하고, 코드는 다른 모델들이 쓴다.** 구현과 테스트를 Sonnet·Haiku·Grok·Antigravity·Luna에게 시키고, 리뷰는 Sol에게 맡길 수 있는 Claude Code 스킬이다.

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

## 특징

- **팀 구성 → 승인 → 마일스톤 → 체크포인트.** 기획 문서를 읽은 리드가 누가 무엇을 맡을지 팀을 짜서 보고하고, 승인 전에는 작업이 시작되지 않는다. 마일스톤이 끝나면 보고하고, 확인을 받아야 다음으로 넘어간다. → [project](references/project.md)
- **능력 기반 배치.** 이름이 아니라 능력(`caps`: code, ui, docs, image-gen…)으로 후보를 거르고, 내 저장소의 실적(반려율)으로 순서를 정한다. 새 모델은 설정에 모델과 능력 한 줄이면 붙고, 실적 없는 신입은 가끔 먼저 시켜 본다. 트위터 벤치마크 말고 내 작업에서 잘하는 놈이 일을 더 받는다. → [routing](references/routing.md)
- **계약 스모크.** `setup-doctor.mjs --smoke`가 일꾼마다 임시 저장소에서 아주 작은 작업을 실제로 시켜 CLI 플래그·출력 형식·결과 계약이 맞는지 본다. CLI 업데이트 뒤 누가 고장 났는지 바로 나온다. → [operations](references/operations.md#doctor-계약-스모크)
- **일꾼 말은 믿지 않는다.** 변경 파일, 테스트 통과 주장은 스냅샷 diff와 리드의 재실행으로만 인정한다. 거짓 신고는 복구 단계로 간다.
- **엄격한 반려.** 반려에는 사유가 필수고, 재지시에는 파일·줄 단위의 명령서가 필수다. 같은 수용 기준(AC1…)으로 두 번 반려되면 일꾼을 교체한다. 일꾼당 3라운드, 리드 takeover는 모든 일꾼이 소진된 뒤 1회뿐이다.
- **red-first 수용 테스트.** 컨트롤러가 수용 명령을 직접 돌린다. 시작할 때 손대지 않은 트리에서 실패하는지 먼저 확인해서, 처음부터 통과하는 엉터리 관문을 막는다.
- **리뷰 위임.** 라운드 리뷰를 Sol 같은 다른 모델이 읽기 전용으로 하고 판정을 적용한다. Opus가 diff를 정독하는 토큰을 아낀다. 구현한 모델은 자기 리뷰를 할 수 없다. → [review](references/review-protocol.md)
- **상담.** 일꾼 한 명(advisor)이 diff를 먼저 검사하거나, 두 명(committee)이 반복 실패의 원인을 분석한다. 읽기 전용이며 상담 전후 스냅샷으로 보증한다. → [consult](references/consult.md)
- **내장 기억 계층.** 시행착오(에러, 절차, 경험)를 외부 서버 없이 로컬에 쌓아 다음 세션과 다른 일꾼에게 넘긴다. 쓰기와 읽기 모두 리드의 승인을 거치고, 비밀값은 저장하지 않는다. → [memory](references/memory.md)
- **단일 writer와 감사 기록.** 한 번에 한 일꾼만 쓰고, 라운드마다 스냅샷과 산출물이 남는다. 중단되면 복구 절차로 이어간다. 자동 commit·push·배포는 없다.
- **리드 입력 절감.** 결과 파일 자동 읽기, brief 기본값, stdin 입력과 요약 status를 지원한다. 라운드 타임라인과 저장소 전체 지표도 명령 하나로 확인한다. → [운영 명령](references/operations.md)
- **독립 worktree와 작업 상한.** 작업마다 상태와 writer lease를 격리해 병렬 실행하고, 보고된 비용과 경과 시간에 상한을 둔다. 결과는 각각 검수한 뒤 통합한다. → [병렬 실행·상한](references/operations.md)
- **알림.** `HF_NOTIFY_URL`(예: ntfy)로 일꾼 완료나 리드 판단이 필요할 때 휴대폰 푸시를 받는다. 본문은 상태만 담는다.
- **Linux·macOS·Windows.**

## 보안

일꾼이 사용자 파일을 마음대로 건드리지 못하게 여러 겹으로 막는다. 다만 이것은 **협업 통제이지 OS 샌드박스가 아니다.**

- 제어 파일(상태, brief, 스냅샷)은 작업 폴더 밖 `~/.hyperfusion/state/`에 둔다(`HF_STATE_DIR`로 변경). 일꾼이 범위를 스스로 넓힐 수 없다.
- 스냅샷이 `.git` 설정·훅, `.env`, 무시된 `.gitignore`, `node_modules/.bin`까지 본다. 컨트롤러의 git은 저장소 설정으로 코드가 실행되지 않게 호출한다.
- 브리지는 실행 직전에 요청을 다시 만들어 대조한다. 일꾼에게는 필요한 환경변수만 넘긴다.
- Bash 허용 규칙은 테스트·린트·빌드 모양만 받는다. 샌드박스 해제 같은 완화는 저장소 설정이 아니라 운영자의 환경변수로만 켠다.

셸을 쓸 수 있는 일꾼은 작업 폴더 밖 파일에 닿을 수 있고, Codex와 Antigravity는 각자의 샌드박스에 의존한다. 이미 무시된 일반 의존성 파일(예: `node_modules/dep/index.js`)의 내용 변경은 스냅샷이 감시하지 않는다. 컨트롤러가 수용 테스트를 직접 돌릴 때는 무시된 파일의 메타데이터를 비교해 바뀌었으면 실행하지 않는다([operations](references/operations.md#수용-테스트-자동-실행)). 이전 버전에서 올라오면 `fusion-state.mjs migrate <저장소>`를 한 번 실행한다. 자세한 건 [configuration](references/configuration.md), [recovery](references/recovery-protocol.md).

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

초기화된 작업은 `node scripts/fusion-state.mjs autopilot <저장소>`로 라운드 실행과 독립 위임 리뷰를 자동 진행할 수 있다. 리드가 정한 `acceptance_commands`와 `review.auto_apply:true`가 필요하다. VERIFY·설계 결정·BLOCKED·takeover에서 리드에게 제어를 돌려주며, 정지·스냅샷·예산·검증 확인에 실패하면 멈춘다. 최종 verify는 리드가 한다([운영 설명](references/operations.md#오토파일럿)).

외부로 보내는 brief·diff·이전 결과에는 이메일·IP·키·비밀번호 패턴 마스킹이 기본 적용된다. 인증에 필요한 벤더 환경변수는 유지한다. CLI가 직접 읽어 보내는 저장소 파일까지 가리는 DLP 기능은 아니므로, 회사 코드 사용 시 파일 접근과 외부 전송 정책도 별도로 통제해야 한다([전송 범위](references/operations.md#외부-전송-마스킹)).

문서: [runtime](references/runtime.md) · [일꾼 런타임(Windows 포함)](references/executor-runtime.md) · [configuration](references/configuration.md) · [state-schema](references/state-schema.json)

## 테스트와 한계

```sh
npm test
```

자동 테스트가 상태 기계, 일꾼 어댑터, 배치, 리뷰 위임, 기억 계층, 프로젝트 흐름, 보안, 마스킹과 오토파일럿을 확인한다. 실제 CLI 스모크 1개는 `HF_LIVE=1`일 때만 실행한다. GitHub Actions는 Ubuntu·Windows × Node 20·24에서 실행하도록 구성돼 있다. 재감사 후속 수정과 남은 한계는 [수정 결과 보고서](references/reaudit-v0.10.0.md)에 정리했다.

**테스트의 `grok`/`agy`/`claude`/`codex`는 대역 CLI다.** 실제 모델 호출, 인증, 이미지 생성은 이 저장소의 테스트로 검증되지 않았다. 설치된 CLI에 필요한 플래그가 없으면 실행 전에 `ADAPTER_UNAVAILABLE`로 거절한다. CLI 플래그는 [Grok Build](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md), [Antigravity CLI](https://antigravity.google/docs/cli/headless), [Claude Code](https://code.claude.com/docs/en/headless) 문서를 기준으로 했다.

버전 이력은 [CHANGELOG](CHANGELOG.md), 라이선스는 [MIT](LICENSE).

## 참고한 것

- [Orca](https://github.com/stablyai/orca), [Paseo](https://github.com/getpaseo/paseo): advisor/committee, 줄 단위 피드백, 알림. worktree 경쟁은 단일 작업 트리 원칙과 맞지 않아 들이지 않았다.
- [AnchorMind](https://github.com/jinho-von-choi/memento-mcp): 기억 계층의 설계(중복 병합, 모순 검토, 감쇠, 출처 표시). 붙지 않고 설계만 들여와 직접 구현했다.
