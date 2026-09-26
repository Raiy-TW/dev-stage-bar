import { test, expect, describe } from 'claude-code/testing'
import { evaluateStatus, renderLines, lineText, type Activity } from '../src/format.ts'
import { emptyState, applySetStage, applyClassification } from '../src/state.ts'
import { displayWidth } from '../src/width.ts'
import { THRESHOLDS, COLORS } from '../src/stages.ts'

const MIN = 60_000
const S = 'sess'
const T0 = 1_000_000_000_000

function act(over: Partial<Activity> = {}): Activity {
  return { now: T0, isWorking: false, lastEventAt: null, lastEventByOwner: {}, calls: [], agents: [], ...over }
}

describe('卡住判定門檻', () => {
  test('工具呼叫進行超過 stuckToolMin 且該 loop 沒有新事件 → stuck', async () => {
    const start = T0 - 21 * MIN
    const a = act({ calls: [{ id: 'c1', tool: 'Bash', label: 'xcodebuild test', startedAt: start }], lastEventAt: start, lastEventByOwner: { main: start } })
    expect(evaluateStatus(emptyState(), a, THRESHOLDS).kind).toBe('stuck')
  })
  test('19 分鐘還不算卡住（turn 進行中）', async () => {
    const start = T0 - 19 * MIN
    const a = act({ isWorking: true, calls: [{ id: 'c1', tool: 'Bash', label: 'xcodebuild test', startedAt: start }], lastEventAt: start, lastEventByOwner: { main: start } })
    expect(evaluateStatus(emptyState(), a, THRESHOLDS).kind).toBe('running')
  })
  test('isWorking 且主迴圈 xcodebuild test 跑 15 分鐘 → running（不走「沒有工具活動」分支）', async () => {
    const start = T0 - 15 * MIN
    const a = act({ isWorking: true, calls: [{ id: 'c1', tool: 'Bash', label: 'xcodebuild test', startedAt: start }], lastEventAt: start, lastEventByOwner: { main: start } })
    expect(evaluateStatus(emptyState(), a, THRESHOLDS).kind).toBe('running')
  })
  test('isWorking 且超過 stuckIdleMin 沒有工具事件 → stuck', async () => {
    const a = act({ isWorking: true, lastEventAt: T0 - 11 * MIN })
    const st = evaluateStatus(emptyState(), a, THRESHOLDS)
    expect(st.kind).toBe('stuck')
    expect(st.text).toContain('11 分鐘')
  })
  test('沒在工作時 11 分鐘沒事件不算卡住', async () => {
    const a = act({ isWorking: false, lastEventAt: T0 - 11 * MIN })
    expect(evaluateStatus(emptyState(), a, THRESHOLDS).kind).toBe('idle')
  })
  test('門檻可調低（覆寫 stuckToolMin=1）', async () => {
    const start = T0 - 2 * MIN
    const a = act({ calls: [{ id: 'c1', tool: 'Bash', label: 'sleep 200', startedAt: start }], lastEventAt: start, lastEventByOwner: { main: start } })
    expect(evaluateStatus(emptyState(), a, { ...THRESHOLDS, stuckToolMin: 1 }).kind).toBe('stuck')
  })
  test('subagent 卡住訊息帶簡稱與指令', async () => {
    const start = T0 - 25 * MIN
    const a = act({
      calls: [{ id: 'c1', tool: 'Bash', label: 'xcodebuild test', agentId: 'a1', startedAt: start }],
      agents: [{ id: 'a1', short: 'T3 impl', startedAt: T0 - 40 * MIN }],
      lastEventAt: start, lastEventByOwner: { a1: start },
    })
    const st = evaluateStatus(emptyState(), a, THRESHOLDS)
    expect(st.kind).toBe('stuck')
    expect(st.text).toBe('⚠ T3 impl 25 分鐘沒有動靜（xcodebuild test 仍在跑）')
  })
})

