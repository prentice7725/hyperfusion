# 프로젝트: 팀 구성 → 보고 → 승인 → 마일스톤 → 체크포인트

리드(Opus)가 기획 문서를 읽고 **이 프로젝트를 누가 어떻게 할지** 팀을 꾸려 사용자에게 보고한다. 사용자가 승인하거나 고친 팀으로 마일스톤을 진행하고, 마일스톤마다 체크포인트 보고를 한다. 승인과 체크포인트 확인은 절차가 아니라 **컨트롤러가 강제**한다.

```
기획 문서 읽기 → roster → propose(팀 구성안) → [사용자 보고] → approve / amend
   → M1 작업들(init … verify) → 마일스톤 끝 → checkpoint(보고) → [사용자 확인] → ack → M2 …
```

## 팀원

| 팀원 | 모델 | 기본 역할 | 기본 담당 |
|---|---|---|---|
| sonnet | claude-sonnet-5-5 | 핵심 구현: 중·고난도 코드, 테스트 설계, 리팩터 | `code:medium\|high`, `tests`, `refactor` |
| grok | Grok CLI 기본 | 이미지 애셋 생성, 빠른 일반 구현 | `image-asset` |
| antigravity | agy 기본 | UI·프론트엔드, 문서 | `ui`, `docs` |
| luna | gpt-6-luna (Codex) | 쉬운 구현·소규모 수정, 기계적 대량 편집 | `code:low` |
| sol | gpt-6.1-sol (Codex) | 리뷰 전담(판정 책임), 위원회 상담. 코드는 쓰지 않음 | 리뷰 |

기본 역할은 출발점이다. 프로젝트마다 리드가 바꾼다. Sol과 Luna의 모델 ID는 `executors.sol.model`, `executors.luna.model`로 바꾼다(설치 환경에서 실제 ID를 확인할 것).

## 1. 구성안 작성 (`propose`)

리드는 기획 문서를 읽은 뒤 `project.mjs roster REPO`로 설치 상태를 보고 구성안을 쓴다.

```json
{
  "name": "Mado Ilbo",
  "summary": "신문 웹진 MVP. 기사 작성·발행과 표지 삽화.",
  "sources": ["docs/GDD.md", "docs/milestones.md"],
  "team": [
    {"member": "sonnet", "role": "핵심 구현", "owns": ["code:medium|high", "tests"], "why": "발행 로직이 까다로움"},
    {"member": "luna", "role": "쉬운 구현·소규모 수정", "owns": ["code:low", "docs"], "why": "빠르고 저렴"},
    {"member": "grok", "role": "삽화 애셋", "owns": ["image-asset"], "why": "이미지 생성"},
    {"member": "sol", "role": "리뷰 전담", "owns": [], "why": "Opus와 다른 계열의 교차 검증"}
  ],
  "excluded": [{"member": "antigravity", "why": "UI 작업이 없음"}],
  "milestones": [
    {"id": "M1", "title": "기반", "goal": "기사 모델과 저장", "checkpoint": ["기사 CRUD 테스트 통과"],
     "tasks": [{"id": "T1", "title": "기사 모델", "kind": "code", "difficulty": "high"}]}
  ],
  "risks": ["기사 스키마 미확정"],
  "questions": ["로그인이 필요한가?"]
}
```

규칙:
- **팀원 결정:** 다섯 팀원 모두 `team` 또는 `excluded`(이유 필수)에 들어가야 한다. 빠뜨린 건지 뺀 건지 보고서에서 구분되게 하려는 것이다.
- **담당 작업(`owns`):** `종류` 또는 `종류:난이도|난이도`. 같은 종류를 여러 명이 맡으면 `team` 순서가 투입 순서다.
- **Sol:** 담당 작업을 가질 수 없다. Sol이 팀에 있으면 리뷰는 자동으로 위임(`sol → 구현 팀원들`)된다.
- **원본 기록:** `sources`는 실제로 읽은 기획 문서다. 해시를 남긴다.
- **경고:** 담당자가 없는 작업 종류나 담당이 없는 팀원은 경고로 보고서에 실린다.

`propose`가 돌려주는 **팀 구성 보고서**(마크다운)를 사용자에게 그대로 보여 준다. 보고서에는 팀 표(모델·역할·담당·이유·설치 여부), 쓰지 않는 팀원과 이유, 리뷰 방식, 마일스톤별 작업과 1순위 담당, 체크포인트 기준, 위험, 질문이 들어간다.

