// 持久化的任務／步驟狀態與其轉換（純函式）。每個 cwd 一份，存在 $.store。
import { ALL_STAGE_IDS, BADGES, LEGACY_STAGE_IDS, TASKS, TASK_IDS, TASK_SIGNAL_RANK, WORK_MIN_READS, type BadgeId, type ProjectKind, type StageId, type TaskId } from './stages.ts'
import type { Classification } from './rules.ts'
import { hasStage, isTaskId, stageIds, tasksWithStage } from './tasks.ts'

export type StageSource = 'none' | 'guess' | 'authority' | 'setstage'
export type TaskSource = 'declared' | 'inferred'

export type StageState = {
  task?: TaskId
  taskSource?: TaskSource
  /** 推斷出的任務所依據的訊號強度（TASK_SIGNAL_RANK）；宣告的任務沒有這欄。 */
  taskRank?: number
  stage: StageId | null
  detail?: string
  milestone?: string
  stageSince: number
  updatedAt: number
  source: StageSource
  /** 最後一次改動這份狀態的 session；和目前 session 不同即為「上次」的狀態。 */
  sessionId?: string
  /** 本 session（= sessionId）已有 SetStage 或權威轉換 → 推測不再改步驟。 */
  locked?: boolean
  /** 本 session 已用 SetStage 宣告 task → 不再推斷任務。 */
  taskDeclared?: boolean
  /** 主迴圈的讀取類／其他動作次數（推斷 work 用），只算 counts.sessionId 那個 session。 */
  counts?: { sessionId: string; reads: number; others: number }
  handoff?: 'load' | 'save'
  badges?: BadgeId[]
  submitted?: boolean
}

export type SetStageInput = { task: TaskId; stage: StageId; detail?: string; milestone?: string }

export const emptyState = (): StageState => ({ stage: null, stageSince: 0, updatedAt: 0, source: 'none' })

export const isLocked = (s: StageState, sessionId: string): boolean => s.sessionId === sessionId && s.locked === true

const taskDeclared = (s: StageState, sessionId: string): boolean => s.sessionId === sessionId && s.taskDeclared === true

/** 換 session 時，清掉只屬於上個 session 的欄位。 */
function forSession(s: StageState, sessionId: string): StageState {
  if (s.sessionId === sessionId) return s
  const { locked: _l, handoff: _h, badges: _b, taskDeclared: _t, ...rest } = s
  return { ...rest, sessionId }
}

function withStage(s: StageState, stage: StageId, now: number): StageState {
  if (s.stage === stage) return s
  const { detail: _d, submitted: _s, ...rest } = s
  return { ...rest, stage, stageSince: now }
}

/** 換任務：整條重來（步驟、計時、detail、badge 都重設）。rank 只給推斷的任務。 */
function withTask(s: StageState, task: TaskId, source: TaskSource, now: number, rank?: number): StageState {
  if (s.task === task) {
    if (source === 'declared') {
      if (s.taskSource === 'declared') return s
      const { taskRank: _r, ...rest } = s
      return { ...rest, taskSource: 'declared' }
    }
    return rank !== undefined && rank > (s.taskRank ?? 0) && s.taskSource === 'inferred' ? { ...s, taskRank: rank } : s
  }
  const { detail: _d, submitted: _s, badges: _b, locked: _l, taskRank: _r, ...rest } = s
  return { ...rest, task, taskSource: source, stage: null, stageSince: now, ...(source === 'inferred' && rank !== undefined ? { taskRank: rank } : {}) }
}

/** 目前任務的強度：本 session 宣告的不可被推斷覆蓋；上個 session 宣告的算 strong。 */
function currentRank(s: StageState, sessionId: string): number {
  if (!s.task) return 0
  if (taskDeclared(s, sessionId)) return Number.POSITIVE_INFINITY
  if (s.taskSource === 'declared') return TASK_SIGNAL_RANK.strong
  return s.taskRank ?? TASK_SIGNAL_RANK.strong
}

