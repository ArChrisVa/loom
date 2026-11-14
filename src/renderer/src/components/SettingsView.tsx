import { BellRing, LogIn, LogOut, Play, RefreshCw, RotateCcw } from 'lucide-react'
import { comboOf, keysOf, SHORTCUTS, whyNot, type KeyChoices, type ShortcutId } from '../lib/keys'
import { DEFAULT_VOLUME, playTone, TONES } from '../lib/tones'
import { useEffect, useState, type ReactNode } from 'react'
import type { AuthStatus, ClaudeSource, EffortLevel, LoomSettings, NotifySound, PermissionMode, ShellChoice, UpdateStatus } from '@shared/types'
import { timeAgo } from '../lib/paths'
import { useStore } from '../store'
import { ALL_EFFORTS, EFFORT_LABELS, MODE_OPTIONS } from './Composer'
import { Dropdown } from './Menu'
import { ServiceAccounts } from './Accounts'
import { account } from './Onboarding'
import { PhoneAccess } from './PhoneAccess'
import { SignInPanel } from './SignIn'

/**
 * Who Loom chats as: the Claude Code sign-in on this PC. Sign out, or switch to another account
 * through the same sign-in terminal Get started uses. While a sign-in runs, it looks every few
 * seconds for the account to change.
 */
/** The account last seen signed in, kept while Settings closes for a sign-in and opens again. */
let lastAccount: string | null = null

function AccountRow(): ReactNode {
  const s = useStore.getState()
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const [busy, setBusy] = useState<'out' | 'waiting' | null>(null)
  const check = async (): Promise<AuthStatus> => {
    const a = await window.loom.authStatus().catch((e: Error) => ({ loggedIn: false, error: e.message }) as AuthStatus)
    const key = a.loggedIn ? (a.email ?? 'signed in') : null
    if (lastAccount !== null && key && key !== lastAccount) window.loom.accountChanged()
    if (key) lastAccount = key
    setAuth(a)
    return a
  }
  useEffect(() => {
    void check()
  }, [])

  const signOut = async (): Promise<boolean> => {
    setBusy('out')
    const r = await window.loom.logout()
    await check()
    setBusy(null)
    if (!r.ok) s.showToast(`Couldn't sign out: ${r.error ?? 'Claude Code did not answer.'}`)
    return r.ok
  }
  const signIn = (): void => setBusy('waiting')

  const hint =
    auth === null
      ? 'Checking the sign-in on this PC…'
      : auth.missing
        ? "Claude Code isn't installed on this PC, so there is no account yet. Get started below installs it."
        : auth.loggedIn
          ? `${account(auth)} Chats, plan limits and Claude Code in your terminals all use this account.`
          : 'Not signed in. Chats need a Claude account.'
  return (
    <Row title="Claude" hint={hint}>
      {busy === 'waiting' ? (
        <SignInPanel
          onEnd={() => {
            setBusy(null)
            void check()
          }}
        />
      ) : null}
      <div className="set-actions" hidden={busy === 'waiting'}>
        {auth?.loggedIn ? (
          <>
            <button
              className="btn"
              disabled={!!busy}
              onClick={async () => {
                const pick = await s.ask({
                  title: 'Switch to another Claude account?',
                  body: `This signs ${auth.email ?? 'this account'} out of Claude Code on this PC, then opens the sign-in for the account you want. Chats in the middle of a reply finish first.`,
                  choices: [
                    { id: 'switch', label: 'Sign out and switch', kind: 'primary' },
                    { id: 'cancel', label: 'Cancel', kind: 'ghost' }
                  ],
                  cancel: 'cancel'
                })
                if (pick === 'switch' && (await signOut())) signIn()
              }}
            >
              <RefreshCw /> Switch account
            </button>
            <button
              className="btn danger"
              disabled={!!busy}
              onClick={async () => {
                const pick = await s.ask({
                  title: `Sign out of ${auth.email ?? 'Claude'}?`,
                  body: 'Claude Code on this PC signs out, in Loom, VS Code and your terminals alike. Chats need you to sign in again before they can reply.',
                  choices: [
                    { id: 'out', label: 'Sign out', kind: 'danger' },
                    { id: 'cancel', label: 'Cancel', kind: 'ghost' }
                  ],
                  cancel: 'cancel'
                })
                if (pick === 'out') await signOut()
              }}
            >
              <LogOut /> Sign out
            </button>
          </>
        ) : auth && !auth.missing ? (
          <button className="btn primary" disabled={busy === 'out'} onClick={signIn}>
            <LogIn /> Sign in
          </button>
        ) : null}
      </div>
    </Row>
  )
}

