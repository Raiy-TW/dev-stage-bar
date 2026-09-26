import { test, expect, describe } from 'claude-code/testing'
import { classifyPrompt } from '../src/intent.ts'

type Want = 'chat' | undefined | { task: string; stage: string }
const BUG = { task: 'bugfix', stage: 'reproduce' }
const FEAT = { task: 'feature', stage: 'intent' }
const WORK = { task: 'work', stage: 'clarify' }

const CASES: [string, Want, string?][] = [
  // 使用者實際的 prompt
  ['幫我優化 dev-stage-bar 他會莫名卡在某個階段', FEAT, '「幫我」＋「優化」；「卡在」不是症狀詞'],
  ['用 haiku 讀 prompt 判斷任務 這個會很消耗token嗎？', 'chat'],
  ['push', undefined],
  ['幫我修登入閃退', BUG, '症狀詞「閃退」'],
  ['研究一下競品定價', WORK, '句首動詞「研究」'],

  // 一般問句：功能／工作詞不壓過問句
  ['哪個比較好？', 'chat'],
  ['用 SwiftData 還是 Core Data 比較快？', 'chat'],
  ['這段是怎麼實作的？', 'chat'],
  ['看一下文件怎麼說', 'chat'],
  ['你剛剛修了哪些檔？', 'chat'],
  ['這兩種做法的好壞？', 'chat'],
  ['錯誤處理要怎麼設計？', 'chat', '通用錯誤詞在問句裡不算 bug'],
  ['這段程式在做什麼', 'chat'],
  ['SwiftData 跟 Core Data 差別？', 'chat'],
  ['how does the stage bar decide the task?', 'chat'],
  ['你覺得這樣好嗎', 'chat'],
  ['能不能解釋一下 prompt cache', 'chat'],

  // 症狀詞：問句裡也算 bugfix
  ['為什麼會閃退？', BUG],
  ['App 一開就 crash', BUG],
  ['登入按鈕按了不會動', BUG],
  ['build 報錯了，幫我看', BUG],
  ['畫面卡住了嗎？', BUG],
  ['設定頁壞掉了', BUG],
  ['按下去就當掉', BUG],
  ['the app crashes on launch', BUG],

  // 通用 bug 詞：沒有問句、也沒有「要做功能」時才算
  ['上傳一直失敗', BUG],
  ['Fix the login error', BUG],
  ['tests are failing', BUG],
  ['there are bugs in login', BUG],
  ['幫我新增錯誤處理', FEAT],
  ['登入失敗時要顯示提示，幫我加上', FEAT],
  ['加上 error log', FEAT],

  // 修：只有「修好／修掉／修復／幫我修／修 bug」才算；修一下文案、修訂不算
  ['修一下文案', undefined],
  ['修訂 README', undefined],
  ['幫我修好登入', BUG],
  ['把這個問題修掉', BUG],

  // feature／work 要有祈使（幫我、請、把、給我、麻煩、我要、我想要、please、let's、can you…）或句首就是動作詞
  ['新增一個匯出 CSV 的按鈕', FEAT],
  ['幫我做一個設定頁', FEAT],
  ['把首頁改成兩欄', FEAT],
  ['implement dark mode', FEAT],
  ['Add a share sheet', FEAT],
  ['adding a toggle for dark mode', FEAT, '句首動作詞含字尾變化'],
  ['把按鈕顏色修改成藍色', FEAT, '「修改」先換成「改」'],
  ['新增一份研究報告', FEAT, 'feature 優先於 work'],
  ['首頁如果改成兩欄會比較好', undefined, '沒有祈使'],
  ['幫我 build 一下看看', undefined, 'build 不是功能詞'],
  ['幫我規劃下個月的 roadmap', WORK],
  ['整理一份會議紀錄', WORK],
  ['幫我比較一下 A 跟 B 兩個方案', WORK],
  ['A 方案跟 B 方案比較', undefined, '單獨的「比較」不算'],
  ['please write the docs for the API', WORK],
  ['can you research competitor pricing', WORK],

  // 接續、太短、slash command
  ['繼續', undefined],
  ['好', undefined],
  ['ok', undefined],
  ['OK!', undefined],
  ['commit', undefined],
  ['存檔', undefined],
  ['/save', undefined],
  ['/ios-review 修 bug', undefined],
  ['/codex:rescue 幫我修登入閃退', undefined],
  ['/Users/ray/app/Login.swift 這裡一開就閃退', BUG, '路徑不是 slash command'],
  ['嗯嗯', undefined],
  ['', undefined],

  // 英文單字邊界：address 不是 add、planet 不是 plan、debugger 不是 debug
  ['update the address field', undefined],
  ['the planet list looks fine', undefined],
  ['open the debugger panel', undefined],

  // 只看第一行、前 120 字；code block 與貼上的內容不算
  ['看一下這段 log\n```\nFatal error: app crashed\n```', undefined],
  ['```\nerror: build failed\n```\n這是什麼意思？', 'chat'],
  ['幫我整理這份清單\n1. crash on launch\n2. 登入失敗', WORK],
  [`${'很長的貼上內容'.repeat(20)} 閃退`, undefined, '超過 120 字的部分不看'],
]

describe('prompt 意圖（純本地規則，不花 token）', () => {
  for (const [text, want, why] of CASES) {
    test(`${JSON.stringify(text).slice(0, 60)} → ${JSON.stringify(want)}${why ? `（${why}）` : ''}`, async () => {
      expect(classifyPrompt(text)).toEqual(want)
    })
  }
})
