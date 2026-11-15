// Teams, on this PC: the connection to each team's room, who is in it, what this PC shares, and
// the copying of chat histories between members. See src/shared/team.ts for what is said and why.
//
// A chat in a team has one writer at a time, the member holding its pen. Only the writer's Loom
// runs Claude in it and adds to its history; everyone else's copy follows. The writer says which
// chats it holds ("chats"), hands out their history on request ("want" and "data") and keeps
// sending as they grow, and passes the pen to whoever asks while the chat is at rest.

import { app, BrowserWindow, ipcMain, safeStorage } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, promises as fs, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  aesKey,
  b64u,
  checkCode,
  deviceKeyBytes,
  ID_PATTERN,
  keyPair,
  pairingId,
  pairingKey,
  publicKey,
  randomBytes,
  randomId,
  REMOTE_ADDRESS,
  seal,
  SECRET_BYTES,
  unb64u,
  unseal,
  type KeyPair
} from '@shared/remote'
import {
  INVITE_MS,
  inviteUrl,
  joinContext,
  MAX_TEAM_MEMBERS,
  parseInvite,
  PIECE_BYTES,
  projectKey,
  TEAM_VERSION,
  teamContext,
  type JoinDown,
  type JoinUp,
  type TeamChat,
  type TeamChatEntry,
  type TeamEnvelope,
  type TeamJoining,
  type TeamLocal,
  type TeamMember,
  type TeamMsg,
  type TeamRepo,
  type TeamsState,
  type TeamStatus,
  type TeamSync,
  type Welcome
} from '@shared/team'
import type { ChatEvent } from '@shared/types'
import { forgetSession, listAllSessions, modelOfSession, projectDirName, releaseSession, sessionState, tapChats, transcriptIndex } from './claude'
import { gitStatus } from './files'

interface Deps {
  projects: () => { id: string; name: string; path: string }[]
}

interface TeamCfg {
  id: string
  name: string
  /** The team's key, and the key this PC signs in to the room with */
  key: string
  auth: string
  me: string
  members: TeamMember[]
  rev: number
  projects: string[]
}

interface SavedFile {
  v: 1
  name: string
  teams: Omit<TeamCfg, 'key' | 'auth'>[]
  private: string[]
  secrets: string
  protected: boolean
}

interface JoinRequest {
  conn: string
  id: string
  name: string
  auth: string
  code: string
  raw: Uint8Array<ArrayBuffer>
  pub: string
  pairId: string
  key: CryptoKey
}

interface Link {
  cfg: TeamCfg
  ws: WebSocket | null
  relay: TeamStatus['relay']
  error?: string
  retry: ReturnType<typeof setTimeout> | null
  attempts: number
  beat: ReturnType<typeof setInterval> | null
  pongDue: ReturnType<typeof setTimeout> | null
  key: Promise<CryptoKey>
  sid: string
  n: number
  out: Promise<void>
  inbox: Promise<void>
  online: Set<string>
  /** The last message taken from each member's connection */
  seen: Map<string, { sid: string; n: number }>
  /** What each member says it holds, by project */
  theirs: Map<string, Map<string, { chats: TeamChat[]; repo: TeamRepo | null }>>
  invite: { id: string; secret: Uint8Array<ArrayBuffer>; url: string; expiresAt: number; fails: number; timer: ReturnType<typeof setTimeout> } | null
  requests: Map<string, JoinRequest>
  /** Members following chats this PC holds: for each chat, how far each has been sent */
  followers: Map<string, Map<string, Follower>>
}

/** A member being sent a chat's history: the file, the project's folder here, and how far it has been sent */
interface Follower {
  ref: string
  path: string
  root: string
  offset: number
  busy: boolean
}

const ADDRESS = (process.env.LOOM_REMOTE_URL || REMOTE_ADDRESS).replace(/\/+$/, '')
const file = (): string => join(app.getPath('userData'), 'teams.json')
const chatsFile = (): string => join(app.getPath('userData'), 'team-chats.json')
const PROJECTS = join(homedir(), '.claude', 'projects')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

let deps: Deps = { projects: () => [] }
let myName = ''
let closing = false
const links = new Map<string, Link>()
/** Team chats with a copy on this PC */
let local: Record<string, TeamLocal> = {}
let privateChats: string[] = []
let joining: (TeamJoining & { ws?: WebSocket; timer?: ReturnType<typeof setTimeout> }) | null = null
/** Histories being received: what is left of a line cut off by the end of a piece, and how far it has come */
const incoming = new Map<string, { ref: string; rest: Buffer; path: string; root: string; write: Promise<void> }>()
/** Those waiting for a chat's copy to be all here, by chat. Told true when it is, false when its holder went away first. */
const arrivals = new Map<string, Set<(here: boolean) => void>>()
/** The request each chat's pieces are expected to answer */
const wanted = new Map<string, string>()
/** Chats this PC follows: who it asked for them */
const following = new Map<string, { teamId: string; member: string }>()
/** People waiting to hear whether a pen was given */
const penWaiters = new Map<string, (r: { ok: boolean; lines?: number; reason?: string }) => void>()

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ---------- Saved on disk ----------

function load(): void {
  try {
    const saved = JSON.parse(readFileSync(file(), 'utf8')) as SavedFile
    const secrets = JSON.parse(saved.protected ? safeStorage.decryptString(Buffer.from(saved.secrets, 'base64')) : saved.secrets) as Record<string, { key: string; auth: string }>
    myName = typeof saved.name === 'string' ? saved.name : ''
    privateChats = Array.isArray(saved.private) ? saved.private.filter((x) => UUID.test(x)) : []
    for (const t of saved.teams) {
      const s = secrets[t.id]
      if (!ID_PATTERN.test(t.id) || !s?.key || !s.auth) continue
      links.set(t.id, newLink({ ...t, key: s.key, auth: s.auth }))
    }
  } catch {
    // Nothing saved yet, or keys this Windows account can't read: no teams.
  }
  try {
    local = JSON.parse(readFileSync(chatsFile(), 'utf8')) as Record<string, TeamLocal>
  } catch {
    local = {}
  }
}

