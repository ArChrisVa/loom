// Teams: what the Looms of a team's members say to each other, PC to PC, through the relay.
//
// A team works on one repository that every member has on their own PC. Each member's chats in a
// project shared with the team show up for the others. Opening one copies its history to that PC
// and keeps it in step; one member at a time writes in a chat (holds its pen), on their own PC,
// with their own files and their own Claude account, and the pen passes on request.
//
// The relay keeps the list of who may connect and passes sealed messages along. Everything the
// members say is sealed with the team's key, which never reaches it.
//
// Joining:
//   A member makes an invitation: a link carrying the team's room and a secret good for one
//   person, for a few minutes. The newcomer's Loom connects as a joiner and swaps public keys with
//   the member's Loom, sealed with a key made from the secret, exactly as a phone is linked. Both
//   screens then show the same four digits, and the member lets the newcomer in on their own PC.
//   Only then is the team's key sent, sealed with the key the two worked out.

import type { ChatEvent } from './types'

export const TEAM_VERSION = 1

/** Members a team can have */
export const MAX_TEAM_MEMBERS = 12

/** How long an invitation can be used */
export const INVITE_MS = 15 * 60_000

/** The largest piece of a chat's history sent in one message, in bytes */
export const PIECE_BYTES = 384 * 1024

export interface TeamMember {
  id: string
  name: string
  joinedAt: number
}

/** A chat one member holds (is the one writing in), as the rest of the team sees it */
export interface TeamChat {
  sessionId: string
  title: string
  /** When it last changed (epoch ms) */
  lastAt: number
  /** The size of its history, in bytes */
  size: number
  status: 'idle' | 'working' | 'waiting'
  model?: string
  /** The member who started it */
  owner: string
}

/** Where a member's copy of a shared project stands in git */
export interface TeamRepo {
  branch: string | null
  changes: number
}

// ---------- What members send each other, sealed with the team's key ----------

export type TeamMsg =
  /** On connecting, and whenever the team changes: who I am and the team as I know it. The newest list (highest rev) is the one everyone keeps. */
  | { t: 'hello'; v: number; name: string; version: string; team: string; members: TeamMember[]; rev: number }
  /** The projects I share with this team, by the address of their git remote: all of them, replacing what I said before */
  | { t: 'projects'; keys: string[] }
  /** Every chat I hold in one shared project, replacing what I said before, and where my copy of it stands */
  | { t: 'chats'; project: string; chats: TeamChat[]; repo: TeamRepo | null }
  /**
   * Send me this chat's history from this line on; with follow, keep sending as it grows.
   * `ref` names the request: the pieces sent for it carry it, so pieces of an earlier request
   * still on their way are told apart and dropped.
   */
  | { t: 'want'; sessionId: string; from: number; follow: boolean; ref: string }
  /**
   * A piece of a chat's history file, as bytes in base64. `left` is how much follows this piece,
   * `total` the whole file, `root` the project's folder on the sender's PC (paths in the history
   * are under it, and become the receiver's own).
   */
  | { t: 'data'; sessionId: string; ref: string; bytes: string; left: number; total: number; root: string }
  /** That chat can't be had: it is gone, or kept private */
  | { t: 'nope'; sessionId: string }
  | { t: 'unfollow'; sessionId: string }
  /** What is happening in a chat right now, for the members following it */
  | { t: 'live'; sessionId: string; ev: ChatEvent }
  /** What I have typed in a chat's message box and not sent yet, for the members following it; empty when the box is */
  | { t: 'typing'; sessionId: string; text: string }
  /** Let me write in this chat */
  | { t: 'pen-ask'; sessionId: string }
  /** It is yours: its history has this many lines */
  | { t: 'pen-give'; sessionId: string; lines: number }
  | { t: 'pen-no'; sessionId: string; reason: 'busy' | 'gone' }

/** The sealed part of every message between members: the sender's connection and a count that only goes up. */
export interface TeamEnvelope {
  sid: string
  n: number
  ts: number
  m: TeamMsg
}

// ---------- Joining ----------

