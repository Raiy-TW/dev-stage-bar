// 狀態判定與兩行排版（純函式，無 $）：輸出 segment 陣列，由 hooks/index.ts 轉成 Box/Text。
import { COLORS, GLYPHS, NARROW_COLUMNS, SAFETY_MARGIN, TASKS, WAITING_STAGES, type ProjectKind, type THRESHOLDS } from './stages.ts'
import { stagesFor, type StageDef } from './tasks.ts'
import type { StageState } from './state.ts'
import { displayWidth, truncateToWidth } from './width.ts'

export type Thresholds = { readonly [K in keyof typeof THRESHOLDS]: number }

export type InFlight = {
  id: string
  tool: string
  label: string
  agentId?: string
  startedAt: number
  /** 權限檢查回了 ask，正等 person 在對話框決定：算「等你」，不算卡住。 */
  awaitingPermission?: boolean
}
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
const PENDING_TEXT = '判斷任務中…'
const INFERRED_MARK = '推測'
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
  const permission = act.calls.find(c => c.awaitingPermission)

  // ⚠ 工具呼叫進行太久，且該 loop 之後沒有任何新事件。
  const stuckCalls = act.calls
    .filter(c => c.tool !== ASK_TOOL && c.tool !== 'Agent' && !c.awaitingPermission)
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
  // 有工具正在跑時由上面的 stuckToolMin 規則負責，不走這條（否則長 xcodebuild 會提早誤報）。
  const toolRunning = act.calls.some(c => c.tool !== ASK_TOOL && c.tool !== 'Agent')
  if (!asking && !permission && !toolRunning && act.isWorking && act.lastEventAt !== null && now - act.lastEventAt > th.stuckIdleMin * MIN) {
    return { kind: 'stuck', text: `⚠ ${minutes(now - act.lastEventAt)} 分鐘沒有任何工具活動（模型可能卡住）` }
  }
  if (asking) return { kind: 'waiting', text: '⏸ 等你：回答問題' }
  if (permission) return { kind: 'waiting', text: `⏸ 等你：授權 ${permission.label}` }
  if (state.stage && WAITING_STAGES.includes(state.stage)) return { kind: 'waiting', text: '⏸ 等你：驗收' }
  if (state.stage === 'submit' && state.submitted) return { kind: 'waiting', text: '⏸ 排審中' }
  if (act.calls.length > 0 || act.agents.length > 0 || (act.lastEventAt !== null && now - act.lastEventAt <= th.activeMin * MIN)) {
    return { kind: 'running', text: '🔄' }
  }
  return { kind: 'idle', text: '' }
}

// ── 第 1、2 行：任務名＋點線進度條、目前點下方的文字 ─────────────

/** 目前任務在此專案類型下的步驟表（沒有任務時為空）。 */
function stagesOf(state: StageState, project: ProjectKind): StageDef[] {
  return state.task ? stagesFor(state.task, project) : []
}

function stageIndex(state: StageState, stages: readonly StageDef[]): number {
  return state.stage ? stages.findIndex(s => s.id === state.stage) : -1
}

function staleText(state: StageState, sessionId: string, now: number): string | undefined {
  if (!state.sessionId || state.sessionId === sessionId || !state.updatedAt) return undefined
  return `上次更新 ${fmtAgo(now - state.updatedAt)}`
}

const width = (line: Line): number => line.reduce((w, s) => w + displayWidth(s.text), 0)

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

/** 最左的任務名：宣告的用主色；推斷的 dim 並附「推測」。後面帶一格空白。 */
function taskPrefix(state: StageState): Line {
  if (!state.task) return []
  const label = TASKS[state.task].label
  if (state.taskSource === 'inferred') return [{ text: label, dim: true }, { text: ` ${INFERRED_MARK} `, dim: true }]
  return [{ text: label, color: COLORS.current }, { text: ' ' }]
}

/** 「驗證 · T3/5 · 12m」與（上個 session 的狀態時）「· 上次更新 3 小時前」；沒有步驟時為空。 */
function stageLabel(state: StageState, stages: readonly StageDef[], now: number, sessionId: string): Line {
  const idx = stageIndex(state, stages)
  if (idx < 0) return []
  const parts = [state.detail, fmtDuration(now - state.stageSince)].filter((p): p is string => !!p)
  const line: Line = [{ text: stages[idx]!.label, color: COLORS.current, bold: true }, { text: ` · ${parts.join(' · ')}` }]
  const stale = staleText(state, sessionId, now)
  if (stale) line.push({ text: ` · ${stale}`, dim: true })
  return line
}

const MILESTONE_GAP = '   '

/** 點之間的連接線長度；左側扣掉任務名，右側保留 milestone。 */
function dotGap(state: StageState, count: number, prefixWidth: number, columns: number): number {
  const reserve = state.milestone ? displayWidth(MILESTONE_GAP + state.milestone) : 0
  return Math.floor((columns - SAFETY_MARGIN - prefixWidth - reserve - count) / Math.max(1, count - 1))
}

