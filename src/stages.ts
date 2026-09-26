// 階段資料：想改標籤、順序、門檻、配色就改這個檔，邏輯不用動。

/** 任務類型：每種任務一張步驟表（每步一個點），順序即流程順序。 */
export const TASKS = {
  feature: {
    label: '新功能',
    stages: [
      { id: 'intent', label: '需求' },
      { id: 'spec', label: '規格' },
      { id: 'plan', label: '拆解' },
      { id: 'impl', label: '實作' },
      { id: 'verify', label: '驗證' },
      { id: 'review', label: '審查' },
      { id: 'ship', label: '出貨' },
      { id: 'accept', label: '驗收' },
      { id: 'submit', label: '送審' },
    ],
  },
  bugfix: {
    label: '修bug',
    stages: [
      { id: 'reproduce', label: '重現' },
      { id: 'diagnose', label: '診斷' },
      { id: 'red', label: '紅測試' },
      { id: 'fix', label: '修正' },
      { id: 'verify', label: '驗證' },
      { id: 'review', label: '審查' },
      { id: 'ship', label: '出貨' },
    ],
  },
  work: {
    label: '非程式',
    stages: [
      { id: 'clarify', label: '釐清' },
      { id: 'research', label: '研究' },
      { id: 'produce', label: '產出' },
      { id: 'review', label: '審查' },
      { id: 'deliver', label: '交付' },
    ],
  },
} as const

export type TaskId = keyof typeof TASKS
export const TASK_IDS = Object.keys(TASKS) as TaskId[]
export type StageId = (typeof TASKS)[TaskId]['stages'][number]['id']
/** 三張表合併的所有 stage id（去重，保持出現順序）。 */
export const ALL_STAGE_IDS: readonly StageId[] = [...new Set(TASK_IDS.flatMap(t => TASKS[t].stages.map(s => s.id)))]

/** 專案類型：只影響少數標籤與 feature 是否有「送審」。 */
export type ProjectKind = 'ios' | 'default'
export const PROJECT_OVERRIDES: Record<
  ProjectKind,
  { labels?: Partial<Record<TaskId, Partial<Record<StageId, string>>>>; omit?: Partial<Record<TaskId, readonly StageId[]>> }
> = {
  ios: { labels: { feature: { ship: 'TF', accept: '真機' }, bugfix: { ship: 'TF' } } },
  default: { labels: { feature: { ship: '部署', accept: '驗收' }, bugfix: { ship: '部署' } }, omit: { feature: ['submit'] } },
}

/**
 * 推斷任務的訊號強度（未宣告 task 時）。較強的訊號可以覆蓋較弱推斷出的任務；
 * 同為 strong 可跨任務切換；宣告（SetStage）的任務不被推斷覆蓋。
 * work 不推斷，靠模型用 SetStage 宣告（數值保留 2／3，與舊 store 存的 taskRank 相容）。
 * - weak：寫程式檔（→ feature）、寫入 /specs/（→ feature）
 * - strong：ios-diagnose、systematic-debugging、gh issue（→ bugfix）、brainstorming（→ feature）
 */
export const TASK_SIGNAL_RANK = { weak: 2, strong: 3 } as const

/** 舊版（0.1）stage id 的對應：tf → ship、device → accept。 */
export const LEGACY_STAGE_IDS: Readonly<Record<string, StageId>> = { tf: 'ship', device: 'accept' }

/** 進度條的點與連接線：已過 ●━、目前 ◉、未到 ○┄。 */
export const GLYPHS = { done: '●', current: '◉', todo: '○', doneLine: '━', todoLine: '┄' } as const

/** 可選活動 badge（第二行，本 session 有發生才顯示）。 */
export const BADGES = ['design', 'upgrade', 'mutation', 'debug', 'merge'] as const
export type BadgeId = (typeof BADGES)[number]

/** 等待中的階段：到了這些階段狀態顯示 ⏸（等你）。 */
export const WAITING_STAGES: readonly StageId[] = ['accept']

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
  /**
   * 任務／步驟多久沒被設定就不算「現在」（分鐘）：超過、或不是本 session 設定的，
   * 不畫點線，改畫一行 dim 的「上次：…」。只有 SetStage、權威轉換、推測步驟、任務推斷切換會刷新。
   */
  staleAfterMin: 120,
} as const

/** 重新計算畫面的週期（毫秒）；內容沒變不會 invalidate。 */
export const TICK_MS = 20_000

/** 寬度低於此值（或點距不到 1 格）改用單行窄版 修bug ●◉○○○○○ 診斷 · 12m。 */
export const NARROW_COLUMNS = 40

/** 點線進度條右側保留的邊距（欄）。 */
export const SAFETY_MARGIN = 2

/** Macaron 色系（對應 statusline.sh 的 soft blue / green / lemon / coral）。 */
export const COLORS = {
  current: '#a8d8ea',
  done: '#b8e6b8',
  waiting: '#f0dc8c',
  stuck: '#f09696',
  running: '#a8d8ea',
  milestone: '#f0dc8c',
} as const
