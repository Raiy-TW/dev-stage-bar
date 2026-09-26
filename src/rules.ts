// 工具呼叫 → 階段訊號的判斷規則（純函式，無 $）。
import type { BadgeId, StageId, TaskId } from './stages.ts'
import { truncateToWidth } from './width.ts'

/** tool.call 的輸入攤平後我們會讀的欄位。 */
export type ToolEvent = {
  tool: string
  agentId?: string
  command?: string
  skill?: string
  name?: string
  scriptPath?: string
  description?: string
  subagent_type?: string
  file_path?: string
}

export type Classification = {
  /** 權威轉換：覆蓋一切，並鎖住本 session 的推測。 */
  authority?: StageId
  /** 頭尾標記：/load 接手、/save 交接完成（不改階段）。 */
  handoff?: 'load' | 'save'
  /** 推測：只在本 session 尚無權威來源時才改階段。 */
  guess?: StageId
  badge?: BadgeId
  /** 已送出審查（submit 階段據此顯示 ⏸ 排審中）。 */
  submitted?: boolean
  /** 任務訊號：只在本 session 尚未宣告 task 時用來推斷任務。 */
  task?: TaskId
  /** 任務訊號強度（見 stages.ts 的 TASK_SIGNAL_RANK）。 */
  taskStrength?: 'strong' | 'weak'
  /** 主迴圈的動作（非唯讀 Bash、寫檔、Agent…）；讀取類與中性工具沒有這個標記。 */
  other?: boolean
  /** 寫了程式檔（非 .md）：任務仍未判定時預設 feature。 */
  codeWrite?: boolean
}

/** 權威轉換：skill／workflow 名 → 步驟（依目前任務查表，查不到就不改），可附帶任務。 */
const AUTHORITY: Readonly<Record<string, { stage: StageId; task?: TaskId }>> = {
  'ios-review': { stage: 'review' },
  'ios-sim-verify': { stage: 'verify' },
  'ios-to-tf': { stage: 'ship' },
  'ios-submit': { stage: 'submit' },
  'ios-diagnose': { stage: 'diagnose', task: 'bugfix' },
}

/** 只隱含任務、不指定步驟的 skill。 */
const TASK_SKILLS: Readonly<Record<string, TaskId>> = {
  'superpowers:systematic-debugging': 'bugfix',
  'superpowers:brainstorming': 'feature',
}

const READ_TOOLS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'ToolSearch', 'LS', 'NotebookRead'])
/** 不算讀取也不算其他動作的工具（互動、規劃、本身無訊號的 skill）。 */
const NEUTRAL_TOOLS: ReadonlySet<string> = new Set(['AskUserQuestion', 'TodoWrite', 'Skill', 'Workflow', 'SendMessage', 'TaskStop', 'Monitor'])
const READ_ONLY_BASH = /^\s*(ls|cat|head|tail|grep|rg|find|fd|wc|pwd|echo|which|file|stat|tree|du|jq|less|sed -n|git (status|log|diff|show|branch|blame|remote))\b/

const RE = {
  agentImpl: /^(M\d+ )?T\d+|Implement T\d+|Bank [A-Z]:/,
  agentReview: /Review (M\d+ )?T\d+|fresh review|Final whole-branch review|Independent review/,
  codexReviewWord: /審查|audit|review/i,
  verify: /xcodebuild\b.*\b(test|test-without-building|build-for-testing)\b|xcrun simctl|swiftlint|check-lint|check-warnings/,
  ship: /asc builds upload|asc publish testflight|asc xcode archive|agvtool/,
  ghIssue: /\bgh issue\b/,
  submit: /asc review|asc submit/,
  mutation: /scripts\/mutate\.sh/,
  merge: /\bgit (merge|push)\b/,
  upgrade: /upgrade[-_ ]?path|升級路徑/i,
} as const

const CODEX_RESCUE = 'codex:codex-rescue'

/** Skill 名 / Workflow name / scriptPath 檔名，去掉 plugin 前綴與副檔名。 */
function invokedName(e: ToolEvent): { full: string; base: string } | undefined {
  let raw: string | undefined
  if (e.tool === 'Skill') raw = e.skill
  else if (e.tool === 'Workflow') raw = e.name ?? e.scriptPath?.split('/').pop()?.replace(/\.[cm]?[jt]s$/, '')
  if (!raw) return undefined
  return { full: raw, base: raw.includes(':') ? raw.slice(raw.lastIndexOf(':') + 1) : raw }
}

/** 唯讀 Bash：每一段（| && ;）都以唯讀指令開頭，且沒有輸出重導。 */
export function isReadOnlyBash(command: string): boolean {
  if (/(^|[^0-9&])>(?!&)/.test(command)) return false
  return command
    .split(/\|\||&&|;|\|/)
    .map(p => p.trim())
    .filter(Boolean)
    .every(p => READ_ONLY_BASH.test(p))
}

