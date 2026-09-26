import { test, expect, mock, describe } from 'claude-code/testing'

const PLUGIN = 'dev-stage-bar'
const TOOL = 'mcp__dev-stage-bar__SetStage'
const CWD = '/p/my-app'
const MIN = 60_000
const T0 = 1_700_000_000_000

type Opts = { ios?: boolean; env?: Record<string, string>; store?: Record<string, unknown>; agents?: unknown[]; toolPrefix?: string; ids?: string[]; hangAgentList?: boolean; registerFails?: boolean }

async function boot($: any, on: any, o: Opts = {}) {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on, o.store ?? {})
  mock.env(on, o.env ?? {})
  const registered: string[] = []
  const descriptions: Record<string, string> = {}
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
    if (o.registerFails) throw new Error('register refused')
    registered.push(e.name)
    descriptions[e.name] = e.description
    return { value: { tool: `${o.toolPrefix ?? 'mcp__dev-stage-bar__'}${e.name}` } }
  })
  on('agent.list', async () => {
    if (o.hangAgentList) await clock.sleep(60 * MIN)
    return { value: o.agents ?? [] }
  })
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
  on('prompt.section', ($: any, e: any) => ({ text: e.text }))
  on('tool.check', () => ({ decision: 'ask' }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  // 最底層的工具實作：Bash 的 sleep 會在 mock clock 上等 30 分鐘。
  on('tool.call', async ($: any, e: any) => {
    if (e.tool === 'Bash' && /^sleep/.test(e.command ?? '')) await clock.sleep(30 * MIN)
    return { result: `bottom:${e.tool}` }
  })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  return { clock, registered, descriptions, clearSession: () => void idIndex++ }
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
  test('非 iOS 專案也啟用：註冊 SetStage、還沒有動作時畫「問答中」', async ($, on) => {
    const { registered } = await boot($, on, { ios: false })
    expect(registered).toContain('SetStage')
    expect(await band($)).toEqual(['問答中'])
  })
  test('iOS 專案：註冊 SetStage；還沒有動作時畫「問答中」', async ($, on) => {
    const { registered } = await boot($, on)
    expect(registered).toContain('SetStage')
    expect(await band($)).toEqual(['問答中'])
  })
  test('非 iOS 專案 feature 用 default 標籤：8 點、ship=部署', async ($, on) => {
    await boot($, on, { ios: false })
    const r: any = await $.tool.call({ tool: TOOL, task: 'feature', stage: 'ship' } as any)
    expect(r.result).toContain('部署')
    const rows = await band($)
    expect((rows[0]!.match(/[●◉○]/g) ?? []).length).toBe(8)
    expect(rows[1]?.trim()).toBe('部署 · 0m')
    const bad: any = await $.tool.call({ tool: TOOL, stage: 'submit' } as any)
    expect(bad.result).toContain('intent, spec, plan, impl, verify, review, ship, accept')
  })
  test('每列是一個 truncate-end 的 Text（寬度估錯時截斷，不折行）', async ($, on) => {
    await boot($, on)
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: PROPS() as any })
    const row = await ui.find({ type: 'Text', text: /問答中/ })
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
    const r: any = await $.tool.call({ tool: TOOL, task: 'feature', stage: 'verify', detail: 'T3/5', milestone: 'M48' } as any)
    expect(typeof r.result).toBe('string')
    expect(r.result).toContain('驗證')
    const rows = await band($)
    expect(rows[0]).toMatch(/^新功能 ●━+.*◉┄+.*M48$/)
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
    await $.tool.call({ tool: TOOL, task: 'feature', stage: 'impl' } as any)
    await $.tool.call({ tool: 'Bash', command: 'xcodebuild test -scheme A' } as any)
    expect((await band($))[1]).toMatch(/實作 · \d+m/)
    clearSession()
    await $.turn.start({ text: 'hi', turnId: 't2' } as any)
    await $.tool.call({ tool: 'Bash', command: 'xcodebuild test -scheme A' } as any)
    expect((await band($))[1]).toMatch(/驗證 · \d+m/)
  })
  test('SetStage 未知階段回說明字串', async ($, on) => {
    await boot($, on)
    const r: any = await $.tool.call({ tool: TOOL, stage: 'deploy' } as any)
    expect(r.result).toContain('未知的階段')
  })
  test('SetStage 沒有任務且 stage 不唯一 → 請帶 task；不合法 stage → 列出合法值且不改狀態', async ($, on) => {
    await boot($, on)
    const amb: any = await $.tool.call({ tool: TOOL, stage: 'review' } as any)
    expect(amb.result).toContain('task')
    await $.tool.call({ tool: TOOL, task: 'bugfix', stage: 'diagnose' } as any)
    const bad: any = await $.tool.call({ tool: TOOL, stage: 'spec' } as any)
    expect(bad.result).toContain('reproduce, diagnose, red, fix, verify, review, ship')
    expect((await band($))[1]?.trim()).toBe('診斷 · 0m')
  })
  test('SetStage 帶新 task → 換整條', async ($, on) => {
    await boot($, on)
    await $.tool.call({ tool: TOOL, task: 'feature', stage: 'impl' } as any)
    await $.tool.call({ tool: TOOL, task: 'work', stage: 'research' } as any)
    const rows = await band($)
    expect(rows[0]).toMatch(/^非程式 /)
    expect((rows[0]!.match(/[●◉○]/g) ?? []).length).toBe(5)
  })
  test('一般工具的結果原封不動放行', async ($, on) => {
    await boot($, on)
    const r: any = await $.tool.call({ tool: 'Bash', command: 'echo hi' } as any)
    expect(r.result).toBe('bottom:Bash')
  })
})

