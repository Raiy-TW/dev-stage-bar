// 使用者 prompt 的意圖（純函式、純本地規則，不呼叫模型）。關鍵字資料在 stages.ts 的 PROMPT_INTENT。
import { PROMPT_INTENT, type StageId, type TaskId } from './stages.ts'

export type PromptIntent = 'chat' | { task: TaskId; stage: StageId } | undefined

const ASCII_WORD = /^[A-Za-z]+$/
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 中文關鍵字：子字串；英文：單字邊界、不分大小寫。 */
function hits(text: string, keyword: string): boolean {
  if (ASCII_WORD.test(keyword)) return new RegExp(`(^|[^A-Za-z])${escape(keyword)}([^A-Za-z]|$)`, 'i').test(text)
  return text.includes(keyword)
}

/** 去掉標點與空白後的字串（判斷「繼續」「OK!」這類接續語）。 */
const bare = (text: string): string => text.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()

export function classifyPrompt(raw: string): PromptIntent {
  const trimmed = raw.trim()
  if (!trimmed || trimmed.startsWith('/')) return undefined
  const core = bare(trimmed)
  if (core.length <= PROMPT_INTENT.shortMax || (PROMPT_INTENT.continuation as readonly string[]).includes(core)) return undefined
  const text = Object.entries(PROMPT_INTENT.neutralize).reduce((t, [from, to]) => t.split(from).join(to), trimmed)
  for (const rule of PROMPT_INTENT.rules) {
    if (rule.keywords.some(k => hits(text, k))) return { task: rule.task, stage: rule.stage }
  }
  const { endings, keywords } = PROMPT_INTENT.chat
  if (endings.some(e => text.endsWith(e)) || keywords.some(k => hits(text, k))) return 'chat'
  return undefined
}
