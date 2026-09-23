// 狀態判定與兩行排版（純函式，無 $）：輸出 segment 陣列，由 hooks/index.ts 轉成 Box/Text。
import { COLORS, HANDOFF_GLYPH, NARROW_COLUMNS, STAGES, WAITING_STAGES, type THRESHOLDS } from './stages.ts'
import type { StageState } from './state.ts'
import { displayWidth, truncateToWidth } from './width.ts'

export type Thresholds = { readonly [K in keyof typeof THRESHOLDS]: number }

export type InFlight = { id: string; tool: string; label: string; agentId?: string; startedAt: number }
export type AgentRow = { id: string; short: string; startedAt: number }

export type Activity = {
  now: number
  /** AbovePrompt 的 isWorking（模型 turn 進行中）。 */
  isWorking: boolean
  /** 最後一次任何 tool.call 事件（開始或結束）。 */
  lastEventAt: number | null
  /** 每個 loop（'main' 或 agentId）最後一次 tool.call 事件。 */
  lastEventByOwner: Readonly<Record<string, number>>
  calls: readonly InFlight[]
  /** 進行中的 subagent。 */
  agents: readonly AgentRow[]
}

export type Seg = { text: string; color?: string; bold?: boolean; dim?: boolean; inverse?: boolean }
export type Line = Seg[]

export type StatusKind = 'stuck' | 'waiting' | 'running' | 'idle'
export type Status = { kind: StatusKind; text: string }

const MIN = 60_000
const MAIN = 'main'
const ASK_TOOL = 'AskUserQuestion'

const minutes = (ms: number): number => Math.max(0, Math.floor(ms / MIN))