/**
 * How Loom tells you a chat is done (or needs an answer) while you're in another window: a Windows
 * notification, a sound of Loom's own, or both. Says so when Windows has notifications off.
 */
function NotifyRow({
  notifyWhenDone,
  sound,
  volume,
  update
}: {
  notifyWhenDone: boolean
  sound: NotifySound
  volume: number
  update: (patch: Partial<LoomSettings>) => void
}): ReactNode {
  const [windowsOff, setWindowsOff] = useState(false)
  useEffect(() => {
    const look = (): void => void window.loom.notifyOff().then(setWindowsOff)
    look()
    // Back from Windows' settings: look again.
    window.addEventListener('focus', look)
    return () => window.removeEventListener('focus', look)
  }, [])
  return (
    <Row title="Notify me" hint="When a chat finishes, or Claude needs an answer, while you're in another window.">
      <div className="notify-controls">
        <label className="check-row">
          <input type="checkbox" checked={notifyWhenDone} onChange={(e) => update({ notifyWhenDone: e.target.checked })} />
          <span>Windows notification</span>
        </label>
        <div className="notify-sound">
          <span className="notify-sound-label">Sound</span>
          <Dropdown<NotifySound>
            value={sound}
            options={TONES}
            onChange={(v) => {
              update({ notifySound: v })
              playTone(v, volume)
            }}
          />
          <button className="icon-btn" title="Play this sound" aria-label="Play this sound" disabled={sound === 'off'} onClick={() => playTone(sound, volume)}>
            <Play />
          </button>
        </div>
        <label className="notify-volume">
          <span className="notify-sound-label">Volume</span>
          <input
            type="range"
            className="range"
            min={0}
            max={100}
            step={5}
            value={volume}
            disabled={sound === 'off'}
            style={{ ['--fill' as string]: `${volume}%` }}
            aria-valuetext={`${volume}%`}
            onChange={(e) => update({ notifyVolume: Number(e.target.value) })}
            // A preview once you let go, not on every step of the drag.
            onPointerUp={(e) => playTone(sound, Number(e.currentTarget.value))}
            onKeyUp={(e) => e.key.startsWith('Arrow') && playTone(sound, Number(e.currentTarget.value))}
          />
          <span className="notify-volume-value">{volume}%</span>
        </label>
        <button className="btn" onClick={() => window.loom.notifyTest()}>
          <BellRing /> Send a test
        </button>
        {windowsOff && notifyWhenDone ? (
          <p className="notify-warn">
            Windows has notifications turned off, so it won&apos;t show Loom&apos;s. A sound still plays if you pick one.{' '}
            <button className="link-btn" onClick={() => window.loom.notifySettings()}>
              Open Windows notification settings
            </button>
          </p>
        ) : null}
      </div>
    </Row>
  )
}

/**
 * The model and the effort a new chat starts with: what Claude Code recommends, unless one is
 * chosen here. Changing either in a chat changes that chat only.
 */
