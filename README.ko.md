# HyperFusion

[English](README.md) | 한국어 | [日本語](README.ja.md)

**Opus는 계획하고 검수만 한다. 코드는 다른 모델이 쓴다.**

HyperFusion은 Claude Code 스킬이다. 비싼 Claude Opus 5.5가 팀장(리드)을 맡고, 실제 구현과 테스트는 Terra·Grok·Sonnet·Luna·Haiku·Antigravity 같은 다른 모델(일꾼)이 한다. 리뷰는 구현하지 않은 다른 회사 모델이 맡는다.

## 왜 만들었나

Opus가 코드를 쓰고, 테스트를 돌리고, 긴 로그를 읽으면 비싼 토큰이 빨리 닳는다. 그 일은 더 싼 모델이나 다른 구독의 모델도 할 수 있다.

그래서 일을 나눈다.

- **Opus:** 무엇을 할지 정하고, 결과를 보고, 통과 또는 반려를 정한다.
- **일꾼:** 코드를 쓰고 테스트를 돌린다.
- **사용자:** Opus 하나와만 이야기한다. 일꾼 관리는 Opus가 한다.

> 목표: **Opus 토큰은 줄이고, 품질은 그대로. 대신 시간은 더 걸려도 된다.**

## 어떻게 일하나

```text
  사용자
    │  "이 기능 만들어 줘"
    ▼
  리드 (Opus) ── 작업지시서와 합격 기준(수용 테스트)을 쓴다
    │
    ▼
  일꾼 (Terra, Grok, Sonnet …) ── 코드를 쓰고 테스트를 돌린다
    │
    ▼
  컨트롤러 ── 바뀐 파일을 직접 비교하고, 수용 테스트를 직접 돌린다
    │           (일꾼의 "다 했어요"는 믿지 않는다)
    ▼
  리뷰어 (구현하지 않은 다른 모델) ── 변경을 읽기 전용으로 검토한다
    │
    ▼
  리드 (Opus) ── 통과 → 끝 / 반려 → 구체적인 수정 지시와 함께 다시 일꾼에게
```

- **수용 테스트는 먼저 실패해야 한다.** 시작할 때 손대지 않은 코드로 테스트를 돌려, 실패하는지 먼저 확인한다. 처음부터 통과하는 엉터리 관문을 막기 위해서다.
- **반려에는 이유가 있어야 한다.** "다시 해"는 안 된다. 어느 기준(AC1, AC2…)이 왜 안 됐는지 적어야 한다.
- **같은 실수를 두 번 하면 일꾼을 바꾼다.**
- **한 번에 한 일꾼만 파일을 고친다.** 라운드마다 스냅샷을 남긴다.
- **오토파일럿.** 일꾼 실행부터 리뷰까지는 자동으로 돌고, 리드는 판정할 때만 깨어난다.

## 측정 결과

큰 과제 5개(L01~L05)를 같은 조건으로 돌려 리드(Opus) 토큰을 비교했다. 과제는 이 저장소의 실제 기능 커밋으로 만들었고, 품질은 일꾼과 리드가 보지 못한 숨김 시험으로 채점했다.

| 과제 | HyperFusion 리드 토큰 (1회 / 2회) | Opus 혼자 (1회 / 2회) |
|---|---|---|
| L01 | 221K / 477K | 434K / 414K |
| L02 | 240K / 272K | 642K / 429K |
| L03 | 623K / 736K | 1.04M / 719K |
| L04 | 293K / 131K | 256K / 206K |
| L05 | 149K / 307K | 307K / 411K |
| **합계** | **1.53M / 1.92M (평균 1.73M)** | **2.68M / 2.18M (평균 2.43M)** |