describe('等待與執行中', () => {
  test('AskUserQuestion 進行中 → waiting', async () => {
    const a = act({ calls: [{ id: 'q', tool: 'AskUserQuestion', label: 'AskUserQuestion', startedAt: T0 }], lastEventAt: T0 })
    expect(evaluateStatus(emptyState(), a, THRESHOLDS).kind).toBe('waiting')
  })
  test('等待授權的呼叫 → waiting（授權），不算卡住', async () => {
    const start = T0 - 30 * MIN
    const a = act({ calls: [{ id: 'c1', tool: 'Bash', label: 'rm -x', startedAt: start, awaitingPermission: true }], lastEventAt: start, lastEventByOwner: { main: start }, isWorking: true })
    const st = evaluateStatus(emptyState(), a, THRESHOLDS)
    expect(st.kind).toBe('waiting')
    expect(st.text).toBe('⏸ 等你：授權 rm -x')
  })
  test('AskUserQuestion 等很久也不算卡住', async () => {
    const start = T0 - 60 * MIN
    const a = act({ calls: [{ id: 'q', tool: 'AskUserQuestion', label: 'AskUserQuestion', startedAt: start }], lastEventAt: start, lastEventByOwner: { main: start }, isWorking: true })
    expect(evaluateStatus(emptyState(), a, THRESHOLDS).kind).toBe('waiting')
  })
  test('accept（真機驗收）階段 → waiting；submit 已送出 → waiting；submit 未送出 → 不是 waiting', async () => {
    expect(evaluateStatus(applySetStage(emptyState(), { task: 'feature', stage: 'accept' }, T0, S), act(), THRESHOLDS).kind).toBe('waiting')
    const sub = applyClassification(applySetStage(emptyState(), { task: 'feature', stage: 'submit' }, T0, S), { guess: 'submit', submitted: true }, T0, S, 'ios')
    expect(evaluateStatus(sub, act(), THRESHOLDS).kind).toBe('waiting')
    expect(evaluateStatus(applySetStage(emptyState(), { task: 'feature', stage: 'submit' }, T0, S), act(), THRESHOLDS).kind).toBe('idle')
  })
  test('5 分鐘內有工具活動 → running；超過 → idle', async () => {
    expect(evaluateStatus(emptyState(), act({ lastEventAt: T0 - 4 * MIN }), THRESHOLDS).kind).toBe('running')
    expect(evaluateStatus(emptyState(), act({ lastEventAt: T0 - 6 * MIN }), THRESHOLDS).kind).toBe('idle')
  })
})

