// The relay behind remote.loom.baby. Each Loom install has a room; Loom on the PC and the phones
// linked to it connect to that room, and the room passes their messages along. It can't read
// them: Loom and each phone seal everything with a key the relay never sees (src/shared/remote.ts).
//
// Rooms are Durable Objects using the hibernation API: a room with nothing to pass along is put
// away while its connections stay open, so idle phones and PCs cost nothing.

import { DurableObject } from 'cloudflare:workers'

interface Env {
  ROOMS: DurableObjectNamespace<Room>
  TEAMS: DurableObjectNamespace<Team>
  ASSETS: Fetcher
}

const ID = /^[A-Za-z0-9_-]{22}$/
/** Phones that can be connected to one room at a time */
const MAX_PHONES = 8
/** The largest message passed along, in characters */
const MAX_MESSAGE = 4 * 1024 * 1024

/** A PC that hasn't answered a ping for this long is taken to be asleep or gone */
const PC_QUIET_MS = 75_000
/** Connections that say they are the PC and haven't shown it yet */
const MAX_UNPROVEN = 3

type Who = { role: 'pc'; ok: boolean; since: number } | { role: 'phone'; device: string }

type Frame = { t?: unknown; key?: unknown; d?: unknown; to?: unknown; p?: unknown; x?: unknown }

/** The parts of a message that are passed along: the sealed data, a pairing id, a plain word. */
function passed(frame: Frame): { d?: string; p?: string; x?: string } {
  const out: { d?: string; p?: string; x?: string } = {}
  if (typeof frame.d === 'string') out.d = frame.d
  if (typeof frame.p === 'string' && ID.test(frame.p)) out.p = frame.p
  if (typeof frame.x === 'string' && frame.x.length <= 20) out.x = frame.x
  return out
}

function send(ws: WebSocket, value: unknown): void {
  try {
    ws.send(typeof value === 'string' ? value : JSON.stringify(value))
  } catch {
    // Closing already: nothing to tell it.
  }
}