function dotSeg(i: number, idx: number): Seg {
  if (i < idx) return { text: GLYPHS.done, color: COLORS.done }
  if (i === idx) return { text: GLYPHS.current, color: COLORS.current, bold: true }
  return { text: GLYPHS.todo, dim: true }
}

/** 第 1 行：修bug ●━━●━━◉┄┄○┄┄○   M48，點平均分布；回傳每個點的欄位供第 2 行對齊。 */
function dotsLine(state: StageState, stages: readonly StageDef[], prefix: Line, gap: number): { line: Line; xs: number[] } {
  const idx = stageIndex(state, stages)
  const line: Line = [...prefix]
  const xs: number[] = []
  stages.forEach((_, i) => {
    if (i > 0) {
      const passed = i <= idx
      line.push({ text: (passed ? GLYPHS.doneLine : GLYPHS.todoLine).repeat(gap), ...(passed ? { color: COLORS.done } : { dim: true }) })
    }
    xs.push(width(line))
    line.push(dotSeg(i, idx))
  })
  if (state.milestone) line.push({ text: MILESTONE_GAP }, { text: state.milestone, color: COLORS.milestone, bold: true })
  return { line, xs }
}

/** 第 2 行：文字中心對準目前點，靠近左右邊界時夾在 [0, columns) 內。 */
function alignUnder(label: Line, x: number, columns: number): Line {
  const fitted = fitLine(label, columns)
  const w = width(fitted)
  const start = Math.max(0, Math.min(x - Math.floor(w / 2), columns - w))
  return start > 0 ? [{ text: ' '.repeat(start) }, ...fitted] : fitted
}

/** 尚未判定任務：一行 dim 的「判斷任務中…」。 */
const pendingLine = (columns: number): Line => fitLine([{ text: PENDING_TEXT, dim: true }], columns)

/** 窄版單行：修bug ●◉○○○○○ 診斷 · 12m */
function compactLine(state: StageState, project: ProjectKind, now: number, sessionId: string, columns: number): Line {
  if (!state.task) return pendingLine(columns)
  const stages = stagesOf(state, project)
  const idx = stageIndex(state, stages)
  const line: Line = [...taskPrefix(state), ...stages.map((_, i) => dotSeg(i, idx))]
  const label = stageLabel(state, stages, now, sessionId)
  if (label.length) line.push({ text: ' ' }, ...label)
  return fitLine(line, columns)
}

/** 第 1、2 行（第 2 行可能為空）；窄到點距不足時為單行。 */
function progressLines(state: StageState, project: ProjectKind, now: number, sessionId: string, columns: number): { bar: Line; label?: Line } {
  if (!state.task) return { bar: pendingLine(columns) }
  const stages = stagesOf(state, project)
  const prefix = taskPrefix(state)
  const gap = dotGap(state, stages.length, width(prefix), columns)
  if (columns < NARROW_COLUMNS || gap < 1) return { bar: compactLine(state, project, now, sessionId, columns) }
  const { line, xs } = dotsLine(state, stages, prefix, gap)
  const label = stageLabel(state, stages, now, sessionId)
  const idx = stageIndex(state, stages)
  return { bar: fitLine(line, columns), ...(label.length ? { label: alignUnder(label, xs[idx]!, columns) } : {}) }
}

// ── 第 3 行：活動／狀態列 ─────────────────────────────────

function activityParts(act: Activity, th: Thresholds): string[] {
  const { now } = act
  const visible = act.calls.filter(c => c.tool !== 'Agent' && c.tool !== ASK_TOOL && !c.awaitingPermission && now - c.startedAt >= th.showToolAfterSec * 1000)
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

function activityLine(state: StageState, act: Activity, st: Status, sessionId: string, columns: number, th: Thresholds): Line | undefined {
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

export type LayoutOptions = { sessionId: string; columns: number; maxRows: number; th: Thresholds; project: ProjectKind }

export function renderLines(state: StageState, act: Activity, o: LayoutOptions): Line[] {
  // 只有一列可用：窄版單行（點＋階段文字）。
  if (o.maxRows < 2) return [compactLine(state, o.project, act.now, o.sessionId, o.columns)]
  const { bar, label } = progressLines(state, o.project, act.now, o.sessionId, o.columns)
  const activity = activityLine(state, act, evaluateStatus(state, act, o.th), o.sessionId, o.columns, o.th)
  const lines: Line[] = [bar]
  if (o.maxRows >= 3 || !label || !activity) {
    if (label) lines.push(label)
    if (activity) lines.push(activity)
    return lines.slice(0, Math.max(1, o.maxRows))
  }
  // 只有兩列：把階段文字併進活動列開頭。
  const merged = [...stageLabel(state, stagesOf(state, o.project), act.now, o.sessionId), { text: ' · ' }, ...activity]
  lines.push(fitLine(merged, o.columns))
  return lines
}

export const lineText = (line: Line): string => line.map(s => s.text).join('')
