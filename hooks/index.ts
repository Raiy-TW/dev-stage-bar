// dev-stage-bar：在 prompt 上方畫「任務類型 × 步驟」進度條與即時活動（所有專案）。
// 原則：本 plugin 只觀察，永遠 `next(e)` 放行，不擋、不改寫任何工具；
// 自己的邏輯出錯只影響顯示（全部包在 try/catch 裡）。
import type { EngineInterface, Register } from 'claude-code'
import { ALL_STAGE_IDS, TASKS, TASK_IDS, THRESHOLDS, TICK_MS, type ProjectKind } from '../src/stages.ts'
import { stageIds, stagesFor } from '../src/tasks.ts'
import { agentShortName, callLabel, classify, type ToolEvent } from '../src/rules.ts'
import { classifyPrompt } from '../src/intent.ts'
import { applyClassification, applyPromptIntent, applySetStage, emptyState, migrateState, resolveSetStage, type StageState } from '../src/state.ts'
import { renderLines, lineText, type Activity, type AgentRow, type InFlight, type Line, type Thresholds } from '../src/format.ts'

const SET_STAGE = 'SetStage'
/** 提醒段附加在這個 system prompt 段尾（實測每個 session 都有、內容穩定，不打壞 prompt cache）。 */
const REMINDER_SECTION = 'env_info_simple'
/** 只有這些來源算「使用者自己送出的 prompt」（Enter、Remote Control）；通知、peer、排程等不判斷意圖。 */
const PERSON_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge'])
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
let project: ProjectKind = 'default'
/** $.tool.register 回傳的完整工具名（mcp__<plugin>__SetStage）。 */
let setStageTool = ''
let state: StageState = emptyState()
let th: Thresholds = THRESHOLDS
let isWorking = false
/** 進行中的主迴圈 turn 已有非讀取動作（turn.complete 清掉）。 */
let turnActed = false
/** 最近一個完成的主迴圈 turn 是對話還是有動作。 */
let lastTurn: 'chat' | 'acted' | undefined
/** 進行中的 turn 是接續 turn（背景 subagent 完成後引擎自己開的，text 為空）。 */
let continuation = false
let lastEventAt: number | null = null
let lastSignature = ''
const lastEventByOwner: Record<string, number> = {}
const calls = new Map<string, InFlight>()
const agentMeta = new Map<string, { short: string; startedAt: number }>()
let agents: AgentRow[] = []

// 同步時間：以最近一次 $.clock.now() 為基準，加上真實經過時間。
// 工具呼叫的記錄因此不必 await 任何 $ 呼叫（不延遲工具），測試的 mock clock 也仍然適用。
let clockBase = 0
let realBase = 0
function noteClock(t: number): number {
  clockBase = t
  realBase = Date.now()
  return t
}
/** 真實經過時間取到秒（毫秒級抖動不該讓「19 分」顯示成「18 分」）。 */
const nowSync = (): number => clockBase + Math.floor((Date.now() - realBase) / 1000) * 1000

const storeKey = (dir: string): string => `stage:${dir}`
const ignore = (): undefined => undefined

/** 專案類型：*.xcodeproj／*.xcworkspace／.asc → ios，其餘 default（只影響少數標籤）。 */
async function detectProject($: $, dir: string): Promise<ProjectKind> {
  try {
    const entries = await $.fs.list(dir)
    const ios = entries.some(e => /\.(xcodeproj|xcworkspace)$/.test(e.name) || e.name === '.asc')
    return ios ? 'ios' : 'default'
  } catch {
    return 'default'
  }
}