describe('階段判斷（經由 hooks）', () => {
  test('權威轉換覆蓋推測', async ($, on) => {
    await boot($, on, { store: { [`stage:${CWD}`]: { task: 'feature', stage: 'impl', stageSince: T0, updatedAt: T0, source: 'setstage', sessionId: 'old' } } })
    await $.tool.call({ tool: 'Skill', skill: 'ios-review' } as any)
    await $.tool.call({ tool: 'Bash', command: 'xcodebuild test -scheme A' } as any)
    const rows = await band($)
    expect(rows[1]).toMatch(/審查 · \d+m/)
  })
  test('無權威時主迴圈 xcodebuild test 推測為驗證', async ($, on) => {
    await boot($, on, { store: { [`stage:${CWD}`]: { task: 'bugfix', stage: 'fix', stageSince: T0, updatedAt: T0, source: 'setstage', sessionId: 'old' } } })
    await $.tool.call({ tool: 'Bash', command: 'xcodebuild test -scheme A' } as any)
    expect((await band($))[1]).toMatch(/驗證 · \d+m/)
  })
  test('subagent 內的 xcodebuild test 不改階段', async ($, on) => {
    await boot($, on, { agents: [{ id: 'a1', description: 'M48 T3 add parser', type: 'general-purpose', status: 'running' }] })
    await $.tool.call({ tool: TOOL, task: 'bugfix', stage: 'fix' } as any)
    await $.tool.call({ tool: 'Bash', command: 'xcodebuild test -scheme A', agentId: 'a1' } as any)
    expect((await band($))[1]).toMatch(/修正 · /)
  })
  test('ios-diagnose 在未宣告任務時一併設定 bugfix/diagnose（推測）', async ($, on) => {
    await boot($, on)
    await $.tool.call({ tool: 'Skill', skill: 'ios-diagnose' } as any)
    const rows = await band($)
    expect(rows[0]).toMatch(/^修bug 推測 ●━+◉/)
    expect(rows[1]?.trim()).toMatch(/^診斷 · /)
  })
  test('讀取類呼叫再多也不推斷 work（沒有點線）', async ($, on) => {
    await boot($, on, { ios: false })
    for (let i = 0; i < 12; i++) await $.tool.call({ tool: i % 2 ? 'Read' : 'WebSearch', file_path: '/x', query: 'q' } as any)
    expect((await band($))[0]).not.toMatch(/[●◉○]/)
  })
  test('store 放損壞資料：工具照常回結果、不 reject，band 仍能畫', async ($, on) => {
    const broken = { task: 'feature', stage: 'impl', stageSince: T0, updatedAt: T0, source: 'setstage', sessionId: 'old', badges: 'merge', milestone: 42, counts: 'x' }
    await boot($, on, { store: { [`stage:${CWD}`]: broken } })
    for (const e of [{ tool: 'Bash', command: 'git merge x' }, { tool: 'Read', file_path: '/x' }, { tool: 'Skill', skill: 'ios-review' }]) {
      const r: any = await $.tool.call(e as any)
      expect(r.result).toBe(`bottom:${e.tool}`)
    }
    const rows = await band($)
    expect(rows[0]).toContain('新功能')
  })
  test('顯示路徑出錯（ui.invalidate 失敗）時工具仍回結果、不 reject', async ($, on) => {
    on('ui.invalidate', () => {
      throw new Error('boom')
    })
    await boot($, on)
    for (const e of [{ tool: 'Bash', command: 'echo hi' }, { tool: 'Skill', skill: 'ios-diagnose' }, { tool: 'Read', file_path: '/x' }]) {
      const r: any = await $.tool.call(e as any)
      expect(r.result).toBe(`bottom:${e.tool}`)
    }
    const set: any = await $.tool.call({ tool: TOOL, task: 'bugfix', stage: 'fix' } as any)
    expect(typeof set.result).toBe('string')
  })
  test('舊版 store 的 tf 映射成 ship（ios 顯示 TF）', async ($, on) => {
    await boot($, on, { store: { [`stage:${CWD}`]: { stage: 'tf', stageSince: T0, updatedAt: T0, source: 'setstage', sessionId: 'old' } } })
    expect((await band($))[0]).toContain('上次：新功能 · TF')
  })
})

