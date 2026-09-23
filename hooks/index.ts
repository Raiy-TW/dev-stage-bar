// ios-stage-bar：在 iOS 專案的 prompt 上方畫階段進度條與即時活動。
// 原則：本 plugin 只觀察，永遠 `next(e)` 放行，不擋、不改寫任何工具；
// 自己的邏輯出錯只影響顯示（全部包在 try/catch 裡）。
import type { EngineInterface, Register } from 'claude-code'
import { STAGES, STAGE_IDS, THRESHOLDS, TICK_MS, type StageId } from '../src/stages.ts'
import { agentShortName, callLabel, classify, type ToolEvent } from '../src/rules.ts'
import { applyClassification, applySetStage, emptyState, type StageState } from '../src/state.ts'
import { renderLines, lineText, type Activity, type AgentRow, type InFlight, type Line, type Thresholds } from '../src/format.ts'

const PLUGIN = 'ios-stage-bar'
const SET_STAGE = 'SetStage'
const SET_STAGE_TOOL = `mcp__${PLUGIN}__${SET_STAGE}`
const MAIN = 'main'
/** 給排版留 1 欄餘裕，避免 ambiguous-width 字元在某些字型下多佔一欄造成折行。 */
const SAFETY_COLUMNS = 1
/** tick 用來比對內容是否改變的兩種寬度（寬版／窄版）。 */
const SIGNATURE_COLUMNS = [200, 80] as const

type $ = EngineInterface

// ── 模組狀態（hot reload 會清空；持久的部分在 $.store） ──
let enabled = false
let cwd = ''
let sessionId = ''
let state: StageState = emptyState()
let th: Thresholds = THRESHOLDS
let isWorking = false
let lastEventAt: number | null = null
let lastSignature = ''
const lastEventByOwner: Record<string, number> = {}
const calls = new Map<string, InFlight>()
const agentMeta = new Map<string, { short: string; startedAt: number }>()
let agents: AgentRow[] = []

const storeKey = (dir: string): string => `stage:${dir}`

async function detectIos($: $, dir: string): Promise<boolean> {
  const entries = await $.fs.list(dir)
  const names = new Set(entries.map(e => e.name))
  const hasProject = entries.some(e => /\.(xcodeproj|xcworkspace)$/.test(e.name))
  const hasAsc = names.has('.asc')
  // 以 .xcodeproj／.xcworkspace 或 .asc/ 為主；Package.swift 需搭配 .asc/ 才算（已被 hasAsc 涵蓋）。
  return hasProject || hasAsc
}

