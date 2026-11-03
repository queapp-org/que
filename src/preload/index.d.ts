import type {
  CheckState,
  PrCheck,
  ReviewState,
  PrThreadEntry,
  PrThread,
  ConfigGetResult,
  ConfigSetParams,
  Events,
  InstructionsGetResult,
  InstructionsSetParams,
  ProjectAddParams,
  ProjectRemoveParams,
  QuietLogParams,
  QuietStartParams,
  QuietUnlockParams,
  Report,
  TicketsListResult,
  TicketsStartResult,
  TicketsStartParams,
  JiraConfig,
  TicketsSyncState,
  Ticket,
  TicketLevel,
  ReportParams,
  WorkspaceDigest,
  TermAttachResult,
  TermCreateParams,
  TermInfo,
  TermListParams,
  TermSnapshotResult,
  WorkspacePrepareParams,
  WorkspaceDiff,
  WorkspaceDiffFile,
  WorkspaceDiffFileParams,
  DiffHunk,
  DiffLine,
  DiffToken,
  TokenKind,
  DiffFile,
  DiffCommit,
  WorkspaceFiles,
  WorkspaceFile,
  WorkspaceListParams,
  WorkspaceOpenTerminalParams,
  WorkspaceRemoveParams,
  WorkspaceRenameParams
} from '../shared/protocol'
import type {
  DaemonState,
  NotificationsConfig,
  Project,
  PullRequest,
  QuietHoursConfig,
  QuietState,
  QuietUnlock,
  UpdateInfo,
  UpdateStatus,
  Usage,
  UsageWindow,
  UserConfig,
  Weekday,
  Workspace,
  WorkspaceStatus
} from '../shared/types'

export type {
  ConfigGetResult,
  DaemonState,
  ConfigSetParams,
  InstructionsGetResult,
  InstructionsSetParams,
  Events,
  NotificationsConfig,
  Project,
  PullRequest,
  QuietHoursConfig,
  QuietState,
  QuietUnlock,
  Usage,
  UsageWindow,
  UserConfig,
  Weekday,
  Report,
  TicketsListResult,
  TicketsStartResult,
  TicketsStartParams,
  JiraConfig,
  TicketsSyncState,
  Ticket,
  TicketLevel,
  WorkspaceDigest,
  TermAttachResult,
  TermCreateParams,
  TermInfo,
  TermSnapshotResult,
  UpdateInfo,
  UpdateStatus,
  Workspace,
  WorkspaceDiff,
  WorkspaceDiffFile,
  WorkspaceDiffFileParams,
  DiffHunk,
  DiffLine,
  DiffToken,
  TokenKind,
  DiffFile,
  DiffCommit,
  WorkspaceFiles,
  WorkspaceFile,
  CheckState,
  PrCheck,
  ReviewState,
  PrThreadEntry,
  PrThread,
  WorkspaceStatus
}

/** Mirrors the daemon's term.* protocol methods and events. */
export interface TermApi {
  create(params: TermCreateParams): Promise<TermInfo>
  list(params?: TermListParams): Promise<TermInfo[]>
  attach(params: { id: string; cols: number; rows: number }): Promise<TermAttachResult>
  detach(params: { id: string }): Promise<{ ok: true }>
  write(params: { id: string; data: string }): void
  resize(params: { id: string; cols: number; rows: number }): Promise<{ ok: true }>
  kill(params: { id: string }): Promise<{ ok: true }>
  snapshot(params: { id: string }): Promise<TermSnapshotResult>
  on<E extends TermEventName>(event: E, cb: (data: Events[E]) => void): () => void
  onDisconnect(cb: () => void): () => void
}

export type TermEventName =
  | 'term.data'
  | 'term.exit'
  | 'term.created'
  | 'term.killed'
  | 'term.updated'

export interface AppApi {
  homedir(): Promise<string>
  /** Shows a native folder picker; resolves to the chosen path or null. */
  openFolder(): Promise<string | null>
  /** Opens a folder in a new editor window (`code -n <path>`); fire-and-forget. */
  openInEditor(params: { path: string }): Promise<{ ok: true }>
  /** Opens a workspace's setup log in the system's viewer for it. */
  openSetupLog(params: { id: string }): Promise<{ ok: true }>
  /** The menu-bar title. Answers only when the app was launched with QUE_E2E=1. */
  trayTitle(): Promise<string>
  /** What the update check last said, and what this build is. */
  updateStatus(): Promise<UpdateStatus>
  /** Fires whenever a check finishes, in the background or asked for. */
  onUpdateStatus(cb: (status: UpdateStatus) => void): () => void
  /** Asks for the latest release now, past the interval. A local build never asks and answers as it stands. */
  checkForUpdate(): Promise<UpdateStatus>
  /** Opens the newer release's page in the browser. */
  openUpdate(): Promise<{ ok: true }>
  /** True only when the app was launched with QUE_E2E=1. */
  e2e: boolean
}

