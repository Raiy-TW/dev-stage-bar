// 階段資料：想改標籤、順序、門檻、配色就改這個檔，邏輯不用動。

/** 進度條 9 格，順序即流程順序（每輪一定經過）。 */
export const STAGES = [
  { id: 'intent', label: '需求' },
  { id: 'spec', label: '規格' },
  { id: 'plan', label: '拆解' },
  { id: 'impl', label: '實作' },
  { id: 'verify', label: '驗證' },
  { id: 'review', label: '審查' },
  { id: 'tf', label: 'TF' },
  { id: 'device', label: '真機' },
  { id: 'submit', label: '送審' },
] as const

export type StageId = (typeof STAGES)[number]['id']

export const STAGE_IDS: readonly StageId[] = STAGES.map(s => s.id)

/** 進度條的點與連接線：已過 ●━、目前 ◉、未到 ○┄。 */
export const GLYPHS = { done: '●', current: '◉', todo: '○', doneLine: '━', todoLine: '┄' } as const

/** 可選活動 badge（第二行，本 session 有發生才顯示）。 */
export const BADGES = ['design', 'upgrade', 'mutation', 'debug', 'merge'] as const
export type BadgeId = (typeof BADGES)[number]

/** 等待中的階段：到了這些階段狀態顯示 ⏸（等你）。 */
export const WAITING_STAGES: readonly StageId[] = ['device']

/** 門檻（分鐘）。卡住門檻可用環境變數覆寫，見 hooks/index.ts。 */
export const THRESHOLDS = {
  /** 最近幾分鐘內有工具活動算「執行中」。 */
  activeMin: 5,
  /** 單一工具呼叫進行超過幾分鐘算「可能卡住」。 */
  stuckToolMin: 20,
  /** isWorking 但幾分鐘沒有任何 tool.call 事件算「可能卡住」。 */
  stuckIdleMin: 10,
  /** 進行超過幾秒的工具呼叫才顯示在第二行（避免短呼叫造成閃爍）。 */
  showToolAfterSec: 30,
} as const

/** 重新計算畫面的週期（毫秒）；內容沒變不會 invalidate。 */
export const TICK_MS = 20_000

/** 寬度低於此值（或點距不到 1 格）改用單行窄版 ●●●●◉○○○○ 驗證 · 12m。 */
export const NARROW_COLUMNS = 40

/** 點線進度條右側保留的邊距（欄）。 */
export const SAFETY_MARGIN = 1

/** Macaron 色系（對應 statusline.sh 的 soft blue / green / lemon / coral）。 */
export const COLORS = {
  current: '#a8d8ea',
  done: '#b8e6b8',
  waiting: '#f0dc8c',
  stuck: '#f09696',
  running: '#a8d8ea',
  milestone: '#f0dc8c',
} as const
