import { test, expect, describe } from 'claude-code/testing'
import { emptyState, applyClassification, applySetStage, isLocked } from '../src/state.ts'

const S1 = 'session-1'
const S2 = 'session-2'

describe('推測只在本 session 沒有權威來源時改階段', () => {
  test('無權威時推測生效並記錄 stageSince', async () => {
    const s = applyClassification(emptyState(), { guess: 'verify' }, 1000, S1)
    expect(s.stage).toBe('verify')
    expect(s.stageSince).toBe(1000)
    expect(s.source).toBe('guess')
    expect(isLocked(s, S1)).toBe(false)
  })
  test('權威轉換後，推測不改階段', async () => {
    let s = applyClassification(emptyState(), { authority: 'review' }, 1000, S1)
    s = applyClassification(s, { guess: 'verify' }, 2000, S1)
    expect(s.stage).toBe('review')
    expect(isLocked(s, S1)).toBe(true)
  })
  test('SetStage 後，推測不改階段；權威轉換仍覆蓋 SetStage', async () => {
    let s = applySetStage(emptyState(), { stage: 'impl', detail: 'T3/5', milestone: 'M48' }, 1000, S1)
    s = applyClassification(s, { guess: 'verify' }, 2000, S1)
    expect(s.stage).toBe('impl')
    expect(s.detail).toBe('T3/5')
    s = applyClassification(s, { authority: 'review' }, 3000, S1)
    expect(s.stage).toBe('review')
    expect(s.detail).toBeUndefined()
    expect(s.milestone).toBe('M48')
  })
  test('上個 session 的鎖不影響新 session', async () => {
    let s = applySetStage(emptyState(), { stage: 'impl' }, 1000, S1)
    expect(isLocked(s, S2)).toBe(false)
    s = applyClassification(s, { guess: 'verify' }, 2000, S2)
    expect(s.stage).toBe('verify')
  })
  test('load 不改階段、也不鎖推測', async () => {
    let s = applySetStage(emptyState(), { stage: 'plan' }, 1000, S1)
    s = applyClassification(s, { handoff: 'load' }, 2000, S2)
    expect(s.stage).toBe('plan')
    expect(s.handoff).toBe('load')
    expect(isLocked(s, S2)).toBe(false)
  })
})

describe('階段與時間', () => {
  test('可以往回跳（不強制單調）', async () => {
    let s = applySetStage(emptyState(), { stage: 'verify' }, 1000, S1)
    s = applySetStage(s, { stage: 'impl' }, 2000, S1)
    expect(s.stage).toBe('impl')
    expect(s.stageSince).toBe(2000)
  })
  test('同階段只改 detail 不重設 stageSince', async () => {
    let s = applySetStage(emptyState(), { stage: 'impl', detail: 'T1/5' }, 1000, S1)
    s = applySetStage(s, { stage: 'impl', detail: 'T2/5' }, 5000, S1)
    expect(s.stageSince).toBe(1000)
    expect(s.detail).toBe('T2/5')
    expect(s.updatedAt).toBe(5000)
  })
  test('badge 只累積在本 session', async () => {
    let s = applyClassification(emptyState(), { badge: 'merge' }, 1000, S1)
    s = applyClassification(s, { badge: 'debug' }, 1100, S1)
    s = applyClassification(s, { badge: 'merge' }, 1200, S1)
    expect(s.badges).toEqual(['merge', 'debug'])
    s = applyClassification(s, { badge: 'design' }, 2000, S2)
    expect(s.badges).toEqual(['design'])
  })
  test('submitted 在離開 submit 階段時清掉', async () => {
    let s = applyClassification(emptyState(), { authority: 'submit' }, 1000, S1)
    s = applyClassification(s, { guess: 'submit', submitted: true }, 1100, S1)
    expect(s.submitted).toBe(true)
    s = applySetStage(s, { stage: 'impl' }, 1200, S1)
    expect(s.submitted).toBeFalsy()
  })
  test('沒有任何變化時回傳同一物件（不寫 store）', async () => {
    const s = applySetStage(emptyState(), { stage: 'impl' }, 1000, S1)
    expect(applyClassification(s, {}, 2000, S1)).toBe(s)
  })
})
