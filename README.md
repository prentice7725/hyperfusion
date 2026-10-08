# HyperFusion

한국어 | [日本語](README.ja.md)

**Claude Opus 5.5가 리드**를 맡고, **Sonnet·Grok·Antigravity·Luna가 일꾼**, **Sol이 리뷰어**로 구현과 테스트를 전부 수행하는 Claude Code 스킬. 리드는 기획 문서를 읽고 프로젝트에 맞는 팀을 꾸려 보고하고, 승인받은 팀으로 마일스톤을 진행하며 체크포인트마다 보고한다.

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

## 보안 리뷰로 찾은 결함 수정 (v0.10)

보안 리뷰에서 지적된 결함을 고쳤다. 공격을 재현하는 회귀 테스트(`tests/security.test.mjs`)를 먼저 만들어 실패를 확인한 뒤 고쳤다.

| 결함 | 수정 |
|---|---|
| **H1** 제어 파일(상태, brief, 스냅샷, lease)이 작업 폴더의 `.fusion/`에 있어, 편집 도구를 가진 일꾼이 brief의 범위를 넓히고 범위 밖 파일을 써도 `REVIEW`로 통과(재현 확인). Grok 외에는 `.fusion` 편집 차단도 없었음. 브리지는 dispatch 파일을 그대로 믿음 | 제어 폴더를 **작업 폴더 밖** `~/.hyperfusion/state/<저장소>-<해시>/`로 옮김(`HF_STATE_DIR`로 변경). 예전 `.fusion/`이 있으면 새 작업을 거절(`LEGACY_CONTROL_DIR`)하고 `fusion-state.mjs migrate REPO`가 해시 검증 후 옮김. Grok·Sonnet은 `.git`·`.fusion`·제어 폴더 Edit/Write를 중첩까지 차단. 브리지는 실행 직전 brief와 상태로 요청을 다시 만들어 다르면 `DISPATCH_TAMPERED` |
| **H2** 스냅샷이 `.gitignore`된 파일과 `.git/config`·훅을 못 봄. 저장소 설정(fsmonitor, filter, 외부 diff)이 컨트롤러의 `git status`로 코드를 실행 | 스냅샷에 `.git/config`·`hooks/*`·`info/*`, `.env*`, `.npmrc`, `.husky`, `.vscode`, `node_modules/.bin`을 포함해 범위 밖 변경으로 적발. 컨트롤러의 git은 fsmonitor·filter·외부 diff·textconv를 끄고 호출. `setup-doctor`가 실행 가능한 저장소 설정과 활성 훅을 경고 |
| **M1** `Bash(npm test*)`가 `; curl … \| sh`를 통과시킬 수 있고, `git -C dir push`가 `git push*` 차단을 우회 | `executor_bash_rules`는 테스트·린트·빌드·읽기 전용 명령 모양만 허용(메타문자·인터프리터·네트워크 도구 거절, `HF_BASH_POLICY=permissive`로만 완화). git 차단 규칙에 옵션 삽입 모양과 변경 명령 전반, curl/wget/ssh/sudo 추가 |
| **M2** scope 경로 검증 허점(글롭, `~`, 드라이브, NTFS 스트림, `.GIT`·`GIT~1`) | scope와 `allow_out_of_scope`는 모두 거절. 일꾼이 보고하는 경로는 글롭만 허용하되 같은 `.git` 우회를 거절 |
| **M3** 저장소 설정으로 샌드박스를 끄거나 다른 프로젝트의 기억 워크스페이스를 가리킬 수 있음 | 샌드박스 해제는 운영자의 `HF_ALLOW_UNSANDBOXED=1`이 있을 때만, 상담·리뷰는 항상 샌드박스. 워크스페이스는 처음 쓴 저장소에 묶이고 다른 저장소는 `memory.mjs bind`로만 허용 |
| **M4** 일꾼에게 컨트롤러의 환경변수 전체가 넘어감 | 실행에 필요한 변수와 해당 벤더 인증값만 넘김(`HF_ENV_PASS`로 추가) |
| **M5** 알림에 일꾼 요약·오류 문장이 실리고 평문 http도 허용 | 고정 형식(작업 ID, 일꾼, 라운드, 상태)만 전송, 평문 http는 localhost만 |
| **M6** 기억 비밀값 필터 누락, 거절된 후보의 내용이 장부에 남음 | 패턴 확대(npm·GitLab·Stripe 토큰, 접속 문자열, `password is …`, 긴 무작위 토큰, 유니코드 우회), 거절된 후보는 사유만 남김 |
| **LOW** router 지표의 `__proto__` 오염, 형식이 틀린 기억 후보가 라운드를 실패시킴, 죽은 컨트롤러의 `control.lock`, 하위 폴더 심볼릭 링크 | 실제 일꾼 이름만 집계, 기억 후보는 걸러내고 라운드는 유지, lock에 소유자(pid·호스트·시각)를 적어 죽은 프로세스의 것만 치움, 쓰기 전 링크 검사 |

