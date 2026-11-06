import fs from 'node:fs'
import net from 'node:net'
import { dirname, join } from 'node:path'
import {
  ErrorCodes,
  MessageDecoder,
  encode,
  type EventName,
  type Events,
  METHODS,
  type MethodName,
  type Methods,
  type ParamsOf,
  type ResultOf,
  type Request,
  type ResponseError
} from '../shared/protocol'
import {
  configPath,
  defaultConfig,
  formatConfigErrors,
  loadConfig,
  loadRepoConfig,
  mergeConfigPatch,
  parseConfig,
  patchToToml,
  readRawConfig,
  stringifyConfig,
  type UserConfig
} from '../shared/config'
import { decoders, ParamsError } from '../shared/methods.decode'
import { ensureDirs, quePaths, type QuePaths } from '../shared/paths'
import { sessionLabel } from '../shared/session-label'
import type {
  ConfigGetResult,
  HandoffParams,
  HandoffResult,
  InstructionsGetResult,
  TermCreateParams,
  TermInfo,
  WorkspaceStartResult
} from '../shared/protocol'
import type { ConfigPatch, Workspace } from '../shared/types'
import { EventBus } from './bus'
import { RpcError } from './errors'
import type { HostedTerminal, PtyHost, Term, TermExtra } from './pty-host'
import { QuietService } from './quiet'
import { UsageService } from './usage'
import { gatherReport } from './gather-report'
import { PrService } from './prs'
import { LiveSessions, storedLiveSessions } from './live-sessions'
import { echoOffProbe, SHELL_WAIT_MS, waitForShell } from './shell-ready'
import { StatusService } from './status'
import { TicketService } from './tickets'
import { Store } from './store'
import { CommentClassifier } from './comment-split'
import { workspaceDiffFile } from './diff-file'
import { workspaceDiff } from './workspace-diff'
import { Tokenizer } from './tokenizer'
import { tokenizerWorkerFrom } from '../shared/packaged'
import { readWorkspaceFile, workspaceFiles } from './files'
import {
  sessionEnv,
  terminalEnv,
  WorkspaceManager,
  workspaceTerminalEnv,
  type WorkspaceTerminalEnv
} from './workspaces'
import { WorktreeWatcher } from './watcher'
import { defaultCliScript, installWrapper, resolveCliRunner, startCommand } from './wrapper'
import { errorCode, errorMessage } from '../shared/errors.decode'

export interface ServerOptions {
  host: PtyHost
  version: string
  /** The build id of the bundle this daemon runs (shared/build-id.ts). Default ''. */
  buildId?: string
  startedAt?: string
  log?: (msg: string) => void
  /** Called after the daemon.shutdown response has been flushed. */
  onShutdown?: () => void
  /**
   * Runs daemon.handoff (see handoff.ts); `release` stops serving everyone but
   * the caller. Without it the daemon refuses the method.
   */
  handoff?: (params: HandoffParams, release: () => Promise<void>) => Promise<HandoffResult>
  /** Called after a successful daemon.handoff response has been flushed: exit, ending nothing. */
  onHandedOff?: () => void
  /** Defaults to quePaths() at construction. */
  paths?: QuePaths
  /** The CLI bin/que runs. Defaults to the bundled out/cli/index.js. */
  cliScript?: string
  /** Status engine stall-check interval. Default 5 s. */
  statusTickMs?: number
  /** Quiet-hours re-evaluation interval. Default 15 s. */
  quietTickMs?: number
  /** The clock quiet hours read. Default Date.now. */
  now?: () => number
  /** Draws the name of a workspace created without one. Default randomWorkspaceName. */
  randomWorkspaceName?: () => string
  /** The tokenizer worker bundle. Defaults to highlight-worker.js beside the daemon bundle. */
  tokenizerWorker?: string
  /** How long tokenizing one file may take before it is answered plain. Default 5 s. */
  tokenizeTimeoutMs?: number
}

interface Subscription {
  /** Live data buffered while an attach snapshot is being taken. */
  pending: Array<{ data: string; seq: number }> | null
}

/** Work to run after a response is written (e.g. flushing buffered data). */
type AfterSend = (fn: () => void) => void

/** What a handler may need besides its params: the caller's connection and work to run after the reply is sent. */
interface HandlerContext {
  conn: Connection
  afterSend: AfterSend
}

class Connection {
  readonly subs = new Map<string, Subscription>()
  /**
   * The workspaces this connection asked to watch with workspace.watch. This
   * is the only input to worktree watching, and it goes away with the connection.
   */
  readonly watches = new Set<string>()
  private decoder: MessageDecoder<Request>

