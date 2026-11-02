// Wire protocol between the que daemon and its clients (Electron main, CLI).
// Newline-delimited JSON over a unix socket. Requests carry an id; responses
// echo it. Events are server-pushed and carry no id.

import type {
  ConfigPatch,
  Project,
  PullRequest,
  QuietKind,
  QuietState,
  QuietUnlock,
  PrThread,
  Ticket,
  TicketsSyncState,
  Usage,
  UserConfig,
  Workspace,
  WorkspaceStatus,
  RemovalFailure
} from './types'

// ---- method types ---------------------------------------------------------

export interface PingResult {
  version: string
  /** The build id of the daemon's bundle (shared/build-id.ts), '' when unknown. */
  buildId: string
  pid: number
  startedAt: string
  nodeVersion: string
  /** The daemon's own PATH, as its child processes see it. */
  path: string
}

/** daemon.handoff: the daemon bundle to hand the terminals to, and the program that runs it as Node. */
export interface HandoffParams {
  /** Default: this daemon's own bundle. */
  script?: string
  /** Default: the program running this daemon. */
  runtime?: string
}

export interface HandoffResult {
  ok: true
  /** The successor's pid. */
  pid: number
  /** How many live terminals it took over. */
  terminals: number
}

export interface TermCreateParams {
  cwd?: string
  cols: number
  rows: number
  name?: string
  /** Program to run instead of the login shell. */
  file?: string
  args?: string[]
}

export interface TermInfo {
  id: string
  name: string
  cwd: string
  cols: number
  rows: number
  pid: number
  alive: boolean
  createdAt: string
  /** Set for terminals opened with workspace.openTerminal. */
  workspaceId?: string
  /** The last title the program set (OSC 0/2), raw; absent when none, or the last was empty. */
  title?: string
  /** The foreground program's name (`zsh`, `claude`, `cat`); kept after the terminal exits. */
  process?: string
}

export interface TermListParams {
  /** Only the terminals of this workspace. */
  workspaceId?: string
}

export interface TermIdParams {
  id: string
}

export interface TermAttachParams {
  id: string
  cols: number
  rows: number
}

export interface TermAttachResult {
  snapshot: string
  cols: number
  rows: number
}

export interface TermWriteParams {
  id: string
  data: string
}

export interface TermResizeParams {
  id: string
  cols: number
  rows: number
}

export interface TermSnapshotResult {
  /** Escape-sequence serialization suitable for writing into an xterm. */
  serialized: string
  /** Plain text of scrollback + screen, one line per row. */
  text: string
}

export interface Ok {
  ok: true
}

export interface ProjectAddParams {
  /**
   * Exactly one of `path` or `repo` is required.
   * `path`: any path inside the repository; the toplevel is registered.
   * `repo`: what `-r` takes, a repo name from `[repos.<name>]` in the user
   * config (registered under that name) or an existing directory.
   */
  path?: string
  repo?: string
  /** The directory a relative `repo` path is resolved against (the caller's); ignored with `path`. */
  cwd?: string
  name?: string
}

export interface ProjectRemoveParams {
  id: string
  /** Also remove its unarchived workspaces. */
  force?: boolean
}

/**
 * A workspace from a name, or from a title or brief. Without a name it is derived from the
 * title (the brief's first line when no title is given) and suffixed `-2`, `-3`, … on a clash.
 */
export interface WorkspaceCreateParams {
  projectId: string
  /** Slugged; a clash is refused. */
  name?: string
  /** What the work is, in a line; defaults to the brief's first line. */
  title?: string
  /** What the work is; written to `<worktree>/.que/brief.md`. */
  brief?: string
  /** Defaults to origin/<default branch> when that ref exists, else <default branch>. */
  baseRef?: string
  /** Defaults to the workspace name. */
  branch?: string
}

export interface WorkspaceStartParams {
  id: string
  cols?: number
  rows?: number
}

export interface WorkspaceStartResult {
  /** The workspace terminal claude is typed into (its first, or the one opened when there was none). */
  terminal: TermInfo
}

export interface WorkspaceRenameParams {
  id: string
  title: string
  /** A new branch name; only for a branch never pushed to origin. The folder keeps its name. */
  branch?: string
}

export interface WorkspaceListParams {
  projectId?: string
}