/** 推斷的任務切換：較強的訊號可覆蓋較弱推斷的任務；同為 strong 可跨任務切換。 */
function canSwitch(s: StageState, task: TaskId, rank: number, sessionId: string): boolean {
  if (task === s.task) return false
  const cur = currentRank(s, sessionId)
  return rank > cur || (rank === cur && rank === TASK_SIGNAL_RANK.strong)
}

/** 累加本 session 的讀取／其他計數；不算「更新」（不動 sessionId／updatedAt，避免「上次更新」被讀檔刷新）。 */
function withCounts(s: StageState, c: Classification, sessionId: string): StageState {
  if (!c.readOnly && !c.other) return s
  const cur = s.counts?.sessionId === sessionId ? s.counts : { sessionId, reads: 0, others: 0 }
  return { ...s, counts: { sessionId, reads: cur.reads + (c.readOnly ? 1 : 0), others: cur.others + (c.other ? 1 : 0) } }
}

const CHANGE_KEYS = ['task', 'taskSource', 'stage', 'source', 'locked', 'handoff', 'badges', 'submitted'] as const

export function applyClassification(prev: StageState, c: Classification, now: number, sessionId: string, project: ProjectKind): StageState {
  const counted = withCounts(prev, c, sessionId)
  const base = forSession(counted, sessionId)
  let s = base
  const reads = s.counts?.reads ?? 0
  const others = s.counts?.others ?? 0

  // 任務推斷：依訊號強度（TASK_SIGNAL_RANK）決定能否切換。
  const candidate: { task: TaskId; rank: number } | undefined = c.task
    ? { task: c.task, rank: c.taskStrength === 'weak' ? TASK_SIGNAL_RANK.weak : TASK_SIGNAL_RANK.strong }
    : c.codeWrite
      ? { task: 'feature', rank: TASK_SIGNAL_RANK.weak }
      : others === 0 && reads >= WORK_MIN_READS
        ? { task: 'work', rank: TASK_SIGNAL_RANK.reads }
        : undefined
  if (candidate && canSwitch(s, candidate.task, candidate.rank, sessionId)) s = withTask(s, candidate.task, 'inferred', now, candidate.rank)

  // 步驟：依目前任務查表，查不到就不改。
  const fits = (stage: StageId | undefined): stage is StageId => !!stage && !!s.task && hasStage(s.task, stage, project)
  if (fits(c.authority)) {
    s = { ...withStage(s, c.authority, now), source: 'authority', locked: true }
  } else if (fits(c.guess) && !isLocked(s, sessionId) && c.guess !== s.stage) {
    s = { ...withStage(s, c.guess, now), source: 'guess' }
  }
  if (c.handoff && s.handoff !== c.handoff) s = { ...s, handoff: c.handoff }
  if (c.badge && !(s.badges ?? []).includes(c.badge)) s = { ...s, badges: [...(s.badges ?? []), c.badge] }
  if (c.submitted && s.stage === 'submit' && !s.submitted) s = { ...s, submitted: true }

  const changed = CHANGE_KEYS.some(k => s[k] !== base[k])
  return changed ? { ...s, updatedAt: now } : counted
}

/** 驗證 SetStage 的輸入：決定任務、確認 stage 屬於該任務；不合法時回錯誤字串（不改狀態）。 */
export function resolveSetStage(prev: StageState, input: { task?: unknown; stage?: unknown }, project: ProjectKind): { task: TaskId; stage: StageId } | { error: string } {
  const { stage } = input
  if (input.task !== undefined && !isTaskId(input.task)) {
    return { error: `未知的 task「${String(input.task)}」；可用：${TASK_IDS.join(', ')}` }
  }
  if (typeof stage !== 'string' || !(ALL_STAGE_IDS as readonly string[]).includes(stage)) {
    return { error: `未知的階段「${String(stage)}」；${TASK_IDS.map(t => `${t}: ${stageIds(t, project).join(', ')}`).join('；')}` }
  }
  let task: TaskId | undefined = isTaskId(input.task) ? input.task : prev.task
  if (!task) {
    const owners = tasksWithStage(stage, project)
    if (owners.length !== 1) return { error: `「${stage}」屬於多個任務（或本專案沒有），請帶 task（${TASK_IDS.join(' / ')}）` }
    task = owners[0]!
  }
  if (!hasStage(task, stage, project)) {
    return { error: `「${stage}」不是 ${task}（${TASKS[task].label}）的步驟；可用：${stageIds(task, project).join(', ')}` }
  }
  return { task, stage: stage as StageId }
}