function parseMinutes(raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function activity(now: number): Activity {
  return { now, isWorking, lastEventAt, lastEventByOwner: { ...lastEventByOwner }, calls: [...calls.values()], agents, turnActed, ...(lastTurn ? { lastTurn } : {}) }
}

function signature(now: number): string {
  const act = activity(now)
  return SIGNATURE_COLUMNS.map(columns => renderLines(state, act, { sessionId, columns, maxRows: 2, th, project }).map(lineText).join('\n')).join('\n--\n')
}

/** 同步更新狀態；寫 store 延到 tick（或 session 結束）才做，工具路徑上不碰 $.store。 */
let dirty = false
function persist(next: StageState): void {
  if (next === state) return
  state = next
  dirty = true
}

async function flush($: $): Promise<void> {
  if (!dirty) return
  dirty = false
  await $.store.set(storeKey(cwd), state)
}

/**
 * 內容有變才 invalidate（頻繁 invalidate 會閃爍）。同步、不等任何 $ 回應。
 * 永不拋錯：它會在工具路徑上 next(e) 之後被呼叫，排版出錯不能讓 hook reject、吃掉工具結果。
 */
function invalidateIfChanged($: $, now: number): void {
  try {
    const sig = signature(now)
    if (sig === lastSignature) return
    lastSignature = sig
    $.ui.invalidate('ui.render')
  } catch {
    // 只影響顯示。
  }
}

/** tick：更新 subagent 清單、寫 store、必要時 invalidate。只在 timer 與 session.start 跑，不在工具路徑上。 */
async function refresh($: $): Promise<void> {
  const now = noteClock(await $.clock.now())
  try {
    const list = await $.agent.list()
    agents = list
      .filter(a => a.status === 'running')
      .map(a => {
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
  try {
    await flush($)
  } catch {
    dirty = true
  }
  invalidateIfChanged($, now)
}

function markEvent(owner: string, now: number): void {
  lastEventAt = now
  lastEventByOwner[owner] = now
}

type CallEvent = ToolEvent & { tool_use_id: string }

function onCallStart(e: CallEvent): void {
  const now = nowSync()
  markEvent(e.agentId ?? MAIN, now)
  const c = classify(e)
  const updated = applyClassification(state, c, now, sessionId, project)
  // 改了任務／步驟的 turn 不算對話（例如只呼叫了 ios-diagnose 這類 skill）。
  if (c.other || updated.task !== state.task || updated.stage !== state.stage || updated.stageAt !== state.stageAt) turnActed = true
  persist(updated)
  const call: InFlight = { id: e.tool_use_id, tool: e.tool, label: callLabel(e), startedAt: now }
  if (e.agentId) call.agentId = e.agentId
  calls.set(e.tool_use_id, call)
}

function onCallEnd(e: CallEvent, result: unknown): void {
  const now = nowSync()
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
}

function onSetStage(e: Record<string, unknown>): string {
  const resolved = resolveSetStage(state, { task: e.task, stage: e.stage }, project)
  if ('error' in resolved) return resolved.error
  const now = nowSync()
  markEvent(typeof e.agentId === 'string' ? e.agentId : MAIN, now)
  const input: { task: typeof resolved.task; stage: typeof resolved.stage; detail?: string; milestone?: string } = { ...resolved }
  if (typeof e.detail === 'string' && e.detail) input.detail = e.detail
  if (typeof e.milestone === 'string' && e.milestone) input.milestone = e.milestone
  persist(applySetStage(state, input, now, sessionId))
  turnActed = true
  const label = stagesFor(resolved.task, project).find(s => s.id === resolved.stage)?.label ?? resolved.stage
  return `已設為 ${TASKS[resolved.task].label} · ${label}（${resolved.stage}）${input.detail ? ` · ${input.detail}` : ''}${input.milestone ? ` · ${input.milestone}` : ''}`
}

/** midTurn：prompt 是在 turn 進行中打的（會送進那個 turn），不抹掉那個 turn 已有的動作。 */
function onPrompt(text: string, midTurn: boolean): void {
  const intent = classifyPrompt(text)
  if (intent === 'chat') {
    // 問答：送出當下就顯示（不等 turn.complete）；這個 turn 若有動作，既有邏輯接手。
    lastTurn = 'chat'
    if (!midTurn) turnActed = false
  } else if (intent) {
    // 要求動手：上一輪的「討論中」不再適用。
    lastTurn = undefined
    persist(applyPromptIntent(state, intent, nowSync(), sessionId, project))
  }
}

/** system prompt 的提醒段：只在 SetStage 註冊成功後加，用實際註冊到的完整工具名。 */
function stageReminder(tool: string): string {
  return [
    `進度條：開始實際工作（寫程式、修 bug、做研究／規劃／文件產出）時呼叫 ${tool} 並帶 task；`,
    '之後每進入下一步再呼叫一次，任務換了就帶新的 task。純問答、釐清問題時不要呼叫。',
  ].join('')
}

/** 給模型看的使用規則：和提醒段一致，寫精簡。 */
function setStageDescription(kind: ProjectKind): string {
  return [
    '宣告目前任務與步驟，顯示在使用者 prompt 上方的進度條（只影響顯示）。',
    '開始實際工作時先呼叫一次並帶 task（feature 新功能／bugfix 修 bug／work 研究、規劃、文件等非程式工作）；之後每進入一個步驟再呼叫一次；任務換了就帶新的 task。純問答、釐清問題時不用呼叫。',
    ...TASK_IDS.map(t => `${t}: ${stageIds(t, kind).join(', ')}`),
    'detail 是簡短進度（例如 "T3/5"），milestone 是里程碑代號（例如 "M48"）。',
  ].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    try {
      cwd = await $.session.cwd()
      project = await detectProject($, cwd)
      sessionId = await $.session.id()
      noteClock(await $.clock.now())
      th = {
        ...THRESHOLDS,
        stuckToolMin: parseMinutes(await $.env.get('DEV_STAGE_BAR_STUCK_MIN'), THRESHOLDS.stuckToolMin),
        stuckIdleMin: parseMinutes(await $.env.get('DEV_STAGE_BAR_IDLE_MIN'), THRESHOLDS.stuckIdleMin),
      }
      const saved = await $.store.get(storeKey(cwd))
      state = migrateState(saved)
      const reg = await $.tool.register({
        name: SET_STAGE,
        description: setStageDescription(project),
        inputSchema: {
          type: 'object',
          properties: {
            task: { type: 'string', enum: [...TASK_IDS], description: '任務類型；新任務或換任務時必帶' },
            stage: { type: 'string', enum: [...ALL_STAGE_IDS], description: '目前步驟（須屬於該任務）' },
            detail: { type: 'string', description: '簡短進度，例如 T3/5' },
            milestone: { type: 'string', description: '里程碑代號，例如 M48' },
          },
          required: ['stage'],
        },
      })
      setStageTool = reg?.tool ?? ''
      enabled = true
      // 提醒段在 SetStage 註冊之後才能帶正確的工具名：丟掉可能已快取的段（只在 session 開始做一次）。
      if (setStageTool) $.ui.invalidate('prompt.section')
      $.clock.every(TICK_MS, () => {
        refresh($).catch(ignore)
      })
      // 第一次 tick 不等：agent 清單卡住也不拖住 session 開始。
      // 但 hook 返回後才完成的 $ 呼叫不保證生效（實測首次 invalidate 會掉），所以這裡先同步 invalidate 一次。
      invalidateIfChanged($, nowSync())
      refresh($).catch(ignore)
    } catch {
      // 偵測或初始化失敗：不畫，但絕不影響 session。
    }
    return r
  })

  on('turn.start', async ($, e, next) => {
    const r = await next(e)
    if (!enabled) return r
    // 新的主迴圈 turn 開始時，上一輪主迴圈不可能還有進行中的呼叫：清掉殘留（中斷時可能漏收結束）。
    for (const [k, c] of calls) if (!c.agentId) calls.delete(k)
    // turn.start 只在主迴圈觸發（subagent 的 run 沒有 turn.start）。
    // 沒有使用者文字的接續 turn 延續上一個 turn 的判定，不重設。
    continuation = e.text === ''
    if (!continuation) turnActed = false
    try {
      // /clear 不會重跑 session.start，但 session id 會換：換了就讓 session 範圍的鎖／badge／接手標記失效。
      const id = await $.session.id()
      if (id && id !== sessionId) sessionId = id
    } catch {
      // 只影響顯示。
    }
    invalidateIfChanged($, nowSync())
    return r
  })

  // 使用者的 prompt：純本地關鍵字判斷意圖（不呼叫模型）。原樣放行，判斷在 next 之前同步做完、不 await 任何 $。
  on('prompt.submit', ($, e, next) => {
    try {
      if (enabled && PERSON_ORIGINS.has(e.origin?.kind ?? '')) onPrompt(e.text, e.turnId !== undefined)
      invalidateIfChanged($, nowSync())
    } catch {
      // 只影響顯示。
    }
    return next(e)
  })

  on('prompt.section', { name: REMINDER_SECTION }, async ($, e, next) => {
    const r = await next(e)
    try {
      // 核心省略該段（null）時不硬塞；SetStage 沒註冊成功也不加。
      if (!enabled || !setStageTool || r.text === null) return r
      return { text: `${r.text}\n\n${stageReminder(setStageTool)}` }
    } catch {
      return r
    }
  })

  // 主迴圈 turn 結束：本 turn 沒有任何動作 → 對話 turn（只影響顯示，不改任務／步驟）。
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    try {
      if (enabled && !e.agentId) {
        // 接續 turn 沒有動作時，保留上一個 turn 的判定（例如派背景 subagent 的 turn 不會被改判成對話）。
        if (turnActed) lastTurn = 'acted'
        else if (!continuation) lastTurn = 'chat'
        turnActed = false
        continuation = false
        invalidateIfChanged($, nowSync())
      }
    } catch {
      // 只影響顯示。
    }
    return r
  })

  on('tool.call', async ($, e, next) => {
    if (!enabled) return next(e)
    if (setStageTool && e.tool === setStageTool) {
      let result = '階段顯示暫時無法更新（不影響工作）'
      try {
        result = onSetStage(e as unknown as Record<string, unknown>)
      } catch {
        // 只影響顯示。
      }
      invalidateIfChanged($, nowSync())
      return { result }
    }
    const ev = e as unknown as CallEvent
    try {
      onCallStart(ev)
    } catch {
      // 只影響顯示。
    }
    // 工具立刻啟動；工具路徑上只做同步記錄＋$.ui.invalidate，不等任何 $ 回應，不延遲工具或其結果。
    const pending = next(e)
    invalidateIfChanged($, nowSync())
    let result: unknown
    try {
      result = await pending
      return result as Awaited<typeof pending>
    } finally {
      try {
        onCallEnd(ev, result)
        invalidateIfChanged($, nowSync())
      } catch {
        // 只影響顯示。
      }
    }
  })

  on('tool.check', async ($, e, next) => {
    const r = await next(e)
    try {
      // 只觀察：權限檢查回 ask 代表要等 person 決定，這段時間不算「卡住」，顯示「⏸ 等你：授權」。
      const call = enabled && r.decision === 'ask' && e.tool_use_id ? calls.get(e.tool_use_id) : undefined
      if (call) {
        call.awaitingPermission = true
        invalidateIfChanged($, nowSync())
      }
    } catch {
      // 只影響顯示。
    }
    return r
  })

  // 授權後指令真的開始跑：引擎在該呼叫下方畫出 ToolProgress（run-in-background 提示）。
  // 沒有這個訊號的工具，等授權標記保留到呼叫結束（保守：寧可顯示「等你」也不誤報卡住）。
  on('ui.render', { component: 'ToolProgress' }, ($, e, next) => {
    try {
      const call = enabled ? calls.get(e.props.tool_use_id) : undefined
      if (call?.awaitingPermission) {
        const now = nowSync()
        call.awaitingPermission = false
        call.startedAt = now
        markEvent(call.agentId ?? MAIN, now)
        invalidateIfChanged($, now)
      }
    } catch {
      // 只影響顯示。
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    try {
      if (enabled) await flush($)
    } catch {
      // 只影響顯示。
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (!enabled || e.props.hasSurvey) return below
    try {
      if (e.props.isWorking !== isWorking) isWorking = e.props.isWorking
      const now = noteClock(await $.clock.now())
      const columns = Math.max(1, e.props.bodyColumns - SAFETY_COLUMNS)
      const lines: Line[] = renderLines(state, activity(now), { sessionId, columns, maxRows: e.props.maxRows, th, project })
      const { Box, Text } = $.ui.resolve(e)
      // 每列一個 truncate-end 的 Text：寬度估算只是盡力（ambiguous-width 字元在某些終端佔 2 欄），估錯時截斷不折行。
      const tree = Box({
        flexDirection: 'column',
        children: lines.map(line =>
          Text({
            wrap: 'truncate-end',
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
