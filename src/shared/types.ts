// Domain types shared by the daemon, CLI, and renderer.

export type WorkspaceStatus =
  | 'preparing'
  | 'idle'
  | 'working'
  | 'needs_input'
  | 'stuck'
  | 'exited'
  | 'removing'

/** A git repository registered with que. */
export interface Project {
  id: string
  name: string
  /** The main checkout (git toplevel). */
  path: string
  defaultBranch: string
  createdAt: string
}

/** Background work the session reported still running at its last turn end (Stop). */
export interface BackgroundTask {
  /** The task id the CLI reported. */
  id: string
  /** `shell`, `subagent`, `monitor`, `workflow`, `teammate`, or whatever the CLI calls it. */
  kind: string
  description: string
  /** When the daemon first saw it (ISO). */
  since: string
}

/** A finished step of a removal or a preparation: how long it took, and why it failed when it did. */
export interface StepResult<S> {
  step: S
  ms: number
  error?: string
}

/** Where a run of steps stands: the steps it runs, since when the current one runs, and those done. */
export interface StepRun<S> {
  /** The steps this run takes, in order. */
  plan: S[]
  /** When the step running now started (ISO): the run was marked, or the previous step finished. */
  since: string
  /** The steps finished so far, with their durations and failures. */
  done: StepResult<S>[]
}

/** The steps a removal runs, in this order. */
export const REMOVAL_STEPS = ['terminals', 'teardown', 'worktree', 'branch'] as const

export type RemovalStep = (typeof REMOVAL_STEPS)[number]

/** A finished removal step. */
export type RemovalResult = StepResult<RemovalStep>

/** A removal step that failed: its result with the reason. */
export type RemovalFailure = RemovalResult & { error: string }

/** Where a removal stands. */
export type Removal = StepRun<RemovalStep>

/** The steps a new workspace's preparation runs, in this order; `setup` only with a setup command, `claude` only when asked. */
export const PREPARATION_STEPS = ['fetch', 'worktree', 'setup', 'claude'] as const

export type PreparationStep = (typeof PREPARATION_STEPS)[number]

/** A finished preparation step. */
export type PreparationResult = StepResult<PreparationStep>

/** Where a new workspace's preparation stands. */
export type Preparation = StepRun<PreparationStep>

/** A git worktree on its own branch, with its own terminals and status. */
export interface Workspace {
  id: string
  projectId: string
  name: string
  /** The branch the worktree has checked out. */
  branch: string
  /**
   * Every branch the worktree has had checked out, oldest first (`branch` among them). Empty for
   * a workspace stored before branches were kept, until the daemon next reads its branch.
   */
  branches: string[]
  path: string
  /** The ref the worktree was made from; empty until workspace.prepare has resolved the default. */
  baseRef: string
  status: WorkspaceStatus
  /** Why it is stuck: `no_heartbeat`, `setup_failed`, `preparation_failed`, `error:<kind>`. */
  statusReason: string | null
  statusAt: string
  lastActivityAt: string | null
  /** The Claude Code session last seen reporting from this workspace. */
  sessionId: string | null
  createdAt: string
  archivedAt: string | null
  /**
   * The pull requests the session created, oldest first: by its own `gh pr create` (its
   * subagents' included) on the project's origin, on any branch.
   */
  prUrls: string[]
  /**
   * The current pull request, as last seen on GitHub: the open or draft one among `prs`, else
   * the most recently updated; null when there is none.
   */
  pr: PullRequest | null
  /**
   * The session's pull requests: those whose head is any of its `branches`, plus each of its
   * `prUrls`. One seen stays when the branch moves on. Newest first by number, at most 20.
   */
  prs: PullRequest[]
  /** When its last turn ended (working to idle); null before one has. */
  finishedAt: string | null
  /** When the app last had it selected in a focused window (workspace.seen); null before. */
  seenAt: string | null
  /** Still running after the last turn ended; agent-like kinds keep the status working, shell and monitor do not. */
  backgroundTasks: BackgroundTask[]
  /** Where its removal stands; present only while it is `removing`. */
  removal?: Removal
  /**
   * Where its preparation stands (workspace.prepare): present from the row's first moment until
   * its steps have run, and kept when a step failed, so that step's reason can be shown.
   */
  preparation?: Preparation
  /** What the work is, in a line (shown instead of the name); absent for a workspace made from a name. */
  title?: string
  /** The description the workspace was made from (written to `.que/brief.md`). */
  brief?: string
  /**
   * Where the title came from: the brief's first line, the session's own terminal title, or
   * the user (an explicit title or a rename, which stops automatic updates).
   */
  titleSource?: TitleSource
}

/** Where a workspace's title came from. */
export const TITLE_SOURCES = ['brief', 'terminal', 'user'] as const

export type TitleSource = (typeof TITLE_SOURCES)[number]

export type CheckState = 'pending' | 'passing' | 'failing' | 'skipped'

/** One check run or commit status on the pull request's head. */
export interface PrCheck {
  name: string
  /** The workflow or app that reported it, when known. */
  source: string | null
  state: CheckState
  url: string | null
  startedAt: string | null
  completedAt: string | null
}