export interface WorkspaceRemoveParams {
  id: string
  /** Delete the branch the worktree had checked out, after the worktree. */
  deleteBranch: boolean
}

export interface WorkspaceOpenTerminalParams {
  id: string
  cols: number
  rows: number
}

/** One file a workspace changed against its base, committed or not. */
export interface DiffFile {
  path: string
  /** For a rename, where it came from. */
  from: string | null
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'
  additions: number
  deletions: number
  /** True while still uncommitted in the worktree. */
  dirty: boolean
  /** The unified patch against the base, or null when binary or too large. */
  patch: string | null
  /**
   * True when the file changed lines and every changed line is a comment line (see DiffLine's
   * `comment`); false for a file that was not classified.
   */
  commentOnly: boolean
  /** additions split into code and comment lines; a file not classified counts as all code. */
  codeAdditions: number
  commentAdditions: number
  /** deletions split the same way. */
  codeDeletions: number
  commentDeletions: number
}

/** What a piece of source text is, for colouring; the daemon maps the highlighter's scopes to these. */
export type TokenKind =
  | 'decl'
  | 'ctrl'
  | 'fn'
  | 'type'
  | 'str'
  | 'num'
  | 'var'
  | 'prop'
  | 'punct'
  | 'comment'
  | 'plain'

/** A run of one line's text with one kind. */
export interface DiffToken {
  text: string
  kind: TokenKind
  /** Nesting depth of a bracket ()[]{} outside strings and comments, 0 = outermost; absent on other tokens. */
  depth?: number
  /** True on the part of a changed line that differs from its paired line (word-level). */
  mark?: true
}

/** One line of a hunk; its tokens' texts joined are the line's text, without the newline. */
export interface DiffLine {
  kind: 'context' | 'added' | 'removed'
  /** Line number in the old file, null on an added line. */
  old: number | null
  /** Line number in the new file, null on a removed line. */
  new: number | null
  tokens: DiffToken[]
  /**
   * On an added or removed line whose visible tokens are all comments (a blank one inside a run of
   * comment lines too); absent on code, on context lines, and on files tokenized plain.
   */
  comment?: true
}

/** A line's text: its tokens' texts joined. */
export function lineText(tokens: readonly DiffToken[]): string {
  return tokens.map((t) => t.text).join('')
}

export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** git's function context after the @@, '' when none. */
  label: string
  lines: DiffLine[]
}

export interface WorkspaceDiffFileParams {
  id: string
  /** The file's path (its new path for a rename), relative to the worktree. */
  path: string
  /** Same meaning as workspace.diff's. */
  base?: string
  head?: string
  commit?: string
  /** 'ignore' compares ignoring whitespace (`git diff -w`); default 'show'. */
  whitespace?: 'show' | 'ignore'
}

/** One file's diff as lines of tokens, in the same scopes as workspace.diff. */
export interface WorkspaceDiffFile {
  workspaceId: string
  path: string
  from: string | null
  status: DiffFile['status']
  base: string
  head: string
  commit: string | null
  whitespace: 'show' | 'ignore'
  /** True when hunks carry the whole file as context, so every unchanged line is present. */
  fullContext: boolean
  /** The highlighter language used, null when none matched (tokens are then 'plain'). */
  language: string | null
  /** Why there are no hunks: binary, or over the size cap; null otherwise. */
  skipped: 'binary' | 'too-large' | null
  additions: number
  deletions: number
  hunks: DiffHunk[]
}

/** One commit on the branch ahead of its base. */
export interface DiffCommit {
  sha: string
  /** The first seven characters of `sha`. */
  shortSha: string
  subject: string
  author: string
  /** ISO time of the commit. */
  at: string
}

export interface WorkspaceDiff {
  workspaceId: string
  /** The ref the branch is compared against: the caller's `base`, else origin/<default> when it exists. */
  base: string
  /** The branch compared: the caller's `head`, else the workspace's branch (with its working tree). */
  head: string
  commitsAhead: number
  /** The commits in `base..head`, newest first, at most 200. */
  commits: DiffCommit[]
  /** Refs worth comparing against: `base` first, then the default branch here and on origin, then the other branches, at most 50. */
  bases: string[]
  /** The sha the files are narrowed to (that commit's own changes), or null for the whole branch and the working tree. */
  commit: string | null
  files: DiffFile[]
  /**
   * The `base` the caller asked for when it was not a commit (a branch since deleted, say). Then
   * `base` is the default comparison and the diff is against that; null when the requested base
   * was used or none was requested.
   */
  rejectedBase: string | null
  generatedAt: string
}

