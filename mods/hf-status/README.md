# hf-status

HyperFusion 작업 상태를 **프롬프트 위 한 줄**로 보여 주는 Claude Code 모드입니다.

```
HF ▸ HF-test │ REVIEW 리뷰 차례 │ grok 1/3 │ 다음 review or delegate-review  [숨김]
```

단계, 지금 일하는 일꾼과 라운드 사용량(상한에 닿으면 `상한`), 열린 상담, 다음 동작을 보여 줍니다. 진행 중인 작업이 없으면 아무것도 그리지 않습니다.

## 어떻게 동작하나

- 상태 파일을 직접 읽지 않고 `node <hyperfusion>/scripts/fusion-state.mjs line <작업 폴더>`를 부릅니다. 한 줄을 만드는 규칙이 `scripts/status-line.mjs` 한 곳에만 있어서 명령줄, UserPromptSubmit 훅, 이 띠가 같은 말을 합니다.
- 모델을 부르지 않고 타이머도 없습니다. 세션 시작, **Bash 도구 호출이 끝난 뒤**(컨트롤러 명령은 모두 Bash로 실행됩니다), 턴이 끝날 때만 다시 읽습니다.
- 명령이 실패하거나 시간이 걸려도(5초 제한) 작업을 막지 않습니다. 이전 줄을 그대로 둡니다.
- **숨김** 버튼은 그 줄만 숨깁니다. 단계나 라운드가 바뀌어 줄이 달라지면 다시 나타납니다.

## 보이는 화면

프롬프트 위 띠(`AbovePrompt`)는 **터미널과 데스크톱 앱**에서만 그려집니다. VS Code 확장은 띠 자리를 보장하지 않으므로, VS Code에서는 같은 줄을 보여 주는 UserPromptSubmit 훅(`npm run guard:settings` 출력에 포함)을 함께 쓰세요. 어떤 화면이든 `fusion-state.mjs line`으로 직접 확인할 수 있습니다.

## 설치

저장소를 마켓플레이스로 추가해 설치합니다(Claude Code 2.1.275 이상).

```
/plugin install hf-status --marketplace prentice7725/hyperfusion
```

설치 화면에서 **`script`** 에 hyperfusion의 `scripts/fusion-state.mjs` **절대 경로**를 넣습니다. 비워 두면 띠가 나타나지 않습니다. `node`는 PATH의 node가 아니면 바꿉니다.

로컬 폴더로 시험할 때는 `claude --plugin-dir mods/hf-status`로 띄우고 설정(`pluginConfigs`)에 `script`를 넣습니다.

## 검사

`claude`가 설치된 PC에서:

```
claude plugin validate mods/hf-status
claude plugin test mods/hf-status
```

시험(`hf-status.test.tsx`)은 `process.run`을 대역으로 세워 줄이 그려지는 것, 작업이 없을 때 엔진 기본 그림에 양보하는 것, 명령이 실패해도 던지지 않는 것, `script`가 비었을 때 아무것도 실행하지 않는 것, 숨김과 재표시, Bash 호출 뒤 갱신을 확인합니다. 이 시험은 `claude` CLI가 필요해서 `npm test`와 CI에는 들어 있지 않습니다. 줄을 만드는 쪽(`scripts/status-line.mjs`)은 `tests/status-line.test.mjs`가 CI에서 확인합니다.