**남은 위험(솔직하게):** 이 보호는 협업 통제이지 OS 샌드박스가 아니다. 셸을 쓸 수 있는 일꾼은 홈 폴더의 다른 파일에 닿을 수 있다(제어 폴더도 이론상 포함). 스냅샷 비교가 작업 폴더 안의 변경을 적발하지만, 폴더 밖 변경은 막지 못한다. git의 clean/smudge 필터가 사용자 전역 설정에 있으면 컨트롤러 호출에서는 꺼지지만 사람이 쓰는 git에서는 그대로다. Codex(Luna/Sol)와 Antigravity는 도구 수준 편집 차단 규칙이 없어, Codex는 `workspace-write` 샌드박스에, Antigravity는 `--sandbox`에 의존한다. 일꾼이 `npm install`로 `node_modules/.bin`을 바꾸면 범위 밖으로 적발되므로 의존성 설치가 필요한 작업은 scope에 `node_modules`를 넣거나 `allow_out_of_scope`로 받아들인다.

## 코드 리뷰로 찾은 결함 수정 (v0.9.1)

코드 리뷰에서 재현으로 확인된 결함을 고쳤다. 각각 실패하는 회귀 테스트를 먼저 만들었다.

| 결함 | 수정 |
|---|---|
| 설치 안 된 일꾼이 `available`에 있으면 그 일꾼이 교체 후보와 "예산 남음" 판단에 들어가 작업이 멈춤(예: Codex 없이 `luna`가 설정에 있을 때) | 예산이 남고 **설치도 된** 일꾼만 센다. 교체할 일꾼이 없으면 takeover나 BLOCKED로 넘어간다. `status`에 `unavailable` 표시 |
| 실패한 라운드가 남긴 범위 밖 파일이 복구 후 다음 라운드 기준선에 섞여 CLOSE까지 통과 | 지적된 파일은 되돌려지거나 허용될 때까지 다음 라운드를 막고, `verify`는 최초 기준선과 비교한다. 알고 받아들일 때만 `allow_out_of_scope`(사유 필수) |
| 막힌(BLOCKED) 작업은 `init`이 거절돼 archive가 유일한 출구였고, archive가 체크포인트 결과를 "보관"으로 덮어씀 | 막힌 작업 뒤에도 새 작업 시작 가능. archive는 `blocked`/`closed` 결과를 덮어쓰지 않음 |
| 팀 구성 보고서의 "1순위"가 난이도 없는 작업에서 실제 배치와 다름 | 보고서·경고·실제 배치가 같은 규칙(`router.matchRule`)을 사용 |
| `decide`·`recover`로 BLOCKED가 되면 지표·프로젝트 정산·기억 추출이 빠짐, 지표 실패는 조용히 묻힘 | 작업이 CLOSE/BLOCKED가 되는 순간 어느 경로든 한 번 정산. 실패는 `metrics_error` 등으로 상태에 남김 |
| 기억 장부 실패가 정상 라운드를 버리게 하거나, 닫힌 작업이 프로젝트에서 계속 active로 남음 | 선택 기능의 실패는 기록만 하고 핵심 흐름을 막지 않음 |
| 위임 리뷰 적용 중 복구 단계로 넘어가면 "adopt 하라"고 잘못 안내 | `recovery_required`로 알리고 복구를 안내 |
| SKILL.md가 `luna`를 일꾼이 아니라고 하고 `--executor` 목록에서 빼먹음, README에 낡은 "Luna 제거" | 바로잡고, 문서-코드 불일치를 테스트로 지킴 |
| `.`·`./src`가 범위 경로로 통과해 모든 변경이 범위 밖 처리, 일꾼 이름 목록 하드코딩, 350줄짜리 `run()` | 거절하고 원인 경로 표시, `EXECUTORS` 단일 출처, 액션 함수로 분리 |

