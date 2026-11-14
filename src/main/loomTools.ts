// Tools Loom gives Claude in its chats, through an MCP server that lives in this process: nothing
// to start, nothing to install. They run dev servers. Claude Code stops a command it started in
// the background after two hours at most; a server started through here is one of Loom's own,
// which runs until someone stops it and shows in Dev servers in the status bar, where it can be
// opened, read, shared with a public link and stopped.

import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import type { RunTarget, ServerInfo } from '@shared/types'
import { listServers, serverLog, startServer, stopServer } from './servers'

type Sdk = typeof import('@anthropic-ai/claude-agent-sdk')

export const LOOM_SERVER = 'loom'
export const START_SERVER = `mcp__${LOOM_SERVER}__start_dev_server`
export const STOP_SERVER = `mcp__${LOOM_SERVER}__stop_dev_server`
export const SERVER_OUTPUT = `mcp__${LOOM_SERVER}__dev_server_output`
export const LIST_SERVERS = `mcp__${LOOM_SERVER}__list_dev_servers`

/** These only read: Claude may use them without asking. */
export const READ_ONLY_TOOLS = new Set([SERVER_OUTPUT, LIST_SERVERS])

const INSTRUCTIONS = [
  'Loom is the desktop app this chat runs in.',
  'To run anything meant to keep running (a dev server, a watcher, a local API, a database), use start_dev_server instead of Bash with run_in_background.',
  'Claude Code stops a background Bash command after two hours at most. A server started with start_dev_server keeps running until it is stopped, and the person sees it in Loom under Dev servers with its address and output, where they can open it, share it with a public link, or stop it.',
  'Read what it printed with dev_server_output, and stop it with stop_dev_server when asked to or when it is no longer needed.',
  'Commands that end by themselves (builds, tests, installs) still go through Bash.'
].join(' ')

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

export interface ToolHost {
  /** The folder the chat works in */
  cwd: string
  /** The project the chat belongs to, when it has one */
  projectId: string | null
  /** That project's folder, for naming a sub folder the short way */
  projectPath?: string | null
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function text(lines: (string | null | undefined | false)[]): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: lines.filter(Boolean).join('\n') }] }
}

function failure(message: string): { content: { type: 'text'; text: string }[]; isError: true } {
  return { content: [{ type: 'text', text: message }], isError: true }
}

/** The last lines a server printed, as plain text. */
function tail(id: string, lines: number): string {
  const log = serverLog(id)?.text ?? ''
  const clean = log.replace(ANSI, '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trimEnd()
  return clean.split('\n').slice(-lines).join('\n')
}

function stateLine(s: ServerInfo): string {
  switch (s.status) {
    case 'running':
      return s.url ? `Running at ${s.url}` : 'Running (it has not printed an address)'
    case 'starting':
      return s.installing ? 'Installing its packages first' : 'Starting'
    case 'stopping':
      return 'Stopping'
    case 'exited':
      return `It ended${s.exitCode != null ? ` with code ${s.exitCode}` : ''}${s.reason ? `: ${s.reason}` : ''}`
    default:
      return 'Stopped'
  }
}

function describe(s: ServerInfo): string {
  return `${s.id}\n  ${s.target.command} (in ${s.target.cwd})\n  ${stateLine(s)}`
}

/** A short name for a command: "npm run dev" is "dev", "php artisan serve" is "php artisan serve". */
function nameOf(command: string): string {
  const script = command.match(/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)/)?.[1]
  return script || command.split(/\s+/).slice(0, 3).join(' ')
}

/** Waits for a server to say where it is, to end, or for the time to run out; returns it as it is then. */
async function settle(id: string, ms: number): Promise<ServerInfo | undefined> {
  const until = Date.now() + ms
  for (;;) {
    const s = listServers().find((x) => x.id === id)
    if (!s || s.status === 'exited' || s.status === 'stopped' || (s.status === 'running' && s.url)) return s
    if (Date.now() >= until) return s
    await wait(300)
  }
}