describe('新鮮度（截圖：舊推測被新 session 的 badge 洗白）', () => {
  const SCREENSHOT = { task: 'feature', taskSource: 'inferred', taskRank: 2, stage: 'ship', stageSince: T0 - 18 * 60 * MIN, updatedAt: T0 - 17 * 60 * MIN - 26 * MIN, source: 'guess', sessionId: 'old' }
  test('(a) 舊 session 推測 feature/ship，新 session 只跑 mutate.sh → dim「上次」行，不是點線；badge 照舊', async ($, on) => {
    await boot($, on, { store: { [`stage:${CWD}`]: SCREENSHOT } })
    await $.tool.call({ tool: 'Bash', command: 'scripts/mutate.sh src/a.ts' } as any)
    const rows = await band($)
    expect(rows[0]).not.toMatch(/[●◉○]/)
    expect(rows[0]).toContain('上次：新功能 · TF · 17 小時前')
    expect(rows.join('\n')).toContain('[mutation]')
    expect(rows.join('\n')).not.toContain('TF · 17h')
  })
  test('(b) 同一 session，SetStage 後 121 分鐘沒有步驟事件 → 「上次」', async ($, on) => {
    const { clock } = await boot($, on)
    await $.tool.call({ tool: TOOL, task: 'feature', stage: 'impl' } as any)
    expect((await band($))[0]).toMatch(/^新功能 ●/)
    await clock.advance(121 * MIN)
    const rows = await band($)
    expect(rows[0]).not.toMatch(/[●◉○]/)
    expect(rows[0]).toContain('上次：新功能 · 實作 · 2 小時前')
  })
  test('(c) 舊 store 之後新 session SetStage → 正常點亮', async ($, on) => {
    await boot($, on, { store: { [`stage:${CWD}`]: SCREENSHOT } })
    await $.tool.call({ tool: TOOL, task: 'bugfix', stage: 'diagnose' } as any)
    const rows = await band($)
    expect(rows[0]).toMatch(/^修bug ●━+◉/)
    expect(rows[1]?.trim()).toBe('診斷 · 0m')
  })
})

