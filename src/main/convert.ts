// Turns Claude Code transcript and SDK messages into the small, display-ready items the UI renders.
// Attached images stay in the main process (images.ts); the renderer gets thumbnails and a reference.

import type { ChatAuthor, ChatContext, ChatContextText, ChatItem, ImagePreview } from '@shared/types'
import { keepImage } from './images'

const MAX_RESULT = 8000
const MAX_DETAIL = 8000
const MAX_DIFF = 12000

type Json = Record<string, unknown>

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n\n(${(text.length - max).toLocaleString()} more characters not shown)`
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function firstLine(text: string, max = 160): string {
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? ''
  return line.length > max ? `${line.slice(0, max)}…` : line
}

function pretty(input: unknown): string {
  try {
    return truncate(JSON.stringify(input, null, 2), MAX_DETAIL)
  } catch {
    return ''
  }
}

export interface ToolView {
  summary: string
  detail?: string
  diff?: { before: string; after: string }
  filePath?: string
}

export function describeTool(name: string, raw: unknown): ToolView {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Json
  const path = str(input.file_path) || str(input.notebook_path) || str(input.path)
  switch (name) {
    case 'Bash':
    case 'PowerShell': {
      const cmd = str(input.command)
      const desc = str(input.description)
      return { summary: desc || firstLine(cmd), detail: truncate(cmd, MAX_DETAIL) }
    }
    case 'Read':
      return { summary: path, filePath: path }
    case 'Write':
      return { summary: path, filePath: path, detail: truncate(str(input.content), MAX_DETAIL) }
    case 'Edit':
      return {
        summary: path,
        filePath: path,
        diff: { before: truncate(str(input.old_string), MAX_DIFF), after: truncate(str(input.new_string), MAX_DIFF) }
      }
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? (input.edits as Json[]) : []
      return {
        summary: `${path} (${edits.length} edits)`,
        filePath: path,
        diff: {
          before: truncate(edits.map((e) => str(e.old_string)).join('\n…\n'), MAX_DIFF),
          after: truncate(edits.map((e) => str(e.new_string)).join('\n…\n'), MAX_DIFF)
        }
      }
    }
    case 'NotebookEdit':
      return { summary: path, filePath: path, detail: truncate(str(input.new_source), MAX_DETAIL) }
    case 'Glob':
      return { summary: [str(input.pattern), str(input.path)].filter(Boolean).join(' in ') }
    case 'Grep':
      return { summary: [str(input.pattern), str(input.path) || str(input.glob)].filter(Boolean).join(' in ') }
    case 'WebFetch':
      return { summary: str(input.url), detail: str(input.prompt) }
    case 'WebSearch':
      return { summary: str(input.query) }
    case 'Agent':
    case 'Task':
      return { summary: str(input.description) || str(input.subagent_type), detail: truncate(str(input.prompt), MAX_DETAIL) }
    case 'TodoWrite': {
      const todos = Array.isArray(input.todos) ? (input.todos as Json[]) : []
      const done = todos.filter((t) => t.status === 'completed').length
      return {
        summary: `${done} of ${todos.length} done`,
        detail: todos.map((t) => `${t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]'} ${str(t.content)}`).join('\n')
      }
    }
    case 'Skill':
      return { summary: str(input.skill) || str(input.command) }
    case 'ExitPlanMode':
      return { summary: 'Plan ready for review', detail: truncate(str(input.plan), MAX_DETAIL) }
    case 'AskUserQuestion': {
      const qs = Array.isArray(input.questions) ? (input.questions as Json[]) : []
      return { summary: qs.map((q) => str(q.question)).join(' / ') }
    }
    // Loom's own tools: the command is what matters, as with Bash.
    case 'mcp__loom__start_dev_server': {
      const cmd = str(input.command)
      const cwd = str(input.cwd)
      return { summary: cmd, detail: cwd ? `${cmd}
in ${cwd}` : cmd }
    }
    case 'mcp__loom__stop_dev_server':
    case 'mcp__loom__dev_server_output':
      return { summary: serverName(str(input.id)) }
    case 'mcp__loom__list_dev_servers':
      return { summary: '' }
    default: {
      if (name.startsWith('mcp__')) {
        const [, server, tool] = name.split('__')
        return { summary: `${server}: ${tool}`, detail: pretty(input) }
      }
      const firstString = Object.values(input).find((v) => typeof v === 'string') as string | undefined
      return { summary: firstLine(firstString ?? ''), detail: pretty(input) }
    }
  }
}