export function classify(e: ToolEvent): Classification {
  const c: Classification = {}
  const main = !e.agentId
  const inv = invokedName(e)
  if (inv) {
    if (e.tool === 'Skill' && inv.full === 'load') c.handoff = 'load'
    else if (e.tool === 'Skill' && inv.full === 'save') c.handoff = 'save'
    const auth = AUTHORITY[inv.base]
    if (auth) {
      c.authority = auth.stage
      if (auth.task) {
        c.task = auth.task
        c.taskStrength = 'strong'
      }
    }
    const task = TASK_SKILLS[inv.full]
    if (task) {
      c.task = task
      c.taskStrength = 'strong'
    }
    if (inv.base === 'ios-diagnose' || inv.full === 'codex:rescue') c.badge = 'debug'
    return c
  }

  switch (e.tool) {
    case 'Write':
    case 'Edit':
    case 'NotebookEdit': {
      const path = e.file_path ?? ''
      if (path.includes('/specs/')) {
        c.guess = 'spec'
        c.task = 'feature'
        c.taskStrength = 'weak'
      }
      if (!/\.md$/i.test(path)) c.codeWrite = true
      if (main) c.other = true
      break
    }
    case 'Agent': {
      const d = e.description ?? ''
      if (RE.agentReview.test(d)) c.guess = 'review'
      else if (e.subagent_type === CODEX_RESCUE) {
        if (RE.codexReviewWord.test(d)) c.guess = 'review'
        else c.badge = 'debug'
      } else if (RE.agentImpl.test(d)) c.guess = 'impl'
      if (RE.upgrade.test(d)) c.badge = 'upgrade'
      if (main) c.other = true
      break
    }
    case 'Bash': {
      const cmd = e.command ?? ''
      // subagent 內的指令屬於該 subagent 的細節，不改階段、不計入任務推斷。
      if (main) {
        if (RE.submit.test(cmd)) {
          c.guess = 'submit'
          if (/asc submit/.test(cmd)) c.submitted = true
        } else if (RE.ship.test(cmd)) c.guess = 'ship'
        else if (RE.verify.test(cmd)) c.guess = 'verify'
        if (RE.ghIssue.test(cmd)) {
          c.task = 'bugfix'
          c.taskStrength = 'strong'
        }
        if (!isReadOnlyBash(cmd)) c.other = true
      }
      if (RE.mutation.test(cmd)) c.badge = 'mutation'
      else if (RE.merge.test(cmd)) c.badge = 'merge'
      else if (RE.upgrade.test(cmd)) c.badge = 'upgrade'
      break
    }
    case 'DesignSync':
      c.badge = 'design'
      if (main) c.other = true
      break
    default:
      if (main && !READ_TOOLS.has(e.tool) && !NEUTRAL_TOOLS.has(e.tool) && !e.tool.startsWith('mcp__')) c.other = true
  }
  return c
}

const COMMAND_MAX = 24
const AGENT_SHORT_MAX = 14

/** Bash 指令的簡短標籤：去掉 `cd … &&` 與環境變數前綴；xcodebuild 取其動作。 */
export function commandLabel(raw: string): string {
  // 多行指令壓成一行（避免撐出額外列）：續行 `\` 接起來；迴圈看整段，其餘只看第一行。
  const joined = raw.replace(/\\\n/g, ' ')
  const isLoop = /^\s*(for|while|until|if)\s/.test(joined)
  const command = (isLoop ? joined : joined.split('\n')[0] ?? '').replace(/\s+/g, ' ').trim()
  // for／while／until／if 迴圈：取關鍵字到第一個 ; 或 do 為止，比只取兩個字好認。
  if (isLoop) return truncateToWidth(command.split(/;|\bdo\b/)[0]!.trim(), COMMAND_MAX)
  const segs = command.split(/&&|;|\|\|/).map(s => s.trim()).filter(Boolean)
  const main = segs.find(s => !/^cd\s/.test(s)) ?? segs[0] ?? ''
  const words = main.split(/\s+/).filter(w => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w))
  const xb = main.match(/\bxcodebuild\b.*?\b(test-without-building|build-for-testing|test|build|archive)\b/)
  if (xb) return `xcodebuild ${xb[1]}`
  return truncateToWidth(words.slice(0, 2).join(' '), COMMAND_MAX)
}

/** subagent 簡稱：T3 impl / T2 review / Bank A，否則截短 description。 */
export function agentShortName(description: string, subagentType?: string): string {
  const t = description.match(/\bT\d+\b/)
  const isReview = RE.agentReview.test(description) || (subagentType === CODEX_RESCUE && RE.codexReviewWord.test(description))
  if (t) return `${t[0]} ${isReview ? 'review' : 'impl'}`
  const bank = description.match(/Bank [A-Z]/)
  if (bank) return bank[0]
  return truncateToWidth(description.replace(/\s+/g, ' ').trim(), AGENT_SHORT_MAX)
}

/** 進行中工具呼叫的標籤。 */
export function callLabel(e: ToolEvent): string {
  if (e.tool === 'Bash') return commandLabel(e.command ?? '')
  const inv = invokedName(e)
  if (inv) return e.tool === 'Skill' ? `/${inv.full}` : `workflow ${inv.base}`
  return e.tool.startsWith('mcp__') ? e.tool.split('__').pop() ?? e.tool : e.tool
}