## 2. 승인과 변경

- 사용자가 승인하면 `approve {"user_message":"그대로 가자"}`. **사용자가 실제로 한 말을 그대로 남긴다.** 승인 전에는 `init`이 `PROJECT_NOT_APPROVED`로 거절된다.
- 사용자가 고치라고 하면 `amend`로 반영하고, 새 보고서를 다시 보여 준다.
  - 팀·제외·리뷰·마일스톤 추가·문서 변경은 **재승인이 필요**하다(상태가 PROPOSED로 돌아가고 rev가 올라감).
  - 진행 중인 마일스톤에 작업 추가(`add_tasks`)나 미착수 작업 제외(`drop_tasks`, 이유 필수)는 재승인 없이 기록만 하고 체크포인트 보고에 드러난다.

```json
{"team": [ ... ], "excluded": [ ... ], "user_message": "grok은 빼고 luna한테 삽화도 맡겨"}
```

## 3. 진행

- `init`은 **현재 마일스톤에 계획된 작업 ID만** 받는다. 계획에 없는 작업은 `amend`로 먼저 추가한다.
- 작업의 종류·난이도는 계획에서 가져온다. 승인된 팀이 그 작업의 설정으로 고정된다.
  - 사용 가능 일꾼 = 팀의 구현 팀원
  - 배치표 = 팀의 담당
  - 리뷰 = 팀의 리뷰 방식
- 제외된 팀원은 그 프로젝트에서 불리지 않는다.
- 작업이 CLOSE·BLOCKED가 되면(어느 경로로든) 지표(제어 폴더의 `metrics/<task>.json`)가 자동으로 기록되고 마일스톤 진행이 갱신된다. 막힌 작업은 archive 없이도 다음 작업을 시작할 수 있고, archive 해도 `blocked`/`closed` 결과는 덮어쓰지 않는다.
- 팀 구성 보고서의 "1순위"와 경고는 실제 배치와 같은 규칙(`router.matchRule`)으로 계산한다. 난이도가 정해진 담당만 있는 종류에 난이도 없는 작업을 넣으면 "담당자가 없다"는 경고가 나오고 팀 기본 순서로 배치된다.

## 4. 체크포인트

- **보고 대기:** 마일스톤의 모든 작업이 끝나면(완료·막힘·보관·제외) 마일스톤이 `checkpoint_due`가 되고 알림이 간다. 다음 마일스톤의 작업은 `PROJECT_CHECKPOINT_PENDING`으로 막힌다.
- **보고서 생성:** `checkpoint`가 보고서를 만든다. 작업별 결과, 투입 팀원과 횟수, 라운드, 리뷰(위임·리드 덮어쓰기), takeover, 팀원별 통과율, 체크포인트 기준, 막힌 작업, 구성 조정 제안(통과율 낮은 팀원), 다음 마일스톤이 들어간다. 리드는 체크포인트 기준을 직접 확인한 결과를 덧붙여 보고한다.
- **사용자 확인:** `ack {"milestone":"M1","user_message":"다음으로"}`로 다음 마일스톤이 열린다. 마지막이면 프로젝트가 COMPLETE가 되고 게이트가 풀린다. 확인과 함께 팀 변경을 지시받으면 `changes`에 담는다. 이 경우 재승인 후 진행한다.

## 명령

```sh
P="node $HF_SKILL/scripts/project.mjs"
$P roster $HF_REPO               # 팀원·모델·기본 역할·설치 여부
$P propose $HF_REPO PLAN.json     # 구성안 저장 + 팀 구성 보고서
$P report $HF_REPO                # 현재 구성안 보고서 다시 보기
$P approve $HF_REPO APPROVE.json  # {"user_message": "..."}
$P amend $HF_REPO CHANGES.json    # 팀/제외/리뷰/add_tasks/drop_tasks/add_milestones
$P checkpoint $HF_REPO            # 끝난 마일스톤의 체크포인트 보고서
$P ack $HF_REPO ACK.json          # {"milestone": "M1", "user_message": "...", "changes"?: {...}}
$P status $HF_REPO
```

프로젝트 파일은 제어 폴더의 `project.json`이다(작업 폴더 밖). 프로젝트가 없으면 이전처럼 작업 단위로 쓴다.