let saving: Promise<void> = Promise.resolve()
/** `now`: written before returning, for when Loom is closing and nothing later would run. */
function save(now = false): void {
  const all = [...links.values()].map((l) => l.cfg)
  const secrets = JSON.stringify(Object.fromEntries(all.map((t) => [t.id, { key: t.key, auth: t.auth }])))
  const protect = safeStorage.isEncryptionAvailable()
  const out: SavedFile = {
    v: 1,
    name: myName,
    teams: all.map(({ key: _k, auth: _a, ...rest }) => rest),
    private: privateChats,
    secrets: protect ? safeStorage.encryptString(secrets).toString('base64') : secrets,
    protected: protect
  }
  const chats = JSON.stringify(local)
  if (now) {
    try {
      writeFileSync(`${file()}.tmp`, JSON.stringify(out, null, 2), 'utf8')
      renameSync(`${file()}.tmp`, file())
      writeFileSync(`${chatsFile()}.tmp`, chats, 'utf8')
      renameSync(`${chatsFile()}.tmp`, chatsFile())
    } catch (e) {
      console.error('[team] save', e)
    }
    return
  }
  saving = saving
    .then(async () => {
      await fs.writeFile(`${file()}.tmp`, JSON.stringify(out, null, 2), 'utf8')
      await fs.rename(`${file()}.tmp`, file())
      await fs.writeFile(`${chatsFile()}.tmp`, chats, 'utf8')
      await fs.rename(`${chatsFile()}.tmp`, chatsFile())
    })
    .catch((e) => console.error('[team] save', e))
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
function saveSoon(): void {
  saveTimer ??= setTimeout(() => {
    saveTimer = null
    save()
  }, 2000)
}

function newLink(cfg: TeamCfg): Link {
  return {
    cfg,
    ws: null,
    relay: 'off',
    retry: null,
    attempts: 0,
    beat: null,
    pongDue: null,
    key: aesKey(unb64u(cfg.key)),
    sid: randomId(),
    n: 0,
    out: Promise.resolve(),
    inbox: Promise.resolve(),
    online: new Set(),
    seen: new Map(),
    theirs: new Map(),
    invite: null,
    requests: new Map(),
    followers: new Map()
  }
}

// ---------- Loom's windows ----------

function toWindows(channel: string, ...args: unknown[]): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send(channel, ...args)
}

function nameOf(link: Link, id: string): string {
  return link.cfg.members.find((m) => m.id === id)?.name ?? 'A teammate'
}

function status(link: Link): TeamStatus {
  const c = link.cfg
  return {
    id: c.id,
    name: c.name,
    relay: link.relay,
    error: link.error,
    me: c.me,
    members: c.members.map((m) => ({ ...m, online: m.id === c.me ? link.relay === 'online' : link.online.has(m.id) })),
    projects: c.projects,
    invite: link.invite ? { url: link.invite.url, expiresAt: link.invite.expiresAt } : null,
    requests: [...link.requests.values()].map(({ conn, name, code }) => ({ id: conn, name, code }))
  }
}

function entries(): TeamChatEntry[] {
  const out: TeamChatEntry[] = []
  for (const link of links.values()) {
    for (const [member, byProject] of link.theirs) {
      for (const [project, said] of byProject) {
        if (!link.cfg.projects.includes(project)) continue
        for (const chat of said.chats) {
          out.push({ ...chat, teamId: link.cfg.id, project, writer: member, writerName: nameOf(link, member), ownerName: nameOf(link, chat.owner), online: link.online.has(member), repo: said.repo })
        }
      }
    }
  }
  return out
}

function state(): TeamsState {
  return {
    name: myName,
    teams: [...links.values()].map(status),
    chats: entries(),
    local,
    private: privateChats,
    joining: joining ? { state: joining.state, code: joining.code, by: joining.by, error: joining.error } : null
  }
}

let emitTimer: ReturnType<typeof setTimeout> | null = null
function emit(): void {
  emitTimer ??= setTimeout(() => {
    emitTimer = null
    toWindows('team:state', state())
  }, 60)
}

// ---------- The projects of this PC, by what a team calls them ----------

const keyCache = new Map<string, { key: string | null; at: number }>()

/** What a team calls the project in this folder: its git remote's address. Null when it has none. */
async function keyOf(path: string): Promise<string | null> {
  const hit = keyCache.get(path.toLowerCase())
  if (hit && Date.now() - hit.at < 60_000) return hit.key
  const git = await gitStatus(path).catch(() => null)
  const key = projectKey(git?.remote)
  keyCache.set(path.toLowerCase(), { key, at: Date.now() })
  return key
}

/** This PC's folder for a project a team shares, when it has one */
async function folderOf(key: string): Promise<string | null> {
  for (const p of deps.projects()) if ((await keyOf(p.path)) === key) return p.path
  return null
}

async function projectKeys(): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {}
  for (const p of deps.projects()) out[p.id] = await keyOf(p.path)
  return out
}

// ---------- The room ----------

function sendRaw(link: Link, frame: Record<string, unknown>): void {
  if (link.ws?.readyState === WebSocket.OPEN) link.ws.send(JSON.stringify(frame))
}

/** Sends a member (or everyone) a message, sealed, in the order asked. */
function post(link: Link, m: TeamMsg, to?: string): Promise<void> {
  link.out = link.out
    .then(async () => {
      if (link.ws?.readyState !== WebSocket.OPEN) return
      const env: TeamEnvelope = { sid: link.sid, n: ++link.n, ts: Date.now(), m }
      sendRaw(link, { ...(to ? { to } : {}), d: await seal(await link.key, teamContext(link.cfg.id, link.cfg.me), env) })
    })
    .catch((e) => console.error('[team] send', e))
  return link.out
}

function stopBeat(link: Link): void {
  if (link.beat) clearInterval(link.beat)
  if (link.pongDue) clearTimeout(link.pongDue)
  link.beat = link.pongDue = null
}

function offline(link: Link): void {
  link.online.clear()
  link.followers.clear()
  link.seen.clear()
  for (const [sessionId, f] of following) if (f.teamId === link.cfg.id) stalled(sessionId)
}

/** The member sending a chat is out of reach: the copy stops where it is, and is asked for again when they are back. */
function stalled(sessionId: string): void {
  subscribed.delete(sessionId)
  settle(sessionId, false)
}

function disconnect(link: Link): void {
  if (link.retry) clearTimeout(link.retry)
  link.retry = null
  stopBeat(link)
  const old = link.ws
  link.ws = null
  old?.close()
  offline(link)
  link.relay = 'off'
  link.error = undefined
}