  constructor(
    readonly socket: net.Socket,
    readonly server: DaemonServer
  ) {
    this.decoder = new MessageDecoder<Request>((line) =>
      server.log(`bad frame from client: ${line.slice(0, 200)}`)
    )
    socket.setNoDelay(true)
    socket.on('data', (chunk) => {
      for (const req of this.decoder.push(chunk)) void server.dispatch(this, req)
    })
    socket.on('error', () => {
      // Clients disappear without ceremony; 'close' does the cleanup.
    })
  }

  send(msg: unknown): void {
    if (this.socket.destroyed || !this.socket.writable) return
    this.socket.write(encode(msg))
  }

  sendEvent<E extends EventName>(event: E, data: Events[E]): void {
    this.send({ event, data })
  }
}

/** How long a read of the user config trusts the last stat of its file. */
const CONFIG_RECHECK_MS = 1_000

export class DaemonServer {
  private server: net.Server | null = null
  private conns = new Set<Connection>()
  private unsubs: Array<() => void> = []
  private socketPath = ''
  private closed = false
  /** Workspace of each workspace terminal, kept past the terminal's removal. */
  private termWorkspace = new Map<string, string>()
  /** Every service reports events here; the server sends them on to the connections. */
  readonly bus = new EventBus({ log: (m) => this.log(m) })
  readonly startedAt: string
  readonly paths: QuePaths
  readonly store: Store
  readonly status: StatusService
  readonly prs: PrService
  readonly tickets: TicketService
  readonly workspaces: WorkspaceManager
  readonly quiet: QuietService
  readonly usage: UsageService
  /** Terminals (a workspace's or loose) with a live Claude session, restored after a restart. */
  readonly liveSessions: LiveSessions
  /** The last good user config, the file stamp it was read at, and when the file was last statted. */
  private config: UserConfig
  private configStamp = ''
  /** Why the file's last read failed, or null when it read cleanly. */
  private configError: string | null = null
  private configCheckedAt = Number.NEGATIVE_INFINITY
  /** Watches the worktrees of the workspaces clients asked for with workspace.watch (workspace.changed). */
  readonly watcher = new WorktreeWatcher((id) => void this.worktreeChanged(id), {
    log: (m) => this.log(m)
  })
  /** Tokenizes files for workspace.diffFile and the comment split on a worker thread, never this one. */
  private readonly tokenizer: Tokenizer
  /** Splits workspace.diff's files into code and comment lines in the background. */
  private readonly classifier: CommentClassifier

