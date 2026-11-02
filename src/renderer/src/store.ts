// The renderer's single store: loads projects, workspaces, terminals, quiet
// state, config and tickets at boot, applies every daemon event, and holds the UI's selection. Components read it with useQue() and call its actions; nothing
// else talks to window.que except Terminal.tsx's attach/detach.
import { createContext, useContext, useSyncExternalStore } from 'react'
import type {
  ConfigGetResult,
  ConfigSetParams,
  DaemonState,
  InstructionsGetResult,
  PrThread,
  Project,
  PullRequest,
  QueApi,
  QuietState,
  QuietUnlock,
  Report,
  TermInfo,
  Ticket,
  TicketsSyncState,
  UpdateInfo,
  Usage,
  Workspace,
  WorkspaceDiff,
  WorkspaceDiffFile,
  WorkspaceFile,
  WorkspaceFiles
} from '../../preload/index.d'
import type { SidebarSort } from './sidebar-order'
import {
  clampRatio,
  isRemembered,
  NO_SPLIT,
  type PaneLayout,
  parseLayout,
  placeIn,
  RATIO_DEFAULT,
  reconcileLayout,
  type DiffAgainst,
  type DiffTab,
  diffId,
  diffOf,
  fileId,
  filePathOf,
  isViewId
} from './layout'
import { keyOf } from './keys'
import { buildTree, newlyChanged } from './files'
import { chime, shouldChime } from './sound'
import { errorCode, errorMessage } from '../../shared/errors.decode'
import { removalStepLabel } from '../../shared/format'
import type { RemovalFailure } from '../../shared/types'
import {
  decodeDiffBases,
  decodeDiffComments,
  type DiffMode,
  type DiffWhitespace,
  decodeDiffMode,
  decodeDiffWhitespace,
  decodeDiffWrap,
  decodeReview,
  readStored,
  writeStored
} from './persisted.decode'
import { newestAt } from './pr-list'
import type { DiffComments, Reveals } from './diff-rows'

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

/** The loose terminals (not in any workspace) share this key. */
export const SCRATCH = ''

/** The key is a workspace's (not the loose sessions', nor one gone from the list). */
export function isWorkspace(s: QueState, key: string | null): boolean {
  return key !== null && key !== SCRATCH && key in s.workspaces
}

export interface TermTab {
  id: string
  name: string
  cwd: string
  alive: boolean
  /** Was already running in the daemon when this app instance launched. */
  reattached: boolean
  /** Workspace id, or SCRATCH. */
  key: string
  createdAt: string
  /** The last title the program set, raw; absent when none. */
  title?: string
  /** The foreground program's name (`zsh`, `claude`); absent until the daemon knows it. */
  process?: string
}

export {
  diffId,
  diffOf,
  fileId,
  filePathOf,
  isViewId,
  RATIO_DEFAULT,
  RATIO_MAX,
  RATIO_MIN
} from './layout'

export type { DiffAgainst, PaneLayout } from './layout'

export type { DiffMode, DiffWhitespace } from './persisted.decode'

export { keyOf } from './keys'

const LAYOUT_PREFIX = 'que.layout.'

/** The review pane's views, picked by the icons in its strip. */
export type ReviewView = 'prs' | 'changes' | 'files'

const REVIEW_VIEWS: readonly ReviewView[] = ['prs', 'changes', 'files']

/** Where the review pane stands for one workspace: its view, and the pull request open in it (null: the list). */
export interface ReviewPlace {
  view: ReviewView
  pr: number | null
}

/** Where a workspace the pane has not been used for stands. */
export const DEFAULT_PLACE: ReviewPlace = { view: 'changes', pr: null }

/** The review pane at the right of the main area: one for the app, its view per workspace. Remembered. */
export interface ReviewState {
  open: boolean
  width: number
  /** Per workspace id; a workspace without one stands at DEFAULT_PLACE. */
  places: Record<string, ReviewPlace>
  /**
   * Per workspace id, then pull request number: the newest entry of its conversation when it was
   * last opened, so the list can tell new comments.
   */
  seen: Record<string, Record<number, string>>
}

/** The folding sections inside a pull request. */
export type PrSection = 'files' | 'checks' | 'comments'

export const REVIEW_MIN = 240
export const REVIEW_MAX = 520
export const REVIEW_DEFAULT = 320
const REVIEW_KEY = 'que.review'

export function clampReviewWidth(w: number): number {
  const n = Number.isFinite(w) ? w : REVIEW_DEFAULT

  return Math.min(REVIEW_MAX, Math.max(REVIEW_MIN, Math.round(n)))
}

const asView = (v: string | null): ReviewView | undefined => REVIEW_VIEWS.find((t) => t === v)

/** The remembered review pane, or the defaults (closed, 320px) for anything unreadable. */
function loadReview(): ReviewState {
  const fallback: ReviewState = { open: false, width: REVIEW_DEFAULT, places: {}, seen: {} }

  return readStored(
    REVIEW_KEY,
    (raw) => {
      const v = decodeReview(JSON.parse(raw))

      if (!v) return fallback

      const places = Object.entries(v.places).flatMap(([id, p]): Array<[string, ReviewPlace]> => {
        const view = asView(p.view)

        return view ? [[id, { view, pr: view === 'prs' ? p.pr : null }]] : []
      })

      return {
        open: v.open,
        width: v.width === null ? REVIEW_DEFAULT : clampReviewWidth(v.width),
        places: Object.fromEntries(places),
        seen: v.seen
      }
    },
    fallback
  )
}

/** The diffs key of a workspace's diff: its worktree's, or against a branch keyed by both refs too. */
export function diffKey(key: string, against?: DiffAgainst): string {
  return against ? keyOf(key, against.head, against.base) : key
}

/** What a pull request's own files compare: its branch against its base. */
export function prAgainst(pr: PullRequest): DiffAgainst {
  return { head: pr.head, base: pr.base }
}

/** The pull request among `prs` whose files a diff against a branch shows; undefined for none. */
export function prOfDiff(
  prs: readonly PullRequest[],
  against: DiffAgainst | undefined
): PullRequest | undefined {
  return against && prs.find((p) => p.head === against.head && p.base === against.base)
}

/** What a workspace's diff is narrowed to: the ref it compares against, and one commit. Null: the daemon's choice, every commit. */
export interface DiffScope {
  base: string | null
  commit: string | null
}

const NO_SCOPE: DiffScope = { base: null, commit: null }
const DIFF_BASES_KEY = 'que.diffBases'

/** The remembered base per workspace id; anything unreadable is dropped. */
function loadDiffBases(): Record<string, string> {
  return readStored(DIFF_BASES_KEY, (raw) => decodeDiffBases(JSON.parse(raw)), {})
}

/** Remembers (or, for null, forgets) a workspace's base across launches. */
function rememberDiffBase(id: string, base: string | null): void {
  const bases = loadDiffBases()

  if (base === null) delete bases[id]
  else bases[id] = base

  writeStored(DIFF_BASES_KEY, Object.keys(bases).length > 0 ? JSON.stringify(bases) : null)
}

const DIFF_MODE_KEY = 'que.diffMode'
const DIFF_WHITESPACE_KEY = 'que.diffWhitespace'
const DIFF_WRAP_KEY = 'que.diffWrap'

function loadDiffMode(): DiffMode {
  return readStored(DIFF_MODE_KEY, decodeDiffMode, 'unified')
}

function loadDiffWhitespace(): DiffWhitespace {
  return readStored(DIFF_WHITESPACE_KEY, decodeDiffWhitespace, 'show')
}

function loadDiffWrap(): boolean {
  return readStored(DIFF_WRAP_KEY, decodeDiffWrap, true)
}

export const DEFAULT_DIFF_COMMENTS: DiffComments = { mode: 'dim', keepRemoved: true }

const DIFF_COMMENTS_KEY = 'que.diffComments'

function loadDiffComments(): Record<string, DiffComments> {
  return readStored(DIFF_COMMENTS_KEY, (raw) => decodeDiffComments(JSON.parse(raw)), {})
}

/** The diffFiles key of a diff tab's file: the workspace, the tab, and the whitespace option. */
export function diffFileKey(
  key: string,
  path: string,
  against: DiffAgainst | undefined,
  whitespace: DiffWhitespace
): string {
  return keyOf(key, diffId(path, against), whitespace)
}

function initialDiffScopes(): Record<string, DiffScope> {
  return Object.fromEntries(
    Object.entries(loadDiffBases()).map(([id, base]) => [id, { base, commit: null }])
  )
}

export type View =
  | { kind: 'terminals'; key: string }
  | { kind: 'report' }
  | { kind: 'tickets' }
  | { kind: 'settings' }

