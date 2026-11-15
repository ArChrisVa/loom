import { create } from 'zustand'
import {
  THREAD_COLORS,
  isStarterModels,
  type BrowserTab,
  type ChatBrief,
  type ChatContextText,
  type ChatEvent,
  type ChatItem,
  type ChatStatus,
  type ChatTab,
  type ClaudeInfo,
  type ContextInfo,
  type EffortLevel,
  type DiffTab,
  type GitChanges,
  type GitStatus,
  type Group,
  type ImageAttachment,
  type ImagePreview,
  type LayoutNode,
  type LoomSettings,
  type PermissionMode,
  type PermissionRequest,
  type PermissionResponse,
  type PersistedState,
  type Project,
  type RunTarget,
  type ServerInfo,
  type SessionSummary,
  type SubFolder,
  type TerminalTab,
  type SlashCommandInfo,
  type Tab,
  type TabSnapshot,
  type TrashedChat,
  type UpdateStatus,
  type AgentTask,
  type UsageSnapshot,
  type TunnelInfo
} from '@shared/types'
import type { RemoteStatus } from '@shared/remote'
import type { TeamChatEntry, TeamLocal, TeamMember, TeamsState, TeamStatus, TeamSync } from '@shared/team'
import {
  cleanLayout,
  inFileRow,
  mapPanes,
  newPane,
  paneById,
  paneOfTab,
  panesOf,
  presetLayout,
  PRESETS,
  removePane,
  setPaneTab,
  setSizes,
  splitPane as splitLayout,
  type Edge,
  type PresetName
} from './lib/layout'
import { baseName, isInside, joinPath, normPath, parentDir, projectForPath, shortPath, thumbnailOf, uid } from './lib/paths'
import { notesFor, notesSince, type ReleaseNotes } from './whatsNew'
import { playTone } from './lib/tones'

export interface ChatRuntime {
  items: ChatItem[]
  /**
   * Your messages sent while Claude was mid-thought or mid-reply, by id. They show below what is
   * being written (where you are looking, not above a long thought), and when that step is done
   * it takes its place before them.
   */
  late?: string[]
  /** You switched the model and the timeline says so: Claude's own note on the next reply would repeat it */
  switchNoted?: boolean
  status: ChatStatus
  error?: string
  permissions: PermissionRequest[]
  historyState: 'none' | 'loading' | 'loaded' | 'error'
  historyTotal: number
  activeModel?: string
  permissionMode: PermissionMode | null
  commands: SlashCommandInfo[]
  unread: boolean
  opened: boolean
  draft: string
  startedAt?: number
  /** How full the context window is */
  context?: ContextInfo
  /** Sub-agents and background tasks running now */
  tasks: AgentTask[]
  /** Images waiting in the message box */
  attachments: ImageAttachment[]
  /** Other chats waiting in the message box, to go with the next message as background */
  briefs: ChatBrief[]
  /** Being moved to another project: no messages until it's done */
  moving?: boolean
  /** What Claude Code is doing besides answering, such as compacting the conversation */
  activity?: 'compacting' | null
  /** Text Stop took back from messages Claude hadn't read yet, for the message box to take in */
  refill?: { text: string; key: number }
}

/**
 * What streams in many times a second: the reply being written and the thought in progress, per
 * chat tab. Kept apart from the main store so a streaming chat redraws only itself.
 */
export const useLive = create<{ partial: Record<string, string>; thinking: Record<string, { text: string; since: number } | null> }>(() => ({
  partial: {},
  thinking: {}
}))

function clearLive(tabId: string, which: 'all' | 'thinking' = 'all'): void {
  const l = useLive.getState()
  if (!(tabId in l.thinking) && (which === 'thinking' || !(tabId in l.partial))) return
  useLive.setState((s) => {
    const thinking = { ...s.thinking }
    delete thinking[tabId]
    if (which === 'thinking') return { thinking }
    const partial = { ...s.partial }
    delete partial[tabId]
    return { thinking, partial }
  })
}

/**
 * Keeps the main process told which files have unsaved edits in this window, so quitting or
 * restarting for an update can say so first.
 */
function reportUnsaved(get: () => { tabs: Tab[]; dirtyFiles: Record<string, boolean> }): void {
  // Null so the first report always goes: after a reload the list kept for this window is the old one.
  let last: string | null = null
  const send = (): void => {
    const s = get()
    const names = s.tabs.filter((t) => t.kind === 'file' && s.dirtyFiles[t.id]).map((t) => t.title)
    const key = names.join('\n')
    if (key === last) return
    last = key
    window.loom.reportUnsaved(names)
  }
  send()
  useStore.subscribe((s, prev) => {
    if (s.dirtyFiles !== prev.dirtyFiles || s.tabs !== prev.tabs) send()
  })
}

/** A chat with nothing in it yet; a shared value, so selectors that fall back to it stay stable. */
export const EMPTY_CHAT: ChatRuntime = Object.freeze(newChatRuntime()) as ChatRuntime

/** This window shows one tab that was moved out of the main window. */
export const POPOUT_TAB = new URLSearchParams(location.search).get('popout')

/** Unsaved text of open file tabs, read when a tab moves to another window. FileView keeps it current. */
export const liveDrafts = new Map<string, () => string | null>()
/** Saves an open file tab; false when it couldn't be saved (changed on disk, write failed). FileView registers it. */
export const fileSavers = new Map<string, () => Promise<boolean>>()

export interface ConfirmChoice {
  id: string
  label: string
  kind?: 'primary' | 'danger' | 'ghost'
}

export interface ConfirmRequest {
  title: string
  body?: string
  /** What it affects, listed under the message */
  items?: string[]
  choices: ConfirmChoice[]
  /** Picked by Esc or a click outside */
  cancel: string
  /** Where keyboard focus starts; the cancel choice when unset */
  focus?: string
  /** A text box under the message; Enter picks the first choice */
  input?: { value: string; placeholder?: string; select?: [number, number] }
  /** Digits to compare with another screen, shown large under the message */
  code?: string
  /** The phone this question is about, when it asks whether to link one */
  linkRequest?: string
}

/**
 * Settings shows over the whole work area instead of inside a pane, so opening and closing it
 * leaves the panes exactly as they were.
 */
export function isOverlayTab(tab: Pick<Tab, 'kind'> | undefined | null): boolean {
  return tab?.kind === 'settings'
}

/** Tabs in the order they appear: the top row, then the files row. */
export function tabsInOrder(tabs: Tab[]): Tab[] {
  return [...tabs.filter((t) => !inFileRow(t)), ...tabs.filter((t) => inFileRow(t))]
}

/** A chat in the middle of something: a turn, a question for you, or agents still running. */
export function chatBusy(c: ChatRuntime | undefined): boolean {
  return !!c && (chatWorking(c) || c.permissions.length > 0)
}

/** Claude, or agents it started, at work in this chat. */
export function chatWorking(c: ChatRuntime | undefined): boolean {
  return !!c && (c.status === 'running' || c.status === 'starting' || (c.tasks?.length ?? 0) > 0)
}

export interface MenuItem {
  label: string
  /** A line that names the items under it, and cannot be picked */
  heading?: boolean
  onSelect?: () => void
  danger?: boolean
  disabled?: boolean
  checked?: boolean
  separator?: boolean
  submenu?: MenuItem[]
}

export interface MenuState {
  x: number
  y: number
  items: MenuItem[]
  /** Opens upwards from the point, for a button at the bottom of the window */
  above?: boolean
}

type PersistedKeys = keyof PersistedState

interface Store extends PersistedState {
  ready: boolean
  info: ClaudeInfo | null
  chats: Record<string, ChatRuntime>
  terminals: Record<string, { exited: boolean; code?: number; started: boolean }>
  dirtyFiles: Record<string, boolean>
  sessions: SessionSummary[]
  git: Record<string, GitStatus | null>
  /** The Changes panel's view of each project: files, branch, upstream */
  gitChanges: Record<string, GitChanges | null>
  menu: MenuState | null
  icons: Record<string, string | null>
  /** Images chosen for groups, by group id. Groups that borrow a project's icon read `icons`. */
  groupIcons: Record<string, string | null>
  /** What each project can run, by project id. Missing until detected. */
  runTargets: Record<string, RunTarget[]>
  servers: ServerInfo[]
  /** Public links to dev servers (Cloudflare Quick Tunnels): open, on their way, or failed lately */
  tunnels: TunnelInfo[]
  /** Whether Cloudflare is set up on this PC (cloudflared installed, or signed in), so sharing is offered */
  canShare: boolean
  /** Looks again whether Cloudflare is set up here, for the share buttons */
  checkSharing: () => Promise<void>
  /** Opens a public link to a running server, offering to install cloudflared when it's missing */
  shareServer: (serverId: string) => Promise<void>
  stopSharing: (serverId: string) => void
  /** The installed app's updates: checking, downloading, ready to restart */
  update: UpdateStatus | null
  /** Folders that appeared in a group's watched folder and aren't projects yet, by group id */
  watchNew: Record<string, SubFolder[]>
  /** The image viewer, open on one of a message's images */
  viewer: { images: ImagePreview[]; index: number } | null
  confirm: (ConfirmRequest & { resolve: (choice: string, text?: string) => void }) | null
  /** Bumped when files may have changed, so open folders in the Files panel read again */
  treeVersion: number
  toasts: { id: string; text: string; action?: ToastAction }[]
  /** Which part of Settings is showing */
  settingsSection: SettingsSection
  /** Chats in the recycle bin, newest first; null until first looked at */
  trash: TrashedChat[] | null
  layout: LayoutNode
  /** The pane you're working in: the tab bar and new tabs act on it. */
  focusedPane: string
  /** A tab being dragged, so panes can offer to take it */
  draggingTab: string | null
  /** The last pane change came from a click inside it, so the view keeps the focus that click gave */
  pointerFocus: boolean
  /** Tabs showing in windows of their own (main window only) */
  detached: Record<string, true>
  /** Unsaved file text handed over from another window, used once by the file's view */
  fileDrafts: Record<string, string>
  usage: UsageSnapshot | null
  /** Files are being dragged over the window from outside (File Explorer, the desktop) */
  fileDrag: boolean
  /**
   * Opens files as tabs and adds folders as projects: dropped from outside, picked with Ctrl+O, or
   * sent by "Open with". `at`: where they were dropped, to open them in the pane under that point.
   */
  openPaths: (paths: string[], at?: { x: number; y: number }) => Promise<void>
  /** Ctrl+O: choose files to open */
  pickAndOpenFiles: () => Promise<void>
  /** What's new, open: the release notes shown after an update, or from Settings */
  whatsNew: ReleaseNotes[] | null
  /** Opens What's new for the version running now (Settings) */
  showWhatsNew: () => void
  /** The Plan limits popover is open: from the status bar's meters, or /usage in a chat */
  usageOpen: boolean
  /** A fresh reading of the plan limits is on its way */
  usageChecking: boolean
  /** Opens the Plan limits popover with a fresh reading, whatever the chats are doing (/usage) */
  showUsage: () => void
  /** Phone access: whether it is on, and the phones linked (main window only) */
  remote: RemoteStatus | null
  /** Teams: who is in them, the chats teammates share, and which chats here belong to one */
  team: TeamsState | null
  /** What a team calls each project here (the address of its git remote), by project id */
  teamKeys: Record<string, string | null>
  /** Histories being copied from a teammate, by chat */
  teamSync: Record<string, TeamSync>
  refreshTeamKeys: () => Promise<void>
  /** What the teammate writing in a followed chat has typed and not sent yet, by chat */
  teamTyping: Record<string, string>
  /** Shares a project with a team, or stops; says what the teammates still have to do for its chats to show */
  shareProject: (teamId: string, path: string, on: boolean) => Promise<void>
  /** Copies a teammate's chat to this PC, opens it in a tab and follows it as it grows */
  openTeamChat: (entry: TeamChatEntry) => Promise<void>
  /** Asks whoever writes in a chat this PC follows to pass it on, so Claude works in it here */
  takeOverChat: (tabId: string) => Promise<void>
  /** A copy of a team chat that is this PC's own from there on */
  copyTeamChat: (tabId: string) => Promise<void>
  /** Reads a chat's history again, taking the place of what the tab shows */
  reloadHistory: (tabId: string) => Promise<void>
  history: string[]
  quickOpen: boolean
  /** Settings is waiting for a key combination: shortcuts stand down meanwhile */
  recordingKeys: boolean
  editingProjectId: string | null
  editingGroupId: string | null

  init: () => Promise<void>
  set: (patch: Partial<Store>) => void

  addProject: (path: string, groupId?: string | null) => Project
  pickAndAddProject: (groupId?: string | null) => Promise<void>
  updateProject: (id: string, patch: Partial<Project>) => void
  removeProject: (id: string) => void
  addGroup: (name?: string) => string
  updateGroup: (id: string, patch: Partial<Group>) => void
  deleteGroup: (id: string) => void
  /** Starts watching a folder for a group. Folders made in the last day count as new. */
  watchFolder: (groupId: string, path: string) => Promise<void>
  unwatchFolder: (groupId: string) => void
  /** Looks in every watched folder for folders that aren't projects or offered before. */
  checkWatched: () => Promise<void>
  /** Adds offered folders to the group as projects */
  addWatched: (groupId: string, folders: SubFolder[]) => void
  /** Stops offering these folders */
  hideWatched: (groupId: string, folders: SubFolder[]) => void
  moveProject: (projectId: string, groupId: string | null, beforeProjectId?: string | null) => void
  /** Puts a group before another one in the sidebar, or last when none is named. */
  moveGroup: (groupId: string, beforeGroupId?: string | null) => void