export type ReviewState = 'approved' | 'changes_requested' | 'commented' | 'dismissed' | 'pending'

/** One entry of a pull request's conversation: an issue comment, a review, or a review comment on a line. */
export interface PrThreadEntry {
  id: string
  kind: 'comment' | 'review' | 'line'
  author: string
  body: string
  /** When it was posted (ISO). */
  at: string
  url: string | null
  /** Reviews only. */
  state: ReviewState | null
  /** Line comments only. */
  path: string | null
  line: number | null
  hunk: string | null
}

export interface PrThread {
  workspaceId: string
  number: number
  /** Oldest first. */
  entries: PrThreadEntry[]
  fetchedAt: string
}

/** The state of a workspace's pull request, refreshed by the daemon. */
export interface PullRequest {
  url: string
  number: number
  title: string
  state: 'draft' | 'open' | 'merged' | 'closed'
  /** Combined status checks on the head commit. */
  checks: 'none' | 'pending' | 'passing' | 'failing'
  /** The review decision, or null when no review is required yet. */
  review: 'approved' | 'changes_requested' | 'review_required' | null
  /** The individual check runs behind `checks`. */
  checkRuns: PrCheck[]
  /** When the pull request last changed on GitHub (ISO), or null when unknown. */
  updatedAt: string | null
  /** Lines added and removed across the pull request, or null when unknown. */
  additions: number | null
  deletions: number | null
  /** The branch it merges into (`baseRefName`); empty when unknown. */
  base: string
  /** The branch it merges from (`headRefName`); empty when unknown. */
  head: string
  /** When que last refreshed this from GitHub. */
  checkedAt: string
  /** How many entries its conversation holds, or null before the daemon has fetched it. */
  comments: number | null
  /** When the newest entry of its conversation was posted (ISO); null without one or before it was fetched. */
  commentedAt: string | null
}

/** Workspace counts per status, for the tray and `que status`. */
export type StatusSummary = Record<WorkspaceStatus, number>

/** A quiet window in local wall-clock time, `HH:MM`; it may cross midnight. */
export interface QuietWindow {
  start: string
  end: string
}

/** Weekday keys of `[quiet_hours]`, indexed like Date#getDay(). */
export const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday'
] as const

export type Weekday = (typeof WEEKDAYS)[number]

/** A per-weekday override: its own window, or `none` (no quiet hours that day). */
export type DayWindow = QuietWindow | 'none'

export interface QuietHoursConfig {
  enabled: boolean
  /** The window used on a day without an override. */
  default: QuietWindow
  /** Overrides keyed by the weekday a window starts on. */
  days: Partial<Record<Weekday, DayWindow>>
  /** Length of `que unlock` when no minutes are given. */
  unlockMinutes: number
}

/** A ticket assigned to the user in the issue tracker, as last synced. */
/** Where a ticket sits in the tracker's hierarchy. */
export type TicketLevel = 'epic' | 'standard' | 'subtask'

export interface Ticket {
  key: string
  summary: string
  status: string
  statusCategory: 'new' | 'indeterminate' | 'done' | 'unknown'
  priority: string | null
  type: string
  /** An epic, a standard issue, or a subtask of one. */
  level: TicketLevel
  /** The key of the ticket this one sits under, when known. */
  parentKey: string | null
  /** False for a parent que knows only through its children (not in the search). */
  assigned: boolean
  assignee: string | null
  projectKey: string
  projectName: string
  /** The ticket's page in the tracker. */
  url: string
  labels: string[]
  updatedAt: string | null
  /** When que last synced this ticket. */
  syncedAt: string
  /** The workspace started for it from que, if any. */
  workspaceId: string | null
}

/** How the last ticket sync went. */
export interface TicketsSyncState {
  lastSyncAt: string | null
  /** Why the last sync failed, or null. */
  error: string | null
  count: number
}

/** The `[jira]` table of the config file. */
export interface JiraConfig {
  /** The filter for the ticket queue. */
  jql: string
  /** Minutes between syncs. */
  pollMinutes: number
  /** The tracker site host for links; learned from the CLI's auth status when null. */
  site: string | null
  /** The first prompt typed into claude when a ticket is started. */
  startPrompt: string
  /** Tracker project key → que project name, learned when the user picks. */
  projects: Record<string, string>
}

export interface NotificationsConfig {
  /** Chime when a session finishes a turn (work hours only). */
  chimeOnComplete: boolean
  /** Chime when a session needs input (work hours only). */
  chimeOnNeedsInput: boolean
  /**
   * Let the complete chime through during a manual quiet (`que quiet start`).
   * Scheduled quiet hours stay silent, and needs input never chimes in a window.
   */
  chimeInManualQuiet: boolean
  /** One notification with the night's totals when quiet hours end. */
  morningSummary: boolean
}

/** Claude Code permission modes que may pass with --permission-mode. */
export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'bypassPermissions'
  | 'dontAsk'
  | 'auto'

export interface RepoEntry {
  path: string
  defaultBranch?: string
}