async function sha256(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export class Room extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // Keep-alives are answered without waking the room.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  private who(ws: WebSocket): Who {
    return ws.deserializeAttachment() as Who
  }

  /** The PC's connection, once it has shown it is this room's PC */
  private pcs(): WebSocket[] {
    return this.ctx.getWebSockets('pc').filter((ws) => {
      const who = this.who(ws)
      return who.role === 'pc' && who.ok
    })
  }

  /**
   * Loom pings every half minute, and those pings are answered without waking the room. A PC
   * that went to sleep stops pinging while its connection still looks open: when a phone turns
   * up or speaks, such a connection is closed, so the phone is told the PC is away.
   */
  private dropQuietPc(): void {
    for (const ws of this.pcs()) {
      const who = this.who(ws)
      const last = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? (who.role === 'pc' ? who.since : 0)
      if (Date.now() - last <= PC_QUIET_MS) continue
      ws.serializeAttachment({ role: 'pc', ok: false, since: 0 } satisfies Who)
      ws.close(4001, 'No ping from the PC')
      if (!this.pcs().length) for (const phone of this.phones()) send(phone, { t: 'pc', on: false })
    }
  }

  private phones(): WebSocket[] {
    return this.ctx.getWebSockets('phone')
  }

  private deviceOf(ws: WebSocket): string {
    const who = this.who(ws)
    return who.role === 'phone' ? who.device : ''
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const role = url.searchParams.get('role')
    const device = url.searchParams.get('device') ?? ''
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    if (role === 'pc') {
      // Nothing reaches it, and no phone hears of it, until it proves it is this room's PC.
      const unproven = this.ctx.getWebSockets('pc').filter((ws) => !this.pcs().includes(ws))
      for (const old of unproven.slice(0, Math.max(0, unproven.length - MAX_UNPROVEN + 1))) old.close(4003, 'Sign in first')
      this.ctx.acceptWebSocket(server, ['pc'])
      server.serializeAttachment({ role: 'pc', ok: false, since: Date.now() } satisfies Who)
    } else {
      this.dropQuietPc()
      const others = new Set(this.phones().map((ws) => this.deviceOf(ws)))
      others.delete(device)
      if (others.size >= MAX_PHONES) return new Response('Too many phones are connected', { status: 429 })
      // The same phone again (a reload, or waking from sleep) takes the place of its old connection.
      for (const old of this.ctx.getWebSockets(`d:${device}`)) old.close(4000, 'Replaced by a newer connection')
      this.ctx.acceptWebSocket(server, ['phone', `d:${device}`])
      server.serializeAttachment({ role: 'phone', device } satisfies Who)
      send(server, { t: 'pc', on: this.pcs().length > 0 })
      for (const pc of this.pcs()) send(pc, { t: 'join', from: device })
    }
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return
    if (message.length > MAX_MESSAGE) return ws.close(1009, 'Message too big')
    let frame: Frame
    try {
      frame = JSON.parse(message) as Frame
    } catch {
      return
    }
    const who = this.who(ws)
    if (who.role === 'pc') {
      if (!who.ok) return this.signIn(ws, frame)
      if (typeof frame.to !== 'string' || !ID.test(frame.to)) return
      const out = JSON.stringify(passed(frame))
      for (const phone of this.ctx.getWebSockets(`d:${frame.to}`)) send(phone, out)
      return
    }
    if (typeof frame.d !== 'string') return
    this.dropQuietPc()
    const out = JSON.stringify({ from: who.device, ...passed(frame) })
    for (const pc of this.pcs()) send(pc, out)
  }

  /**
   * The PC's first message: its room key. The first PC to sign in to a room owns it; after that
   * only the same key gets in, so nobody else can take the PC's place and cut it off.
   */
  private async signIn(ws: WebSocket, frame: Frame): Promise<void> {
    if (frame.t !== 'auth' || typeof frame.key !== 'string' || frame.key.length < 40 || frame.key.length > 100) {
      return ws.close(4003, 'Sign in first')
    }
    const hash = await sha256(frame.key)
    const owner = await this.ctx.storage.get<string>('pc')
    if (owner && owner !== hash) {
      send(ws, { t: 'denied', reason: 'This room belongs to another PC' })
      return ws.close(4003, 'This room belongs to another PC')
    }
    if (!owner) await this.ctx.storage.put('pc', hash)
    for (const old of this.pcs()) old.close(4000, 'Replaced by a newer connection')
    ws.serializeAttachment({ role: 'pc', ok: true, since: Date.now() } satisfies Who)
    send(ws, { t: 'phones', ids: [...new Set(this.phones().map((p) => this.deviceOf(p)))] })
    for (const phone of this.phones()) send(phone, { t: 'pc', on: true })
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason)
    } catch {
      // Closed already.
    }
    this.gone(ws)
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.gone(ws)
  }

  /** Tells the other side that a connection went away, unless a newer one took its place. */
  private gone(ws: WebSocket): void {
    const who = this.who(ws)
    if (who.role === 'pc') {
      if (who.ok && !this.pcs().some((other) => other !== ws)) for (const phone of this.phones()) send(phone, { t: 'pc', on: false })
      return
    }
    if (this.ctx.getWebSockets(`d:${who.device}`).some((other) => other !== ws)) return
    for (const pc of this.pcs()) send(pc, { t: 'leave', from: who.device })
  }
}

// ---------- Teams ----------
//
// A team's room connects the Looms of its members, PC to PC. Like a phone's room it only passes
// sealed messages along: the team's key never comes here. What the room does know is who may
// connect. Each member signs in with a key of its own, whose hash the room keeps; a member lets a
// new one in by handing the room that hash, and takes one out by name. Someone holding an
// invitation connects as a joiner, and can only swap the few sealed messages of joining with the
// members until one of them lets it in.

/** Members a team can have */
const MAX_MEMBERS = 12
/** Joiners that can be waiting at once */
const MAX_JOINERS = 4

type TeamWho = { role: 'member'; id: string; ok: boolean; since: number } | { role: 'joiner'; conn: string }

type TeamFrame = { t?: unknown; key?: unknown; id?: unknown; d?: unknown; to?: unknown; p?: unknown }

