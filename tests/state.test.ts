import { test, expect, describe } from 'claude-code/testing'
import { emptyState, applyClassification, applySetStage, isFresh, isLocked, resolveSetStage, migrateState, type StageState } from '../src/state.ts'
import { TASK_SIGNAL_RANK, THRESHOLDS } from '../src/stages.ts'

const S1 = 'session-1'
const S2 = 'session-2'
const feature = (stage: string, now = 0, sid = 'boot', extra: Record<string, string> = {}): StageState =>
  applySetStage(emptyState(), { task: 'feature', stage: stage as never, ...extra }, now, sid)

describe('推測只在本 session 沒有權威來源時改階段', () => {
  test('無權威時推測生效並記錄 stageSince', async () => {
    const s = applyClassification(feature('intent'), { guess: 'verify' }, 1000, S1, 'ios')
    expect(s.stage).toBe('verify')
    expect(s.stageSince).toBe(1000)
    expect(s.source).toBe('guess')
    expect(isLocked(s, S1)).toBe(false)
  })
  test('權威轉換後，推測不改階段', async () => {
    let s = applyClassification(feature('intent'), { authority: 'review' }, 1000, S1, 'ios')
    s = applyClassification(s, { guess: 'verify' }, 2000, S1, 'ios')
    expect(s.stage).toBe('review')
    expect(isLocked(s, S1)).toBe(true)
  })
  test('SetStage 後，推測不改階段；權威轉換仍覆蓋 SetStage', async () => {
    let s = feature('impl', 1000, S1, { detail: 'T3/5', milestone: 'M48' })
    s = applyClassification(s, { guess: 'verify' }, 2000, S1, 'ios')
    expect(s.stage).toBe('impl')
    expect(s.detail).toBe('T3/5')
    s = applyClassification(s, { authority: 'review' }, 3000, S1, 'ios')
    expect(s.stage).toBe('review')
    expect(s.detail).toBeUndefined()
    expect(s.milestone).toBe('M48')
  })
  test('上個 session 的鎖不影響新 session', async () => {
    let s = feature('impl', 1000, S1)
    expect(isLocked(s, S2)).toBe(false)
    s = applyClassification(s, { guess: 'verify' }, 2000, S2, 'ios')
    expect(s.stage).toBe('verify')
  })
  test('load 不改階段、也不鎖推測', async () => {
    let s = feature('plan', 1000, S1)
    s = applyClassification(s, { handoff: 'load' }, 2000, S2, 'ios')
    expect(s.stage).toBe('plan')
    expect(s.handoff).toBe('load')
    expect(isLocked(s, S2)).toBe(false)
  })
  test('查不到的步驟不改：work 任務遇到 ios-to-tf（ship）與 xcodebuild test（verify）', async () => {
    let s = applySetStage(emptyState(), { task: 'work', stage: 'research' }, 1000, 'boot')
    s = applyClassification(s, { authority: 'ship' }, 2000, S1, 'ios')
    expect(s.stage).toBe('research')
    s = applyClassification(s, { guess: 'verify' }, 3000, S1, 'ios')
    expect(s.stage).toBe('research')
  })
  test('沒有任務時，步驟推測不改階段', async () => {
    const s = applyClassification(emptyState(), { guess: 'verify' }, 1000, S1, 'ios')
    expect(s.stage).toBeNull()
  })
})