/** A server's id is "<project>|<folder>#<script>": the part after the bar says which one. */
function serverName(id: string): string {
  return id.slice(id.indexOf('|') + 1)
}

export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return truncate(content, MAX_RESULT)
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content as Json[]) {
    if (block.type === 'text') parts.push(str(block.text))
    else if (block.type === 'image') parts.push('[image]')
    else if (block.type === 'document') parts.push('[document]')
  }
  return truncate(parts.join('\n'), MAX_RESULT)
}

const SUMMARY_PREFIXES = [
  'This session is being continued from a previous conversation',
  'This conversation was compacted'
]

/** What Claude Code writes in place of a message when a turn was stopped. */
const INTERRUPTED = /^\[Request interrupted by user[^\]]*\]$/

/**
 * Text Claude Code or an editor adds around what the person typed: reminders, and the file or
 * selection VS Code sends along (ide_opened_file, ide_selection, ide_diagnostics).
 */
/**
 * What "Send to background" adds to a message, for Claude: hand the job to a background agent and
 * stay free. It goes at the end in its own tag, so the chat (and the history read back) shows only
 * the person's words, marked as sent to the background.
 */
const BACKGROUND_TAG = 'loom-background'
export const BACKGROUND_ASK = [
  `<${BACKGROUND_TAG}>`,
  'The person sent this from Loom with "Send to background", so the chat stays free while the work runs.',
  'Do not do the work in this turn. Start one background agent (the Agent tool with run_in_background set to true) and give it the whole task above, with everything it needs to know from this conversation.',
  'Then say in one short sentence that it is running, and end your turn so the person can keep talking with you.',
  'When the agent reports back, carry on from its result: check it, finish anything left, and tell the person what was done.',
  `</${BACKGROUND_TAG}>`
].join('\n')
const BACKGROUND_END = new RegExp(`\\s*<${BACKGROUND_TAG}>[\\s\\S]*?</${BACKGROUND_TAG}>\\s*$`)

/**
 * Another chat brought into a message as background goes in front of the person's words, each in
 * its own tag with the chat's name, and each as a part of its own: Claude Code names and lists a
 * chat by the first part of its first message that does not open with a tag, so the person's
 * words must not share a part with the notes. The chat (and the history read back) shows only the
 * person's words, with the names of the chats that came along.
 */
const CONTEXT_TAG = 'loom-context'
const CONTEXT_START = new RegExp(`^\\s*<${CONTEXT_TAG}((?:\\s+[a-z]+="[^"]*")*)\\s*>[\\s\\S]*?</${CONTEXT_TAG}>\\s*`)

const attr = (text: string): string => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\s+/g, ' ').trim()
const unattr = (text: string): string => text.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/** The chats brought in, as Claude gets them: a part for each, ahead of what the person wrote. */
export function contextParts(context: ChatContextText[]): string[] {
  return context
    .filter((c) => c.text.trim())
    .map((c) =>
      [
        `<${CONTEXT_TAG} title="${attr(c.title)}"${c.from ? ` from="${attr(c.from)}"` : ''}>`,
        c.from
          ? `The person brought this in from Loom as background for their message below: notes on another conversation about this project, named "${c.title}", which ${c.from} had with Claude on their own computer.`
          : `The person brought this in from Loom as background for their message below: notes on another conversation of theirs with Claude about this project, named "${c.title}".`,
        c.from
          ? `You were not part of that conversation, and what was changed in it was changed in ${c.from}'s copy of the project: check the files here as they are now before relying on the notes.`
          : 'You were not part of that conversation: where the notes say files were changed, check them as they are now before relying on that.',
        '',
        // The summary cannot close its own tag.
        c.text.trim().split(`</${CONTEXT_TAG}>`).join(''),
        `</${CONTEXT_TAG}>`
      ].join('\n')
    )
}