  activate: (tabId: string) => void
  openTab: (tab: Tab) => void
  /** `closing` names tabs being closed along with it, so none of them is put in its pane. */
  closeTab: (tabId: string, closing?: Set<string>) => void
  moveTab: (tabId: string, toIndex: number) => void
  updateTab: (tabId: string, patch: Partial<Tab>) => void
  newChat: (projectId: string | null) => void
  openSession: (session: SessionSummary) => void
  /** Moves a chat to another project: its history goes with it, and Claude works in the new folder. */
  moveChat: (ref: { tabId?: string; session?: SessionSummary }, projectId: string) => Promise<void>
  /** Deletes a chat: its tab closes and it goes to the recycle bin, from where it can be put back. */
  deleteChat: (ref: { tabId?: string; session?: SessionSummary }) => Promise<void>
  refreshTrash: () => Promise<void>
  /** Puts a chat in the recycle bin back in its project. */
  restoreChat: (sessionId: string) => Promise<boolean>
  /** Deletes chats in the recycle bin for good, after asking; 'all' empties it. */
  purgeTrash: (ids: string[] | 'all') => Promise<void>
  openFile: (path: string, projectId?: string | null) => void
  newTerminal: (projectId: string | null, cwd?: string) => void
  /** Opens Settings, on the given part when one is named */
  openSettings: (section?: SettingsSection) => void
  /** The getting-started steps, in a tab of their own. */
  openStart: () => void
  /** Runs Anthropic's Claude Code installer in a terminal beside the getting-started steps. */
  openInstallTerminal: () => void
  /** Opens a terminal tab that runs one command, such as a tool's own sign-in */
  runInTerminal: (title: string, run: string) => void

  chat: (tabId: string) => ChatRuntime
  loadHistory: (tabId: string) => Promise<void>
  /** id: the message's own, when whoever sent it (a linked phone) already made one */
  /** `background`: "Send to background", Claude hands the job to a background agent and stays free */
  /** `context`: other chats brought in as background, their summaries sent along */
  send: (tabId: string, text: string, images: ImageAttachment[], id?: string, background?: boolean, context?: ChatContextText[]) => Promise<void>
  /** Puts another chat in the message box, and has its summary written for Claude to get with the next message */
  bringIn: (tabId: string, chat: { sessionId: string; title: string; from?: string }) => Promise<void>
  dropBrief: (tabId: string, sessionId: string) => void
  interrupt: (tabId: string) => void
  setModel: (tabId: string, model: string | null) => void
  setMode: (tabId: string, mode: PermissionMode) => void
  /** The chat's next permission mode, in the order the menu lists them (Shift+Tab) */
  cycleMode: (tabId: string) => void
  setEffort: (tabId: string, effort: EffortLevel | null) => void
  setUltracode: (tabId: string, on: boolean) => void
  loadIcon: (projectId: string) => Promise<void>
  loadGroupIcon: (groupId: string) => Promise<void>
  /** Moves a tab into a window of its own; `at` is where on screen, when it was dragged out. */
  popOut: (tabId: string, at?: { x: number; y: number }) => void
  /** A tab's live state, for handing it to another window */
  snapshotOf: (tabId: string) => TabSnapshot | null
  focusPane: (paneId: string, byPointer?: boolean) => void
  /** Fetches the chat's commands and skills before it has started, so the / menu has them all. */
  loadCommands: (tabId: string) => Promise<void>
  /** Remembers a choice made in a chat's message box, so the next chat starts with it. */
  /** The options a new or reopened chat starts with: the ones you picked last. */
  chatDefaults: () => Pick<ChatTab, 'model' | 'permissionMode' | 'effort' | 'ultracode'>
  /** Opens a project's site in a browser tab, beside what you're working on. */
  openPreview: (projectId: string | null, url?: string, beside?: boolean) => void
  /** Adds a pane beside one (the focused one by default) showing the tab, or the last tab not on screen. */
  splitPane: (edge: Edge, tabId?: string | null, paneId?: string) => void
  /** Shows a tab in a pane; if it was showing elsewhere, the two swap. */
  moveTabToPane: (tabId: string, paneId: string) => void
  /** Moves a pane, with what it shows, beside another one; dropped on its middle, the two swap. */
  movePane: (fromPaneId: string, zone: Edge | 'center', targetPaneId: string) => void
  closePane: (paneId?: string) => void
  applyPreset: (name: PresetName) => void
  resizeSplit: (splitId: string, sizes: number[]) => void
  loadRunTargets: (projectId: string) => Promise<RunTarget[]>
  /** Starts the given target, or the project's usual one. */
  runProject: (projectId: string, targetId?: string) => Promise<void>
  stopServer: (serverId: string) => void
  /** Runs a server again; `install` installs its project's dependencies first. */
  restartServer: (serverId: string, install?: boolean) => void
  dismissServer: (serverId: string) => void
  showServerOutput: (serverId: string) => void
  refreshUsage: (force?: boolean) => Promise<void>
  /** Asks Claude Code for the account's models when the list is still the short one Loom starts with. */
  ensureModels: () => void
  respond: (tabId: string, requestId: string, response: PermissionResponse) => void
  setDraft: (tabId: string, draft: string) => void
  setAttachments: (tabId: string, attachments: ImageAttachment[]) => void
  handleChatEvent: (tabId: string, event: ChatEvent) => void

  refreshSessions: (force?: boolean) => Promise<void>
  refreshGit: (projectId: string) => Promise<void>
  /** Git state of every project, a few at a time, for the sidebar's git marks. */
  refreshAllGit: () => Promise<void>
  refreshChanges: (projectId: string) => Promise<void>
  /** A file's changes in a tab: uncommitted ones, or the ones made in a commit. */
  openDiff: (projectId: string | null, path: string, commit?: string, commitLabel?: string) => void
  showMenu: (e: { clientX: number; clientY: number }, items: MenuItem[], above?: boolean) => void
  /** Asks a question in Loom's own dialog; resolves with the id of the choice picked. */
  ask: (req: ConfirmRequest) => Promise<string>
  /** `action`: one thing to do about it, such as Undo */
  showToast: (text: string, action?: ToastAction) => void
  dismissToast: (id: string) => void
  /** Asks for a name; null when cancelled or left empty. */
  askText: (req: { title: string; body?: string; value: string; placeholder?: string; select?: [number, number]; confirm: string }) => Promise<string | null>
  bumpTree: () => void
  createEntry: (dir: string, kind: 'file' | 'folder', projectId: string | null) => Promise<void>
  renameEntry: (path: string) => Promise<void>
  trashEntry: (path: string, isDir: boolean) => Promise<void>
  /** Closes tabs the way a person asks to: offers to save unsaved files, warns about working chats. */
  requestClose: (tabIds: string[]) => Promise<boolean>
  requestRemoveProject: (id: string) => Promise<void>
  /** Tabs closed in this session, newest last, for Reopen closed tab */
  closedTabs: Tab[]
  /** Where each of them was showing when it closed: its pane, and the split as it was then. */
  closedPlaces: Record<string, { paneId: string; layout: LayoutNode }>
  reopenClosed: () => void
  /** Starts the window over from what is saved, after asking about unsaved files. Chats, terminals and servers carry on. */
  reloadApp: () => Promise<void>
  requestDeleteGroup: (id: string) => Promise<void>
}

/** The parts of Settings, in the order they are listed */
export type SettingsSection = 'accounts' | 'claude' | 'notifications' | 'keyboard' | 'phone' | 'team' | 'terminal' | 'trash' | 'about'

/**
 * A chat's place in a team, when it has one: the team, whether this PC is the one writing in it,
 * and who is when it isn't.
 */
export function teamRole(
  team: TeamsState | null,
  sessionId: string | null | undefined
): { local: TeamLocal; team: TeamStatus; mine: boolean; writerName: string; online: boolean } | null {
  const l = sessionId ? team?.local[sessionId] : undefined
  const t = l ? team!.teams.find((x) => x.id === l.teamId) : undefined
  if (!l || !t) return null
  const writer = t.members.find((m) => m.id === l.writer)
  return { local: l, team: t, mine: l.writer === t.me, writerName: writer?.name ?? 'A teammate', online: !!writer?.online }
}

/** The teammates who share a project (by the address of its git remote) with a team, besides this PC */
export function sharersOf(t: TeamStatus, key: string | null | undefined): (TeamMember & { online: boolean })[] {
  return key ? t.members.filter((m) => m.id !== t.me && (t.shares[m.id] ?? []).includes(key)) : []
}