- **Opus 토큰:** 평균 **약 29% 적게** 썼다. 다만 과제마다 차이가 크다. 작은 과제(L04)에서는 혼자 하는 쪽이 더 적게 쓴 적도 있다.
- **품질:** 숨김 시험 통과는 HyperFusion 48/50(1회 25/25, 2회 23/25), Opus 혼자 24/25(2회)였다.
- **시간:** 훨씬 오래 걸린다. 과제 하나에 HyperFusion은 17~108분, Opus 혼자는 3~7분(2회)이었다.

**읽는 법과 한계**
- 토큰 수치는 입력 환산값이다. 캐시 쓰기는 1.25배, 캐시 읽기는 0.1배, 출력은 5배로 쳐서 더했다.
- 일꾼 모델이 쓴 토큰과 비용은 이 표에 없다. 일꾼은 다른 구독이나 더 싼 모델을 쓴다고 가정했다.
- 각각 두 번씩만 돌렸다. 회차 사이에 스킬도 고쳤다(2회차에는 #112, #114가 들어갔다).
- 2026-11-10~11, Windows 11 한 대에서 측정했다.
- 방법은 [벤치마크 문서](references/benchmark-pilot.md)에 있다.

## 팀

| 팀원 | 모델 | 맡는 일 |
|---|---|---|
| **Opus (리드)** | claude-opus-5-5 | 계획, 판정, 최종 검수. 일꾼이 남아 있으면 코드를 쓰지 않는다 |
| Terra | gpt-6.1-terra (Codex) | 어렵거나 중간 난이도의 코드, 테스트, 리팩터 |
| Grok | Grok 4.7 CLI | 구현, 이미지 애셋, 리뷰 |
| Sonnet | claude-sonnet-5-5 | 구현, 리뷰 |
| Luna | gpt-6-luna (Codex) | 작은 수정, 반복적인 대량 편집 |
| Haiku | claude-haiku-5-5 | 쉬운 코드, 문서, 테스트 보강 |
| Antigravity | agy (Gemini 3.8 Flash high) | UI, 프론트엔드, 문서 |
| Sol | gpt-6.1-sol (Codex) | 주로 리뷰와 상담 |

설치된 일꾼만 쓴다. 하나만 있어도 된다. 배치는 출발점일 뿐이고, 일꾼마다 반려된 기록을 보고 리드가 바꾼다. → [배치 규칙](references/routing.md)

## 설치와 사용

필요한 것:
- Node.js 24 이상
- 초기 커밋이 있는 Git 저장소(원격 저장소는 없어도 된다)
- 설치·인증된 `claude`, `grok`, `agy`, `codex` 중 하나 이상

```sh
# Linux / macOS
git clone https://github.com/prentice7725/hyperfusion.git ~/.claude/skills/hyperfusion
```

```powershell
# Windows (PowerShell)
git clone https://github.com/prentice7725/hyperfusion.git "$env:USERPROFILE\.claude\skills\hyperfusion"
```

Claude Code에서 Opus 5.5를 고르고 이렇게 쓴다.

```text
/hyperfusion <작업 내용>
/hyperfusion --executor sonnet <작업 내용>
```

- **설치 점검:** `node scripts/setup-doctor.mjs <저장소>`가 설치된 CLI를 보고 알맞은 설정을 추천한다.
- **팀 파일:** `--write-team`을 붙이면 설치된 CLI로 `~/.hyperfusion/team.json` 초안을 쓴다. 쓸 일꾼, 모델, 강도를 그 파일에서 고친다. → [팀 파일](references/configuration.md#이-컴퓨터의-팀-파일-hyperfusionteamjson)
- **설정 파일:** 대상 저장소의 `hyperfusion.config.json`이다. 예시는 `hyperfusion.config.example.json`에 있다.
- **리드 가드 훅(권장):** `npm run guard:settings`가 출력하는 `hooks`를 `~/.claude/settings.json`에 합친다. 일꾼이 일하는 동안 리드가 직접 파일을 고치지 못하게 막는다. → [자세히](references/details.md#설치와-사용)
- **다음에 할 일:** 어느 단계에서든 `node scripts/fusion-state.mjs next <저장소>`가 다음 명령을 알려 준다.

## 안전에 대해

- 일꾼에게 넘기는 글에서는 이메일, 키, 비밀번호 패턴을 가린다.
- 작업 상태 파일은 저장소 밖 `~/.hyperfusion/state/`에 둔다.
- 자동 커밋, 푸시, 배포는 하지 않는다.

**이것은 협업 규칙이지 OS 샌드박스가 아니다.** 셸을 쓸 수 있는 일꾼은 저장소 밖 파일에도 닿을 수 있다. 회사 코드에 쓴다면 파일 접근과 외부 전송 정책을 따로 정해야 한다. → [보안 상세](references/details.md#보안)

## 더 읽을거리

- [상세 설명](references/details.md): 전체 기능, 적응형 리뷰, 벤더 설정, 측정, 보안, 테스트
- [CHANGELOG](CHANGELOG.md): 버전별 변경. 지금 패키지 버전은 `0.32.0`이다.
- 처음이면 [runtime](references/runtime.md)(명령)과 [configuration](references/configuration.md)(설정)부터 본다. 리드용 영어 요약은 [executor-quickstart](references/executor-quickstart.md)에 있다.

| 주제 | 문서 |
|---|---|
| 상태와 명령 | [runtime](references/runtime.md) · [state-actions](references/state-actions.md) · [operations](references/operations.md) |
| 설정 | [configuration](references/configuration.md) · [codex-runtime](references/codex-runtime.md) |
| 일꾼 | [executor-runtime](references/executor-runtime.md) · [routing](references/routing.md) · [herdr](references/herdr.md) |
| 작업지시서와 결과 | [delegation-protocol](references/delegation-protocol.md) · [result-protocol](references/result-protocol.md) |
| 검수 | [review-protocol](references/review-protocol.md) · [review-pairs](references/review-pairs.md) · [finding-ledger](references/finding-ledger.md) · [consult](references/consult.md) · [universal-supervisor](references/universal-supervisor.md) |
| 실패와 복구 | [failure-protocol](references/failure-protocol.md) · [recovery-protocol](references/recovery-protocol.md) · [reconciliation](references/reconciliation.md) |
| 프로젝트·기억·지표 | [project](references/project.md) · [memory](references/memory.md) · [metrics-policy](references/metrics-policy.md) · [benchmark-pilot](references/benchmark-pilot.md) |

## 테스트와 한계

```sh
npm test
```

- CI는 Ubuntu와 Windows에서 Node 24로 돈다.
- 테스트 속 `grok`, `agy`, `claude`, `codex`는 흉내 낸 가짜 CLI다. 실제 모델의 품질, 인증, 이미지 생성은 이 테스트로 확인하지 않는다.
- 실제 모델로 잰 결과는 위 [측정 결과](#측정-결과)뿐이다.

라이선스는 [MIT](LICENSE).

## 참고한 것

- [Orca](https://github.com/stablyai/orca), [Paseo](https://github.com/getpaseo/paseo): 상담(advisor/committee), 줄 단위 피드백, 알림
- [AnchorMind](https://github.com/jinho-von-choi/memento-mcp): 기억 계층 설계(중복 병합, 모순 검토, 감쇠, 출처 표시)
- [cli-dispatch](https://github.com/rbinar/cli-dispatch): agy 모델명 검증, 컴팩션 뒤 상태 주입, Codex 잔량 읽기
- [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills): 리뷰어에게 일꾼의 주장을 주지 않기, 지적 분류
- [cursor/plugins pstack](https://github.com/cursor/plugins/tree/main/pstack): 지적별 처분(Act on / Consider / Noted / Dismissed)
- [mattpocock/skills](https://github.com/mattpocock/skills): 규칙과 명세를 나눈 리뷰, 의존 그래프 기반 작업 분해
