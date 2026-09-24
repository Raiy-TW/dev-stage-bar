import { test, expect, mock, describe } from 'claude-code/testing'

const PLUGIN = 'ios-stage-bar'
const TOOL = 'mcp__ios-stage-bar__SetStage'
const CWD = '/p/my-app'
const MIN = 60_000
const T0 = 1_700_000_000_000

type Opts = { ios?: boolean; env?: Record<string, string>; store?: Record<string, unknown>; agents?: unknown[]; toolPrefix?: string; ids?: string[]; hangAgentList?: boolean }

async function boot($: any, on: any, o: Opts = {}) {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on, o.store ?? {})
  mock.env(on, o.env ?? {})
  const registered: string[] = []
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: CWD }))
  // 可切換的 session id：/clear 之後 id 會變，但 session.start 不會再跑。
  const ids = o.ids ?? ['sess-1']
  let idIndex = 0
  on('session.id', () => ({ value: ids[Math.min(idIndex, ids.length - 1)] }))
  on('fs.list', () => ({
    value:
      o.ios === false
        ? [{ name: 'package.json', kind: 'file', size: 1, isLink: false }]
        : [{ name: 'MyApp.xcodeproj', kind: 'dir', size: 0, isLink: false }],
  }))
  on('tool.register', ($: any, e: any) => {
    registered.push(e.name)
    return { value: { tool: `${o.toolPrefix ?? 'mcp__ios-stage-bar__'}${e.name}` } }
  })
  on('agent.list', async () => {
    if (o.hangAgentList) await clock.sleep(60 * MIN)
    return { value: o.agents ?? [] }
  })
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('tool.check', () => ({ decision: 'ask' }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  // 最底層的工具實作：Bash 的 sleep 會在 mock clock 上等 30 分鐘。
  on('tool.call', async ($: any, e: any) => {
    if (e.tool === 'Bash' && /^sleep/.test(e.command ?? '')) await clock.sleep(30 * MIN)
    return { result: `bottom:${e.tool}` }
  })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  return { clock, registered, clearSession: () => void idIndex++ }
}

const PROPS = (over: Record<string, unknown> = {}) => ({
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 160,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
  ...over,
})

async function band($: any, over: Record<string, unknown> = {}): Promise<string[]> {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: PROPS(over) })
  const tree = await ui.drawn()
  await ui.unmount()
  const rows: string[] = []
  const text = (n: any): string => (typeof n === 'string' ? n : (n.children ?? []).map(text).join(''))
  if (tree?.type === 'Box') for (const row of tree.children ?? []) rows.push(text(row))
  return rows
}

describe('啟用條件', () => {
  test('非 iOS 專案：不註冊 SetStage、不畫', async ($, on) => {
    const { registered } = await boot($, on, { ios: false })
    expect(registered).not.toContain('SetStage')
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: PROPS() as any })
    expect(await ui.find({ type: 'Text', text: /需求/ })).toBeUndefined()
  })
  test('iOS 專案：註冊 SetStage 並畫進度條', async ($, on) => {
    const { registered } = await boot($, on)
    expect(registered).toContain('SetStage')
    const rows = await band($)
    expect(rows[0]).toMatch(/^○┄+○/)
    expect(rows).toHaveLength(1)
  })
  test('每列是一個 truncate-end 的 Text（寬度估錯時截斷，不折行）', async ($, on) => {
    await boot($, on)
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: PROPS() as any })
    const row = await ui.find({ type: 'Text', text: /○/ })
    expect(row?.props.wrap).toBe('truncate-end')
    await ui.unmount()
  })
  test('hasSurvey 時讓出 band', async ($, on) => {
    await boot($, on)
    expect(await band($, { hasSurvey: true })).toHaveLength(0)
  })
})

describe('SetStage 與放行', () => {
  test('SetStage 回字串並顯示 milestone/detail', async ($, on) => {
    await boot($, on)
    const r: any = await $.tool.call({ tool: TOOL, stage: 'verify', detail: 'T3/5', milestone: 'M48' } as any)
    expect(typeof r.result).toBe('string')
    expect(r.result).toContain('驗證')
    const rows = await band($)
    expect(rows[0]).toMatch(/●━+.*◉┄+.*M48$/)
    expect(rows[1]?.trim()).toBe('驗證 · T3/5 · 0m')
  })
  test('SetStage 的工具名取自 $.tool.register 的回傳值', async ($, on) => {
    await boot($, on, { toolPrefix: 'mcp__renamed__' })
    const r: any = await $.tool.call({ tool: 'mcp__renamed__SetStage', stage: 'plan' } as any)
    expect(r.result).toContain('拆解')
  })
  test('顯示邏輯的 $ 呼叫卡住也不延遲工具結果', async ($, on) => {
    const { clock } = await boot($, on, { hangAgentList: true })
    let done = false
    const p = $.tool.call({ tool: 'Bash', command: 'echo hi' } as any).then((r: any) => {
      done = true
      return r
    })
    await clock.settle()
    expect(done).toBe(true)
    expect((await p).result).toBe('bottom:Bash')
    await clock.advance(61 * MIN)
  })
  test('/clear 後（session.start 不重跑）turn.start 換新 session id，上個 session 的鎖失效', async ($, on) => {
    const { clearSession } = await boot($, on, { ids: ['sess-1', 'sess-2'] })
    await $.tool.call({ tool: TOOL, stage: 'impl' } as any)
    await $.tool.call({ tool: 'Bash', command: 'xcodebuild test -scheme A' } as any)
    expect((await band($))[1]).toMatch(/實作 · \d+m/)
    clearSession()
    await $.turn.start({ text: 'hi', turnId: 't2' } as any)
    await $.tool.call({ tool: 'Bash', command: 'xcodebuild test -scheme A' } as any)
    expect((await band($))[1]).toMatch(/驗證 · \d+m/)
  })
  test('SetStage 未知階段回說明字串', async ($, on) => {
    await boot($, on)
    const r: any = await $.tool.call({ tool: TOOL, stage: 'ship' } as any)
    expect(r.result).toContain('未知的階段')
  })
  test('一般工具的結果原封不動放行', async ($, on) => {
    await boot($, on)
    const r: any = await $.tool.call({ tool: 'Bash', command: 'echo hi' } as any)
    expect(r.result).toBe('bottom:Bash')
  })
})