export class Team extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  private who(ws: WebSocket): TeamWho {
    return ws.deserializeAttachment() as TeamWho
  }

  /** The connections of members that have signed in */
  private members(): WebSocket[] {
    return this.ctx.getWebSockets('member').filter((ws) => {
      const who = this.who(ws)
      return who.role === 'member' && who.ok
    })
  }

  private idOf(ws: WebSocket): string {
    const who = this.who(ws)
    return who.role === 'member' ? who.id : ''
  }

  private online(): string[] {
    return [...new Set(this.members().map((ws) => this.idOf(ws)))]
  }

  /** A member that stopped pinging (asleep, or cut off) is taken to have left. */
  private dropQuiet(): void {
    for (const ws of this.members()) {
      const who = this.who(ws)
      if (who.role !== 'member') continue
      const last = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? who.since
      if (Date.now() - last <= PC_QUIET_MS) continue
      ws.serializeAttachment({ ...who, ok: false } satisfies TeamWho)
      ws.close(4001, 'No ping')
      if (!this.online().includes(who.id)) for (const other of this.members()) send(other, { t: 'leave', from: who.id })
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const member = url.searchParams.get('member')
    const join = url.searchParams.get('join') ?? ''
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    this.dropQuiet()
    if (member) {
      const unproven = this.ctx.getWebSockets('member').filter((ws) => !this.members().includes(ws))
      for (const old of unproven.slice(0, Math.max(0, unproven.length - MAX_UNPROVEN + 1))) old.close(4003, 'Sign in first')
      this.ctx.acceptWebSocket(server, ['member', `m:${member}`])
      server.serializeAttachment({ role: 'member', id: member, ok: false, since: Date.now() } satisfies TeamWho)
    } else {
      const waiting = this.ctx.getWebSockets('joiner')
      for (const old of waiting.slice(0, Math.max(0, waiting.length - MAX_JOINERS + 1))) old.close(4000, 'Too many are waiting to join')
      this.ctx.acceptWebSocket(server, ['joiner', `j:${join}`])
      server.serializeAttachment({ role: 'joiner', conn: join } satisfies TeamWho)
    }
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return
    if (message.length > MAX_MESSAGE) return ws.close(1009, 'Message too big')
    let frame: TeamFrame
    try {
      frame = JSON.parse(message) as TeamFrame
    } catch {
      return
    }
    const who = this.who(ws)
    if (who.role === 'joiner') {
      // A joiner speaks only of joining, and only to the members.
      if (typeof frame.d !== 'string' || typeof frame.p !== 'string' || !ID.test(frame.p)) return
      const out = JSON.stringify({ from: who.conn, p: frame.p, d: frame.d })
      for (const m of this.members()) send(m, out)
      return
    }
    if (!who.ok) return this.signIn(ws, who.id, frame)
    if (frame.t === 'admit') return this.admit(ws, frame)
    if (frame.t === 'expel') return this.expel(ws, who.id, frame)
    if (typeof frame.d !== 'string') return
    // To a joiner: one of the messages of joining.
    if (typeof frame.p === 'string' && ID.test(frame.p)) {
      if (typeof frame.to !== 'string' || !ID.test(frame.to)) return
      const out = JSON.stringify({ p: frame.p, d: frame.d })
      for (const j of this.ctx.getWebSockets(`j:${frame.to}`)) send(j, out)
      return
    }
    const out = JSON.stringify({ from: who.id, d: frame.d })
    if (typeof frame.to === 'string') {
      if (!ID.test(frame.to)) return
      for (const m of this.ctx.getWebSockets(`m:${frame.to}`)) if (this.members().includes(m)) send(m, out)
      return
    }
    for (const m of this.members()) if (m !== ws) send(m, out)
  }

  /**
   * A member's first message: its own key. The first to sign in to a new room founds the team;
   * after that only keys the members have let in are taken.
   */
  private async signIn(ws: WebSocket, id: string, frame: TeamFrame): Promise<void> {
    if (frame.t !== 'auth' || typeof frame.key !== 'string' || frame.key.length < 40 || frame.key.length > 100) {
      return ws.close(4003, 'Sign in first')
    }
    const hash = await sha256(frame.key)
    const list = (await this.ctx.storage.get<Record<string, string>>('members')) ?? {}
    if (!Object.keys(list).length) {
      list[id] = hash
      await this.ctx.storage.put('members', list)
    } else if (list[id] !== hash) {
      send(ws, { t: 'denied', reason: 'You are not in this team' })
      return ws.close(4003, 'Not a member')
    }
    for (const old of this.ctx.getWebSockets(`m:${id}`)) if (old !== ws) old.close(4000, 'Replaced by a newer connection')
    const others = this.online().filter((x) => x !== id)
    ws.serializeAttachment({ role: 'member', id, ok: true, since: Date.now() } satisfies TeamWho)
    send(ws, { t: 'members', ids: others })
    for (const m of this.members()) if (m !== ws) send(m, { t: 'join', from: id })
  }

  /** A member lets a new one in: the new member's id and the hash of the key it will sign in with. */
  private async admit(ws: WebSocket, frame: TeamFrame): Promise<void> {
    if (typeof frame.id !== 'string' || !ID.test(frame.id) || typeof frame.key !== 'string' || !/^[0-9a-f]{64}$/.test(frame.key)) return
    const list = (await this.ctx.storage.get<Record<string, string>>('members')) ?? {}
    if (!list[frame.id] && Object.keys(list).length >= MAX_MEMBERS) return send(ws, { t: 'full', id: frame.id })
    list[frame.id] = frame.key
    await this.ctx.storage.put('members', list)
    send(ws, { t: 'admitted', id: frame.id })
  }

  /** A member takes one out (itself, to leave): that key no longer gets in, and its connections close. */
  private async expel(ws: WebSocket, by: string, frame: TeamFrame): Promise<void> {
    if (typeof frame.id !== 'string' || !ID.test(frame.id)) return
    const list = (await this.ctx.storage.get<Record<string, string>>('members')) ?? {}
    if (!list[frame.id]) return
    delete list[frame.id]
    await this.ctx.storage.put('members', list)
    send(ws, { t: 'expelled', id: frame.id })
    for (const old of this.ctx.getWebSockets(`m:${frame.id}`)) {
      send(old, { t: 'denied', reason: frame.id === by ? 'You left this team' : 'You were removed from this team' })
      old.close(4004, 'Removed')
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason)
    } catch {
      // Closed already.
    }
    this.gone(ws)
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.gone(ws)
  }

  private gone(ws: WebSocket): void {
    const who = this.who(ws)
    if (who.role !== 'member' || !who.ok) return
    if (this.members().some((other) => other !== ws && this.idOf(other) === who.id)) return
    for (const m of this.members()) if (m !== ws) send(m, { t: 'leave', from: who.id })
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const team = url.pathname.match(/^\/v1\/team\/([A-Za-z0-9_-]{22})$/)?.[1]
    if (team) {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('This address takes WebSocket connections', { status: 426 })
      const member = url.searchParams.get('member') ?? ''
      const join = url.searchParams.get('join') ?? ''
      if (!ID.test(member) && !ID.test(join)) return new Response('Bad request', { status: 400 })
      // Teams connect Loom to Loom: no page is involved, so a browser has no business here.
      const origin = request.headers.get('Origin')
      if (origin !== null && origin !== url.origin) return new Response('Forbidden', { status: 403 })
      return env.TEAMS.get(env.TEAMS.idFromName(team)).fetch(request)
    }
    const room = url.pathname.match(/^\/v1\/room\/([A-Za-z0-9_-]{22})$/)?.[1]
    // Anything else is the page's business: its files, or its "not found" page.
    if (!room) return url.pathname.startsWith('/v1/') ? new Response('Not found', { status: 404 }) : env.ASSETS.fetch(request)
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('This address takes WebSocket connections', { status: 426 })
    const role = url.searchParams.get('role')
    const device = url.searchParams.get('device') ?? ''
    if (role !== 'pc' && !(role === 'phone' && ID.test(device))) return new Response('Bad request', { status: 400 })
    // Phones connect from this site's page only. Loom on the PC is no browser and sends no Origin.
    const origin = request.headers.get('Origin')
    if (role === 'phone' ? origin !== url.origin : origin !== null && origin !== url.origin) {
      return new Response('Forbidden', { status: 403 })
    }
    return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(request)
  }
} satisfies ExportedHandler<Env>