/** The MCP server for one chat. The chat's folder is where its commands run unless told otherwise. */
export async function loomTools(sdk: Sdk, host: ToolHost): Promise<McpSdkServerConfigWithInstance> {
  // The same copy of zod the SDK reads schemas with.
  const { z } = await import('zod/v4')

  const start = sdk.tool(
    'start_dev_server',
    'Starts a long-running command (a dev server, a watcher, a local API) in Loom, where it keeps running until it is stopped and the person can see it. Use this instead of Bash with run_in_background for anything that should stay up. Returns its id, its address once it prints one, and what it printed so far.',
    {
      command: z.string().describe('The command, as typed in a terminal in that folder. Example: "npm run dev"'),
      cwd: z.string().optional().describe("The folder to run it in: absolute, or relative to this chat's folder. Leave out for the chat's folder."),
      name: z.string().optional().describe('A short name for it, such as "dev" or "api"')
    },
    async (args) => {
      const command = args.command.trim()
      if (!command) return failure('There is no command to run.')
      const cwd = args.cwd ? (isAbsolute(args.cwd) ? resolve(args.cwd) : resolve(host.cwd, args.cwd)) : host.cwd
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return failure(`That folder does not exist: ${cwd}`)
      const root = host.projectPath || host.cwd
      const where = relative(root, cwd).replace(/\\/g, '/')
      const key = createHash('sha1').update(`${cwd.toLowerCase()}\n${command}`).digest('hex').slice(0, 10)
      const target: RunTarget = {
        id: `claude#${key}`,
        script: (args.name || nameOf(command)).slice(0, 40),
        where: where && !where.startsWith('..') ? where : '',
        command,
        cwd,
        detail: command
      }
      const projectId = host.projectId ?? ''
      const id = `${projectId}|${target.id}`
      const before = listServers().find((x) => x.id === id)
      const already = !!before && (before.status === 'running' || before.status === 'starting')
      await startServer(projectId, target, false, 'claude')
      const s = await settle(id, 20_000)
      if (!s) return failure('Loom could not start it.')
      const out = tail(id, 40)
      return text([
        already ? 'This was already running in Loom; it was left as it is.' : null,
        `Server id: ${s.id}`,
        stateLine(s),
        s.status === 'starting' ? 'It has not said where it is yet. Look again with dev_server_output in a moment.' : null,
        s.status === 'exited' ? null : 'It keeps running in Loom until it is stopped, with no time limit. The person sees it under Dev servers in the status bar.',
        out ? `\nOutput so far:\n${out}` : null
      ])
    }
  )

  const output = sdk.tool(
    'dev_server_output',
    'Shows how a server started in Loom is doing: whether it is running, its address, and the last lines it printed.',
    {
      id: z.string().describe('The server id, as start_dev_server or list_dev_servers gave it'),
      lines: z.number().int().min(1).max(400).optional().describe('How many of the last lines to return (60 by default)')
    },
    async (args) => {
      const s = listServers().find((x) => x.id === args.id)
      if (!s) return failure(`Loom has no server with the id ${args.id}. list_dev_servers shows the ones it has.`)
      const out = tail(s.id, args.lines ?? 60)
      return text([stateLine(s), out ? `\n${out}` : 'It has not printed anything.'])
    },
    { annotations: { readOnlyHint: true } }
  )

  const stop = sdk.tool(
    'stop_dev_server',
    'Stops a server running in Loom, and everything it started.',
    { id: z.string().describe('The server id, as start_dev_server or list_dev_servers gave it') },
    async (args) => {
      const s = listServers().find((x) => x.id === args.id)
      if (!s) return failure(`Loom has no server with the id ${args.id}. list_dev_servers shows the ones it has.`)
      if (s.status === 'exited') return text(['It had already ended.'])
      stopServer(s.id)
      const until = Date.now() + 8000
      while (Date.now() < until && listServers().some((x) => x.id === s.id && x.status === 'stopping')) await wait(200)
      return text([listServers().some((x) => x.id === s.id && x.status === 'stopping') ? 'It is stopping.' : 'Stopped.'])
    }
  )

  const list = sdk.tool(
    'list_dev_servers',
    'Lists the servers Loom is running or has just run, in every project: each with its id, command, folder and state.',
    {},
    async () => {
      const all = listServers()
      if (!all.length) return text(['Loom is not running any server.'])
      const mine = all.filter((x) => x.projectId === (host.projectId ?? ''))
      const others = all.filter((x) => !mine.includes(x))
      return text([
        mine.length ? `In this chat's project:\n${mine.map(describe).join('\n')}` : null,
        others.length ? `${mine.length ? '\n' : ''}In other projects:\n${others.map(describe).join('\n')}` : null
      ])
    },
    { annotations: { readOnlyHint: true } }
  )

  return sdk.createSdkMcpServer({ name: LOOM_SERVER, version: '1.0.0', instructions: INSTRUCTIONS, tools: [start, output, stop, list], alwaysLoad: true })
}
