// The chat recycle bin. Deleting a chat in Loom moves it here, out of Claude Code's own folders:
// its history file, the folder beside it (its agents' histories, long tool output) and a note of
// where it came from. Nothing is gone for good until it is deleted from the bin.

import { existsSync, promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { TrashedChat } from '@shared/types'
import { forgetSession, listAllSessions, sessionInUse, transcriptIndex } from './claude'

const TRASH = join(homedir(), '.claude', 'chat-trash')
const PROJECTS = join(homedir(), '.claude', 'projects')
/** Chats are named by a UUID; nothing else is ever taken as a folder name here. */
const ID = /^[0-9a-f-]{36}$/i

interface Info {
  sessionId: string
  title: string
  cwd: string
  /** The folder under .claude/projects it was in, and goes back to */
  dir: string
  deletedAt: number
  lastModified?: number
}

type Result = { ok: boolean; error?: string }

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Moves a file or a folder. Claude Code may still be letting go of a chat that has just closed, so
 * a busy file is tried again a few times; across drives it is copied, then removed.
 */
async function move(from: string, to: string): Promise<void> {
  for (let tries = 0; ; tries++) {
    try {
      await fsp.rename(from, to)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'EXDEV') break
      if (tries >= 4 || (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES')) throw e
      await wait(200)
    }
  }
  await fsp.cp(from, to, { recursive: true, preserveTimestamps: true })
  await fsp.rm(from, { recursive: true, force: true })
}

async function readInfo(home: string): Promise<Info | null> {
  try {
    const info = JSON.parse(await fsp.readFile(join(home, 'info.json'), 'utf8')) as Info
    // The folder to go back to is a plain name under .claude/projects, never a path.
    if (typeof info.dir !== 'string' || !info.dir || basename(info.dir) !== info.dir || info.dir === '..' || info.dir === '.') return null
    return info
  } catch {
    return null
  }
}

/** Moves a chat to the bin. The chat must not be open: its tab closes first. */
export async function trashChat(sessionId: string, title?: string): Promise<Result> {
  if (!ID.test(sessionId)) return { ok: false, error: 'That is not a chat.' }
  if (sessionInUse(sessionId)) return { ok: false, error: 'This chat is still open. Close its tab, then delete it.' }
  const src = (await transcriptIndex()).get(sessionId)
  if (!src) return { ok: false, error: "This chat's history file was not found." }
  const known = (await listAllSessions().catch(() => [])).find((s) => s.sessionId === sessionId)
  const home = join(TRASH, sessionId)
  const side = join(dirname(src), sessionId)
  try {
    // Anything an earlier, failed try left here would be in the way.
    await fsp.rm(home, { recursive: true, force: true })
    await fsp.mkdir(home, { recursive: true })
    const stat = await fsp.stat(src)
    const info: Info = {
      sessionId,
      title: (title || known?.title || 'Untitled chat').trim(),
      cwd: known?.cwd ?? '',
      dir: basename(dirname(src)),
      deletedAt: Date.now(),
      lastModified: stat.mtimeMs
    }
    await fsp.writeFile(join(home, 'info.json'), JSON.stringify(info, null, 2), 'utf8')
    await move(src, join(home, 'chat.jsonl'))
  } catch (e) {
    await fsp.rm(home, { recursive: true, force: true }).catch(() => undefined)
    return { ok: false, error: `The chat could not be moved to the recycle bin: ${(e as Error).message}` }
  }
  // The history is in the bin, so the chat is deleted. What sat beside it follows; if that fails
  // it stays where it was, and goes back to use when the chat is restored.
  if (existsSync(side)) await move(side, join(home, 'files')).catch((e) => console.error('[trash] the folder beside the chat stays', e))
  forgetSession(sessionId)
  return { ok: true }
}

/** Puts a chat back where it was: in its project, in the sidebar and in Claude Code's own list. */
export async function restoreChat(sessionId: string): Promise<Result> {
  if (!ID.test(sessionId)) return { ok: false, error: 'That is not a chat.' }
  const home = join(TRASH, sessionId)
  const info = await readInfo(home)
  if (!info || !existsSync(join(home, 'chat.jsonl'))) return { ok: false, error: 'That chat is no longer in the recycle bin.' }
  const destDir = join(PROJECTS, info.dir)
  const dest = join(destDir, `${sessionId}.jsonl`)
  if (existsSync(dest)) return { ok: false, error: 'A chat with this id is already in that project.' }
  try {
    await fsp.mkdir(destDir, { recursive: true })
    await move(join(home, 'chat.jsonl'), dest)
  } catch (e) {
    return { ok: false, error: `The chat could not be put back: ${(e as Error).message}` }
  }
  const files = join(home, 'files')
  const side = join(destDir, sessionId)
  if (existsSync(files) && !existsSync(side)) await move(files, side).catch((e) => console.error('[trash] the folder beside the chat was not put back', e))
  await fsp.rm(home, { recursive: true, force: true }).catch(() => undefined)
  forgetSession(sessionId)
  return { ok: true }
}

/** What is in the bin, most recently deleted first. */
export async function listTrash(): Promise<TrashedChat[]> {
  let names: string[]
  try {
    names = await fsp.readdir(TRASH)
  } catch {
    return []
  }
  const list = await Promise.all(
    names
      .filter((n) => ID.test(n))
      .map(async (sessionId): Promise<TrashedChat | null> => {
        const home = join(TRASH, sessionId)
        try {
          const stat = await fsp.stat(join(home, 'chat.jsonl'))
          const info = await readInfo(home)
          return {
            sessionId,
            title: info?.title || 'Untitled chat',
            cwd: info?.cwd ?? '',
            deletedAt: info?.deletedAt ?? stat.mtimeMs,
            lastModified: info?.lastModified ?? stat.mtimeMs,
            size: stat.size,
            // Without the note of where it came from, it can only be deleted.
            restorable: !!info
          }
        } catch {
          return null
        }
      })
  )
  return list.filter((x): x is TrashedChat => !!x).sort((a, b) => b.deletedAt - a.deletedAt)
}

/** Deletes chats in the bin for good; `all` empties it. Returns how many could not be deleted. */
export async function purgeTrash(ids: string[] | 'all'): Promise<{ failed: number }> {
  const names = ids === 'all' ? (await listTrash()).map((x) => x.sessionId) : ids.filter((id) => ID.test(id))
  let failed = 0
  for (const id of names) {
    try {
      await fsp.rm(join(TRASH, id), { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
    } catch (e) {
      failed++
      console.error('[trash] could not delete', id, e)
    }
  }
  return { failed }
}