const turnStart = ($: any, turnId: string) => $.turn.start({ text: 'q', turnId } as any)
const turnComplete = ($: any, turnId: string, agentId?: string) =>
  $.turn.complete({ answer: 'a', durationMs: 1000, isAborted: false, turnId, reason: 'answer', ...(agentId ? { agentId } : {}) } as any)

describe('system prompt 提醒（f）', () => {
  const SECTION = 'env_info_simple'
  test('在 env_info_simple 段尾加提醒，用實際註冊到的工具名；其他段不動', async ($, on) => {
    await boot($, on, { toolPrefix: 'mcp__renamed__' })
    const r = await $.prompt.section({ name: SECTION, text: 'ENV' })
    expect(r.text!.startsWith('ENV\n\n')).toBe(true)
    expect(r.text).toContain('mcp__renamed__SetStage')
    expect(r.text).toContain('task')
    expect(r.text).toContain('純問答')
    expect((await $.prompt.section({ name: 'memory', text: 'M' })).text).toBe('M')
  })
  test('核心省略該段（null）時不硬塞', async ($, on) => {
    await boot($, on)
    expect((await $.prompt.section({ name: SECTION, text: null })).text).toBeNull()
  })
  test('SetStage 沒註冊成功就不加', async ($, on) => {
    await boot($, on, { registerFails: true })
    expect((await $.prompt.section({ name: SECTION, text: 'ENV' })).text).toBe('ENV')
  })
  const spyInvalidate = (on: any): string[] => {
    const events: string[] = []
    on('ui.invalidate', ($: any, e: any) => {
      events.push(e.event)
    })
    return events
  }
  test('session.start 後只 invalidate 一次 prompt.section；之後的工具呼叫、turn、tick 都不再 invalidate 它', async ($, on) => {
    const events = spyInvalidate(on)
    const { clock } = await boot($, on)
    expect(events.filter(e => e === 'prompt.section')).toHaveLength(1)
    await turnStart($, 't1')
    await $.tool.call({ tool: TOOL, task: 'feature', stage: 'impl' } as any)
    await $.tool.call({ tool: 'Bash', command: 'npm test' } as any)
    await turnComplete($, 't1')
    await clock.advance(5 * MIN)
    expect(events.filter(e => e === 'prompt.section')).toHaveLength(1)
  })
  test('SetStage 註冊失敗時不 invalidate prompt.section', async ($, on) => {
    const events = spyInvalidate(on)
    await boot($, on, { registerFails: true })
    expect(events).not.toContain('prompt.section')
  })
  test('SetStage 工具說明寫明純問答不用呼叫', async ($, on) => {
    const { descriptions } = await boot($, on)
    expect(descriptions.SetStage).toContain('純問答')
    expect(descriptions.SetStage).toContain('task')
  })
})