export type DialogState =
  | { kind: 'new-workspace'; projectId: string }
  | { kind: 'remove-project'; projectId: string }
  | { kind: 'remove-workspace'; workspaceId: string }
  | { kind: 'rename-workspace'; workspaceId: string }
  | { kind: 'start-ticket'; key: string; projects: Project[] }

/** A fetched value as it last landed, and why the last fetch failed (null: it did not). */
export interface Resource<T> {
  /** Absent until a fetch lands (and again after a failure drops it). */
  data?: T
  error: string | null
}

/** What the store fetches per key and keeps as a Resource. */
interface Resources {
  /** Per keyOf(workspace, number): a pull request's conversation (null: no such pull request). A failure keeps the last one. */
  prThreads: PrThread | null
  /**
   * Per diffKey: a workspace's diff against its base, in its scope; or a branch's own files
   * against a base (a pull request's).
   */
  diffs: WorkspaceDiff
  /** Per diffFileKey: one diff tab's file as lines of tokens, in its tab's scope. */
  diffFiles: WorkspaceDiffFile
  /** Per workspace: its worktree's files as listed. */
  fileLists: WorkspaceFiles
  /** Per fileKey(workspace, path): a file as read for its file tab; null when the path is gone. */
  fileContents: WorkspaceFile | null
}

type ResourceName = keyof Resources

type ResourceTables = { [K in ResourceName]: Record<string, Resource<Resources[K]>> }

/** The fileContents key of one file of a workspace. */
export function fileKey(key: string, path: string): string {
  return keyOf(key, path)
}

export interface QueState extends ResourceTables {
  loaded: boolean
  connected: boolean
  /** Disconnected and asking the main process to reconnect (see the reconnect contract). */
  reconnecting: boolean
  /** Bumped on every reconnect, so the panes attach their terminals again. */
  connection: number
  /** The daemon's build as the main process last saw it; null until asked. */
  daemon: DaemonState | null
  error: string | null
  projects: Project[]
  /** Unarchived workspaces by id. */
  workspaces: Record<string, Workspace>
  terminals: TermTab[]
  /** The tickets assigned to the user, as last synced, in the daemon's order. */
  tickets: Ticket[]
  ticketsSync: TicketsSyncState
  view: View
  /** The pane layout per terminal key; a key without one has a single pane. */
  layouts: Record<string, PaneLayout>
  /** Per workspace: the base and commit its diff is narrowed to (none: the daemon's base, every commit). The base is remembered. */
  diffScopes: Record<string, DiffScope>
  /** Per workspace: the Files tree's open directories, for the session; none until its files first load. */
  filesExpanded: Record<string, ReadonlySet<string>>
  /** Per workspace: why the last check of its pull requests with GitHub failed; dropped when the next one starts. */
  prCheckErrors: Record<string, string>
  /** The review pane: open or not, how wide, its view per workspace, and the conversations seen. Remembered. */
  review: ReviewState
  /** Which sections inside a pull request are open, for the session. */
  prFolds: Record<PrSection, boolean>
  /** Per keyOf(workspace, diff tab id): the line the tab was last asked to show. */
  diffTargets: Record<string, { line: number; nonce: number }>
  /** Per keyOf(workspace, diff tab id): the folds opened in it, while the tab is open. */
  diffReveals: Record<string, Reveals>
  /** How diff tabs lay out their lines; remembered. */
  diffMode: DiffMode
  /** Whether diff tabs ignore whitespace; remembered. */
  diffWhitespace: DiffWhitespace
  /** Whether diff tabs wrap long lines in their column; remembered, on by default. */
  diffWrap: boolean
  /** Per project id: how its diff tabs treat changed comment lines (none: the default); remembered. */
  diffComments: Record<string, DiffComments>
  dialog: DialogState | null
  /** The daemon's quiet-hours state; null until loaded. */
  quiet: QuietState | null
  /** The newest Claude plan usage reading (usage.get, usage.changed); null before one or once its windows reset. */
  usage: Usage | null
  /** The user config (config.get); null until loaded. */
  config: ConfigGetResult | null
  /** The sidebar filter text; empty shows everything. Not remembered. */
  filter: string
  /** Whether the sidebar search field is shown. */
  searchOpen: boolean
  /** Bumped each time the search is asked for, so the field focuses and selects again. */
  searchFocusNonce: number
  /** How projects and workspaces are ordered; remembered. */
  sort: SidebarSort
}

export interface StoreOptions {
  /** The quiet board window: never opens terminals, never chimes. */
  board?: boolean
  /** The clock for ages, countdowns and windows. Default Date.now. */
  now?: () => number
  /**
   * The workspace popout's delays in ms: how long the pointer rests on a row before it opens,
   * and how long after the pointer leaves the row and the card it closes. Default 500 and 150.
   */
  popoutDelays?: PopoutDelays
}

export interface PopoutDelays {
  open: number
  close: number
}

const POPOUT_DELAYS: PopoutDelays = { open: 500, close: 150 }

const SORT_KEY = 'que.sidebarSort'

function loadSort(): SidebarSort {
  return readStored(SORT_KEY, (raw) => (raw === 'activity' ? 'activity' : 'name'), 'name')
}

function toTab(t: TermInfo, reattached: boolean): TermTab {
  return {
    id: t.id,
    name: t.name,
    cwd: t.cwd,
    alive: t.alive,
    reattached,
    key: t.workspaceId ?? SCRATCH,
    createdAt: t.createdAt,
    title: t.title,
    process: t.process
  }
}

/** The tabs with one terminal's title and process replaced; the same array when neither changed. */
function withFacts(tabs: TermTab[], info: TermInfo): TermTab[] {
  const tab = tabs.find((t) => t.id === info.id)

  if (!tab || (tab.title === info.title && tab.process === info.process)) return tabs

  return tabs.map((t) => (t === tab ? { ...t, title: info.title, process: info.process } : t))
}

/** A load the board can do without: its fallback when the daemon cannot answer. */
function optional<T>(call: Promise<T>, fallback: T): Promise<T> {
  return call.catch(() => fallback)
}

function byId<T extends { id: string }>(items: readonly T[]): Record<string, T> {
  return Object.fromEntries(items.map((i) => [i.id, i]))
}

function without<T>(rec: Record<string, T>, id: string): Record<string, T> {
  const { [id]: _gone, ...rest } = rec

  return rest
}

export class QueStore {
  private state: QueState = {
    loaded: false,
    connected: true,
    reconnecting: false,
    connection: 0,
    daemon: null,
    error: null,
    projects: [],
    workspaces: {},
    terminals: [],
    tickets: [],
    ticketsSync: { lastSyncAt: null, error: null, count: 0 },
    view: { kind: 'terminals', key: SCRATCH },
    layouts: {},
    prThreads: {},
    diffs: {},
    diffScopes: initialDiffScopes(),
    fileLists: {},
    fileContents: {},
    filesExpanded: {},
    prCheckErrors: {},
    review: loadReview(),
    prFolds: { files: true, checks: true, comments: true },
    diffTargets: {},
    diffReveals: {},
    diffMode: loadDiffMode(),
    diffWhitespace: loadDiffWhitespace(),
    diffWrap: loadDiffWrap(),
    diffComments: loadDiffComments(),
    diffFiles: {},
    dialog: null,
    quiet: null,
    usage: null,
    config: null,
    filter: '',
    searchOpen: false,
    searchFocusNonce: 0,
    sort: loadSort()
  }
  private listeners = new Set<() => void>()
  private offs: Array<() => void> = []
  private boot: Promise<void> | null = null
  /** Terminal keys that already had their first-visit terminal opened. */
  private autoOpened = new Set<string>()
  /**
   * Terminals this store is creating. The daemon announces them to this window too, and that event can beat the
   * creator's reply; a tab added before the creator has placed the terminal in a pane would mount in the wrong one.
   */
  private creating = 0
  /** Announcements that arrived while `creating` was above zero, added once it drops back. */
  private createdMeanwhile: TermInfo[] = []
  /** Fetches in flight per resource and key, so a pane and a list asking at once share one request. */
  private loads = new Map<string, Promise<void>>()
  /** The latest fetch per resource and key, for those where an older answer is dropped. */
  private loadSeq = new Map<string, number>()
  /** Per diffKey of a branch's diff: the updatedAt of the pull request it was fetched for. */
  private diffFor = new Map<string, string | null>()
  /** Workspaces whose worktree change is being followed, and those with another change waiting. */
  private following = new Set<string>()
  /** The workspace this store asked the daemon to watch, if any. */
  private watchedKey: string | null = null
  private followAgain = new Set<string>()

  constructor(
    private api: QueApi,
    private options: StoreOptions = {}
  ) {}

  // ---- external store plumbing ----------------------------------------------

  getState = (): QueState => this.state

  /** The current time, from the injected clock. */
  now = (): number => (this.options.now ?? Date.now)()

