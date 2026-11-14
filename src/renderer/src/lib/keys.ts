// Loom's keyboard shortcuts: what each does, its default keys, and the ones changed in Settings.
// A shortcut is written the way it reads: "Ctrl+Shift+T". Keys are named by their place on the
// keyboard, not the letter the layout types there, so Ctrl+W is the same key under a Greek layout.

import { useStore } from '../store'

export type ShortcutId =
  | 'newChat'
  | 'closeTab'
  | 'reopenTab'
  | 'nextTab'
  | 'prevTab'
  | 'quickOpen'
  | 'openFile'
  | 'newTerminal'
  | 'splitRight'
  | 'splitDown'
  | 'nextPane'
  | 'prevPane'
  | 'toggleSidebar'
  | 'togglePanel'
  | 'settings'
  | 'cycleMode'
  | 'sendBackground'
  | 'saveFile'

export interface Shortcut {
  id: ShortcutId
  label: string
  keys: string
  /** More keys for the same thing, while the shortcut is still the default one */
  also?: string[]
  /** Where it acts, when not everywhere */
  where?: string
}

export const SHORTCUTS: Shortcut[] = [
  { id: 'newChat', label: 'New chat in this project', keys: 'Ctrl+T' },
  { id: 'closeTab', label: 'Close tab', keys: 'Ctrl+W' },
  { id: 'reopenTab', label: 'Reopen the tab closed last', keys: 'Ctrl+Shift+T' },
  { id: 'nextTab', label: 'Next tab', keys: 'Ctrl+Tab' },
  { id: 'prevTab', label: 'Previous tab', keys: 'Ctrl+Shift+Tab' },
  { id: 'quickOpen', label: 'Find a file or a chat', keys: 'Ctrl+P' },
  { id: 'openFile', label: 'Open a file from anywhere on the PC', keys: 'Ctrl+O' },
  { id: 'newTerminal', label: 'New terminal', keys: 'Ctrl+`' },
  { id: 'splitRight', label: 'Split to the right', keys: 'Ctrl+\\' },
  { id: 'splitDown', label: 'Split down', keys: 'Ctrl+Shift+\\' },
  { id: 'nextPane', label: 'Next pane', keys: 'Ctrl+Alt+Right', also: ['Ctrl+Alt+Down'] },
  { id: 'prevPane', label: 'Previous pane', keys: 'Ctrl+Alt+Left', also: ['Ctrl+Alt+Up'] },
  { id: 'toggleSidebar', label: 'Show or hide the sidebar', keys: 'Ctrl+B' },
  { id: 'togglePanel', label: 'Show or hide the Files, Git and Claude panel', keys: 'Ctrl+Alt+B' },
  { id: 'settings', label: 'Settings', keys: 'Ctrl+,' },
  { id: 'cycleMode', label: 'Next permission mode', keys: 'Shift+Tab', where: 'in a chat' },
  { id: 'sendBackground', label: 'Send to background', keys: 'Alt+Enter', where: 'in the message box' },
  { id: 'saveFile', label: 'Save a file', keys: 'Ctrl+S', where: 'in a file' }
]

/** Keys that are not letters or digits, by where they sit, and the name each goes by. */
const NAMED: Record<string, string> = {
  Backquote: '`',
  Backslash: '\\',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  Tab: 'Tab',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Space: 'Space',
  Escape: 'Esc',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown'
}

/** The key pressed, by its place on the keyboard; null for Ctrl, Alt and Shift themselves. */
function keyName(e: KeyboardEvent): string | null {
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3)
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5)
  if (/^F([1-9]|1[0-2])$/.test(e.code)) return e.code
  return NAMED[e.code] ?? null
}

/** A key press as a shortcut is written: "Ctrl+Shift+T". Null while only modifiers are down. */
export function comboOf(e: KeyboardEvent): string | null {
  const key = keyName(e)
  if (!key) return null
  return [e.ctrlKey || e.metaKey ? 'Ctrl' : '', e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : '', key].filter(Boolean).join('+')
}

export type KeyChoices = Partial<Record<ShortcutId, string>>

