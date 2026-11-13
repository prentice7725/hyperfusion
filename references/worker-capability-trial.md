# 일꾼 역량 시험 (실험 계획)

상태: 계획. 아직 돌리지 않았다. 실행 도구 `tools/worker-trial.mjs`는 가짜 CLI로만 시험했고 실제 모델로는 돌려 보지 않았다.

## 무엇을 정하려는가

지금 A급·B급은 모델 이름을 보고 손으로 나눴다([배치](routing.md)). 같은 과제를 일꾼마다 따로 시켜 보고 배치표를 고친다.

| 번호 | 질문 | 답에 따라 바뀌는 것 |
|---|---|---|
| Q1 | Gemini 4 Hydrogen을 A급으로 올릴 만한가 | `member-registry.mjs`의 antigravity 등급, 배치표의 `code` medium·high 줄 |
| Q2 | A급 안의 순서 Terra → Grok → Sonnet이 맞는가 | 배치표의 A급 투입 순서 |
| Q3 | Hydrogen이 3.8 Flash보다 실제로 나은가 | antigravity 기본 모델 |

B급끼리의 순서(Luna·Haiku), `ui`·`docs`·`image-asset` 칸은 이번에 다루지 않는다. 큰 과제가 전부 `code`/`high`라 답이 나오지 않는다.

## 비교 대상

| label | 일꾼 | 모델 | 강도 | 지금 등급 |
|---|---|---|---|---|
| `terra` | terra | 기본(gpt-6.1-terra) | 기본(medium) | A |
| `grok` | grok | 기본(Grok 4.7) | 기본(high) | A |
| `sonnet` | sonnet | 기본(claude-sonnet-5-5) | 기본(medium) | A |
| `flash38` | antigravity | `gemini-3.8-flash` | high | B |
| `hydrogen` | antigravity | `gemini-4-hydrogen` | high | 미정 |

A급 셋은 모델과 강도를 지정하지 않는다. 평소 배치에서 쓰는 기본값 그대로 재야 배치표에 옮길 수 있다. 실제로 쓰인 모델과 강도는 기록의 `usage.model`, `usage.reasoning_effort`에 남으니 돌린 뒤 확인한다.

## 과제와 횟수

큰 과제 다섯 개(`HF-L01`~`HF-L05`, 모두 `code`/`high`)를 대상마다 **두 번씩** 돌린다. 5개 대상 × 5개 과제 × 2회 = 50회다.

한 번의 시험은 이렇다. 리드와 리뷰어는 부르지 않는다.

```text
과제 준비(수용 테스트가 먼저 실패하는지 확인) → 일꾼 한 라운드 → finish(수용 테스트 실행) → 숨김 시험 채점
```

반려와 재지시가 없으므로 재는 것은 **첫 라운드 실력**이다. 재지시를 받아 고치는 능력은 이 시험에 나오지 않는다.

## 재는 것

`tools/worker-trial.mjs`가 시험마다 한 줄씩 기록한다.

| 항목 | 기록 필드 | 뜻 |
|---|---|---|
| 수용 테스트 통과 | `acceptance_passed` | finish 뒤 단계가 `REVIEW`면 통과 |
| 숨김 시험 | `score.hidden_passed`, `score.hidden_failed`, `score.all_hidden_passed` | 일꾼이 보지 못한 시험. 주 지표 |
| 범위 밖 수정 | `score.scope_violations`, `score.scope_files` | 고쳐도 되는 경로 밖의 변경 파일 수 |
| 걸린 시간 | `usage.wall_ms` | 일꾼 프로세스가 돈 시간 |
| 토큰 | `usage.*_tokens` | CLI가 보고한 값. 보고하지 않는 CLI는 비어 있다 |
| 깨진 시험 | `stage`, `error` | 어느 단계에서 왜 멈췄는지 |

도중에 깨진 시험도 기록에 남고 실패로 센다. 빼면 통과율이 부풀려진다.

## 판정 기준

**돌리기 전에 아래 숫자를 확정하고, 결과를 본 뒤에는 바꾸지 않는다.** 적어 둔 값은 제안이다.

**Q1. Hydrogen 승격.** 셋을 모두 만족하면 A급으로 올린다.

1. `all_hidden_passed` 횟수(10회 중)가 A급 셋 중 가장 낮은 대상 이상이다.
2. 범위 밖 수정이 있는 시험이 0회다.
3. 오류로 끝난 시험(`errored`)이 A급 셋 중 가장 많은 대상보다 많지 않다.

하나라도 못 미치면 B급에 둔다. 1번만 한 회 차이로 못 미쳤으면 "보류"로 적고 세 번째 회차를 돌린 뒤 정한다.