  /** The workspace popout's open and close delays, injectable like the clock. */
  popoutDelays = (): PopoutDelays => this.options.popoutDelays ?? POPOUT_DELAYS

  private home: Promise<string> | null = null

  /** The user's home directory (asked once), so paths can read `~/…`. */
  homedir = (): Promise<string> => (this.home ??= this.api.app.homedir())

  // ---- app update ----------------------------------------------------------

  /** A newer release, if the main process's daily check found one. */
  fetchUpdate = (): Promise<UpdateInfo | null> => this.api.app.update()

  onUpdate = (cb: (info: UpdateInfo) => void): (() => void) => this.api.app.onUpdate(cb)

  /** Opens the newer release's page in the browser. */
  openUpdate = (): void => {
    void this.api.app.openUpdate().catch(() => {})
  }

  // ---- the daemon's build and the connection --------------------------------
  //
  // The reconnect contract (session resume and the upgrade handoff build on it):
  // - The connection drops (term.onDisconnect): `connected` goes false, the window
  //   says it is reconnecting, and the store asks the main process for the daemon's
  //   state, which reconnects or starts a daemon. A failure goes to the error line
  //   and the next try is the user's (Reconnect), never a loop.
  // - The connection is back (daemon.onReconnected, or that state call answering):
  //   everything is loaded again, the terminals that still exist attach again (the
  //   `connection` count remounts the panes), the rest are marked exited, the shown
  //   workspace is watched again (watches are per connection), a visited workspace
  //   opens a fresh shell again (autoOpened is cleared), and `daemon` is refreshed
  //   so the Restart control clears.

  /** Asks the main process which build the daemon runs; failures leave it unknown. */
  private refreshDaemon(): void {
    void this.api.daemon.state().then(
      (daemon) => this.set({ daemon }),
      () => {}
    )
  }

  /** Asks the main process to reconnect; once it answers, the store recovers. */
  reconnect = (): void => {
    if (this.state.connected || this.state.reconnecting) return
    this.set({ reconnecting: true })
    this.api.daemon.state().then(
      (daemon) => void this.recover(daemon),
      (err) => this.set({ reconnecting: false, error: errorMessage(err) })
    )
  }

  /** The connection is back: reload and re-attach as the contract above says. */
  private async recover(daemon: DaemonState): Promise<void> {
    this.set({ daemon })

    if (this.state.connected) return
    this.autoOpened.clear()
    // The daemon forgot this window's watch with the old connection.
    this.watchedKey = null
    this.setWith((s) => ({
      connected: true,
      reconnecting: false,
      error: null,
      connection: s.connection + 1
    }))
    this.watchShown()
    await this.load(true)
  }