function NewChatRows({ model, effort, update }: { model: string | null | undefined; effort: EffortLevel | null | undefined; update: (patch: Partial<LoomSettings>) => void }): ReactNode {
  const known = useStore((s) => s.knownModels)
  const usual = useStore((s) => s.info?.defaultEffort ?? null)
  const claudeDefault = known.find((m) => m.value === '')
  const models = [
    { value: '', label: "Claude Code's default", description: claudeDefault?.description ?? 'What Claude Code recommends for your account' },
    ...known.filter((m) => m.value !== '').map((m) => ({ value: m.value, label: m.label, description: m.description }))
  ]
  // A model that is no longer offered still shows as chosen, by its name.
  if (model && !models.some((o) => o.value === model)) models.push({ value: model, label: model, description: 'Not in the current list of models' })
  const efforts: { value: EffortLevel | ''; label: string; description?: string }[] = [
    { value: '', label: usual ? `Default (${EFFORT_LABELS[usual]})` : 'Default', description: 'What your Claude settings use' },
    ...ALL_EFFORTS.map((e) => ({ value: e, label: EFFORT_LABELS[e] }))
  ]
  return (
    <>
      <Row
        title="Model for new chats"
        hint="Every new chat starts with this model. Picking another in a chat changes that chat only. Claude Code's default is what Claude Code recommends on this PC, and can differ from one account or version to another."
      >
        <Dropdown<string> value={model || ''} options={models} onChange={(v) => update({ newChatModel: v || null })} />
      </Row>
      <Row title="Effort for new chats" hint="How hard Claude thinks before answering, in a new chat. Changing it in a chat changes that chat only; a model that can't use the level chosen here falls back to its own.">
        <Dropdown<EffortLevel | ''> value={effort ?? ''} options={efforts} onChange={(v) => update({ newChatEffort: v || null })} />
      </Row>
    </>
  )
}

/**
 * Every shortcut with the keys it has, each changeable: Change waits for the next combination and
 * takes it unless it would get in the way of typing, belongs to every app (copy, paste), or is
 * another shortcut already. The keys that are not Loom's to move are listed below them.
 */
