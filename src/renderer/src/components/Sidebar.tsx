import { useCallback, useEffect, useRef, useState } from 'react'
import type { Project, Workspace } from '../../../preload/index.d'
import { formatCountdown } from '../../../shared/format'
import { tabLabel } from '../format'
import { type QueStore, SCRATCH, usePanes, useQueSelector, useStore } from '../store'
import { countOpenTickets } from '../ticket-tree'
import { filterSidebar, matches, sortProjects, sortWorkspaces } from '../sidebar-order'
import { hoverWord, type RowTone, rowTone } from '../sidebar-row'
import { NOW_SECONDS_INTERVAL_MS, useNow } from '../useNow'
import { useUnlockCountdown } from '../useUnlockCountdown'
import UpdateChip from './UpdateChip'
import {
  ChevronIcon,
  FolderIcon,
  FolderPlusIcon,
  GearIcon,
  PlusIcon,
  ReportIcon,
  SearchIcon,
  SortIcon,
  TicketIcon,
  UnlockIcon
} from './icons'
import BackgroundMark from './BackgroundMark'
import Menu, { type MenuItem, type Point } from './Menu'
import UsageFoot from './UsageFoot'
import WorkingMark from './WorkingMark'
import WorkspacePopout, { usePopout } from './WorkspacePopout'

/** Which row's menu is open, and where: under its ⋯ button, or at the pointer. */
type OpenMenu = { kind: 'project' | 'workspace'; id: string; at?: Point }

/**
 * A workspace's status at rest: a 5px dot in its tone, or, while it works, the working
 * mark (in the neutral tone while it is being removed). Its tooltip is the hover word, and why when the workspace is
 * stuck. It carries `data-status` and `data-unseen` for tests.
 */
function StatusMark({
  w,
  look,
  word
}: {
  w: Workspace
  look: RowTone
  word: string
}): React.JSX.Element {
  const common = {
    'data-testid': `sidebar-workspace-${w.id}-status`,
    'data-status': look.status,
    'data-unseen': look.unseen ? 'true' : 'false',
    title: w.statusReason && look.status === w.status ? `${word}: ${w.statusReason}` : word
  }

  if (look.working) {
    return <WorkingMark {...common} />
  }

  if (look.removing) {
    return <WorkingMark tone="neutral" {...common} />
  }

  return <span className={`status-dot tone-${look.tone}`} {...common} />
}

/** During an unlock: the countdown, and `lock now`, always shown. */
function UnlockRow(): React.JSX.Element | null {
  const store = useStore()
  const connected = useQueSelector((s) => s.connected)
  const until = useUnlockCountdown()

  if (until === null) return null

  return (
    <div className="unlock-row" role="status" data-testid="sidebar-unlock">
      <UnlockIcon />
      <span data-testid="sidebar-unlock-countdown">
        {formatCountdown(until - store.now())} left
      </span>
      <button
        type="button"
        className="lock-now"
        data-testid="sidebar-lock"
        disabled={!connected}
        onClick={() => void store.lock()}
      >
        lock now
      </button>
    </div>
  )
}

/** The manual quiet's lengths, right after the word; the word itself starts the hour. */
const QUIET_CHIPS = [
  { minutes: 30, text: '30m', label: 'Quiet for 30 minutes' },
  { minutes: 60, text: '1h', label: 'Quiet for 1 hour' },
  { minutes: 120, text: '2h', label: 'Quiet for 2 hours' }
] as const

/** Outside a quiet window: the word starts an hour of quiet; the lengths after it pick one. */
function QuietRow(): React.JSX.Element | null {
  const store = useStore()
  const connected = useQueSelector((s) => s.connected)
  const inQuiet = useQueSelector((s) => s.quiet?.inQuietHours ?? false)

  if (inQuiet) return null

  return (
    <div className="quiet-row" role="group" aria-label="Quiet">
      <button
        type="button"
        className="quiet-word"
        data-testid="sidebar-quiet"
        disabled={!connected}
        onClick={() => void store.startQuiet(60)}
      >
        Quiet
      </button>
      <span className="quiet-lengths">
        {QUIET_CHIPS.map((c) => (
          <button
            key={c.minutes}
            type="button"
            className={c.minutes === 60 ? 'quiet-chip default' : 'quiet-chip'}
            data-testid={`sidebar-quiet-${c.minutes}`}
            aria-label={c.label}
            disabled={!connected}
            onClick={() => void store.startQuiet(c.minutes)}
          >
            {c.text}
          </button>
        ))}
      </span>
    </div>
  )
}