describe('任務推斷', () => {
  test('bugfix 訊號（ios-diagnose 權威）→ 任務 bugfix、步驟 diagnose、標示推測', async () => {
    const s = applyClassification(emptyState(), { task: 'bugfix', authority: 'diagnose' }, 1000, S1, 'ios')
    expect(s.task).toBe('bugfix')
    expect(s.taskSource).toBe('inferred')
    expect(s.stage).toBe('diagnose')
  })
  test('feature 訊號（brainstorming / specs）→ 任務 feature', async () => {
    const s = applyClassification(emptyState(), { task: 'feature', guess: 'spec' }, 1000, S1, 'default')
    expect(s.task).toBe('feature')
    expect(s.stage).toBe('spec')
  })
  test('本 session 已宣告 task 時不推斷任務', async () => {
    const s0 = applySetStage(emptyState(), { task: 'work', stage: 'clarify' }, 1000, S1)
    const s = applyClassification(s0, { task: 'bugfix', authority: 'diagnose' }, 2000, S1, 'ios')
    expect(s.task).toBe('work')
    expect(s.stage).toBe('clarify')
  })
  test('讀取類呼叫再多也不推斷任務（work 靠模型宣告）', async () => {
    let s = emptyState()
    for (let i = 0; i < 20; i++) s = applyClassification(s, {}, 1000 + i, S1, 'default')
    expect(s.task).toBeUndefined()
  })
  test('寫程式檔且仍未判定 → feature', async () => {
    const s = applyClassification(emptyState(), { codeWrite: true, other: true }, 1000, S1, 'default')
    expect(s.task).toBe('feature')
    expect(s.taskSource).toBe('inferred')
  })
  test('宣告的 work 不因寫程式檔改變', async () => {
    let w = applySetStage(emptyState(), { task: 'work', stage: 'produce' }, 1000, S1)
    w = applyClassification(w, { codeWrite: true, other: true }, 2000, S1, 'default')
    expect(w.task).toBe('work')
    expect(w.stage).toBe('produce')
  })
  test('明確訊號推斷的 bugfix 不被較弱訊號（/specs/ 寫入、寫程式檔）覆蓋，也不解除權威鎖', async () => {
    let s = applyClassification(emptyState(), { task: 'bugfix', taskStrength: 'strong', authority: 'diagnose' }, 1000, S1, 'ios')
    s = applyClassification(s, { task: 'feature', taskStrength: 'weak', guess: 'spec', codeWrite: true }, 2000, S1, 'ios')
    expect(s.task).toBe('bugfix')
    expect(s.stage).toBe('diagnose')
    expect(isLocked(s, S1)).toBe(true)
  })
  test('同級明確訊號可以跨任務切換（bugfix → brainstorming 的 feature）', async () => {
    let s = applyClassification(emptyState(), { task: 'bugfix', taskStrength: 'strong', authority: 'diagnose' }, 1000, S1, 'ios')
    s = applyClassification(s, { task: 'feature', taskStrength: 'strong' }, 2000, S1, 'ios')
    expect(s.task).toBe('feature')
  })
  test('TASK_SIGNAL_RANK 優先序：弱訊號 < 明確訊號；沒有讀取門檻', async () => {
    expect('reads' in TASK_SIGNAL_RANK).toBe(false)
    expect(TASK_SIGNAL_RANK.weak).toBeLessThan(TASK_SIGNAL_RANK.strong)
  })
  test('推斷換任務時重設步驟與 badge', async () => {
    let s = applyClassification(feature('impl', 0, 'old'), { badge: 'merge' }, 500, S1, 'ios')
    s = applyClassification(s, { task: 'bugfix', authority: 'diagnose' }, 1000, S1, 'ios')
    expect(s.task).toBe('bugfix')
    expect(s.stage).toBe('diagnose')
    expect(s.stageSince).toBe(1000)
    expect(s.badges ?? []).toEqual([])
  })
})