describe('點線進度條', () => {
  const st = applySetStage(emptyState(), { task: 'feature', stage: 'verify', detail: 'T3/5', milestone: 'M48' }, T0 - 12 * MIN, S)
  const opts = (columns: number, maxRows = 5) => ({ sessionId: S, columns, maxRows, th: THRESHOLDS, project: 'ios' as const })
  const dotCols = (t: string): number[] => {
    // 回傳每個點（●◉○）所在的欄位（點與線都是 1 欄字元）。
    const cols: number[] = []
    let col = 0
    for (const ch of t) {
      if ('●◉○'.includes(ch)) cols.push(col)
      col += displayWidth(ch)
    }
    return cols
  }

  test('寬版第 1 行：9 個點平均分布、連接線隨寬度伸縮、M48 在右側', async () => {
    for (const cols of [60, 100, 160]) {
      const [bar] = renderLines(st, act(), opts(cols))
      const t = lineText(bar!)
      const xs = dotCols(t)
      expect(xs).toHaveLength(9)
      const gaps = xs.slice(1).map((x, i) => x - xs[i]!)
      expect(new Set(gaps).size).toBe(1)
      expect(gaps[0]!).toBeGreaterThanOrEqual(2)
      expect(t).toMatch(/M48$/)
      expect(displayWidth(t)).toBeLessThanOrEqual(cols)
      // 寬度越大，點距越大（右側只留 milestone 與少量邊距）。
      expect(displayWidth(t)).toBeGreaterThan(cols - 12)
    }
    const g = (cols: number) => { const xs = dotCols(lineText(renderLines(st, act(), opts(cols))[0]!)); return xs[1]! - xs[0]! }
    expect(g(160)).toBeGreaterThan(g(100))
    expect(g(100)).toBeGreaterThan(g(60))
  })

  test('已過 ●━ 柔和綠、目前 ◉ 粗體主色、未到 ○┄ dim；不再列出 9 個階段名與載／存', async () => {
    const [bar] = renderLines(st, act(), opts(160))
    const t = lineText(bar!)
    expect(t.startsWith('新功能 ●━')).toBe(true)
    expect(t).toContain('◉┄')
    for (const w of ['需求', '規格', '拆解', '實作', '驗證', '審查', 'TF', '真機', '送審', '載', '存']) expect(t).not.toContain(w)
    const done = bar!.filter(s => /[●━]/.test(s.text))
    expect(done.length).toBeGreaterThan(0)
    expect(done.every(s => s.color === COLORS.done)).toBe(true)
    const cur = bar!.find(s => s.text === '◉')
    expect(cur?.bold).toBe(true)
    expect(cur?.color).toBe(COLORS.current)
    expect(bar!.filter(s => /[○┄]/.test(s.text)).every(s => s.dim)).toBe(true)
  })

  test('第 2 行：階段名 · detail · 耗時，文字中心對準目前點', async () => {
    const lines = renderLines(st, act(), opts(160))
    const xs = dotCols(lineText(lines[0]!))
    const label = lineText(lines[1]!)
    expect(label.trim()).toBe('驗證 · T3/5 · 12m')
    const start = displayWidth(label) - displayWidth(label.trimStart())
    const center = start + Math.floor(displayWidth(label.trim()) / 2)
    expect(Math.abs(center - xs[4]!)).toBeLessThanOrEqual(1)
  })

  test('第 1 點（intent）與第 9 點（submit）的文字夾在邊界內', async () => {
    const first = applySetStage(emptyState(), { task: 'feature', stage: 'intent', detail: 'long detail here' }, T0 - 3 * MIN, S)
    const l1 = lineText(renderLines(first, act(), opts(100))[1]!)
    expect(l1.startsWith('需求')).toBe(true)
    const last = applySetStage(emptyState(), { task: 'feature', stage: 'submit', detail: 'long detail here', milestone: 'M48' }, T0 - 3 * MIN, S)
    const lines = renderLines(last, act(), opts(100))
    const l9 = lineText(lines[1]!)
    expect(displayWidth(l9)).toBeLessThanOrEqual(100)
    expect(l9.trim()).toBe('送審 · long detail here · 3m')
    const xs = dotCols(lineText(lines[0]!))
    // 文字右端不超過目前點太遠（夾邊時右對齊到可用寬度內）。
    expect(displayWidth(l9)).toBeGreaterThanOrEqual(xs[8]!)
  })

  test('尚未判定任務：只畫一行 dim 的「判斷任務中…」，不畫點線', async () => {
    const lines = renderLines(emptyState(), act(), opts(160))
    expect(lines).toHaveLength(1)
    expect(lineText(lines[0]!)).toBe('判斷任務中…')
    expect(lines[0]!.every(s => s.dim)).toBe(true)
  })

  test('有任務但尚未進入步驟：任務名＋全部 ○ 與 ┄，不畫第 2 行', async () => {
    const s0 = applyClassification(emptyState(), { task: 'feature', taskStrength: 'weak' }, T0, S, 'default')
    const lines = renderLines(s0, act(), { ...opts(160), project: 'default' })
    expect(lines).toHaveLength(1)
    const t = lineText(lines[0]!)
    expect(t).not.toMatch(/[●◉━]/)
    expect(dotCols(t)).toHaveLength(8)
  })

  test('第 1 行最左是任務名；點數依任務與專案（bugfix 7、default feature 8）', async () => {
    const bug = applySetStage(emptyState(), { task: 'bugfix', stage: 'diagnose' }, T0, S)
    const t = lineText(renderLines(bug, act(), opts(120))[0]!)
    expect(t.startsWith('修bug ')).toBe(true)
    expect(dotCols(t)).toHaveLength(7)
    const web = applySetStage(emptyState(), { task: 'feature', stage: 'ship' }, T0, S)
    const lines = renderLines(web, act(), { ...opts(120), project: 'default' })
    expect(dotCols(lineText(lines[0]!))).toHaveLength(8)
    expect(lineText(lines[1]!).trim()).toBe('部署 · 0m')
  })

  test('宣告的任務名用主色；推斷的任務名 dim 並附「推測」', async () => {
    const declared = renderLines(applySetStage(emptyState(), { task: 'bugfix', stage: 'fix' }, T0, S), act(), opts(120))[0]!
    expect(declared[0]).toEqual(expect.objectContaining({ text: '修bug', color: COLORS.current }))
    const inferred = applyClassification(emptyState(), { task: 'bugfix', authority: 'diagnose' }, T0, S, 'ios')
    const line = renderLines(inferred, act(), opts(120))[0]!
    expect(lineText(line).startsWith('修bug 推測 ●')).toBe(true)
    expect(line[0]!.dim).toBe(true)
  })

  test('不 fresh（上個 session）：不畫點線，只畫一行 dim「上次：任務 · 步驟 · X 前」', async () => {
    const old = applySetStage(emptyState(), { task: 'feature', stage: 'ship' }, T0 - 17 * 60 * MIN, 'old')
    for (const cols of [160, 38]) {
      const lines = renderLines(old, act(), opts(cols))
      expect(lines).toHaveLength(1)
      const t = lineText(lines[0]!)
      expect(t).toContain('上次：新功能 · TF · 17 小時前')
      expect(t).not.toMatch(/[●◉○]/)
      expect(lines[0]!.every(s => s.dim)).toBe(true)
    }
    expect(lineText(renderLines(old, act(), { ...opts(160), maxRows: 1 })[0]!)).toContain('上次：新功能 · TF · 17 小時前')
  })
  test('同 session 但 stageAt 超過 staleAfterMin → 同樣是「上次」', async () => {
    const s = applySetStage(emptyState(), { task: 'bugfix', stage: 'fix' }, T0 - 121 * MIN, S)
    expect(lineText(renderLines(s, act(), opts(160))[0]!)).toContain('上次：修bug · 修正 · 2 小時前')
    const fresh = applySetStage(emptyState(), { task: 'bugfix', stage: 'fix' }, T0 - 119 * MIN, S)
    expect(lineText(renderLines(fresh, act(), opts(160))[0]!)).toMatch(/^修bug ●/)
  })
  test('舊 store 沒有 stageAt：用 updatedAt 算多久前；沒有步驟時省略步驟段', async () => {
    const legacy = { task: 'feature' as const, taskSource: 'inferred' as const, stage: null, stageSince: 0, updatedAt: T0 - 3 * 60 * MIN, source: 'none' as const, sessionId: 'old' }
    expect(lineText(renderLines(legacy, act(), opts(160))[0]!)).toContain('上次：新功能 · 3 小時前')
  })
  test('不 fresh 的 accept／已送審不顯示「⏸ 等你」', async () => {
    const acc = applySetStage(emptyState(), { task: 'feature', stage: 'accept' }, T0 - 17 * 60 * MIN, 'old')
    for (const l of renderLines(acc, act(), opts(160))) expect(lineText(l)).not.toContain('⏸')
  })

  test('活動列在第 3 行；maxRows < 3 時第 2 行併進活動列開頭', async () => {
    const a = act({ lastEventAt: T0 })
    const three = renderLines(st, a, opts(160, 5))
    expect(three).toHaveLength(3)
    expect(lineText(three[2]!)).toContain('🔄')
    const two = renderLines(st, a, opts(160, 2))
    expect(two).toHaveLength(2)
    expect(lineText(two[1]!)).toMatch(/^驗證 · T3\/5 · 12m · 🔄/)
    const one = renderLines(st, a, opts(160, 1))
    expect(one).toHaveLength(1)
    expect(lineText(one[0]!)).toContain('驗證')
  })

  test('窄版（< NARROW_COLUMNS 或點距不到 1 格）：單行 新功能 ●●●●◉○○○○ 驗證 · T3/5 · 12m', async () => {
    const lines = renderLines(st, act(), opts(38))
    expect(lines).toHaveLength(1)
    expect(lineText(lines[0]!)).toBe('新功能 ●●●●◉○○○○ 驗證 · T3/5 · 12m')
  })

  test('任何寬度都不超過 columns', async () => {
    for (const cols of [10, 20, 24, 26, 30, 40, 60, 89, 100, 160]) {
      for (const l of renderLines(st, act({ lastEventAt: T0 }), opts(cols))) {
        expect(displayWidth(lineText(l))).toBeLessThanOrEqual(cols)
      }
    }
  })
})