/** Every tracked and untracked file of a worktree, never the ignored ones. */
export interface WorkspaceFiles {
  workspaceId: string
  /** Relative paths, deduplicated and sorted; at most 20,000. */
  files: string[]
  /** True when the listing was cut at the cap. */
  truncated: boolean
  generatedAt: string
}

/** One file of a worktree, read for the file view. */
export interface WorkspaceFile {
  workspaceId: string
  path: string
  /** The text, or null for a binary file. */
  content: string | null
  /** A NUL byte in the first 8 KB marks a file binary. */
  binary: boolean
  /** Bytes on disk. */
  size: number
  /** True when `content` was cut at MAX_FILE_CHARS (500,000). */
  truncated: boolean
}

/**
 * A hook from `que hook`: from a workspace's session, or from a session in a
 * loose terminal, which names only its terminal. The daemon feeds a loose
 * terminal's hooks to the live-session record alone, never to a workspace.
 */
export type HookEventParams =
  | {
      workspaceId: string
      /** The daemon terminal the hook fired in (QUE_TERMINAL_ID), when it fired in one. */
      terminalId?: string
      /** The hook JSON Claude Code wrote to the hook's stdin. */
      payload: HookEvent
    }
  | {
      workspaceId?: undefined
      /** The loose terminal the hook fired in (QUE_TERMINAL_ID). */
      terminalId: string
      payload: HookEvent
    }

export interface TicketsStartParams {
  key: string
  /** The que project to make the workspace in; omitted means use the learned mapping. */
  projectId?: string
  /** A loose terminal with the brief instead of a workspace. */
  session?: boolean
}

export type TicketsStartResult =
  | { kind: 'workspace'; workspace: Workspace }
  | { kind: 'session'; terminal: TermInfo }
  /** que could not tell which project; the app offers these. */
  | { kind: 'needs_project'; projects: Project[] }

export interface TicketsListResult {
  tickets: Ticket[]
  sync: TicketsSyncState
}

export interface ReportParams {
  /** ISO time; defaults to 24 hours ago. */
  since?: string
}

/** What one workspace (an interactive session in its worktree) did in the window. */
export interface WorkspaceDigest {
  id: string
  name: string
  project: string
  branch: string
  status: WorkspaceStatus
  statusReason: string | null
  /** The first and last status change in the window; null when nothing happened. */
  firstActivityAt: string | null
  lastActivityAt: string | null
  /** Time spent in `working` within the window. */
  workingMs: number
  /** How many times it asked for input in the window. */
  needsInputCount: number
  /** Since when it has been waiting, if it is waiting now. */
  waitingSince: string | null
  stuckCount: number
  /** Commits on its branch past the base; null when git could not say. */
  commitsAhead: number | null
  pr: PullRequest | null
  sessionId: string | null
}

export interface Report {
  since: string
  generatedAt: string
  /** Workspaces with activity in the window, those needing attention first. */
  workspaces: WorkspaceDigest[]
  totals: {
    workspaces: number
    needsInput: number
  }
}

export interface QuietUnlockParams {
  /** Defaults to quiet_hours.unlock_minutes. */
  minutes?: number
  /** Why, for the unlock log. */
  why?: string
}

export interface QuietStartParams {
  /** How long the manual quiet lasts; default 60, at most 720. */
  minutes?: number
}

export interface QuietLogParams {
  /** ISO time; defaults to everything. */
  since?: string
}

export interface ConfigGetResult {
  /** The config file (QUE_CONFIG or ~/.config/que/config.toml). */
  path: string
  config: UserConfig
}

export interface ConfigSetParams {
  /** Merged into the file; `null` clears a setting. */
  patch: ConfigPatch
  /** Let a change that shortens or removes tonight's window apply now. */
  applyTonight?: boolean
}

/** The instructions file (instructions_file) appended to every session's system prompt. */
export interface InstructionsGetResult {
  /** The configured path, absolute; absent when instructions_file is unset. */
  path?: string
  exists: boolean
  /** The file's text; '' when it does not exist. */
  content: string
}