  constructor(private opts: ServerOptions) {
    this.startedAt = opts.startedAt ?? new Date().toISOString()
    this.tokenizer = new Tokenizer({
      script: opts.tokenizerWorker ?? tokenizerWorkerFrom(__dirname),
      timeoutMs: opts.tokenizeTimeoutMs,
      log: (m) => this.log(m)
    })
    this.classifier = new CommentClassifier(this.tokenizer, (id) =>
      this.bus.emit('workspace.diffSettled', { id })
    )
    const { host } = opts
    this.paths = ensureDirs(opts.paths ?? quePaths())
    this.store = new Store(this.paths.db)
    this.config = defaultConfig({ queHome: this.paths.home })
    const { emit } = this.bus
    this.bus.onAny((event, data) => {
      for (const c of this.conns) c.sendEvent(event, data)
    })
    this.bus.on('workspace.removed', () => this.syncWatches())
    this.status = new StatusService({
      store: this.store,
      emit,
      config: () => this.configOrDefault(),
      log: (m) => this.log(m),
      tickMs: opts.statusTickMs
    })
    this.workspaces = new WorkspaceManager({
      store: this.store,
      paths: this.paths,
      status: this.status,
      emit,
      killTerminals: (id) => this.killWorkspaceTerminals(id),
      startClaude: (id) => void this.startWorkspace(id),
      log: (m) => this.log(m),
      randomName: opts.randomWorkspaceName,
      config: () => this.strictConfig()
    })
    this.prs = new PrService({
      store: this.store,
      workspaces: this.workspaces,
      bus: this.bus,
      config: () => this.configOrDefault(),
      log: (m) => this.log(m)
    })
    this.tickets = new TicketService({
      store: this.store,
      config: () => this.configOrDefault(),
      emit,
      log: (m) => this.log(m),
      home: this.paths.home,
      projects: () => this.workspaces.listProjects(),
      createWorkspace: (p) => this.workspaces.create(p),
      openTerminal: async (workspaceId) => this.openWorkspaceTerminal(workspaceId, 120, 30),
      createSession: async (cwd) => this.openLooseTerminal({ cwd, cols: 120, rows: 30 }).info(),
      typeCommand: (id, command) => void this.typeAtPrompt(id, command, 'ticket'),
      learnProject: async (projectKey, projectName) => {
        this.setConfig({ jira: { projects: { [projectKey]: projectName } } }, false)
      }
    })
    this.quiet = new QuietService({
      store: this.store,
      emit,
      config: () => this.configOrDefault(),
      detachAll: () => {
        for (const c of this.conns) c.subs.clear()
      },
      report: (since) => this.report(since),
      log: (m) => this.log(m),
      now: opts.now,
      tickMs: opts.quietTickMs
    })
    this.usage = new UsageService({
      file: this.paths.usageJson,
      emit,
      log: (m) => this.log(m)
    })

    // Terminals taken over from a predecessor daemon keep their workspace.
    for (const t of host.list())
      if (t.alive && t.workspaceId) this.termWorkspace.set(t.id, t.workspaceId)
    this.liveSessions = new LiveSessions({
      ...storedLiveSessions(this.store),
      locked: () => this.quiet.locked(),
      workspace: (id) => this.store.getWorkspace(id),
      folderExists: (path) => fs.statSync(path, { throwIfNoEntry: false })?.isDirectory() === true,
      // A loose terminal has no workspace, so one with none matches only a loose terminal.
      ownsTerminal: (termId, wsId) => {
        const t = host.get(termId)

        return t !== undefined && t.alive && t.workspaceId === wsId
      },
      onLive: (termId) => this.labelFromTerminal(termId),
      resume: (entry) => {
        const command = startCommand({ resumeSessionId: entry.sessionId })

        if (entry.workspaceId === undefined) {
          // A loose terminal has no setup to wait for, only its shell.
          const t = this.openLooseTerminal({ cwd: entry.cwd, cols: 120, rows: 30 })
          void this.typeAtPrompt(t.id, command, 'loose session')

          return t.id
        }

        const t = this.openWorkspaceTerminal(entry.workspaceId, 120, 30)
        this.typeAfterSetup(entry.workspaceId, t.id, command)

        return t.id
      },
      log: (m) => this.log(m)
    })
    this.bus.on('quiet.changed', (q) => {
      if (!q.locked) this.liveSessions.unlocked()
    })
    this.unsubs.push(
      host.onData((id, data, seq) => {
        for (const c of this.conns) {
          const sub = c.subs.get(id)

          if (!sub) continue

          if (sub.pending) sub.pending.push({ data, seq })
          else c.sendEvent('term.data', { id, data, seq })
        }
      }),
      host.onUpdate((info) => {
        this.bus.emit('term.updated', info)
        this.labelFromTerminal(info.id)
      }),
      host.onExit((id, info) => {
        this.log(`term ${id} exited code=${info.exitCode} signal=${info.signal ?? ''}`)
        this.bus.emit('term.exit', { id, exitCode: info.exitCode, signal: info.signal })
        this.liveSessions.terminalGone(id)
        const wsId = this.termWorkspace.get(id)

        if (wsId) {
          this.termWorkspace.delete(id)
          const live = host.list().some((t) => t.alive && t.workspaceId === wsId)

          if (!live) this.status.apply(wsId, { kind: 'terminal_exit' })
        }
      })
    )
  }

  /**
   * The user config, re-read when the file changes. The file is statted at most
   * once a second (hooks, stream messages and every tick read the config), so a
   * hand edit is seen within a second; config.set rereads at once. An invalid
   * file keeps the last good config.
   */
  private configOrDefault(): UserConfig {
    return this.readConfig().config
  }

  /** The config and the error of the file as last read (null when it read). `fresh` skips the once-a-second throttle. */
  private readConfig(fresh = false): { config: UserConfig; error: string | null } {
    const now = performance.now()

    if (!fresh && now - this.configCheckedAt < CONFIG_RECHECK_MS) {
      return { config: this.config, error: this.configError }
    }

    this.configCheckedAt = now
    const path = configPath()
    let stamp = `${path}:missing`

    try {
      const st = fs.statSync(path)
      stamp = `${path}:${st.mtimeMs}:${st.size}`
    } catch {
      // No file: the defaults.
    }

    if (stamp !== this.configStamp) {
      this.configStamp = stamp
      const r = loadConfig({ queHome: this.paths.home }, path)

      if (r.ok) {
        this.config = r.config
        this.configError = null
      } else {
        this.configError = formatConfigErrors(r.errors)
        this.log(`config ${path} is invalid; keeping the last good one: ${this.configError}`)
      }
    }

    return { config: this.config, error: this.configError }
  }

