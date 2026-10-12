import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

// HyperFusion 작업 상태 띠. 상태 파일을 직접 읽지 않고 `fusion-state.mjs line`을 부른다.
// 한 줄을 만드는 규칙이 한 곳(scripts/status-line.mjs)에만 있어야 명령줄·훅·이 띠가 같은 말을 한다.
// 모델을 부르지 않는다. 갱신은 이벤트로만 한다(세션 시작, Bash 도구 호출 뒤, 턴 끝). 타이머는 없다.

const line = atom({ plugin: 'hf-status', key: 'line' } as const, '')
// 숨김은 "그 줄"에 묶는다. 같은 줄을 숨겼다가 단계나 라운드가 바뀌어 줄이 달라지면 다시 나타난다.
const hiddenFor = atom({ plugin: 'hf-status', key: 'hiddenFor' } as const, '')

// $를 넘겨받는 함수는 파일 맨 위에 선언한 함수여야 한다(모드 검사기의 규칙). 그래서 register 밖에 둔다.
async function refresh($: EngineInterface, script: string, node: string) {
  if (!script) return
  // 어떤 실패도 밖으로 내보내지 않는다. 표시 때문에 도구 호출이나 턴이 멈추면 안 된다.
  try {
    const cwd = await $.session.cwd()
    const ran = await $.process
      .run([node, script, 'line', cwd], { cwd, timeoutMs: 5000 })
      .catch(() => null)
    const text = ran && ran.exitCode === 0 ? ran.stdout.trim() : ''
    await update($, line, () => text)
  } catch {
    // 이전 줄을 그대로 둔다.
  }
}

export const register: Register = (on, options) => {
  const script = String(options.script ?? '')
  const node = String(options.node ?? 'node') || 'node'

  on('session.start', async ($, e, next) => {
    await refresh($, script, node)
    return next(e)
  })

  // 컨트롤러 명령은 모두 Bash로 실행되므로, Bash 호출이 끝난 뒤에만 다시 읽는다.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    await refresh($, script, node)
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    await refresh($, script, node)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const text = await read($, line)
    const hidden = await read($, hiddenFor)
    if (e.props.hasSurvey || !script || !text || hidden === text) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box>
        <Text dimColor>{text} </Text>
        <Button
          key="hide"
          label="숨김"
          onPress={() => update($, hiddenFor, () => text)}
        />
      </Box>
    )
  })
}