function KeyboardSettings({ chosen, sendWithCtrlEnter, update }: { chosen: KeyChoices | undefined; sendWithCtrlEnter: boolean; update: (patch: Partial<LoomSettings>) => void }): ReactNode {
  const [recording, setRecording] = useState<ShortcutId | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    if (!recording) return
    // The app's own shortcuts stand down while a combination is being chosen.
    useStore.setState({ recordingKeys: true })
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      const combo = comboOf(e)
      // Ctrl, Alt or Shift on their own: still waiting for the key.
      if (!combo) return
      if (combo === 'Esc') {
        setRecording(null)
        setProblem(null)
        return
      }
      const why = whyNot(combo, recording, chosen)
      if (why) return setProblem(why)
      const next = { ...chosen }
      if (combo === SHORTCUTS.find((s) => s.id === recording)!.keys) delete next[recording]
      else next[recording] = combo
      update({ keys: next as Record<string, string> })
      setRecording(null)
      setProblem(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      useStore.setState({ recordingKeys: false })
    }
  }, [recording, chosen])

  const changed = SHORTCUTS.filter((s) => chosen?.[s.id])
  const reset = (id: ShortcutId): void => {
    const next = { ...chosen }
    delete next[id]
    update({ keys: next as Record<string, string> })
  }
  return (
    <section className="set-section">
      <div className="set-heading">
        <h2>Keyboard</h2>
        {changed.length ? (
          <button className="btn ghost" onClick={() => update({ keys: {} })}>
            <RotateCcw /> Reset all
          </button>
        ) : null}
      </div>
      <p className="set-lede">Click Change, then press the keys you want. Keys are read by where they sit on the keyboard, so they work the same in any language layout.</p>
      <dl className="keys">
        {SHORTCUTS.map((s) => {
          const on = recording === s.id
          return (
            <div key={s.id} className={`key-row${on ? ' is-recording' : ''}`} data-shortcut={s.id}>
              <dt>
                {s.label}
                {s.where ? <span className="key-where">{s.where}</span> : null}
                {on && problem ? (
                  <span className="key-problem" role="alert">
                    {problem}
                  </span>
                ) : null}
              </dt>
              <dd>
                {on ? <span className="key-waiting">Press the new keys, or Esc to keep these</span> : <kbd>{keysOf(s.id, chosen)}</kbd>}
                {chosen?.[s.id] && !on ? (
                  <button className="icon-btn small" title={`Back to ${s.keys}`} aria-label={`Reset ${s.label} to ${s.keys}`} onClick={() => reset(s.id)}>
                    <RotateCcw />
                  </button>
                ) : null}
                <button
                  className="btn ghost key-change"
                  onClick={() => {
                    setProblem(null)
                    setRecording(on ? null : s.id)
                  }}
                >
                  {on ? 'Cancel' : 'Change'}
                </button>
              </dd>
            </div>
          )
        })}
        {[
          ['Go to a tab by its place', 'Ctrl+1 to Ctrl+9'],
          ['Stop Claude', 'Esc'],
          ['Send a message', sendWithCtrlEnter ? 'Ctrl+Enter' : 'Enter']
        ].map(([what, keys]) => (
          <div key={what} className="key-row is-fixed">
            <dt>{what}</dt>
            <dd>
              <kbd>{keys}</kbd>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

function Row({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }): ReactNode {
  return (
    <div className="set-row">
      <div className="set-text">
        <div className="set-title">{title}</div>
        {hint ? <div className="set-hint">{hint}</div> : null}
      </div>
      <div className="set-control">{children}</div>
    </div>
  )
}

/** What the About section says about updates. */
function updateLine(u: UpdateStatus): string {
  if (!u.enabled) return 'This copy is built from source. Update it with git pull, then npm run build.'
  switch (u.state) {
    case 'checking':
      return 'Checking for updates…'
    case 'downloading':
      return `Downloading Loom ${u.available}${u.percent ? ` (${u.percent}%)` : ''}. A Restart to update button appears when it's ready.`
    case 'ready':
      return `Loom ${u.available} is ready. Restart to install it; your tabs and chats come back.`
    case 'none':
      return `Loom is up to date.${u.checkedAt ? ` Checked ${timeAgo(u.checkedAt)}.` : ''}`
    case 'error':
      return `Couldn't check for updates. ${u.error ?? ''}`.trim()
    default:
      return 'Loom looks for updates when it starts and every few hours.'
  }
}

export function SettingsView(): ReactNode {
  const s = useStore()
  const st = s.settings
  const info = s.info
  // Look again for Claude Code each time Settings opens: it may have been installed since.
  useEffect(() => {
    void window.loom.claudeInfo().then((next) => useStore.getState().set({ info: next }))
  }, [])
  const update = (patch: Partial<LoomSettings>): void => s.set({ settings: { ...st, ...patch } })

  // The installed Loom app has no bundled copy; there "bundled" quietly means the installed one.
  const hasBundled = !!info?.bundledPath
  const source: ClaudeSource = st.claudeSource === 'bundled' && info && !hasBundled ? 'installed' : st.claudeSource
  const sources: { value: ClaudeSource; label: string; detail: string }[] = [
    ...(hasBundled || !info ? [{ value: 'bundled' as const, label: 'Bundled with Loom', detail: info?.bundledPath ?? '' }] : []),
    { value: 'installed', label: 'Your installed Claude Code', detail: info?.installedPath ?? 'Not found on this PC' },
    { value: 'custom', label: 'Another program', detail: 'Pick a claude.exe below' }
  ]

  return (
    <div className="settings">
      <div className="settings-inner">
        <h1>Settings</h1>

        <section className="set-section">
          <h2>Accounts</h2>
          <AccountRow />
          <ServiceAccounts />
        </section>

        <section className="set-section">
          <h2>Claude</h2>
          <Row title="Program that runs your chats" hint="Every option uses your Claude Code sign-in, settings, skills and hooks. Changes apply to chats you start or restart from now on.">
            <div className="radio-list">
              {sources.map((o) => (
                <label key={o.value} className="radio-row">
                  <input type="radio" name="claude-source" checked={source === o.value} onChange={() => update({ claudeSource: o.value })} />
                  <span>
                    <span className="radio-label">{o.label}</span>
                    <span className="radio-detail selectable">{o.detail}</span>
                  </span>
                </label>
              ))}
              {source === 'custom' ? (
                <div className="inline-field">
                  <input
                    className="field"
                    placeholder="C:\path\to\claude.exe"
                    value={st.claudeCustomPath}
                    aria-invalid={!st.claudeCustomPath.trim()}
                    onChange={(e) => update({ claudeCustomPath: e.target.value })}
                  />
                  <button
                    className="btn"
                    onClick={async () => {
                      const p = await window.loom.pickFile('Choose claude.exe')
                      if (p) update({ claudeCustomPath: p })
                    }}
                  >
                    Browse…
                  </button>
                </div>
              ) : null}
            </div>
          </Row>
          <Row
            title="Permission mode for new chats"
            hint="What Claude may do without asking, in a new chat. Changing the mode in a chat changes that chat only."
          >
            <Dropdown<PermissionMode | 'settings'>
              value={st.defaultPermissionMode ?? 'settings'}
              options={[{ value: 'settings', label: 'Follow my Claude settings', description: 'Uses defaultMode from settings.json' }, ...MODE_OPTIONS]}
              onChange={(v) => update({ defaultPermissionMode: v === 'settings' ? null : v })}
            />
          </Row>
          <NewChatRows model={st.newChatModel} effort={st.newChatEffort} update={update} />
          <Row title="Send messages with" hint="The other combination adds a new line.">
            <div className="segmented">
              <button aria-selected={!st.sendWithCtrlEnter} onClick={() => update({ sendWithCtrlEnter: false })}>
                Enter
              </button>
              <button aria-selected={st.sendWithCtrlEnter} onClick={() => update({ sendWithCtrlEnter: true })}>
                Ctrl+Enter
              </button>
            </div>
          </Row>
          <Row title="Timeline" hint="How Claude's steps show in a chat. Quiet keeps every step but tones it down: small grey dots, a fainter line and lighter step names, closer together.">
            <div className="segmented">
              <button aria-selected={st.timeline !== 'quiet'} onClick={() => update({ timeline: 'full' })}>
                Full
              </button>
              <button aria-selected={st.timeline === 'quiet'} onClick={() => update({ timeline: 'quiet' })}>
                Quiet
              </button>
            </div>
          </Row>
          <NotifyRow notifyWhenDone={st.notifyWhenDone} sound={st.notifySound ?? 'off'} volume={st.notifyVolume ?? DEFAULT_VOLUME} update={update} />
        </section>

        <PhoneAccess />

        <section className="set-section">
          <h2>Backups</h2>
          <Row
            title="Keep copies of moved chats"
            hint="Moving a chat to another project keeps a copy of the original in .claude\chat-backups, in your user folder. Copies older than this are deleted for good."
          >
            <Dropdown<string>
              value={String(st.keepChatBackupsDays ?? 30)}
              options={[
                { value: '7', label: '7 days' },
                { value: '14', label: '14 days' },
                { value: '30', label: '30 days' },
                { value: '90', label: '90 days' },
                { value: '180', label: '6 months' },
                { value: '365', label: 'A year' },
                { value: '0', label: 'Forever' }
              ]}
              onChange={(v) => update({ keepChatBackupsDays: Number(v) })}
            />
          </Row>
        </section>

        <section className="set-section">
          <h2>Getting started</h2>
          <Row title="The first-launch steps" hint="Signing in to Claude, adding projects, and how much Claude does without asking.">
            <button className="btn" onClick={() => s.openStart()}>
              Show the steps
            </button>
          </Row>
        </section>

        <section className="set-section">
          <h2>Terminal</h2>
          <Row title="Shell" hint="Used for new terminal tabs.">
            <Dropdown<ShellChoice>
              value={st.shell}
              options={[
                { value: 'powershell', label: 'PowerShell' },
                { value: 'cmd', label: 'Command Prompt' },
                { value: 'gitbash', label: 'Git Bash' }
              ]}
              onChange={(v) => update({ shell: v })}
            />
          </Row>
        </section>

        {s.update ? (
          <section className="set-section">
            <h2>About</h2>
            <Row title={`Loom ${s.update.version}`} hint={updateLine(s.update)}>
              {/* What's new for every copy; updating only where Loom updates itself (not from source). */}
              <div className="set-actions">
                {!s.update.enabled ? null : s.update.state === 'ready' ? (
                  <button className="btn primary" onClick={() => void window.loom.updateInstall()}>
                    Restart to update
                  </button>
                ) : (
                  <button
                    className="btn"
                    disabled={s.update.state === 'checking' || s.update.state === 'downloading'}
                    onClick={() => void window.loom.updateCheck()}
                  >
                    Check for updates
                  </button>
                )}
                <button className="btn ghost" onClick={() => s.showWhatsNew()}>
                  What&apos;s new
                </button>
              </div>
            </Row>
          </section>
        ) : null}

        <KeyboardSettings chosen={st.keys} sendWithCtrlEnter={st.sendWithCtrlEnter} update={update} />
      </div>
    </div>
  )
}
