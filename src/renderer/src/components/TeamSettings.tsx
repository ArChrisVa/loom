import { Check, Copy, LogOut, UserPlus, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { TeamStatus } from '@shared/team'
import { useStore } from '../store'

/** A member, as a small tile with their initial: beside their chats, in the list of members. */
export function MemberMark({ name, online }: { name: string; online?: boolean }): ReactNode {
  return (
    <span className={`member-mark${online === false ? ' is-away' : ''}`} aria-hidden="true">
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  )
}

function relayLine(t: TeamStatus): { text: string; tone?: 'warn' } {
  if (t.relay === 'online') {
    const others = t.members.filter((m) => m.id !== t.me)
    const here = others.filter((m) => m.online).length
    return { text: !others.length ? 'Connected. Nobody else is in it yet.' : here ? `Connected. ${here} of ${others.length} ${others.length === 1 ? 'teammate' : 'teammates'} online.` : 'Connected. Nobody else is online.' }
  }
  if (t.relay === 'error') return { text: t.error ?? 'Loom could not connect to this team.', tone: 'warn' }
  return { text: 'Connecting…' }
}

function Invite({ team }: { team: TeamStatus }): ReactNode {
  const [copied, setCopied] = useState(false)
  if (!team.invite) {
    return (
      <button className="btn" disabled={team.relay !== 'online'} onClick={() => void window.loom.teamInvite(team.id)}>
        <UserPlus /> Invite someone
      </button>
    )
  }
  const until = new Date(team.invite.expiresAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  return (
    <div className="invite-box">
      <div className="invite-line">
        <span className="invite-link selectable">{team.invite.url}</span>
        <button
          className="btn"
          onClick={() => {
            void navigator.clipboard.writeText(team.invite!.url)
            setCopied(true)
            setTimeout(() => setCopied(false), 1600)
          }}
        >
          {copied ? <Check /> : <Copy />} {copied ? 'Copied' : 'Copy link'}
        </button>
        <button className="icon-btn" title="Withdraw the invitation" aria-label="Withdraw the invitation" onClick={() => void window.loom.teamCancelInvite(team.id)}>
          <X />
        </button>
      </div>
      <p className="set-note">
        For one person, until {until}. They paste it in Loom under Settings, Team, Join a team. You are then asked here to let them in, so keep Loom open.
      </p>
    </div>
  )
}

function TeamBlock({ team }: { team: TeamStatus }): ReactNode {
  const s = useStore.getState()
  const projects = useStore((st) => st.projects)
  const keys = useStore((st) => st.teamKeys)
  const line = relayLine(team)
  const leave = async (): Promise<void> => {
    const pick = await s.ask({
      title: `Leave ${team.name}?`,
      body: 'Your chats are no longer shown to the team, and theirs no longer to you. Copies of their chats already on this PC stay.',
      choices: [
        { id: 'leave', label: 'Leave', kind: 'danger' },
        { id: 'cancel', label: 'Cancel', kind: 'ghost' }
      ],
      cancel: 'cancel'
    })
    if (pick === 'leave') void window.loom.teamLeave(team.id)
  }
  const remove = async (id: string, name: string): Promise<void> => {
    const pick = await s.ask({
      title: `Take ${name} out of ${team.name}?`,
      body: 'Their Loom can no longer connect to the team. What they already copied to their PC stays there.',
      choices: [
        { id: 'remove', label: 'Remove', kind: 'danger' },
        { id: 'cancel', label: 'Cancel', kind: 'ghost' }
      ],
      cancel: 'cancel'
    })
    if (pick === 'remove') void window.loom.teamRemove(team.id, id)
  }
  const share = async (path: string, on: boolean): Promise<void> => {
    const r = await window.loom.teamShare(team.id, path, on)
    if (!r.ok) s.showToast(r.error ?? 'That project could not be shared.')
  }
  return (
    <div className="team-block" data-team={team.id}>
      <div className="team-head">
        <div className="team-name">
          <span className="set-title">{team.name}</span>
          <span className={`team-state${line.tone ? ` is-${line.tone}` : ''}`}>{line.text}</span>
        </div>
        <button className="btn ghost" onClick={() => void leave()}>
          <LogOut /> Leave
        </button>
      </div>

      {team.requests.map((r) => (
        <div key={r.id} className="team-request" role="alert">
          <div className="team-request-text">
            <strong>{r.name}</strong> wants to join. Let them in only if their screen shows <span className="team-code">{r.code}</span>.
          </div>
          <button className="btn primary" onClick={() => void window.loom.teamAnswer(team.id, r.id, true)}>
            Let in
          </button>
          <button className="btn" onClick={() => void window.loom.teamAnswer(team.id, r.id, false)}>
            Refuse
          </button>
        </div>
      ))}

      <div className="set-row">
        <div className="set-text">
          <div className="set-title">Members</div>
          <div className="set-hint">Everyone here can open the chats of the projects shared below, and carry one on.</div>
        </div>
        <div className="set-control">
          <div className="team-members">
            <ul className="member-list">
              {team.members.map((m) => (
                <li key={m.id} className="member-row">
                  <MemberMark name={m.name} online={m.online} />
                  <span className="member-name">{m.name}</span>
                  <span className="member-note">{m.id === team.me ? 'You' : m.online ? 'Online' : 'Offline'}</span>
                  {m.id !== team.me ? (
                    <button className="icon-btn small" title={`Remove ${m.name}`} aria-label={`Remove ${m.name}`} onClick={() => void remove(m.id, m.name)}>
                      <X />
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
            <Invite team={team} />
          </div>
        </div>
      </div>

      <div className="set-row">
        <div className="set-text">
          <div className="set-title">Projects shared with it</div>
          <div className="set-hint">
            Every chat in a shared project shows for the team, unless you keep one private (right-click it in the sidebar). A project is matched on each PC by its git remote, so the folder can be anywhere.
          </div>
        </div>
        <div className="set-control">
          <div className="team-projects">
            {projects.map((p) => {
              const key = keys[p.id]
              return (
                <label key={p.id} className="check-row" title={key ? key : 'This project has no git remote, which is how a team tells that everyone has the same project'}>
                  <input type="checkbox" disabled={!key} checked={!!key && team.projects.includes(key)} onChange={(e) => void share(p.path, e.target.checked)} />
                  <span>
                    {p.name}
                    {!key ? <span className="member-note"> has no git remote</span> : null}
                  </span>
                </label>
              )
            })}
            {!projects.length ? <p className="set-note">Add a project folder first.</p> : null}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Settings, Team: the name this PC goes by, the teams it is in (their members, who to let in,
 * which projects are shared), and making or joining one.
 */
export function TeamSettings(): ReactNode {
  const team = useStore((s) => s.team)
  const [name, setName] = useState('')
  const [teamName, setTeamName] = useState('')
  const [link, setLink] = useState('')
  useEffect(() => {
    void useStore.getState().refreshTeamKeys()
  }, [])
  useEffect(() => {
    if (team?.name && !name) setName(team.name)
  }, [team?.name])
  if (!team) return null
  const named = !!team.name.trim()
  const saveName = (): void => {
    if (name.trim() && name.trim() !== team.name) void window.loom.teamName(name.trim())
  }
  const joining = team.joining
  return (
    <section className="set-section">
      <h2>Team</h2>
      <p className="set-lede">
        People working on the same project see each other&apos;s chats in it and can carry one on. Everyone keeps the project on their own PC and runs Claude there, on their own account. A chat&apos;s
        history is copied between you, sealed so that only the team can read it.
      </p>

      <div className="set-row">
        <div className="set-text">
          <div className="set-title">Your name</div>
          <div className="set-hint">What teammates see beside your chats.</div>
        </div>
        <div className="set-control">
          <input
            className="field team-field"
            value={name}
            maxLength={40}
            placeholder="Your name"
            aria-label="Your name"
            onChange={(e) => setName(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
        </div>
      </div>

      {team.teams.map((t) => (
        <TeamBlock key={t.id} team={t} />
      ))}

      <div className="set-row">
        <div className="set-text">
          <div className="set-title">Join a team</div>
          <div className="set-hint">Paste the invitation a teammate sent you. They let you in from their Loom, so they need it open.</div>
        </div>
        <div className="set-control">
          <div className="team-join">
            <div className="inline-field">
              <input
                className="field"
                value={link}
                placeholder="Paste the invitation link"
                aria-label="Invitation link"
                onChange={(e) => setLink(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && named && link.trim() && void window.loom.teamJoin(link.trim())}
              />
              <button className="btn" disabled={!named || !link.trim() || (!!joining && joining.state !== 'failed')} onClick={() => void window.loom.teamJoin(link.trim())}>
                Join
              </button>
            </div>
            {joining ? (
              <div className={`join-state is-${joining.state}`} role="status">
                {joining.state === 'connecting' ? (
                  <span>Asking the team. This waits until one of them has Loom open.</span>
                ) : joining.state === 'waiting' ? (
                  <span>
                    {joining.by} is being asked to let you in. Their screen should show <span className="team-code">{joining.code}</span>.
                  </span>
                ) : (
                  <span>{joining.error}</span>
                )}
                <button className="btn ghost" onClick={() => void window.loom.teamCancelJoin()}>
                  {joining.state === 'failed' ? 'Dismiss' : 'Cancel'}
                </button>
              </div>
            ) : null}
            {!named ? <p className="set-note">Say your name above first.</p> : null}
          </div>
        </div>
      </div>

      <div className="set-row">
        <div className="set-text">
          <div className="set-title">Start a team</div>
          <div className="set-hint">You then invite the others, one link each.</div>
        </div>
        <div className="set-control">
          <div className="inline-field">
            <input
              className="field"
              value={teamName}
              maxLength={40}
              placeholder="Name of the team"
              aria-label="Name of the team"
              onChange={(e) => setTeamName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || !named || !teamName.trim()) return
                void window.loom.teamCreate(teamName.trim())
                setTeamName('')
              }}
            />
            <button
              className="btn"
              disabled={!named || !teamName.trim()}
              onClick={() => {
                void window.loom.teamCreate(teamName.trim())
                setTeamName('')
              }}
            >
              Start
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}
