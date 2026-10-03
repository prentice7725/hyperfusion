# HyperFusion

Codex가 계획과 최종 검수를 맡고, 외부 CLI가 구현과 테스트를 수행하는 Codex Skill.

기본 리드는 **GPT-6.1 Sol / reasoning high**, 기본 외부 실행자는 **Claude Code**다. Luna는 검수 후 작은 조사·수정에만 사용한다. 리드의 직접 구현은 기록된 takeover에서만 허용한다.

## 상태 — v0.2.1 prototype

| 기능 | 상태 |
|---|---|
| Claude subprocess bridge / task-scoped resume | 구현; 대역 CLI 검증 |
| 단일 writer / snapshot / result 검증 / review / recovery | 구현 |
| Luna helper | native collaboration 도구 descriptor |
| Lead takeover | 명시적 이유와 writer lease |
| Grok / Antigravity / auto-routing | 미구현; 선택 시 명시적 오류 |
| 실제 Claude 인증·모델 호출 | 이 패키지의 테스트로 검증되지 않음 |

이 스킬은 현재 대화의 모델·reasoning 설정을 강제로 전환하지 않는다. 호스트에서 GPT-6.1 Sol/high를 선택한다. Claude가 종료되거나 RESULT_READY를 반환해도 최종 작업 성공은 아니며, 리드의 검수·검증 후 CLOSE가 필요하다.

## 설치와 사용

Node.js 20 이상, Git, 초기 커밋이 있는 대상 저장소가 필요하다. Claude 브리지는 POSIX 환경에서 설치·인증된 Claude Code를 사용한다. 필요 flag가 없는 버전은 preflight에서 거절한다.

Codex CLI의 개인 스킬 디렉터리에 설치:

```sh
git clone https://github.com/prentice7725/hyperfusion.git ~/.codex/skills/hyperfusion
```

Codex에서 호출:

```text
$hyperfusion <작업 내용>
$hyperfusion --executor claude <작업 내용>
```

이는 스킬 호출 문법이다. 독립 실행형 hyperfusion 명령이나 자율 daemon을 제공하지 않는다. Lead가 `SKILL.md`에 따라 brief를 만들고 controller 및 bridge를 호출한다.

기본 executor는 대상 저장소의 `hyperfusion.config.json`으로 설정한다. 예시는 `hyperfusion.config.example.json`에 있다. provider 목록은 어댑터가 실제 구현되었다는 뜻이 아니다. 기존 `lead: astra` 설정은 Sol/high로 읽으며, 기존 작업 lease는 임의로 변경하지 않는다.

자세한 실행 순서: [SKILL.md](SKILL.md), [runtime](references/runtime.md), [Claude runtime](references/claude-runtime.md).

## 테스트

```sh
npm test
# 또는
node --test tests/*.test.mjs
```

36개 테스트가 정상 실행, 동일 세션 재개, 중복 실행 차단, 오류·timeout·결과 검증, helper/takeover budget, Sol/high 설정 및 실패 비용 집계를 확인한다. 테스트의 Claude CLI는 명시적으로 표시된 대역이며 실제 Claude 모델을 호출하지 않는다. GitHub Actions가 실행 결과를 별도로 기록한다.

## 완료보고 진단

대상 저장소 `.fusion/tasks/<task_id>/`를 확인한다.

- `claude-envelope-N.json`: 종료 코드, 중단 이유, 원본 stdout/stderr
- `claude-result-N.json`: 검증된 structured result
- `.fusion/state.json`: lead 검수·완료 상태

현재 수집기는 성공 envelope의 `structured_output`을 검증한다. 다른 형태의 출력, malformed JSON, 세션 불일치, 권한 거절 또는 실패 envelope는 성공으로 처리하지 않는다. 결과 파일 부재만으로 미보고 종료를 단정하지 말고 원본 envelope를 확인한다. bridge 결과 수집 실패 뒤 같은 launch를 재실행하지 않고 recovery protocol을 따른다.

## 운영 원칙

writer는 한 명이다. 작업 중 lead나 helper가 같은 tree를 동시에 수정하지 않는다. lock은 협업 통제이며 OS sandbox가 아니다. 자동 commit/push/deploy/release, 범위 확장과 destructive recovery를 제공하지 않는다.

목표 지표는 **성공 작업당 Codex 사용량(lead + Luna)**이다. 실패 작업 사용량도 포함하고, 외부 비용·소요 시간·성공률·회귀는 별도로 기록한다. 측정되지 않은 값은 null이다.

실행 로그·session·인증정보는 이 소스 저장소에 포함하지 않는다. `.fusion/`은 대상 저장소의 비공개 로컬 작업 기록이다.