function parseMinutes(raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function isStageState(v: unknown): v is StageState {
  return typeof v === 'object' && v !== null && 'stage' in v && 'stageSince' in v
}

function activity(now: number): Activity {
  return { now, isWorking, lastEventAt, lastEventByOwner: { ...lastEventByOwner }, calls: [...calls.values()], agents }
}

function signature(now: number): string {
  const act = activity(now)
  return SIGNATURE_COLUMNS.map(columns => renderLines(state, act, { sessionId, columns, maxRows: 2, th }).map(lineText).join('\n')).join('\n--\n')
}

async function persist($: $, next: StageState): Promise<void> {
  if (next === state) return
  state = next
  await $.store.set(storeKey(cwd), state)
}

/** 更新 subagent 清單，內容有變才 invalidate（頻繁 invalidate 會閃爍）。 */
async function refresh($: $): Promise<void> {
  const now = await $.clock.now()
  try {
    const list = await $.agent.list()
    const running = list.filter(a => a.status === 'running')
    agents = running.map(a => {
      let meta = agentMeta.get(a.id)
      if (!meta) {
        meta = { short: agentShortName(a.description, a.type), startedAt: now }
        agentMeta.set(a.id, meta)
      }
      return { id: a.id, short: meta.short, startedAt: meta.startedAt }
    })
    // 自我修復：已結束的 subagent 還掛著的呼叫一併清掉。
    const finished = new Set(list.filter(a => a.status !== 'running').map(a => a.id))
    for (const [k, c] of calls) if (c.agentId && finished.has(c.agentId)) calls.delete(k)
  } catch {
    // agent 清單拿不到時沿用上一次的結果。
  }
  const sig = signature(now)
  if (sig !== lastSignature) {
    lastSignature = sig
    $.ui.invalidate('ui.render')
  }
}

function markEvent(owner: string, now: number): void {
  lastEventAt = now
  lastEventByOwner[owner] = now
}

async function onCallStart($: $, e: ToolEvent & { tool_use_id: string }): Promise<void> {
  const now = await $.clock.now()
  markEvent(e.agentId ?? MAIN, now)
  await persist($, applyClassification(state, classify(e), now, sessionId))
  const call: InFlight = { id: e.tool_use_id, tool: e.tool, label: callLabel(e), startedAt: now }
  if (e.agentId) call.agentId = e.agentId
  calls.set(e.tool_use_id, call)
  await refresh($)
}

async function onCallEnd($: $, e: ToolEvent & { tool_use_id: string }, result: unknown): Promise<void> {
  const now = await $.clock.now()
  const started = calls.get(e.tool_use_id)?.startedAt ?? now
  calls.delete(e.tool_use_id)
  markEvent(e.agentId ?? MAIN, now)
  if (e.tool === 'Agent') {
    // 背景 subagent 的 Agent 呼叫會立即回傳 agentId；前景的在結束時才拿到。
    const agentId = (result as { result?: { agentId?: unknown } } | undefined)?.result?.agentId
    if (typeof agentId === 'string' && !agentMeta.has(agentId)) {
      agentMeta.set(agentId, { short: agentShortName(e.description ?? '', e.subagent_type), startedAt: started })
    }
  }
  await refresh($)
}

async function onSetStage($: $, e: Record<string, unknown>): Promise<string> {
  const stage = e.stage
  if (typeof stage !== 'string' || !STAGE_IDS.includes(stage as StageId)) {
    return `未知的階段「${String(stage)}」；可用：${STAGE_IDS.join(', ')}`
  }
  const now = await $.clock.now()
  markEvent(typeof e.agentId === 'string' ? e.agentId : MAIN, now)
  const input: { stage: StageId; detail?: string; milestone?: string } = { stage: stage as StageId }
  if (typeof e.detail === 'string' && e.detail) input.detail = e.detail
  if (typeof e.milestone === 'string' && e.milestone) input.milestone = e.milestone
  await persist($, applySetStage(state, input, now, sessionId))
  await refresh($)
  const label = STAGES.find(s => s.id === stage)?.label ?? stage
  return `階段已設為 ${label}（${stage}）${input.detail ? ` · ${input.detail}` : ''}${input.milestone ? ` · ${input.milestone}` : ''}`
}

const SET_STAGE_DESCRIPTION = [
  '宣告目前 iOS 開發流程所在的階段，顯示在使用者 prompt 上方的進度條。',
  '在進入新階段、或同階段進度有變（例如完成第 3 棒）時呼叫；只影響顯示，不改任何檔案。',
  `stage 可用：${STAGES.map(s => `${s.id}=${s.label}`).join('、')}。`,
  'detail 是簡短進度（例如 "T3/5"），milestone 是里程碑代號（例如 "M48"）。',
].join('\n')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    try {
      cwd = await $.session.cwd()
      enabled = await detectIos($, cwd)
      if (!enabled) return r
      sessionId = await $.session.id()
      th = {
        ...THRESHOLDS,
        stuckToolMin: parseMinutes(await $.env.get('IOS_STAGE_BAR_STUCK_MIN'), THRESHOLDS.stuckToolMin),
        stuckIdleMin: parseMinutes(await $.env.get('IOS_STAGE_BAR_IDLE_MIN'), THRESHOLDS.stuckIdleMin),
      }
      const saved = await $.store.get(storeKey(cwd))
      state = isStageState(saved) ? saved : emptyState()
      await $.tool.register({
        name: SET_STAGE,
        description: SET_STAGE_DESCRIPTION,
        inputSchema: {
          type: 'object',
          properties: {
            stage: { type: 'string', enum: [...STAGE_IDS] },
            detail: { type: 'string', description: '簡短進度，例如 T3/5' },
            milestone: { type: 'string', description: '里程碑代號，例如 M48' },
          },
          required: ['stage'],
        },
      })
      $.clock.every(TICK_MS, () => {
        refresh($).catch(() => undefined)
      })
      await refresh($)
    } catch {
      // 偵測或初始化失敗：不畫，但絕不影響 session。
    }
    return r
  })

  on('turn.start', async ($, e, next) => {
    const r = await next(e)
    // 新的主迴圈 turn 開始時，上一輪主迴圈不可能還有進行中的呼叫：清掉殘留（中斷時可能漏收結束）。
    for (const [k, c] of calls) if (!c.agentId) calls.delete(k)
    return r
  })

  on('tool.call', async ($, e, next) => {
    if (!enabled) return next(e)
    if (e.tool === SET_STAGE_TOOL) {
      try {
        return { result: await onSetStage($, e as unknown as Record<string, unknown>) }
      } catch {
        return { result: '階段顯示暫時無法更新（不影響工作）' }
      }
    }
    const ev = e as unknown as ToolEvent & { tool_use_id: string }
    try {
      await onCallStart($, ev)
    } catch {
      // 只影響顯示。
    }
    let result: unknown
    try {
      result = await next(e)
      return result as Awaited<ReturnType<typeof next>>
    } finally {
      try {
        await onCallEnd($, ev, result)
      } catch {
        // 只影響顯示。
      }
    }
  })

  on('tool.check', async ($, e, next) => {
    const r = await next(e)
    try {
      // 只觀察：權限檢查回 ask 代表要等 person 決定，這段時間不該算「卡住」。
      const call = enabled && r.decision === 'ask' && e.tool_use_id ? calls.get(e.tool_use_id) : undefined
      if (call) {
        call.awaitingPermission = true
        await refresh($)
      }
    } catch {
      // 只影響顯示。
    }
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (!enabled || e.props.hasSurvey) return below
    try {
      if (e.props.isWorking !== isWorking) isWorking = e.props.isWorking
      const now = await $.clock.now()
      // band 又畫出來了 = 授權對話框已關：等授權的呼叫從現在起才開始算執行時間。
      for (const c of calls.values()) {
        if (!c.awaitingPermission) continue
        c.awaitingPermission = false
        c.startedAt = now
        markEvent(c.agentId ?? MAIN, now)
      }
      const columns = Math.max(1, e.props.bodyColumns - SAFETY_COLUMNS)
      const lines: Line[] = renderLines(state, activity(now), { sessionId, columns, maxRows: e.props.maxRows, th })
      const { Box, Text } = $.ui.resolve(e)
      const tree = Box({
        flexDirection: 'column',
        children: lines.map(line =>
          Box({
            flexDirection: 'row',
            children: line.map(seg =>
              Text({
                ...(seg.color ? { color: seg.color } : {}),
                ...(seg.bold ? { bold: true } : {}),
                ...(seg.dim ? { dimColor: true } : {}),
                ...(seg.inverse ? { inverse: true } : {}),
                children: seg.text,
              }),
            ),
          }),
        ),
      })
      // 別的 plugin 也畫了這個 band 就疊在我們下面，不吃掉它。
      if (below.type === 'engine') return tree
      return Box({ flexDirection: 'column', children: [tree, below] })
    } catch {
      return below
    }
  })
}