describe('活動列', () => {
  const st = applyClassification(applySetStage(emptyState(), { task: 'feature', stage: 'impl' }, T0, S), { badge: 'debug' }, T0, S, 'ios')
  const st2 = applyClassification(st, { badge: 'merge' }, T0, S, 'ios')
  test('執行中：subagent 簡稱、其最久指令與耗時、badge', async () => {
    const a = act({
      lastEventAt: T0 - MIN,
      calls: [{ id: 'c1', tool: 'Bash', label: 'xcodebuild test', agentId: 'a1', startedAt: T0 - 12 * MIN }],
      agents: [{ id: 'a1', short: 'T3 impl', startedAt: T0 - 20 * MIN }, { id: 'a2', short: 'T2 review', startedAt: T0 - 3 * MIN }],
      lastEventByOwner: { a1: T0 - MIN, a2: T0 - MIN },
    })
    const lines = renderLines(st2, a, { sessionId: S, columns: 160, maxRows: 5, th: THRESHOLDS, project: 'ios' as const })
    expect(lines).toHaveLength(3)
    const t = lineText(lines[2]!)
    expect(t).toContain('🔄 T3 impl: xcodebuild test 12m · T2 review 3m')
    expect(t).toContain('[debug] [merge]')
  })
  test('短於 showToolAfterSec 的呼叫不顯示', async () => {
    const a = act({ lastEventAt: T0, calls: [{ id: 'c1', tool: 'Bash', label: 'echo hi', startedAt: T0 - 5_000 }] })
    const lines = renderLines(emptyState(), a, { sessionId: S, columns: 160, maxRows: 5, th: THRESHOLDS, project: 'ios' as const })
    expect(lineText(lines[1]!)).not.toContain('echo hi')
  })
  test('卡住時整行用 stuck 色', async () => {
    const start = T0 - 30 * MIN
    const a = act({ calls: [{ id: 'c1', tool: 'Bash', label: 'sleep 9999', startedAt: start }], lastEventAt: start, lastEventByOwner: { main: start } })
    const lines = renderLines(emptyState(), a, { sessionId: S, columns: 160, maxRows: 5, th: THRESHOLDS, project: 'ios' as const })
    const l2 = lines[1]!
    expect(lineText(l2)).toContain('⚠ 主迴圈 30 分鐘沒有動靜（sleep 9999 仍在跑）')
    expect(l2.every(s => s.color === COLORS.stuck)).toBe(true)
  })
  test('閒置且無 badge → 只有一行；maxRows=1 → 只有一行', async () => {
    expect(renderLines(emptyState(), act(), { sessionId: S, columns: 160, maxRows: 5, th: THRESHOLDS, project: 'ios' as const })).toHaveLength(1)
    const a = act({ lastEventAt: T0 })
    expect(renderLines(emptyState(), a, { sessionId: S, columns: 160, maxRows: 1, th: THRESHOLDS, project: 'ios' as const })).toHaveLength(1)
  })
})