describe('SetStage 的任務與步驟', () => {
  test('帶 task 且不同 → 換整條、重設計時、清 badge', async () => {
    let s = applyClassification(feature('impl', 1000, S1), { badge: 'debug' }, 1100, S1, 'ios')
    s = applySetStage(s, { task: 'bugfix', stage: 'reproduce' }, 2000, S1)
    expect(s.task).toBe('bugfix')
    expect(s.taskSource).toBe('declared')
    expect(s.stage).toBe('reproduce')
    expect(s.stageSince).toBe(2000)
    expect(s.badges ?? []).toEqual([])
  })
  test('不帶 task → 沿用目前任務', async () => {
    const r = resolveSetStage(feature('impl'), { stage: 'verify' }, 'ios')
    expect(r).toEqual({ task: 'feature', stage: 'verify' })
  })
  test('沒有任務且 stage 唯一屬於某任務 → 用它', async () => {
    expect(resolveSetStage(emptyState(), { stage: 'diagnose' }, 'ios')).toEqual({ task: 'bugfix', stage: 'diagnose' })
    expect(resolveSetStage(emptyState(), { stage: 'research' }, 'default')).toEqual({ task: 'work', stage: 'research' })
  })
  test('沒有任務且 stage 屬於多個任務 → 錯誤請帶 task', async () => {
    const r = resolveSetStage(emptyState(), { stage: 'review' }, 'ios')
    expect('error' in r && r.error).toContain('task')
  })
  test('stage 不屬於該任務 → 錯誤列出合法 stage', async () => {
    const r = resolveSetStage(emptyState(), { task: 'bugfix', stage: 'spec' }, 'ios')
    expect('error' in r).toBe(true)
    if ('error' in r) expect(r.error).toContain('reproduce, diagnose, red, fix, verify, review, ship')
  })
  test('default 專案的 feature 沒有 submit；ios 有', async () => {
    expect('error' in resolveSetStage(emptyState(), { task: 'feature', stage: 'submit' }, 'default')).toBe(true)
    expect(resolveSetStage(emptyState(), { task: 'feature', stage: 'submit' }, 'ios')).toEqual({ task: 'feature', stage: 'submit' })
  })
  test('未知 task → 錯誤', async () => {
    const r = resolveSetStage(emptyState(), { task: 'chore', stage: 'plan' }, 'ios')
    expect('error' in r && r.error).toContain('feature')
  })
})

describe('階段與時間', () => {
  test('可以往回跳（不強制單調）', async () => {
    let s = feature('verify', 1000, S1)
    s = applySetStage(s, { task: 'feature', stage: 'impl' }, 2000, S1)
    expect(s.stage).toBe('impl')
    expect(s.stageSince).toBe(2000)
  })
  test('同階段只改 detail 不重設 stageSince', async () => {
    let s = feature('impl', 1000, S1, { detail: 'T1/5' })
    s = applySetStage(s, { task: 'feature', stage: 'impl', detail: 'T2/5' }, 5000, S1)
    expect(s.stageSince).toBe(1000)
    expect(s.detail).toBe('T2/5')
    expect(s.updatedAt).toBe(5000)
  })
  test('badge 只累積在本 session', async () => {
    let s = applyClassification(emptyState(), { badge: 'merge' }, 1000, S1, 'ios')
    s = applyClassification(s, { badge: 'debug' }, 1100, S1, 'ios')
    s = applyClassification(s, { badge: 'merge' }, 1200, S1, 'ios')
    expect(s.badges).toEqual(['merge', 'debug'])
    s = applyClassification(s, { badge: 'design' }, 2000, S2, 'ios')
    expect(s.badges).toEqual(['design'])
  })
  test('submitted 在離開 submit 階段時清掉', async () => {
    let s = applyClassification(feature('ship'), { authority: 'submit' }, 1000, S1, 'ios')
    s = applyClassification(s, { guess: 'submit', submitted: true }, 1100, S1, 'ios')
    expect(s.submitted).toBe(true)
    s = applySetStage(s, { task: 'feature', stage: 'impl' }, 1200, S1)
    expect(s.submitted).toBeFalsy()
  })
  test('沒有任何變化時回傳同一物件（不寫 store）', async () => {
    const s = feature('impl', 1000, S1)
    expect(applyClassification(s, {}, 2000, S1, 'ios')).toBe(s)
  })
})

const MIN = 60_000
const STALE = THRESHOLDS.staleAfterMin * MIN