export interface InstructionsSetParams {
  content: string
}

/** Maps each method name to its params and result types. */
export interface Methods {
  'daemon.ping': { params: Record<string, never> | undefined; result: PingResult }
  'daemon.shutdown': { params: Record<string, never> | undefined; result: Ok }
  /** Hands every live terminal to a new daemon process, which then serves the socket; this one exits. */
  'daemon.handoff': { params: HandoffParams | undefined; result: HandoffResult }
  'term.create': { params: TermCreateParams; result: TermInfo }
  'term.list': { params: TermListParams | undefined; result: TermInfo[] }
  'term.attach': { params: TermAttachParams; result: TermAttachResult }
  'term.detach': { params: TermIdParams; result: Ok }
  'term.write': { params: TermWriteParams; result: Ok }
  'term.resize': { params: TermResizeParams; result: Ok }
  'term.kill': { params: TermIdParams; result: Ok }
  'term.snapshot': { params: TermIdParams; result: TermSnapshotResult }
  'project.add': { params: ProjectAddParams; result: Project }
  'project.list': { params: Record<string, never> | undefined; result: Project[] }
  'project.remove': { params: ProjectRemoveParams; result: Ok }
  'workspace.create': { params: WorkspaceCreateParams; result: Workspace }
  'workspace.list': { params: WorkspaceListParams | undefined; result: Workspace[] }
  'workspace.get': { params: { id: string }; result: Workspace }
  'workspace.remove': { params: WorkspaceRemoveParams; result: Ok }
  'workspace.openTerminal': { params: WorkspaceOpenTerminalParams; result: TermInfo }
  /** Types `claude '<start_prompt>'` into the workspace's first terminal once setup is done. */
  'workspace.start': { params: WorkspaceStartParams; result: WorkspaceStartResult }
  /** Sets the title (and, when allowed and asked, renames the branch); emits workspace.updated. */
  'workspace.rename': { params: WorkspaceRenameParams; result: Workspace }
  /** Whether workspace.rename may rename the branch: it has no `origin/<branch>`. */
  'workspace.canRenameBranch': { params: { id: string }; result: { allowed: boolean } }
  /** The app had it selected in a focused window: sets seenAt; emits workspace.updated. */
  'workspace.seen': { params: { id: string }; result: Workspace }
  /**
   * What the workspace changed against its base: committed and uncommitted, file by file. With
   * `head`, what that branch changed against its base instead (committed only).
   */
  'workspace.diff': {
    params: { id: string; base?: string; head?: string; commit?: string }
    result: WorkspaceDiff
  }
  /**
   * One file of workspace.diff's scope as hunks of tokenized lines: syntax kinds from the whole
   * old and new files, bracket depth, word marks; whole-file context when it fits.
   */
  'workspace.diffFile': { params: WorkspaceDiffFileParams; result: WorkspaceDiffFile }
  /**
   * A pull request's conversation (comments, reviews, line comments): the workspace's pull
   * request `number`; null when it has no such pull request.
   */
  'workspace.prThread': {
    params: { id: string; number: number; refresh?: boolean }
    result: PrThread | null
  }
  /**
   * Checks the workspace's pull requests with GitHub now, as the tracker's poll does; stores and
   * announces what changed (workspace.updated) and resolves with the workspace.
   */
  'workspace.checkPrs': { params: { id: string }; result: Workspace }
  'workspace.files': { params: { id: string }; result: WorkspaceFiles }
  'workspace.readFile': { params: { id: string; path: string }; result: WorkspaceFile }
  /**
   * Watch this workspace's worktree for this connection (`workspace.changed`).
   * The daemon watches exactly what clients ask for here, whatever terminals
   * they attach to; a connection's watches end with `workspace.unwatch` or when
   * it closes.
   */
  'workspace.watch': { params: { id: string }; result: Ok }
  'workspace.unwatch': { params: { id: string }; result: Ok }
  'hook.event': { params: HookEventParams; result: Ok }
  'report.get': { params: ReportParams | undefined; result: Report }
  'quiet.state': { params: Record<string, never> | undefined; result: QuietState }
  'quiet.unlock': { params: QuietUnlockParams | undefined; result: QuietState }
  'quiet.lock': { params: Record<string, never> | undefined; result: QuietState }
  'quiet.start': { params: QuietStartParams | undefined; result: QuietState }
  'quiet.end': { params: Record<string, never> | undefined; result: QuietState }
  'quiet.log': { params: QuietLogParams | undefined; result: QuietUnlock[] }
  /** From `que statusline`: a Claude plan usage reading; one older than the newest is ignored. */
  'usage.report': { params: Usage; result: Ok }
  /** The newest reading, without windows that have reset; null when none is left. */
  'usage.get': { params: Record<string, never> | undefined; result: Usage | null }
  'config.get': { params: Record<string, never> | undefined; result: ConfigGetResult }
  'config.set': { params: ConfigSetParams; result: ConfigGetResult }
  'instructions.get': { params: Record<string, never> | undefined; result: InstructionsGetResult }
  /** Writes the instructions file; `not_configured` when instructions_file is unset. */
  'instructions.set': { params: InstructionsSetParams; result: InstructionsGetResult }
  'tickets.list': { params: Record<string, never> | undefined; result: TicketsListResult }
  'tickets.sync': { params: Record<string, never> | undefined; result: TicketsListResult }
  'tickets.start': { params: TicketsStartParams; result: TicketsStartResult }
  'tickets.projectFor': { params: { key: string }; result: { projectId: string | null } }
}