function connect(link: Link): void {
  if (closing) return
  if (link.retry) clearTimeout(link.retry)
  link.retry = null
  link.relay = 'connecting'
  link.error = undefined
  let socket: WebSocket
  try {
    socket = new WebSocket(`${ADDRESS.replace(/^http/, 'ws')}/v1/team/${link.cfg.id}?member=${link.cfg.me}`)
  } catch (e) {
    console.error('[team] connect', e)
    return again(link)
  }
  link.ws = socket
  // A new connection counts its messages afresh.
  link.sid = randomId()
  link.n = 0
  socket.addEventListener('open', () => {
    if (socket !== link.ws) return
    socket.send(JSON.stringify({ t: 'auth', key: link.cfg.auth }))
    stopBeat(link)
    link.beat = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return
      socket.send('ping')
      link.pongDue ??= setTimeout(() => socket.close(), 10_000)
    }, 30_000)
  })
  socket.addEventListener('message', (e) => {
    if (socket !== link.ws || typeof e.data !== 'string') return
    if (e.data === 'pong') {
      if (link.pongDue) clearTimeout(link.pongDue)
      link.pongDue = null
      return
    }
    const text = e.data
    link.inbox = link.inbox.then(() => onFrame(link, text)).catch((err) => console.error('[team]', err))
  })
  socket.addEventListener('close', () => {
    if (socket !== link.ws) return
    link.ws = null
    stopBeat(link)
    offline(link)
    again(link)
    emit()
  })
  socket.addEventListener('error', () => {
    // A close follows; that is where it is handled.
  })
  emit()
}

function again(link: Link): void {
  if (closing || !links.has(link.cfg.id) || link.relay === 'error') return emit()
  link.relay = 'connecting'
  const delay = Math.min(30_000, 1000 * 2 ** link.attempts++) + Math.random() * 500
  link.retry = setTimeout(() => {
    link.retry = null
    if (links.has(link.cfg.id)) connect(link)
  }, delay)
  emit()
}

function hello(link: Link, to?: string): void {
  const c = link.cfg
  void post(link, { t: 'hello', v: TEAM_VERSION, name: myName, version: app.getVersion(), team: c.name, members: c.members, rev: c.rev }, to)
}

async function onFrame(link: Link, text: string): Promise<void> {
  let f: Record<string, unknown>
  try {
    f = JSON.parse(text) as Record<string, unknown>
  } catch {
    return
  }
  if (typeof f.t === 'string') {
    if (f.t === 'members' && Array.isArray(f.ids)) {
      link.relay = 'online'
      link.attempts = 0
      link.online = new Set((f.ids as unknown[]).filter((x): x is string => typeof x === 'string'))
      hello(link)
      void announce(link)
    } else if (f.t === 'join' && typeof f.from === 'string') {
      link.online.add(f.from)
      hello(link, f.from)
      void announce(link, f.from)
    } else if (f.t === 'leave' && typeof f.from === 'string') {
      link.online.delete(f.from)
      link.seen.delete(f.from)
      for (const subs of link.followers.values()) subs.delete(f.from)
      for (const [sessionId, fo] of following) if (fo.teamId === link.cfg.id && fo.member === f.from) stalled(sessionId)
    } else if (f.t === 'denied') {
      link.relay = 'error'
      link.error = typeof f.reason === 'string' ? f.reason : 'The team would not let this PC in'
    }
    return emit()
  }
  if (typeof f.from !== 'string' || !ID_PATTERN.test(f.from) || typeof f.d !== 'string') return
  if (typeof f.p === 'string') return onJoin(link, f.from, f.p, f.d)
  const env = await unseal<TeamEnvelope>(await link.key, teamContext(link.cfg.id, f.from), f.d)
  if (!env || typeof env !== 'object' || typeof env.n !== 'number' || typeof env.sid !== 'string' || !env.m) return
  // Each connection's messages once, in order, and not ones kept from long ago and sent again.
  if (Math.abs(Date.now() - env.ts) > 10 * 60_000) return
  const last = link.seen.get(f.from)
  if (last && last.sid === env.sid && env.n <= last.n) return
  link.seen.set(f.from, { sid: env.sid, n: env.n })
  return onMember(link, f.from, env.m)
}

// ---------- Inviting, and letting someone in ----------

function endInvite(link: Link): void {
  if (link.invite) clearTimeout(link.invite.timer)
  link.invite = null
  link.requests.clear()
}

async function startInvite(teamId: string): Promise<void> {
  const link = links.get(teamId)
  if (!link) return
  const secret = randomBytes(SECRET_BYTES)
  endInvite(link)
  link.invite = {
    id: await pairingId(secret),
    secret,
    url: inviteUrl(ADDRESS, teamId, b64u(secret)),
    expiresAt: Date.now() + INVITE_MS,
    fails: 0,
    timer: setTimeout(() => {
      endInvite(link)
      emit()
    }, INVITE_MS)
  }
  emit()
}

function cleanName(name: unknown, fallback: string): string {
  const text = typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) : ''
  return text || fallback
}

async function onJoin(link: Link, conn: string, pairId: string, sealed: string): Promise<void> {
  const inv = link.invite
  if (!inv || inv.id !== pairId || Date.now() > inv.expiresAt) return
  const key = await pairingKey(inv.secret, inv.id)
  const msg = await unseal<JoinUp>(key, joinContext(inv.id, 'up'), sealed)
  if (!msg || msg.t !== 'join' || typeof msg.pub !== 'string' || !ID_PATTERN.test(msg.id) || !/^[0-9a-f]{64}$/.test(msg.auth)) {
    if (++inv.fails >= 5) {
      endInvite(link)
      emit()
    }
    return
  }
  const reply = async (m: JoinDown): Promise<void> => sendRaw(link, { to: conn, p: inv.id, d: await seal(key, joinContext(inv.id, 'down'), m) })
  if (msg.v !== TEAM_VERSION) return reply({ t: 'join-failed', reason: 'version' })
  if (link.cfg.members.length >= MAX_TEAM_MEMBERS) return reply({ t: 'join-failed', reason: 'full' })
  const known = link.requests.get(conn)
  // Asked again while it waits (its first message may have come before anyone was here to hear it).
  if (known) return reply({ t: 'confirm', pub: known.pub, by: myName })
  if (link.requests.size >= 3) return
  const pair = await keyPair()
  let raw: Uint8Array<ArrayBuffer>
  try {
    raw = await deviceKeyBytes(pair, msg.pub, inv.secret, msg.id)
  } catch {
    return
  }
  if (link.invite !== inv) return
  link.requests.set(conn, { conn, id: msg.id, name: cleanName(msg.name, 'Someone'), auth: msg.auth, code: await checkCode(raw), raw, pub: await publicKey(pair), pairId: inv.id, key })
  await reply({ t: 'confirm', pub: link.requests.get(conn)!.pub, by: myName })
  emit()
}