  /**
   * The config for creating a project or workspace, which refuses a file that
   * does not read rather than carry on with the last good one. The file is
   * checked now, so a fix is seen at once.
   */
  private strictConfig(): UserConfig {
    const { config, error } = this.readConfig(true)

    if (error !== null) throw new RpcError(ErrorCodes.BadRequest, `invalid que config: ${error}`)

    return config
  }

  private getConfig(): ConfigGetResult {
    return { path: configPath(), config: this.configOrDefault() }
  }

  /** Merges a patch into the config file, validates, writes, and reloads it. */
  private setConfig(patch: ConfigPatch, applyTonight: boolean): ConfigGetResult {
    const path = configPath()
    const raw = readRawConfig(path)

    if (!raw.ok) {
      throw new RpcError(ErrorCodes.BadRequest, `${path}: ${formatConfigErrors(raw.errors)}`)
    }

    let changes: Record<string, unknown>

    try {
      changes = patchToToml(patch)
    } catch (err) {
      throw new RpcError(ErrorCodes.BadRequest, errorMessage(err))
    }

    const merged = mergeConfigPatch(raw.config, changes)
    // smol-toml writes the table back without the file's comments.
    const text = stringifyConfig(merged)
    const parsed = parseConfig(text, { queHome: this.paths.home })

    if (!parsed.ok) {
      throw new RpcError(
        ErrorCodes.BadRequest,
        `invalid config: ${formatConfigErrors(parsed.errors)}`
      )
    }

    fs.mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    fs.writeFileSync(tmp, text.endsWith('\n') ? text : `${text}\n`)
    fs.renameSync(tmp, path)
    this.configStamp = ''
    this.readConfig(true)
    this.log(`config ${path} updated${applyTonight ? ' (apply tonight)' : ''}`)
    this.quiet.configChanged(applyTonight)
    const result = this.getConfig()
    this.bus.emit('config.changed', result)

    return result
  }

  /** The sessions report (report.get and the quiet summaries). */
  private report(since?: string): ReturnType<typeof gatherReport> {
    return gatherReport({ store: this.store, workspaces: this.workspaces }, since)
  }

  private createTerminal(params: TermCreateParams, extra?: TermExtra): HostedTerminal {
    const t = this.opts.host.create(params, extra)

    if (extra?.workspaceId) this.termWorkspace.set(t.id, extra.workspaceId)
    this.log(`term ${t.id} created pid=${t.pid} cwd=${t.cwd}`)
    this.bus.emit('term.created', t.info())

    return t
  }

  /**
   * A loose terminal (no workspace): the hooks wrapper first on PATH, so a claude
   * started there reports its session to the live-session record alone.
   */
  private openLooseTerminal(params: TermCreateParams): HostedTerminal {
    return this.createTerminal(params, { env: terminalEnv(this.paths, this.socketPath) })
  }

  /** A shell in the workspace's worktree, carrying its que environment. */
  private openWorkspaceTerminal(id: string, cols: number, rows: number): TermInfo {
    const ws = this.workspaces.get(id)

    const t = this.createTerminal(
      { cwd: ws.path, cols, rows, name: ws.name },
      { workspaceId: ws.id, env: this.terminalEnv(ws) }
    )

    return t.info()
  }

  private requireTerm(id: string): Term {
    const t = this.opts.host.get(id)

    if (!t) throw new RpcError(ErrorCodes.NotFound, `no terminal ${id}`)

    return t
  }

  /**
   * Starts claude on the brief (or the configured start prompt), or a bare claude with no brief, in the workspace's
   * first terminal (opened when it has none). Answers with the terminal at once; the command is typed once setup has ended and the shell can take it.
   */
  private startWorkspace(id: string, cols = 120, rows = 30): WorkspaceStartResult {
    const ws = this.workspaces.get(id)

    const first =
      this.opts.host.list().find((t) => t.alive && t.workspaceId === ws.id) ??
      this.createTerminal(
        { cwd: ws.path, cols, rows, name: ws.name },
        { workspaceId: ws.id, env: this.terminalEnv(ws) }
      )

    const command = startCommand({
      startPrompt: this.configOrDefault().startPrompt,
      briefFile: ws.brief ? join(ws.path, '.que', 'brief.md') : null
    })

    this.typeAfterSetup(ws.id, first.id, command)

    return { terminal: first.info() }
  }