export type MethodName = keyof Methods

export type ParamsOf<M extends MethodName> = Methods[M]['params']

export type ResultOf<M extends MethodName> = Methods[M]['result']

/**
 * The one runtime list of methods, in the order of `Methods`; the mapped type
 * makes a missing or extra entry a compile error.
 *
 * - `renderer`: the app's window may call it (Electron main enforces this). False for
 *   the calls only the daemon's own tooling makes: ping, shutdown, handoff, and hook events.
 * - `quiet`: refused with `quiet_hours` while quiet hours are on and not unlocked:
 *   every way to see a terminal, its output, or a report, or to start new work.
 *
 * The decoders for the params are the sibling table in `methods.decode.ts`, keyed the same way.
 */
export const METHODS: {
  [M in MethodName]: {
    renderer: boolean
    quiet: boolean
  }
} = {
  'daemon.ping': { renderer: false, quiet: false },
  'daemon.shutdown': {
    renderer: false,
    quiet: false
  },
  'daemon.handoff': { renderer: false, quiet: false },
  'term.create': { renderer: true, quiet: true },
  'term.list': { renderer: true, quiet: false },
  'term.attach': { renderer: true, quiet: true },
  'term.detach': { renderer: true, quiet: false },
  'term.write': { renderer: true, quiet: false },
  'term.resize': { renderer: true, quiet: false },
  'term.kill': { renderer: true, quiet: false },
  'term.snapshot': { renderer: true, quiet: true },
  'project.add': { renderer: true, quiet: false },
  'project.list': { renderer: true, quiet: false },
  'project.remove': { renderer: true, quiet: false },
  'workspace.create': {
    renderer: true,
    quiet: false
  },
  'workspace.list': { renderer: true, quiet: false },
  'workspace.get': { renderer: true, quiet: false },
  'workspace.remove': {
    renderer: true,
    quiet: false
  },
  'workspace.openTerminal': {
    renderer: true,
    quiet: true
  },
  'workspace.start': { renderer: true, quiet: true },
  'workspace.rename': {
    renderer: true,
    quiet: false
  },
  'workspace.canRenameBranch': {
    renderer: true,
    quiet: false
  },
  'workspace.seen': { renderer: true, quiet: false },
  'workspace.diff': { renderer: true, quiet: true },
  'workspace.diffFile': { renderer: true, quiet: true },
  'workspace.prThread': {
    renderer: true,
    quiet: true
  },
  'workspace.checkPrs': { renderer: true, quiet: true },
  'workspace.files': { renderer: true, quiet: true },
  'workspace.readFile': {
    renderer: true,
    quiet: true
  },
  'workspace.watch': {
    renderer: true,
    quiet: false
  },
  'workspace.unwatch': {
    renderer: true,
    quiet: false
  },
  'hook.event': { renderer: false, quiet: false },
  'report.get': { renderer: true, quiet: true },
  'quiet.state': { renderer: true, quiet: false },
  'quiet.unlock': { renderer: true, quiet: false },
  'quiet.lock': { renderer: true, quiet: false },
  'quiet.start': { renderer: true, quiet: false },
  'quiet.end': { renderer: true, quiet: false },
  'quiet.log': { renderer: true, quiet: false },
  'usage.report': { renderer: false, quiet: false },
  'usage.get': { renderer: true, quiet: false },
  'config.get': { renderer: true, quiet: false },
  'config.set': { renderer: true, quiet: false },
  'instructions.get': {
    renderer: true,
    quiet: false
  },
  'instructions.set': {
    renderer: true,
    quiet: false
  },
  'tickets.list': { renderer: true, quiet: false },
  'tickets.sync': { renderer: true, quiet: false },
  'tickets.start': { renderer: true, quiet: true },
  'tickets.projectFor': {
    renderer: true,
    quiet: false
  }
}