**Q2. A급 순서.** `all_hidden_passed` 횟수가 **3회 이상** 차이 날 때만 순서를 바꾼다. 그보다 작으면 지금 순서를 둔다. 10회짜리 표본에서 한두 회 차이는 우연과 구분되지 않는다. README의 실측에서도 같은 과제가 회차마다 크게 흔들렸다.

**Q3. 기본 모델.** Hydrogen의 `all_hidden_passed` 횟수가 3.8 Flash 이상이고 범위 밖 수정이 더 많지 않으면 antigravity 기본 모델을 Hydrogen으로 바꾼다.

시간은 판정에 넣지 않고 함께 보고한다. 통과 횟수가 같은 대상끼리만 중앙값이 빠른 쪽을 앞에 세울 근거로 쓴다.

## 돌리기 전에 확인할 것

```sh
# 1. 이 도구가 들어 있는 최신 코드를 받는다. 과제 원본 커밋이 필요하므로 전체 이력이 있어야 한다.
git pull
git rev-parse --is-shallow-repository        # false 여야 한다

# 2. 일꾼 CLI가 지금 버전에서도 계약대로 도는지 본다(아주 작은 실제 작업, 비용 조금).
node scripts/setup-doctor.mjs . --smoke=terra,grok,sonnet,antigravity

# 3. agy가 두 모델을 모두 내놓는지 본다. 강도가 붙은 이름으로 나온다.
agy models                                   # gemini-3.8-flash-high, gemini-4-hydrogen-high 가 있어야 한다

# 4. 숨김 시험이 과제마다 있고 유효한지 본다(기준 커밋에서는 통과, 그 전 트리에서는 실패).
node scripts/benchmark.mjs check-hidden HF-L01     # L02~L05도 같은 식으로
```

- 3번에서 Hydrogen이 목록에 없으면 그 대상의 시험은 `MODEL_UNLISTED`로 시작 전에 멈춘다. 다른 모델로 자동 대체되지 않는다.
- 4번에서 `valid`가 `false`인 과제는 뺀다. 숨김 시험은 `~/.hyperfusion/benchmark-hidden/<과제>/`에 있다.
- 코덱스 주간 한도가 돌아왔는지 본다. Terra가 10회를 쓴다.

## 실행

시험 한 번의 명령이다. 저장소 폴더는 **없는 경로**여야 한다. 있는 폴더는 덮어쓰지 않고 거절한다.

```sh
node tools/worker-trial.mjs run HF-L01 ../hf-trials/l01-hydrogen-1 --worker antigravity --model gemini-4-hydrogen --effort high --label hydrogen --out ../hf-trials/trials.jsonl
```

50회를 한 번에 도는 묶음이다. 회차 1을 전부 마친 뒤 회차 2로 넘어가고, 과제마다 대상 순서를 한 칸씩 돌려 같은 대상이 늘 먼저 돌지 않게 한다.

PowerShell:

```powershell
$out = "..\hf-trials"; New-Item -ItemType Directory -Force $out | Out-Null
$arms = @(
  @{label="terra";    args=@("--worker","terra")},
  @{label="grok";     args=@("--worker","grok")},
  @{label="sonnet";   args=@("--worker","sonnet")},
  @{label="flash38";  args=@("--worker","antigravity","--model","gemini-3.8-flash","--effort","high")},
  @{label="hydrogen"; args=@("--worker","antigravity","--model","gemini-4-hydrogen","--effort","high")}
)
$cases = "HF-L01","HF-L02","HF-L03","HF-L04","HF-L05"
foreach ($rep in 1,2) {
  for ($c = 0; $c -lt $cases.Count; $c++) {
    for ($i = 0; $i -lt $arms.Count; $i++) {
      $arm = $arms[($i + $c + $rep) % $arms.Count]
      $repo = "$out\$($cases[$c].ToLower())-$($arm.label)-$rep"
      if (Test-Path $repo) { continue }   # 이미 돈 시험은 건너뛴다(중단 뒤 이어 돌리기)
      node tools/worker-trial.mjs run $cases[$c] $repo @($arm.args) --label $arm.label --timeout-min 60 --out "$out\trials.jsonl" | Out-Null
    }
  }
}
node tools/worker-trial.mjs summary "$out\trials.jsonl"
```

bash:

```sh
out=../hf-trials; mkdir -p "$out"
labels=(terra grok sonnet flash38 hydrogen)
args=("--worker terra" "--worker grok" "--worker sonnet" \
      "--worker antigravity --model gemini-3.8-flash --effort high" \
      "--worker antigravity --model gemini-4-hydrogen --effort high")
cases=(HF-L01 HF-L02 HF-L03 HF-L04 HF-L05)
for rep in 1 2; do for c in 0 1 2 3 4; do for i in 0 1 2 3 4; do
  a=$(( (i + c + rep) % 5 )); case_id=${cases[$c]}
  repo="$out/$(echo "$case_id" | tr A-Z a-z)-${labels[$a]}-$rep"
  [ -e "$repo" ] && continue
  node tools/worker-trial.mjs run "$case_id" "$repo" ${args[$a]} --label "${labels[$a]}" --timeout-min 60 --out "$out/trials.jsonl" >/dev/null
done; done; done
node tools/worker-trial.mjs summary "$out/trials.jsonl"
```