## 팀 구성 보고와 마일스톤 (v0.9)

리드가 기획 문서를 읽고 **이 프로젝트를 누가 어떻게 할지** 팀을 먼저 꾸려 보고한다.

| 팀원 | 모델 | 기본 역할 |
|---|---|---|
| Sonnet | claude-sonnet-5-5 | 핵심 구현(중·고난도 코드, 테스트, 리팩터) |
| Grok | Grok CLI | 이미지 애셋, 빠른 일반 구현 |
| Antigravity | agy | UI·프론트엔드, 문서 |
| Luna | gpt-6-luna (Codex) | 쉬운 구현·소규모 수정, 기계적 대량 편집 |
| Sol | gpt-6.1-sol (Codex) | 리뷰 전담, 위원회 상담. 코드는 쓰지 않음 |

1. **구성안:** 리드가 팀원별 역할·담당 작업·쓰지 않는 팀원과 이유·마일스톤·체크포인트 기준을 정해 `propose`하면 팀 구성 보고서가 나온다.
2. **승인:** 사용자가 "그대로 가자" 하면 `approve`. "얘는 이거 시키자", "grok은 빼자" 하면 `amend` 후 다시 보고한다. **승인 전에는 작업이 시작되지 않는다**(컨트롤러가 거절).
3. **진행:** 작업은 현재 마일스톤에 계획된 것만 시작할 수 있다. 승인된 팀이 그대로 배치표·리뷰어·사용 가능 일꾼이 된다. 뺀 팀원은 불리지 않는다.
4. **체크포인트:** 마일스톤이 끝나면 체크포인트 보고서가 나온다. 작업별 결과, 누가 몇 번 투입됐는지, 반려·위임 리뷰·리드 덮어쓰기, 팀원별 통과율, 구성 조정 제안이 들어간다. **사용자가 확인(`ack`)해야 다음 마일스톤이 열린다.** 확인할 때 팀 변경을 지시할 수도 있다.

기본 역할은 출발점이고, 프로젝트마다 리드가 바꾼다. 모델 ID는 `executors.sol.model`, `executors.luna.model`로 바꾼다. 자세한 건 [project](references/project.md).

## 리뷰 위임 (v0.8)

리드는 Opus 그대로 두고, 라운드 리뷰만 다른 모델에게 맡기는 옵션이다(`"review": {"by": "delegate"}`). Opus가 diff를 정독하는 비용이 리드 토큰에서 가장 크기 때문이다.

- **판정 적용:** 리뷰어가 읽기 전용으로 diff를 보고 판정(pass/redo/alternative/decision), 반려 사유, 파일·줄 지적을 낸다. 컨트롤러가 그 판정을 그대로 적용한다(`auto_apply: false`면 리드가 채택하거나 덮어쓴다).
- **리뷰어 순서:** 기본은 **Sol**(GPT-6.1 Sol via Codex, 리드와 다른 계열이라 교차 검증에 가장 유리) → Sonnet → Antigravity → Grok → Luna다. 설치 안 된 리뷰어는 건너뛴다. 프로젝트가 있으면 승인된 팀의 리뷰어 순서를 쓴다.
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
| 알림 | 둘 다 | `HF_NOTIFY_URL`(예: ntfy)로 일꾼 완료, 상담 완료, 리드 판단 필요 시 휴대폰 푸시(고정 형식, 요약·오류 문장은 제외) |

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
| Luna (v0.2.1의 보조 모델) | v0.3에서 제거했다가 v0.9에서 Codex 구현 일꾼(`gpt-6-luna`)으로 복귀 |
| Claude 일꾼 | Claude는 리드이므로 `claude`로는 고용할 수 없고, `sonnet`(리드와 별도 프로세스)으로만 고용 |
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