const METHOD_NAMES = Object.keys(METHODS) as MethodName[]

/** Methods refused with `quiet_hours` while quiet hours are on and not unlocked. */
export const QUIET_REFUSED_METHODS: readonly MethodName[] = METHOD_NAMES.filter(
  (m) => METHODS[m].quiet
)

/** Methods the app's window may call. */
export const RENDERER_METHODS: ReadonlySet<MethodName> = new Set(
  METHOD_NAMES.filter((m) => METHODS[m].renderer)
)

// ---- event types ----------------------------------------------------------

export interface Events {
  'term.data': { id: string; data: string }
  'term.exit': { id: string; exitCode: number; signal?: number }
  'term.created': TermInfo
  'term.killed': { id: string }
  /** Its title or foreground program changed. */
  'term.updated': TermInfo
  'workspace.created': Workspace
  /** The row after any commit: status, reason, activity, session, title, branch, pull request. */
  'workspace.updated': Workspace
  /** Gone from the list; `failed` lists the removal steps that went wrong, when any did. */
  'workspace.removed': { id: string; failed?: RemovalFailure[] }
  /** Its worktree changed on disk (a write, a commit): the daemon computes nothing until asked. */
  'workspace.changed': { id: string }
  /**
   * workspace.diff's comment split, worked out in the background for this workspace, settled
   * with something new: asking for its diff again gives it.
   */
  'workspace.diffSettled': { id: string }
  'project.added': Project
  'project.removed': { id: string }
  'quiet.changed': QuietState
  /**
   * Once, when a quiet window ends and notifications.morning_summary is on: a
   * scheduled one at its end, a manual one at its end or at quiet.end.
   */
  'quiet.morningSummary': { kind: QuietKind; report: Report }
  'config.changed': ConfigGetResult
  /** The newest plan usage reading changed: a new one, or a window reset; null when none is left. */
  'usage.changed': Usage | null
  /** After every ticket sync, and when a ticket's workspace changes. */
  'tickets.synced': TicketsListResult
}

export type EventName = keyof Events

/**
 * The one runtime list of events, in the order of `Events`.
 *
 * - `renderer`: Electron main forwards it to the app's window. False for events main
 *   handles itself.
 */
export const EVENTS: { [E in EventName]: { renderer: boolean } } = {
  'term.data': { renderer: true },
  'term.exit': { renderer: true },
  'term.created': { renderer: true },
  'term.killed': { renderer: true },
  'term.updated': { renderer: true },
  'workspace.created': { renderer: true },
  'workspace.updated': { renderer: true },
  'workspace.removed': { renderer: true },
  'workspace.changed': { renderer: true },
  'workspace.diffSettled': { renderer: true },
  'project.added': { renderer: true },
  'project.removed': { renderer: true },
  'quiet.changed': { renderer: true },
  'quiet.morningSummary': { renderer: false },
  'config.changed': { renderer: true },
  'usage.changed': { renderer: true },
  'tickets.synced': { renderer: true }
}

/** Events forwarded to the app's window. */
export const RENDERER_EVENTS: readonly EventName[] = (Object.keys(EVENTS) as EventName[]).filter(
  (e) => EVENTS[e].renderer
)

// ---- envelopes ------------------------------------------------------------

export interface Request {
  id: number
  method: string
  params?: Record<string, unknown>
}

export interface ResponseError {
  code: string
  message: string
}

export type Response = { id: number; result: unknown } | { id: number; error: ResponseError }

