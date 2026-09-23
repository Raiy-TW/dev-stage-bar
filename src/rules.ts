// 工具呼叫 → 階段訊號的判斷規則（純函式，無 $）。
import type { BadgeId, StageId } from './stages.ts'
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
}

const AUTHORITY: Readonly<Record<string, StageId>> = {
  'ios-review': 'review',
  'ios-sim-verify': 'verify',
  'ios-to-tf': 'tf',
  'ios-submit': 'submit',
}

const RE = {
  agentImpl: /^(M\d+ )?T\d+|Implement T\d+|Bank [A-Z]:/,
  agentReview: /Review (M\d+ )?T\d+|fresh review|Final whole-branch review|Independent review/,
  codexReviewWord: /審查|audit|review/i,
  verify: /xcodebuild\b.*\b(test|test-without-building|build-for-testing)\b|xcrun simctl|swiftlint|check-lint|check-warnings/,
  tf: /asc builds upload|asc publish testflight|asc xcode archive|agvtool/,
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

export function classify(e: ToolEvent): Classification {
  const c: Classification = {}
  const inv = invokedName(e)
  if (inv) {
    if (e.tool === 'Skill' && inv.full === 'load') c.handoff = 'load'
    else if (e.tool === 'Skill' && inv.full === 'save') c.handoff = 'save'
    const stage = AUTHORITY[inv.base]
    if (stage) c.authority = stage
    if (inv.base === 'ios-diagnose' || inv.full === 'codex:rescue') c.badge = 'debug'
    return c
  }

  switch (e.tool) {
    case 'Write':
    case 'Edit':
      if (e.file_path?.includes('/specs/')) c.guess = 'spec'
      break
    case 'Agent': {
      const d = e.description ?? ''
      if (RE.agentReview.test(d)) c.guess = 'review'
      else if (e.subagent_type === CODEX_RESCUE) {
        if (RE.codexReviewWord.test(d)) c.guess = 'review'
        else c.badge = 'debug'
      } else if (RE.agentImpl.test(d)) c.guess = 'impl'
      if (RE.upgrade.test(d)) c.badge = 'upgrade'
      break
    }
    case 'Bash': {
      const cmd = e.command ?? ''
      // subagent 內的指令屬於該 subagent 的細節，不改階段。
      if (!e.agentId) {
        if (RE.submit.test(cmd)) {
          c.guess = 'submit'
          if (/asc submit/.test(cmd)) c.submitted = true
        } else if (RE.tf.test(cmd)) c.guess = 'tf'
        else if (RE.verify.test(cmd)) c.guess = 'verify'
      }
      if (RE.mutation.test(cmd)) c.badge = 'mutation'
      else if (RE.merge.test(cmd)) c.badge = 'merge'
      else if (RE.upgrade.test(cmd)) c.badge = 'upgrade'
      break
    }
    case 'DesignSync':
      c.badge = 'design'
      break
  }
  return c
}

const COMMAND_MAX = 24
const AGENT_SHORT_MAX = 14

/** Bash 指令的簡短標籤：去掉 `cd … &&` 與環境變數前綴；xcodebuild 取其動作。 */
export function commandLabel(command: string): string {
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
  return truncateToWidth(description, AGENT_SHORT_MAX)
}

/** 進行中工具呼叫的標籤。 */
export function callLabel(e: ToolEvent): string {
  if (e.tool === 'Bash') return commandLabel(e.command ?? '')
  const inv = invokedName(e)
  if (inv) return e.tool === 'Skill' ? `/${inv.full}` : `workflow ${inv.base}`
  return e.tool.startsWith('mcp__') ? e.tool.split('__').pop() ?? e.tool : e.tool
}
