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
 * 工具呼叫不推 work（讀再多檔也不算）；work 來自模型的 SetStage 或使用者 prompt 的意圖（見 PROMPT_INTENT）。
 * 數值保留 2／3，與舊 store 存的 taskRank 相容。
 * - weak：寫程式檔（→ feature，只在沒有 fresh 任務時）、寫入 /specs/（→ feature）、使用者 prompt 的意圖（只在沒有 fresh 任務時）
 * - strong：ios-diagnose、systematic-debugging、gh issue（→ bugfix）、brainstorming（→ feature）
 */
export const TASK_SIGNAL_RANK = { weak: 2, strong: 3 } as const

/**
 * prompt 意圖（純本地關鍵字，不呼叫模型、不花 token）：只看使用者自己送出的 prompt。
 * - rules 依陣列順序比對，第一個命中的就是答案（同時命中 bug 與 feature → bugfix；feature 與 work → feature）。
 * - 有任一 rules 命中就不算 chat（「為什麼會閃退？」是 bugfix）。
 * - 中文關鍵字以子字串比對；英文以單字邊界、不分大小寫比對（address 不是 add、debugger 不是 bug）。
 * - neutralize：比對前先換掉的詞（「修改」是改，不是修 bug）。
 * - continuation：整段（去掉標點與空白）等於其中一個、或不超過 shortMax 個字 → 不判斷；以 / 開頭的 slash command 也不判斷。
 */
export const PROMPT_INTENT = {
  rules: [
    { task: 'bugfix', stage: 'reproduce', keywords: ['修', 'bug', '壞', '錯誤', '閃退', 'crash', '卡住', '報錯', 'error', 'fix', '失敗', '不會動', 'debug'] },
    { task: 'feature', stage: 'intent', keywords: ['新增', '加上', '加一個', '做一個', '實作', '優化', '改成', 'implement', 'add', 'build'] },
    { task: 'work', stage: 'clarify', keywords: ['研究', '調查', '規劃', '整理', '文件', '報告', '比較', 'research', 'plan', 'docs'] },
  ],
  chat: {
    endings: ['?', '？'],
    keywords: ['嗎', '呢', '為什麼', '什麼', '怎麼', '如何', '是不是', '會不會', '有沒有', '能不能', '差別', '解釋', 'why', 'what', 'how'],
  },
  neutralize: { 修改: '改', 修飾: '飾' },
  continuation: ['繼續', '好', '好的', 'ok', 'okay', 'yes', 'go', 'push', 'commit', '存檔', 'save', '可以', '對'],
  shortMax: 2,
} as const satisfies {
  rules: readonly { task: TaskId; stage: StageId; keywords: readonly string[] }[]
  chat: { endings: readonly string[]; keywords: readonly string[] }
  neutralize: Readonly<Record<string, string>>
  continuation: readonly string[]
  shortMax: number
}

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
   * 不畫點線，改畫一行 dim 的「上次：…」。SetStage、權威轉換、推測步驟、任務推斷切換（含 prompt 意圖）會刷新；
   * 本 session 主迴圈的動作只刷新時間、不改步驟。badge、handoff、讀取類工具不刷新。
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
