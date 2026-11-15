# 일꾼 호출 조절 (설계 초안)

상태: 초안. 구현하지 않았다. 번호 HF-I10은 가칭이다. 정할 것 다섯 가지는 2026-11-15에 정했다(문서 끝).

## 왜 필요한가

2026년 11월 들어 Antigravity(`agy`) 계정이 약관 위반으로 정지됐다는 보고가 구글 개발자 포럼에 여럿 올라왔다. 정지되면 `agy`와 Gemini CLI가 403으로 막히고, 이의 신청은 계정당 한 번이며 복구 뒤 다시 걸리면 영구 정지다.

HyperFusion은 토큰을 꺼내 쓰지 않고 공식 `agy` 바이너리를 헤드리스로 띄운다. 구글 직원은 이 방식을 의도된 사용이라고 답했지만, 조건으로 "개인이 자기 컴퓨터에서 쓸 것"과 "빠른 반복 호출을 피할 것"을 달았다. 같은 방식으로 쓰다 정지됐다는 사례도 있다. 정지의 실제 원인은 확인할 수 없다.

- [Antigravity 추가 약관 6조](https://antigravity.google/terms)
- [로컬 오케스트레이터가 agy를 띄워도 되는가에 대한 답변 (2026-10-05)](https://discuss.ai.google.dev/t/is-automatically-launching-the-official-agy-cli-from-a-local-ai-orchestrator-allowed-under-additional-terms-6/186954)
- [헤드리스 1회 실행 뒤 정지 사례 (2026-11-03)](https://discuss.ai.google.dev/t/appeal-request-antigravity-cli-suspended-no-third-party-oauth-client/197943)
- [스크립트로 agy를 여러 개 동시에 돌린 뒤 정지 사례 (2026-11-12)](https://discuss.ai.google.dev/t/appeal-submitted-antigravity-cli-403-after-headless-reviews-run-by-my-ai-assistant-all-automated-agy-use-removed/199919)

지금 HyperFusion에는 호출 모양을 다스리는 장치가 없다. 오토파일럿은 재지시와 리뷰로 같은 CLI를 쉬지 않고 연달아 부르고, 읽기 전용 작업([read-only-work](read-only-work.md))과 시험 묶음은 같은 CLI를 동시에 띄울 수 있다.

이 초안은 세 가지를 더한다.

| 장치 | 하는 일 | 켜는 법 |
|---|---|---|
| 자리 제한 | 일꾼이 맡을 수 있는 자리를 구현·리뷰·상담 중에서 좁힌다 | 팀 파일 |
| 호출 간격 | 같은 CLI를 한 번에 하나만 띄우고, 끝난 뒤 정한 시간만큼 쉰다 | 팀 파일 |
| 정지 차단기 | 계정 정지 응답을 보면 그 CLI를 이 컴퓨터에서 더 부르지 않는다 | 항상 켜짐 |

**이것은 정지를 막아 준다는 보장이 아니다.** 구글이 무엇을 보고 정지하는지 모른다. 보고된 사례에서 공통으로 나온 모양(짧은 호출의 반복, 동시 실행)을 줄일 뿐이다.

## 어디에 적는가

이 컴퓨터의 팀 파일(`~/.hyperfusion/team.json`)에 적는다. 계정과 구독은 저장소가 아니라 컴퓨터에 묶여 있고, 팀 파일은 이미 "쓸 수 있는 것을 좁히기만 하는" 운영자 파일이다([팀 파일](configuration.md#이-컴퓨터의-팀-파일-hyperfusionteamjson)). 저장소 설정(`hyperfusion.config.json`)으로는 풀 수 없다.

```json
{
  "version": 1,
  "members": {
    "antigravity": {
      "enabled": true,
      "seats": ["implement"],
      "min_interval_s": 300
    }
  }
}
```

두 키 모두 antigravity 전용이 아니다. 어느 일꾼에나 적을 수 있다. 적지 않으면 지금과 똑같이 동작한다.

## 자리 제한 (`seats`)

`seats`는 `implement`, `review`, `consult` 중 하나 이상의 목록이다. 없으면 셋 다다.

리뷰와 상담은 짧게 자주 부르는 자리다. 구현만 남기면 호출 한 번에 큰 일을 맡기게 되어, 같은 토큰을 더 적은 호출로 쓴다.

적용 지점:

| 지점 | 자리가 없을 때 |
|---|---|
| 구현 배치(`router`, `canWork`) | 후보에서 뺀다. 근거에 `seat-excluded: <일꾼>`을 남긴다 |
| 리뷰·상담 자동 선택(`consult`, `delegate-review`) | 건너뛰고 다음 순번으로 간다 |
| 리드가 이름으로 지정 | `SEAT_POLICY: antigravity does not take review on this machine`으로 거절한다 |
| 적응형 리뷰의 필수 리뷰어 계산(`review-plan`) | 팀 후보에서 뺀 뒤 계산한다 |
| 읽기 전용 작업 계획(`read-only-plan`) | 상담 자리로 보고 같은 규칙을 쓴다 |

지키는 것:

- 자리 제한 때문에 필수 리뷰어를 채울 수 없으면 지금처럼 오류로 멈춘다. 리뷰어 수를 줄이거나 통과로 바꾸지 않는다.
- 설정은 지금처럼 init 때 고정된다. 진행 중인 작업에는 적용되지 않는다.
- `enabled:false`인 일꾼에 `seats`를 적으면 팀 파일 검증에서 거절한다(뜻이 없는 조합).
- `reviewers` 목록에 든 일꾼의 `seats`에 `review`가 없으면 검증에서 거절한다.

## 호출 간격 (`min_interval_s`)

`min_interval_s`는 0 이상 3600 이하의 정수(초)다. 0이나 없음은 조절하지 않는다는 뜻이다. 값이 1 이상이면 그 CLI에 두 규칙이 걸린다.

1. **한 번에 하나.** 같은 CLI 바이너리의 프로세스를 이 컴퓨터에서 동시에 둘 이상 띄우지 않는다. 저장소가 달라도, 세션이 달라도 같다.
2. **끝난 뒤 쉬기.** 앞선 프로세스가 끝난 시각부터 `min_interval_s`가 지나야 다음을 띄운다.

단위는 일꾼 이름이 아니라 CLI 바이너리다. Sonnet과 Haiku는 둘 다 `claude`, Terra·Luna·Sol은 `codex`라서 한 계정의 호출로 함께 센다. 같은 CLI의 일꾼들이 다른 값을 적었으면 가장 큰 값을 쓴다.

### 기록

`~/.hyperfusion/pacing/<cli>.json` 하나와 잠금 파일 하나를 둔다(`HF_PACING_DIR`로 위치를 바꾼다).

```json
{"cli": "agy", "pid": 12345, "host": "DESKTOP-1", "started_at": "…", "ended_at": "…", "repo": "<저장소 식별자>", "task": "HF-example", "tag": "3"}
```

- 띄우기 직전에 잠금을 잡고 `started_at`을 쓰고, 프로세스가 끝나면 `ended_at`을 쓰고 잠금을 놓는다.
- 잠금 주인이 죽었으면(같은 호스트에서 그 pid가 없음) 다음 호출이 치운다. `control.lock`과 같은 방식이다. 이때 `ended_at`이 없으므로 치운 시각을 끝난 시각으로 본다.
- 다른 호스트의 잠금은 건드리지 않고 오류로 멈춘다.

### 기다리는 곳

브리지([executor-bridge.mjs](../scripts/executor-bridge.mjs))가 프로세스를 띄우기 직전에 기다린다. 구현 실행과 상담·리뷰 실행 모두 같은 곳을 지난다.

- 기다림은 일꾼의 실행 제한 시간(`timeout_ms`)에 넣지 않는다. 작업 전체 경과 시간 상한(`max_wall_ms`)에는 넣는다. 남은 시간이 기다림보다 짧으면 지금의 상한 규칙대로 띄우지 않는다.
- 기다리는 동안 리드를 깨우지 않는다. 활동 기록에 `pacing: waiting 212s for agy`를 한 줄 남기고, 실행 봉투(`envelope-N.json`)에 `paced_ms`를 적는다.
- 기다림 때문에 다른 일꾼으로 배치를 바꾸지 않는다. 바꾸면 남는 한도를 쓰려는 목적이 사라지고, 배치가 시각에 따라 달라져 재현하기 어려워진다.
- 중단 신호(SIGINT 등)가 오면 기다림을 끝내고 프로세스를 띄우지 않는다. `launch-N.json`은 기다림이 끝난 뒤에 쓰므로 띄우지 않은 실행은 표식이 남지 않는다.

### 모델 목록 조회

antigravity 어댑터는 설정한 모델이 있는지 `agy models`로 확인한다([checkModel](../scripts/adapters/antigravity.mjs)). 이것도 로그인이 필요한, 서버에 닿는 호출이다. 그리고 **일꾼 실행보다 훨씬 자주 일어난다.** 0.33.0부터 기본 설정에 모델(`gemini-4-hydrogen-high`)이 적혀 있어, antigravity를 probe할 때마다 `agy models`가 한 번 돈다. probe는 agy가 일하지 않는 작업에서도 여러 번 불린다.

| 부르는 곳 | 때 |
|---|---|
| [installation.mjs](../scripts/installation.mjs) `installationRoster` | init에서 설치 명단을 만들 때. 모든 작업 |
| [router.mjs](../scripts/router.mjs) | 배치 후보를 고를 때. 후보 전부를 probe한다 |
| [fusion-state.mjs](../scripts/fusion-state.mjs) begin, 교체 후보 점검(`cliBlocked` 주변), 상담 자리 선택 | 라운드마다 |
| [dispatch-verify.mjs](../scripts/dispatch-verify.mjs) | 브리지가 요청을 다시 만들어 비교할 때. agy 라운드마다 |
| `project.mjs`, `setup-doctor.mjs` | 팀 초안, 점검 |

그래서 이 조회는 간격 설정과 상관없이 **항상** 줄인다.

- 목록을 `~/.hyperfusion/pacing/agy-models.json`에 6시간 동안 넣어 두고, 이 컴퓨터의 모든 저장소와 작업이 같이 쓴다. 팀 파일에 아무것도 적지 않아도 그렇다.
- 넣어 둔 목록에 없는 모델만 한 번 새로 조회한 뒤 판정한다. 그래도 없으면 지금처럼 `MODEL_UNLISTED`다.
- 실행하지 않는 확인(설치 명단, 배치 후보, 교체 후보 점검, 재검증)은 넣어 둔 목록이 없을 때 조회하지 않고 `model_check: unverified`로 둔다. 새로 조회하는 것은 agy 라운드를 실제로 띄우기 직전(begin, 상담 선택)과 `setup-doctor`뿐이다.
- 새로 조회하는 것도 간격이 걸려 있으면 한 번에 하나 규칙과 간격을 따른다. 조회가 끝난 시각도 마지막 실행 시각으로 센다.
- `--help`와 `--version`은 서버에 닿지 않는 것으로 보고 조절하지 않는다(구현할 때 확인한다).

구현하면 한 작업에서 `agy models`가 몇 번 도는지 가짜 CLI로 세는 테스트를 둔다. agy가 일하지 않는 작업에서는 0번, agy 라운드 하나에서는 넣어 둔 목록이 없을 때 1번이어야 한다.

### 오토파일럿과 시험 묶음

- 오토파일럿은 고칠 것이 없다. 같은 단계를 밟되 브리지가 기다리는 만큼 느려진다.
- 시험 묶음(`worker-trial-batch`)도 브리지를 거치므로 그대로 적용된다. `--parallel`은 회사별로 한 줄씩이라 한 번에 하나 규칙과 부딪히지 않는다. 다만 시험 묶음은 같은 CLI를 몇 시간 동안 쉬지 않고 부르는, 보고된 정지 사례와 가장 닮은 모양이다. 그래서 antigravity 대상(`flash38`, `hydrogen`, `argon`)이 든 묶음은 `--allow-agy`가 없으면 시작하지 않는다. 2026-11-14~15에 돌린 시험에서 agy 라운드는 35회 띄웠다(역량 시험 30회와 중단 뒤 재실행 1회, Argon 4회 중 1회는 도중에 끊음). 그 밖에 probe마다 `agy models`가 돌았다.
- 읽기 전용 작업의 동시 자리 둘이 같은 CLI면 둘째가 첫째를 기다린다.

## 정지 차단기

실행의 stderr와 CLI가 돌려준 오류 메시지에서 계정 정지 문구를 찾는다. 사용량 한도를 알아보는 것([provider-limit.mjs](../scripts/provider-limit.mjs))과 같은 범위만 본다. 일꾼이 작업하며 쓴 출력은 보지 않는다.

- **종료 코드가 0이어도 본다.** agy는 실패를 종료 코드 0과 stderr 한 줄로 알리기도 한다(명령이 거부된 실행이 그랬다. `AGY_COMMAND_BLOCKED` 참고).
- **`agy models` 조회의 출력도 본다.** 정지된 계정은 일꾼 실행보다 이 조회에서 먼저 드러날 가능성이 높다. 조회는 init과 begin에서 일어나기 때문이다. `setup-doctor --smoke`의 실행도 같다.

```text
disabled in this account for violation of Terms of Service
TOS_VIOLATION
```

찾으면:

1. `~/.hyperfusion/pacing/<cli>-suspended.json`에 시각, 그 줄(200자까지, 비밀·이메일 가림), 저장소와 작업을 적는다.
2. 문구 목록은 CLI마다 두고 모든 CLI에 같은 코드로 적용한다. 지금 목록에는 구글 문구만 있어 사실상 `agy`에만 걸린다. 다른 회사의 정지 문구를 확인하면 목록에 더한다.
3. 그 CLI의 일꾼은 **이 컴퓨터의 모든 저장소에서** 설치되지 않은 것처럼 다룬다. 오류 문구는 `ADAPTER_UNAVAILABLE: ACCOUNT_SUSPENDED: agy reported a Terms of Service suspension at <시각>; it will not be launched again on this machine until an operator clears it`이다.
4. 진행 중인 라운드는 사용량 한도에 걸렸을 때와 같은 길로 다른 일꾼에게 넘긴다.
5. 리드에게 알림을 한 번 보낸다(`notify`).

지키는 것:

- **자동으로 풀지 않는다.** 시간이 지나도, 새 작업을 시작해도 그대로다. 정지된 계정으로 계속 요청을 보내면 두 번째 정지로 이어질 수 있다고 구글이 안내한다.
- **다른 계정으로 바꾸지 않는다.** 계정 전환은 보고된 정지 원인 가운데 하나다.
- 푸는 것은 운영자만 한다: `node scripts/setup-doctor.mjs REPO --clear-suspension agy`. 계정이 복구된 것을 확인한 뒤에 쓴다. `setup-doctor`의 보고에 정지 기록이 있으면 항상 보여 준다.
- 이 차단기는 팀 파일에 아무것도 적지 않아도 동작한다. 끄는 옵션은 두지 않는다.

문구는 포럼에 올라온 오류에서 가져왔다. 구글이 문구를 바꾸면 놓친다. 그 경우 일반 실패로 처리되어 지금과 같아진다.

## 하지 않는 것

- **자동화를 숨기지 않는다.** 간격에 무작위 값을 섞거나, 사람이 입력하는 것처럼 보이게 하거나, 클라이언트 정보를 바꾸지 않는다. 목적은 호출을 줄이는 것이지 탐지를 피하는 것이 아니다.
- 계정 여러 개를 돌려 쓰는 기능
- 하루 호출 횟수 상한(간격과 한 번에 하나 규칙을 써 본 뒤 필요하면 따로 다룬다)
- OAuth 토큰이나 `agy`의 인증 파일을 읽는 일
- 이미 있는 팀 파일을 고치는 일. 팀 파일에 적지 않으면 자리와 간격은 지금과 같다. 새로 쓰는 팀 파일에만 기본값이 들어간다(setup-doctor 참고)

## setup-doctor

- `--write-team`이 antigravity가 설치돼 있으면 그 항목에 `"seats": ["implement"]`, `"min_interval_s": 300`, `"note": "약관 정지 보고가 있다: references/worker-pacing-draft.md"`를 넣는다. 운영자는 고치거나 지울 수 있다. 이미 있는 팀 파일은 `--force` 없이는 바꾸지 않으므로 그대로다.
- antigravity가 켜져 있고 `min_interval_s`가 없으면 점검 결과에 경고 한 줄을 낸다. 실패로 치지 않는다.
- 조절 기록 폴더의 위치, CLI별 마지막 실행 시각, 정지 기록 유무를 보여 준다.

## 바뀌는 파일

| 파일 | 변경 |
|---|---|
| `scripts/team-file.mjs` | `seats`, `min_interval_s` 검증과 병합 |
| `scripts/worker-pacing.mjs` (새 파일) | 잠금, 기록, 기다림, 정지 기록 읽기·쓰기·지우기 |
| `scripts/executor-bridge.mjs` | 띄우기 직전 기다림, 끝난 뒤 기록, 정지 문구 확인 |
| `scripts/fusion-state.mjs` | `canWork`·`cliBlocked`·상담 선택에 자리 제한과 정지 기록 반영 |
| `scripts/router.mjs`, `review-plan.mjs`, `read-only-plan.mjs` | 자리 제한 |
| `scripts/adapters/antigravity.mjs` | 모델 목록을 컴퓨터 단위로 넣어 두고 재사용, 실행하지 않는 확인에서는 새로 조회하지 않음 |
| `scripts/installation.mjs`, `router.mjs`, `dispatch-verify.mjs` | probe가 모델 목록을 새로 조회하지 않게 함 |
| `tools/worker-trial-batch.mjs` | antigravity 대상에 `--allow-agy` 요구 |
| `scripts/setup-doctor.mjs` | 경고, 상태 표시, `--clear-suspension` |
| `references/configuration.md`, `routing.md`, README 세 개의 "안전에 대해" | 설명 |
| `tests/worker-pacing.test.mjs` | 새 테스트 |

## 테스트로 고정할 것

가짜 CLI와 가짜 시계로 한다. 실제로 기다리지 않는다.

- 팀 파일: 모르는 자리 이름, 빈 `seats`, 범위 밖 `min_interval_s`, 꺼진 일꾼의 `seats`, `review` 자리 없는 리뷰어는 거절된다.
- 자리 제한: 구현만 남긴 일꾼은 자동 리뷰·상담에서 빠지고, 이름으로 지정하면 `SEAT_POLICY`로 거절된다. 필수 리뷰어가 모자라면 통과가 아니라 오류다.
- 간격: 앞선 실행이 끝난 뒤 간격 안에는 띄우지 않고, 지나면 띄운다. `paced_ms`가 봉투에 남는다.
- 한 번에 하나: 같은 CLI의 두 번째 실행은 첫 번째가 끝날 때까지 프로세스를 만들지 않는다.
- 죽은 잠금은 치워지고, 다른 호스트의 잠금은 오류다.
- 기다리는 중에 중단하면 `launch-N.json`이 없다.
- 기다림이 `max_wall_ms`를 넘기면 띄우지 않는다.
- 정지 문구가 stderr에 있으면 정지 기록이 생기고, 다른 저장소의 새 작업에서도 그 CLI는 후보에서 빠진다. 일꾼이 쓴 파일이나 정상 출력에 같은 문구가 있어도 기록이 생기지 않는다.
- `--clear-suspension` 뒤에는 다시 후보가 된다.
- 정지 문구가 종료 코드 0인 실행의 stderr나 `agy models` 조회 출력에 있어도 정지 기록이 생긴다.
- `agy models` 횟수: agy가 일하지 않는 작업에서는 0번, agy 라운드 하나에서는 넣어 둔 목록이 없을 때 1번.
- 시험 묶음: antigravity 대상이 있는데 `--allow-agy`가 없으면 시작하지 않는다.
- 팀 파일에 두 키가 없으면 기존 테스트가 그대로 통과한다.

## 정한 것 (2026-11-15)

1. **`min_interval_s` 권장값은 300초다.** 근거 있는 숫자는 아니다. agy 라운드 하나가 보통 7~20분이라, 끝난 뒤 5분을 쉬면 시간당 두세 번으로 묶인다.
2. **간격은 끝난 시각부터 잰다.** 긴 실행 뒤에도 항상 쉰다.
3. **정지 차단기는 모든 CLI에 둔다.** 문구 목록만 CLI마다 다르다.
4. **`--write-team`이 antigravity에 `seats:["implement"]`와 `min_interval_s:300`을 처음부터 넣는다.** 이미 있는 팀 파일은 바꾸지 않고, doctor가 경고한다. 모델 목록 재사용과 정지 차단기는 팀 파일과 상관없이 항상 켠다.
5. **자리 제한은 팀 파일에만 둔다.** 저장소 설정으로는 넓히지도 좁히지도 않는다.