  /** Types a command into a workspace terminal once the workspace's setup has ended and its shell can take it. */
  private typeAfterSetup(wsId: string, termId: string, command: string): void {
    void this.status
      .setupDone(wsId)
      .then(() => this.typeAtPrompt(termId, command, `workspace ${wsId}`))
  }

  /**
   * Types a command that starts claude once the terminal's shell can take it (see shell-ready.ts),
   * or anyway when the wait runs out. `whose` names the terminal in the log.
   */
  private async typeAtPrompt(termId: string, command: string, whose: string): Promise<void> {
    const t = this.opts.host.get(termId)

    const wait =
      t &&
      (await waitForShell({
        probe: echoOffProbe(t.pid),
        stopped: () => this.closed || !t.alive
      }))

    // Shutdown ends the waits too; nothing is typed into a terminal that is being torn down.
    if (this.closed) return

    if (!t?.alive) {
      this.log(`${whose}: terminal ${termId} is gone; claude not started`)

      return
    }

    if (wait === 'timeout') {
      this.log(
        `${whose}: terminal ${termId} has no line editor after ${SHELL_WAIT_MS / 1000}s; typing the command anyway`
      )
    }

    t.write(command)
  }

  private killTerminal(id: string): boolean {
    if (!this.opts.host.kill(id)) return false
    this.log(`term ${id} killed`)
    this.liveSessions.terminalGone(id)

    for (const c of this.conns) c.subs.delete(id)
    this.bus.emit('term.killed', { id })

    return true
  }

  /**
   * A workspace terminal's environment, with the instructions file and the
   * permission mode from the current config and the project's que.toml.
   */
  private terminalEnv(ws: Workspace): WorkspaceTerminalEnv {
    const repo = loadRepoConfig(this.workspaces.project(ws.projectId).path)

    if (!repo.ok) this.log(`que.toml for ${ws.name} is invalid: ${formatConfigErrors(repo.errors)}`)
    const session = sessionEnv(this.configOrDefault(), repo.ok ? repo.config : {})

    return workspaceTerminalEnv(ws, this.paths, this.socketPath, session)
  }

  private getInstructions(): InstructionsGetResult {
    const path = this.configOrDefault().instructionsFile

    if (!path) return { exists: false, content: '' }

    try {
      return { path, exists: true, content: fs.readFileSync(path, 'utf8') }
    } catch (err) {
      if (errorCode(err) === 'ENOENT') return { path, exists: false, content: '' }

      throw new RpcError(ErrorCodes.BadRequest, `${path}: ${errorMessage(err)}`)
    }
  }

  private setInstructions(content: string): InstructionsGetResult {
    const path = this.configOrDefault().instructionsFile

    if (!path) {
      throw new RpcError(
        ErrorCodes.NotConfigured,
        'no instructions file: set instructions_file in the que config first'
      )
    }

    fs.mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    fs.writeFileSync(tmp, content)
    fs.renameSync(tmp, path)
    this.log(`instructions ${path} updated`)

    return this.getInstructions()
  }

  /**
   * The title of a workspace terminal in which a Claude session is live names the
   * session; it becomes the workspace's title unless the user set one. Run when the
   * title changes and when a session goes live, since a resumed session writes its
   * name before its start hook lands. An empty title (the session exiting) or the
   * unnamed placeholder changes nothing.
   */
  private labelFromTerminal(id: string): void {
    const t = this.opts.host.get(id)

    if (!t?.workspaceId || !this.liveSessions.isLive(id)) return
    const label = sessionLabel(t.title)

    if (label) this.workspaces.labelFromSession(t.workspaceId, label)
  }

  /** Kills every terminal of a workspace; returns how many were still alive. */
  private killWorkspaceTerminals(workspaceId: string): number {
    let alive = 0

    for (const t of this.opts.host.list()) {
      if (t.workspaceId === workspaceId) {
        if (t.alive) alive += 1
        this.termWorkspace.delete(t.id)
        this.killTerminal(t.id)
      }
    }

    return alive
  }

  log(msg: string): void {
    this.opts.log?.(msg)
  }