  /**
   * Updates the daemon in place to this app's build; every terminal keeps running
   * with its id, so the reconnect re-attaches them all. A failed hand-off goes to
   * the error line, and the Restart control stays for another try.
   */
  upgradeDaemon(): Promise<void> {
    return this.guard(async () => this.recover(await this.api.daemon.upgrade()))
  }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)

    return () => this.listeners.delete(cb)
  }

  /** Applies a patch computed from the current state. */
  /** Quiet hours are on and no unlock is running; false until the state has loaded. */
  private locked(): boolean {
    return this.state.quiet?.locked ?? false
  }

  private setWith(update: (s: QueState) => Partial<QueState>): void {
    this.set(update(this.state))
  }

  private set(patch: Partial<QueState>): void {
    const keys = Object.keys(patch) as Array<keyof QueState>

    // Nothing changed (an empty patch, or every value the same): nothing to tell.
    if (keys.every((k) => Object.is(patch[k], this.state[k]))) return
    this.state = { ...this.state, ...patch }

    if (patch.view) this.watchShown()

    for (const cb of this.listeners) cb()
  }

  /**
   * Asks the daemon to watch the worktree of the workspace this window shows, and no other, so
   * `workspace.changed` names it whatever the pane shows (a terminal, a diff, a file). Failures
   * are dropped: the Refresh button still works without the watch.
   */
  private watchShown(): void {
    const key = this.currentKey()
    const want = key !== null && key !== SCRATCH && !this.options.board ? key : null

    if (want === this.watchedKey) return
    const was = this.watchedKey
    this.watchedKey = want

    if (was !== null) void this.api.workspace.unwatch({ id: was }).catch(() => {})

    if (want !== null) void this.api.workspace.watch({ id: want }).catch(() => {})
  }

  // ---- lifecycle ------------------------------------------------------------

  /** Subscribes to daemon events and loads everything once. Safe to call again after stop(). */
  start(): void {
    this.subscribeEvents()

    if (!this.boot) {
      this.boot = this.load()

      if (!this.options.board) this.refreshDaemon()
    }
  }

  stop(): void {
    for (const off of this.offs) off()
    this.offs = []
  }

  /**
   * Loads everything. On a reconnect (`again`) the daemon's answer wins over what the
   * store holds, and a tab whose terminal the daemon no longer has is marked exited.
   * Usage and tickets are optional: the previous build may not know their methods
   * (the app is updated before the daemon), and the board must still list every
   * workspace so the update can be offered.
   */
  private async load(again = false): Promise<void> {
    const { tickets: held, ticketsSync } = this.state

    try {
      const [projects, workspaces, terms, quiet, usage, config, tickets] = await Promise.all([
        this.api.project.list(),
        this.api.workspace.list(),
        this.api.term.list(),
        this.api.quiet.state(),
        optional(this.api.usage.get(), null),
        this.api.config.get(),
        optional(this.api.tickets.list(), { tickets: held, sync: ticketsSync })
      ])

      const live = terms.filter((t) => t.alive)
      const liveTabs = live.map((t) => toTab(t, true))

      if (again) {
        const alive = new Set(live.map((t) => t.id))
        this.setWith((s) => ({
          loaded: true,
          quiet,
          usage,
          config,
          tickets: tickets.tickets,
          ticketsSync: tickets.sync,
          projects,
          workspaces: byId(workspaces),
          terminals: mergeById(
            liveTabs,
            s.terminals.map((t) => (alive.has(t.id) ? t : { ...t, alive: false }))
          )
        }))
      } else {
        this.setWith((s) => ({
          loaded: true,
          quiet: s.quiet ?? quiet,
          usage: s.usage ?? usage,
          config: s.config ?? config,
          tickets: tickets.tickets,
          ticketsSync: tickets.sync,
          projects: mergeById(projects, s.projects),
          workspaces: { ...byId(workspaces), ...s.workspaces },
          terminals: mergeById(liveTabs, s.terminals)
        }))
        this.hydrateLayouts()
      }

      await this.visit(this.currentKey())
    } catch (err) {
      this.set({ error: errorMessage(err) })
    }
  }

  private subscribeEvents(): void {
    if (this.offs.length > 0) return
    const { term, workspace, project, quiet, usage, config, tickets } = this.api
    this.offs.push(
      quiet.on('quiet.changed', (q) => {
        const was = this.locked()
        this.set({ quiet: q })

        // Unlocked (or morning): open the current view's first terminal if it has none.
        if (was && !q.locked) void this.visit(this.currentKey())
      }),
      usage.on('usage.changed', (u) => this.set({ usage: u })),
      config.on('config.changed', (c) => this.set({ config: c })),
      tickets.on('tickets.synced', (r) => this.set({ tickets: r.tickets, ticketsSync: r.sync })),
      project.on('project.added', (p) =>
        this.setWith((s) => ({ projects: mergeById(s.projects, [p]) }))
      ),
      project.on('project.removed', ({ id }) => this.setWith((s) => dropProject(s, id))),
      term.on('term.created', (info) => {
        if (this.creating > 0) this.createdMeanwhile.push(info)
        else this.addTab(info)
      }),
      term.on('term.killed', ({ id }) => this.removeTab(id)),
      term.on('term.updated', (info) =>
        this.setWith((s) => ({ terminals: withFacts(s.terminals, info) }))
      ),
      term.on('term.exit', ({ id }) =>
        this.setWith((s) => ({
          terminals: s.terminals.map((t) => (t.id === id ? { ...t, alive: false } : t))
        }))
      ),
      term.onDisconnect(() => {
        this.set({ connected: false })
        this.reconnect()
      }),
      this.api.daemon.onReconnected((daemon) => void this.recover(daemon)),
      workspace.on('workspace.created', (ws) => this.upsertWorkspace(ws)),
      workspace.on('workspace.updated', (ws) => {
        const prev = this.state.workspaces[ws.id]?.status
        this.upsertWorkspace(ws)

        if (prev !== ws.status) this.maybeChime({ state: ws.status, prev })
      }),
      workspace.on('workspace.changed', ({ id }) => this.followChange(id)),
      workspace.on('workspace.diffSettled', ({ id }) => this.followDiffSettled(id)),
      workspace.on('workspace.removed', ({ id, failed }) => {
        if (id in this.state.diffScopes) rememberDiffBase(id, null)

        const { places, seen } = this.state.review

        if (id in places || id in seen) {
          this.setReview({ places: without(places, id), seen: without(seen, id) })
        }

        // The name is read before the row goes.
        const gone = this.state.workspaces[id]

        if (failed && failed.length > 0) {
          this.set({ error: removalFailedMessage(gone ? (gone.title ?? gone.name) : id, failed) })
        }

        this.setWith((s) => ({
          workspaces: without(s.workspaces, id),
          diffScopes: without(s.diffScopes, id),
          prCheckErrors: without(s.prCheckErrors, id),
          view: viewWithout(s.view, [id])
        }))
      })
    )
  }

  /** A short chime for a finished turn (or one needing input), in work hours only. */
  private maybeChime(event: { state: string; prev?: string | null }): void {
    if (this.options.board) return
    const kind = shouldChime(event, this.state.quiet, this.state.config?.config.notifications)

    if (kind) chime(kind)
  }

  private upsertWorkspace(ws: Workspace): void {
    const before = this.state.workspaces[ws.id]?.prs ?? []
    this.setWith((s) => ({ workspaces: { ...s.workspaces, [ws.id]: ws } }))
    // A pull request that changed upstream: what is on screen of it (its conversation and
    // files) is fetched again, the rest forgotten so the next look fetches it.
    const shown = new Set(this.shownPrs(ws.id).map((p) => p.number))

    for (const old of before) {
      const pr = ws.prs.find((p) => p.number === old.number)

      if (pr?.updatedAt === old.updatedAt) continue
      const thread = keyOf(ws.id, old.number)

      if (pr && shown.has(pr.number)) {
        void this.fetchPrThread(ws.id, pr.number)
        void this.refreshDiff(ws.id, prAgainst(pr))
      } else {
        if (this.state.prThreads[thread]?.data !== undefined) this.forget('prThreads', thread)
        const files = diffKey(ws.id, prAgainst(old))

        if (this.state.diffs[files]?.data !== undefined) this.forget('diffs', files)
      }
    }

    if (!this.state.projects.some((p) => p.id === ws.projectId)) {
      // A project.added that raced the workspace event; fetch the list.
      void this.api.project.list().then(
        (projects) => this.set({ projects }),
        () => {}
      )
    }
  }

  /** Adds the tab for a terminal the daemon reported, unless it already has one (the reply and the event both bring it). */
  private addTab(info: TermInfo): void {
    if (this.state.terminals.some((t) => t.id === info.id)) return
    const tab = toTab(info, false)
    this.setWith((s) => ({ terminals: mergeById(s.terminals, [tab]) }))
  }

  private currentKey(): string | null {
    return this.state.view.kind === 'terminals' ? this.state.view.key : null
  }

  /** Opens the first terminal of a key that has none, once per key. */
  private async visit(key: string | null): Promise<void> {
    if (key === null || !this.state.loaded || this.autoOpened.has(key)) return

    // The board never opens terminals; during quiet hours nothing may.
    if (this.options.board || this.locked()) return
    this.autoOpened.add(key)

    if (this.state.terminals.some((t) => t.key === key && t.alive)) return
    await this.newTerminal(key)
  }

  /** Runs an action; a failure goes to the error banner. */
  private async guard(action: () => Promise<void>): Promise<void> {
    try {
      await action()
    } catch (err) {
      this.set({ error: errorMessage(err) })
    }
  }

  // ---- actions --------------------------------------------------------------

  dismissError(): void {
    this.set({ error: null })
  }

  setFilter(text: string): void {
    this.set({ filter: text })
  }

  openSearch(): void {
    this.set({ searchOpen: true, searchFocusNonce: this.state.searchFocusNonce + 1 })
  }

  closeSearch(): void {
    this.set({ searchOpen: false, filter: '' })
  }

  setSort(sort: SidebarSort): void {
    writeStored(SORT_KEY, sort)
    this.set({ sort })
  }

  openDialog(dialog: DialogState): void {
    this.set({ dialog })
  }

  closeDialog(): void {
    this.set({ dialog: null })
  }

  /**
   * Shows a workspace's terminals. The daemon only watches the shown workspace's worktree (the
   * view change asks it to, in watchShown), so what the pane and the view tabs show for the new
   * one is fetched again rather than served from the cache, in case it changed while another
   * was shown.
   */
  showTerminals(key: string): void {
    const was = this.currentKey()
    this.set({ view: { kind: 'terminals', key } })
    void this.visit(key)

    if (key !== was && key !== SCRATCH) void this.refetchShown(key)
  }

  // ---- the review pane ------------------------------------------------------

  private setReview(patch: Partial<ReviewState>): void {
    const review = { ...this.state.review, ...patch }
    this.set({ review })
    writeStored(REVIEW_KEY, JSON.stringify(review))
  }

  /** Drops a resource's value (keeping its error), so the next look fetches it. */
  private forget(name: 'prThreads' | 'diffs' | 'diffFiles', key: string): void {
    this.setWith((s) => withEntry(s, name, key, { error: s[name][key]?.error ?? null }))
  }

  /** Where the review pane stands for a workspace. */
  reviewPlace(key: string): ReviewPlace {
    return this.state.review.places[key] ?? DEFAULT_PLACE
  }

  private setPlace(key: string, place: ReviewPlace): void {
    this.setReview({ places: { ...this.state.review.places, [key]: place } })
  }

  /**
   * The pull requests of a workspace whose own conversation and files are on screen: the one
   * open in the review pane (`paneShown`: the pane shows that workspace, by default while it is
   * open on it), and each with a diff tab.
   */
  private shownPrs(
    key: string,
    paneShown = this.state.review.open && this.currentKey() === key
  ): PullRequest[] {
    const prs = this.state.workspaces[key]?.prs ?? []
    const place = this.reviewPlace(key)
    const inPane = paneShown && place.view === 'prs'
    const tabs = this.layout(key).views.map((v) => diffOf(v)?.against)

    return prs.filter(
      (p) => (inPane && p.number === place.pr) || tabs.some((a) => prOfDiff([p], a) === p)
    )
  }

  /** Opens the review pane where the current workspace left it and loads what it shows. */
  openReview(): void {
    this.setReview({ open: true })
    this.ensureReview(this.currentKey())
  }

  /** Closes the pane when it is open, else opens it. */
  toggleReview(): void {
    if (this.state.review.open) this.closeReview()
    else this.openReview()
  }

  closeReview(): void {
    this.setReview({ open: false })
  }

  /** Shows a view for a workspace (the pull requests as their list) and loads it; remembered per workspace. */
  setReviewView(key: string, view: ReviewView): void {
    this.setPlace(key, { view, pr: null })
    this.ensureReview(key)
  }

  /** Opens a pull request in place in the pane: its files, checks and conversation. */
  openPullRequest(key: string, number: number): void {
    this.setPlace(key, { view: 'prs', pr: number })
    this.ensureReview(key)
  }

  /**
   * Opens the pane on a view for a workspace; on the view it was last on, an open pull request
   * stays in place.
   */
  showReview(key: string, view: ReviewView): void {
    if (this.reviewPlace(key).view !== view) this.setReviewView(key, view)
    this.openReview()
  }

  /** Back from a pull request to the list. */
  closePullRequest(key: string): void {
    this.setReviewView(key, 'prs')
  }

  /**
   * Loads what the pane shows for a workspace: the worktree's diff always (the strip counts its
   * files; the workspace carries no count of its own), the listing on Files, and the pull
   * request open in it: its conversation and its files, kept until its updatedAt moves. The
   * list fetches nothing: each pull request carries its comment count.
   */
  ensureReview(key: string | null): void {
    if (key === null || key === SCRATCH) return
    const { view } = this.reviewPlace(key)
    void this.ensureDiff(key)

    if (view === 'files') void this.ensureFiles(key)

    for (const pr of this.shownPrs(key, true)) {
      void this.ensurePrThread(key, pr.number)
      void this.ensureDiff(key, prAgainst(pr))
      // A conversation already loaded is seen now; one being fetched, once it lands.
      this.markPrSeen(key, pr.number)
    }
  }

  /** Remembers a pull request's conversation as seen while it is open in the pane. */
  private markPrSeen(key: string, number: number): void {
    const { review } = this.state

    if (!review.open || this.currentKey() !== key || this.reviewPlace(key).pr !== number) return
    const at = newestAt(this.state.prThreads[keyOf(key, number)]?.data?.entries ?? [])

    if (at === undefined || review.seen[key]?.[number] === at) return
    this.setReview({ seen: { ...review.seen, [key]: { ...review.seen[key], [number]: at } } })
  }

  /** Opens or folds a section inside a pull request, for every pull request, this session. */
  togglePrFold(section: PrSection): void {
    this.setWith((s) => ({ prFolds: { ...s.prFolds, [section]: !s.prFolds[section] } }))
  }

  /**
   * The daemon saw the worktree change on disk. For the shown workspace, fetch again what is on
   * screen: the diff (in its scope) while the pane or a view tab is open, and the listing and the
   * open file tabs too while Files or a file tab is; nothing while quiet hours are locked, when
   * those fetches are refused. One change at a time: a change arriving
   * while one is followed is followed once more after it lands.
   */
  private followChange(id: string): void {
    if (id !== this.currentKey() || this.locked()) return

    if (this.following.has(id)) {
      this.followAgain.add(id)

      return
    }

    this.following.add(id)
    void this.refetchShown(id).finally(() => {
      this.following.delete(id)

      if (this.followAgain.delete(id)) this.followChange(id)
    })
  }

  /**
   * The daemon's comment split for a workspace settled: the diffs on screen (its own and its
   * shown pull requests') and their diff tabs on screen are fetched again, nothing else.
   */
  private followDiffSettled(id: string): void {
    if (id !== this.currentKey() || this.locked()) return

    if (!this.state.review.open && this.layout(id).views.length === 0) return
    void this.refreshDiff(id)

    for (const pr of this.shownPrs(id)) void this.refreshDiff(id, prAgainst(pr))
  }

  private refetchShown(key: string): Promise<void> {
    const { open } = this.state.review
    const place = this.reviewPlace(key)
    const views = this.layout(key).views
    const fileTabs = views.some((v) => filePathOf(v) !== null)

    if (!open && views.length === 0) return Promise.resolve()
    const loads = [this.refreshDiff(key)]

    if ((open && place.view === 'files') || fileTabs) loads.push(this.reloadFiles(key))

    // A pull request's own files on screen, unless it has not moved since they were fetched.
    for (const pr of this.shownPrs(key)) {
      const against = prAgainst(pr)

      if (this.diffFor.get(diffKey(key, against)) !== pr.updatedAt) {
        loads.push(this.refreshDiff(key, against))
      }
    }

    return Promise.all(loads).then(() => undefined)
  }

  setReviewWidth(px: number): void {
    this.setReview({ width: clampReviewWidth(px) })
  }

  // ---- diff tabs ------------------------------------------------------------

  /**
   * Opens a file's diff tab and selects it: where it already is, or else in the focused pane.
   * `against`: a branch's own diff of it (a pull request's) instead of the worktree's. With a
   * `line`, the tab shows that line of the new file, each time it is asked.
   */
  openDiff(key: string, path: string, opts: { against?: DiffAgainst; line?: number } = {}): void {
    const id = diffId(path, opts.against)
    this.openView(key, id)
    const { line } = opts

    if (line === undefined) return
    const target = keyOf(key, id)
    const nonce = (this.state.diffTargets[target]?.nonce ?? 0) + 1
    this.setWith((s) => ({ diffTargets: { ...s.diffTargets, [target]: { line, nonce } } }))
  }

  /** Opens a worktree file's read-only tab and selects it: where it already is, or else in the focused pane. */
  openFile(key: string, path: string): void {
    this.openView(key, fileId(path))
  }

  private openView(key: string, id: string): void {
    const l = this.layout(key)

    if (l.views.includes(id)) {
      this.selectTerminal(key, id)

      return
    }

    this.setLayout(key, {
      ...placeIn(l, this.focusedPane(key), id, { append: true }),
      views: [...l.views, id]
    })
  }

  /** Closes a view tab; its pane selects the neighbouring tab, and an emptied split collapses. */
  closeView(key: string, id: string): void {
    const l = this.layout(key)

    if (!l.views.includes(id)) return
    const pane = l.second.includes(id) ? 1 : 0
    const ids = this.paneIds(key, pane)
    const at = ids.indexOf(id)
    const neighbour = ids[at - 1] ?? ids[at + 1] ?? null
    const active: PaneLayout['active'] = [...l.active]

    if (this.paneActiveId(key, pane) === id) active[pane] = neighbour

    const next: PaneLayout = {
      ...l,
      views: l.views.filter((v) => v !== id),
      second: l.second.filter((x) => x !== id),
      active
    }

    const tabIds = this.tabs(key).map((t) => t.id)
    this.setLayout(key, reconcileLayout(next, new Set(tabIds), tabIds))
    const reveals = keyOf(key, id)

    if (reveals in this.state.diffReveals) {
      this.setWith((s) => ({ diffReveals: without(s.diffReveals, reveals) }))
    }
  }

  /** Closes the focused pane's active tab: a view tab (a diff or a file), or a terminal (which is killed). */
  closeActiveTab(key: string): void {
    const id = this.paneActiveId(key, this.focusedPane(key))

    if (id && isViewId(id)) this.closeView(key, id)
    else if (id) void this.closeTerminal(id)
  }

  /**
   * Fetches one key of a resource and keeps the answer, or why it failed: with `keepOnError` the
   * last value stays beside the error, else it is dropped. With `latestOnly`, only the latest
   * fetch per key lands, so a quick change of scope never shows a stale answer; the fetcher gets
   * the check, for side effects of its own. `onData` adds to the patch that keeps a value.
   */
  private fetchInto<K extends ResourceName>(
    name: K,
    key: string,
    fetcher: (current: () => boolean) => Promise<Resources[K]>,
    opts: {
      latestOnly: boolean
      keepOnError: boolean
      onData?: (s: QueState, data: Resources[K]) => Partial<QueState>
    }
  ): Promise<void> {
    const slot = `${name}\0${key}`
    const seq = (this.loadSeq.get(slot) ?? 0) + 1

    if (opts.latestOnly) this.loadSeq.set(slot, seq)
    const current = (): boolean => !opts.latestOnly || this.loadSeq.get(slot) === seq

    const load = (async () => {
      try {
        const data = await fetcher(current)

        if (!current()) return
        this.setWith((s) => ({
          ...withEntry(s, name, key, { data, error: null }),
          ...opts.onData?.(s, data)
        }))
      } catch (err) {
        if (!current()) return
        const error = errorMessage(err)

        this.setWith((s) =>
          withEntry(s, name, key, opts.keepOnError ? { ...s[name][key], error } : { error })
        )
      }
    })()

    this.loads.set(slot, load)
    void load.finally(() => {
      if (this.loads.get(slot) === load) this.loads.delete(slot)
    })

    return load
  }

  /** Fetches one key of a resource unless it is loaded or on its way. */
  private ensure(name: ResourceName, key: string, fetch: () => Promise<void>): Promise<void> {
    if (this.state[name][key]?.data !== undefined) return Promise.resolve()

    return this.loads.get(`${name}\0${key}`) ?? fetch()
  }

  /**
   * Fetches one pull request's conversation (nothing before the workspace is loaded); a failure
   * (quiet hours too) is kept for the view. Open in the pane, it is then seen.
   */
  fetchPrThread(key: string, number: number, refresh = false): Promise<void> {
    if (!this.state.workspaces[key]) return Promise.resolve()

    return this.fetchInto(
      'prThreads',
      keyOf(key, number),
      () =>
        this.api.workspace.prThread(
          refresh ? { id: key, number, refresh: true } : { id: key, number }
        ),
      { latestOnly: false, keepOnError: true }
    ).then(() => this.markPrSeen(key, number))
  }

  /** Fetches the conversation unless it is loaded or on its way. */
  ensurePrThread(key: string, number: number): Promise<void> {
    return this.ensure('prThreads', keyOf(key, number), () => this.fetchPrThread(key, number))
  }

  /**
   * The pane's Refresh on the pull requests: checks them with GitHub now, and inside a pull
   * request also fetches its conversation and its files again, all at once. Settles when all
   * of it has landed; a failure is kept for the view, never thrown.
   */
  refreshPrs(key: string): Promise<void> {
    const { pr: number } = this.reviewPlace(key)
    const pr = this.state.workspaces[key]?.prs.find((p) => p.number === number)
    const loads = [this.checkPrs(key)]

    if (pr) loads.push(this.fetchPrThread(key, pr.number, true), this.fetchDiff(key, prAgainst(pr)))

    return Promise.all(loads).then(() => undefined)
  }

  /**
   * Asks the daemon to check a workspace's pull requests with GitHub now and keeps the
   * workspace it answers (workspace.updated brings the same). Why it failed is kept for the
   * view until the next check starts.
   */
  private async checkPrs(key: string): Promise<void> {
    if (!this.state.workspaces[key]) return

    if (key in this.state.prCheckErrors) {
      this.setWith((s) => ({ prCheckErrors: without(s.prCheckErrors, key) }))
    }

    try {
      const ws = await this.api.workspace.checkPrs({ id: key })

      // One removed while it was checked stays gone.
      if (this.state.workspaces[key]) this.upsertWorkspace(ws)
    } catch (err) {
      const error = errorMessage(err)

      this.setWith((s) => ({ prCheckErrors: { ...s.prCheckErrors, [key]: error } }))
    }
  }

  /** The base and commit a workspace's diff is narrowed to. */
  diffScope(key: string): DiffScope {
    return this.state.diffScopes[key] ?? NO_SCOPE
  }

  /**
   * Fetches a workspace's diff in its scope; a failure (quiet hours too) is kept for the views.
   * A base the daemon reports as rejected (a branch since deleted) is forgotten; the diff is then against its default.
   * Only the latest fetch per workspace lands, so a quick change of scope never shows a stale answer.
   * `against`: a branch's own committed files against a base instead (a pull request's), noted
   * with that pull request's updatedAt.
   */
  fetchDiff(key: string, against?: DiffAgainst): Promise<void> {
    if (against) return this.fetchBranchDiff(key, against)

    return this.fetchInto(
      'diffs',
      key,
      async (current) => {
        const scope = this.diffScope(key)

        const diff = await this.api.workspace.diff({
          id: key,
          base: scope.base ?? undefined,
          commit: scope.commit ?? undefined
        })

        if (diff.rejectedBase !== null && current()) {
          rememberDiffBase(key, null)
          this.setWith((s) => ({
            diffScopes: { ...s.diffScopes, [key]: { ...scope, base: null } }
          }))
        }

        return diff
      },
      { latestOnly: true, keepOnError: false, onData: (s, diff) => openNewlyChanged(s, key, diff) }
    )
  }

  private fetchBranchDiff(key: string, against: DiffAgainst): Promise<void> {
    const k = diffKey(key, against)
    const pr = prOfDiff(this.state.workspaces[key]?.prs ?? [], against)

    return this.fetchInto(
      'diffs',
      k,
      async (current) => {
        if (against.head === '') throw new Error('The branch of this pull request is unknown.')

        const diff = await this.api.workspace.diff({
          id: key,
          base: against.base || undefined,
          head: against.head
        })

        if (current()) this.diffFor.set(k, pr?.updatedAt ?? null)

        return diff
      },
      { latestOnly: true, keepOnError: false }
    )
  }

  /** Compares a workspace against another ref (null: the daemon's choice), over every commit; remembered per workspace. */
  setDiffBase(key: string, base: string | null): Promise<void> {
    rememberDiffBase(key, base)
    this.setWith((s) => ({ diffScopes: { ...s.diffScopes, [key]: { base, commit: null } } }))

    return this.refreshDiff(key)
  }

  /** Narrows a workspace's diff to one commit's own changes (null: every commit). Not remembered. */
  setDiffCommit(key: string, commit: string | null): Promise<void> {
    this.setWith((s) => ({
      diffScopes: { ...s.diffScopes, [key]: { ...(s.diffScopes[key] ?? NO_SCOPE), commit } }
    }))

    return this.refreshDiff(key)
  }

  /** Fetches the diff unless it is loaded or on its way. */
  ensureDiff(key: string, against?: DiffAgainst): Promise<void> {
    return this.ensure('diffs', diffKey(key, against), () => this.fetchDiff(key, against))
  }

  /**
   * Fetches one diff tab's file as lines of tokens, in the tab's scope (the workspace's base and
   * commit, or the branch and base it is against) and with the whitespace option; a failure
   * (quiet hours too) is kept for the tab. Only the latest fetch per tab and option lands.
   */
  fetchDiffFile(key: string, path: string, against?: DiffAgainst): Promise<void> {
    const whitespace = this.state.diffWhitespace

    return this.fetchInto(
      'diffFiles',
      diffFileKey(key, path, against, whitespace),
      () => {
        if (against?.head === '') throw new Error('The branch of this pull request is unknown.')
        const { base, commit } = this.diffScope(key)

        const scope = against
          ? { head: against.head, base: against.base || undefined }
          : { base: base ?? undefined, commit: commit ?? undefined }

        return this.api.workspace.diffFile({ id: key, path, ...scope, whitespace })
      },
      { latestOnly: true, keepOnError: false }
    )
  }

  /** Fetches the tab's file unless it is loaded or on its way. */
  ensureDiffFile(key: string, path: string, against?: DiffAgainst): Promise<void> {
    return this.ensure(
      'diffFiles',
      diffFileKey(key, path, against, this.state.diffWhitespace),
      () => this.fetchDiffFile(key, path, against)
    )
  }

  /**
   * Fetches a workspace's diff again (its worktree's, or a branch's against a base) and the
   * lines of its diff tabs that show the same thing.
   */
  private refreshDiff(key: string, against?: DiffAgainst): Promise<void> {
    const same = diffKey(key, against)

    return Promise.all([
      this.fetchDiff(key, against),
      this.fetchDiffTabs(key, (tab) => diffKey(key, tab.against) === same)
    ]).then(() => undefined)
  }

  /**
   * The lines of a workspace's open diff tabs that `filter` keeps: a tab on screen (the active
   * tab of a pane while the workspace is shown) is fetched again; the rest are forgotten, with
   * both whitespace options, so each is fetched when it is next selected.
   */
  private fetchDiffTabs(key: string, filter: (tab: DiffTab) => boolean): Promise<void> {
    const l = this.layout(key)
    const shown = this.currentKey() === key
    const current = this.state.diffWhitespace

    const onScreen = new Set([
      this.paneActiveId(key, 0),
      l.split ? this.paneActiveId(key, 1) : null
    ])

    const loads: Array<Promise<void>> = []

    for (const id of l.views) {
      const tab = diffOf(id)

      if (!tab || !filter(tab)) continue
      const visible = shown && onScreen.has(id)

      for (const ws of ['show', 'ignore'] as const) {
        const k = diffFileKey(key, tab.path, tab.against, ws)

        if (ws === current && visible) loads.push(this.fetchDiffFile(key, tab.path, tab.against))
        else if (this.state.diffFiles[k]?.data !== undefined) this.forget('diffFiles', k)
      }
    }

    return Promise.all(loads).then(() => undefined)
  }

  /** Lays every diff tab out in one column or side by side; remembered. */
  setDiffMode(mode: DiffMode): void {
    writeStored(DIFF_MODE_KEY, mode)
    this.set({ diffMode: mode })
  }

  /**
   * Has every diff tab show or ignore whitespace; remembered. A tab on screen fetches its lines
   * with the option it lacks, and every refresh forgets the other option's, so none is stale.
   */
  setDiffWhitespace(whitespace: DiffWhitespace): void {
    writeStored(DIFF_WHITESPACE_KEY, whitespace)
    this.set({ diffWhitespace: whitespace })
  }

  /** Has every diff tab wrap long lines in their column, or scroll sideways; remembered. */
  setDiffWrap(wrap: boolean): void {
    writeStored(DIFF_WRAP_KEY, wrap ? 'on' : 'off')
    this.set({ diffWrap: wrap })
  }

  /** Has a project's diff tabs dim, show or fold changed comment lines; remembered per project. */
  setDiffComments(projectId: string, change: Partial<DiffComments>): void {
    const was = this.state.diffComments[projectId] ?? DEFAULT_DIFF_COMMENTS
    const next = { ...this.state.diffComments, [projectId]: { ...was, ...change } }
    writeStored(DIFF_COMMENTS_KEY, JSON.stringify(next))
    this.set({ diffComments: next })
  }

  /** Keeps the folds opened in a diff tab while it is open. */
  setDiffReveals(key: string, id: string, reveals: Reveals): void {
    const k = keyOf(key, id)
    this.setWith((s) => ({ diffReveals: { ...s.diffReveals, [k]: reveals } }))
  }

  // ---- the Files tab and file tabs -------------------------------------------

  /**
   * Lists a workspace's files; a failure (quiet hours too) is kept for the tree.
   * Only the latest listing per workspace lands.
   */
  fetchFiles(key: string): Promise<void> {
    return this.fetchInto('fileLists', key, () => this.api.workspace.files({ id: key }), {
      latestOnly: true,
      keepOnError: false
    })
  }

  /** Lists the files unless they are listed or on their way. */
  ensureFiles(key: string): Promise<void> {
    return this.ensure('fileLists', key, () => this.fetchFiles(key))
  }

  /** Reads one file for its tab; a path that is gone is kept as null, any other failure as an error. */
  fetchFile(key: string, path: string): Promise<void> {
    return this.fetchInto(
      'fileContents',
      fileKey(key, path),
      async () => {
        try {
          return await this.api.workspace.readFile({ id: key, path })
        } catch (err) {
          // The daemon's not-found code: the path left the worktree.
          if (errorCode(err) === 'not_found') return null
          throw err
        }
      },
      { latestOnly: false, keepOnError: false }
    )
  }

  /** Reads the file unless it is read or on its way. */
  ensureFile(key: string, path: string): Promise<void> {
    return this.ensure('fileContents', fileKey(key, path), () => this.fetchFile(key, path))
  }

  /** The Files header's Refresh: the listing, the diff, and every open file tab of the workspace. */
  refreshFiles(key: string): Promise<void> {
    return Promise.all([this.reloadFiles(key), this.fetchDiff(key)]).then(() => undefined)
  }

  /** The listing and every open file tab of a workspace, without the diff. */
  private reloadFiles(key: string): Promise<void> {
    const paths = this.layout(key)
      .views.map(filePathOf)
      .filter((p): p is string => p !== null)

    return Promise.all([this.fetchFiles(key), ...paths.map((p) => this.fetchFile(key, p))]).then(
      () => undefined
    )
  }

  /** Sets the Files tree's open directories for a workspace. */
  setFilesExpanded(key: string, expanded: ReadonlySet<string>): void {
    this.setWith((s) => ({ filesExpanded: { ...s.filesExpanded, [key]: expanded } }))
  }

  showReport(): void {
    this.set({ view: { kind: 'report' } })
  }

  showTickets(): void {
    this.set({ view: { kind: 'tickets' } })
  }

  showSettings(): void {
    this.set({ view: { kind: 'settings' } })
  }

  /** Syncs the tickets now; a failure goes to the error banner. */
  syncTickets(): Promise<void> {
    return this.guard(async () => {
      const r = await this.api.tickets.sync()
      this.set({ tickets: r.tickets, ticketsSync: r.sync })
    })
  }

  /**
   * Starts a ticket: a workspace in the learned (or chosen) project, or a loose
   * session. Asks which project when none is known. Throws for the dialog.
   */
  async startTicket(
    key: string,
    choice?: { projectId: string } | { session: true }
  ): Promise<void> {
    const result = await this.api.tickets.start({ key, ...choice })

    if (result.kind === 'needs_project') {
      this.openDialog({ kind: 'start-ticket', key, projects: result.projects })
    } else if (result.kind === 'workspace') {
      this.upsertWorkspace(result.workspace)
      this.showTerminals(result.workspace.id)
    } else {
      // Add the tab before the view shows, so the view does not open a second terminal.
      this.addTab(result.terminal)
      this.showTerminals(SCRATCH)
      this.selectTerminal(SCRATCH, result.terminal.id)
    }
  }

  /** The Start button: like startTicket, with a failure shown in the error banner. */
  beginTicket(key: string): Promise<void> {
    return this.guard(() => this.startTicket(key))
  }

  unlock(): Promise<void> {
    return this.guard(async () => this.set({ quiet: await this.api.quiet.unlock() }))
  }

  lock(): Promise<void> {
    return this.guard(async () => this.set({ quiet: await this.api.quiet.lock() }))
  }

  /** Goes quiet now, as in quiet hours, for `minutes`. */
  startQuiet(minutes: number): Promise<void> {
    return this.guard(async () => this.set({ quiet: await this.api.quiet.start({ minutes }) }))
  }

  /** Ends a manual quiet early. */
  endQuiet(): Promise<void> {
    return this.guard(async () => this.set({ quiet: await this.api.quiet.end() }))
  }

  fetchUnlocks(since?: string): Promise<QuietUnlock[]> {
    return this.api.quiet.log(since ? { since } : undefined)
  }

  /** Saves config changes; throws for the settings view to show. */
  async saveConfig(p: ConfigSetParams): Promise<ConfigGetResult> {
    const config = await this.api.config.set(p)
    this.set({ config })

    return config
  }

  /** The instructions file (instructions_file): its path, whether it exists, its text. */
  loadInstructions(): Promise<InstructionsGetResult> {
    return this.api.instructions.get()
  }

  /** Writes the instructions file; rejects with `not_configured` when no path is set. */
  saveInstructions(content: string): Promise<InstructionsGetResult> {
    return this.api.instructions.set({ content })
  }

  /** Selects a tab (a terminal or a view) within the pane that holds it, and focuses that pane. */
  selectTerminal(key: string, id: string): void {
    const l = this.layout(key)
    this.setLayout(key, placeIn(l, l.second.includes(id) ? 1 : 0, id, { append: false }))
  }

  /** Focuses a pane (the second only when the key is split). */
  focusPane(key: string, pane: 0 | 1): void {
    const l = this.layout(key)

    if (l.focused === pane || (pane === 1 && !l.split)) return
    this.setLayout(key, { ...l, focused: pane })
  }

  /** The layout of a key. */
  layout(key: string): PaneLayout {
    return this.state.layouts[key] ?? NO_SPLIT
  }

  /** The terminal tabs of one pane, oldest first. */
  paneTabs(key: string, pane: 0 | 1): TermTab[] {
    const second = this.layout(key).second

    return this.tabs(key).filter((t) => second.includes(t.id) === (pane === 1))
  }

  /** The view (diff) tab ids of one pane, in the order they were opened. */
  paneViews(key: string, pane: 0 | 1): string[] {
    const l = this.layout(key)

    return l.views.filter((v) => l.second.includes(v) === (pane === 1))
  }

  /** Every tab id of one pane: its terminals, then its views. */
  private paneIds(key: string, pane: 0 | 1): string[] {
    return [...this.paneTabs(key, pane).map((t) => t.id), ...this.paneViews(key, pane)]
  }

  /** The selected tab id (a terminal or a view) of a pane, else its newest tab. */
  paneActiveId(key: string, pane: 0 | 1): string | null {
    const ids = this.paneIds(key, pane)
    const want = this.layout(key).active[pane]

    return (want && ids.includes(want) ? want : ids.at(-1)) ?? null
  }

  /** The selected terminal of a pane; null when the pane shows a view tab or holds no terminal. */
  paneActive(key: string, pane: 0 | 1): TermTab | null {
    const id = this.paneActiveId(key, pane)

    return this.paneTabs(key, pane).find((t) => t.id === id) ?? null
  }

  focusedPane(key: string): 0 | 1 {
    const l = this.layout(key)

    return l.split ? l.focused : 0
  }

  /** Creates a terminal for a key (a workspace's, or a loose one in the active tab's folder). */
  private async createFor(key: string): Promise<TermInfo> {
    if (key === SCRATCH) {
      const cwd = this.activeTab(key)?.cwd ?? (await this.homedir())

      return this.api.term.create({ cwd, cols: DEFAULT_COLS, rows: DEFAULT_ROWS })
    }

    return this.api.workspace.openTerminal({ id: key, cols: DEFAULT_COLS, rows: DEFAULT_ROWS })
  }

  /**
   * Creates a terminal and places it in a pane once its id is known, before its
   * tab appears, so it never mounts in the wrong pane (see `creating`).
   */
  private async openIn(key: string, place: (id: string) => void): Promise<void> {
    this.creating++

    try {
      const info = await this.createFor(key)
      place(info.id)
      this.addTab(info)
    } catch (err) {
      this.set({ error: errorMessage(err) })
    } finally {
      this.creating--

      if (this.creating === 0) {
        const others = this.createdMeanwhile
        this.createdMeanwhile = []

        for (const info of others) this.addTab(info)
      }
    }
  }

  /** A new terminal in the focused pane. */
  async newTerminal(key: string): Promise<void> {
    await this.openIn(key, (id) =>
      this.setLayout(key, placeIn(this.layout(key), this.focusedPane(key), id, { append: true }))
    )
  }

  /** Splits the key in two with a new terminal in the second pane (or adds one to it). */
  async splitPane(key: string, direction: 'row' | 'column'): Promise<void> {
    const first = this.paneActiveId(key, 0)
    await this.openIn(key, (id) => {
      const l = this.layout(key)
      this.setLayout(key, {
        ...l,
        split: l.split ?? { direction, ratio: RATIO_DEFAULT },
        second: [...l.second, id],
        active: [l.split ? l.active[0] : first, id],
        focused: 1
      })
    })
  }

  /** Joins the second pane's tabs onto the first; nothing is killed. */
  joinPanes(key: string): void {
    const l = this.layout(key)

    if (!l.split) return
    this.setLayout(key, {
      ...NO_SPLIT,
      views: l.views,
      active: [l.active[l.focused] ?? l.active[0], null]
    })
  }

  setRatio(key: string, ratio: number): void {
    const l = this.layout(key)

    if (!l.split) return
    this.setLayout(key, { ...l, split: { ...l.split, ratio: clampRatio(ratio) } })
  }

  private setLayout(key: string, layout: PaneLayout): void {
    this.setWith((s) => ({ layouts: { ...s.layouts, [key]: layout } }))
    writeStored(LAYOUT_PREFIX + key, isRemembered(layout) ? JSON.stringify(layout) : null)
  }

  /** Restores the remembered layouts and view tabs, dropping terminals that no longer exist. */
  private hydrateLayouts(): void {
    const layouts: Record<string, PaneLayout> = {}

    try {
      for (let i = 0; i < localStorage.length; i++) {
        const name = localStorage.key(i)

        if (!name?.startsWith(LAYOUT_PREFIX)) continue
        const key = name.slice(LAYOUT_PREFIX.length)
        const parsed = parseLayout(localStorage.getItem(name))

        if (!parsed) continue
        const tabIds = this.tabs(key).map((t) => t.id)
        const l = reconcileLayout(parsed, new Set(tabIds), tabIds)

        if (isRemembered(l)) layouts[key] = l
      }
    } catch {
      return
    }

    this.setWith((s) => ({ layouts: { ...layouts, ...s.layouts } }))
  }

  /** Removes a tab, collapsing its key's split if a pane is left empty. */
  private removeTab(id: string): void {
    const key = this.state.terminals.find((t) => t.id === id)?.key
    const terminals = this.state.terminals.filter((t) => t.id !== id)
    this.set({ terminals })
    const l = key === undefined ? undefined : this.state.layouts[key]

    if (key === undefined || !l?.split) return
    const tabIds = terminals.filter((t) => t.key === key).map((t) => t.id)
    const next = reconcileLayout(l, new Set(tabIds), tabIds)

    if (next !== l) this.setLayout(key, next)
  }

  async closeTerminal(id: string): Promise<void> {
    this.removeTab(id)

    try {
      await this.api.term.kill({ id })
    } catch {
      // Already gone.
    }
  }

  /** The tabs of a key, oldest first. */
  tabs(key: string): TermTab[] {
    return this.state.terminals.filter((t) => t.key === key)
  }

  /** The selected terminal of the focused pane, else of the first pane. */
  activeTab(key: string): TermTab | null {
    return this.paneActive(key, this.focusedPane(key)) ?? this.paneActive(key, 0)
  }

  addProject(): Promise<void> {
    return this.guard(async () => {
      const dir = await this.api.app.openFolder()

      if (!dir) return
      const project = await this.api.project.add({ path: dir })
      this.setWith((s) => ({
        projects: s.projects.some((p) => p.id === project.id)
          ? s.projects
          : [...s.projects, project]
      }))
    })
  }

  /**
   * Creates a workspace and shows it, which opens its first terminal. With `start`, the daemon
   * opens that terminal and types claude on the start prompt into it once setup is done; its tab
   * is added before the view shows, so the view does not open a second one. Throws for the dialog.
   */
  async createWorkspace(p: {
    projectId: string
    brief: string
    /** The workspace, branch and folder name. */
    name: string
    baseRef?: string
    start?: boolean
  }): Promise<void> {
    const { start, ...params } = p
    const ws = await this.api.workspace.create(params)
    this.upsertWorkspace(ws)

    if (!start) {
      this.showTerminals(ws.id)

      return
    }

    // The workspace exists now: a failure to start goes to the banner, not back to the dialog.
    let terminal: TermInfo

    try {
      ;({ terminal } = await this.api.workspace.start({
        id: ws.id,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS
      }))
    } catch (err) {
      this.set({ error: errorMessage(err) })
      this.showTerminals(ws.id)

      return
    }

    this.addTab(terminal)
    this.showTerminals(ws.id)
    this.selectTerminal(ws.id, terminal.id)
  }

  /** Whether a rename may also rename the workspace's branch (it was never pushed). */
  async canRenameBranch(id: string): Promise<boolean> {
    return (await this.api.workspace.canRenameBranch({ id })).allowed
  }

  /**
   * Tells the daemon the workspace is selected in a focused window, so a finish it shows
   * no longer reads as new. Errors (a dropped connection, a workspace just removed) are
   * dropped: the next selection or focus asks again.
   */
  async markSeen(id: string): Promise<void> {
    try {
      this.upsertWorkspace(await this.api.workspace.seen({ id }))
    } catch {
      // nothing to show; see above
    }
  }

  /** Sets a workspace's title (and branch, when asked). Throws for the dialog. */
  async renameWorkspace(id: string, title: string, branch?: string): Promise<void> {
    const ws = await this.api.workspace.rename({ id, title, branch })

    this.upsertWorkspace(ws)
  }

  /** Removes the project and, with it, its workspaces (terminals killed, worktrees deleted). */
  async removeProject(id: string): Promise<void> {
    await this.api.project.remove({ id, force: true })
    this.setWith((s) => dropProject(s, id))
  }

  /**
   * Starts the workspace's removal and moves the view off it at once. The daemon answers
   * straight away; the row stays, `removing`, until workspace.removed drops it.
   */
  async removeWorkspace(id: string, deleteBranch: boolean): Promise<void> {
    await this.api.workspace.remove({ id, deleteBranch })
    this.setWith((s) => ({ view: viewWithout(s.view, [id]) }))
  }

  openInEditor(path: string): Promise<void> {
    return this.guard(async () => {
      await this.api.app.openInEditor({ path })
    })
  }

  fetchReport(): Promise<Report> {
    return this.api.report.get()
  }
}

