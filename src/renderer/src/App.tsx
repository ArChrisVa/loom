import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { ConfirmHost, ToastHost } from './components/Confirm'
import { WhatsNew } from './components/WhatsNew'
import { FileDropHint, useFileDrop } from './components/FileDrop'
import { ImageViewer } from './components/ImageViewer'
import { ContextMenuHost } from './components/Menu'
import { QuickOpen } from './components/QuickOpen'
import { RightPanel } from './components/RightPanel'
import { Sidebar } from './components/Sidebar'
import { StatusBar } from './components/StatusBar'
import { FileBar, TabBar } from './components/TabBar'
import { Workspace } from './components/Workspace'
import { comboOf, keyboardInChat, keyboardInTerminal, redoBelongsHere, shortcutOf } from './lib/keys'
import { inFileRow, panesOf } from './lib/layout'
import { useResizing } from './lib/resizing'
import { startRemoteAgent } from './remoteAgent'
import { tabsInOrder, useStore } from './store'
import wordmark from './assets/brand/loom-wordmark.webp'
import wordmark2x from './assets/brand/loom-wordmark@2x.webp'

// Shortcuts are listed in lib/keys.ts with their default keys; Settings can change them. They are
// matched by where a key sits on the keyboard, so Ctrl+W is the same key under a Greek layout.
function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const s = useStore.getState()
      if (s.confirm || s.recordingKeys) return
      const tab = s.tabs.find((t) => t.id === s.activeTabId)
      const tabStep = (by: 1 | -1): void => {
        // In the order the tabs are shown, past the ones living in a window of their own.
        const list = tabsInOrder(s.tabs).filter((t) => !s.detached[t.id] || t.id === s.activeTabId)
        if (!list.length) return
        const i = list.findIndex((t) => t.id === s.activeTabId)
        s.activate(list[(i + by + list.length) % list.length].id)
      }
      const paneStep = (by: 1 | -1): boolean => {
        const list = panesOf(s.layout)
        if (list.length < 2) return false
        const i = list.findIndex((p) => p.id === s.focusedPane)
        s.focusPane(list[(i + by + list.length) % list.length].id)
        return true
      }
      // Ctrl+Shift+Z stays redo in a file being edited, and in a text field with something to redo.
      if (comboOf(e) === 'Ctrl+Shift+Z' && redoBelongsHere()) return
      switch (shortcutOf(e, s.settings.keys)) {
        case 'splitRight':
          s.splitPane('right')
          break
        case 'splitDown':
          s.splitPane('bottom')
          break
        case 'nextPane':
          if (!paneStep(1)) return
          break
        case 'prevPane':
          if (!paneStep(-1)) return
          break
        case 'nextTab':
          tabStep(1)
          break
        case 'prevTab':
          tabStep(-1)
          break
        case 'closeTab':
          if (tab) void s.requestClose([tab.id])
          else if (panesOf(s.layout).length > 1) s.closePane()
          break
        case 'reopenTab':
          s.reopenClosed()
          break
        case 'reload':
          // In a terminal, Ctrl+R searches the shell's history.
          if (keyboardInTerminal()) return
          void s.reloadApp()
          break
        case 'newChat':
          s.newChat(tab?.projectId ?? s.projects[0]?.id ?? null)
          break
        case 'quickOpen':
          s.set({ quickOpen: !s.quickOpen })
          break
        case 'openFile':
          void s.pickAndOpenFiles()
          break
        case 'newTerminal':
          s.newTerminal(tab?.projectId ?? null)
          break
        case 'togglePanel':
          s.set({ rightPanelOpen: !s.rightPanelOpen })
          break
        case 'toggleSidebar':
          s.set({ sidebarOpen: !s.sidebarOpen })
          break
        case 'settings':
          s.openSettings()
          break
        case 'cycleMode':
          // Only with the keyboard in a chat: everywhere else Shift+Tab steps back between controls.
          if (tab?.kind !== 'chat' || !keyboardInChat()) return
          s.cycleMode(tab.id)
          break
        default: {
          // Ctrl+1 to Ctrl+9 go to a tab by its place; 9 is the last one. These stay as they are.
          // Saving a file and sending to the background are handled where they happen.
          if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || !/^Digit[1-9]$/.test(e.code)) return
          const list = tabsInOrder(s.tabs)
          const t = list[e.code === 'Digit9' ? list.length - 1 : Number(e.code.slice(5)) - 1]
          if (!t) return
          s.activate(t.id)
        }
      }
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}

function Resizer({ side }: { side: 'left' | 'right' }): ReactNode {
  const start = useRef<{ x: number; w: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  useResizing(dragging)
  return (
    <div
      className={`resizer resizer-${side}${dragging ? ' dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      onPointerDown={(e) => {
        const s = useStore.getState()
        start.current = { x: e.clientX, w: side === 'left' ? s.sidebarWidth : s.rightPanelWidth }
        ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
        setDragging(true)
      }}
      onPointerMove={(e) => {
        if (!start.current) return
        const dx = e.clientX - start.current.x
        const w = Math.round(Math.max(200, Math.min(520, start.current.w + (side === 'left' ? dx : -dx))))
        useStore.getState().set(side === 'left' ? { sidebarWidth: w } : { rightPanelWidth: w })
      }}
      onPointerUp={() => {
        start.current = null
        setDragging(false)
      }}
      onLostPointerCapture={() => {
        start.current = null
        setDragging(false)
      }}
    />
  )
}

export function App(): ReactNode {
  const s = useStore()
  useFileDrop()
  useShortcuts()

  useEffect(() => {
    void useStore.getState().init().then(startRemoteAgent)
  }, [])

  useEffect(() => {
    const onFocus = (): void => {
      void useStore.getState().refreshSessions()
      void useStore.getState().checkWatched()
      useStore.getState().bumpTree()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  if (!s.ready) return <div className="boot" />

  const style = {
    // Never so wide together that the work area is squeezed out in a narrow window.
    '--sbw': s.sidebarOpen ? `min(${s.sidebarWidth}px, 30vw)` : '0px',
    '--rpw': s.rightPanelOpen ? `min(${s.rightPanelWidth}px, 35vw)` : '0px',
    '--filebar': s.tabs.some(inFileRow) ? '30px' : '0px'
  } as CSSProperties

  return (
    <div className="app" style={style}>
      {s.sidebarOpen ? (
        <>
          <div className="brand">
            <img className="brand-wordmark" src={wordmark} srcSet={`${wordmark} 2x, ${wordmark2x} 4x`} alt="Loom" draggable={false} />
          </div>
          <Sidebar />
          <Resizer side="left" />
        </>
      ) : null}
      <TabBar />
      <FileBar />
      <Workspace />
      {s.rightPanelOpen ? (
        <>
          <Resizer side="right" />
          <RightPanel />
        </>
      ) : null}
      <StatusBar />
      <ContextMenuHost />
      <ImageViewer />
      {s.quickOpen ? <QuickOpen /> : null}
      <ConfirmHost />
      <WhatsNew />
      <FileDropHint />
      <ToastHost />
    </div>
  )
}