  listen(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        const conn = new Connection(socket, this)
        this.conns.add(conn)
        socket.on('close', () => {
          // Subscriptions are per-connection; terminals keep running.
          conn.subs.clear()
          conn.watches.clear()
          this.conns.delete(conn)
          this.syncWatches()
        })
      })

      server.once('error', reject)
      server.listen(socketPath, () => {
        server.off('error', reject)
        this.socketPath = socketPath

        try {
          installWrapper({
            paths: this.paths,
            ...resolveCliRunner(),
            cliScript: this.opts.cliScript ?? defaultCliScript()
          })
        } catch (err) {
          this.log(`installing the hooks wrapper failed: ${errorMessage(err)}`)
        }

        this.status.start()
        this.quiet.start()
        this.usage.start()
        this.prs.start()
        this.tickets.start()
        // After quiet hours have read their state: a locked start keeps the sessions for the unlock.
        this.liveSessions.start()
        // After the sessions: a workspace still being removed restores none, and its removal goes on.
        this.workspaces.start()
        server.on('error', (err) => this.log(`server error: ${err.message}`))

        try {
          fs.chmodSync(socketPath, 0o600)
        } catch (err) {
          this.log(`chmod socket failed: ${errorMessage(err)}`)
        }

        this.server = server
        resolve()
      })
    })
  }

  /**
   * Stops accepting connections and drops existing ones. Does not kill PTYs.
   */
  async close(): Promise<void> {
    await this.stopServices()

    for (const c of this.conns) c.socket.destroy()
    this.conns.clear()
    const server = this.server
    this.server = null

    if (!server) return Promise.resolve()

    return new Promise((resolve) => server.close(() => resolve()))
  }

  /**
   * For a handoff: as close(), but the caller's connection stays open for the
   * answer, and this resolves once the socket stops accepting rather than
   * when every connection has ended. Does not kill PTYs.
   */
  private async release(spare: Connection): Promise<void> {
    await this.stopServices()

    for (const c of this.conns) if (c !== spare) c.socket.destroy()
    this.server?.close()
    this.server = null
  }

  private async stopServices(): Promise<void> {
    // Before the terminals' exits and hooks arrive: shutdown and a handoff leave the record as it was.
    this.liveSessions.stop()

    for (const u of this.unsubs) u()
    this.unsubs = []

    if (!this.closed) {
      this.closed = true
      this.quiet.stop()
      this.usage.stop()
      this.prs.stop()
      await this.prs.drain()
      this.tickets.stop()
      await this.tickets.drain()
      this.status.stop()
      this.watcher.close()
      this.workspaces.close()
      this.store.close()
      await this.tokenizer.close()
    }
  }

  /** A watched worktree changed: its branch is re-read (HEAD may have moved) before clients hear of it. */
  private async worktreeChanged(id: string): Promise<void> {
    try {
      await this.workspaces.syncBranch(id)
    } catch {
      // Removed since the change was seen.
    }

    this.bus.emit('workspace.changed', { id })
  }

  /**
   * Watches the worktree of every workspace some connection asked to watch
   * with workspace.watch, and nothing else. Terminals do not matter here: a
   * client that wants a workspace watched says so, and its watches end when it
   * unwatches or its connection closes. Call this when that set changes or a
   * watched workspace goes away.
   */
  private syncWatches(): void {
    if (this.closed) {
      this.watcher.close()

      return
    }

    const ids = new Set<string>()

    for (const c of this.conns) {
      for (const id of c.watches) ids.add(id)
    }

    const wanted = new Map<string, string>()

    for (const id of ids) {
      const ws = this.store.getWorkspace(id)

      if (ws && !ws.archivedAt) wanted.set(ws.id, ws.path)
    }

    this.watcher.sync(wanted)
  }

  async dispatch(conn: Connection, req: Request): Promise<void> {
    if (typeof req !== 'object' || req === null || typeof req.id !== 'number') {
      this.log('dropping request without numeric id')

      return
    }

    if (typeof req.method !== 'string') {
      conn.send({ id: req.id, error: err(ErrorCodes.BadRequest, 'method must be a string') })

      return
    }

    const after: Array<() => void> = []

    try {
      const result = await this.handle(conn, req.method, req.params ?? {}, (fn) => after.push(fn))
      conn.send({ id: req.id, result })

      for (const fn of after) fn()

      if (req.method === 'daemon.handoff') {
        conn.socket.end(() => this.opts.onHandedOff?.())
        setTimeout(() => this.opts.onHandedOff?.(), 500).unref()
      }

      if (req.method === 'daemon.shutdown') {
        // Let the response reach the client before tearing everything down.
        conn.socket.end(() => this.opts.onShutdown?.())
        setTimeout(() => this.opts.onShutdown?.(), 500).unref()
      }
    } catch (e) {
      const error =
        e instanceof RpcError ? err(e.code, e.message) : err(ErrorCodes.Internal, errorMessage(e))

      if (!(e instanceof RpcError)) this.log(`${req.method} failed: ${error.message}`)
      conn.send({ id: req.id, error })
    }
  }

  private async handle(
    conn: Connection,
    method: string,
    p: Record<string, unknown>,
    afterSend: AfterSend
  ): Promise<Methods[keyof Methods]['result']> {
    if (!Object.hasOwn(METHODS, method)) {
      throw new RpcError(ErrorCodes.UnknownMethod, `unknown method ${method}`)
    }

    const name = method as MethodName
    // Quiet hours: detail is refused here, so every client gets the same answer.

    if (METHODS[name].quiet) this.quiet.check()

    let params: unknown

    try {
      params = decoders[name](p)
    } catch (e) {
      if (e instanceof ParamsError) throw new RpcError(ErrorCodes.BadRequest, e.message)

      throw e
    }

    // The table's type proves these methods' params name the workspace.
    if (METHODS[name].needsWorktree) this.workspaces.requireWorktree((params as { id: string }).id)

    // Each handler takes its own method's params; the table above pairs them.
    const run = this.handlers[name] as (
      params: unknown,
      ctx: HandlerContext
    ) => Promise<Methods[keyof Methods]['result']> | Methods[keyof Methods]['result']

    return run(params, { conn, afterSend })
  }

  /** What each method does with its decoded params; the compiler proves none is missing. */
  private readonly handlers: {
    [M in MethodName]: (
      params: ParamsOf<M>,
      ctx: HandlerContext
    ) => ResultOf<M> | Promise<ResultOf<M>>
  } = {
    'daemon.ping': () => ({
      version: this.opts.version,
      buildId: this.opts.buildId ?? '',
      pid: process.pid,
      startedAt: this.startedAt,
      nodeVersion: process.version,
      path: process.env.PATH ?? ''
    }),
    'daemon.shutdown': () => ({ ok: true }),
    'daemon.handoff': (p, { conn }) => {
      if (!this.opts.handoff)
        throw new RpcError(ErrorCodes.BadRequest, 'this daemon cannot hand off')

      return this.opts.handoff(p ?? {}, () => this.release(conn))
    },
    'term.create': (p) => this.openLooseTerminal(p).info(),
    'term.list': (p) =>
      this.opts.host
        .list()
        .filter((t) => !p?.workspaceId || t.workspaceId === p.workspaceId)
        .map((t) => t.info()),
    'term.attach': async (p, { conn, afterSend }) => {
      const t = this.requireTerm(p.id)
      // Buffer live output from this instant; the snapshot below covers everything
      // before it. Output already sent reaches the client too: the seq in the answer
      // tells it which, so nothing is lost or duplicated.
      const sub: Subscription = { pending: [] }
      conn.subs.set(t.id, sub)

      try {
        t.resize(p.cols, p.rows)
        const { serialized, seq } = await t.serializeNow()
        afterSend(() => flushPending(conn, t.id, sub))

        return { snapshot: serialized, seq, cols: t.cols, rows: t.rows }
      } catch (e) {
        if (conn.subs.get(t.id) === sub) conn.subs.delete(t.id)
        throw e
      }
    },
    'term.detach': (p, { conn }) => {
      conn.subs.delete(p.id)

      return { ok: true }
    },
    'term.write': (p) => {
      this.requireTerm(p.id).write(p.data)

      return { ok: true }
    },
    'term.resize': (p) => {
      this.requireTerm(p.id).resize(p.cols, p.rows)

      return { ok: true }
    },
    'term.kill': (p) => {
      if (!this.killTerminal(p.id)) throw new RpcError(ErrorCodes.NotFound, `no terminal ${p.id}`)

      return { ok: true }
    },
    'term.snapshot': (p) => this.requireTerm(p.id).snapshot(),
    'project.add': async (p) => {
      const before = new Set(this.workspaces.listProjects().map((x) => x.id))
      const project = await this.workspaces.addProject(p)

      if (!before.has(project.id)) this.bus.emit('project.added', project)

      return project
    },
    'project.list': () => this.workspaces.listProjects(),
    'project.remove': async (p) => {
      await this.workspaces.removeProject(p.id, p.force)
      this.bus.emit('project.removed', { id: p.id })

      return { ok: true }
    },
    'workspace.create': (p) => this.workspaces.create(p),
    'workspace.prepare': (p) => this.workspaces.prepare(p),
    'workspace.list': (p) => this.workspaces.list(p?.projectId),
    'workspace.get': (p) => this.workspaces.get(p.id),
    'workspace.remove': async (p) => {
      await this.workspaces.remove({ id: p.id, deleteBranch: p.deleteBranch })

      return { ok: true }
    },
    'workspace.openTerminal': (p) => this.openWorkspaceTerminal(p.id, p.cols, p.rows),
    'workspace.start': (p) => this.startWorkspace(p.id, p.cols, p.rows),
    'workspace.rename': (p) => this.workspaces.rename(p),
    'workspace.canRenameBranch': async (p) => ({
      allowed: await this.workspaces.canRenameBranch(p.id)
    }),
    'workspace.seen': (p) => this.workspaces.seen(p.id),
    'workspace.diff': (p) => {
      const ws = this.workspaces.get(p.id)

      return workspaceDiff(
        ws,
        this.workspaces.project(ws.projectId),
        Date.now,
        { base: p.base, head: p.head, commit: p.commit },
        this.classifier
      )
    },
    'workspace.diffFile': ({ id, ...rest }) => {
      const ws = this.workspaces.get(id)

      return workspaceDiffFile(ws, this.workspaces.project(ws.projectId), rest, this.tokenizer)
    },
    'workspace.prThread': (p) => {
      const ws = this.workspaces.get(p.id)

      return this.prs.thread(ws.id, p.number, p.refresh === true)
    },
    'workspace.checkPrs': (p) => this.prs.checkNow(this.workspaces.get(p.id).id),
    'workspace.files': (p) => workspaceFiles(this.workspaces.get(p.id), Date.now),
    'workspace.readFile': (p) => readWorkspaceFile(this.workspaces.get(p.id), p.path),
    'workspace.watch': (p, { conn }) => {
      conn.watches.add(this.workspaces.get(p.id).id)
      this.syncWatches()

      return { ok: true }
    },
    'workspace.unwatch': (p, { conn }) => {
      conn.watches.delete(p.id)
      this.syncWatches()

      return { ok: true }
    },
    'hook.event': (p) => {
      // A loose terminal's hook names no workspace: its session is kept for a restart, and no
      // workspace hears of it.
      const ws = p.workspaceId === undefined ? undefined : this.workspaces.get(p.workspaceId)
      this.liveSessions.hook(ws?.id, p.terminalId, p.payload)

      if (!ws) return { ok: true }

      this.status.hook(ws.id, p.payload)
      this.prs.hook(ws.id, p.payload).catch((e: unknown) => {
        this.log(`pull request capture failed for ${ws.id}: ${errorMessage(e)}`)
      })

      return { ok: true }
    },
    'report.get': (p) => this.report(p?.since),
    'quiet.state': () => this.quiet.state(),
    'quiet.unlock': (p) => this.quiet.unlockFor(p?.minutes, p?.why),
    'quiet.lock': () => this.quiet.lock(),
    'quiet.start': (p) => this.quiet.startManual(p?.minutes),
    'quiet.end': () => this.quiet.endManual(),
    'quiet.log': (p) => this.quiet.log(p?.since),
    'usage.report': (p) => {
      this.usage.report(p)

      return { ok: true }
    },
    'usage.get': () => this.usage.get(),
    'tickets.list': () => this.tickets.list(),
    'tickets.sync': () => this.tickets.sync(),
    'tickets.start': (p) => this.tickets.startTicket(p),
    'tickets.projectFor': (p) => ({ projectId: this.tickets.projectFor(p.key) }),
    'config.get': () => this.getConfig(),
    'config.set': (p) => this.setConfig(p.patch, p.applyTonight === true),
    'instructions.get': () => this.getInstructions(),
    'instructions.set': (p) => this.setInstructions(p.content)
  }
}

function flushPending(conn: Connection, id: string, sub: Subscription): void {
  // A later attach/detach on this connection replaced this subscription.
  if (conn.subs.get(id) !== sub || !sub.pending) return
  const pending = sub.pending
  sub.pending = null
  const last = pending.at(-1)

  // All of it is past the snapshot, so the highest number speaks for the whole.
  if (last) {
    conn.sendEvent('term.data', {
      id,
      data: pending.map((p) => p.data).join(''),
      seq: last.seq
    })
  }
}

function err(code: string, message: string): ResponseError {
  return { code, message }
}