/** The answer given on this PC to someone who opened the invitation. */
async function answer(teamId: string, conn: string, allow: boolean): Promise<void> {
  const link = links.get(teamId)
  const r = link?.requests.get(conn)
  if (!link || !r) return
  link.requests.delete(conn)
  const tell = async (to: JoinRequest, m: JoinDown): Promise<void> => sendRaw(link, { to: to.conn, p: to.pairId, d: await seal(to.key, joinContext(to.pairId, 'down'), m) })
  const full = link.cfg.members.length >= MAX_TEAM_MEMBERS
  if (!allow || full) {
    await tell(r, { t: 'join-failed', reason: allow ? 'full' : 'refused' })
    return emit()
  }
  // An invitation lets one person in: it is used up, and anyone else waiting on it is turned away.
  const others = [...link.requests.values()]
  endInvite(link)
  sendRaw(link, { t: 'admit', id: r.id, key: r.auth })
  const c = link.cfg
  c.members = [...c.members.filter((m) => m.id !== r.id), { id: r.id, name: r.name, joinedAt: Date.now() }]
  c.rev++
  save()
  const welcome: Welcome = { key: c.key, name: c.name, members: c.members, rev: c.rev }
  await tell(r, { t: 'welcome', sealed: await seal(await aesKey(r.raw), `loom-team welcome ${r.pairId}`, welcome) })
  for (const other of others) await tell(other, { t: 'join-failed', reason: 'refused' })
  hello(link)
  emit()
}

// ---------- Joining a team ----------

function endJoining(error?: string): void {
  if (!joining) return
  if (joining.timer) clearTimeout(joining.timer)
  const ws = joining.ws
  joining.ws = undefined
  ws?.close()
  joining = error ? { state: 'failed', error } : null
  emit()
}

async function joinTeam(text: string): Promise<void> {
  const inv = parseInvite(text)
  if (!inv) {
    joining = { state: 'failed', error: 'That is not an invitation to a team. Paste the whole link you were sent.' }
    return emit()
  }
  if (links.has(inv.team)) {
    joining = { state: 'failed', error: 'This PC is already in that team.' }
    return emit()
  }
  endJoining()
  const secret = unb64u(inv.secret)
  const pairId = await pairingId(secret)
  const key = await pairingKey(secret, pairId)
  const pair: KeyPair = await keyPair()
  const me = randomId()
  const auth = b64u(randomBytes(32))
  const up: JoinUp = { t: 'join', v: TEAM_VERSION, pub: await publicKey(pair), name: myName || 'Someone', id: me, auth: sha256(auth) }
  let raw: Uint8Array<ArrayBuffer> | null = null
  let socket: WebSocket
  try {
    socket = new WebSocket(`${ADDRESS.replace(/^http/, 'ws')}/v1/team/${inv.team}?join=${me}`)
  } catch {
    joining = { state: 'failed', error: 'Loom could not reach the team. Check the connection and try again.' }
    return emit()
  }
  const mine: NonNullable<typeof joining> = { state: 'connecting', ws: socket }
  joining = mine
  const ask = async (): Promise<void> => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ p: pairId, d: await seal(key, joinContext(pairId, 'up'), up) }))
  }
  // Asked again every few seconds until a member's Loom answers: the one who invited may not have Loom open yet.
  const knock = setInterval(() => joining === mine && mine.state === 'connecting' && void ask(), 4000)
  mine.timer = setTimeout(() => joining === mine && endJoining('Nobody from the team let this PC in. Ask for a new invitation and try again while they have Loom open.'), INVITE_MS)
  socket.addEventListener('open', () => void ask())
  socket.addEventListener('message', (e) => {
    if (joining !== mine || typeof e.data !== 'string') return
    void (async () => {
      let f: { p?: string; d?: string }
      try {
        f = JSON.parse(e.data as string) as { p?: string; d?: string }
      } catch {
        return
      }
      if (f.p !== pairId || typeof f.d !== 'string') return
      const m = await unseal<JoinDown>(key, joinContext(pairId, 'down'), f.d)
      if (!m || joining !== mine) return
      if (m.t === 'confirm') {
        raw = await deviceKeyBytes(pair, m.pub, secret, me)
        mine.state = 'waiting'
        mine.code = await checkCode(raw)
        mine.by = cleanName(m.by, 'A member')
        return emit()
      }
      if (m.t === 'join-failed') {
        clearInterval(knock)
        return endJoining(m.reason === 'full' ? 'That team is full.' : m.reason === 'version' ? 'That team runs another version of Loom. Update Loom on both PCs and try again.' : 'The invitation was not accepted.')
      }
      if (m.t === 'welcome' && raw) {
        const w = await unseal<Welcome>(await aesKey(raw), `loom-team welcome ${pairId}`, m.sealed)
        clearInterval(knock)
        if (!w || typeof w.key !== 'string' || !Array.isArray(w.members)) return endJoining('The invitation could not be read. Ask for a new one.')
        const link = newLink({ id: inv.team, name: cleanName(w.name, 'Team'), key: w.key, auth, me, members: w.members, rev: w.rev ?? 0, projects: [] })
        links.set(inv.team, link)
        save()
        endJoining()
        connect(link)
      }
    })()
  })
  socket.addEventListener('close', () => {
    clearInterval(knock)
    if (joining === mine && mine.ws === socket) endJoining('The connection to the team was lost. Try the invitation again.')
  })
  emit()
}

// ---------- What this PC holds ----------