/** The state's patch that keeps one key's entry of a resource. */
function withEntry<K extends ResourceName>(
  s: QueState,
  name: K,
  key: string,
  entry: Resource<Resources[K]>
): Partial<QueState> {
  const patch: Partial<ResourceTables> = { [name]: { ...s[name], [key]: entry } }

  return patch
}

/**
 * Once the Files tree has its open directories, any directory that holds a changed file in the
 * new diff and held none before is opened; the rest of the set stands.
 */
function openNewlyChanged(s: QueState, key: string, diff: WorkspaceDiff): Partial<QueState> {
  const expanded = s.filesExpanded[key]

  if (expanded === undefined) return {}

  const tree = buildTree(
    s.fileLists[key]?.data?.files ?? [],
    new Map(diff.files.map((f) => [f.path, f]))
  )

  const opened = newlyChanged(
    (s.diffs[key]?.data?.files ?? []).map((f) => f.path),
    tree
  )

  if (opened.length === 0) return {}

  return { filesExpanded: { ...s.filesExpanded, [key]: new Set([...expanded, ...opened]) } }
}

/** Both lists in creation order, without duplicates (the first list's copy wins). */
function mergeById<T extends { id: string; createdAt: string }>(
  a: readonly T[],
  b: readonly T[]
): T[] {
  const seen = new Set(a.map((x) => x.id))

  return [...a, ...b.filter((x) => !seen.has(x.id))].sort((x, y) =>
    x.createdAt.localeCompare(y.createdAt)
  )
}