describe('新鮮度：只有設定任務／步驟的事件寫 stageSessionId／stageAt', () => {
  test('staleAfterMin 預設 120 分鐘', async () => {
    expect(THRESHOLDS.staleAfterMin).toBe(120)
  })
  test('SetStage 寫入；同 session 且未超過門檻才算 fresh', async () => {
    const s = feature('impl', 1000, S1)
    expect(s.stageSessionId).toBe(S1)
    expect(s.stageAt).toBe(1000)
    expect(isFresh(s, S1, 1000 + STALE - 1)).toBe(true)
    expect(isFresh(s, S1, 1000 + STALE)).toBe(false)
    expect(isFresh(s, S2, 1000)).toBe(false)
    expect(isFresh(emptyState(), S1, 0)).toBe(false)
  })
  test('新 session 的 badge／handoff 不讓舊步驟變成本 session 的（截圖的根因）', async () => {
    const old: StageState = { ...applyClassification(emptyState(), { task: 'feature', taskStrength: 'weak' }, 0, 'old', 'ios'), stage: 'ship', source: 'guess' }
    let s = applyClassification(old, { badge: 'mutation', other: true }, 17 * 60 * MIN, S2, 'ios')
    s = applyClassification(s, { handoff: 'load' }, 17 * 60 * MIN + 1, S2, 'ios')
    expect(s.badges).toEqual(['mutation'])
    expect(s.stageSessionId).toBe('old')
    expect(s.stageAt).toBe(0)
    expect(isFresh(s, S2, 17 * 60 * MIN + 1)).toBe(false)
  })
  test('權威轉換、推測步驟、任務推斷切換都會寫入', async () => {
    const a = applyClassification(feature('impl', 0, 'old'), { authority: 'review' }, 5000, S1, 'ios')
    expect([a.stageSessionId, a.stageAt]).toEqual([S1, 5000])
    const g = applyClassification(feature('impl', 0, 'old'), { guess: 'verify' }, 6000, S1, 'ios')
    expect([g.stageSessionId, g.stageAt]).toEqual([S1, 6000])
    const t = applyClassification(emptyState(), { task: 'bugfix', taskStrength: 'strong' }, 7000, S1, 'ios')
    expect([t.stageSessionId, t.stageAt]).toEqual([S1, 7000])
  })
  test('推測等於目前步驟也刷新 stageAt（不重設 stageSince）', async () => {
    let s = applyClassification(feature('intent', 0, 'old'), { guess: 'verify' }, 1000, S1, 'ios')
    s = applyClassification(s, { guess: 'verify' }, 90 * MIN, S1, 'ios')
    expect(s.stage).toBe('verify')
    expect(s.stageSince).toBe(1000)
    expect(s.stageAt).toBe(90 * MIN)
  })
  test('本 session 已鎖：不同步驟的推測不改步驟，但刷新 stageAt（仍在工作）', async () => {
    let s = feature('impl', 1000, S1)
    s = applyClassification(s, { guess: 'verify' }, 60 * MIN, S1, 'ios')
    expect(s.stage).toBe('impl')
    expect(s.stageAt).toBe(60 * MIN)
  })
  test('不 fresh 的任務強度視為 0：本 session 任何任務訊號都取代它（同任務也重新開始）', async () => {
    const old = feature('ship', 0, 'old', { detail: 'T3/5' })
    const bug = applyClassification(old, { task: 'bugfix', taskStrength: 'weak' }, 1000, S1, 'ios')
    expect(bug.task).toBe('bugfix')
    expect(bug.taskSource).toBe('inferred')
    expect(isFresh(bug, S1, 1000)).toBe(true)
    const again = applyClassification(old, { codeWrite: true, other: true }, 1000, S1, 'ios')
    expect(again.task).toBe('feature')
    expect(again.taskSource).toBe('inferred')
    expect(again.stage).toBe('impl')
    expect(again.detail).toBeUndefined()
    expect(isFresh(again, S1, 1000)).toBe(true)
  })
  test('同 session 宣告的任務過了門檻也不被推斷取代', async () => {
    const s = applyClassification(feature('impl', 0, S1), { task: 'bugfix', taskStrength: 'strong' }, STALE + 1, S1, 'ios')
    expect(s.task).toBe('feature')
    expect(s.taskSource).toBe('declared')
  })
  test('同 session 宣告 bugfix → 121 分鐘 → 寫程式檔：仍是 bugfix／fix，且回到 fresh', async () => {
    const decl = applySetStage(emptyState(), { task: 'bugfix', stage: 'fix' }, 0, S1)
    const s = applyClassification(decl, { codeWrite: true, other: true }, STALE + MIN, S1, 'ios')
    expect(s.task).toBe('bugfix')
    expect(s.taskSource).toBe('declared')
    expect(s.stage).toBe('fix')
    expect(isFresh(s, S1, STALE + MIN)).toBe(true)
  })
  test('本 session 的動作（other）刷新 stageAt、不改步驟：一直在工作就不會過期', async () => {
    let s = applySetStage(emptyState(), { task: 'bugfix', stage: 'fix' }, 0, S1)
    for (let t = 30; t <= 240; t += 30) s = applyClassification(s, { other: true }, t * MIN, S1, 'ios')
    expect(s.stage).toBe('fix')
    expect(s.stageSince).toBe(0)
    expect(isFresh(s, S1, 250 * MIN)).toBe(true)
  })
  test('別的 session 的舊任務：動作（other）不刷新（只有步驟／任務訊號能延續）', async () => {
    const old = applySetStage(emptyState(), { task: 'bugfix', stage: 'fix' }, 0, 'old')
    const s = applyClassification(old, { other: true, badge: 'mutation' }, 1000, S1, 'ios')
    expect(isFresh(s, S1, 1000)).toBe(false)
    expect(s.stageSessionId).toBe('old')
  })
  test('同 session 推斷的任務過期後，任務訊號可取代', async () => {
    const inf = applyClassification(emptyState(), { task: 'bugfix', taskStrength: 'weak' }, 0, S1, 'ios')
    const s = applyClassification(inf, { task: 'feature', taskStrength: 'weak' }, STALE + 1, S1, 'ios')
    expect(s.task).toBe('feature')
  })
  test('延續上個 session 宣告的任務 → 改標為推測（strong），本 session 還沒宣告', async () => {
    const old = applySetStage(emptyState(), { task: 'bugfix', stage: 'fix' }, 0, 'old')
    const g = applyClassification(old, { guess: 'verify' }, 1000, S1, 'ios')
    expect(g.taskSource).toBe('inferred')
    expect(g.taskRank).toBe(TASK_SIGNAL_RANK.strong)
    const a = applyClassification(old, { authority: 'review' }, 1000, S1, 'ios')
    expect(a.taskSource).toBe('inferred')
  })
  test('本 session 的步驟訊號符合舊任務的步驟表 → 延續舊任務並變 fresh（計時重來、清舊 detail）', async () => {
    const old = feature('impl', 0, 'old', { detail: 'T3/5', milestone: 'M48' })
    const s = applyClassification(old, { guess: 'impl' }, 17 * 60 * MIN, S2, 'ios')
    expect(s.task).toBe('feature')
    expect(s.stage).toBe('impl')
    expect(s.stageSince).toBe(17 * 60 * MIN)
    expect(s.detail).toBeUndefined()
    expect(s.milestone).toBe('M48')
    expect(isFresh(s, S2, 17 * 60 * MIN)).toBe(true)
  })
  test('同 session 過了門檻且已鎖：推測仍可延續（解除過期的鎖）', async () => {
    const s = applyClassification(feature('impl', 0, S1), { guess: 'verify' }, STALE + 1, S1, 'ios')
    expect(s.stage).toBe('verify')
    expect(isFresh(s, S1, STALE + 1)).toBe(true)
  })
  test('不符合舊任務步驟表的步驟訊號不延續（work 遇到 verify）', async () => {
    const old = applySetStage(emptyState(), { task: 'work', stage: 'research' }, 0, 'old')
    const s = applyClassification(old, { guess: 'verify' }, 1000, S1, 'ios')
    expect(isFresh(s, S1, 1000)).toBe(false)
  })
  test('寫程式檔推斷出 feature 且沒有步驟 → 推測 impl', async () => {
    const s = applyClassification(emptyState(), { codeWrite: true, other: true }, 1000, S1, 'default')
    expect(s.stage).toBe('impl')
    expect(s.source).toBe('guess')
  })
})