function isUnder(path: string, root: string): boolean {
  const a = path.replace(/[\\/]+$/, '').toLowerCase().replace(/\//g, '\\')
  const b = root.replace(/[\\/]+$/, '').toLowerCase().replace(/\//g, '\\')
  return a === b || a.startsWith(`${b}\\`)
}

/** The chats of a shared project that this PC writes in: its own, and those whose pen it holds. */
async function held(link: Link, project: string, fresh = false): Promise<{ chats: TeamChat[]; path: string } | null> {
  const path = await folderOf(project)
  if (!path) return null
  // Saying what this PC holds reads the chats afresh: one started a moment ago must be in it.
  const all = await listAllSessions(fresh).catch(() => [])
  const chats: TeamChat[] = []
  for (const s of all) {
    if (!isUnder(s.cwd, path) || privateChats.includes(s.sessionId)) continue
    const l = local[s.sessionId]
    if (l && (l.teamId !== link.cfg.id || l.writer !== link.cfg.me)) continue
    chats.push({
      sessionId: s.sessionId,
      title: s.title,
      lastAt: s.lastModified,
      size: s.fileSize ?? 0,
      status: sessionState(s.sessionId) ?? 'idle',
      model: modelOfSession(s.sessionId),
      owner: l?.owner ?? link.cfg.me
    })
    if (chats.length >= 60) break
  }
  return { chats, path }
}

async function holds(link: Link, sessionId: string): Promise<boolean> {
  for (const project of link.cfg.projects) if ((await held(link, project))?.chats.some((c) => c.sessionId === sessionId)) return true
  return false
}

const announcing = new Map<string, ReturnType<typeof setTimeout>>()

/** Says which chats this PC holds in each shared project, to one member or to all. */
async function announce(link: Link, to?: string): Promise<void> {
  if (link.relay !== 'online') return
  for (const project of link.cfg.projects) {
    const mine = await held(link, project, true)
    if (!mine) continue
    const git = await gitStatus(mine.path).catch(() => null)
    void post(link, { t: 'chats', project, chats: mine.chats, repo: git ? { branch: git.branch, changes: git.changes } : null }, to)
  }
}

/** Says it again shortly, once: after a chat started or finished a turn, was shared or made private. */
function announceSoon(link: Link, ms = 1200): void {
  if (announcing.has(link.cfg.id)) return
  announcing.set(
    link.cfg.id,
    setTimeout(() => {
      announcing.delete(link.cfg.id)
      void announce(link)
    }, ms)
  )
}

// ---------- Histories ----------

const lineCache = new Map<string, { size: number; mtime: number; lines: number }>()

/** How many lines a file has. Kept, for as long as the file is the same. */
async function countLines(path: string): Promise<number> {
  const st = await fs.stat(path)
  const hit = lineCache.get(path)
  if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) return hit.lines
  let lines = 0
  for await (const chunk of createReadStream(path)) {
    const b = chunk as Buffer
    for (let i = b.indexOf(10); i !== -1; i = b.indexOf(10, i + 1)) lines++
  }
  lineCache.set(path, { size: st.size, mtime: st.mtimeMs, lines })
  return lines
}

/** Where in a file a line starts, counting from 0; the file's end when it has fewer. */
async function offsetOfLine(path: string, line: number): Promise<number> {
  if (line <= 0) return 0
  let seen = 0
  let at = 0
  for await (const chunk of createReadStream(path)) {
    const b = chunk as Buffer
    for (let i = b.indexOf(10); i !== -1; i = b.indexOf(10, i + 1)) {
      if (++seen === line) return at + i + 1
    }
    at += b.length
  }
  return at
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A history names files by their place on the PC it was written on. Under the project's folder
 * there, they become this PC's: as JSON holds them (backslashes doubled) and with forward slashes.
 */
function rewriteRoot(text: string, from: string, to: string): string {
  const a = from.replace(/[\\/]+$/, '')
  const b = to.replace(/[\\/]+$/, '')
  if (!a || a.toLowerCase() === b.toLowerCase()) return text
  const forms: [string, string][] = [
    [JSON.stringify(a).slice(1, -1), JSON.stringify(b).slice(1, -1)],
    [a.replace(/\\/g, '/'), b.replace(/\\/g, '/')]
  ]
  for (const [x, y] of forms) text = text.replace(new RegExp(`${escapeRegExp(x)}(?![\\w.-])`, 'gi'), () => y)
  return text
}

/** Sends a member a chat's history from where they have it, piece by piece, then more as it grows. */
async function feed(link: Link, to: string, sessionId: string): Promise<void> {
  const sub = link.followers.get(sessionId)?.get(to)
  if (!sub || sub.busy) return
  sub.busy = true
  try {
    const { path, root, ref } = sub
    for (;;) {
      if (link.followers.get(sessionId)?.get(to) !== sub || link.ws?.readyState !== WebSocket.OPEN) return
      const size = (await fs.stat(path)).size
      if (size <= sub.offset) return
      const fh = await fs.open(path, 'r')
      let piece: Buffer
      try {
        const buf = Buffer.alloc(Math.min(PIECE_BYTES, size - sub.offset))
        const { bytesRead } = await fh.read(buf, 0, buf.length, sub.offset)
        piece = buf.subarray(0, bytesRead)
      } finally {
        await fh.close()
      }
      if (!piece.length) return
      sub.offset += piece.length
      await post(link, { t: 'data', sessionId, ref, bytes: piece.toString('base64'), left: size - sub.offset, total: size, root }, to)
      // Not faster than the connection takes it.
      while ((link.ws?.bufferedAmount ?? 0) > 4 * 1024 * 1024) await wait(50)
    }
  } catch (e) {
    console.error('[team] feed', e)
  } finally {
    sub.busy = false
  }
}

/** The folder, on this PC, of the project a chat of a team belongs to */
async function rootOf(link: Link, sessionId: string): Promise<string | null> {
  for (const project of link.cfg.projects) {
    const mine = await held(link, project)
    if (mine?.chats.some((c) => c.sessionId === sessionId)) return mine.path
  }
  return null
}

// Histories that members follow grow while Claude works: looked at twice a second while anyone follows.
setInterval(() => {
  for (const link of links.values()) for (const [sessionId, subs] of link.followers) for (const to of subs.keys()) void feed(link, to, sessionId)
}, 500).unref?.()

/** A member asks for a chat's history from a line on. */
async function onWant(link: Link, from: string, m: Extract<TeamMsg, { t: 'want' }>): Promise<void> {
  const sessionId = m.sessionId
  const root = UUID.test(sessionId) && typeof m.ref === 'string' ? await rootOf(link, sessionId) : null
  const path = root ? (await transcriptIndex()).get(sessionId) : undefined
  if (!root || !path) return void post(link, { t: 'nope', sessionId }, from)
  const offset = await offsetOfLine(path, Math.max(0, Math.floor(m.from)))
  const subs = link.followers.get(sessionId) ?? new Map<string, Follower>()
  subs.set(from, { ref: m.ref, path, root, offset, busy: false })
  link.followers.set(sessionId, subs)
  // Nothing new for them: say so, so they know they have it all.
  const size = (await fs.stat(path)).size
  if (size <= offset) await post(link, { t: 'data', sessionId, ref: m.ref, bytes: '', left: 0, total: size, root }, from)
  await feed(link, from, sessionId)
  if (!m.follow) link.followers.get(sessionId)?.delete(from)
}

/** Chats this PC is being sent right now, by who sends them */
const subscribed = new Map<string, string>()

/**
 * How many whole lines of a team chat's copy are on this PC. The file is what counts: the number
 * kept beside it can be behind after Loom was cut off (asking from there would add lines twice),
 * and half a line left at the end by a write that never finished is cut off first.
 */
async function linesHere(sessionId: string): Promise<number> {
  const l = local[sessionId]
  const root = l ? await folderOf(l.project) : null
  if (!l || !root) return l?.lines ?? 0
  const path = join(PROJECTS, projectDirName(root), `${sessionId}.jsonl`)
  let lines = 0
  try {
    const size = (await fs.stat(path)).size
    if (size > 0) {
      let wholeTo = 0
      let at = 0
      for await (const chunk of createReadStream(path)) {
        const b = chunk as Buffer
        for (let i = b.indexOf(10); i !== -1; i = b.indexOf(10, i + 1)) {
          lines++
          wholeTo = at + i + 1
        }
        at += b.length
      }
      if (wholeTo < size) await fs.truncate(path, wholeTo)
      lineCache.delete(path)
    }
  } catch {
    // No copy here (never made, or deleted since): it is asked for from the start.
    lines = 0
  }
  if (l.lines !== lines) {
    l.lines = lines
    saveSoon()
  }
  return lines
}

/** Asks the member who holds a chat for what this PC is missing of it, and to keep it coming. */
async function subscribe(sessionId: string): Promise<void> {
  const f = following.get(sessionId)
  const link = f && links.get(f.teamId)
  if (!f || !link || !link.online.has(f.member) || subscribed.get(sessionId) === f.member) return
  const member = f.member
  subscribed.set(sessionId, member)
  // From here on, pieces of an earlier asking are turned away.
  const ref = randomId()
  wanted.set(sessionId, ref)
  const before = incoming.get(sessionId)
  incoming.delete(sessionId)
  // What was already on its way into the file lands before its lines are counted.
  if (before) await before.write.catch(() => undefined)
  const from = await linesHere(sessionId)
  // Asked again meanwhile (the chat changed hands, its holder came and went): that asking stands.
  if (wanted.get(sessionId) !== ref) return
  await post(link, { t: 'want', sessionId, from, follow: true, ref }, member)
}

async function onData(link: Link, from: string, m: Extract<TeamMsg, { t: 'data' }>): Promise<void> {
  const l = local[m.sessionId]
  const f = following.get(m.sessionId)
  // Only the pieces of the request this PC last made: ones still coming for an earlier one would repeat lines.
  if (!l || !f || f.member !== from || f.teamId !== link.cfg.id || l.writer === link.cfg.me || wanted.get(m.sessionId) !== m.ref) return
  const root = await folderOf(l.project)
  // Asked for afresh while this piece waited: it belongs to the asking before.
  if (!root || wanted.get(m.sessionId) !== m.ref) return
  let inc = incoming.get(m.sessionId)
  if (!inc || inc.ref !== m.ref) {
    const path = join(PROJECTS, projectDirName(root), `${m.sessionId}.jsonl`)
    inc = { ref: m.ref, rest: Buffer.alloc(0), path, root, write: fs.mkdir(dirname(path), { recursive: true }).then(() => undefined) }
    incoming.set(m.sessionId, inc)
  }
  const bytes = Buffer.from(m.bytes, 'base64')
  const all = inc.rest.length ? Buffer.concat([inc.rest, bytes]) : bytes
  const end = all.lastIndexOf(10)
  const whole = end === -1 ? Buffer.alloc(0) : all.subarray(0, end + 1)
  inc.rest = end === -1 ? all : all.subarray(end + 1)
  if (whole.length) {
    const text = rewriteRoot(whole.toString('utf8'), m.root, inc.root)
    let lines = 0
    for (let i = whole.indexOf(10); i !== -1; i = whole.indexOf(10, i + 1)) lines++
    const path = inc.path
    inc.write = inc.write.then(() => fs.appendFile(path, text, 'utf8'))
    await inc.write
    l.lines += lines
    saveSoon()
  }
  const sync: TeamSync = { sessionId: m.sessionId, got: m.total - m.left, total: m.total, done: m.left === 0 }
  toWindows('team:sync', sync)
  if (m.left === 0) {
    forgetSession(m.sessionId)
    lineCache.delete(inc.path)
    settle(m.sessionId, true)
    if (whole.length) toWindows('team:grew', m.sessionId)
  }
}

/** Tells those waiting for a chat's copy how it went. */
function settle(sessionId: string, here: boolean): void {
  const waiting = arrivals.get(sessionId)
  if (!waiting) return
  arrivals.delete(sessionId)
  for (const tell of waiting) tell(here)
}

/**
 * Resolves true once what the holder has so far is all here; false when the holder goes away
 * first, or it takes too long. Ask before asking the holder, so an answer cannot come first.
 */
function caughtUp(sessionId: string, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const waiting = arrivals.get(sessionId) ?? new Set<(here: boolean) => void>()
    arrivals.set(sessionId, waiting)
    const tell = (here: boolean): void => {
      clearTimeout(timer)
      resolve(here)
    }
    const timer = setTimeout(() => {
      waiting.delete(tell)
      resolve(false)
    }, ms)
    waiting.add(tell)
  })
}