돌리는 동안 지킬 것:

- **한 번에 하나씩 돌린다.** 여러 개를 동시에 돌리면 걸린 시간이 서로 섞이고, 같은 회사 모델끼리는 한도에 걸린다. 시간이 급하면 회사가 다른 대상끼리만 터미널을 나눠 돌리고, 그렇게 했다고 결과에 적는다.
- **시험 폴더를 지우고 다시 돌리지 않는다.** 결과가 마음에 안 들어 다시 돌린 것과 구분되지 않는다. 한도 초과나 로그인 만료처럼 일꾼 실력과 무관한 이유로 깨진 시험만, 이유를 적고 새 폴더 이름(`…-1b`)으로 다시 돌린다.
- 한 시험은 60분에서 끊는다. 끊긴 시험은 실패로 센다.
- 시험 저장소의 작업 상태는 평소처럼 `~/.hyperfusion/state/`에 쌓인다. 끝난 뒤 시험 폴더와 함께 지워도 된다.

## 결과 읽기

`summary`가 대상별로 한 줄씩 준다.

```json
{"label": "hydrogen", "trials": 10, "errored": 0, "unscored": 0, "acceptance_passed": 9,
 "all_hidden_passed": 8, "hidden_tests_passed": 47, "hidden_tests_total": 50,
 "scope_violation_trials": 0, "median_worker_wall_min": 14.2,
 "by_case": {"HF-L01": ["5/5", "5/5"], "HF-L02": ["4/5", "5/5"]}}
```

(숫자는 형식을 보여 주는 예시다.)

- 판정에는 `all_hidden_passed`를 쓴다. `hidden_tests_passed`는 시험 개수가 많은 과제에 끌려가므로 참고만 한다.
- `unscored`가 0이 아니면 그 시험의 `score_error`를 먼저 본다. 채점하지 못한 시험은 통과로도 실패로도 세지 않았다.
- `by_case`에서 한 과제만 모든 대상이 실패하면 일꾼이 아니라 과제나 숨김 시험을 의심한다.
- 판정 뒤 이 문서 끝에 날짜, 환경, 요약 표, 판정을 적는다.

## 결과를 반영할 곳

| 판정 | 고칠 곳 |
|---|---|
| Hydrogen 승격 | `scripts/member-registry.mjs`의 antigravity `grade`와 `role`, `references/routing.md`의 등급 설명과 배치표, README 세 개의 팀 표 |
| antigravity 기본 모델 변경 | `references/configuration.md`의 기본값 설명, `scripts/model-registry.mjs`에 `gemini-4-hydrogen` 항목 |
| A급 순서 변경 | `scripts/router.mjs`의 배치표, `references/routing.md` |

등급을 바꾸면 B급에서 A급으로 넘기는 규칙과 리뷰 짝([review-pairs](review-pairs.md))이 함께 움직이는지 `tests/router.test.mjs`, `tests/worker-tiers.test.mjs`로 확인한다.

## 한계

- **표본이 작다.** 대상마다 10회다. 판정 기준을 "3회 이상 차이"로 잡은 까닭이다. 통계적 증명이 아니다.
- **과제가 한 종류다.** 다섯 개 모두 이 저장소의 Node 코드이고 난이도 `high`다. 다른 언어, UI, 문서 작업의 실력은 알 수 없다.
- **첫 라운드만 본다.** 실제 운영에서는 반려와 재지시가 있다. 첫 라운드에서 조금 모자라도 재지시를 잘 따르는 일꾼은 여기서 손해를 본다.
- **숨김 시험은 협조에 기대어 숨겨져 있다.** 셸을 쓰는 일꾼은 홈 폴더의 숨김 시험에 닿을 수 있다. 결과가 이상하게 좋으면 일꾼 출력에서 그 경로를 읽었는지 찾아본다.
- **과제의 원본이 공개 저장소의 커밋이다.** 모델이 학습 때 이 커밋을 봤을 가능성을 배제하지 못한다. 새 모델일수록 유리할 수 있다.
- **시간은 그날의 서버 사정을 탄다.** 하루에 다 돌려도 대상마다 도는 시각이 다르다.
- **비용은 비교하지 않는다.** 구독과 API 요금이 섞여 있어 토큰 수를 돈으로 옮기지 않는다.

## 결과

(돌린 뒤 적는다.)
