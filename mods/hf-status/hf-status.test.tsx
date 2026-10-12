import type { On } from 'claude-code'
import { test, expect } from 'claude-code/testing'

// 진짜 fusion-state.mjs 대신 process.run을 대역으로 세운다. 이 모드는 명령이 낸 한 줄만 믿고 그린다.
const SCRIPT = '/opt/hyperfusion/scripts/fusion-state.mjs'
const LINE = 'HF ▸ HF-test │ REVIEW 리뷰 차례 │ grok 1/3 │ 다음 review or delegate-review'
const RAN = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
// 모드가 next(e)로 양보하면 엔진의 기본 그림이 나온다. 시험에서는 그 자리를 'ENGINE' 글자가 대신한다.
const engine = (on: On) =>
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>ENGINE</Text>
  })
const BAND = {
  plugin: 'hf-status',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
} as const

test('세션이 시작되면 상태 한 줄을 프롬프트 위에 그린다', { options: { script: SCRIPT } }, async ($, on) => {
  const calls: string[][] = []
  on('session.cwd', () => ({ value: '/work/repo' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('process.run', (_$, e) => {
    calls.push([...e.argv])
    return { value: RAN(LINE + '\n') }
  })
  await $.session.start({ cwd: '/work/repo', surface: 'terminal', isInteractive: true } as never)
  expect(calls[0]).toEqual(['node', SCRIPT, 'line', '/work/repo'])
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /grok 1\/3/ })).toBeDefined()
    await ui.unmount()
  }
})

test('진행 중인 작업이 없으면(빈 출력) 띠를 그리지 않는다', { options: { script: SCRIPT } }, async ($, on) => {
  on('session.cwd', () => ({ value: '/work/repo' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: RAN('') }))
  engine(on)
  await $.session.start({ cwd: '/work/repo', surface: 'terminal', isInteractive: true } as never)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /ENGINE/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /HF/ })).toBeUndefined()
  await ui.unmount()
})

test('명령이 실패해도 던지지 않고 띠만 비운다', { options: { script: SCRIPT } }, async ($, on) => {
  on('session.cwd', () => ({ value: '/work/repo' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: { ...RAN('garbage'), exitCode: 1, stderr: 'boom' } }))
  engine(on)
  await $.session.start({ cwd: '/work/repo', surface: 'terminal', isInteractive: true } as never)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /ENGINE/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /garbage/ })).toBeUndefined()
  await ui.unmount()
})

test('script를 설정하지 않으면 아무것도 실행하지 않는다', async ($, on) => {
  let ran = 0
  on('session.cwd', () => ({ value: '/work/repo' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('process.run', () => {
    ran += 1
    return { value: RAN(LINE) }
  })
  await $.session.start({ cwd: '/work/repo', surface: 'terminal', isInteractive: true } as never)
  expect(ran).toBe(0)
})

test('숨김을 누르면 사라지고, 줄이 바뀌면 다시 나타난다', { options: { script: SCRIPT } }, async ($, on) => {
  let out = LINE
  on('turn.complete', () => ({ text: '' }))
  on('session.cwd', () => ({ value: '/work/repo' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: RAN(out) }))
  engine(on)
  await $.session.start({ cwd: '/work/repo', surface: 'terminal', isInteractive: true } as never)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'hide' })
  expect(await ui.find({ type: 'Text', text: /ENGINE/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /grok 1\/3/ })).toBeUndefined()
  await ui.unmount()
  out = 'HF ▸ HF-test │ VERIFY 검증 차례 │ grok 1/3 │ 다음 verify'
  await $.turn.complete({ reason: 'answer', answer: '', text: '' } as never)
  const again = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await again.find({ type: 'Text', text: /VERIFY/ })).toBeDefined()
  await again.unmount()
})

test('Bash 도구 호출이 끝나면 다시 읽는다(컨트롤러 명령은 모두 Bash로 실행된다)', { options: { script: SCRIPT } }, async ($, on) => {
  let runs = 0
  on('session.cwd', () => ({ value: '/work/repo' }))
  on('process.run', () => {
    runs += 1
    return { value: RAN(LINE) }
  })
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }) as never)
  await $.tool.call({ tool: 'Bash', command: 'node fusion-state.mjs finish' } as never)
  expect(runs).toBe(1)
})