/**
 * The background service itself, from the main process (not daemon socket methods).
 * The reconnect contract: when the connection drops, `term.onDisconnect` fires; the
 * main process reconnects (or starts a daemon) on the next call that needs it, and
 * `daemon.reconnected` fires once a connection that had dropped is back.
 */
export interface DaemonApi {
  /** Connects (or starts a daemon) if needed, then says which build it runs. */
  state(): Promise<DaemonState>
  /**
   * Updates the daemon in place to this app's build: every terminal moves to the
   * new daemon with the same id and keeps running, and `daemon.reconnected` fires.
   * Rejects when the hand-off failed, saying what that means; the old daemon
   * still serves, and the app never restarts it (`que daemon restart` does).
   */
  upgrade(): Promise<DaemonState>
  /** Fires after a dropped connection is back (an update, a restart, or the daemon came back). */
  onReconnected(cb: (state: DaemonState) => void): () => void
}

export type ProjectEventName = 'project.added' | 'project.removed'

/** Mirrors the daemon's project.* methods and events. */
export interface ProjectApi {
  add(params: ProjectAddParams): Promise<Project>
  list(): Promise<Project[]>
  remove(params: ProjectRemoveParams): Promise<{ ok: true }>
  on<E extends ProjectEventName>(event: E, cb: (data: Events[E]) => void): () => void
}

export type WorkspaceEventName =
  | 'workspace.created'
  | 'workspace.updated'
  | 'workspace.removed'
  | 'workspace.changed'
  | 'workspace.diffSettled'

export type WorkspaceEvents = Pick<Events, WorkspaceEventName>

/** Mirrors the daemon's workspace.* methods and events. */
export interface WorkspaceApi {
  /** Answers with the row before the fetch and the worktree; the steps then run in the daemon. */
  prepare(params: WorkspacePrepareParams): Promise<Workspace>
  list(params?: WorkspaceListParams): Promise<Workspace[]>
  get(params: { id: string }): Promise<Workspace>
  remove(params: WorkspaceRemoveParams): Promise<{ ok: true }>
  /** Opens a terminal in the worktree with the hooks wrapper on PATH. */
  openTerminal(params: WorkspaceOpenTerminalParams): Promise<TermInfo>
  /** Types claude with the start prompt into the workspace's first terminal (opened when none) once setup is done. */
  /** Sets the title, and renames the branch when asked and allowed. */
  rename(params: WorkspaceRenameParams): Promise<Workspace>
  /** Whether rename may also rename the branch (it was never pushed). */
  canRenameBranch(params: { id: string }): Promise<{ allowed: boolean }>
  /** The workspace is selected in a focused window: records it as seen (seenAt). */
  seen(params: { id: string }): Promise<Workspace>
  /** What the workspace changed against its base, file by file; with `head`, that branch's committed files against `base` instead. Refused in quiet hours. */
  diff(params: {
    id: string
    base?: string
    head?: string
    commit?: string
  }): Promise<WorkspaceDiff>
  /** One file of diff()'s scope as hunks of tokenized lines (syntax kinds, bracket depth, word marks), whole-file context when it fits. Refused in quiet hours. */
  diffFile(params: WorkspaceDiffFileParams): Promise<WorkspaceDiffFile>
  /** Pull request `number`'s conversation: comments, reviews, line comments. Null when the workspace has no such PR. Refused in quiet hours. */
  prThread(params: { id: string; number: number; refresh?: boolean }): Promise<PrThread | null>
  /** Check the workspace's pull requests with GitHub now; workspace.updated carries what changed. Rejects with gh's message when it fails. Refused in quiet hours. */
  checkPrs(params: { id: string }): Promise<Workspace>
  /** Every tracked and untracked file of the worktree, sorted; never the ignored ones. Refused in quiet hours. */
  files(params: { id: string }): Promise<WorkspaceFiles>
  /** One file of the worktree for the file view; the path is relative and must stay inside the worktree. Refused in quiet hours. */
  readFile(params: { id: string; path: string }): Promise<WorkspaceFile>
  /** Ask the daemon to watch this workspace's worktree, so `workspace.changed` names it while this window shows it. */
  watch(params: { id: string }): Promise<{ ok: true }>
  /** Stop asking for watch(); the daemon may still watch it for another window or an attached terminal. */
  unwatch(params: { id: string }): Promise<{ ok: true }>
  on<E extends WorkspaceEventName>(event: E, cb: (data: Events[E]) => void): () => void
}