/** The keys a shortcut has now: the one chosen in Settings, else its default. */
export function keysOf(id: ShortcutId, chosen: KeyChoices | undefined): string {
  return chosen?.[id] || SHORTCUTS.find((s) => s.id === id)!.keys
}

let cache: { chosen: KeyChoices | undefined; map: Map<string, ShortcutId> } | null = null
function lookup(chosen: KeyChoices | undefined): Map<string, ShortcutId> {
  if (cache && cache.chosen === chosen) return cache.map
  const map = new Map<string, ShortcutId>()
  // The extra default keys first, so a key chosen for something else wins over them.
  for (const s of SHORTCUTS) if (!chosen?.[s.id]) for (const k of s.also ?? []) map.set(k, s.id)
  for (const s of SHORTCUTS) map.set(keysOf(s.id, chosen), s.id)
  cache = { chosen, map }
  return map
}

/** The shortcut a key press is, if any. */
export function shortcutOf(e: KeyboardEvent, chosen: KeyChoices | undefined): ShortcutId | null {
  const combo = comboOf(e)
  return combo ? (lookup(chosen).get(combo) ?? null) : null
}

/** Whether a key press is this shortcut. */
export function isShortcut(e: KeyboardEvent, id: ShortcutId, chosen: KeyChoices | undefined): boolean {
  return shortcutOf(e, chosen) === id
}

// Keys that mean something everywhere and stay what they are.
const TAKEN: Record<string, string> = {
  'Ctrl+C': 'copying',
  'Ctrl+V': 'pasting',
  'Ctrl+X': 'cutting',
  'Ctrl+A': 'selecting everything',
  'Ctrl+Z': 'undoing',
  'Ctrl+Y': 'redoing',
  'Ctrl+Shift+Z': 'redoing',
  'Ctrl+F': 'finding in a file',
  Esc: 'stopping Claude and closing things',
  Enter: 'sending a message',
  'Ctrl+Enter': 'sending a message',
  'Shift+Enter': 'a new line in a message',
  Tab: 'moving between controls',
  'Ctrl+=': 'zooming in',
  'Ctrl+-': 'zooming out',
  'Ctrl+0': 'resetting the zoom'
}

/**
 * Why a combination can't be a shortcut, or null when it can. One that would type a character
 * (a letter with no Ctrl or Alt) is out, as are the keys every app shares and the tab numbers.
 */
export function whyNot(combo: string, id: ShortcutId, chosen: KeyChoices | undefined): string | null {
  const parts = combo.split('+')
  const key = parts[parts.length - 1]
  const held = parts.slice(0, -1)
  if (TAKEN[combo]) return `${combo} is kept for ${TAKEN[combo]}.`
  if (/^Ctrl\+[1-9]$/.test(combo)) return `${combo} goes to a tab by its number.`
  const functionKey = /^F\d+$/.test(key)
  const quiet = functionKey || (combo === 'Shift+Tab' && id === 'cycleMode')
  if (!held.includes('Ctrl') && !held.includes('Alt') && !quiet) return 'Use Ctrl or Alt with it, so it never gets in the way of typing.'
  const other = SHORTCUTS.find((s) => s.id !== id && (keysOf(s.id, chosen) === combo || (!chosen?.[s.id] && s.also?.includes(combo))))
  if (other) return `${combo} is already "${other.label}".`
  return null
}

/** The keys a shortcut has now, for hints and tooltips; follows Settings. */
export function useKeys(id: ShortcutId): string {
  return useStore((s) => keysOf(id, s.settings.keys))
}

/**
 * Whether the keyboard is in the chat in front: in its message box, or on nothing in particular.
 * Shift+Tab changes the permission mode only then. On a button or a field, in a menu or a
 * dialog, it keeps stepping back between controls, which people who use the keyboard rely on.
 */
export function keyboardInChat(): boolean {
  if (document.querySelector('.confirm-backdrop, .menu, [role="dialog"], .palette')) return false
  const el = document.activeElement as HTMLElement | null
  if (!el || el === document.body) return true
  if (!el.closest('.tab-panel:not([hidden]) .chat, .popout .chat')) return false
  return el.classList.contains('composer-input') || !el.matches('button, a, input, select, textarea, summary, [role="button"]')
}
