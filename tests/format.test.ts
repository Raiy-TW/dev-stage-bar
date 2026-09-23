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
  test('19 分鐘還不算卡住', async () => {
    const start = T0 - 19 * MIN
    const a = act({ calls: [{ id: 'c1', tool: 'Bash', label: 'xcodebuild test', startedAt: start }], lastEventAt: start, lastEventByOwner: { main: start } })
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
  test('device 階段 → waiting；submit 已送出 → waiting；submit 未送出 → 不是 waiting', async () => {
    expect(evaluateStatus(applySetStage(emptyState(), { stage: 'device' }, T0, S), act(), THRESHOLDS).kind).toBe('waiting')
    const sub = applyClassification(applySetStage(emptyState(), { stage: 'submit' }, T0, S), { guess: 'submit', submitted: true }, T0, S)
    expect(evaluateStatus(sub, act(), THRESHOLDS).kind).toBe('waiting')
    expect(evaluateStatus(applySetStage(emptyState(), { stage: 'submit' }, T0, S), act(), THRESHOLDS).kind).toBe('idle')
  })
  test('5 分鐘內有工具活動 → running；超過 → idle', async () => {
    expect(evaluateStatus(emptyState(), act({ lastEventAt: T0 - 4 * MIN }), THRESHOLDS).kind).toBe('running')
    expect(evaluateStatus(emptyState(), act({ lastEventAt: T0 - 6 * MIN }), THRESHOLDS).kind).toBe('idle')
  })
})

describe('第一行', () => {
  const st = applySetStage(emptyState(), { stage: 'verify', detail: 'T3/5', milestone: 'M48' }, T0 - 42 * MIN, S)
  test('寬版：9 格、M48 在最前、尾巴有 detail 與本階段耗時', async () => {
    const [l1] = renderLines(st, act(), { sessionId: S, columns: 160, maxRows: 5, th: THRESHOLDS })
    const t = lineText(l1!)
    expect(t).toContain('M48')
    expect(t.indexOf('M48')).toBeLessThan(t.indexOf('需求'))
    for (const w of ['需求', '規格', '拆解', '實作', '驗證', '審查', 'TF', '真機', '送審']) expect(t).toContain(w)
    expect(t).toContain('━')
    expect(t).toMatch(/驗證 T3\/5 · 42m/)
    expect(displayWidth(t)).toBeLessThanOrEqual(160)
  })
  test('目前格反白粗體、已過格柔和綠、未到 dim', async () => {
    const [l1] = renderLines(st, act(), { sessionId: S, columns: 160, maxRows: 5, th: THRESHOLDS })
    const cur = l1!.find(s => s.text === '驗證' && s.inverse)
    expect(cur?.bold).toBe(true)
    expect(l1!.find(s => s.text === '需求')?.color).toBe(COLORS.done)
    expect(l1!.find(s => s.text === '送審')?.dim).toBe(true)
  })
  test('窄寬降級（<90）：M48 4/9 驗證 ▰▰▰▰▱▱▱▱▱ 42m（4/9 = 已完成格數，照範例）', async () => {
    const [l1] = renderLines(st, act(), { sessionId: S, columns: 80, maxRows: 5, th: THRESHOLDS })
    const t = lineText(l1!)
    expect(t).toContain('M48 4/9 驗證 ▰▰▰▰▱▱▱▱▱ 42m')
    expect(displayWidth(t)).toBeLessThanOrEqual(80)
  })
  test('非常窄時不超過寬度', async () => {
    for (const cols of [20, 30, 40, 89, 90, 95]) {
      for (const l of renderLines(st, act(), { sessionId: S, columns: cols, maxRows: 5, th: THRESHOLDS })) {
        expect(displayWidth(lineText(l))).toBeLessThanOrEqual(cols)
      }
    }
  })
  test('上個 session 的狀態標示「上次更新 X 小時前」', async () => {
    const old = applySetStage(emptyState(), { stage: 'impl' }, T0 - 3 * 60 * MIN, 'old')
    const [l1] = renderLines(old, act(), { sessionId: S, columns: 160, maxRows: 5, th: THRESHOLDS })
    expect(lineText(l1!)).toContain('上次更新 3 小時前')
    const [fresh] = renderLines(old, act(), { sessionId: 'old', columns: 160, maxRows: 5, th: THRESHOLDS })
    expect(lineText(fresh!)).not.toContain('上次更新')
  })
})

describe('第二行', () => {
  const st = applyClassification(applySetStage(emptyState(), { stage: 'impl' }, T0, S), { badge: 'debug' }, T0, S)
  const st2 = applyClassification(st, { badge: 'merge' }, T0, S)
  test('執行中：subagent 簡稱、其最久指令與耗時、badge', async () => {
    const a = act({
      lastEventAt: T0 - MIN,
      calls: [{ id: 'c1', tool: 'Bash', label: 'xcodebuild test', agentId: 'a1', startedAt: T0 - 12 * MIN }],
      agents: [{ id: 'a1', short: 'T3 impl', startedAt: T0 - 20 * MIN }, { id: 'a2', short: 'T2 review', startedAt: T0 - 3 * MIN }],
      lastEventByOwner: { a1: T0 - MIN, a2: T0 - MIN },
    })
    const lines = renderLines(st2, a, { sessionId: S, columns: 160, maxRows: 5, th: THRESHOLDS })
    expect(lines).toHaveLength(2)
    const t = lineText(lines[1]!)
    expect(t).toContain('🔄 T3 impl: xcodebuild test 12m · T2 review 3m')
    expect(t).toContain('[debug] [merge]')
  })
  test('短於 showToolAfterSec 的呼叫不顯示', async () => {
    const a = act({ lastEventAt: T0, calls: [{ id: 'c1', tool: 'Bash', label: 'echo hi', startedAt: T0 - 5_000 }] })
    const lines = renderLines(emptyState(), a, { sessionId: S, columns: 160, maxRows: 5, th: THRESHOLDS })
    expect(lineText(lines[1]!)).not.toContain('echo hi')
  })
  test('卡住時整行用 stuck 色', async () => {
    const start = T0 - 30 * MIN
    const a = act({ calls: [{ id: 'c1', tool: 'Bash', label: 'sleep 9999', startedAt: start }], lastEventAt: start, lastEventByOwner: { main: start } })
    const lines = renderLines(emptyState(), a, { sessionId: S, columns: 160, maxRows: 5, th: THRESHOLDS })
    const l2 = lines[1]!
    expect(lineText(l2)).toContain('⚠ 主迴圈 30 分鐘沒有動靜（sleep 9999 仍在跑）')
    expect(l2.every(s => s.color === COLORS.stuck)).toBe(true)
  })
  test('閒置且無 badge → 只有一行；maxRows=1 → 只有一行', async () => {
    expect(renderLines(emptyState(), act(), { sessionId: S, columns: 160, maxRows: 5, th: THRESHOLDS })).toHaveLength(1)
    const a = act({ lastEventAt: T0 })
    expect(renderLines(emptyState(), a, { sessionId: S, columns: 160, maxRows: 1, th: THRESHOLDS })).toHaveLength(1)
  })
})