/** The error line for a removal with failed steps: `Removing <name>: running teardown failed, timed out after 60s`. */
function removalFailedMessage(name: string, failed: RemovalFailure[]): string {
  const steps = failed.map((f) => `${removalStepLabel(f.step)} failed, ${f.error}`)

  return `Removing ${name}: ${steps.join('; ')}`
}

/** The view, or the scratch terminals when it shows one of these workspaces. */
function viewWithout(view: View, ids: readonly string[]): View {
  return view.kind === 'terminals' && ids.includes(view.key)
    ? { kind: 'terminals', key: SCRATCH }
    : view
}

/** The state without a project and its workspaces; a view on one of them goes back to scratch. */
function dropProject(s: QueState, id: string): Partial<QueState> {
  const gone = new Set(
    Object.values(s.workspaces)
      .filter((w) => w.projectId === id)
      .map((w) => w.id)
  )

  return {
    projects: s.projects.filter((p) => p.id !== id),
    workspaces: Object.fromEntries(Object.entries(s.workspaces).filter(([k]) => !gone.has(k))),
    view: viewWithout(s.view, [...gone])
  }
}

export const StoreContext = createContext<QueStore | null>(null)

export function useStore(): QueStore {
  const store = useContext(StoreContext)

  if (!store) throw new Error('useStore() outside <App>')

  return store
}

/** The store's state; re-renders on every change. */
export function useQue(): QueState {
  const store = useStore()

  return useSyncExternalStore(store.subscribe, store.getState)
}

/**
 * One value of the store's state; re-renders only when it changes (by Object.is). The selector
 * must return a value the state already holds (a field, an entry, a primitive), never a new
 * object or array per call.
 */
export function useQueSelector<T>(select: (s: QueState) => T): T {
  const store = useStore()

  return useSyncExternalStore(store.subscribe, () => select(store.getState()))
}

/**
 * The store, for a component that reads a key's tabs and panes through its pane methods
 * (paneTabs, paneActiveId, activeTab, …): re-renders when the terminals or the key's layout change.
 */
export function usePanes(key: string): QueStore {
  useQueSelector((s) => s.terminals)
  useQueSelector((s) => s.layouts[key])

  return useStore()
}
