import { test, expect, describe } from 'claude-code/testing'
import { classifyPrompt } from '../src/intent.ts'

type Want = 'chat' | undefined | { task: string; stage: string }
const BUG = { task: 'bugfix', stage: 'reproduce' }
const FEAT = { task: 'feature', stage: 'intent' }
const WORK = { task: 'work', stage: 'clarify' }

const CASES: [string, Want][] = [
  // 使用者實際的 prompt
  ['幫我優化 dev-stage-bar 他會莫名卡在某個階段', FEAT], // 「優化」命中 feature；「卡在」不是 bugfix 關鍵字
  ['用 haiku 讀 prompt 判斷任務 這個會很消耗token嗎？', 'chat'],
  ['push', undefined],
  ['幫我修登入閃退', BUG],
  ['研究一下競品定價', WORK],
  // bugfix
  ['App 一開就 crash', BUG],
  ['登入按鈕按了不會動', BUG],
  ['build 報錯了，幫我看', BUG], // bugfix 與 feature（build）同時命中 → bugfix 優先
  ['Fix the login error', BUG],
  ['上傳一直失敗', BUG],
  ['為什麼會閃退？', BUG], // 疑問句但有動作關鍵字 → 動作優先
  // feature
  ['新增一個匯出 CSV 的按鈕', FEAT],
  ['幫我做一個設定頁', FEAT],
  ['把首頁改成兩欄', FEAT],
  ['implement dark mode', FEAT],
  ['Add a share sheet', FEAT],
  ['把按鈕顏色修改成藍色', FEAT], // 「修改」先被中和，不算 bugfix 的「修」
  // work
  ['幫我規劃下個月的 roadmap', WORK],
  ['整理一份會議紀錄', WORK],
  ['比較 A 跟 B 兩個方案', WORK],
  ['write the docs for the API', WORK],
  ['新增一份研究報告', FEAT], // feature 與 work 同時命中 → 依優先序 feature
  // chat
  ['這段程式在做什麼', 'chat'],
  ['SwiftData 跟 Core Data 差別？', 'chat'],
  ['how does the stage bar decide the task?', 'chat'],
  ['你覺得這樣好嗎', 'chat'],
  ['能不能解釋一下 prompt cache', 'chat'],
  // 接續、太短、slash command → 不判斷
  ['繼續', undefined],
  ['好', undefined],
  ['ok', undefined],
  ['OK!', undefined],
  ['commit', undefined],
  ['存檔', undefined],
  ['/save', undefined],
  ['/ios-review 修 bug', undefined],
  ['嗯嗯', undefined],
  ['', undefined],
  // 英文關鍵字以單字邊界比對：address 不是 add、debugger 不是 bug、planet 不是 plan
  ['update the address field', undefined],
  ['the planet list looks fine', undefined],
]

describe('prompt 意圖（純本地規則，不花 token）', () => {
  for (const [text, want] of CASES) {
    test(`${JSON.stringify(text)} → ${JSON.stringify(want)}`, async () => {
      expect(classifyPrompt(text)).toEqual(want)
    })
  }
})