describe('舊 store 資料相容', () => {
  test('沒有 stageSessionId／stageAt 的舊 store 視為不 fresh；有的照讀', async () => {
    const old = migrateState({ task: 'feature', taskSource: 'inferred', stage: 'ship', stageSince: 1, updatedAt: 2, source: 'guess', sessionId: S1 })
    expect(old.stageSessionId).toBeUndefined()
    expect(old.stageAt).toBe(2)
    expect(isFresh(old, S1, 3)).toBe(false)
    const cur = migrateState({ task: 'feature', stage: 'ship', stageSince: 1, updatedAt: 2, source: 'guess', sessionId: S1, stageSessionId: S1, stageAt: 2 })
    expect(isFresh(cur, S1, 3)).toBe(true)
    const bad = migrateState({ task: 'feature', stage: 'ship', stageSince: 1, updatedAt: 2, source: 'guess', stageSessionId: 5, stageAt: 'x' })
    expect(bad.stageSessionId).toBeUndefined()
    expect(bad.stageAt).toBe(2)
    expect(migrateState({ stage: null, stageSince: 0, updatedAt: 5, source: 'none' }).stageAt).toBeUndefined()
  })
  test('0.1 的 tf／device 映射成 feature 的 ship／accept', async () => {
    const tf = migrateState({ stage: 'tf', stageSince: 1, updatedAt: 2, source: 'setstage', sessionId: 'x', milestone: 'M48' })
    expect(tf.task).toBe('feature')
    expect(tf.stage).toBe('ship')
    expect(tf.milestone).toBe('M48')
    expect(migrateState({ stage: 'device', stageSince: 1, updatedAt: 2, source: 'guess' }).stage).toBe('accept')
    expect(migrateState({ stage: 'impl', stageSince: 1, updatedAt: 2, source: 'guess' }).task).toBe('feature')
  })
  test('型別錯的欄位清成預設，其餘保留', async () => {
    const s = migrateState({
      task: 'bugfix', taskSource: 'declared', stage: 'fix', stageSince: 1, updatedAt: 2, source: 'setstage',
      milestone: 42, detail: {}, badges: 'merge', counts: 5, locked: 'yes', handoff: 'x', submitted: 1, sessionId: 7, taskRank: 'hi',
    })
    expect(s.task).toBe('bugfix')
    expect(s.stage).toBe('fix')
    for (const k of ['milestone', 'detail', 'badges', 'counts', 'locked', 'handoff', 'submitted', 'sessionId', 'taskRank']) {
      expect((s as Record<string, unknown>)[k]).toBeUndefined()
    }
    const bad = migrateState({ stage: 'fix', stageSince: 'x', updatedAt: null, source: 'weird', task: 'bugfix', badges: ['merge', 'nope'] })
    expect(bad.stageSince).toBe(0)
    expect(bad.updatedAt).toBe(0)
    expect(bad.source).toBe('none')
    expect(bad.badges).toEqual(['merge'])
  })
  test('舊版的 counts（讀取計數）不再保留', async () => {
    const s = migrateState({ task: 'work', stage: 'research', stageSince: 1, updatedAt: 2, source: 'guess', counts: { sessionId: 'x', reads: 9, others: 0 } })
    expect('counts' in s).toBe(false)
  })
  test('壞資料 → 空狀態', async () => {
    expect(migrateState(undefined)).toEqual(emptyState())
    expect(migrateState({ foo: 1 })).toEqual(emptyState())
    expect(migrateState({ stage: 'nope', stageSince: 1, updatedAt: 2, source: 'guess' }).stage).toBeNull()
  })
})