export function applySetStage(prev: StageState, input: SetStageInput, now: number, sessionId: string): StageState {
  const s = withStage(withTask(forSession(prev, sessionId), input.task, 'declared', now), input.stage, now)
  const next: StageState = { ...s, source: 'setstage', locked: true, taskDeclared: true, updatedAt: now }
  if (input.detail) next.detail = input.detail
  else delete next.detail
  if (input.milestone) next.milestone = input.milestone
  return next
}

const STAGE_SOURCES: readonly StageSource[] = ['none', 'guess', 'authority', 'setstage']
const TASK_SOURCES: readonly TaskSource[] = ['declared', 'inferred']
const HANDOFFS = ['load', 'save'] as const

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)
const oneOf = <T extends string>(v: unknown, xs: readonly T[]): T | undefined => (xs as readonly unknown[]).includes(v) ? (v as T) : undefined

/**
 * 讀 store：逐欄驗證型別，不合法的欄位清成預設（store 可能被舊版或手動改壞）。
 * 0.1 版的 tf／device 映射成 ship／accept；沒有 task 的舊資料視為 feature。
 */
export function migrateState(v: unknown): StageState {
  if (typeof v !== 'object' || v === null || !('stage' in v) || !('stageSince' in v)) return emptyState()
  const raw = v as Record<string, unknown>
  const rawStage = typeof raw.stage === 'string' ? (LEGACY_STAGE_IDS[raw.stage] ?? raw.stage) : null
  const stage = rawStage !== null && (ALL_STAGE_IDS as readonly string[]).includes(rawStage) ? (rawStage as StageId) : null
  const source = oneOf(raw.source, STAGE_SOURCES) ?? 'none'
  const s: StageState = { stage, stageSince: num(raw.stageSince) ?? 0, updatedAt: num(raw.updatedAt) ?? 0, source }

  if (isTaskId(raw.task)) {
    s.task = raw.task
    const ts = oneOf(raw.taskSource, TASK_SOURCES)
    if (ts) s.taskSource = ts
    const rank = num(raw.taskRank)
    if (rank !== undefined && ts === 'inferred') s.taskRank = rank
  } else if (stage) {
    s.task = 'feature'
    s.taskSource = source === 'setstage' ? 'declared' : 'inferred'
  }
  const detail = str(raw.detail)
  if (detail) s.detail = detail
  const milestone = str(raw.milestone)
  if (milestone) s.milestone = milestone
  const sessionId = str(raw.sessionId)
  if (sessionId) s.sessionId = sessionId
  const locked = bool(raw.locked)
  if (locked !== undefined) s.locked = locked
  const declared = bool(raw.taskDeclared)
  if (declared !== undefined) s.taskDeclared = declared
  const submitted = bool(raw.submitted)
  if (submitted !== undefined) s.submitted = submitted
  const handoff = oneOf(raw.handoff, HANDOFFS)
  if (handoff) s.handoff = handoff
  if (Array.isArray(raw.badges)) {
    const badges = raw.badges.filter((b): b is BadgeId => (BADGES as readonly unknown[]).includes(b))
    if (badges.length) s.badges = badges
  }
  const c = raw.counts as Record<string, unknown> | null | undefined
  if (typeof c === 'object' && c !== null && str(c.sessionId) && num(c.reads) !== undefined && num(c.others) !== undefined) {
    s.counts = { sessionId: c.sessionId as string, reads: c.reads as number, others: c.others as number }
  }
  return s
}