/** The parsed user config (~/.config/que/config.toml or $QUE_CONFIG). */
export interface UserConfig {
  worktreeRoot: string
  stallTimeoutMinutes: number
  /** How long a repo's teardown hook may run when a workspace is removed before it is killed. */
  teardownTimeoutSeconds: number
  statusPollSeconds: number
  /** How often the daemon refreshes each workspace's pull request from GitHub. */
  prPollSeconds: number
  /** Named repositories, so `que work -r <name>` can resolve a name. */
  repos: Record<string, RepoEntry>
  /** Used when a repo's que.toml sets no permission_mode. */
  defaultPermissionMode?: PermissionMode
  /** Required (with the repo opting in) before a workspace session may run with bypassPermissions. */
  allowBypassPermissions: boolean
  /** Branches whose pull requests que does not look up, besides each project's default branch. */
  protectedBranches: string[]
  /**
   * A file appended to every interactive session's system prompt inside a
   * workspace (absolute; a leading ~ is expanded). Unset when absent.
   */
  instructionsFile?: string
  quietHours: QuietHoursConfig
  notifications: NotificationsConfig
  jira: JiraConfig
  /** What claude starts on in a workspace made from a brief; empty (the default) means the brief itself. */
  startPrompt: string
}

/**
 * The daemon the app is connected to, as the main process last saw it: its
 * version and build id, the build id of the bundle this app would start, and
 * whether they differ (shared/build-id.ts).
 */
export interface DaemonState {
  version: string
  buildId: string
  expectedBuildId: string
  stale: boolean
}

/** A newer que release, found by the app's update check. */
export interface UpdateInfo {
  /** The newer version, without a leading v. */
  version: string
  /** Its release page. */
  url: string
}

/** The update check as the app reports it. */
export interface UpdateStatus {
  /** The running app's version. */
  version: string
  /** Only a release build asks for newer releases; see isReleaseBuild. */
  releaseBuild: boolean
  /** A newer release, when the check knows of one. */
  update: UpdateInfo | null
  /** Epoch ms of the last attempt; null before the first. */
  checkedAt: number | null
  /** The last attempt got no usable answer. */
  failed: boolean
}

/** What the daemon says about quiet hours (quiet.state and the quiet.changed event). */
/** A 24-hour `HH:MM` wall-clock time, as quiet-hours windows are written. */
export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

/** Where a quiet window comes from: the quiet_hours config, or `que quiet start`. */
export type QuietKind = 'scheduled' | 'manual'

export interface QuietState {
  enabled: boolean
  inQuietHours: boolean
  /** The source of the window in progress, else null. */
  kind: QuietKind | null
  /** The window in progress (ISO), else null. */
  windowStart: string | null
  windowEnd: string | null
  /** The next start or end (ISO); null when quiet hours never come. */
  nextBoundary: string | null
  /** While an unlock lasts (ISO), else null. */
  unlockedUntil: string | null
  unlockMinutes: number
  /**
   * True while quiet hours are on and no unlock is running: the one value clients
   * ask before showing the board, refusing a detail command or opening a terminal.
   */
  locked: boolean
}

/** One `que unlock`, from the quiet_unlocks log. */
export interface QuietUnlock {
  at: string
  minutes: number
  why: string | null
  /** When it expired or was locked early; null while it lasts. */
  endedAt: string | null
}

/** Anything `JSON.parse` can return. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

/** `T` as a patch: every key optional, scalars and lists clearable with `null`, nested objects patched in turn. */
type Patch<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[]
    ? T[K] | null
    : T[K] extends object
      ? Patch<T[K]> | null
      : T[K] | null
}

/**
 * A `config.set` patch: the parts of a `UserConfig` to change, in its camelCase
 * shape. Sections merge key by key, so a patch names only what it sets. A
 * `null` clears a setting back to its default (or removes a weekday override,
 * a ticket project, a configured repo). Mapping to the file's own key names
 * happens in `shared/config-keys.decode.ts`; nothing on the wire knows them.
 */
export type ConfigPatch = Patch<Omit<UserConfig, 'repos' | 'quietHours' | 'jira'>> & {
  /** A configured repo by name; `null` removes it. */
  repos?: Record<string, Patch<RepoEntry> | null>
  quietHours?: Patch<Omit<QuietHoursConfig, 'default' | 'days'>> & {
    default?: QuietWindow | null
    /** A weekday's override; `null` removes it so the default window applies. */
    days?: Partial<Record<Weekday, DayWindow | null>>
  }
  jira?: Patch<Omit<JiraConfig, 'projects'>> & {
    /** Tracker project key to que project name; `null` forgets a key. */
    projects?: Record<string, string | null>
  }
}

/** One Claude plan usage window: how much of it is used, and when it starts over. */
export interface UsageWindow {
  /** Percent used, 0–100. */
  pct: number
  /** When the window resets, epoch ms. */
  resetsAt: number
}

/**
 * The newest Claude plan usage reading, from any session's status line: the
 * numbers are account-wide. A window is absent before the plan reports it and
 * after it resets. `at` is when the reading was taken (epoch ms);
 * `workspaceId` is the workspace whose session reported it.
 */
export interface Usage {
  fiveHour?: UsageWindow
  sevenDay?: UsageWindow
  at: number
  workspaceId?: string
}