describe('問答偵測（d）', () => {
  test('沒有 fresh 任務：零工具 turn 後畫「問答中」；舊任務接「上次」', async ($, on) => {
    await boot($, on, { store: { [`stage:${CWD}`]: { task: 'feature', stage: 'ship', stageSince: T0, updatedAt: T0 - 17 * 60 * MIN, source: 'guess', sessionId: 'old' } } })
    await turnStart($, 't1')
    await turnComplete($, 't1')
    const rows = await band($)
    expect(rows[0]).toBe('問答中 · 上次：新功能 · TF · 17 小時前')
  })
  test('本 turn 出現非讀取動作但任務未判定 → 「判斷任務中…」；讀取類不算', async ($, on) => {
    await boot($, on, { ios: false })
    await turnStart($, 't1')
    await $.tool.call({ tool: 'Read', file_path: '/x' } as any)
    expect((await band($))[0]).toBe('問答中')
    await $.tool.call({ tool: 'Bash', command: 'npm run build' } as any)
    expect((await band($))[0]).toBe('判斷任務中…')
    await turnComplete($, 't1')
    expect((await band($))[0]).toBe('問答中')
    await turnStart($, 't2')
    expect((await band($))[0]).toBe('問答中')
  })
  test('有動作的 turn 結束、任務未判定、有舊任務 → 只畫「上次：…」', async ($, on) => {
    await boot($, on, { store: { [`stage:${CWD}`]: { task: 'feature', stage: 'ship', stageSince: T0, updatedAt: T0 - 17 * 60 * MIN, source: 'guess', sessionId: 'old' } } })
    await turnStart($, 't1')
    await $.tool.call({ tool: 'Bash', command: 'scripts/mutate.sh a' } as any)
    expect((await band($))[0]).toBe('判斷任務中… · 上次：新功能 · TF · 17 小時前')
    await turnComplete($, 't1')
    expect((await band($))[0]).toBe('上次：新功能 · TF · 17 小時前')
  })
  test('背景 subagent 完成後的接續 turn（text 為空）不把有動作的 turn 改判成對話', async ($, on) => {
    await boot($, on)
    await turnStart($, 't1')
    await $.tool.call({ tool: TOOL, task: 'feature', stage: 'impl' } as any)
    await $.tool.call({ tool: 'Agent', description: 'T3 add parser' } as any)
    await turnComplete($, 't1')
    await $.turn.start({ text: '', turnId: 't2' } as any)
    await turnComplete($, 't2')
    expect((await band($)).join('\n')).not.toContain('討論中')
  })
  test('有 fresh 任務：讀取類 turn 後第三行「討論中」，任務／步驟不變', async ($, on) => {
    const { clock } = await boot($, on)
    await turnStart($, 't1')
    await $.tool.call({ tool: TOOL, task: 'feature', stage: 'impl', detail: 'T2/5' } as any)
    await turnComplete($, 't1')
    const before = await band($)
    expect(before.join('\n')).not.toContain('討論中')
    await clock.advance(3 * MIN)
    await turnStart($, 't2')
    await $.tool.call({ tool: 'Read', file_path: '/x' } as any)
    await $.tool.call({ tool: 'Grep', pattern: 'x' } as any)
    await turnComplete($, 't2')
    const rows = await band($)
    expect(rows[0]).toBe(before[0])
    expect(rows[1]?.trim()).toBe('實作 · T2/5 · 3m')
    expect(rows[2]).toBe('討論中')
  })
  test('subagent 的 turn.complete 不算主迴圈的對話 turn', async ($, on) => {
    await boot($, on)
    await turnStart($, 't1')
    await $.tool.call({ tool: TOOL, task: 'feature', stage: 'impl' } as any)
    await turnComplete($, 'sub-1', 'a1')
    expect((await band($)).join('\n')).not.toContain('討論中')
  })
  test('零工具 turn：有 fresh 任務時第三行「討論中」', async ($, on) => {
    await boot($, on)
    await turnStart($, 't1')
    await $.tool.call({ tool: TOOL, task: 'bugfix', stage: 'diagnose' } as any)
    await turnComplete($, 't1')
    await turnStart($, 't2')
    await turnComplete($, 't2')
    const rows = await band($)
    expect(rows[0]).toMatch(/^修bug ●━+◉/)
    expect(rows[2]).toBe('討論中')
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
    const { clock } = await boot($, on, { env: { DEV_STAGE_BAR_STUCK_MIN: '1' } })
    const pending = $.tool.call({ tool: 'Bash', command: 'sleep 9999' } as any)
    await clock.settle()
    await clock.advance(2 * MIN)
    expect((await band($))[1]).toContain('⚠ 主迴圈 2 分鐘沒有動靜')
    await clock.advance(30 * MIN)
    await pending
    expect((await band($))[1] ?? '').not.toContain('⚠')
  })
  test('等授權的時間不算卡住；band 重新出現（授權結束）後才開始計時', async ($, on) => {
    const { clock } = await boot($, on, { env: { DEV_STAGE_BAR_STUCK_MIN: '1' } })
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