describe('階段判斷（經由 hooks）', () => {
  test('權威轉換覆蓋推測', async ($, on) => {
    await boot($, on)
    await $.tool.call({ tool: 'Skill', skill: 'ios-review' } as any)
    await $.tool.call({ tool: 'Bash', command: 'xcodebuild test -scheme A' } as any)
    const rows = await band($)
    expect(rows[1]).toMatch(/審查 · \d+m/)
  })
  test('無權威時主迴圈 xcodebuild test 推測為驗證', async ($, on) => {
    await boot($, on)
    await $.tool.call({ tool: 'Bash', command: 'xcodebuild test -scheme A' } as any)
    expect((await band($))[1]).toMatch(/驗證 · \d+m/)
  })
  test('subagent 內的 xcodebuild test 不改階段', async ($, on) => {
    await boot($, on, { agents: [{ id: 'a1', description: 'M48 T3 add parser', type: 'general-purpose', status: 'running' }] })
    await $.tool.call({ tool: 'Bash', command: 'xcodebuild test -scheme A', agentId: 'a1' } as any)
    expect((await band($))[0]).not.toMatch(/[●◉]/)
  })
  test('上次 session 的階段顯示「上次更新」', async ($, on) => {
    const saved = { stage: 'impl', stageSince: T0 - 5 * 60 * MIN, updatedAt: T0 - 3 * 60 * MIN, source: 'setstage', sessionId: 'old' }
    await boot($, on, { store: { [`stage:${CWD}`]: saved } })
    expect((await band($))[1]).toContain('上次更新 3 小時前')
  })
})

describe('卡住偵測', () => {
  test('Bash 跑超過 20 分鐘 → ⚠', async ($, on) => {
    const { clock } = await boot($, on)
    const pending = $.tool.call({ tool: 'Bash', command: 'sleep 9999' } as any)
    await clock.settle()
    await clock.advance(19 * MIN)
    expect((await band($, { isWorking: true }))[1]).toContain('🔄 sleep 9999 19m')
    await clock.advance(2 * MIN)
    const rows = await band($, { isWorking: true })
    expect(rows[1]).toContain('⚠ 主迴圈 21 分鐘沒有動靜（sleep 9999 仍在跑）')
    await clock.advance(10 * MIN)
    await pending
  })
  test('環境變數把門檻調成 1 分鐘', async ($, on) => {
    const { clock } = await boot($, on, { env: { IOS_STAGE_BAR_STUCK_MIN: '1' } })
    const pending = $.tool.call({ tool: 'Bash', command: 'sleep 9999' } as any)
    await clock.settle()
    await clock.advance(2 * MIN)
    expect((await band($))[1]).toContain('⚠ 主迴圈 2 分鐘沒有動靜')
    await clock.advance(30 * MIN)
    await pending
    expect((await band($))[1] ?? '').not.toContain('⚠')
  })
  test('等授權的時間不算卡住；band 重新出現（授權結束）後才開始計時', async ($, on) => {
    const { clock } = await boot($, on, { env: { IOS_STAGE_BAR_STUCK_MIN: '1' } })
    const pending = $.tool.call({ tool: 'Bash', command: 'sleep needs-ok', tool_use_id: 'tu-1' } as any)
    await clock.settle()
    // 模擬引擎：這個呼叫要授權（ask），person 在對話框前想了 5 分鐘。
    await $.tool.check({ tool: 'Bash', input: { command: 'sleep needs-ok' }, tool_use_id: 'tu-1' })
    await clock.advance(5 * MIN)
    // 對話框期間 band 可能被重畫多次：每次都要是「⏸ 等你：授權」，不能被重畫清掉。
    expect((await band($, { isWorking: true }))[1]).toContain('⏸ 等你：授權 sleep needs-ok')
    await clock.advance(1 * MIN)
    expect((await band($, { isWorking: true }))[1]).toContain('⏸ 等你：授權 sleep needs-ok')
    // 指令真的開始跑：引擎畫出該呼叫的 ToolProgress（run-in-background 提示）。
    const prog = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'ToolProgress', props: { tool_use_id: 'tu-1', kind: 'background_hint', hint: '(ctrl+b to run in background)' } as any })
    await prog.unmount()
    expect((await band($, { isWorking: true }))[1]).toContain('🔄')
    await clock.advance(2 * MIN)
    expect((await band($, { isWorking: true }))[1]).toContain('⚠ 主迴圈 2 分鐘沒有動靜（sleep needs-ok 仍在跑）')
    await clock.advance(30 * MIN)
    await pending
  })
  test('isWorking 但 10 分鐘沒工具事件 → ⚠', async ($, on) => {
    const { clock } = await boot($, on)
    await $.tool.call({ tool: 'Bash', command: 'echo hi' } as any)
    await clock.advance(11 * MIN)
    expect((await band($, { isWorking: true }))[1]).toContain('⚠ 11 分鐘沒有任何工具活動')
  })
})