/**
 * In a chat that members of a team take turns in, each message says who wrote it: a part of its
 * own ahead of the person's words, like the chats brought in. Claude reads it too, so it knows
 * more than one person is talking; the chat shows the name beside the message.
 */
const AUTHOR_TAG = 'loom-author'
const AUTHOR_START = new RegExp(`^\\s*<${AUTHOR_TAG}((?:\\s+[a-z]+="[^"]*")*)\\s*>[\\s\\S]*?</${AUTHOR_TAG}>\\s*`)

/** Who wrote a message, as Claude gets it. */
export function authorPart(author: ChatAuthor): string {
  return [
    `<${AUTHOR_TAG}${author.id ? ` id="${attr(author.id)}"` : ''} name="${attr(author.name)}">`,
    `This message is from ${author.name}. More than one person writes in this conversation through Loom, taking turns, each on their own computer with their own copy of the project.`,
    `</${AUTHOR_TAG}>`
  ].join('\n')
}

/** Takes what Loom put in front of a message off it: who wrote it, the chats brought in. What is left is the person's words. */
function takeLead(raw: string): { rest: string; context: ChatContext[]; author?: ChatAuthor } {
  const context: ChatContext[] = []
  let author: ChatAuthor | undefined
  let rest = raw
  for (;;) {
    const a = rest.match(AUTHOR_START)
    if (a) {
      const id = a[1].match(/\sid="([^"]*)"/)?.[1]
      const name = a[1].match(/\sname="([^"]*)"/)?.[1]
      author = { name: name ? unattr(name) : 'A teammate', ...(id ? { id: unattr(id) } : {}) }
      rest = rest.slice(a[0].length)
      continue
    }
    const m = rest.match(CONTEXT_START)
    if (!m) break
    const title = m[1].match(/\stitle="([^"]*)"/)?.[1]
    const from = m[1].match(/\sfrom="([^"]*)"/)?.[1]
    context.push({ title: title ? unattr(title) : 'Another chat', ...(from ? { from: unattr(from) } : {}) })
    rest = rest.slice(m[0].length)
  }
  return { rest, context, author }
}

function stripTags(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<(ide_[a-z_]+)>[\s\S]*?<\/\1>/g, '')
    .replace(/<artifact-content-authored-by-others\/>/g, '')
    .trim()
}

/** "claude-fable-5-2" as "Fable 5.2", "claude-haiku-4-5-20251001" as "Haiku 4.5". */
export function prettyModel(id: string): string {
  const parts = id.replace(/^claude-/, '').replace(/\[.*\]$/, '').replace(/-\d{8}$/, '').split('-')
  const name = parts.find((p) => /[a-z]/i.test(p))
  if (!name) return id
  const version = parts.filter((p) => /^\d+$/.test(p)).join('.')
  return `${name[0].toUpperCase()}${name.slice(1)}${version ? ` ${version}` : ''}`
}

/** The model a saved or live assistant message came from, when it is a real Claude model. */
export function messageModel(message: unknown): string | null {
  const model = (message as { model?: unknown } | null)?.model
  return typeof model === 'string' && model.startsWith('claude-') ? model : null
}

/** Replies now come from another model: from which to which, when the one before is known. */
export function modelNote(model: string, id: string, before?: string): ChatItem {
  const text = before ? `Switched from ${prettyModel(before)} to ${prettyModel(model)}` : `Switched to ${prettyModel(model)}`
  return { kind: 'note', id: `model:${id}`, tone: 'info', text }
}

