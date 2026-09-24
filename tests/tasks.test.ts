import { test, expect, describe } from 'claude-code/testing'
import { stagesFor, tasksWithStage } from '../src/tasks.ts'

const labels = (task: 'feature' | 'bugfix' | 'work', project: 'ios' | 'default') => stagesFor(task, project).map(s => s.label)

describe('任務步驟表與專案 override', () => {
  test('ios：feature 9 點，ship=TF、accept=真機、有送審；bugfix 的 ship=TF', async () => {
    expect(labels('feature', 'ios')).toEqual(['需求', '規格', '拆解', '實作', '驗證', '審查', 'TF', '真機', '送審'])
    expect(labels('bugfix', 'ios')).toEqual(['重現', '診斷', '紅測試', '修正', '驗證', '審查', 'TF'])
  })
  test('default：feature 8 點（沒有送審），ship=部署、accept=驗收；bugfix 的 ship=部署', async () => {
    expect(labels('feature', 'default')).toEqual(['需求', '規格', '拆解', '實作', '驗證', '審查', '部署', '驗收'])
    expect(labels('bugfix', 'default')).toEqual(['重現', '診斷', '紅測試', '修正', '驗證', '審查', '部署'])
  })
  test('work 兩種專案相同', async () => {
    expect(labels('work', 'ios')).toEqual(['釐清', '研究', '產出', '審查', '交付'])
    expect(labels('work', 'default')).toEqual(labels('work', 'ios'))
  })
  test('tasksWithStage 考慮 override', async () => {
    expect(tasksWithStage('submit', 'ios')).toEqual(['feature'])
    expect(tasksWithStage('submit', 'default')).toEqual([])
    expect(tasksWithStage('review', 'ios')).toEqual(['feature', 'bugfix', 'work'])
    expect(tasksWithStage('diagnose', 'ios')).toEqual(['bugfix'])
  })
})