export interface EventMessage {
  event: string
  data: Record<string, unknown>
}

export type ServerMessage = Response | EventMessage

export const ErrorCodes = {
  BadRequest: 'bad_request',
  UnknownMethod: 'unknown_method',
  NotFound: 'not_found',
  Conflict: 'conflict',
  Internal: 'internal',
  QuietHours: 'quiet_hours',
  /** The method needs a config key that is not set (instructions.set without instructions_file). */
  NotConfigured: 'not_configured'
} as const

// ---- framing --------------------------------------------------------------

export function encode(msg: unknown): string {
  return `${JSON.stringify(msg)}\n`
}

/**
 * Splits a byte stream into complete, non-blank lines. Feed it chunks in
 * arrival order; a partial trailing line is kept until its newline arrives.
 * Each chunk is scanned once, so a long line in many chunks costs linear time.
 */
export class LineSplitter {
  /** The pieces of the line in progress, joined when its newline arrives. */
  private pieces: string[] = []

  push(chunk: string): string[] {
    const out: string[] = []
    let start = 0

    for (let nl = chunk.indexOf('\n'); nl !== -1; nl = chunk.indexOf('\n', start)) {
      this.pieces.push(chunk.slice(start, nl))
      this.take(out)
      start = nl + 1
    }

    if (start < chunk.length) this.pieces.push(chunk.slice(start))

    return out
  }

  /** The last line if it never got its newline (call at end of stream). */
  flush(): string[] {
    const out: string[] = []
    this.take(out)

    return out
  }

  private take(out: string[]): void {
    const line = this.pieces.length === 1 ? this.pieces[0] : this.pieces.join('')
    this.pieces = []

    if (line.trim().length > 0) out.push(line)
  }
}

/** Decodes buffered chunks into parsed JSON messages; bad lines go to onError. */
export class MessageDecoder<T = unknown> {
  private lines = new LineSplitter()
  private decoder = new TextDecoder('utf-8')

  constructor(private onError?: (line: string, err: unknown) => void) {}

  push(chunk: string | Uint8Array): T[] {
    const text = typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true })

    return this.parse(this.lines.push(text))
  }

  /** Decodes a last line that never got its newline (call at end of stream). */
  flush(): T[] {
    return this.parse(this.lines.flush())
  }

  private parse(lines: string[]): T[] {
    const out: T[] = []

    for (const line of lines) {
      try {
        out.push(JSON.parse(line) as T)
      } catch (err) {
        this.onError?.(line, err)
      }
    }

    return out
  }
}

export function isEvent(msg: ServerMessage): msg is EventMessage {
  return typeof (msg as EventMessage).event === 'string'
}

// ---- Claude Code payloads -------------------------------------------------
// Shapes que receives from Claude Code: the hook JSON on stdin.

export const HOOK_EVENT_NAMES = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'StopFailure',
  'Notification',
  'PermissionRequest',
  'PreCompact',
  'SubagentStart',
  'SubagentStop'
] as const

export type HookEventName = (typeof HOOK_EVENT_NAMES)[number]

/** One entry of a Stop or SubagentStop hook's `background_tasks`. */
export interface HookBackgroundTask {
  id: string
  type: string
  status: string
  description?: string
  /** shell tasks */
  command?: string
  /** subagent tasks */
  agent_type?: string
}

export interface HookEvent {
  hook_event_name: HookEventName
  session_id: string
  cwd: string
  transcript_path: string
  permission_mode?: string
  /** Set when the event comes from a subagent rather than the main session. */
  agent_id?: string
  agent_type?: string
  /** SessionStart */
  source?: 'startup' | 'resume' | 'clear' | 'compact'
  /** UserPromptSubmit */
  prompt?: string
  prompt_id?: string
  /** PreToolUse / PostToolUse */
  tool_name?: string
  tool_input?: Record<string, unknown>
  tool_response?: unknown
  tool_use_id?: string
  /** Notification */
  notification_type?: string
  message?: string
  title?: string
  /** Stop */
  last_assistant_message?: string
  stop_hook_active?: boolean
  /** Stop, SubagentStop: the parent session's in-flight background tasks; absent when the CLI reports none. */
  background_tasks?: HookBackgroundTask[]
  /** StopFailure */
  error?: string
  error_details?: string
  /** SessionEnd */
  reason?: string
}