// ---------- A message from a member ----------

/** What followers hear of a chat as it happens. The whole reply so far is sent each time, so not too often. */
const LIVE = new Set<ChatEvent['type']>(['items', 'tool-result', 'partial', 'partial-clear', 'thinking-partial', 'status'])
const liveAt = new Map<string, number>()
const liveLater = new Map<string, ReturnType<typeof setTimeout>>()

function onChatEvent(sessionId: string, ev: ChatEvent): void {
  if (ev.type === 'status') for (const link of links.values()) if (link.cfg.projects.length) announceSoon(link)
  if (!LIVE.has(ev.type)) return
  const send = (): void => {
    for (const link of links.values()) for (const to of link.followers.get(sessionId)?.keys() ?? []) void post(link, { t: 'live', sessionId, ev }, to)
  }
  if (ev.type !== 'partial' && ev.type !== 'thinking-partial') return send()
  // Text being written: at most a few times a second, and always the latest.
  const key = `${sessionId} ${ev.type}`
  const pending = liveLater.get(key)
  if (pending) clearTimeout(pending)
  const since = Date.now() - (liveAt.get(key) ?? 0)
  const go = (): void => {
    liveLater.delete(key)
    liveAt.set(key, Date.now())
    send()
  }
  if (since >= 350) go()
  else liveLater.set(key, setTimeout(go, 350 - since))
}

