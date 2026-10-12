// 이 모드가 세션 상태($.state)에 두는 값. 이름은 모드 이름(hf-status) 아래에 선언한다.
declare module 'claude-code' {
  interface PluginState {
    'hf-status': {
      // `fusion-state.mjs line`이 마지막으로 낸 한 줄. 진행 중인 작업이 없으면 빈 문자열.
      line: string
      // 사용자가 [숨김]을 눌렀는지. 작업 단계가 바뀌면 다시 보인다.
      hiddenFor: string
    }
  }
}