/** "Maria", "Maria and Chris", "Maria, Chris and Dana" */
export function namesOf(people: { name: string }[]): string {
  const names = people.map((p) => p.name)
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** How many other chats one message can bring along */
export const MAX_BRIEFS = 4

/** The chats the last few messages brought along, by message: Stop gives them back with a message it takes back. */
const sentContext = new Map<string, ChatContextText[]>()

/** Forgets what a teammate was typing in a chat. */
function clearTyping(sessionId: string): void {
  useStore.setState((s) => {
    if (!(sessionId in s.teamTyping)) return s
    const teamTyping = { ...s.teamTyping }
    delete teamTyping[sessionId]
    return { teamTyping }
  })
}

/** When each followed chat last heard from its writer as it happened */
const teamLiveAt = new Map<string, number>()
const teamReloads = new Map<string, ReturnType<typeof setTimeout>>()

/** One thing a toast offers to do, such as Undo */
export interface ToastAction {
  label: string
  run: () => void
}

export function newChatRuntime(): ChatRuntime {
  return {
    items: [],
    status: 'idle',
    permissions: [],
    tasks: [],
    attachments: [],
    briefs: [],
    historyState: 'none',
    historyTotal: 0,
    permissionMode: null,
    commands: [],
    unread: false,
    opened: false,
    draft: ''
  }
}

const PERSISTED: PersistedKeys[] = [
  'version',
  'projects',
  'groups',
  'tabs',
  'activeTabId',
  'layout',
  'focusedPane',
  'onboarded',
  'settings',
  'sidebarWidth',
  'sidebarOpen',
  'rightPanelOpen',
  'rightPanelWidth',
  'rightPanelView',
  'knownModels'
]

function pickPersisted(s: Store): PersistedState {
  const out: Record<string, unknown> = {}
  for (const k of PERSISTED) out[k] = s[k]
  return out as unknown as PersistedState
}

function nextColor(projects: Project[]): Project['color'] {
  const used = new Map<string, number>()
  for (const p of projects) used.set(p.color, (used.get(p.color) ?? 0) + 1)
  return [...THREAD_COLORS].sort((a, b) => (used.get(a) ?? 0) - (used.get(b) ?? 0))[0]
}

/** When the account's models were last asked for because the list was still the starter one */
let modelsAskedAt = 0

/** Titles Claude wrote for new chats that had no id yet to be saved under, by tab. */
const titlesToSave = new Map<string, string>()

function chatTitleFrom(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > 44 ? `${one.slice(0, 44)}…` : one || 'New chat'
}

export const useStore = create<Store>((set, get) => {
  const patchChat = (tabId: string, fn: (c: ChatRuntime) => Partial<ChatRuntime>): void => {
    set((s) => {
      // Late news for a tab that has closed (a history load, a last event) stays dropped.
      if (!s.tabs.some((t) => t.id === tabId)) return s
      const cur = s.chats[tabId] ?? newChatRuntime()
      return { chats: { ...s.chats, [tabId]: { ...cur, ...fn(cur) } } }
    })
  }

  const ensureOpened = async (tab: ChatTab): Promise<void> => {
    const c = get().chat(tab.id)
    if (c.opened) return
    await window.loom.chatOpen(tab.id, {
      cwd: tab.cwd,
      projectId: tab.projectId,
      projectPath: get().projects.find((p) => p.id === tab.projectId)?.path ?? null,
      sessionId: tab.sessionId,
      model: tab.model ?? null,
      permissionMode: tab.permissionMode ?? null,
      effort: tab.effort ?? null,
      ultracode: tab.ultracode === true
    })
    patchChat(tab.id, () => ({ opened: true }))
  }

  return {
    version: 1,
    projects: [],
    groups: [],
    tabs: [],
    activeTabId: null,
    settings: {
      claudeSource: 'bundled',
      claudeCustomPath: '',
      shell: 'powershell',
      sendWithCtrlEnter: false,
      defaultPermissionMode: 'default',
      notifyWhenDone: true,
      keepChatBackupsDays: 30
    },
    sidebarWidth: 260,
    sidebarOpen: true,
    rightPanelOpen: false,
    rightPanelWidth: 280,
    rightPanelView: 'files',
    knownModels: [],
    onboarded: undefined,

    ready: false,
    info: null,
    chats: {},
    terminals: {},
    dirtyFiles: {},
    sessions: [],
    git: {},
    gitChanges: {},
    menu: null,
    icons: {},
    groupIcons: {},
    runTargets: {},
    servers: [],
    tunnels: [],
    canShare: false,
    update: null,
    watchNew: {},
    viewer: null,
    confirm: null,
    toasts: [],
    settingsSection: 'accounts',
    trash: null,
    closedTabs: [],
    closedPlaces: {},
    treeVersion: 0,
    layout: { kind: 'pane', id: 'main', tabId: null },
    focusedPane: 'main',
    draggingTab: null,
    pointerFocus: false,
    detached: {},
    fileDrafts: {},
    usage: null,
    fileDrag: false,
    whatsNew: null,
    usageOpen: false,
    usageChecking: false,
    remote: null,
    team: null,
    teamKeys: {},
    teamSync: {},
    teamTyping: {},
    history: [],
    quickOpen: false,
    recordingKeys: false,
    editingProjectId: null,
    editingGroupId: null,

    init: async () => {
      const [state, info] = await Promise.all([window.loom.loadState(), window.loom.claudeInfo()])
      window.loom.onSnapshotRequest((tabId) => get().snapshotOf(tabId))
      window.loom.onBrowserShortcut((k) =>
        window.dispatchEvent(new KeyboardEvent('keydown', { key: k.key, code: k.code, ctrlKey: true, shiftKey: k.shift, altKey: k.alt, bubbles: true }))
      )
      if (POPOUT_TAB) {
        // A popout: it shows one tab, saves nothing, and sends its changes to the main window.
        window.loom.onChatEvent((tabId, event) => get().handleChatEvent(tabId, event))
        const got = await window.loom.popoutInit()
        if (!got) return
        const { tab, snapshot } = got
        const chat = snapshot?.chat as ChatRuntime | undefined
        set({
          projects: state.projects,
          groups: state.groups,
          settings: state.settings,
          knownModels: state.knownModels,
          tabs: [tab],
          layout: { kind: 'pane', id: 'main', tabId: tab.id },
          focusedPane: 'main',
          activeTabId: tab.id,
          chats: chat ? { [tab.id]: chat } : {},
          dirtyFiles: snapshot?.dirty ? { [tab.id]: true } : {},
          fileDrafts: snapshot?.fileDraft != null ? { [tab.id]: snapshot.fileDraft } : {},
          info,
          ready: true
        })
        window.loom.popoutReady()
        reportUnsaved(get)
        let sent = tab
        let sentChat = ''
        useStore.subscribe((st) => {
          const now = st.tabs[0]
          if (now && now !== sent) {
            sent = now
            window.loom.popoutTab(now)
          }
          // The main window keeps showing this chat's tab, sidebar row and status: keep them true.
          const c = now && st.chats[now.id]
          if (c) {
            const state = { status: c.status, permissions: c.permissions, tasks: c.tasks, unread: c.unread }
            const key = JSON.stringify([state.status, state.permissions.map((p) => p.requestId), state.tasks.map((t) => [t.id, t.toolUses]), state.unread])
            if (key !== sentChat) {
              sentChat = key
              window.loom.popoutChatState(now.id, state)
            }
          }
        })
        if (tab.projectId) {
          void get().loadIcon(tab.projectId)
          void get().loadRunTargets(tab.projectId)
        }
        window.loom.onServers((servers) => set({ servers }))
        void window.loom.serverList().then((servers) => set({ servers }))
        return
      }
      window.loom.onPopoutTab((tab) => set((st) => ({ tabs: st.tabs.map((t) => (t.id === tab.id ? tab : t)) })))
      window.loom.onPopoutChatState((tabId, state) => {
        if (get().detached[tabId]) patchChat(tabId, () => state)
      })
      window.loom.onPopoutReturned((tabId, snapshot) => {
        const st = get()
        if (!st.tabs.some((t) => t.id === tabId)) return
        const detached = { ...st.detached }
        delete detached[tabId]
        const patch: Partial<Store> = { detached }
        if (snapshot) {
          patch.tabs = st.tabs.map((t) => (t.id === tabId ? snapshot.tab : t))
          if (snapshot.chat) patch.chats = { ...st.chats, [tabId]: snapshot.chat as ChatRuntime }
          patch.dirtyFiles = { ...st.dirtyFiles, [tabId]: !!snapshot.dirty }
          // Whatever the other window had is now the truth: its unsaved text, or none because it
          // saved there. A copy parked here when the tab left must not come back over it.
          const fileDrafts = { ...st.fileDrafts }
          if (snapshot.fileDraft != null) fileDrafts[tabId] = snapshot.fileDraft
          else delete fileDrafts[tabId]
          patch.fileDrafts = fileDrafts
        }
        set(patch)
        get().activate(tabId)
      })
      window.loom.onMainDo((action, args) => {
        const st = get() as unknown as Record<string, (...a: unknown[]) => void>
        if (['openFile', 'openPaths', 'newChat', 'newTerminal', 'openSettings', 'openSession', 'showServerOutput', 'runProject', 'openPreview', 'openDiff', 'openStart'].includes(action)) st[action](...args)
      })
      // Server output tabs belong to servers that stopped when Loom last quit.
      const tabs = state.tabs.filter((t) => t.kind !== 'server')
      const paneTabs = tabs.filter((t) => !isOverlayTab(t))
      const fallback = paneTabs.some((t) => t.id === state.activeTabId) ? state.activeTabId : (paneTabs[0]?.id ?? null)
      let layout = cleanLayout(state.layout ?? { kind: 'pane', id: 'main', tabId: fallback }, new Set(tabs.filter((t) => !isOverlayTab(t)).map((t) => t.id)))
      let focused = paneById(layout, state.focusedPane ?? '') ?? panesOf(layout)[0]
      // A saved layout whose tabs are gone would open empty: show the last tab used instead.
      if (!focused.tabId && fallback && !panesOf(layout).some((p) => p.tabId === fallback)) {
        layout = setPaneTab(layout, focused.id, fallback)
        focused = paneById(layout, focused.id)!
      }
      set({ ...state, tabs, layout, focusedPane: focused.id, activeTabId: focused.tabId, info, ready: true })
      // First launch: nothing saved yet, so show the getting-started steps.
      if (state.onboarded === undefined && !state.projects.length && !tabs.some((t) => t.kind === 'start')) get().openStart()
      window.loom.onChatEvent((tabId, event) => get().handleChatEvent(tabId, event))
      // Started with files ("Open with" Loom), or sent some while running.
      window.loom.onOpenPaths((paths) => void get().openPaths(paths))
      void window.loom.launchPaths().then((paths) => {
        if (paths.length) void get().openPaths(paths)
      })
      let last = pickPersisted(get())
      let timer: ReturnType<typeof setTimeout> | null = null
      useStore.subscribe((s) => {
        if (!s.ready) return
        const changed = PERSISTED.some((k) => s[k] !== (last as unknown as Record<string, unknown>)[k])
        if (!changed) return
        last = pickPersisted(s)
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => window.loom.saveState(pickPersisted(get())), 250)
      })
      reportUnsaved(get)
      // A change made just before closing (a tab closed, a divider moved) is sent now, not lost.
      window.addEventListener('beforeunload', () => {
        if (!timer) return
        clearTimeout(timer)
        timer = null
        window.loom.saveState(pickPersisted(get()))
      })
      void get().refreshSessions(true)
      for (const p of get().projects) void get().loadIcon(p.id)
      for (const g of get().groups) void get().loadGroupIcon(g.id)
      for (const p of get().projects) void get().loadRunTargets(p.id)
      // Which projects are in git, for the sidebar: soon after start, then every few minutes.
      setTimeout(() => void get().refreshAllGit(), 1500)
      setInterval(() => {
        if (document.hasFocus()) void get().refreshAllGit()
      }, 3 * 60_000)
      // Watched folders: soon after start, every minute while Loom is in front, and on focus (App).
      setTimeout(() => void get().checkWatched(), 2000)
      setInterval(() => {
        if (document.hasFocus()) void get().checkWatched()
      }, 60_000)
      window.loom.onUpdate((update) => set({ update }))
      // Updated since last time: what's new, once. A first install has the getting-started steps
      // instead, and only notes the version.
      const existing = state.onboarded === true || state.projects.length > 0
      void window.loom.updateStatus().then((update) => {
        set({ update })
        const seen = get().settings.lastSeenVersion
        if (!update.announce || seen === update.version) return
        const notes = existing ? notesSince(seen ?? null, update.version) : []
        set((s) => ({ settings: { ...s.settings, lastSeenVersion: update.version }, ...(notes.length ? { whatsNew: notes } : {}) }))
      })
      window.loom.onServers((servers) => set({ servers }))
      void window.loom.serverList().then((servers) => set({ servers }))
      // A public link that just started answering: say so, with the link, naming the project.
      window.loom.onTunnels((tunnels) => {
        for (const t of tunnels) {
          const before = get().tunnels.find((x) => x.serverId === t.serverId)
          if (t.state !== 'live' || before?.state === 'live' || !t.url) continue
          const server = get().servers.find((x) => x.id === t.serverId)
          const name = get().projects.find((p) => p.id === server?.projectId)?.name ?? 'The site'
          get().showToast(`${name} is online at ${t.url}${t.path}${t.slow ? ' (it may take a minute more to open)' : ''}. Copy the link from Dev servers in the status bar.`)
        }
        set({ tunnels })
      })
      void window.loom.tunnelList().then((tunnels) => set({ tunnels }))
      void get().checkSharing()
      window.loom.onUsage((usage) => set({ usage }))
      window.loom.onModels((models) => models.length && set({ knownModels: models }))
      // Teams. Chats this window shows that a teammate writes in are followed again from the start.
      const followerTab = (sessionId: string): ChatTab | undefined => {
        const tab = get().tabs.find((t): t is ChatTab => t.kind === 'chat' && t.sessionId === sessionId)
        return tab && teamRole(get().team, sessionId)?.mine === false ? tab : undefined
      }
      void window.loom.teamState().then((team) => {
        set({ team })
        for (const t of get().tabs) if (t.kind === 'chat' && t.sessionId && teamRole(team, t.sessionId)?.mine === false) void window.loom.teamOpen(t.sessionId)
      })
      void get().refreshTeamKeys()
      window.loom.onTeamState((team) => set({ team }))
      window.loom.onTeamSync((sync) => set((s) => ({ teamSync: { ...s.teamSync, [sync.sessionId]: sync } })))
      // What the writer's Claude is doing right now shows here as it does there.
      window.loom.onTeamLive((sessionId, event) => {
        const tab = followerTab(sessionId)
        if (!tab) return
        teamLiveAt.set(sessionId, Date.now())
        // Their message is sent: what they were typing is in the chat now.
        if (event.type === 'items' && event.items.some((it) => it.kind === 'user')) clearTyping(sessionId)
        get().handleChatEvent(tab.id, event)
      })
      window.loom.onTeamTyping((sessionId, text) => {
        if (!text) return clearTyping(sessionId)
        set((s) => ({ teamTyping: { ...s.teamTyping, [sessionId]: text } }))
      })
      // A teammate shares a project this PC has too: offered once, where it can be taken up.
      window.loom.onTeamOffer((offer) => {
        const names = offer.paths.map((p) => projectForPath(get().projects, p)?.name ?? baseName(p))
        if (!names.length) {
          // None of them is on this PC: said, with what it takes, since nothing else here would show it.
          if (!offer.missing.length) return
          const what = offer.missing.length === 1 ? offer.missing[0] : `${offer.missing[0]} and ${offer.missing.length - 1} more`
          return get().showToast(`${offer.member} shares ${what} with ${offer.team}, which is not on this PC. Clone it and add its folder to Loom, then share it too.`, {
            label: 'Open Team',
            run: () => get().openSettings('team')
          })
        }
        const one = names.length === 1
        get().showToast(`${offer.member} shares ${one ? names[0] : `${names[0]} and ${names.length - 1} more`} with ${offer.team}. Share ${one ? 'it' : 'them'} too to see each other's chats there.`, {
          label: one ? 'Share it too' : 'Open Team',
          run: () => (one ? void get().shareProject(offer.teamId, offer.paths[0], true) : get().openSettings('team'))
        })
      })
      // More of the history arrived. Heard live already, there is nothing to add; otherwise
      // (this window opened it mid-way, or was away) the tab reads it again.
      window.loom.onTeamGrew((sessionId) => {
        const tab = followerTab(sessionId)
        if (!tab || Date.now() - (teamLiveAt.get(sessionId) ?? 0) < 5000 || teamReloads.has(sessionId)) return
        teamReloads.set(
          sessionId,
          setTimeout(() => {
            teamReloads.delete(sessionId)
            void get().reloadHistory(tab.id)
          }, 800)
        )
      })
      window.loom.onTeamPassed((sessionId, to) => {
        const tab = get().tabs.find((t) => t.kind === 'chat' && t.sessionId === sessionId)
        if (!tab) return
        patchChat(tab.id, () => ({ opened: false, status: 'idle' }))
        get().showToast(`${to} is writing in ${tab.title} now. You see it as it happens.`)
      })
      window.loom.onNotifySound((sound) => playTone(sound, get().settings.notifyVolume))
      // Quitting or restarting would lose something: asked in Loom's own dialog.
      window.loom.onAsk((id, req) => {
        window.loom.askShown(id)
        void get()
          .ask(req as ConfirmRequest)
          .then((choice) => window.loom.askReply(id, choice))
      })
      void window.loom.getUsage().then((usage) => usage && set({ usage }))
    },

    set: (patch) => set(patch),

    addProject: (path, groupId = null) => {
      const existing = get().projects.find((p) => normPath(p.path) === normPath(path))
      if (existing) return existing
      const project: Project = { id: uid(), name: baseName(path), path, color: nextColor(get().projects), groupId }
      set((s) => ({ projects: [...s.projects, project] }))
      void get().loadIcon(project.id)
      void get().loadRunTargets(project.id)
      void get().refreshGit(project.id)
      return project
    },
    pickAndAddProject: async (groupId = null) => {
      const path = await window.loom.pickFolder()
      if (path) get().addProject(path, groupId)
    },
    updateProject: (id, patch) => {
      set((s) => ({ projects: s.projects.map((p) => (p.id === id ? { ...p, ...patch } : p)) }))
      if ('iconMode' in patch || 'iconPath' in patch || 'path' in patch) void get().loadIcon(id)
      if ('path' in patch) void get().loadRunTargets(id)
    },
    removeProject: (id) => {
      const theirs = get().tabs.filter((t) => t.projectId === id)
      const closing = new Set(theirs.map((t) => t.id))
      for (const t of theirs) get().closeTab(t.id, closing)
      for (const sv of get().servers.filter((x) => x.projectId === id)) void window.loom.serverStop(sv.id)
      set((s) => ({ projects: s.projects.filter((p) => p.id !== id) }))
    },
    addGroup: (name = 'New group') => {
      const id = uid()
      set((s) => ({ groups: [...s.groups, { id, name }], editingGroupId: id }))
      return id
    },
    updateGroup: (id, patch) => {
      set((s) => ({ groups: s.groups.map((g) => (g.id === id ? { ...g, ...patch } : g)) }))
      if ('iconPath' in patch) void get().loadGroupIcon(id)
    },
    watchFolder: async (groupId, path) => {
      const now = Date.now()
      const folders = await window.loom.subfolders(path)
      // Everything already there counts as seen, except what arrived in the last day (a pull just now, say).
      const seen = folders.filter((f) => now - f.created > 24 * 60 * 60_000).map((f) => f.name)
      get().updateGroup(groupId, { watchPath: path, watchSeen: seen })
      await get().checkWatched()
    },
    unwatchFolder: (groupId) => {
      get().updateGroup(groupId, { watchPath: undefined, watchSeen: undefined })
      set((s) => {
        const watchNew = { ...s.watchNew }
        delete watchNew[groupId]
        return { watchNew }
      })
    },
    checkWatched: async () => {
      const watched = get().groups.filter((g) => g.watchPath)
      const found = await Promise.all(watched.map((g) => window.loom.subfolders(g.watchPath!)))
      const watchNew: Record<string, SubFolder[]> = {}
      watched.forEach((g, i) => {
        const seen = new Set(g.watchSeen ?? [])
        const fresh = found[i].filter((f) => !seen.has(f.name) && !get().projects.some((p) => normPath(p.path) === normPath(f.path)))
        if (fresh.length) watchNew[g.id] = fresh.sort((a, b) => a.name.localeCompare(b.name))
      })
      set({ watchNew })
    },
    addWatched: (groupId, folders) => {
      for (const f of folders) get().addProject(f.path, groupId)
      get().hideWatched(groupId, folders)
    },
    hideWatched: (groupId, folders) => {
      const g = get().groups.find((x) => x.id === groupId)
      if (!g) return
      const names = new Set(folders.map((f) => f.name))
      get().updateGroup(groupId, { watchSeen: [...new Set([...(g.watchSeen ?? []), ...names])] })
      set((s) => {
        const rest = (s.watchNew[groupId] ?? []).filter((f) => !names.has(f.name))
        const watchNew = { ...s.watchNew }
        if (rest.length) watchNew[groupId] = rest
        else delete watchNew[groupId]
        return { watchNew }
      })
    },
    deleteGroup: (id) =>
      set((s) => ({
        groups: s.groups.filter((g) => g.id !== id),
        projects: s.projects.map((p) => (p.groupId === id ? { ...p, groupId: null } : p))
      })),
    moveProject: (projectId, groupId, beforeProjectId) =>
      set((s) => {
        const moving = s.projects.find((p) => p.id === projectId)
        if (!moving) return {}
        const rest = s.projects.filter((p) => p.id !== projectId)
        const updated = { ...moving, groupId }
        const idx = beforeProjectId ? rest.findIndex((p) => p.id === beforeProjectId) : -1
        if (idx >= 0) rest.splice(idx, 0, updated)
        else rest.push(updated)
        return { projects: rest }
      }),
    moveGroup: (groupId, beforeGroupId) =>
      set((s) => {
        const moving = s.groups.find((g) => g.id === groupId)
        if (!moving || beforeGroupId === groupId) return {}
        const rest = s.groups.filter((g) => g.id !== groupId)
        const idx = beforeGroupId ? rest.findIndex((g) => g.id === beforeGroupId) : -1
        if (idx >= 0) rest.splice(idx, 0, moving)
        else rest.push(moving)
        return { groups: rest }
      }),

    activate: (tabId) => {
      if (get().detached[tabId]) {
        void window.loom.popoutFocus(tabId)
        return
      }
      if (isOverlayTab(get().tabs.find((t) => t.id === tabId))) {
        set((s) => ({ activeTabId: tabId, pointerFocus: false, history: [...s.history.filter((h) => h !== tabId), tabId].slice(-50) }))
        return
      }
      set((s) => {
        // Already on screen: go to its pane. Otherwise it takes the place of what the focused pane shows.
        const shown = paneOfTab(s.layout, tabId)
        return {
          layout: shown ? s.layout : setPaneTab(s.layout, s.focusedPane, tabId),
          focusedPane: shown ? shown.id : s.focusedPane,
          activeTabId: tabId,
          pointerFocus: false,
          history: [...s.history.filter((h) => h !== tabId), tabId].slice(-50)
        }
      })
      const c = get().chats[tabId]
      if (c?.unread) patchChat(tabId, () => ({ unread: false }))
      const tab = get().tabs.find((t) => t.id === tabId)
      if (tab?.projectId) void get().refreshGit(tab.projectId)
    },
    openTab: (tab) => {
      set((s) => ({ tabs: [...s.tabs, tab] }))
      get().activate(tab.id)
    },
    closeTab: (tabId, closing) => {
      const s = get()
      const tab = s.tabs.find((t) => t.id === tabId)
      if (!tab) return
      if (s.detached[tabId]) void window.loom.popoutDiscard(tabId)
      // Closing the steps counts as done with them: they don't come back by themselves.
      if (tab.kind === 'start') set({ onboarded: true })
      if (tab.kind === 'chat') void window.loom.chatClose(tabId)
      // A teammate's chat this PC was following: they need not keep sending it.
      if (tab.kind === 'chat' && tab.sessionId && teamRole(s.team, tab.sessionId)?.mine === false) void window.loom.teamUnfollow(tab.sessionId)
      if (tab.kind === 'terminal') void window.loom.ptyKill(tabId)
      const idx = s.tabs.findIndex((t) => t.id === tabId)
      const tabs = s.tabs.filter((t) => t.id !== tabId)
      // A pane that showed it is filled again from the open tabs not already on screen: one of the
      // same row first (a chat by a chat or a terminal, a file by a file), the one used most recently,
      // like an editor does, failing that the nearest neighbour. Tabs closing along with it don't count.
      const onScreen = new Set(panesOf(s.layout).map((p) => p.tabId))
      const fileRow = inFileRow(tab)
      const replacement = (): string | null => {
        const fits = (t: Tab | undefined): t is Tab => !!t && !onScreen.has(t.id) && !s.detached[t.id] && !closing?.has(t.id) && !isOverlayTab(t)
        const recent = [...s.history].reverse().map((h) => tabs.find((t) => t.id === h)).filter(fits)
        const near = tabs.map((t, i) => ({ t, d: Math.abs(i - idx) })).filter((x) => fits(x.t)).sort((a, b) => a.d - b.d).map((x) => x.t)
        const pick = recent.find((t) => inFileRow(t) === fileRow) ?? near.find((t) => inFileRow(t) === fileRow) ?? recent[0] ?? near[0]
        return pick?.id ?? null
      }
      let layout = s.layout
      let focusedPane = s.focusedPane
      for (const p of panesOf(s.layout)) {
        if (p.tabId !== tabId) continue
        const next = replacement()
        const list = panesOf(layout)
        if (!next && list.length > 1) {
          // Nothing left to show in it, with the screen split: the pane goes and the others take its
          // room; the keyboard moves to its neighbour, as closing a pane does.
          const at = list.findIndex((x) => x.id === p.id)
          layout = removePane(layout, p.id)
          if (focusedPane === p.id) {
            const left = panesOf(layout)
            focusedPane = left[Math.max(0, Math.min(at - 1, left.length - 1))].id
          }
          continue
        }
        layout = setPaneTab(layout, p.id, next)
        if (next) onScreen.add(next)
      }
      // Closing something else while Settings is open keeps Settings in front.
      const activeTabId = s.activeTabId !== tabId && isOverlayTab(tabs.find((t) => t.id === s.activeTabId)) ? s.activeTabId : (paneById(layout, focusedPane)?.tabId ?? null)
      const chats = { ...s.chats }
      delete chats[tabId]
      const terminals = { ...s.terminals }
      delete terminals[tabId]
      const dirtyFiles = { ...s.dirtyFiles }
      delete dirtyFiles[tabId]
      const detached = { ...s.detached }
      delete detached[tabId]
      const fileDrafts = { ...s.fileDrafts }
      delete fileDrafts[tabId]
      // Chats with history, files, previews and diffs can come back; a shell or a dev server can't.
      const reopenable = (tab.kind === 'chat' && tab.sessionId) || tab.kind === 'file' || tab.kind === 'browser' || tab.kind === 'diff'
      const closedTabs = reopenable ? [...s.closedTabs.filter((t) => t.id !== tabId), tab].slice(-20) : s.closedTabs
      // Where it was showing, so reopening it puts it back there (and brings back a pane that went with it).
      const was = paneOfTab(s.layout, tabId)
      const closedPlaces: Store['closedPlaces'] = {}
      for (const t of closedTabs) if (s.closedPlaces[t.id]) closedPlaces[t.id] = s.closedPlaces[t.id]
      if (reopenable && was) closedPlaces[tabId] = { paneId: was.id, layout: s.layout }
      set({ tabs, layout, focusedPane, activeTabId, chats, terminals, dirtyFiles, detached, fileDrafts, closedTabs, closedPlaces })
      clearLive(tabId)
      if (activeTabId) get().activate(activeTabId)
    },
    popOut: (tabId, at) => {
      const s = get()
      const tab = s.tabs.find((t) => t.id === tabId)
      // Settings and Get started change Loom itself, which a window of its own can't do.
      if (!tab || s.detached[tabId] || POPOUT_TAB || tab.kind === 'settings' || tab.kind === 'start') return
      // Its pane shows the tab used before it, as when a tab closes.
      const onScreen = new Set(panesOf(s.layout).map((p) => p.tabId))
      const fits = (id: string): boolean => id !== tabId && !onScreen.has(id) && !s.detached[id] && !isOverlayTab(s.tabs.find((t) => t.id === id))
      const back = [...s.history].reverse().find((h) => fits(h) && s.tabs.some((t) => t.id === h)) ?? s.tabs.find((t) => fits(t.id))?.id ?? null
      let layout = s.layout
      for (const p of panesOf(layout)) if (p.tabId === tabId) layout = setPaneTab(layout, p.id, back)
      const activeTabId = paneById(layout, s.focusedPane)?.tabId ?? null
      set({ detached: { ...s.detached, [tabId]: true }, layout, activeTabId })
      void window.loom.popoutOpen(tab, at)
    },
    snapshotOf: (tabId) => {
      const s = get()
      const tab = s.tabs.find((t) => t.id === tabId)
      if (!tab) return null
      return {
        tab,
        chat: s.chats[tabId],
        dirty: !!s.dirtyFiles[tabId],
        fileDraft: liveDrafts.get(tabId)?.() ?? s.fileDrafts[tabId] ?? null
      }
    },
    moveTab: (tabId, toIndex) =>
      set((s) => {
        const tabs = [...s.tabs]
        const from = tabs.findIndex((t) => t.id === tabId)
        if (from < 0) return {}
        const [t] = tabs.splice(from, 1)
        tabs.splice(Math.max(0, Math.min(toIndex, tabs.length)), 0, t)
        return { tabs }
      }),
    updateTab: (tabId, patch) =>
      set((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId ? ({ ...t, ...patch } as Tab) : t)) })),

    newChat: (projectId) => {
      if (POPOUT_TAB) return window.loom.mainDo('newChat', [projectId])
      const project = get().projects.find((p) => p.id === projectId) ?? null
      const cwd = project?.path ?? get().info?.homeDir ?? 'C:\\'
      get().openTab({ id: uid(), kind: 'chat', projectId: project?.id ?? null, sessionId: null, cwd, title: 'New chat', ...get().chatDefaults() })
      // A first chat on a new PC: its model menu should have the account's models, not the short list.
      get().ensureModels()
    },
    moveChat: async (ref, projectId) => {
      if (POPOUT_TAB) return
      const project = get().projects.find((p) => p.id === projectId)
      if (!project) return
      // A saved chat that isn't open opens first, so the move has somewhere to report back.
      if (!ref.tabId && ref.session) get().openSession(ref.session)
      const tab = get().tabs.find(
        (t): t is ChatTab => t.kind === 'chat' && (ref.tabId ? t.id === ref.tabId : t.sessionId === ref.session?.sessionId)
      )
      if (!tab || tab.projectId === project.id) return
      const note = (text: string, tone: 'info' | 'error' = 'info'): void =>
        patchChat(tab.id, (c) => ({ items: [...c.items, { kind: 'note', id: uid(), tone, text }] }))
      const c = get().chat(tab.id)
      if (get().detached[tab.id]) return get().showToast('Bring this chat back to the main window first, then move it.')
      if (chatBusy(c)) {
        return note('Claude is still working in this chat. Move it once the reply is done.', 'error')
      }
      // No messages while the history file moves: one would land in the old folder.
      patchChat(tab.id, () => ({ moving: true }))
      try {
        // Claude Code keeps the chat open between messages; it has to let go of it first, and a
        // chat that opened without getting an id yet would otherwise go on in the old folder.
        if (c.opened) {
          await window.loom.chatClose(tab.id)
          patchChat(tab.id, () => ({ opened: false, status: 'idle' }))
        }
        if (tab.sessionId) {
          const r = await window.loom.moveSession(tab.sessionId, tab.cwd, project.path)
          if (!r.ok) return note(r.error ?? 'The chat could not be moved.', 'error')
        }
      } finally {
        patchChat(tab.id, () => ({ moving: false }))
      }
      get().updateTab(tab.id, { projectId: project.id, cwd: project.path } as Partial<ChatTab>)
      // Skills and commands can differ per folder: fetch them again for the new one.
      patchChat(tab.id, () => ({ commands: [] }))
      note(`Moved to ${project.name}. From the next message Claude works in ${project.path}.`)
      void get().refreshSessions(true)
    },
    openSession: (session) => {
      if (POPOUT_TAB) return window.loom.mainDo('openSession', [session])
      const open = get().tabs.find((t) => t.kind === 'chat' && t.sessionId === session.sessionId)
      if (open) return get().activate(open.id)
      const project = projectForPath(get().projects, session.cwd)
      get().openTab({
        id: uid(),
        kind: 'chat',
        projectId: project?.id ?? null,
        sessionId: session.sessionId,
        cwd: session.cwd,
        title: session.title.length > 60 ? `${session.title.slice(0, 60)}…` : session.title,
        ...get().chatDefaults()
      })
    },
    deleteChat: async (ref) => {
      if (POPOUT_TAB) return
      const tab = get().tabs.find(
        (t): t is ChatTab => t.kind === 'chat' && (ref.tabId ? t.id === ref.tabId : !!ref.session && t.sessionId === ref.session.sessionId)
      )
      const sessionId = tab?.sessionId ?? ref.session?.sessionId ?? null
      const title = tab?.title ?? ref.session?.title ?? 'The chat'
      // Its tab closes first (asking, if Claude is still working in it): Claude Code lets go of the history.
      if (tab && !(await get().requestClose([tab.id]))) return
      // A chat with nothing said in it yet has no history: closing it was all there was to do.
      if (!sessionId) return
      const r = await window.loom.trashChat(sessionId, title)
      if (!r.ok) return get().showToast(r.error ?? `${title} could not be moved to the recycle bin.`)
      set((s) => ({
        sessions: s.sessions.filter((x) => x.sessionId !== sessionId),
        // Reopen closed tab must not bring back a chat whose history is in the bin.
        closedTabs: s.closedTabs.filter((t) => !(t.kind === 'chat' && t.sessionId === sessionId))
      }))
      void get().refreshSessions(true)
      void get().refreshTrash()
      get().showToast(`${title} is in the recycle bin.`, { label: 'Undo', run: () => void get().restoreChat(sessionId) })
    },
    refreshTrash: async () => {
      const trash = await window.loom.listTrash().catch(() => [] as TrashedChat[])
      set({ trash })
    },
    restoreChat: async (sessionId) => {
      const r = await window.loom.restoreChat(sessionId)
      if (!r.ok) get().showToast(r.error ?? 'The chat could not be put back.')
      await Promise.all([get().refreshSessions(true), get().refreshTrash()])
      return r.ok
    },
    purgeTrash: async (ids) => {
      const list = get().trash ?? []
      const going = ids === 'all' ? list : list.filter((x) => ids.includes(x.sessionId))
      if (!going.length) return
      const one = going.length === 1
      const choice = await get().ask({
        title: one ? `Delete ${going[0].title} for good?` : `Delete ${going.length} chats for good?`,
        body: one ? 'Its whole history is removed from this PC. This cannot be undone.' : 'Their whole history is removed from this PC. This cannot be undone.',
        items: one || going.length > 8 ? undefined : going.map((x) => x.title),
        choices: [
          { id: 'delete', label: 'Delete for good', kind: 'danger' },
          { id: 'cancel', label: 'Cancel', kind: 'ghost' }
        ],
        cancel: 'cancel'
      })
      if (choice !== 'delete') return
      const r = await window.loom.purgeTrash(ids === 'all' ? 'all' : going.map((x) => x.sessionId))
      if (r.failed) get().showToast(r.failed === 1 ? 'One chat could not be deleted. Try again in a moment.' : `${r.failed} chats could not be deleted. Try again in a moment.`)
      await get().refreshTrash()
    },
    openFile: (path, projectId) => {
      if (POPOUT_TAB) return window.loom.mainDo('openFile', [path, projectId])
      const open = get().tabs.find((t) => t.kind === 'file' && normPath(t.path) === normPath(path))
      if (open) return get().activate(open.id)
      const project = projectId !== undefined ? get().projects.find((p) => p.id === projectId) : projectForPath(get().projects, path)
      get().openTab({ id: uid(), kind: 'file', projectId: project?.id ?? null, path, title: baseName(path) })
    },
    openPaths: async (paths, at) => {
      if (POPOUT_TAB) return window.loom.mainDo('openPaths', [paths])
      const list = [...new Set(paths.filter(Boolean))]
      if (!list.length) return
      const isDir = await window.loom.dirsExist(list).catch(() => list.map(() => false))
      // Dropped on one pane of a split screen: that pane takes them.
      if (at) {
        const pane = [...document.querySelectorAll<HTMLElement>('.content [data-pane]')].find((el) => {
          const r = el.getBoundingClientRect()
          return at.x >= r.left && at.x <= r.right && at.y >= r.top && at.y <= r.bottom
        })
        if (pane?.dataset.pane) get().focusPane(pane.dataset.pane)
      }
      const added: string[] = []
      const had: string[] = []
      list.forEach((p, i) => {
        if (!isDir[i]) return get().openFile(p)
        // A folder becomes a project, as Add a project folder would make it.
        const known = get().projects.some((x) => normPath(x.path) === normPath(p))
        const project = get().addProject(p)
        ;(known ? had : added).push(project.name)
      })
      if (added.length || had.length) set({ sidebarOpen: true })
      if (added.length) get().showToast(added.length === 1 ? `${added[0]} is now one of your projects.` : `${added.length} folders are now projects: ${added.join(', ')}.`)
      else if (had.length) get().showToast(had.length === 1 ? `${had[0]} is already one of your projects.` : 'Those folders are already projects.')
    },
    pickAndOpenFiles: async () => {
      const tab = get().tabs.find((t) => t.id === get().activeTabId)
      const project = get().projects.find((p) => p.id === tab?.projectId)
      const paths = await window.loom.pickFiles(project?.path)
      if (paths.length) await get().openPaths(paths)
    },
    newTerminal: (projectId, dir) => {
      if (POPOUT_TAB) return window.loom.mainDo('newTerminal', [projectId, dir])
      const project = get().projects.find((p) => p.id === projectId) ?? null
      const cwd = dir ?? project?.path ?? get().info?.homeDir ?? 'C:\\'
      const count = get().tabs.filter((t) => t.kind === 'terminal' && t.projectId === (project?.id ?? null)).length
      get().openTab({ id: uid(), kind: 'terminal', projectId: project?.id ?? null, cwd, title: count ? `Terminal ${count + 1}` : 'Terminal' })
    },
    openStart: () => {
      if (POPOUT_TAB) return window.loom.mainDo('openStart', [])
      const open = get().tabs.find((t) => t.kind === 'start')
      if (open) return get().activate(open.id)
      get().openTab({ id: uid(), kind: 'start', projectId: null, title: 'Get started' })
    },
    openInstallTerminal: () => {
      // Pressed again: the terminal already open comes forward instead of a second one.
      const open = get().tabs.find((t) => t.kind === 'terminal' && t.title === 'Install Claude Code')
      if (open) return get().activate(open.id)
      // Anthropic's own installer, as its docs give it for each shell.
      const shell = get().settings.shell
      const ps = 'irm https://claude.ai/install.ps1 | iex'
      const run =
        shell === 'powershell'
          ? ps
          : shell === 'cmd'
            ? 'curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd'
            : `powershell -NoProfile -Command "${ps}"`
      const tab: TerminalTab = {
        id: uid(),
        kind: 'terminal',
        projectId: null,
        cwd: get().info?.homeDir ?? 'C:\\',
        title: 'Install Claude Code',
        run
      }
      set((s) => ({ tabs: [...s.tabs, tab] }))
      get().splitPane('right', tab.id)
    },
    runInTerminal: (title, run) => {
      if (POPOUT_TAB) return
      get().openTab({ id: uid(), kind: 'terminal', projectId: null, cwd: get().info?.homeDir ?? 'C:\\', title, run })
    },
    openSettings: (section) => {
      if (POPOUT_TAB) return window.loom.mainDo('openSettings', section ? [section] : [])
      if (section) set({ settingsSection: section })
      const open = get().tabs.find((t) => t.kind === 'settings')
      if (open) return get().activate(open.id)
      get().openTab({ id: uid(), kind: 'settings', projectId: null, title: 'Settings' })
    },

    chat: (tabId) => get().chats[tabId] ?? newChatRuntime(),

    loadHistory: async (tabId) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab || tab.kind !== 'chat' || !tab.sessionId) return
      const c = get().chat(tabId)
      if (c.historyState === 'loading' || c.historyState === 'loaded') return
      patchChat(tabId, () => ({ historyState: 'loading' }))
      const r = await window.loom.loadHistory(tab.sessionId)
      patchChat(tabId, (cur) => ({
        context: cur.context ?? r.context,
        historyState: r.error ? 'error' : 'loaded',
        historyTotal: r.total,
        error: r.error,
        items: [...r.items, ...cur.items]
      }))
    },

    bringIn: async (tabId, chat) => {
      const cur = get().chat(tabId).briefs
      if (cur.some((b) => b.sessionId === chat.sessionId)) return
      if (cur.length >= MAX_BRIEFS) return get().showToast(`A message takes up to ${MAX_BRIEFS} other chats.`)
      patchChat(tabId, (c) => ({ briefs: [...c.briefs, { ...chat, state: 'writing' }] }))
      const r = await window.loom.teamBrief(chat.sessionId).catch((e) => ({ ok: false, text: undefined, error: (e as Error).message }))
      // Taken out of the message box meanwhile: there is nothing left to fill in.
      patchChat(tabId, (c) => ({
        briefs: c.briefs.map((b) =>
          b.sessionId !== chat.sessionId
            ? b
            : r.ok && r.text
              ? { ...b, state: 'ready', text: r.text }
              : { ...b, state: 'failed', error: r.error ?? 'The summary could not be written.' }
        )
      }))
      // A teammate's chat was copied here for it: the sidebar lists the copy.
      if (chat.from) void get().refreshSessions(true)
    },
    dropBrief: (tabId, sessionId) => patchChat(tabId, (c) => ({ briefs: c.briefs.filter((b) => b.sessionId !== sessionId) })),
    send: async (tabId, text, images, givenId, background = false, context = []) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab || tab.kind !== 'chat') return
      const trimmed = text.trim()
      if (!trimmed && !images.length) return
      if (tab.title === 'New chat' && trimmed) {
        // Named by the start of the message at once, then by a short title Claude writes for it.
        const first = chatTitleFrom(trimmed)
        get().updateTab(tabId, { title: first })
        if (get().settings.autoTitle !== false) {
          void window.loom
            .nameChat(trimmed)
            .then((title) => {
              const now = get().tabs.find((t) => t.id === tabId)
              // Renamed by hand meanwhile, or closed: left as it is.
              if (!title || now?.kind !== 'chat' || now.title !== first) return
              get().updateTab(tabId, { title })
              // Saved with the chat once Claude Code has given it an id, so the sidebar keeps the name.
              if (now.sessionId) void window.loom.renameSession(now.sessionId, title)
              else titlesToSave.set(tabId, title)
            })
            .catch(() => undefined)
        }
      }
      const previews: ImagePreview[] = await Promise.all(
        images.map(async (img) => {
          const full = `data:${img.mediaType};base64,${img.data}`
          return { thumb: await thumbnailOf(full), full }
        })
      )
      // A real UUID: Claude Code tags the message with it, and Stop names the ones it takes back by it.
      const id = givenId ?? crypto.randomUUID()
      if (context.length) {
        sentContext.set(id, context)
        if (sentContext.size > 40) sentContext.delete(sentContext.keys().next().value!)
      }
      const role = teamRole(get().team, tab.sessionId)
      const mine = role ? { id: role.team.me, name: get().team?.name.trim() || 'You' } : null
      // Claude is in the middle of a thought or of writing its reply: the message shows under it.
      const live = useLive.getState()
      const midStep = !!(live.thinking[tabId] || live.partial[tabId])
      patchChat(tabId, (c) => ({
        ...(midStep ? { late: [...(c.late ?? []), id] } : {}),
        items: [
          ...c.items,
          {
            kind: 'user',
            id,
            text: trimmed,
            images: images.length,
            previews: previews.length ? previews : undefined,
            ts: new Date().toISOString(),
            ...(background ? { background: true } : {}),
            ...(context.length ? { context: context.map((c) => ({ title: c.title, ...(c.from ? { from: c.from } : {}) })) } : {}),
            // In a chat a team takes turns in, each message says whose it is.
            ...(mine ? { author: mine } : {})
          }
        ],
        draft: '',
        error: undefined,
        status: c.status === 'idle' || c.status === 'stopped' || c.status === 'error' ? 'starting' : c.status,
        // A message added mid-turn doesn't restart the turn's clock.
        startedAt: c.status === 'running' || c.status === 'starting' ? c.startedAt : Date.now()
      }))
      try {
        await ensureOpened(tab)
        await window.loom.chatSend(tabId, trimmed, images, id, background, context)
      } catch (e) {
        patchChat(tabId, () => ({ status: 'error', error: (e as Error).message }))
      }
    },
    interrupt: (tabId) => void window.loom.chatInterrupt(tabId),
    setModel: (tabId, model) => {
      // In a chat under way, the timeline says from what to what, at once.
      const tab = get().tabs.find((t) => t.id === tabId)
      const before = tab?.kind === 'chat' ? (tab.model ?? '') : ''
      if (tab?.kind === 'chat' && before !== (model ?? '') && get().chat(tabId).items.length) {
        const known = get().knownModels
        const name = (v: string): string => {
          if (v) return modelName(v, known) ?? v
          const resolved = known.find((m) => m.value === '')?.description?.split(' · ')[0]
          return resolved ? `the default (${resolved})` : 'the default'
        }
        patchChat(tabId, (c) => ({
          switchNoted: true,
          items: [...c.items, { kind: 'note', id: uid(), tone: 'info', text: `Switched from ${name(before)} to ${name(model ?? '')}`, ts: new Date().toISOString() }]
        }))
      }
      // This chat only: a new chat starts with what Settings says, not with the last pick here.
      get().updateTab(tabId, { model })
      patchChat(tabId, () => ({ activeModel: model || undefined }))
      if (get().chat(tabId).opened) void window.loom.chatSetModel(tabId, model)
    },
    setMode: (tabId, mode) => {
      get().updateTab(tabId, { permissionMode: mode })
      patchChat(tabId, () => ({ permissionMode: mode }))
      if (get().chat(tabId).opened) void window.loom.chatSetMode(tabId, mode)
    },
    cycleMode: (tabId) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab || tab.kind !== 'chat') return
      const order: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']
      const now = tab.permissionMode ?? get().chat(tabId).permissionMode ?? get().settings.defaultPermissionMode ?? 'default'
      get().setMode(tabId, order[(order.indexOf(now) + 1) % order.length])
    },
    setEffort: (tabId, effort) => {
      get().updateTab(tabId, { effort } as Partial<ChatTab>)
      const tab = get().tabs.find((t) => t.id === tabId)
      if (get().chat(tabId).opened && tab?.kind === 'chat') void window.loom.chatSetEffort(tabId, effort, tab.ultracode === true)
    },
    setUltracode: (tabId, on) => {
      get().updateTab(tabId, { ultracode: on } as Partial<ChatTab>)
      const tab = get().tabs.find((t) => t.id === tabId)
      if (get().chat(tabId).opened && tab?.kind === 'chat') void window.loom.chatSetEffort(tabId, tab.effort ?? null, on)
    },
    loadIcon: async (projectId) => {
      const p = get().projects.find((x) => x.id === projectId)
      if (!p) return
      const others = get().projects.filter((x) => x.id !== projectId).map((x) => x.path)
      const url = await window.loom.projectIcon(p.path, p.iconMode ?? 'auto', p.iconPath ?? null, others).catch(() => null)
      set((s) => ({ icons: { ...s.icons, [projectId]: url } }))
    },
    loadGroupIcon: async (groupId) => {
      const path = get().groups.find((g) => g.id === groupId)?.iconPath
      const url = path ? await window.loom.readIcon(path).catch(() => null) : null
      set((s) => ({ groupIcons: { ...s.groupIcons, [groupId]: url } }))
    },
    // What a new chat starts with: Claude Code's recommended model and effort, unless Settings
    // names others, the permission mode from Settings, and Ultracode off. What you change in one
    // chat stays in that chat.
    chatDefaults: () => {
      const st = get().settings
      return {
        model: st.newChatModel || null,
        permissionMode: st.defaultPermissionMode ?? null,
        effort: st.newChatEffort ?? null,
        ultracode: false
      }
    },
    loadCommands: async (tabId) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab || tab.kind !== 'chat' || get().chat(tabId).commands.length) return
      const list = await window.loom.commandsList(tab.cwd).catch(() => [])
      if (list.length && !get().chat(tabId).commands.length) patchChat(tabId, () => ({ commands: list }))
    },
    openPreview: (projectId, url, beside = true) => {
      if (POPOUT_TAB) return window.loom.mainDo('openPreview', [projectId, url, beside])
      const s = get()
      const server = s.servers.find((x) => x.projectId === projectId && x.url)
      const target = url ?? server?.url ?? 'http://localhost:3000/'
      const origin = (u: string): string => {
        try {
          return new URL(u).origin
        } catch {
          return u
        }
      }
      let tab = s.tabs.find((t): t is BrowserTab => t.kind === 'browser' && t.projectId === projectId && origin(t.url) === origin(target))
      if (!tab) {
        let title = target
        try {
          title = new URL(target).host
        } catch {
          // not a full address; show it as typed
        }
        tab = { id: uid(), kind: 'browser', projectId, url: target, title }
        const added = tab
        set((st) => ({ tabs: [...st.tabs, added] }))
      }
      if (paneOfTab(get().layout, tab.id) || get().detached[tab.id] || !beside) return get().activate(tab.id)
      // Beside: in another pane if there is one, else a new pane to the right.
      const other = panesOf(get().layout).find((p) => p.id !== get().focusedPane)
      if (other) get().moveTabToPane(tab.id, other.id)
      else get().splitPane('right', tab.id)
    },
    focusPane: (paneId, byPointer = false) => {
      const s = get()
      if (s.focusedPane === paneId) return
      const pane = paneById(s.layout, paneId)
      if (!pane) return
      set({ focusedPane: paneId, activeTabId: pane.tabId, pointerFocus: byPointer })
      if (pane.tabId) {
        const id = pane.tabId
        set((st) => ({ history: [...st.history.filter((h) => h !== id), id].slice(-50) }))
        if (get().chats[id]?.unread) patchChat(id, () => ({ unread: false }))
        const tab = get().tabs.find((t) => t.id === id)
        if (tab?.projectId) void get().refreshGit(tab.projectId)
      }
    },
    splitPane: (edge, tabId, paneId) => {
      const s = get()
      const target = paneId ?? s.focusedPane
      const onScreen = new Set(panesOf(s.layout).map((p) => p.tabId))
      const fits = (id: string, except: string | null): boolean =>
        id !== except && !onScreen.has(id) && !s.detached[id] && !isOverlayTab(s.tabs.find((t) => t.id === id))
      const spare = (except: string | null): string | null =>
        [...s.history].reverse().find((h) => fits(h, except) && s.tabs.some((t) => t.id === h)) ?? s.tabs.find((t) => fits(t.id, except))?.id ?? null
      // A tab in its own window comes back first; Settings never goes in a pane.
      if (tabId && s.detached[tabId]) return void window.loom.popoutClose(tabId)
      if (tabId && isOverlayTab(s.tabs.find((t) => t.id === tabId))) return get().activate(tabId)
      let layout = s.layout
      let tab = tabId ?? null
      if (tab) {
        // Moving a tab that's on screen: its old pane shows something else.
        const from = paneOfTab(layout, tab)
        if (from) layout = setPaneTab(layout, from.id, spare(tab))
      } else tab = spare(null)
      const added = newPane(tab)
      layout = splitLayout(layout, target, edge, added)
      set({ layout, focusedPane: added.id, activeTabId: tab, pointerFocus: false })
      if (tab) get().activate(tab)
    },
    moveTabToPane: (tabId, paneId) => {
      const s = get()
      const target = paneById(s.layout, paneId)
      if (!target) return
      if (s.detached[tabId]) return void window.loom.popoutClose(tabId)
      if (isOverlayTab(s.tabs.find((t) => t.id === tabId))) return get().activate(tabId)
      const from = paneOfTab(s.layout, tabId)
      let layout = s.layout
      if (from && from.id !== paneId) layout = setPaneTab(layout, from.id, target.tabId)
      layout = setPaneTab(layout, paneId, tabId)
      set({ layout, focusedPane: paneId })
      get().activate(tabId)
    },
    movePane: (fromPaneId, zone, targetPaneId) => {
      const s = get()
      const from = paneById(s.layout, fromPaneId)
      const target = paneById(s.layout, targetPaneId)
      if (!from || !target || from.id === target.id) return
      // On the middle: the two panes swap what they show.
      const layout =
        zone === 'center'
          ? setPaneTab(setPaneTab(s.layout, from.id, target.tabId), target.id, from.tabId)
          : splitLayout(removePane(s.layout, from.id), target.id, zone, { ...from })
      const focusedPane = zone === 'center' ? target.id : from.id
      set({ layout, focusedPane, activeTabId: from.tabId, pointerFocus: false })
      if (from.tabId) get().activate(from.tabId)
    },
    closePane: (paneId) => {
      const s = get()
      const id = paneId ?? s.focusedPane
      const list = panesOf(s.layout)
      if (list.length < 2) return
      const at = list.findIndex((p) => p.id === id)
      const layout = removePane(s.layout, id)
      const left = panesOf(layout)
      const next = id === s.focusedPane ? left[Math.max(0, Math.min(at - 1, left.length - 1))] : (paneById(layout, s.focusedPane) ?? left[0])
      set({ layout, focusedPane: next.id, activeTabId: next.tabId, pointerFocus: false })
    },
    applyPreset: (name) => {
      const s = get()
      const focusedTab = paneById(s.layout, s.focusedPane)?.tabId ?? null
      const shown = panesOf(s.layout).map((p) => p.tabId)
      const order: string[] = []
      for (const id of [focusedTab, ...shown, ...[...s.history].reverse(), ...s.tabs.map((t) => t.id)]) {
        const t = s.tabs.find((x) => x.id === id)
        if (id && t && !order.includes(id) && !s.detached[id] && !isOverlayTab(t)) order.push(id)
      }
      const count = PRESETS.find((p) => p.name === name)?.panes ?? 1
      const layout = presetLayout(name, order.slice(0, count))
      const first = panesOf(layout)[0]
      set({ layout, focusedPane: first.id, activeTabId: first.tabId, pointerFocus: false })
    },
    resizeSplit: (splitId, sizes) => set((s) => ({ layout: setSizes(s.layout, splitId, sizes) })),
    loadRunTargets: async (projectId) => {
      const p = get().projects.find((x) => x.id === projectId)
      if (!p) return []
      const others = get().projects.filter((x) => x.id !== projectId).map((x) => x.path)
      const targets = await window.loom.detectRun(p.path, others).catch(() => [] as RunTarget[])
      set((s) => ({ runTargets: { ...s.runTargets, [projectId]: targets } }))
      return targets
    },
    runProject: async (projectId, targetId) => {
      const p = get().projects.find((x) => x.id === projectId)
      if (!p) return
      // Look again: package.json may have changed since Loom started.
      const targets = await get().loadRunTargets(projectId)
      const target =
        targets.find((t) => t.id === targetId) ?? targets.find((t) => t.id === p.runTargetId) ?? targets[0]
      if (!target) return
      if (targetId && targetId !== p.runTargetId) get().updateProject(projectId, { runTargetId: targetId })
      // A fresh clone has no node_modules yet, so running it would only stop at once. Offer to install first.
      const missing = await window.loom.serverMissingPackages(target)
      let install = false
      if (missing) {
        const elsewhere = normPath(missing.cwd) !== normPath(target.cwd) ? ` in ${missing.cwd}` : ''
        const choice = await get().ask({
          title: 'Dependencies are not installed',
          body: `${p.name} lists packages it needs, but they were never installed here, so ${target.command} would stop at once. Install and run runs ${missing.command}${elsewhere} first, which can take a minute or two.`,
          choices: [
            { id: 'install', label: 'Install and run', kind: 'primary' },
            { id: 'run', label: 'Run anyway', kind: 'ghost' },
            { id: 'cancel', label: 'Cancel', kind: 'ghost' }
          ],
          cancel: 'cancel',
          focus: 'install'
        })
        if (choice === 'cancel') return
        install = choice === 'install'
      }
      const info = await window.loom.serverStart(projectId, target, install)
      set((s) => ({ servers: s.servers.some((x) => x.id === info.id) ? s.servers : [...s.servers, info] }))
    },
    stopServer: (serverId) => void window.loom.serverStop(serverId),
    restartServer: (serverId, install) => void window.loom.serverRestart(serverId, install),
    dismissServer: (serverId) => void window.loom.serverDismiss(serverId),
    showServerOutput: (serverId) => {
      if (POPOUT_TAB) return window.loom.mainDo('showServerOutput', [serverId])
      const open = get().tabs.find((t) => t.kind === 'server' && t.serverId === serverId)
      if (open) return get().activate(open.id)
      const server = get().servers.find((x) => x.id === serverId)
      if (!server) return
      get().openTab({ id: uid(), kind: 'server', projectId: server.projectId, serverId, title: server.target.command })
    },
    ensureModels: () => {
      if (!isStarterModels(get().knownModels) || Date.now() - modelsAskedAt < 15_000) return
      modelsAskedAt = Date.now()
      // The models come with the plan limits reading.
      void window.loom.getUsage(true).catch(() => undefined)
    },
    refreshUsage: async (force) => {
      if (force) set({ usageChecking: true })
      try {
        const usage = await window.loom.getUsage(force)
        if (usage) set({ usage })
      } finally {
        if (force) set({ usageChecking: false })
      }
    },
    checkSharing: async () => {
      const [installed, cf] = await Promise.all([window.loom.tunnelAvailable().catch(() => false), window.loom.serviceAccount('cloudflare', false).catch(() => null)])
      set({ canShare: installed || !!cf?.signedIn })
    },
    shareServer: async (serverId) => {
      const r = await window.loom.tunnelStart(serverId)
      if (r.ok) return
      if (!r.missing) return get().showToast(r.message ?? 'Cloudflare could not open a public link.')
      // Quick Tunnels run on cloudflared, Cloudflare's small connector program.
      const choice = await get().ask({
        title: 'Install cloudflared?',
        body: "Public links run through cloudflared, Cloudflare's connector program, which isn't on this PC yet. Loom can install it with winget in a terminal tab; when it has finished, click the cloud again.",
        choices: [
          { id: 'install', label: 'Install cloudflared', kind: 'primary' },
          { id: 'cancel', label: 'Cancel', kind: 'ghost' }
        ],
        cancel: 'cancel',
        focus: 'install'
      })
      if (choice === 'install') get().runInTerminal('Install cloudflared', 'winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements')
    },
    stopSharing: (serverId) => void window.loom.tunnelStop(serverId),
    showWhatsNew: () => {
      const version = get().update?.version
      const notes = version ? notesFor(version) : []
      if (notes.length) set({ whatsNew: notes })
      else void window.loom.updateNotes(version)
    },
    showUsage: () => {
      set({ usageOpen: true })
      void get().refreshUsage(true)
    },
    respond: (tabId, requestId, response) => {
      patchChat(tabId, (c) => ({ permissions: c.permissions.filter((p) => p.requestId !== requestId) }))
      void window.loom.chatRespond(tabId, requestId, response)
    },
    setDraft: (tabId, draft) => {
      patchChat(tabId, () => ({ draft }))
      // On the tab too, so a half-written message survives a restart or an update.
      const tab = get().tabs.find((t) => t.id === tabId)
      if (tab?.kind === 'chat' && (tab.draft ?? '') !== draft) get().updateTab(tabId, { draft: draft || undefined } as Partial<ChatTab>)
    },
    setAttachments: (tabId, attachments) => patchChat(tabId, () => ({ attachments })),

    handleChatEvent: (tabId, ev) => {
      switch (ev.type) {
        case 'items':
          patchChat(tabId, (c) => {
            const items = [...c.items]
            const now = new Date().toISOString()
            // The first reply after you switched: its "switched to" note would say it twice.
            const replied = c.switchNoted && ev.items.some((x) => x.kind === 'assistant' || x.kind === 'thinking' || x.kind === 'tool')
            const incoming = replied ? ev.items.filter((x) => !(x.kind === 'note' && x.id.startsWith('model:'))) : ev.items
            // The thought or the reply that was being written when you sent a message is done: it
            // goes before that message (with the rest of what Claude said in the same breath),
            // and the message stays where it has been showing, under it.
            const late = new Set(c.late ?? [])
            const closing = late.size > 0 && incoming.some((x) => x.kind === 'thinking' || x.kind === 'assistant')
            for (const raw of incoming) {
              // Live steps get the time they arrived, as saved ones carry theirs. One sent again
              // (a step updated in place) keeps the time it first had.
              const at = items.findIndex((x) => x.id === raw.id)
              const item = raw.ts ? raw : { ...raw, ts: items[at]?.ts ?? now }
              const before = closing && at < 0 ? items.findIndex((x) => late.has(x.id)) : -1
              if (at >= 0) items[at] = item
              else if (before >= 0) items.splice(before, 0, item)
              else items.push(item)
            }
            return { items, ...(replied ? { switchNoted: false } : {}), ...(closing ? { late: [] } : {}) }
          })
          break
        case 'tool-result':
          patchChat(tabId, (c) => {
            const items = [...c.items]
            for (let i = items.length - 1; i >= 0; i--) {
              const it = items[i]
              if (it.kind === 'tool' && it.id === ev.toolUseId) {
                items[i] = { ...it, result: ev.result, isError: ev.isError, status: ev.isError ? 'error' : 'done', ms: ev.ms ?? it.ms }
                break
              }
            }
            return { items }
          })
          break
        case 'partial':
          useLive.setState((l) => ({ partial: { ...l.partial, [tabId]: ev.text } }))
          break
        case 'thinking-partial':
          useLive.setState((l) => ({ thinking: { ...l.thinking, [tabId]: { text: ev.text, since: l.thinking[tabId]?.since ?? Date.now() } } }))
          break
        case 'partial-clear':
          clearLive(tabId)
          break
        case 'status':
          // Stopped or done mid-thought: nothing more is coming for the live thinking.
          if (ev.status === 'stopped' || ev.status === 'error' || ev.status === 'idle') clearLive(tabId, 'thinking')
          patchChat(tabId, (c) => ({
            status: ev.status,
            ...(ev.status === 'stopped' || ev.status === 'error' || ev.status === 'idle' ? { late: [] } : {}),
            ...(ev.status === 'stopped' || ev.status === 'error' ? { activity: null } : {}),
            error: ev.error,
            // A turn Claude started by itself has no send to time it from.
            ...(ev.status === 'running' && c.status !== 'running' && c.status !== 'starting' ? { startedAt: Date.now() } : {}),
            items:
              ev.status === 'stopped' || ev.status === 'error' || ev.status === 'idle'
                ? c.items.map((it) => (it.kind === 'tool' && it.status === 'running' && ev.status !== 'idle' ? { ...it, status: 'done' as const } : it))
                : c.items
          }))
          break
        case 'session': {
          get().updateTab(tabId, { sessionId: ev.sessionId } as Partial<ChatTab>)
          // A title Claude wrote before the chat had an id is saved with it now.
          const named = titlesToSave.get(tabId)
          if (named) {
            titlesToSave.delete(tabId)
            if (get().tabs.find((t) => t.id === tabId)?.title === named) void window.loom.renameSession(ev.sessionId, named)
          }
          patchChat(tabId, (c) => ({
            activeModel: ev.model ?? c.activeModel,
            permissionMode: ev.permissionMode ?? c.permissionMode,
            historyState: c.historyState === 'none' ? 'loaded' : c.historyState
          }))
          break
        }
        case 'permission':
          // A window that takes a chat over is sent its open questions again: keep one card each.
          patchChat(tabId, (c) => ({
            permissions: [...c.permissions.filter((p) => p.requestId !== ev.request.requestId), ev.request],
            unread: get().activeTabId !== tabId
          }))
          break
        case 'tasks':
          patchChat(tabId, () => ({ tasks: ev.tasks }))
          break
        case 'task-done': {
          // Work you sent to the background has ended. Claude picks the result up by itself; this
          // says so, naming the chat when you are looking at another.
          const s = get()
          const where = s.activeTabId === tabId ? '' : `, in ${s.tabs.find((t) => t.id === tabId)?.title ?? 'another chat'}`
          const what = ev.status === 'failed' ? 'Failed in the background' : ev.status === 'stopped' ? 'Stopped in the background' : 'Done in the background'
          const desc = ev.description.replace(/[.\s]+$/, '')
          s.showToast(`${what}${where}: ${desc}.${ev.status === 'stopped' ? '' : ' Claude is picking up the result.'}`)
          break
        }
        case 'activity':
          patchChat(tabId, () => ({ activity: ev.activity }))
          break
        case 'unsent': {
          // Stop cancelled messages Claude hadn't read yet: off the conversation, back into the box.
          const gone = new Set(ev.ids)
          const back = get()
            .chat(tabId)
            .items.filter((it): it is Extract<ChatItem, { kind: 'user' }> => it.kind === 'user' && gone.has(it.id))
          if (!back.length) break
          const images: ImageAttachment[] = back.flatMap((it) =>
            (it.previews ?? []).flatMap((p) => {
              const m = p.full?.match(/^data:([^;,]+);base64,(.+)$/)
              return m ? [{ mediaType: m[1], data: m[2], name: 'image' }] : []
            })
          )
          // The chats those messages brought along wait in the box again, their notes already written.
          const brought: ChatBrief[] = back.flatMap((it) =>
            (sentContext.get(it.id) ?? []).map((c) => ({ sessionId: c.sessionId ?? `${it.id}:${c.title}`, title: c.title, ...(c.from ? { from: c.from } : {}), state: 'ready' as const, text: c.text }))
          )
          for (const it of back) sentContext.delete(it.id)
          patchChat(tabId, (c) => ({
            items: c.items.filter((it) => !(it.kind === 'user' && gone.has(it.id))),
            attachments: [...images, ...c.attachments].slice(0, 8),
            briefs: [...brought, ...c.briefs].filter((b, i, all) => all.findIndex((x) => x.sessionId === b.sessionId) === i).slice(0, MAX_BRIEFS),
            refill: { text: back.map((it) => it.text).filter(Boolean).join('\n\n'), key: Date.now() }
          }))
          break
        }
        case 'permission-done':
          patchChat(tabId, (c) => ({ permissions: c.permissions.filter((p) => p.requestId !== ev.requestId) }))
          break
        case 'context':
          patchChat(tabId, () => ({ context: ev.context }))
          break
        case 'turn-done': {
          get().bumpTree()
          patchChat(tabId, (c) => {
            const now = Date.now()
            const items: ChatItem[] = c.items.map((it) =>
              it.kind === 'tool' && it.status === 'running'
                ? { ...it, status: 'done' as const, ms: it.startedAt ? now - it.startedAt : undefined }
                : it
            )
            const outcome = ev.stopped ? ('stopped' as const) : ev.error ? ('error' as const) : undefined
            if (ev.durationMs && ev.durationMs >= 1000) items.push({ kind: 'done', id: uid(), ms: ev.durationMs, ts: new Date(now).toISOString(), ...(outcome ? { outcome } : {}) })
            return { unread: get().activeTabId !== tabId, items, activity: null }
          })
          const tab = get().tabs.find((t) => t.id === tabId)
          if (tab?.projectId) void get().refreshGit(tab.projectId)
          void get().refreshSessions(true)
          break
        }
        case 'models':
          if (ev.models.length) set({ knownModels: ev.models })
          break
        case 'commands':
          patchChat(tabId, () => ({ commands: ev.commands }))
          break
        case 'mode':
          get().updateTab(tabId, { permissionMode: ev.permissionMode })
          patchChat(tabId, () => ({ permissionMode: ev.permissionMode }))
          break
      }
    },

    refreshTeamKeys: async () => {
      const teamKeys = await window.loom.teamKeys().catch(() => ({}) as Record<string, string | null>)
      set({ teamKeys })
    },
    shareProject: async (teamId, path, on) => {
      const r = await window.loom.teamShare(teamId, path, on)
      if (!r.ok) return get().showToast(r.error ?? 'That project could not be shared.')
      if (!on) return
      await get().refreshTeamKeys()
      const t = get().team?.teams.find((x) => x.id === teamId)
      const project = projectForPath(get().projects, path)
      const key = project ? get().teamKeys[project.id] : null
      if (!t || !key) return
      const name = project?.name ?? baseName(path)
      const others = t.members.filter((m) => m.id !== t.me)
      const also = sharersOf(t, key)
      // Sharing is done on each PC: what is left for the others to do is said here, where it was just done.
      if (!others.length) get().showToast(`${name} is shared with ${t.name}. Nobody else is in the team yet: invite someone in Settings, Team.`)
      else if (also.length) get().showToast(`${name} is shared with ${t.name}. ${namesOf(also)} ${also.length === 1 ? 'shares' : 'share'} it too, so you see each other's chats under the project.`)
      else {
        const who = others.length === 1 ? others[0].name : 'Each teammate'
        get().showToast(`${name} is shared with ${t.name}. ${who} has to share it too, on their PC, before you see each other's chats: the same repository added to their Loom, and shared in Settings, Team.`)
      }
    },
    openTeamChat: async (entry) => {
      if (POPOUT_TAB) return
      const open = get().tabs.find((t) => t.kind === 'chat' && t.sessionId === entry.sessionId)
      if (open) return get().activate(open.id)
      set((s) => ({ teamSync: { ...s.teamSync, [entry.sessionId]: { sessionId: entry.sessionId, got: 0, total: entry.size, done: false } } }))
      const r = await window.loom.teamOpen(entry.sessionId)
      set((s) => {
        const teamSync = { ...s.teamSync }
        delete teamSync[entry.sessionId]
        return { teamSync }
      })
      if (!r.ok || !r.cwd) return get().showToast(r.error ?? `${entry.title} could not be opened.`)
      // Only part of it came (its holder went away): it opens with what is here, and says so.
      if (r.partial) get().showToast(r.partial)
      await get().refreshSessions(true)
      get().openSession({ sessionId: entry.sessionId, title: entry.title, cwd: r.cwd, lastModified: entry.lastAt })
    },
    takeOverChat: async (tabId) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      const role = tab?.kind === 'chat' ? teamRole(get().team, tab.sessionId) : null
      if (!tab || tab.kind !== 'chat' || !tab.sessionId || !role || role.mine) return
      const repo = get().team?.chats.find((c) => c.sessionId === tab.sessionId)?.repo
      const theirs = repo?.changes
        ? ` ${role.writerName} has ${repo.changes === 1 ? '1 change' : `${repo.changes} changes`} not committed${repo.branch ? ` on ${repo.branch}` : ''}: what Claude did there that you have not pulled is not in your files.`
        : repo?.branch
          ? ` ${role.writerName} is on ${repo.branch}: pull first if Claude changed files there.`
          : ''
      const choice = await get().ask({
        title: `Continue ${tab.title} here?`,
        body: `${role.writerName} passes it on, and from then on Claude works on this PC: in your copy of the project, on your Claude account.${theirs}`,
        choices: [
          { id: 'take', label: 'Continue here', kind: 'primary' },
          { id: 'cancel', label: 'Cancel', kind: 'ghost' }
        ],
        cancel: 'cancel',
        focus: 'take'
      })
      if (choice !== 'take') return
      const r = await window.loom.teamTake(tab.sessionId)
      if (!r.ok) return get().showToast(r.error ?? 'The chat could not be passed on.')
      await get().reloadHistory(tabId)
      patchChat(tabId, () => ({ opened: false, status: 'idle', error: undefined }))
      clearLive(tabId)
      get().showToast(`You are writing in ${tab.title} now.`)
    },
    copyTeamChat: async (tabId) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab || tab.kind !== 'chat' || !tab.sessionId) return
      const r = await window.loom.teamFork(tab.sessionId)
      if (!r.ok || !r.sessionId) return get().showToast(r.error ?? 'The copy could not be made.')
      const title = `${tab.title} (copy)`
      await window.loom.renameSession(r.sessionId, title).catch(() => undefined)
      await get().refreshSessions(true)
      get().openSession({ sessionId: r.sessionId, title, cwd: tab.cwd, lastModified: Date.now() })
    },
    reloadHistory: async (tabId) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab || tab.kind !== 'chat' || !tab.sessionId) return
      const r = await window.loom.loadHistory(tab.sessionId)
      if (r.error) return
      patchChat(tabId, (c) => ({ items: r.items, historyTotal: r.total, historyState: 'loaded', context: r.context ?? c.context }))
    },
    refreshSessions: async (force) => {
      try {
        const sessions = await window.loom.listSessions(force)
        set({ sessions })
      } catch {
        // keep the previous list
      }
    },
    refreshChanges: async (projectId) => {
      const p = get().projects.find((x) => x.id === projectId)
      if (!p) return
      const changes = await window.loom.gitChanges(p.path).catch(() => null)
      set((s) => ({ gitChanges: { ...s.gitChanges, [projectId]: changes } }))
      void get().refreshGit(projectId)
    },
    openDiff: (projectId, path, commit, commitLabel) => {
      if (POPOUT_TAB) return window.loom.mainDo('openDiff', [projectId, path, commit, commitLabel])
      const open = get().tabs.find((t) => t.kind === 'diff' && normPath(t.path) === normPath(path) && (t.commit ?? null) === (commit ?? null))
      if (open) return get().activate(open.id)
      const name = baseName(path)
      const tab: DiffTab = { id: uid(), kind: 'diff', projectId, path, commit, title: commit ? `${name} @ ${commitLabel ?? commit.slice(0, 7)}` : `${name} changes` }
      get().openTab(tab)
    },
    refreshAllGit: async () => {
      const queue = get().projects.map((p) => p.id)
      const worker = async (): Promise<void> => {
        for (let id = queue.shift(); id; id = queue.shift()) await get().refreshGit(id)
      }
      await Promise.all(Array.from({ length: 6 }, worker))
    },
    refreshGit: async (projectId) => {
      const p = get().projects.find((x) => x.id === projectId)
      if (!p) return
      const status = await window.loom.gitStatus(p.path)
      set((s) => ({ git: { ...s.git, [projectId]: status } }))
    },
    showMenu: (e, items, above) => set({ menu: { x: e.clientX, y: e.clientY, items, above } }),
    ask: (req) =>
      new Promise<string>((resolve) => {
        // One question at a time: an older one still open counts as cancelled.
        const open = get().confirm
        if (open) open.resolve(open.cancel)
        set({ confirm: { ...req, resolve } })
      }),
    showToast: (text, action) => {
      const id = uid()
      set((s) => ({ toasts: [...s.toasts.slice(-2), { id, text, action }] }))
      // One with something to do about it stays a little longer.
      setTimeout(() => get().dismissToast(id), action ? 10_000 : 7000)
    },
    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
    askText: (req) =>
      new Promise<string | null>((resolve) => {
        const open = get().confirm
        if (open) open.resolve(open.cancel)
        set({
          confirm: {
            title: req.title,
            body: req.body,
            choices: [
              { id: 'ok', label: req.confirm, kind: 'primary' },
              { id: 'cancel', label: 'Cancel', kind: 'ghost' }
            ],
            cancel: 'cancel',
            input: { value: req.value, placeholder: req.placeholder, select: req.select },
            resolve: (choice, text) => resolve(choice === 'ok' && text?.trim() ? text.trim() : null)
          }
        })
      }),
    bumpTree: () => set((s) => ({ treeVersion: s.treeVersion + 1 })),
    createEntry: async (dir, kind, projectId) => {
      const name = await get().askText({
        title: kind === 'file' ? 'New file' : 'New folder',
        body: `In ${shortPath(dir, get().info?.homeDir)}`,
        value: '',
        placeholder: kind === 'file' ? 'name.ext' : 'Folder name',
        confirm: 'Create'
      })
      if (!name) return
      const path = joinPath(dir, name)
      const r = await window.loom.createEntry(path, kind)
      if (!r.ok) return get().showToast(r.error ?? `${name} could not be created.`)
      get().bumpTree()
      if (kind === 'file') get().openFile(path, projectId)
    },
    renameEntry: async (path) => {
      const name = baseName(path)
      const dot = name.lastIndexOf('.')
      const next = await get().askText({ title: `Rename ${name}`, value: name, select: [0, dot > 0 ? dot : name.length], confirm: 'Rename' })
      if (!next || next === name) return
      const to = joinPath(parentDir(path), next)
      const r = await window.loom.renameEntry(path, to)
      if (!r.ok) return get().showToast(r.error ?? `${name} could not be renamed.`)
      // Open files follow the rename, inside a renamed folder too.
      const moved = (p: string): string | null => (normPath(p) === normPath(path) ? to : isInside(p, path) ? to + p.slice(path.length) : null)
      set((s) => ({
        tabs: s.tabs.map((t) => {
          if (t.kind !== 'file') return t
          const p = moved(t.path)
          return p ? { ...t, path: p, title: baseName(p) } : t
        })
      }))
      get().bumpTree()
    },
    trashEntry: async (path, isDir) => {
      const name = baseName(path)
      const choice = await get().ask({
        title: `Move ${name} to the Recycle Bin?`,
        body: isDir ? 'Everything inside it goes too. You can restore it from the Recycle Bin.' : 'You can restore it from the Recycle Bin.',
        choices: [
          { id: 'trash', label: 'Move to Recycle Bin', kind: 'danger' },
          { id: 'cancel', label: 'Cancel', kind: 'ghost' }
        ],
        cancel: 'cancel'
      })
      if (choice !== 'trash') return
      const r = await window.loom.trashEntry(path)
      if (!r.ok) return get().showToast(r.error ?? `${name} could not be moved to the Recycle Bin.`)
      const gone = get().tabs.filter((t) => t.kind === 'file' && (normPath(t.path) === normPath(path) || isInside(t.path, path)))
      const closing = new Set(gone.map((t) => t.id))
      for (const t of gone) get().closeTab(t.id, closing)
      get().bumpTree()
    },
    requestClose: async (tabIds) => {
      const pick = (): Tab[] => tabIds.map((id) => get().tabs.find((t) => t.id === id)).filter((t): t is Tab => !!t)
      const dirty = pick().filter((t) => t.kind === 'file' && get().dirtyFiles[t.id] && !get().detached[t.id])
      if (dirty.length) {
        const one = dirty.length === 1
        const choice = await get().ask({
          title: one ? `Save the changes to ${dirty[0].title}?` : `Save the changes to ${dirty.length} files?`,
          body: "If you don't save, the changes are lost.",
          items: one ? undefined : dirty.map((t) => t.title),
          choices: [
            { id: 'save', label: one ? 'Save' : 'Save all', kind: 'primary' },
            { id: 'discard', label: "Don't save", kind: 'danger' },
            { id: 'cancel', label: 'Cancel', kind: 'ghost' }
          ],
          cancel: 'cancel',
          focus: 'save'
        })
        if (choice === 'cancel') return false
        if (choice === 'save') {
          for (const t of dirty) {
            const saved = (await fileSavers.get(t.id)?.()) ?? false
            if (!saved) {
              get().activate(t.id)
              get().showToast(`${t.title} wasn't saved, so it stays open.`)
              return false
            }
          }
        }
      }
      // A teammate's chat only shown here is theirs to stop: closing its tab stops nothing.
      const working = pick().filter(
        (t) => t.kind === 'chat' && !get().detached[t.id] && chatBusy(get().chats[t.id]) && teamRole(get().team, t.sessionId)?.mine !== false
      )
      if (working.length) {
        const one = working.length === 1
        const choice = await get().ask({
          title: one ? `Claude is still working in ${working[0].title}` : `Claude is still working in ${working.length} chats`,
          body: 'Closing stops it. The conversation is saved, and you can continue it later from the sidebar.',
          items: one ? undefined : working.map((t) => t.title),
          choices: [
            { id: 'close', label: one ? 'Stop and close' : 'Stop them and close', kind: 'danger' },
            { id: 'cancel', label: 'Cancel', kind: 'ghost' }
          ],
          cancel: 'cancel'
        })
        if (choice !== 'close') return false
      }
      const closing = new Set(pick().map((t) => t.id))
      for (const t of pick()) get().closeTab(t.id, closing)
      return true
    },
    reopenClosed: () => {
      const list = [...get().closedTabs]
      const tab = list.pop()
      if (!tab) return
      const place = get().closedPlaces[tab.id]
      const closedPlaces = { ...get().closedPlaces }
      delete closedPlaces[tab.id]
      set({ closedTabs: list, closedPlaces })
      // Back where it was showing: the keyboard goes to that pane, and the tab opens in it.
      const goBack = (): void => {
        if (!place) return
        const s = get()
        if (paneById(s.layout, place.paneId)) return get().focusPane(place.paneId)
        // Its pane went when it closed. With the other panes still the ones from then, the split
        // comes back as it was, each showing what it shows now.
        const now = panesOf(s.layout)
        const then = panesOf(place.layout).filter((p) => p.id !== place.paneId)
        if (now.length !== then.length || !then.every((p) => now.some((n) => n.id === p.id))) return
        const layout = mapPanes(place.layout, (p) => (p.id === place.paneId ? { ...p, tabId: null } : (paneById(s.layout, p.id) ?? p)))
        set({ layout, focusedPane: place.paneId, activeTabId: null, pointerFocus: false })
      }
      if (tab.kind === 'file') {
        if (!get().tabs.some((t) => t.kind === 'file' && normPath(t.path) === normPath(tab.path))) goBack()
        return get().openFile(tab.path, tab.projectId)
      }
      if (tab.kind === 'chat') {
        const open = get().tabs.find((t) => t.kind === 'chat' && t.sessionId === tab.sessionId)
        if (open) return get().activate(open.id)
      }
      goBack()
      // The project may have gone meanwhile; the tab still opens, just without it.
      const projectId = tab.projectId && get().projects.some((p) => p.id === tab.projectId) ? tab.projectId : null
      get().openTab({ ...tab, id: uid(), projectId } as Tab)
    },
    reloadApp: async () => {
      if (POPOUT_TAB) return
      // Tabs in windows of their own come back first, with whatever they hold.
      const out = Object.keys(get().detached)
      for (const id of out) void window.loom.popoutClose(id)
      const until = Date.now() + 4000
      while (Object.keys(get().detached).length && Date.now() < until) await new Promise((r) => setTimeout(r, 50))
      const dirty = get().tabs.filter((t) => t.kind === 'file' && get().dirtyFiles[t.id])
      if (dirty.length) {
        const one = dirty.length === 1
        const choice = await get().ask({
          title: one ? `Save the changes to ${dirty[0].title} before reloading?` : `Save the changes to ${dirty.length} files before reloading?`,
          body: "Reloading starts the window over. If you don't save, the changes are lost.",
          items: one ? undefined : dirty.map((t) => t.title),
          choices: [
            { id: 'save', label: one ? 'Save and reload' : 'Save all and reload', kind: 'primary' },
            { id: 'discard', label: 'Reload without saving', kind: 'danger' },
            { id: 'cancel', label: 'Cancel', kind: 'ghost' }
          ],
          cancel: 'cancel',
          focus: 'save'
        })
        if (choice === 'cancel') return
        if (choice === 'save') {
          for (const t of dirty) {
            const saved = (await fileSavers.get(t.id)?.()) ?? false
            if (!saved) {
              get().activate(t.id)
              get().showToast(`${t.title} wasn't saved, so Loom did not reload.`)
              return
            }
          }
        }
      }
      // What is open goes to disk now; the reloaded window starts from it.
      window.loom.saveState(pickPersisted(get()))
      await window.loom.reloadApp()
    },
    requestRemoveProject: async (id) => {
      const p = get().projects.find((x) => x.id === id)
      if (!p) return
      const tabs = get().tabs.filter((t) => t.projectId === id)
      const terminals = tabs.filter((t) => t.kind === 'terminal').length
      const servers = get().servers.filter((x) => x.projectId === id && (x.status === 'running' || x.status === 'starting')).length
      const ends = [
        tabs.length ? `its ${tabs.length === 1 ? 'open tab closes' : `${tabs.length} open tabs close`}` : '',
        terminals ? `${terminals === 1 ? 'its terminal ends' : `${terminals} terminals end`}` : '',
        servers ? `${servers === 1 ? 'its dev server stops' : `${servers} dev servers stop`}` : ''
      ].filter(Boolean)
      const choice = await get().ask({
        title: `Remove ${p.name} from Loom?`,
        body: `The folder and its chat history stay on disk, and you can add it again later.${ends.length ? ` ${ends.join(', ').replace(/^./, (c) => c.toUpperCase())}.` : ''}`,
        choices: [
          { id: 'remove', label: 'Remove', kind: 'danger' },
          { id: 'cancel', label: 'Cancel', kind: 'ghost' }
        ],
        cancel: 'cancel'
      })
      if (choice !== 'remove') return
      if (tabs.length && !(await get().requestClose(tabs.map((t) => t.id)))) return
      get().removeProject(id)
    },
    requestDeleteGroup: async (id) => {
      const g = get().groups.find((x) => x.id === id)
      if (!g) return
      const count = get().projects.filter((p) => p.groupId === id).length
      const choice = await get().ask({
        title: `Delete the group ${g.name}?`,
        body: `${count === 1 ? 'Its project stays' : count ? `Its ${count} projects stay` : 'Nothing else changes'}${count ? ' in Loom, outside any group' : ''}. Nothing is deleted from disk.${g.watchPath ? ' It stops watching its folder for new projects.' : ''}`,
        choices: [
          { id: 'delete', label: 'Delete group', kind: 'danger' },
          { id: 'cancel', label: 'Cancel', kind: 'ghost' }
        ],
        cancel: 'cancel'
      })
      if (choice === 'delete') get().deleteGroup(id)
    }
  }
})

/** A readable model name: the account's label when known, else "Opus 5.5" style from the id. */
export function modelName(id: string | undefined, known: { value: string; label: string; resolved?: string }[]): string | undefined {
  if (!id) return undefined
  const hit = known.find((m) => m.value === id || m.resolved === id)
  if (hit) return hit.label
  const m = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?/)
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
  return id[0].toUpperCase() + id.slice(1)
}

export function activeTab(s: { tabs: Tab[]; activeTabId: string | null }): Tab | null {
  return s.tabs.find((t) => t.id === s.activeTabId) ?? null
}

export function sessionsForProject(sessions: SessionSummary[], projects: Project[], projectId: string): SessionSummary[] {
  return sessions.filter((s) => projectForPath(projects, s.cwd)?.id === projectId)
}
