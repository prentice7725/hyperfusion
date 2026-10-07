# 기억 계층 (AnchorMind 설계를 들여온 내장 작업기억)

[AnchorMind](https://github.com/jinho-von-choi/memento-mcp)의 설계를 벤치마킹해 HyperFusion 안에 직접 구현한 **에이전트 공유 장기 작업기억**이다. 외부 서버나 DB는 쓰지 않는다. 정본도 아니다.

```
Google Drive SOT ── 최종 권위 (설계 정본)
Git ─────────────── 실제 구현
Notion ──────────── 관제 / 상태
──────────────────────────────
HyperFusion 기억 ── "지난번에 왜 이렇게 했지?" "그 에러 해결한 적 있지 않나?" "여기선 어떻게 검증했지?"
   ↓ (리드가 SOT·Git과 대조해 고른 것만)
Grok / Antigravity / Sonnet
```

행동 규칙(SOURCE FIRST, 실패한 게이트를 넘지 않는다, Drive SOT 우선 등)은 계속 CLAUDE.md, AGENTS.md, 스킬, 훅에 둔다. 기억에는 사실과 경험만 넣는다.

## 들여온 설계

| AnchorMind 아이디어 | 이 구현 |
|---|---|
| fact/decision/error/preference/procedure/relation/episode fragment, 1~2문장 | 같음. 400자 상한 |
| workspace 격리 | `~/.hyperfusion/memory/<workspace>.json` 파일 단위(`HF_MEMORY_DIR`로 위치 변경). 쓰기 때마다 파일 잠금 + 원자적 저장 |
| context → recall → remember → reflect | `memory.mjs context / recall / commit / reflect` |
| 중복 병합 | 같은 종류이고 토큰 유사도 0.8 이상이면서 숫자·버전이 같으면 병합. 중요도를 올리고, 키워드·출처를 합치고, verified가 이긴다 |
| 모순 탐지 + 검토 대기열 | 주제가 겹치는데(유사도 0.3 이상) 한쪽만 부정하거나 숫자·버전이 다르면 `needs_review`. 리드가 `resolve`할 때까지 일꾼에게 안 간다. NLI 모델이 아닌 규칙 기반이라 판정하지 않고 표시만 한다 |
| importance decay | 종류별 반감기(일): error 120, procedure 180, decision·preference 365, episode 60, fact 90, relation 180. 마지막으로 만들어지거나 쓰인 때부터 잰다 |
| 재공고화 | recall에 걸린 기억은 사용 시각이 갱신돼 감쇠가 다시 시작된다 |
| TTL | `ttl_days`. 만료되면 검색에서 빠지고 reflect 때 archive로 간다 |
| 연상 확산 | 상위 결과와 링크됐거나 같은 작업(`hf:<task>`)에서 나온 기억을 0.3배 점수로 함께 꺼낸다(`via: association`) |
| provenance / assertion | 출처(일꾼·프로토콜·리드, 작업, 후보 ID)를 누적하고 verified/inferred/rejected를 표시한다. 기각된 내용은 같은 문장으로 다시 저장되지 않는다 |
| anchor | 허용 목록 6개 키만, 감쇠·만료 없음 |

검색은 벡터 임베딩 없이 BM25 계열 어휘 점수 × (0.5 + 감쇠된 중요도) × 신뢰도(verified 1.0, inferred 0.8)다. 한글은 글자 bigram도 색인해서 "팔분리"로 "활팔분리"가 걸린다. 의미가 비슷하지만 단어가 다른 기억은 놓칠 수 있다. 키워드를 붙여 보완한다.

## 리드가 문지기

처음 잘못 저장된 기억은 저장소가 스스로 판별하지 못한다(AnchorMind도 같다). 그래서 쓰기와 읽기 모두 리드를 거친다.

- **일꾼:** 기억 저장소에 접근하지 않는다. 결과에 `memory_candidates`로 교훈을 최대 3개 **제안**만 한다.
- **컨트롤러:** 작업이 끝나면(CLOSE/BLOCKED) 리뷰 기록에서 "실패 → 원인 → 수정 → 검증"을 후보로 자동 추출한다. AnchorMind의 reflect에 해당하는 단계다.
- **리드:** 후보를 승인·수정·기각한다. 승인분만 저장한다. 검색 결과도 SOT·Git과 대조한 뒤에만 brief의 `prior_experience`에 넣는다.

## 무엇을 저장하나

| 종류 | 누가 | 예 |
|---|---|---|
| decision | 리드 | "Pixel pipeline에서 Qwen2.1 제외, Anima + Krea2 기본" |
| error | 일꾼·프로토콜·리드 | "PixelOEPixelize+가 ModuleNotFoundError. 같은 구성으로 재시도 금지" |
| procedure | 일꾼·프로토콜·리드 | "Generation → Technical Gate → Human Review → Golden 승인" |
| episode | 일꾼·프로토콜·리드 | "P4 원화 2개 모두 점유율·bow/arm separation으로 FAIL" |
| preference | 리드 | "사람이 매번 prompt를 읽는 방식보다 기계적 검증 절차 선호" |
| fact / relation | △ 리드, 사유 필수 (fact는 일꾼 제안 가능) | 정본에 있는 사실의 사본이 되지 않게 |

- **금지:** GDD 전체·설계 문서 저장, SOT 대체, 최신 구현 상태의 권위 소스로 쓰기, API 키·비밀번호·토큰(패턴 차단).
- **anchor:** `PROJECT_NAME`, `SOT_LOCATION`, `GIT_REPO`, `NON_NEGOTIABLE_RULE`, `CURRENT_ENGINE`만 허용하고 리드만 붙인다. `NON_NEGOTIABLE_RULE`은 규칙 본문이 아니라 "규칙은 CLAUDE.md의 어디에 있다"는 가리킴이어야 한다.
- **verified:** 검증을 통과해 닫힌 작업에서 프로토콜이 뽑은 기록만 해당한다. 일꾼 제안과 리드 추가는 inferred다.

## 설정

`hyperfusion.config.json` (프로젝트마다 workspace를 반드시 분리):
```json
{"memory": {"workspace": "hyperfusion", "recall_limit": 8}}
```
권장 workspace 예: `asset-pipeline`, `gochachara-godot`, `margrave-history`, `shop-game`, `sky-rendezvous`, `hyperfusion`.

workspace가 없으면 기능 전체가 꺼진다. 같은 PC의 여러 세션과 일꾼이 같은 파일을 공유한다. `setup-doctor`의 `memory` 항목에 파일 위치와 활성·검토 대기·기각·보관 개수가 나온다.

## 리드 흐름

```sh
M="node $HF_SKILL/scripts/memory.mjs"
$M context $HF_REPO                                        # 세션 시작: anchor + 핵심 기억 + 검토 대기
$M recall  $HF_REPO "bow-arm separation 실패" --type error # 관련 경험 검색 → SOT·Git 확인 → prior_experience
# ... 작업 ...
$M candidates $HF_REPO                                     # 종료 후 후보 확인
$M commit  $HF_REPO COMMIT.json                            # 승인·수정·기각·추가
$M resolve $HF_REPO RESOLVE.json                           # 모순 정리: {"keep":"f…","drop":"f…"} 또는 {"reject":["f…"]}
$M reflect $HF_REPO                                        # 만료·잊힌 추정 기억 정리, 현황
$M forget  $HF_REPO f1a2b3c4                               # 잘못 저장된 기억 보관함으로
```

`COMMIT.json`:
```json
{
  "accept": ["m1", "m3"],
  "reject": ["m2"],
  "edits": {"m3": {"content": "더 짧고 정확하게 고친 문장"}},
  "add": [
    {"type": "decision", "content": "Pixel pipeline excludes Qwen2.1; Anima + Krea2 are default generators", "importance": "high"},
    {"type": "fact", "content": "Design SOT is the GDD folder in Google Drive", "anchor_key": "SOT_LOCATION", "reason": "pointer for agents"},
    {"type": "episode", "content": "Staging server on port 8081 this sprint", "ttl_days": 14}
  ]
}
```
- 고친 내용도 같은 규칙으로 다시 검사한다.
- 저장 결과는 `stored`, `merged`(기존과 병합), `needs_review`(모순 후보), `refused`(예전에 기각된 내용) 중 하나다.
- 키워드에는 `hf:<task>`, `src:<worker|protocol|lead>`, `by:<일꾼>`이 붙는다.

## 파일럿 범위

HyperFusion 저장소 하나에서 먼저 쓴다. 같은 실수 반복 감소와 리드 토큰 감소가 확인되면 Asset Pipeline으로 넓힌다.