function tagValue(text: string, tag: string): string {
  return text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim() ?? ''
}

/** A user-side text turn: the person's prompt, or something Claude Code injected in their place. */
export function userTextItem(
  text: string,
  id: string,
  images: number,
  ts?: string,
  synthetic = false,
  previews: ImagePreview[] = []
): ChatItem | null {
  const raw = text.trim()
  if (!raw && !images) return null
  // Markers count only where Claude Code puts them, at the start: a message that merely
  // mentions one (quoting a log, say) is still the person's message.
  const lead = stripTags(raw)
  if (SUMMARY_PREFIXES.some((p) => lead.startsWith(p))) {
    return { kind: 'note', id, tone: 'summary', text: 'Earlier messages were summarized', detail: truncate(lead, 40000) }
  }
  if (INTERRUPTED.test(lead)) return { kind: 'note', id, tone: 'info', text: 'Interrupted' }
  if (/^<command-(name|message|args)>/.test(raw)) {
    const name = tagValue(raw, 'command-name')
    const args = tagValue(raw, 'command-args')
    return { kind: 'user', id, text: `${name.startsWith('/') ? name : `/${name}`}${args ? ` ${args}` : ''}`, images: 0, ts }
  }
  if (raw.startsWith('<local-command-stdout>') || raw.startsWith('<local-command-stderr>')) {
    const out = tagValue(raw, 'local-command-stdout') || tagValue(raw, 'local-command-stderr')
    return out ? { kind: 'note', id, tone: 'info', text: firstLine(out, 200), detail: truncate(out, MAX_RESULT) } : null
  }
  if (raw.startsWith('<local-command-caveat>')) return null
  if (raw.startsWith('<task-notification>')) {
    const summary = tagValue(raw, 'summary') || 'A background task finished'
    return { kind: 'note', id, tone: 'info', text: firstLine(summary, 200) }
  }
  const { rest, context, author } = takeLead(raw)
  const background = BACKGROUND_END.test(rest)
  const clean = stripTags(background ? rest.replace(BACKGROUND_END, '') : rest)
  if (!clean && !images && !context.length) return null
  if (synthetic) return { kind: 'note', id, tone: 'info', text: firstLine(clean, 200), detail: truncate(clean, MAX_RESULT) }
  return {
    kind: 'user',
    id,
    text: clean,
    images,
    previews: previews.length ? previews : undefined,
    ts,
    ...(background ? { background: true } : {}),
    ...(context.length ? { context } : {}),
    ...(author ? { author } : {})
  }
}

export interface ToolResultUpdate {
  toolUseId: string
  result: string
  isError: boolean
}

/** Splits user content into a visible text item (if any) and tool results. */
export function parseUserContent(
  content: unknown,
  id: string,
  ts?: string,
  synthetic = false
): { item: ChatItem | null; results: ToolResultUpdate[] } {
  if (typeof content === 'string') return { item: userTextItem(content, id, 0, ts, synthetic), results: [] }
  if (!Array.isArray(content)) return { item: null, results: [] }
  const texts: string[] = []
  let images = 0
  const previews: ImagePreview[] = []
  const results: ToolResultUpdate[] = []
  for (const block of content as Json[]) {
    if (block.type === 'text') texts.push(str(block.text))
    else if (block.type === 'image') {
      images++
      const src = (block.source ?? {}) as Json
      if (src.type === 'base64' && typeof src.data === 'string') {
        previews.push({ thumb: null, ref: keepImage(str(src.media_type) || 'image/png', src.data) })
      }
    } else if (block.type === 'document') images++
    else if (block.type === 'tool_result') {
      results.push({ toolUseId: str(block.tool_use_id), result: toolResultText(block.content), isError: block.is_error === true })
    }
  }
  const item = texts.length || (images && !results.length) ? userTextItem(texts.join('\n\n'), id, images, ts, synthetic, previews) : null
  return { item, results }
}