export type JoinUp = { t: 'join'; v: number; pub: string; name: string; id: string; auth: string }
export type JoinDown =
  /** A member has the request and is being asked. The newcomer can now work out the digits to compare. */
  | { t: 'confirm'; pub: string; by: string }
  /** Let in: the team, sealed with the key the two worked out */
  | { t: 'welcome'; sealed: string }
  | { t: 'join-failed'; reason: 'full' | 'version' | 'refused' }

/** What `welcome` holds */
export interface Welcome {
  key: string
  name: string
  members: TeamMember[]
  rev: number
}

// ---------- What Loom's windows are told ----------

export interface TeamStatus {
  id: string
  name: string
  relay: 'off' | 'connecting' | 'online' | 'error'
  error?: string
  me: string
  members: (TeamMember & { online: boolean })[]
  /** The projects shared with this team, by the address of their git remote */
  projects: string[]
  /** What each of the others shares with it, as last heard from them, by member */
  shares: Record<string, string[]>
  /** An invitation waiting to be used */
  invite: { url: string; expiresAt: number } | null
  /** People who opened it and wait to be let in */
  requests: { id: string; name: string; code: string }[]
}

/** A teammate started sharing projects that this PC does not share yet */
export interface TeamOffer {
  teamId: string
  team: string
  /** The teammate, by name */
  member: string
  /** The folders, on this PC, of the ones it has too: they can be shared at once */
  paths: string[]
  /** The ones it does not have, by the address of their git remote: to be cloned and added first */
  missing: string[]
}

/** How joining a team is going, on the newcomer's PC */
export interface TeamJoining {
  state: 'connecting' | 'waiting' | 'failed'
  /** The four digits to compare with the member's screen */
  code?: string
  /** Who is being asked */
  by?: string
  error?: string
}

/** A teammate's chat, as the sidebar lists it */
export interface TeamChatEntry extends TeamChat {
  teamId: string
  project: string
  /** The member writing in it, and their name */
  writer: string
  writerName: string
  ownerName: string
  online: boolean
  repo: TeamRepo | null
}

/** A chat on this PC that belongs to a team: who started it and who writes in it now */
export interface TeamLocal {
  teamId: string
  project: string
  owner: string
  writer: string
  /** Lines of its history on this PC */
  lines: number
}

/** A history being copied */
export interface TeamSync {
  sessionId: string
  got: number
  total: number
  done: boolean
  error?: string
}

export interface TeamsState {
  /** The name this PC goes by in its teams */
  name: string
  teams: TeamStatus[]
  /** Teammates' chats, by team and project */
  chats: TeamChatEntry[]
  /** Team chats that have a copy on this PC, by session id */
  local: Record<string, TeamLocal>
  /** Chats of mine kept out of the team */
  private: string[]
  joining: TeamJoining | null
}

// ---------- Helpers both sides of a team share ----------

/**
 * What a project goes by in a team: the address of its git remote, without how it is reached
 * (https or ssh, a user name, .git), so the same repository matches on every PC wherever its
 * folder is.
 */
export function projectKey(remote: string | null | undefined): string | null {
  if (!remote) return null
  let s = remote.trim()
  if (!s || /^[a-z]:[\\/]/i.test(s) || s.startsWith('/') || s.startsWith('.')) return null
  s = s
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^[^@/]+@/, '')
    .replace(/^([^/:]+):(\d+)\//, '$1/')
    .replace(/^([^/:]+):/, '$1/')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
  return s.toLowerCase() || null
}

export function inviteUrl(address: string, team: string, secret: string): string {
  return `${address}/team#t=${team}&s=${secret}`
}

/** Reads an invitation: the whole link, or just the part after the #. */
export function parseInvite(text: string): { team: string; secret: string } | null {
  const hash = text.trim().replace(/^[^#]*#/, '')
  const q = new URLSearchParams(hash)
  const team = q.get('t')
  const secret = q.get('s')
  const ID = /^[A-Za-z0-9_-]{22}$/
  return team && secret && ID.test(team) && ID.test(secret) ? { team, secret } : null
}

/** What a message between members is sealed for: one team, one sender */
export function teamContext(team: string, from: string): string {
  return `loom-team ${team} ${from}`
}

/** What the two messages of joining are sealed for */
export function joinContext(pairId: string, dir: 'up' | 'down'): string {
  return `loom-team join ${pairId} ${dir}`
}
