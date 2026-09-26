// 持久化的任務／步驟狀態與其轉換（純函式）。每個 cwd 一份，存在 $.store。
import { ALL_STAGE_IDS, BADGES, LEGACY_STAGE_IDS, TASKS, TASK_IDS, TASK_SIGNAL_RANK, THRESHOLDS, type BadgeId, type ProjectKind, type StageId, type TaskId } from './stages.ts'
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
  /** 最後一次改動這份狀態的 session（badge／handoff 等 session 範圍欄位以此為準）。 */
  sessionId?: string
  /** 最後一次「真的設定任務／步驟」的 session 與時間；新鮮度只看這兩欄，badge、handoff 不寫。 */
  stageSessionId?: string
  stageAt?: number
  /** 本 session（= sessionId）已有 SetStage 或權威轉換 → 推測不再改步驟。 */
  locked?: boolean
  /** 本 session 已用 SetStage 宣告 task → 不再推斷任務。 */
  taskDeclared?: boolean
  handoff?: 'load' | 'save'
  badges?: BadgeId[]
  submitted?: boolean
}

export type SetStageInput = { task: TaskId; stage: StageId; detail?: string; milestone?: string }

export const emptyState = (): StageState => ({ stage: null, stageSince: 0, updatedAt: 0, source: 'none' })

export const isLocked = (s: StageState, sessionId: string): boolean => s.sessionId === sessionId && s.locked === true

const taskDeclared = (s: StageState, sessionId: string): boolean => s.sessionId === sessionId && s.taskDeclared === true

const MIN = 60_000

/** 任務／步驟是「現在」的：本 session 設定、且 staleMin 分鐘內刷新過。否則只顯示為「上次」。 */
export function isFresh(s: StageState, sessionId: string, now: number, staleMin: number = THRESHOLDS.staleAfterMin): boolean {
  return !!s.task && s.stageSessionId === sessionId && s.stageAt !== undefined && now - s.stageAt < staleMin * MIN
}

/** 記下「本 session 此刻設定了任務／步驟」。 */
const touch = (s: StageState, sessionId: string, now: number): StageState => ({ ...s, stageSessionId: sessionId, stageAt: now })

/** 延續不 fresh 的舊步驟：計時重來，舊的 detail／已送審不帶過來。 */
function revive(s: StageState, now: number): StageState {
  const { detail: _d, submitted: _s, ...rest } = s
  return { ...rest, stageSince: now }
}

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

/** 換任務：整條重來（步驟、計時、detail、badge 都重設）。rank 只給推斷的任務；restart 時同任務也重來。 */
function withTask(s: StageState, task: TaskId, source: TaskSource, now: number, rank?: number, restart = false): StageState {
  if (s.task === task && !restart) {
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

/** 目前任務的強度：不 fresh 的為 0；本 session 宣告的不可被推斷覆蓋；宣告過（被延續）的算 strong。 */
function currentRank(s: StageState, sessionId: string, now: number): number {
  if (!s.task || !isFresh(s, sessionId, now)) return 0
  if (taskDeclared(s, sessionId)) return Number.POSITIVE_INFINITY
  if (s.taskSource === 'declared') return TASK_SIGNAL_RANK.strong
  return s.taskRank ?? TASK_SIGNAL_RANK.strong
}

/** 推斷的任務切換：較強的訊號可覆蓋較弱推斷的任務；同為 strong 可跨任務切換。 */
function canSwitch(s: StageState, task: TaskId, rank: number, sessionId: string, now: number): boolean {
  if (task === s.task) return false
  const cur = currentRank(s, sessionId, now)
  return rank > cur || (rank === cur && rank === TASK_SIGNAL_RANK.strong)
}

const CHANGE_KEYS = ['task', 'taskSource', 'stage', 'source', 'locked', 'handoff', 'badges', 'submitted', 'stageSessionId', 'stageAt'] as const

export function applyClassification(prev: StageState, c: Classification, now: number, sessionId: string, project: ProjectKind): StageState {
  const base = forSession(prev, sessionId)
  let s = base

  // 任務推斷：依訊號強度（TASK_SIGNAL_RANK）決定能否切換；不 fresh 的任務任何訊號都能取代（同任務也重來）。
  const candidate: { task: TaskId; rank: number } | undefined = c.task
    ? { task: c.task, rank: c.taskStrength === 'weak' ? TASK_SIGNAL_RANK.weak : TASK_SIGNAL_RANK.strong }
    : c.codeWrite
      ? { task: 'feature', rank: TASK_SIGNAL_RANK.weak }
      : undefined
  if (candidate) {
    const stale = !isFresh(s, sessionId, now)
    if (stale || canSwitch(s, candidate.task, candidate.rank, sessionId, now)) {
      s = touch(withTask(s, candidate.task, 'inferred', now, candidate.rank, stale), sessionId, now)
    }
  }

  // 步驟：依目前任務查表，查不到就不改。不 fresh 的舊任務遇到符合的步驟訊號 → 延續並變 fresh。
  const fresh = isFresh(s, sessionId, now)
  const fits = (stage: StageId | undefined): stage is StageId => !!stage && !!s.task && hasStage(s.task, stage, project)
  // 寫程式檔推斷出 feature 但還沒有步驟 → 實作中（避免「有任務卻沒有目前點」）。
  const guess = c.guess ?? (c.codeWrite && s.task === 'feature' && s.stage === null ? 'impl' : undefined)
  if (fits(c.authority)) {
    const base = fresh ? s : revive(s, now)
    s = touch({ ...withStage(base, c.authority, now), source: 'authority', locked: true }, sessionId, now)
  } else if (fits(guess)) {
    // 本 session 已鎖（SetStage／權威）時推測不改步驟，但表示仍在工作，照樣刷新 stageAt。
    const base = fresh ? s : revive(s, now)
    const move = guess !== base.stage && (!fresh || !isLocked(base, sessionId))
    s = touch(move ? { ...withStage(base, guess, now), source: 'guess' } : base, sessionId, now)
  }
  if (c.handoff && s.handoff !== c.handoff) s = { ...s, handoff: c.handoff }
  if (c.badge && !(s.badges ?? []).includes(c.badge)) s = { ...s, badges: [...(s.badges ?? []), c.badge] }
  if (c.submitted && s.stage === 'submit' && !s.submitted) s = { ...s, submitted: true }

  const changed = CHANGE_KEYS.some(k => s[k] !== base[k])
  return changed ? { ...s, updatedAt: now } : prev
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
  const cur = forSession(prev, sessionId)
  const base = isFresh(cur, sessionId, now) ? cur : revive(cur, now)
  const s = withStage(withTask(base, input.task, 'declared', now), input.stage, now)
  const next: StageState = { ...touch(s, sessionId, now), source: 'setstage', locked: true, taskDeclared: true, updatedAt: now }
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
  // 0.2 以前沒有這兩欄：沒有 stageSessionId 即不 fresh（只顯示為「上次」）；
  // stageAt 退回 updatedAt 並固定下來，之後的 badge／handoff 更新 updatedAt 也不會讓「多久前」歸零。
  const stageSessionId = str(raw.stageSessionId)
  const stageAt = num(raw.stageAt)
  if (stageSessionId && stageAt !== undefined) {
    s.stageSessionId = stageSessionId
    s.stageAt = stageAt
  } else if (s.task && s.updatedAt) {
    s.stageAt = s.updatedAt
  }
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
  return s
}