async function onMember(link: Link, from: string, m: TeamMsg): Promise<void> {
  const c = link.cfg
  switch (m.t) {
    case 'hello': {
      if (m.v !== TEAM_VERSION || !Array.isArray(m.members)) return
      // The newest list of members is the one everyone keeps. A list without this PC in it means it was taken out.
      if (m.rev > c.rev && m.members.some((x) => x.id === c.me)) {
        c.members = m.members.filter((x) => ID_PATTERN.test(x.id)).map((x) => ({ id: x.id, name: cleanName(x.name, 'A teammate'), joinedAt: Number(x.joinedAt) || Date.now() }))
        c.rev = m.rev
        c.name = cleanName(m.team, c.name)
        save()
      } else if (m.rev < c.rev) hello(link, from)
      // A member's name is the one they go by now.
      const who = c.members.find((x) => x.id === from)
      const name = cleanName(m.name, who?.name ?? 'A teammate')
      if (who && who.name !== name) {
        who.name = name
        saveSoon()
      }
      return emit()
    }
    case 'chats': {
      if (typeof m.project !== 'string' || !Array.isArray(m.chats)) return
      const by = link.theirs.get(from) ?? new Map<string, { chats: TeamChat[]; repo: TeamRepo | null }>()
      by.set(m.project, { chats: m.chats.filter((x) => UUID.test(x.sessionId)).slice(0, 80), repo: m.repo ?? null })
      link.theirs.set(from, by)
      for (const chat of m.chats) {
        const l = local[chat.sessionId]
        // They hold it now (it was passed on while this PC was away): this PC's copy follows theirs.
        if (l && l.teamId === c.id && l.writer !== from && l.writer !== c.me) {
          l.writer = from
          saveSoon()
        }
        const f = following.get(chat.sessionId)
        if (f && f.teamId === c.id) {
          // It changed hands while this PC looked on: the one who had it need not send it any more.
          if (f.member !== from) {
            void post(link, { t: 'unfollow', sessionId: chat.sessionId }, f.member)
            f.member = from
          }
          void subscribe(chat.sessionId)
        }
      }
      return emit()
    }
    case 'want':
      return onWant(link, from, m)
    case 'unfollow':
      link.followers.get(m.sessionId)?.delete(from)
      return
    case 'data':
      return onData(link, from, m)
    case 'nope':
      subscribed.delete(m.sessionId)
      toWindows('team:sync', { sessionId: m.sessionId, got: 0, total: 0, done: true, error: `${nameOf(link, from)} no longer shares this chat.` } satisfies TeamSync)
      return
    case 'live':
      if (following.get(m.sessionId)?.member === from) toWindows('team:live', m.sessionId, m.ev)
      return
    case 'pen-ask': {
      // Only a chat at rest changes hands: Claude is not cut off in the middle of a turn.
      if (!(await holds(link, m.sessionId))) return void post(link, { t: 'pen-no', sessionId: m.sessionId, reason: 'gone' }, from)
      const doing = sessionState(m.sessionId)
      if (doing === 'working' || doing === 'waiting') return void post(link, { t: 'pen-no', sessionId: m.sessionId, reason: 'busy' }, from)
      const path = (await transcriptIndex()).get(m.sessionId)
      const project = (await projectOf(link, m.sessionId)) ?? ''
      if (!path || !project) return void post(link, { t: 'pen-no', sessionId: m.sessionId, reason: 'gone' }, from)
      // Claude Code lets go of the history before anyone else writes in it.
      releaseSession(m.sessionId)
      // Those who followed it here follow its new holder, once that PC says it has it.
      link.followers.delete(m.sessionId)
      const lines = await countLines(path)
      local[m.sessionId] = { teamId: c.id, project, owner: local[m.sessionId]?.owner ?? c.me, writer: from, lines }
      save()
      await post(link, { t: 'pen-give', sessionId: m.sessionId, lines }, from)
      following.set(m.sessionId, { teamId: c.id, member: from })
      toWindows('team:passed', m.sessionId, nameOf(link, from))
      void announce(link)
      return emit()
    }
    case 'pen-give':
      penWaiters.get(m.sessionId)?.({ ok: true, lines: m.lines })
      return
    case 'pen-no':
      penWaiters.get(m.sessionId)?.({ ok: false, reason: m.reason })
      return
  }
}

async function projectOf(link: Link, sessionId: string): Promise<string | null> {
  for (const project of link.cfg.projects) if ((await held(link, project))?.chats.some((c) => c.sessionId === sessionId)) return project
  return null
}

// ---------- What a window asks for ----------

type Result = { ok: boolean; error?: string }

/** Starts copying a teammate's chat to this PC and following it. Done when all there is so far has arrived. */
async function open(sessionId: string): Promise<Result & { cwd?: string; partial?: { who: string; left: boolean } }> {
  const entry = entries().find((e) => e.sessionId === sessionId)
  const known = local[sessionId]
  const link = links.get(entry?.teamId ?? known?.teamId ?? '')
  if (!link) return { ok: false, error: 'That chat is no longer shared with the team.' }
  const project = entry?.project ?? known!.project
  const cwd = await folderOf(project)
  if (!cwd) return { ok: false, error: 'This PC does not have that project. Add its folder to Loom first.' }
  const writer = entry?.writer ?? known!.writer
  if (writer === link.cfg.me) return { ok: true, cwd }
  if (!known) {
    // A history of the same name here that did not come from the team is not overwritten.
    if (existsSync(join(PROJECTS, projectDirName(cwd), `${sessionId}.jsonl`))) return { ok: false, error: 'This PC already has a chat with that id.' }
    local[sessionId] = { teamId: link.cfg.id, project, owner: entry!.owner, writer, lines: 0 }
    save()
  } else if (known.writer !== writer) {
    known.writer = writer
    saveSoon()
  }
  following.set(sessionId, { teamId: link.cfg.id, member: writer })
  emit()
  if (!link.online.has(writer)) {
    // They are away: what this PC already has of it can still be read.
    return local[sessionId].lines > 0 ? { ok: true, cwd } : { ok: false, error: `${nameOf(link, writer)} is not online, and this PC has no copy of that chat yet.` }
  }
  subscribed.delete(sessionId)
  const arrived = caughtUp(sessionId, 120_000)
  await subscribe(sessionId)
  const here = await arrived
  if (here) return { ok: true, cwd }
  const who = nameOf(link, writer)
  const left = !link.online.has(writer)
  if (local[sessionId].lines === 0) return { ok: false, error: left ? `${who} went offline before the chat arrived. Try again when they are back.` : 'The chat did not arrive. Try again in a moment.' }
  // Part of it is here and can be read; the rest is asked for again when its holder is back.
  return { ok: true, cwd, partial: { who, left } }
}

function unfollow(sessionId: string): void {
  const f = following.get(sessionId)
  if (!f) return
  following.delete(sessionId)
  subscribed.delete(sessionId)
  incoming.delete(sessionId)
  wanted.delete(sessionId)
  const link = links.get(f.teamId)
  if (link) void post(link, { t: 'unfollow', sessionId }, f.member)
}

