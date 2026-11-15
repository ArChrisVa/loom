import { Check, Copy, LogOut, Plus, UserPlus, X } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { TeamStatus } from '@shared/team'
import type { Project } from '@shared/types'
import { namesOf, sharersOf, useStore } from '../store'
import { ProjectMark } from './ProjectMark'

/**
 * A member, as a round mark with their initial: beside their chats, in the list of members. Round,
 * where a project's icon is a square, so a person is never taken for a project; a green dot on
 * its rim says they are online right now.
 */
export function MemberMark({ name, online }: { name: string; online?: boolean }): ReactNode {
  return (
    <span className={`member-mark${online === false ? ' is-away' : online ? ' is-online' : ''}`} aria-hidden="true">
      {(Array.from(name.trim())[0] ?? '?').toUpperCase()}
    </span>
  )
}

/**
 * The projects a team shares, from this PC's side. The ones shared here are a short list, each
 * saying who else shares it; the ones teammates share and this PC does not are offered; every
 * other project waits behind Share a project, found by typing, with the ones a team cannot share
 * (no git remote) folded away at its end.
 */
function TeamProjects({ team }: { team: TeamStatus }): ReactNode {
  const s = useStore.getState()
  const projects = useStore((st) => st.projects)
  const groups = useStore((st) => st.groups)
  const keys = useStore((st) => st.teamKeys)
  const [picking, setPicking] = useState(false)
  const [filter, setFilter] = useState('')
  const others = team.members.filter((m) => m.id !== team.me)

  const shared = projects.filter((p) => !!keys[p.id] && team.projects.includes(keys[p.id]!))
  const free = projects.filter((p) => !!keys[p.id] && !team.projects.includes(keys[p.id]!))
  // Looked at and found without a remote: null. Not looked at yet is neither here nor there.
  const bare = projects.filter((p) => keys[p.id] === null)
  const alone = shared.some((p) => !sharersOf(team, keys[p.id]).length)

  // What teammates share and this PC does not, by the address of the git remote.
  const theirs = useMemo(() => {
    const by = new Map<string, typeof others>()
    for (const m of others) for (const k of team.shares[m.id] ?? []) if (!team.projects.includes(k)) by.set(k, [...(by.get(k) ?? []), m])
    return [...by.entries()].map(([key, who]) => ({ key, who, here: projects.find((p) => keys[p.id] === key) }))
  }, [team.shares, team.projects, team.members, projects, keys])

  // The picker: the projects not shared yet, under the groups the sidebar keeps them in.
  const q = filter.trim().toLowerCase()
  const found = free.filter((p) => !q || p.name.toLowerCase().includes(q) || (keys[p.id] ?? '').toLowerCase().includes(q))
  const sections: { id: string; label: string; items: Project[] }[] = [
    ...groups.map((g) => ({ id: g.id, label: g.name, items: found.filter((p) => p.groupId === g.id) })),
    { id: '', label: groups.length ? 'In no group' : '', items: found.filter((p) => !p.groupId || !groups.some((g) => g.id === p.groupId)) }
  ].filter((x) => x.items.length)

  return (
    <div className="team-projects">
      {shared.length ? (
        <ul className="share-list" aria-label={`Projects you share with ${team.name}`}>
          {shared.map((p) => {
            const also = sharersOf(team, keys[p.id])
            return (
              <li key={p.id} className="share-row" data-shared={p.name}>
                <ProjectMark project={p} size={16} />
                <span className="share-name" title={keys[p.id] ?? undefined}>
                  {p.name}
                </span>
                <span className={`share-who${also.length ? '' : ' is-alone'}`}>{also.length ? `${namesOf(also)} too` : others.length ? 'Only you so far' : ''}</span>
                <button className="icon-btn small" title={`Stop sharing ${p.name}`} aria-label={`Stop sharing ${p.name}`} onClick={() => void s.shareProject(team.id, p.path, false)}>
                  <X />
                </button>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="set-note share-empty">Nothing is shared yet, so nobody sees a chat of yours and you see none of theirs.</p>
      )}
      {alone && others.length ? (
        <p className="set-note">
          Only you so far: {others.length === 1 ? others[0].name : 'a teammate'} has to share the project too, on their own PC, with the same repository added to their Loom. Until then neither of you
          sees the other&apos;s chats in it.
        </p>
      ) : null}

      {theirs.length ? (
        <div className="share-offers">
          <div className="share-head">Shared by teammates, not by you yet</div>
          <ul className="share-list">
            {theirs.map(({ key, who, here }) => (
              <li key={key} className="share-row" data-offer={key}>
                {here ? <ProjectMark project={here} size={16} /> : null}
                <span className="share-name" title={key}>
                  {here ? here.name : key}
                </span>
                <span className="share-who">{namesOf(who)}</span>
                {here ? (
                  <button className="btn small" onClick={() => void s.shareProject(team.id, here.path, true)}>
                    Share it too
                  </button>
                ) : (
                  <span className="share-missing">Not on this PC</span>
                )}
              </li>
            ))}
          </ul>
          {theirs.some((x) => !x.here) ? <p className="set-note">For one that is not on this PC, clone the repository, add its folder to Loom, and it shows here to share.</p> : null}
        </div>
      ) : null}

      {picking ? (
        <div className="share-picker">
          <div className="share-picker-top">
            <input className="field" type="search" autoFocus value={filter} placeholder="Find a project" aria-label="Find a project to share" onChange={(e) => setFilter(e.target.value)} />
            <button
              className="btn"
              onClick={() => {
                setPicking(false)
                setFilter('')
              }}
            >
              Done
            </button>
          </div>
          <div className="share-options" role="group" aria-label="Projects you can share">
            {sections.map((sec) => (
              <div key={sec.id} className="share-group">
                {sec.label ? <div className="share-head">{sec.label}</div> : null}
                {sec.items.map((p) => (
                  <button key={p.id} className="share-option" data-option={p.name} onClick={() => void s.shareProject(team.id, p.path, true)}>
                    <ProjectMark project={p} size={16} />
                    <span className="share-name">{p.name}</span>
                    <span className="share-key">{keys[p.id]}</span>
                  </button>
                ))}
              </div>
            ))}
            {!sections.length ? <p className="set-note share-none">{free.length ? 'No project matches that.' : projects.length ? 'Every project with a git remote is shared already.' : 'Add a project folder first.'}</p> : null}
            {bare.length ? (
              <details className="share-bare">
                <summary>
                  {bare.length} {bare.length === 1 ? 'project has' : 'projects have'} no git remote
                </summary>
                <p className="set-note">
                  A team tells that everyone has the same project by the address of its git remote. Put one of these on GitHub, or another git host, and it can be shared.
                </p>
                <ul className="share-bare-list">
                  {bare.map((p) => (
                    <li key={p.id}>
                      <ProjectMark project={p} size={14} />
                      {p.name}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        </div>
      ) : (
        <button className="btn" onClick={() => setPicking(true)}>
          <Plus /> Share a project
        </button>
      )}
    </div>
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
          <div className="set-title">Shared projects</div>
          <div className="set-hint">
            Sharing is done on each PC. You and a teammate see each other&apos;s chats in a project once both of you have its repository in Loom and both share it here. It is matched by its git
            remote, so the folder can be anywhere. Every chat in it shows for the team, unless you keep one private (right-click it in the sidebar).
          </div>
        </div>
        <div className="set-control">
          <TeamProjects team={team} />
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
  const typingOn = useStore((s) => s.settings.teamTyping !== false)
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

      {team.teams.length ? (
        <div className="set-row">
          <div className="set-text">
            <div className="set-title">What you type</div>
            <div className="set-hint">A teammate who has one of your chats open sees your message taking shape in its message box, before you send it.</div>
          </div>
          <div className="set-control">
            <label className="check-row">
              <input type="checkbox" checked={typingOn} onChange={(e) => useStore.getState().set({ settings: { ...useStore.getState().settings, teamTyping: e.target.checked } })} />
              <span>Show what I am typing</span>
            </label>
          </div>
        </div>
      ) : null}

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