192개 테스트가 보안 회귀(제어 파일 변조·`.git` 훅·`.env` 심기 적발, 저장소 설정으로 인한 코드 실행 차단, dispatch 재검증, 환경변수 허용목록, Bash 규칙·scope 경로 우회, 기억 워크스페이스 격리, 알림 최소화, 비밀값 필터, 잠금·링크), 코드 리뷰 회귀(설치 안 된 일꾼, 범위 밖 파일의 누적 검사와 허용, 막힌 작업 정산, 보고서-배치 일치, 정산 경로·실패 기록, 문서-코드 일치), 프로젝트(팀원 전원 결정 강제, Sol 담당 금지, 팀 구성 보고서, 승인 전 작업 거절, 마일스톤 밖 작업 거절, 팀 설정 고정·제외 팀원 차단, 체크포인트 보고·확인 전 다음 마일스톤 차단, 재승인이 필요한 변경 구분, 확인과 함께 팀 변경, 완료 후 게이트 해제), Luna 구현(workspace-write), 리뷰 위임(Sol 우선 배정, 자기 리뷰 금지, 판정 자동 적용·보류·채택·덮어쓰기 기록, `@review` 지시 전달, 리뷰어 실패 시 교체·라운드 상한, 형식 오류 판정 폐기, 미완료 라운드 pass 차단, 읽기 전용 위반 폐기, takeover 코드 리뷰, Codex 구현 금지·설정 검증), 기억 계층(비밀값·크기·권한 차단, 후보 장부, 프로토콜 자동 추출, 리드 승인 저장, verified/inferred, 중복 병합, 모순 검토 대기열, 감쇠·재공고화·TTL, 연상 확산, 한글 검색, workspace 격리, 파일 잠금),  상담(advisor/committee) 실행·읽기 전용 위반 적발·상담 중 잠금·예산, 줄 단위 피드백, 알림 전송, Windows 경로 처리(.cmd 래퍼 해석, .js 진입점, 역슬래시 경로, 명령줄 길이)와 Grok/Antigravity/Sonnet 정상 실행, 작업별 배치·설치 상태 반영·실적 기반 강등·교체 순서, 세션 재개, 중복 실행 차단, 오류·timeout·출력 상한·결과 검증, 빈 반려 거절, 같은 실수 반복 시 교체, 일꾼이 남아 있을 때 takeover 거절, 예산 소진 후 단 1회 takeover, 거짓 변경 신고 적발, 리드/일꾼 사용량 분리 집계를 확인한다. GitHub Actions가 Ubuntu·Windows × Node 20·24에서 실행한다. 테스트의 `grok`/`agy`/`claude`/`codex`는 명시적으로 표시된 대역이며 실제 모델을 호출하지 않는다.

## 완료보고 진단

제어 폴더(기본 `~/.hyperfusion/state/<저장소>-<해시>/`, 작업 폴더 밖) `tasks/<task_id>/`:

- `dispatch-N.json`: 일꾼, CLI 인자, 세션
- `envelope-N.json`: 종료 코드, 중단 이유, 원본 stdout/stderr
- `result-N.json`, `session-N.json`, `usage-N.json`: 검증된 결과, 세션 ID, 일꾼 보고 사용량
- `review-N.json`: 리드 판정과 반려 사유
- `state.json`: 단계, 배치 결과와 근거(`routing`), 일꾼별 남은 예산, 교체 이력
- `metrics/<task_id>.json`: router가 학습하는 작업별 기록

## 운영 원칙

writer는 한 명이다. lock은 협업 통제이며 OS 샌드박스가 아니다. 자동 commit/push/deploy/release, 범위 확장, 파괴적 복구는 없다.

목표 지표는 **성공 작업당 Opus 리드 토큰**이다. 실패 작업도 분자에 포함한다. 일꾼 비용과 소요 시간은 별도 가드레일로 기록한다(Antigravity는 비용을 보고하지 않으므로 null). 작업이 끝날 때마다 `metrics.mjs`를 돌려야 router가 실적을 배운다. 측정되지 않은 값은 null이다.

실행 로그·세션·인증정보는 이 저장소에 포함하지 않는다. 제어 폴더는 일꾼의 편집 도구가 닿지 못하도록 작업 폴더 밖에 둔 비공개 로컬 작업 기록이다. 예전 버전의 `.fusion/`은 `node scripts/fusion-state.mjs migrate <저장소>`로 옮긴다.