/** Asks the member writing in a chat for its pen. From then on this PC writes in it. */
async function take(sessionId: string): Promise<Result> {
  const l = local[sessionId]
  const link = l && links.get(l.teamId)
  if (!l || !link) return { ok: false, error: 'That chat is not shared with a team.' }
  if (l.writer === link.cfg.me) return { ok: true }
  const holder = l.writer
  if (!link.online.has(holder)) return { ok: false, error: `${nameOf(link, holder)} is not online, so the chat cannot change hands. Take a copy to carry on from what this PC has.` }
  const answer = await new Promise<{ ok: boolean; lines?: number; reason?: string }>((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, reason: 'quiet' }), 20_000)
    penWaiters.set(sessionId, (r) => {
      clearTimeout(timer)
      resolve(r)
    })
    void post(link, { t: 'pen-ask', sessionId }, holder)
  })
  penWaiters.delete(sessionId)
  if (!answer.ok) {
    const who = nameOf(link, holder)
    return { ok: false, error: answer.reason === 'busy' ? `Claude is still working in it for ${who}. Try again when it is done.` : answer.reason === 'gone' ? `${who} no longer shares that chat.` : `${who}'s Loom did not answer. Try again in a moment.` }
  }
  // Everything they wrote has to be here before this PC adds to it: the rest of it is on its way.
  for (let i = 0; i < 300 && local[sessionId].lines < (answer.lines ?? 0); i++) await wait(200)
  if (local[sessionId].lines < (answer.lines ?? 0)) return { ok: false, error: 'The last of the chat did not arrive. Try again in a moment.' }
  unfollow(sessionId)
  l.writer = link.cfg.me
  save()
  forgetSession(sessionId)
  void announce(link)
  emit()
  return { ok: true }
}

/** A copy of a team chat that is this PC's own from here on: same history, a new id. */
async function fork(sessionId: string): Promise<Result & { sessionId?: string }> {
  const path = (await transcriptIndex()).get(sessionId)
  if (!path || !UUID.test(sessionId)) return { ok: false, error: 'This PC has no copy of that chat yet.' }
  const id = randomUUID()
  try {
    const text = await fs.readFile(path, 'utf8')
    await fs.writeFile(join(dirname(path), `${id}.jsonl`), text.split(sessionId).join(id), 'utf8')
  } catch (e) {
    return { ok: false, error: `The copy could not be made: ${(e as Error).message}` }
  }
  forgetSession(id)
  for (const link of links.values()) announceSoon(link)
  return { ok: true, sessionId: id }
}

export function setupTeams(d: Deps): void {
  deps = d
  load()
  tapChats(onChatEvent)
  for (const link of links.values()) connect(link)
  // What this PC holds changes as chats are started, renamed and closed: said again now and then.
  setInterval(() => {
    for (const link of links.values()) if (link.cfg.projects.length) void announce(link)
  }, 30_000).unref?.()

  ipcMain.handle('team:state', () => state())
  ipcMain.handle('team:keys', () => projectKeys())
  ipcMain.handle('team:name', (_e, name: string) => {
    myName = cleanName(name, '')
    save()
    for (const link of links.values()) {
      const me = link.cfg.members.find((m) => m.id === link.cfg.me)
      if (me && myName) me.name = myName
      hello(link)
    }
    emit()
  })
  ipcMain.handle('team:create', (_e, name: string) => {
    const me = randomId()
    const cfg: TeamCfg = { id: randomId(), name: cleanName(name, 'Team'), key: b64u(randomBytes(32)), auth: b64u(randomBytes(32)), me, members: [{ id: me, name: myName || 'Me', joinedAt: Date.now() }], rev: 1, projects: [] }
    const link = newLink(cfg)
    links.set(cfg.id, link)
    save()
    connect(link)
    emit()
    return cfg.id
  })
  ipcMain.handle('team:invite', (_e, teamId: string) => startInvite(teamId))
  ipcMain.handle('team:cancelInvite', (_e, teamId: string) => {
    const link = links.get(teamId)
    if (link) endInvite(link)
    emit()
  })
  ipcMain.handle('team:answer', (_e, teamId: string, conn: string, allow: boolean) => answer(teamId, conn, allow))
  ipcMain.handle('team:join', (_e, text: string) => joinTeam(text))
  ipcMain.handle('team:cancelJoin', () => endJoining())
  ipcMain.handle('team:leave', (_e, teamId: string) => {
    const link = links.get(teamId)
    if (!link) return
    sendRaw(link, { t: 'expel', id: link.cfg.me })
    links.delete(teamId)
    disconnect(link)
    for (const [sessionId, f] of following) if (f.teamId === teamId) following.delete(sessionId)
    save()
    emit()
  })
  ipcMain.handle('team:remove', (_e, teamId: string, memberId: string) => {
    const link = links.get(teamId)
    if (!link || memberId === link.cfg.me) return
    sendRaw(link, { t: 'expel', id: memberId })
    link.cfg.members = link.cfg.members.filter((m) => m.id !== memberId)
    link.cfg.rev++
    link.theirs.delete(memberId)
    link.online.delete(memberId)
    save()
    hello(link)
    emit()
  })
  ipcMain.handle('team:share', async (_e, teamId: string, path: string, on: boolean): Promise<Result> => {
    const link = links.get(teamId)
    const key = await keyOf(path)
    if (!link) return { ok: false, error: 'That team is gone.' }
    if (!key) return { ok: false, error: 'This project has no git remote, which is how a team tells that everyone has the same project. Push it to a remote first.' }
    link.cfg.projects = on ? [...new Set([...link.cfg.projects, key])] : link.cfg.projects.filter((p) => p !== key)
    save()
    if (on) void announce(link)
    else void post(link, { t: 'chats', project: key, chats: [], repo: null })
    emit()
    return { ok: true }
  })
  ipcMain.handle('team:private', (_e, sessionId: string, on: boolean) => {
    privateChats = on ? [...new Set([...privateChats, sessionId])] : privateChats.filter((x) => x !== sessionId)
    save()
    for (const link of links.values()) {
      if (on) link.followers.delete(sessionId)
      void announce(link)
    }
    emit()
  })
  ipcMain.handle('team:open', async (_e, sessionId: string) => {
    const r = await open(sessionId)
    // The chat opens with the part that is here; the window says the rest is still to come.
    const partial = r.partial ? (r.partial.left ? `${r.partial.who} went offline before the whole chat arrived. The rest comes when they are back.` : 'Only part of the chat has arrived so far. The rest is on its way.') : undefined
    return { ok: r.ok, error: r.error, cwd: r.cwd, partial }
  })
  ipcMain.handle('team:unfollow', (_e, sessionId: string) => unfollow(sessionId))
  ipcMain.handle('team:take', (_e, sessionId: string) => take(sessionId))
  ipcMain.handle('team:fork', (_e, sessionId: string) => fork(sessionId))
}

export function closeTeams(): void {
  closing = true
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
    save(true)
  }
  for (const link of links.values()) disconnect(link)
}
