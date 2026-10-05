# 기억 계층: AnchorMind (파일럿)

[AnchorMind](https://github.com/jinho-von-choi/memento-mcp)(구 memento-mcp)를 **에이전트들의 장기 작업기억**으로만 쓴다. 정본이 아니다.

```
Google Drive SOT ── 최종 권위 (설계 정본)
Git ─────────────── 실제 구현
Notion ──────────── 관제 / 상태
──────────────────────────────
AnchorMind ──────── "지난번에 왜 이렇게 했지?" "그 에러 해결한 적 있지 않나?" "여기선 어떻게 검증했지?"
   ↓ (리드가 SOT·Git과 대조해 고른 것만)
Grok / Antigravity / Sonnet
```

행동 규칙(SOURCE FIRST, 실패한 게이트를 넘지 않는다, Drive SOT 우선 등)은 계속 CLAUDE.md, AGENTS.md, 스킬, 훅에 둔다. AnchorMind도 주입된 기억은 지침 파일보다 우선순위가 낮다고 명시한다. 기억에는 사실과 경험만 넣는다.

## 왜 리드가 문지기인가

AnchorMind는 처음 잘못 저장된 기억을 스스로 판별하지 못한다. 나중에 모순되는 기억이 들어와야 탐지된다. 또 LongMemEval-S에서 검색 recall_any@5는 88.3%지만 QA 정확도는 44.9%다. **찾기는 잘하지만, 여러 기억을 종합해 결론 내리는 건 약하다.** 그래서 이렇게 나눈다.

- **일꾼:** AnchorMind에 직접 접근하지 않는다. 결과에 `memory_candidates`로 교훈을 최대 3개 **제안**만 한다.
- **컨트롤러:** 작업이 끝나면(CLOSE/BLOCKED) 리뷰 기록에서 "실패 → 원인 → 수정 → 검증"을 후보로 자동 추출한다.
- **리드:** 후보를 보고 승인·수정·기각한다. 승인분만 저장된다. 검색 결과도 리드가 SOT·Git과 대조한 뒤에만 brief에 넣는다.

## 무엇을 저장하나

| 종류 | 누가 | 비고 |
|---|---|---|
| decision | 리드 | 예: "Pixel pipeline에서 Qwen2.1 제외, Anima + Krea2 기본" |
| error | 일꾼·프로토콜·리드 | 실패와 원인, 해결. 가장 값진 자산 |
| procedure | 일꾼·프로토콜·리드 | 예: "Generation → Technical Gate → Human Review → Golden 승인" |
| episode | 일꾼·프로토콜·리드 | 예: "P4 원화 2개 모두 점유율·bow/arm separation으로 FAIL" |
| preference | 리드 | 예: "사람이 매번 prompt를 읽는 방식보다 기계적 검증 절차 선호" |
| fact | △ 리드는 사유 필수, 일꾼은 제안만 | 정본에 있는 사실의 사본이 되지 않게 |
| relation | △ 리드, 사유 필수 | |

**금지:** GDD 전체나 설계 문서 저장, SOT 대체, 최신 구현 상태의 권위 소스로 쓰기, API 키·비밀번호·토큰.
비밀값 패턴은 내용과 상관없이 거절한다. 한 기억은 400자(1~2문장) 이하다.

**anchor(감쇠·만료 없음):** `PROJECT_NAME`, `SOT_LOCATION`, `GIT_REPO`, `NON_NEGOTIABLE_RULE`, `CURRENT_ENGINE` 6개 키만 허용하고, 리드만 붙일 수 있다. `NON_NEGOTIABLE_RULE` anchor는 규칙 본문이 아니라 "규칙은 CLAUDE.md의 어디에 있다"는 가리킴이어야 한다. 나머지 기억은 모두 감쇠 대상이다.

**신뢰 표시(`assertionStatus`):** 검증을 통과해 닫힌 작업에서 프로토콜이 뽑은 기록만 `verified`다. 일꾼 제안과 리드 추가는 `inferred`다. `rejected`인 기억은 recall 결과에서 빼고 일꾼에게 넘기지 않는다.

## 설정

`hyperfusion.config.json`(프로젝트마다 workspace 분리, 필수):
```json
{"memory": {"workspace": "hyperfusion", "recall_limit": 8}}
```
권장 workspace 예: `asset-pipeline`, `gochachara-godot`, `margrave-history`, `shop-game`, `sky-rendezvous`, `hyperfusion`.

서버 주소와 키는 사용자 환경변수로만 받는다(저장소에 두지 않는다):
```powershell
setx HF_MEMORY_URL "http://localhost:57332/mcp"
setx HF_MEMORY_KEY "<AnchorMind access key>"
```
`memory.workspace`가 없으면 기억 기능 전체가 꺼진다. `setup-doctor`의 `memory` 항목에서 연결 상태를 볼 수 있다(실패해도 전체 점검을 막지 않는다).

## 리드 흐름

```sh
# 작업 시작 전: 핵심 기억(anchor)과 관련 경험 검색
node $HF_SKILL/scripts/memory.mjs context $HF_REPO
node $HF_SKILL/scripts/memory.mjs recall $HF_REPO "bow-arm separation 실패 사례" --type error
#   → SOT·Git HEAD와 대조해 맞는 것만 brief.prior_experience에 복사 (최대 12개)

# 작업 종료 후(CLOSE/BLOCKED): 후보 확인 후 승인
node $HF_SKILL/scripts/memory.mjs candidates $HF_REPO
node $HF_SKILL/scripts/memory.mjs commit $HF_REPO COMMIT.json
```

`COMMIT.json`:
```json
{
  "accept": ["m1", "m3"],
  "reject": ["m2"],
  "edits": {"m3": {"content": "더 짧고 정확하게 고친 문장"}},
  "add": [
    {"type": "decision", "content": "Pixel pipeline excludes Qwen2.1; Anima + Krea2 are default generators", "importance": "high"},
    {"type": "fact", "content": "Design SOT is the GDD folder in Google Drive", "anchor_key": "SOT_LOCATION", "reason": "pointer for agents"}
  ]
}
```
- 고친 내용도 같은 규칙으로 다시 검사한다.
- 저장되는 키워드에는 `hf:<task>`, `src:<worker|protocol|lead>`, `by:<일꾼>`이 붙어 출처를 추적할 수 있다.
- `add`로 넣은 항목은 리드 작성분이라 바로 저장된다.

## 서버 인자

인자 이름을 추측하지 않는다. 접속할 때 `tools/list`로 받은 실제 스키마에 있는 이름만 채운다(예: recall의 질의는 `text`, anchor는 `isAnchor`). 서버가 요구하는 인자를 채울 수 없으면 명시적으로 실패한다. importance는 스키마의 범위에 맞춰 low/medium/high를 숫자로 바꾼다.

## 파일럿 범위

HyperFusion 저장소 하나에서 먼저 쓴다. 효과(같은 실수 반복 감소, 리드 토큰 감소)가 보이면 Asset Pipeline으로 넓힌다. 전 프로젝트에 한꺼번에 깔지 않는다.