/** Assistant content blocks to display items. */
export function assistantItems(content: unknown, idBase: string, ts?: string): ChatItem[] {
  if (!Array.isArray(content)) return []
  const items: ChatItem[] = []
  ;(content as Json[]).forEach((block, i) => {
    if (block.type === 'text') {
      const text = str(block.text)
      if (text.trim()) items.push({ kind: 'assistant', id: `${idBase}:${i}`, text, ts })
    } else if (block.type === 'thinking') {
      const text = str(block.thinking)
      if (text.trim()) items.push({ kind: 'thinking', id: `${idBase}:${i}`, text: truncate(text, MAX_DETAIL), ts })
    } else if (block.type === 'tool_use') {
      const name = str(block.name)
      const view = describeTool(name, block.input)
      items.push({ kind: 'tool', id: str(block.id) || `${idBase}:${i}`, name, status: 'running', ...view, ts })
    }
  })
  return items
}

interface HistoryMessage {
  type: string
  uuid: string
  message?: unknown
  parent_tool_use_id: string | null
  timestamp?: string
  origin?: { kind?: string }
}

/**
 * Converts a saved conversation (SDK getSessionMessages output) into display items. Every saved
 * step has a timestamp, which gives the timings: thinking ran from the previous step to the
 * thought, a tool from its call to its result, a turn from the prompt to its last step.
 */
export function historyToItems(messages: HistoryMessage[]): ChatItem[] {
  const items: ChatItem[] = []
  const tools = new Map<string, Extract<ChatItem, { kind: 'tool' }>>()
  const toolStart = new Map<string, number>()
  let prev = NaN
  let turnStart = NaN
  let turnEnd = NaN
  let model = ''
  const endTurn = (): void => {
    if (turnEnd - turnStart >= 1000) {
      items.push({ kind: 'done', id: `done:${turnStart}`, ms: turnEnd - turnStart, ts: new Date(turnEnd).toISOString() })
    }
    turnStart = NaN
    turnEnd = NaN
  }
  for (const m of messages) {
    if (m.parent_tool_use_id) continue
    const msg = (m.message ?? {}) as Json
    const at = m.timestamp ? Date.parse(m.timestamp) : NaN
    if (m.type === 'assistant') {
      // A reply from another model than the one before: say so above it.
      const from = messageModel(msg)
      if (from) {
        if (model && from !== model) items.push({ ...modelNote(from, m.uuid, model), ts: m.timestamp })
        model = from
      }
      for (const item of assistantItems(msg.content, m.uuid, m.timestamp)) {
        if (item.kind === 'thinking' && at - prev > 0) item.ms = at - prev
        if (item.kind === 'tool') {
          item.status = 'done'
          tools.set(item.id, item)
          if (!Number.isNaN(at)) toolStart.set(item.id, at)
        }
        items.push(item)
      }
    } else if (m.type === 'user') {
      const synthetic = !!m.origin?.kind && m.origin.kind !== 'human'
      const { item, results } = parseUserContent(msg.content, m.uuid, m.timestamp, synthetic)
      for (const r of results) {
        const tool = tools.get(r.toolUseId)
        if (tool) {
          tool.result = r.result
          tool.isError = r.isError
          tool.status = r.isError ? 'error' : 'done'
          const start = toolStart.get(r.toolUseId)
          if (start !== undefined && at - start >= 0) tool.ms = at - start
        }
      }
      if (item?.kind === 'user') {
        endTurn()
        turnStart = at
      }
      // Notes made from user-side messages (Interrupted, a command's output) keep their time too.
      if (item) items.push(item.ts || !m.timestamp ? item : { ...item, ts: m.timestamp })
    }
    if (!Number.isNaN(at)) {
      prev = at
      if (!Number.isNaN(turnStart)) turnEnd = at
    }
  }
  endTurn()
  return items
}
