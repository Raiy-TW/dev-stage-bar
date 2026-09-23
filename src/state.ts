// 持久化的階段狀態與其轉換（純函式）。每個 cwd 一份，存在 $.store。
import type { BadgeId, StageId } from './stages.ts'
import type { Classification } from './rules.ts'

export type StageSource = 'none' | 'guess' | 'authority' | 'setstage'

export type StageState = {
  stage: StageId | null
  detail?: string
  milestone?: string
  stageSince: number
  updatedAt: number
  source: StageSource
  /** 最後一次改動這份狀態的 session；和目前 session 不同即為「上次」的狀態。 */
  sessionId?: string
  /** 本 session（= sessionId）已有 SetStage 或權威轉換 → 推測不再改階段。 */
  locked?: boolean
  handoff?: 'load' | 'save'
  badges?: BadgeId[]
  submitted?: boolean
}

export type SetStageInput = { stage: StageId; detail?: string; milestone?: string }

export const emptyState = (): StageState => ({ stage: null, stageSince: 0, updatedAt: 0, source: 'none' })

export const isLocked = (s: StageState, sessionId: string): boolean => s.sessionId === sessionId && s.locked === true

/** 換 session 時，清掉只屬於上個 session 的欄位。 */
function forSession(s: StageState, sessionId: string): StageState {
  if (s.sessionId === sessionId) return s
  const { locked: _l, handoff: _h, badges: _b, ...rest } = s
  return { ...rest, sessionId }
}

function withStage(s: StageState, stage: StageId, now: number): StageState {
  if (s.stage === stage) return s
  const { detail: _d, submitted: _s, ...rest } = s
  return { ...rest, stage, stageSince: now }
}

export function applyClassification(prev: StageState, c: Classification, now: number, sessionId: string): StageState {
  const meaningful = c.authority || c.handoff || c.badge || c.submitted || (c.guess && !isLocked(prev, sessionId) && c.guess !== prev.stage)
  if (!meaningful) return prev
  let s = forSession(prev, sessionId)
  if (c.authority) {
    s = { ...withStage(s, c.authority, now), source: 'authority', locked: true }
  } else if (c.guess && !isLocked(s, sessionId) && c.guess !== s.stage) {
    s = { ...withStage(s, c.guess, now), source: 'guess' }
  }
  if (c.handoff) s = { ...s, handoff: c.handoff }
  if (c.badge && !(s.badges ?? []).includes(c.badge)) s = { ...s, badges: [...(s.badges ?? []), c.badge] }
  if (c.submitted && s.stage === 'submit') s = { ...s, submitted: true }
  if (s === prev) return prev
  return { ...s, updatedAt: now }
}

export function applySetStage(prev: StageState, input: SetStageInput, now: number, sessionId: string): StageState {
  const s = withStage(forSession(prev, sessionId), input.stage, now)
  const next: StageState = { ...s, source: 'setstage', locked: true, updatedAt: now }
  if (input.detail) next.detail = input.detail
  else delete next.detail
  if (input.milestone) next.milestone = input.milestone
  return next
}