export interface ReportApi {
  get(params?: ReportParams): Promise<Report>
}

/** Mirrors the daemon's quiet.* methods and the quiet.changed event. */
export interface QuietApi {
  state(): Promise<QuietState>
  /** Unlocks detail for `minutes` (default: the configured unlock length). */
  unlock(params?: QuietUnlockParams): Promise<QuietState>
  /** Ends an unlock early. */
  lock(): Promise<QuietState>
  /** Starts a manual quiet window for `minutes` (default 60), or replaces the one running. */
  start(params?: QuietStartParams): Promise<QuietState>
  /** Ends a manual quiet window and any unlock in it. */
  end(): Promise<QuietState>
  log(params?: QuietLogParams): Promise<QuietUnlock[]>
  on(event: 'quiet.changed', cb: (data: QuietState) => void): () => void
}

/** Mirrors the daemon's usage.get and the usage.changed event: Claude plan usage. */
export interface UsageApi {
  /** The newest reading without the windows that have reset; null before the first or once none is left. */
  get(): Promise<Usage | null>
  on(event: 'usage.changed', cb: (data: Usage | null) => void): () => void
}

/** Mirrors the daemon's config.* methods and the config.changed event. */
export interface ConfigApi {
  get(): Promise<ConfigGetResult>
  set(params: ConfigSetParams): Promise<ConfigGetResult>
  on(event: 'config.changed', cb: (data: ConfigGetResult) => void): () => void
}

/** Mirrors the daemon's instructions.* methods: the file named by instructions_file. */
export interface InstructionsApi {
  get(): Promise<InstructionsGetResult>
  /** Rejects with code `not_configured` when instructions_file is unset. */
  set(params: InstructionsSetParams): Promise<InstructionsGetResult>
}

/** Mirrors the daemon's tickets.* methods and the tickets.synced event. */
export interface TicketsApi {
  list(): Promise<TicketsListResult>
  sync(): Promise<TicketsListResult>
  start(params: TicketsStartParams): Promise<TicketsStartResult>
  projectFor(params: { key: string }): Promise<{ projectId: string | null }>
  on(event: 'tickets.synced', cb: (data: TicketsListResult) => void): () => void
}

export interface QueApi {
  quiet: QuietApi
  usage: UsageApi
  config: ConfigApi
  instructions: InstructionsApi
  term: TermApi
  project: ProjectApi
  workspace: WorkspaceApi
  report: ReportApi
  tickets: TicketsApi
  app: AppApi
  daemon: DaemonApi
}

/** The two chimes: a session finished a turn, or a session needs input. */
export type ChimeKind = 'complete' | 'needs_input'

export interface QueTestHook {
  /** The focused pane's attached terminal, or null. */
  activeTermId(): string | null
  /** The focused pane's terminal screen. */
  screenText(): string
  /**
   * The panes on screen, in order. `activeTab` is the selected tab (a terminal id or a
   * diff tab id, `view:diff:<path>`); `activeTermId` is null while a diff tab is selected.
   */
  panes(): Array<{
    index: number
    activeTermId: string | null
    activeTab: string | null
    focused: boolean
  }>
  /** The review pane at the right of the main area: open or not, the shown workspace's view and the pull request open in it, its width in px. */
  review(): { open: boolean; view: 'prs' | 'changes' | 'files'; pr: number | null; width: number }
  /** The screen of any attached terminal by id ('' when it is not on screen). */
  screenTextOf(termId: string): string
  /** The tray's current title, from the main process. */
  trayTitle(): Promise<string>
  /** The chimes the app would have played, in order (recorded, never played, under e2e). */
  chimes(): ChimeKind[]
}

declare global {
  interface Window {
    que: QueApi
    __que?: QueTestHook
  }
}