/** The foot's icon strip: the views the main area shows besides terminals. */
const FOOT_VIEWS = [
  { kind: 'report', name: 'Report', Icon: ReportIcon, show: (s: QueStore) => s.showReport() },
  { kind: 'tickets', name: 'Tickets', Icon: TicketIcon, show: (s: QueStore) => s.showTickets() },
  { kind: 'settings', name: 'Settings', Icon: GearIcon, show: (s: QueStore) => s.showSettings() }
] as const

export default function Sidebar(): React.JSX.Element {
  const store = usePanes(SCRATCH)
  const projects = useQueSelector((s) => s.projects)
  const workspaces = useQueSelector((s) => s.workspaces)
  const view = useQueSelector((s) => s.view)
  const connected = useQueSelector((s) => s.connected)
  const loaded = useQueSelector((s) => s.loaded)
  const tickets = useQueSelector((s) => s.tickets)
  const ticketsSync = useQueSelector((s) => s.ticketsSync)
  const filter = useQueSelector((s) => s.filter)
  const searchOpen = useQueSelector((s) => s.searchOpen)
  const searchFocusNonce = useQueSelector((s) => s.searchFocusNonce)
  const sort = useQueSelector((s) => s.sort)
  const locked = useQueSelector((s) => s.quiet?.locked ?? false)
  const dialog = useQueSelector((s) => s.dialog)
  // A removal's step word counts seconds; everything else here reads in minutes.
  const removing = Object.values(workspaces).some((w) => w.status === 'removing')
  const now = useNow(removing ? NOW_SECONDS_INTERVAL_MS : undefined)
  // The workspace card: detail, so never while quiet hours lock the app.
  const popout = usePopout(!locked)
  const rows = useRef(new Map<string, HTMLLIElement>())
  const showPopout = popout.show

  const searchRef = useRef<HTMLInputElement>(null)
  // The usage card stands beside it.
  const asideRef = useRef<HTMLElement>(null)
  // the nonce re-runs the focus on every request
  useEffect(() => {
    if (!searchOpen) return
    searchRef.current?.focus()
    searchRef.current?.select()
  }, [searchOpen, searchFocusNonce])
  const filtering = filter.trim() !== ''
  const openTickets = countOpenTickets(tickets.filter((t) => matches(filter, t.key, t.summary)))
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [menu, setMenu] = useState<OpenMenu | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const selected = view.kind === 'terminals' ? view.key : null
  const allSessions = store.tabs(SCRATCH)
  const sessions = allSessions.filter((t) => matches(filter, tabLabel(t), t.name, t.cwd))
  const narrowed = filterSidebar(filter, projects, Object.values(workspaces))
  const shownProjects = sortProjects(narrowed.projects, Object.values(workspaces), sort)
  const activeSession = selected === SCRATCH ? store.activeTab(SCRATCH) : null

  // The selected workspace has been looked at: when it becomes the selected one in a
  // focused window, when it finishes while selected, when the window regains focus, and
  // when quiet hours unlock on it. Never while they lock it: nothing of it shows.
  const seenId = selected !== null && selected in workspaces ? selected : null
  const seenFinishedAt = seenId ? workspaces[seenId]?.finishedAt : null

  useEffect(() => {
    if (!seenId || locked) return

    if (document.hasFocus()) void store.markSeen(seenId)
    const onFocus = (): void => void store.markSeen(seenId)
    window.addEventListener('focus', onFocus)

    return () => window.removeEventListener('focus', onFocus)
  }, [store, seenId, seenFinishedAt, locked])

  const toggle = (id: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)

      if (next.has(id)) next.delete(id)
      else next.add(id)

      return next
    })

  // ⌘I opens the card for the selected workspace (not under a dialog).
  useEffect(() => {
    if (dialog) return

    const onKey = (e: KeyboardEvent): void => {
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'i') return
      const row = selected ? rows.current.get(selected) : undefined

      if (!selected || !row) return
      e.preventDefault()
      e.stopPropagation()
      showPopout(selected, row)
    }

    window.addEventListener('keydown', onKey, true)

    return () => window.removeEventListener('keydown', onKey, true)
  }, [dialog, selected, showPopout])

  const toggleMenu = (kind: OpenMenu['kind'], id: string): void => {
    popout.close()
    setMenu(menu?.kind === kind && menu.id === id && !menu.at ? null : { kind, id })
  }

  const menuAtPointer = (e: React.MouseEvent, kind: OpenMenu['kind'], id: string): void => {
    e.preventDefault()
    e.stopPropagation()
    popout.close()
    setMenu({ kind, id, at: { x: e.clientX, y: e.clientY } })
  }

  const projectItems = (p: Project): MenuItem[] => [
    {
      label: 'New workspace…',
      testId: 'new-workspace',
      action: () => store.openDialog({ kind: 'new-workspace', projectId: p.id })
    },
    {
      label: 'Open in editor',
      testId: 'open-editor',
      action: () => void store.openInEditor(p.path)
    },
    {
      label: 'Remove project…',
      testId: 'remove',
      action: () => store.openDialog({ kind: 'remove-project', projectId: p.id })
    }
  ]

  const workspaceItems = (w: Workspace): MenuItem[] => [
    {
      label: 'Rename…',
      testId: 'rename',
      action: () => store.openDialog({ kind: 'rename-workspace', workspaceId: w.id })
    },
    {
      label: 'Open in editor',
      testId: 'open-editor',
      action: () => void store.openInEditor(w.path)
    },
    {
      label: 'Remove…',
      testId: 'remove',
      action: () => store.openDialog({ kind: 'remove-workspace', workspaceId: w.id })
    }
  ]

  const menuFor = (kind: OpenMenu['kind'], id: string): OpenMenu | null =>
    menu?.kind === kind && menu.id === id ? menu : null

  return (
    <aside ref={asideRef} className="sidebar" data-testid="sidebar" aria-label="Sidebar">
      <button
        type="button"
        className={`ghost icon sidebar-search-toggle${searchOpen ? ' active' : ''}`}
        data-testid="sidebar-search-toggle"
        aria-label="Search"
        title="Search (⌘K)"
        aria-expanded={searchOpen}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => (searchOpen ? store.closeSearch() : store.openSearch())}
      >
        <SearchIcon />
      </button>
      {searchOpen && (
        <div className="sidebar-search">
          <input
            ref={searchRef}
            type="search"
            data-testid="sidebar-search"
            aria-label="Search"
            placeholder="Search"
            value={filter}
            onChange={(e) => store.setFilter(e.target.value)}
            onBlur={(e) => {
              if (e.currentTarget.value === '') store.closeSearch()
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return
              e.preventDefault()
              store.closeSearch()
            }}
          />
        </div>
      )}
      <nav aria-label="Sessions" data-testid="sidebar-sessions">
        <div className="section-head">
          <h2>Sessions</h2>
          <div className="head-actions">
            <button
              type="button"
              className="ghost icon"
              data-testid="sidebar-sessions-add"
              aria-label="New session"
              title="New session: a terminal outside any workspace"
              disabled={!connected}
              onClick={() => {
                store.showTerminals(SCRATCH)
                void store.newTerminal(SCRATCH)
              }}
            >
              <PlusIcon />
            </button>
          </div>
        </div>
        {allSessions.length > 0 && sessions.length === 0 ? (
          <p className="empty-note" data-testid="sidebar-sessions-nomatch">
            Nothing matches
          </p>
        ) : sessions.length === 0 ? (
          <p className="empty-note" data-testid="sidebar-sessions-empty">
            No sessions. Press + to open a terminal.
          </p>
        ) : (
          <ul>
            {sessions.map((t) => (
              <li
                key={t.id}
                className={`session row${t.alive ? '' : ' exited weight-faint'}`}
                data-testid={`sidebar-session-${t.id}`}
              >
                <button
                  type="button"
                  className="row-button"
                  data-testid={`sidebar-session-${t.id}-open`}
                  aria-current={activeSession?.id === t.id ? 'page' : undefined}
                  title={t.cwd}
                  onClick={() => {
                    store.showTerminals(SCRATCH)
                    store.selectTerminal(SCRATCH, t.id)
                  }}
                >
                  <span className="ico glyph" aria-hidden="true">
                    ›_
                  </span>
                  <span className="name">{tabLabel(t)}</span>
                </button>
                {!t.alive && (
                  <span className="reveal">
                    <span className="word" data-testid={`sidebar-session-${t.id}-exited`}>
                      exited
                    </span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </nav>
      <nav aria-label="Projects">
        <div className="section-head">
          <h2>Projects</h2>
          <div className="head-actions">
            <button
              type="button"
              className="ghost icon"
              data-testid="sidebar-add-project"
              aria-label="Add project"
              title="Add project: a git repository"
              disabled={!connected}
              onClick={() => void store.addProject()}
            >
              <FolderPlusIcon />
            </button>
            <button
              type="button"
              className="ghost icon"
              data-testid="sidebar-sort"
              data-sort={sort}
              aria-label={sort === 'name' ? 'Sorted by name' : 'Sorted by last activity'}
              title={sort === 'name' ? 'Sort by last activity' : 'Sort by name'}
              onClick={() => store.setSort(sort === 'name' ? 'activity' : 'name')}
            >
              <SortIcon />
            </button>
          </div>
        </div>
        {loaded && projects.length === 0 && (
          <p className="empty-note" data-testid="sidebar-empty">
            Add a git repository to start a workspace.
          </p>
        )}
        {loaded && filtering && projects.length > 0 && shownProjects.length === 0 && (
          <p className="empty-note" data-testid="sidebar-projects-nomatch">
            Nothing matches
          </p>
        )}
        {shownProjects.map((p) => {
          const open = filtering || !collapsed.has(p.id)
          const list = sortWorkspaces(narrowed.workspacesOf(p.id), sort)
          const looks = list.map((w) => rowTone(w, selected === w.id))
          const unseenCount = looks.filter((l) => l.unseen).length
          const projectMenu = menuFor('project', p.id)

          return (
            <div key={p.id} className="project" data-testid={`sidebar-project-${p.id}`}>
              <div className={`project-head${open ? '' : ' collapsed'}`}>
                <button
                  type="button"
                  className="row-button disclosure"
                  data-testid={`sidebar-project-${p.id}-toggle`}
                  aria-expanded={open}
                  title={p.path}
                  onClick={() => toggle(p.id)}
                  onContextMenu={(e) => menuAtPointer(e, 'project', p.id)}
                >
                  <span className="ico" aria-hidden="true">
                    <FolderIcon />
                    <ChevronIcon open={open} />
                  </span>
                  <span className="name">{p.name}</span>
                </button>
                {!open && (
                  <span className="count" data-testid={`sidebar-project-${p.id}-count`}>
                    {unseenCount > 0 && (
                      <>
                        <span className="done">{unseenCount} done</span> ·{' '}
                      </>
                    )}
                    {looks.length}
                  </span>
                )}
                <div className="head-actions">
                  <button
                    type="button"
                    className="ghost icon"
                    data-testid={`sidebar-project-${p.id}-add-workspace`}
                    aria-label={`New workspace in ${p.name}`}
                    title={`New workspace in ${p.name}`}
                    disabled={!connected}
                    onClick={() => store.openDialog({ kind: 'new-workspace', projectId: p.id })}
                  >
                    <PlusIcon />
                  </button>
                  <button
                    type="button"
                    className="ghost icon sm more"
                    data-testid={`sidebar-project-${p.id}-menu`}
                    aria-label={`More actions for ${p.name}`}
                    aria-haspopup="menu"
                    aria-expanded={projectMenu !== null}
                    onClick={() => toggleMenu('project', p.id)}
                  >
                    ⋯
                  </button>
                </div>
                {projectMenu && (
                  <Menu
                    label={`Actions for ${p.name}`}
                    testId={`sidebar-project-${p.id}-menu`}
                    items={projectItems(p)}
                    at={projectMenu.at}
                    onClose={closeMenu}
                  />
                )}
              </div>
              {open && (
                <ul>
                  {list.map((w, i) => {
                    const look = looks[i]
                    const workspaceMenu = look.removing ? null : menuFor('workspace', w.id)
                    const word = hoverWord(w, look, now)

                    return (
                      <li
                        key={w.id}
                        className={`workspace row weight-${look.weight}`}
                        data-testid={`sidebar-workspace-${w.id}`}
                        ref={(el) => {
                          if (el) rows.current.set(w.id, el)
                          else rows.current.delete(w.id)
                        }}
                        onContextMenu={
                          look.removing
                            ? (e) => e.preventDefault()
                            : (e) => menuAtPointer(e, 'workspace', w.id)
                        }
                        onMouseEnter={(e) => popout.enter(w.id, e.currentTarget)}
                        onMouseLeave={popout.leave}
                        onMouseDown={popout.press}
                      >
                        <button
                          type="button"
                          className="row-button"
                          data-testid={`sidebar-workspace-${w.id}-open`}
                          aria-current={selected === w.id ? 'page' : undefined}
                          disabled={look.removing}
                          onClick={() => store.showTerminals(w.id)}
                        >
                          <span className="ico" aria-hidden="true">
                            <StatusMark w={w} look={look} word={word.word} />
                          </span>
                          <span className="name" data-testid={`sidebar-workspace-${w.id}-name`}>
                            {w.title ?? w.name}
                          </span>
                          {look.background.length > 0 && (
                            <BackgroundMark data-testid={`sidebar-workspace-${w.id}-background`} />
                          )}
                          {look.removing && (
                            <span
                              className="step-word"
                              data-testid={`sidebar-workspace-${w.id}-step`}
                            >
                              {word.word}
                            </span>
                          )}
                        </button>
                        <span className="reveal" data-testid={`sidebar-workspace-${w.id}-reveal`}>
                          <span
                            className={word.tone ? `word toned tone-${word.tone}` : 'word'}
                            data-testid={`sidebar-workspace-${w.id}-word`}
                          >
                            {word.word}
                          </span>
                          {!look.removing && (
                            <button
                              type="button"
                              className="ghost icon sm more"
                              data-testid={`sidebar-workspace-${w.id}-menu`}
                              aria-label={`More actions for ${w.title ?? w.name}`}
                              aria-haspopup="menu"
                              aria-expanded={workspaceMenu !== null}
                              onClick={() => toggleMenu('workspace', w.id)}
                            >
                              ⋯
                            </button>
                          )}
                        </span>
                        {popout.open?.id === w.id && (
                          <WorkspacePopout ws={w} row={popout.open.row} onClose={popout.close} />
                        )}
                        {workspaceMenu && (
                          <Menu
                            label={`Actions for ${w.title ?? w.name}`}
                            testId={`sidebar-workspace-${w.id}-menu`}
                            items={workspaceItems(w)}
                            at={workspaceMenu.at}
                            onClose={closeMenu}
                          />
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )
        })}
      </nav>
      <div className="sidebar-bottom" data-testid="sidebar-bottom">
        {/* The Quiet row (or, while one runs, the unlock row), with Restart or Update at its
            right end. Empty during a quiet window with neither, and then not drawn. */}
        <div className="foot-row" data-testid="sidebar-foot-row">
          <UnlockRow />
          <QuietRow />
          <UpdateChip />
        </div>
        <div className="foot-strip" data-testid="sidebar-strip">
          {FOOT_VIEWS.map(({ kind, name, Icon, show }) => (
            <button
              key={kind}
              type="button"
              className="ghost icon strip-view foot-view"
              data-testid={`sidebar-${kind}`}
              aria-label={name}
              title={name}
              aria-current={view.kind === kind ? 'page' : undefined}
              onClick={() => show(store)}
            >
              <Icon />
              {kind === 'tickets' && ticketsSync.error && (
                <span
                  className="foot-view-mark"
                  data-testid="sidebar-tickets-error"
                  title={ticketsSync.error}
                >
                  ✕
                </span>
              )}
              {kind === 'tickets' && (
                <span className="foot-view-count" data-testid="sidebar-tickets-count">
                  {openTickets}
                </span>
              )}
            </button>
          ))}
          {/* The right end: Claude plan usage. */}
          <UsageFoot sidebar={asideRef} />
        </div>
      </div>
    </aside>
  )
}