export function fmtDuration(ms: number): string {
  const m = minutes(ms)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h${m % 60}m`
}

function fmtAgo(ms: number): string {
  const m = minutes(ms)
  if (m < 60) return `${m} 分鐘前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小時前`
  return `${Math.floor(h / 24)} 天前`
}

const ownerOf = (c: InFlight): string => c.agentId ?? MAIN

function ownerName(owner: string, act: Activity): string {
  if (owner === MAIN) return '主迴圈'
  return act.agents.find(a => a.id === owner)?.short ?? 'subagent'
}

export function evaluateStatus(state: StageState, act: Activity, th: Thresholds): Status {
  const { now } = act
  const asking = act.calls.some(c => c.tool === ASK_TOOL)

  // ⚠ 工具呼叫進行太久，且該 loop 之後沒有任何新事件。
  const stuckCalls = act.calls
    .filter(c => c.tool !== ASK_TOOL && c.tool !== 'Agent')
    .filter(c => now - c.startedAt > th.stuckToolMin * MIN)
    .filter(c => now - (act.lastEventByOwner[ownerOf(c)] ?? c.startedAt) > th.stuckToolMin * MIN)
    .sort((a, b) => a.startedAt - b.startedAt)
  const oldest = stuckCalls[0]
  if (oldest) {
    const owner = ownerOf(oldest)
    const since = act.lastEventByOwner[owner] ?? oldest.startedAt
    return { kind: 'stuck', text: `⚠ ${ownerName(owner, act)} ${minutes(now - since)} 分鐘沒有動靜（${oldest.label} 仍在跑）` }
  }
  // ⚠ turn 進行中卻很久沒有任何工具事件（模型本身可能卡住）。
  if (!asking && act.isWorking && act.lastEventAt !== null && now - act.lastEventAt > th.stuckIdleMin * MIN) {
    return { kind: 'stuck', text: `⚠ ${minutes(now - act.lastEventAt)} 分鐘沒有任何工具活動（模型可能卡住）` }
  }
  if (asking) return { kind: 'waiting', text: '⏸ 等你：回答問題' }
  if (state.stage && WAITING_STAGES.includes(state.stage)) return { kind: 'waiting', text: '⏸ 等你：真機驗收' }
  if (state.stage === 'submit' && state.submitted) return { kind: 'waiting', text: '⏸ 排審中' }
  if (act.calls.length > 0 || act.agents.length > 0 || (act.lastEventAt !== null && now - act.lastEventAt <= th.activeMin * MIN)) {
    return { kind: 'running', text: '🔄' }
  }
  return { kind: 'idle', text: '' }
}

// ── 第一行 ────────────────────────────────────────────────

function stageIndex(state: StageState): number {
  return state.stage ? STAGES.findIndex(s => s.id === state.stage) : -1
}

function tailText(state: StageState, now: number, withDetail: boolean): string {
  const idx = stageIndex(state)
  if (idx < 0) return '尚未設定階段'
  const label = STAGES[idx]!.label
  const detail = withDetail && state.detail ? ` ${state.detail}` : ''
  return `${label}${detail} · ${fmtDuration(now - state.stageSince)}`
}

function staleText(state: StageState, sessionId: string, now: number): string | undefined {
  if (!state.sessionId || state.sessionId === sessionId || !state.updatedAt) return undefined
  return `上次更新 ${fmtAgo(now - state.updatedAt)}`
}

const width = (line: Line): number => line.reduce((w, s) => w + displayWidth(s.text), 0)

function wideLine(state: StageState, now: number, sessionId: string, opts: { detail: boolean; stale: boolean; handoff: boolean }): Line {
  const idx = stageIndex(state)
  const line: Line = [{ text: ' ' }]
  if (state.milestone) line.push({ text: state.milestone, color: COLORS.milestone, bold: true }, { text: '  ' })
  const fresh = state.sessionId === sessionId
  if (opts.handoff) {
    const loaded = fresh && state.handoff === 'load'
    line.push({ text: HANDOFF_GLYPH.load, ...(loaded ? { color: COLORS.current } : { dim: true }) }, { text: ' ' })
  }
  STAGES.forEach((s, i) => {
    if (i > 0) line.push({ text: i <= idx ? ' ━ ' : ' ─ ', ...(i <= idx ? { color: COLORS.done } : { dim: true }) })
    if (i < idx) line.push({ text: s.label, color: COLORS.done })
    else if (i === idx) line.push({ text: s.label, color: COLORS.current, bold: true, inverse: true })
    else line.push({ text: s.label, dim: true })
  })
  if (opts.handoff) {
    const saved = fresh && state.handoff === 'save'
    line.push({ text: ' ' }, { text: HANDOFF_GLYPH.save, ...(saved ? { color: COLORS.done } : { dim: true }) })
  }
  line.push({ text: '   ' }, { text: tailText(state, now, opts.detail), bold: idx >= 0 })
  const stale = opts.stale ? staleText(state, sessionId, now) : undefined
  if (stale) line.push({ text: ` · ${stale}`, dim: true })
  return line
}

function narrowLine(state: StageState, now: number, sessionId: string, columns: number): Line {
  const idx = stageIndex(state)
  const done = Math.max(0, idx)
  const bar = '▰'.repeat(done) + '▱'.repeat(STAGES.length - done)
  const line: Line = []
  if (state.milestone) line.push({ text: `${state.milestone} `, color: COLORS.milestone, bold: true })
  if (idx >= 0) {
    line.push({ text: `${done}/${STAGES.length} ` }, { text: STAGES[idx]!.label, color: COLORS.current, bold: true })
    line.push({ text: ' ' }, { text: bar, color: COLORS.done }, { text: ` ${fmtDuration(now - state.stageSince)}` })
    if (state.detail) line.push({ text: ` · ${state.detail}` })
  } else {
    line.push({ text: bar, dim: true }, { text: ' 尚未設定階段' })
  }
  const stale = staleText(state, sessionId, now)
  if (stale && width(line) + displayWidth(stale) + 3 <= columns) line.push({ text: ` · ${stale}`, dim: true })
  return fitLine(line, columns)
}

/** 從尾端截斷到 columns 欄內。 */
function fitLine(line: Line, columns: number): Line {
  if (width(line) <= columns) return line
  const out: Line = []
  let used = 0
  for (const seg of line) {
    const w = displayWidth(seg.text)
    if (used + w <= columns - 1) {
      out.push(seg)
      used += w
      continue
    }
    const room = columns - used
    if (room > 0) out.push({ ...seg, text: truncateToWidth(seg.text, room) })
    break
  }
  return out
}

function firstLine(state: StageState, now: number, sessionId: string, columns: number): Line {
  if (columns >= NARROW_COLUMNS) {
    // 放不下時依序捨棄：stale 標示 → 頭尾圖示 → detail，再不行才降級成窄版。
    const variants = [
      { detail: true, stale: true, handoff: true },
      { detail: true, stale: false, handoff: true },
      { detail: true, stale: false, handoff: false },
      { detail: false, stale: false, handoff: false },
    ]
    for (const v of variants) {
      const l = wideLine(state, now, sessionId, v)
      if (width(l) <= columns) return l
    }
  }
  return narrowLine(state, now, sessionId, columns)
}

// ── 第二行 ────────────────────────────────────────────────

function activityParts(act: Activity, th: Thresholds): string[] {
  const { now } = act
  const visible = act.calls.filter(c => c.tool !== 'Agent' && c.tool !== ASK_TOOL && now - c.startedAt >= th.showToolAfterSec * 1000)
  const longest = (owner: string): InFlight | undefined =>
    visible.filter(c => ownerOf(c) === owner).sort((a, b) => a.startedAt - b.startedAt)[0]
  const parts: string[] = []
  const main = longest(MAIN)
  if (main) parts.push(`${main.label} ${fmtDuration(now - main.startedAt)}`)
  for (const a of act.agents) {
    const c = longest(a.id)
    parts.push(c ? `${a.short}: ${c.label} ${fmtDuration(now - c.startedAt)}` : `${a.short} ${fmtDuration(now - a.startedAt)}`)
  }
  return parts
}

function secondLine(state: StageState, act: Activity, st: Status, sessionId: string, columns: number, th: Thresholds): Line | undefined {
  const badges = state.sessionId === sessionId ? state.badges ?? [] : []
  const badgeText = badges.map(b => `[${b}]`).join(' ')
  let body: Line
  if (st.kind === 'stuck') {
    body = [{ text: st.text, color: COLORS.stuck, bold: true }]
    if (badgeText) body.push({ text: `   ${badgeText}`, color: COLORS.stuck })
    return fitLine(body, columns)
  }
  const parts = activityParts(act, th)
  if (st.kind === 'waiting') {
    body = [{ text: st.text, color: COLORS.waiting, bold: true }]
    if (parts.length) body.push({ text: ` · ${parts.join(' · ')}` })
  } else if (st.kind === 'running') {
    body = [{ text: '🔄', color: COLORS.running }]
    body.push({ text: parts.length ? ` ${parts.join(' · ')}` : ' 執行中' })
  } else {
    if (!badgeText) return undefined
    body = [{ text: '·', dim: true }]
  }
  if (badgeText) {
    const room = columns - width(body)
    const badgeW = displayWidth(badgeText) + 3
    if (room >= badgeW) body.push({ text: '   ' }, { text: badgeText, color: COLORS.milestone })
  }
  return fitLine(body, columns)
}

export type LayoutOptions = { sessionId: string; columns: number; maxRows: number; th: Thresholds }

export function renderLines(state: StageState, act: Activity, o: LayoutOptions): Line[] {
  const lines: Line[] = [firstLine(state, act.now, o.sessionId, o.columns)]
  if (o.maxRows >= 2) {
    const l2 = secondLine(state, act, evaluateStatus(state, act, o.th), o.sessionId, o.columns, o.th)
    if (l2) lines.push(l2)
  }
  return lines
}

export const lineText = (line: Line): string => line.map(s => s.text).join('')
