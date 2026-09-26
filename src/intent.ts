// 使用者 prompt 的意圖（純函式、純本地規則，不呼叫模型）。關鍵字與判斷順序見 stages.ts 的 PROMPT_INTENT。
import { PROMPT_INTENT, type StageId, type TaskId } from './stages.ts'

export type PromptIntent = 'chat' | { task: TaskId; stage: StageId } | undefined

const P = PROMPT_INTENT
const ASCII = /^[A-Za-z' ]+$/
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** 英文字尾變化：crash → crashes、fail → failing、bug → bugs。 */
const SUFFIX = '(?:s|es|ed|ing)?'
/** slash command 的第一個詞：/save、/ios-review、/codex:rescue（路徑 /Users/… 不算）。 */
const SLASH_COMMAND = /^\/[A-Za-z][\w:-]*$/

function pattern(keyword: string, anchored: boolean): RegExp {
  if (ASCII.test(keyword)) return new RegExp(`${anchored ? '^' : '(?:^|[^A-Za-z])'}${escape(keyword)}${SUFFIX}(?![A-Za-z])`, 'i')
  return new RegExp(`${anchored ? '^' : ''}${escape(keyword)}`)
}

const hitsAny = (text: string, keywords: readonly string[]): boolean => keywords.some(k => pattern(k, false).test(text))
const startsWithAny = (text: string, keywords: readonly string[]): boolean => keywords.some(k => pattern(k, true).test(text))

/** 去掉標點與空白後的字串（判斷「繼續」「OK!」這類接續語）。 */
const bare = (text: string): string => text.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()

/** 只看第一行（先拿掉 ``` code block）的前 maxChars 字：貼上的 log、程式碼不算。 */
function firstLine(raw: string): string {
  const withoutCode = raw.replace(/```[\s\S]*?(?:```|$)/g, '\n')
  const line = withoutCode.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? ''
  return line.slice(0, P.maxChars)
}

const intentOf = (task: TaskId): PromptIntent => ({ task, stage: P.stages[task as keyof typeof P.stages] })

export function classifyPrompt(raw: string): PromptIntent {
  const line = firstLine(raw)
  if (!line || SLASH_COMMAND.test(line.split(/\s+/)[0] ?? '')) return undefined
  const core = bare(line)
  if (core.length <= P.shortMax || (P.continuation as readonly string[]).includes(core)) return undefined
  const text = Object.entries(P.neutralize).reduce((t, [from, to]) => t.split(from).join(to), line)

  if (hitsAny(text, P.symptoms)) return intentOf('bugfix')
  if (P.chat.endings.some(e => text.endsWith(e)) || hitsAny(text, P.chat.keywords)) return 'chat'
  const imperative = hitsAny(text, P.imperatives) || startsWithAny(text, [...P.feature, ...P.work])
  if (imperative && hitsAny(text, P.feature)) return intentOf('feature')
  if (hitsAny(text, P.bugGeneric)) return intentOf('bugfix')
  if (imperative && hitsAny(text, P.work)) return intentOf('work')
  return undefined
}
