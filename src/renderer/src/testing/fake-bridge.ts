// The fake window.que for renderer tests: an in-memory fixture book behind the
// same QueApi the preload exposes, emitting the events the daemon would.
// setup.ts installs `fakeBridge.api` as window.que and resets it after each test.
import type {
  ConfigGetResult,
  DaemonState,
  ConfigSetParams,
  InstructionsGetResult,
  Events,
  PrThread,
  Project,
  PullRequest,
  QueApi,
  QuietState,
  QuietUnlock,
  Report,
  TermInfo,
  Ticket,
  TicketsListResult,
  TicketsSyncState,
  UpdateInfo,
  UserConfig,
  Workspace,
  WorkspaceDiff,
  WorkspaceDiffFile,
  WorkspaceDiffFileParams,
  WorkspaceDigest,
  WorkspaceFile,
  WorkspaceFiles,
  WorkspaceStatus
} from '../../../preload/index.d'
import { quietMessage } from '../../../daemon/quiet-hours'
import { buildReport } from '../../../daemon/report'
import { titleOf } from '../../../shared/brief'
import { patchToToml } from '../../../shared/config-keys.decode'
import { mergeConfigPatch } from '../../../shared/config-patch.decode'
import { randomWorkspaceName } from '../../../shared/names'
import { keyOf } from '../keys'
import {
  ErrorCodes,
  QUIET_REFUSED_METHODS,
  type WorkspaceCreateParams,
  type WorkspaceRenameParams
} from '../../../shared/protocol'
import { removalStep } from '../../../shared/removal'
import { workspaceSlug } from '../../../shared/slug'
import type { RemovalFailure, RemovalResult, RemovalStep, Usage } from '../../../shared/types'
import {
  diffFileFromPatch,
  makeQuietState,
  makeUserConfig,
  makeWorkspaceDiffFile
} from './fixtures'

export type FakeQueApi = QueApi

/** A terminal in the book: what term.list reports, plus what was typed into it. */
export interface FakeTerminal extends TermInfo {
  /** Everything written with term.write, in order. */
  input: string
  /** What term.attach and term.snapshot replay. */
  screen: string
}

type AnyEvents = Events

type Listener = (data: never) => void

function notFound(what: string, id: string): Error {
  return Object.assign(new Error(`no ${what} ${id}`), { code: 'not_found' })
}

/**
 * A test's hold on one bridge method: while held, calls wait until release();
 * refuse() makes the next call fail with a message. A slow or refusing daemon.
 */
class Gate {
  private held: Array<() => void> | null = null
  private refusal: string | null = null

  hold(): void {
    this.held ??= []
  }

  /** Lets the held calls through, in the order they arrived, and stops holding. */
  release(): void {
    const held = this.held ?? []
    this.held = null

    for (const go of held) go()
  }

  refuse(message: string): void {
    this.refusal = message
  }

  /** A call passes: it waits while held, then takes the refusal meant for it, if any. */
  async pass(): Promise<string | null> {
    const held = this.held

    if (held) await new Promise<void>((go) => held.push(go))
    const refusal = this.refusal
    this.refusal = null

    return refusal
  }

  reset(): void {
    this.held = null
    this.refusal = null
  }
}

function rpcError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** A seeded diff's key: the workspace and the exact scope it answers for. */
function diffKey(id: string, base?: string, commit?: string): string {
  return keyOf(id, base ?? '', commit ?? '')
}

let idCounter = 0

/** A daemon running the same build as the app. */
function currentDaemon(): DaemonState {
  return {
    version: '0.4.0',
    buildId: '3f9a2c71b0de',
    expectedBuildId: '3f9a2c71b0de',
    stale: false
  }
}

function fakeId(prefix: 'prj_' | 'ws_'): string {
  idCounter += 1

  return `${prefix}fake${idCounter.toString(36).padStart(8, '0')}`
}

/** A field a previous build may not send: a workspace's, or (`pr.` and its name) its pull requests'. */
export type BuildField = keyof Workspace | `pr.${keyof PullRequest}`

/**
 * A copy of `value` without `fields`, as a build from before them sends it. The type stays
 * this build's, as the bridge's own types do whatever build answers.
 */
function stripped<T extends Workspace | PullRequest>(value: T, fields: readonly string[]): T {
  const sent = { ...value }

  for (const f of fields) Reflect.deleteProperty(sent, f)

  return sent
}

class FakeBridge {
  readonly api: FakeQueApi
  private projects = new Map<string, Project>()
  private workspaces = new Map<string, Workspace>()
  private digests: WorkspaceDigest[] = []
  /** A test's hold on report.get. */
  private reportGate = new Gate()
  private terminals = new Map<string, FakeTerminal>()
  private listeners = new Map<string, Set<Listener>>()
  private disconnectListeners = new Set<() => void>()
  private reconnectListeners = new Set<(state: DaemonState) => void>()
  private daemonBook: DaemonState = currentDaemon()
  /** While the connection is down: daemon.state calls wait here until reconnect() or failReconnect(). */
  private down: Array<{ resolve: (s: DaemonState) => void; reject: (e: Error) => void }> | null =
    null
  private upgradeCount = 0
  /** A test's hold or refusal on daemon.upgrade. */
  private upgradeGate = new Gate()
  private daemonStateCount = 0
  private home = '/Users/dev'
  private folder: string | null = null
  private tray = '● 0 ▸ 0 ✕ 0'
  private editorCalls: string[] = []
  private updateInfo: UpdateInfo | null = null
  private updateListeners = new Set<(info: UpdateInfo) => void>()
  private updateOpens = 0
  private createCallLog: WorkspaceCreateParams[] = []
  private startCallLog: string[] = []
  private termListCalls = 0
  private attachCallLog: string[] = []
  private renameCallLog: WorkspaceRenameParams[] = []
  private seenCallLog: string[] = []
  private pushedBranches = new Set<string>()
  private quiet: QuietState = makeQuietState()
  private usageBook: Usage | null = null
  /** Methods the daemon's build does not have yet (see withoutMethods). */
  private unknownMethods = new Set<string>()
  /** Fields the daemon's build does not send yet (see withoutFields). */
  private unsentFields = new Set<BuildField>()
  private unlocks: QuietUnlock[] = []
  private unlockRequests: Array<{ minutes?: number; why?: string }> = []
  private configBook: ConfigGetResult = defaultConfigBook()
  /** The config file's table, as the daemon would hold it: what config.set patches end up as. */
  private configRaw: Record<string, unknown> = {}
  private configSets: ConfigSetParams[] = []
  /** A test's hold or refusal on config.set. */
  private configGate = new Gate()
  /** workspace.remove stops on its first step until the test advances it. */
  private removalsHeld = false
  /** The instructions file's text; null while it does not exist. */
  private instructionsText: string | null = null
  private instructionsSets: string[] = []

  constructor() {
    this.api = {
      quiet: {
        state: async () => ({ ...this.quiet }),
        unlock: async (p) => {
          this.unlockRequests.push({ ...p })

          if (!this.quiet.inQuietHours) return { ...this.quiet }
          const minutes = p?.minutes ?? this.quiet.unlockMinutes
          const now = Date.now()

          // As in the daemon, the log keeps quiet hours' unlocks, not a manual quiet's.
          if (this.quiet.kind !== 'manual') {
            this.unlocks.push({
              at: new Date(now).toISOString(),
              minutes,
              why: p?.why ?? null,
              endedAt: null
            })
          }

          this.setQuietState({ unlockedUntil: new Date(now + minutes * 60_000).toISOString() })

          return { ...this.quiet }
        },
        lock: async () => {
          const open = this.unlocks.find((u) => u.endedAt === null)

          if (open) open.endedAt = new Date().toISOString()
          this.setQuietState({ unlockedUntil: null })

          return { ...this.quiet }
        },
        start: async (p) => {
          if (this.quiet.kind === 'scheduled') return { ...this.quiet }
          const now = Date.now()
          const end = new Date(now + (p?.minutes ?? 60) * 60_000).toISOString()
          this.setQuietState({
            inQuietHours: true,
            kind: 'manual',
            windowStart: new Date(now).toISOString(),
            windowEnd: end,
            nextBoundary: end,
            unlockedUntil: null
          })

          return { ...this.quiet }
        },
        end: async () => {
          if (this.quiet.kind !== 'manual') return { ...this.quiet }
          this.setQuietState({
            inQuietHours: false,
            kind: null,
            windowStart: null,
            windowEnd: null,
            nextBoundary: null,
            unlockedUntil: null
          })

          return { ...this.quiet }
        },
        log: async () => this.unlocks.map((u) => ({ ...u })),
        on: (event, cb) => this.subscribe(event, cb as Listener)
      },
      usage: {
        get: async () => {
          this.refuseIfUnknown('usage.get')

          return structuredClone(this.usageBook)
        },
        on: (event, cb) => this.subscribe(event, cb as Listener)
      },
      config: {
        get: async () => structuredClone(this.configBook),
        set: async (p) => {
          const refusal = await this.configGate.pass()

          if (refusal !== null) throw rpcError('bad_request', refusal)

          this.configSets.push(structuredClone(p))
          this.configRaw = mergeConfigPatch(this.configRaw, patchToToml(p.patch))

          if ('instructionsFile' in p.patch) {
            const file = p.patch.instructionsFile
            this.configBook.config = {
              ...this.configBook.config,
              instructionsFile: typeof file === 'string' && file !== '' ? file : undefined
            }
          }

          this.emit('config.changed', structuredClone(this.configBook))

          return structuredClone(this.configBook)
        },
        on: (event, cb) => this.subscribe(event, cb as Listener)
      },
      instructions: {
        get: async () => this.instructionsResult(),
        set: async (p) => {
          if (!this.configBook.config.instructionsFile) {
            throw rpcError(
              ErrorCodes.NotConfigured,
              'no instructions file: set instructions_file in the que config first'
            )
          }

          this.instructionsSets.push(p.content)
          this.instructionsText = p.content

          return this.instructionsResult()
        }
      },
      term: {
        create: async (p) => {
          this.refuseIfQuiet('term.create')

          return this.createTerminal(p)
        },
        list: async (p) => {
          this.termListCalls++

          return [...this.terminals.values()].flatMap((t) =>
            !p?.workspaceId || t.workspaceId === p.workspaceId ? [toInfo(t)] : []
          )
        },
        attach: async ({ id, cols, rows }) => {
          this.refuseIfQuiet('term.attach')
          const t = this.terminal(id)
          this.attachCallLog.push(id)
          Object.assign(t, { cols, rows })

          return { snapshot: t.screen, cols, rows }
        },
        detach: async () => ({ ok: true }),
        write: ({ id, data }) => {
          const t = this.terminals.get(id)

          if (t?.alive) t.input += data
        },
        resize: async ({ id, cols, rows }) => {
          Object.assign(this.terminal(id), { cols, rows })

          return { ok: true }
        },
        kill: async ({ id }) => {
          this.terminal(id)
          this.terminals.delete(id)
          this.emit('term.killed', { id })

          return { ok: true }
        },
        snapshot: async ({ id }) => {
          this.refuseIfQuiet('term.snapshot')
          const t = this.terminal(id)

          return { serialized: t.screen, text: t.screen }
        },
        on: (event, cb) => this.subscribe(event, cb as Listener),
        onDisconnect: (cb) => {
          this.disconnectListeners.add(cb)

          return () => this.disconnectListeners.delete(cb)
        }
      },
      app: {
        homedir: async () => this.home,
        openFolder: async () => this.folder,
        openInEditor: async ({ path }) => {
          this.editorCalls.push(path)

          return { ok: true }
        },
        trayTitle: async () => this.tray,
        update: async () => (this.updateInfo ? { ...this.updateInfo } : null),
        onUpdate: (cb) => {
          this.updateListeners.add(cb)

          return () => this.updateListeners.delete(cb)
        },
        openUpdate: async () => {
          this.updateOpens++

          return { ok: true }
        },
        e2e: false
      },
      daemon: {
        state: () => {
          this.daemonStateCount++
          const waiting = this.down

          if (waiting) return new Promise((resolve, reject) => waiting.push({ resolve, reject }))

          return Promise.resolve({ ...this.daemonBook })
        },
        upgrade: async () => {
          this.upgradeCount++
          const refusal = await this.upgradeGate.pass()

          // As the main process does: a failed handoff leaves the old daemon serving as it was.
          if (refusal !== null) throw rpcError('handoff_failed', refusal)

          // The terminals move to the new daemon with their ids; the connection drops and comes back.
          this.disconnect()
          this.daemonBook = {
            ...this.daemonBook,
            buildId: this.daemonBook.expectedBuildId,
            stale: false
          }
          this.unknownMethods.clear()
          this.unsentFields.clear()
          this.reconnect()

          return { ...this.daemonBook }
        },
        onReconnected: (cb) => {
          this.reconnectListeners.add(cb)

          return () => this.reconnectListeners.delete(cb)
        }
      },
      project: {
        add: async ({ path = '', name }) => {
          const existing = [...this.projects.values()].find((p) => p.path === path)

          if (existing) return { ...existing }

          const project: Project = {
            id: fakeId('prj_'),
            name: name ?? path.split('/').filter(Boolean).pop() ?? 'repo',
            path,
            defaultBranch: 'main',
            createdAt: new Date().toISOString()
          }

          this.projects.set(project.id, project)
          this.emit('project.added', { ...project })

          return { ...project }
        },
        list: async () => [...this.projects.values()].map((p) => ({ ...p })),
        remove: async ({ id, force }) => {
          if (!this.projects.has(id)) throw notFound('project', id)
          const open = [...this.workspaces.values()].filter((w) => w.projectId === id)

          if (open.length > 0 && !force) throw rpcError('conflict', `project ${id} has workspaces`)

          for (const w of open) this.removeWorkspace(w.id)
          this.projects.delete(id)
          this.emit('project.removed', { id })

          return { ok: true }
        },
        on: (event, cb) => this.subscribe(event, cb as Listener)
      },
      tickets: {
        list: async () => {
          this.refuseIfUnknown('tickets.list')

          return this.ticketsResult()
        },
        sync: async () => {
          this.ticketSyncs += 1
          this.ticketsSync = { ...this.ticketsSync, lastSyncAt: new Date().toISOString() }
          const r = this.ticketsResult()
          this.emit('tickets.synced', r)

          return r
        },
        start: async ({ key, projectId, session }) => {
          this.refuseIfQuiet('tickets.start')
          const ticket = this.tickets.get(key)

          if (!ticket) throw notFound('ticket', key)

          if (session) {
            const t = await this.api.term.create({ cwd: '/Users/dev', cols: 80, rows: 24 })

            return { kind: 'session', terminal: t }
          }

          const target = projectId ?? this.ticketProjects.get(ticket.projectKey) ?? null

          if (!target) return { kind: 'needs_project', projects: [...this.projects.values()] }
          this.ticketProjects.set(ticket.projectKey, target)

          const ws = await this.api.workspace.create({
            projectId: target,
            name: `${key.toLowerCase()} ${ticket.summary}`
          })

          this.tickets.set(key, { ...ticket, workspaceId: ws.id })
          this.emit('tickets.synced', this.ticketsResult())

          return { kind: 'workspace', workspace: ws }
        },
        projectFor: async ({ key }) => ({
          projectId: this.ticketProjects.get(this.tickets.get(key)?.projectKey ?? '') ?? null
        }),
        on: (event, cb) => this.subscribe(event, cb as Listener)
      },
      report: {
        get: async (p) => {
          this.refuseIfQuiet('report.get')
          await this.reportGate.pass()

          return this.report(p?.since)
        }
      },
      workspace: {
        create: async (p) => {
          const { projectId, name, baseRef, branch } = p
          this.createCallLog.push(structuredClone(p))
          const project = this.projects.get(projectId)

          if (!project) throw notFound('project', projectId)
          const brief = p.brief?.trim() ? p.brief : undefined
          const title = p.title?.trim() || (brief ? titleOf(brief) : '')
          const titleSource = p.title?.trim() ? 'user' : 'brief'
          const id = fakeId('ws_')
          const s = name !== undefined ? workspaceSlug(name) : randomWorkspaceName()

          if (!s) throw rpcError('bad_request', `invalid workspace name ${name ?? ''}`)

          const other = [...this.workspaces.values()].find(
            (w) => w.projectId === projectId && w.name === s
          )

          if (other) throw rpcError('conflict', `workspace ${s} already exists (${other.id})`)
          const now = new Date().toISOString()

          const ws: Workspace = {
            id,
            projectId,
            name: s,
            branch: branch ?? s,
            branches: [branch ?? s],
            path: `${this.home}/.que/worktrees/${project.name}/${s}`,
            baseRef: baseRef ?? `origin/${project.defaultBranch}`,
            status: 'preparing',
            statusReason: null,
            statusAt: now,
            lastActivityAt: null,
            sessionId: null,
            createdAt: now,
            archivedAt: null,
            prUrls: [],
            pr: null,
            prs: [],
            finishedAt: null,
            seenAt: null,
            backgroundTasks: []
          }

          if (title) {
            ws.title = title
            ws.titleSource = titleSource
          }

          if (brief) ws.brief = brief
          this.workspaces.set(ws.id, ws)
          this.emit('workspace.created', this.sent(ws))

          return this.sent(ws)
        },
        list: async (p) =>
          [...this.workspaces.values()].flatMap((w) =>
            !p?.projectId || w.projectId === p.projectId ? [this.sent(w)] : []
          ),
        get: async ({ id }) => this.sent(this.workspace(id)),
        remove: async ({ id, deleteBranch }) => {
          this.workspace(id)
          this.startRemoval(id, deleteBranch)

          return { ok: true }
        },
        openTerminal: async ({ id, cols, rows }) => {
          this.refuseIfQuiet('workspace.openTerminal')
          const ws = this.workspace(id)

          return this.createTerminal({ cwd: ws.path, cols, rows, name: ws.name }, ws.id)
        },
        diff: async ({ id, base, head, commit }) => {
          this.refuseIfQuiet('workspace.diff')
          const ws = this.workspace(id)

          this.diffCallLog.push(
            head === undefined
              ? { id, base: base ?? null, commit: commit ?? null }
              : { id, base: base ?? null, commit: commit ?? null, head }
          )

          if (head !== undefined) {
            // A branch's own files: only what was seeded for it, never the worktree's diff.
            const own = this.headDiffs.get(diffKey(id, base, head))

            if (!own) throw rpcError('bad_request', `no such branch: ${head}`)

            return structuredClone(own)
          }

          const scoped = diffKey(id, base, commit)
          const failure = this.diffFailures.get(scoped)

          if (failure !== undefined) throw rpcError('bad_request', failure)

          if (base !== undefined && this.refusedBases.has(diffKey(id, base))) {
            const fallback = this.diffs.get(diffKey(id)) ?? this.defaultDiff(ws)

            return structuredClone({ ...fallback, rejectedBase: base })
          }

          const seeded = this.diffs.get(scoped) ?? this.diffs.get(diffKey(id))

          return structuredClone(seeded ?? this.defaultDiff(ws))
        },
        diffFile: async (params) => {
          this.refuseIfQuiet('workspace.diffFile')
          const ws = this.workspace(params.id)
          this.diffFileCallLog.push(structuredClone(params))
          const whitespace = params.whitespace ?? 'show'
          const seeded = this.diffFiles.get(keyOf(ws.id, params.path))

          const scope = {
            workspaceId: ws.id,
            path: params.path,
            head: params.head ?? ws.branch,
            commit: params.commit ?? null,
            whitespace
          }

          if (seeded) return structuredClone({ ...seeded, ...scope })
          // Unseeded: the lines of the file's patch in the listing of the same scope.
          const { id, base, head, commit } = params

          const listing =
            head !== undefined
              ? this.headDiffs.get(diffKey(id, base, head))
              : (this.diffs.get(diffKey(id, base, commit)) ?? this.diffs.get(diffKey(id)))

          const listed = listing?.files.find((f) => f.path === params.path)

          return structuredClone(
            listed ? diffFileFromPatch(listed, scope) : makeWorkspaceDiffFile(scope)
          )
        },
        files: async ({ id }) => {
          this.refuseIfQuiet('workspace.files')
          const ws = this.workspace(id)
          this.filesCallLog.push(id)
          const seeded = this.files.get(id)

          return structuredClone(
            seeded ?? {
              workspaceId: ws.id,
              files: [],
              truncated: false,
              generatedAt: new Date().toISOString()
            }
          )
        },
        readFile: async ({ id, path }) => {
          this.refuseIfQuiet('workspace.readFile')
          this.workspace(id)
          this.readFileCallLog.push({ id, path })
          const seeded = this.fileContents.get(keyOf(id, path))

          if (!seeded) throw rpcError(ErrorCodes.NotFound, `no such file: ${path}`)

          return structuredClone(seeded)
        },
        watch: async ({ id }) => {
          this.workspace(id)
          this.watchCallLog.push({ id, on: true })
          this.watchedIds.add(id)

          return { ok: true }
        },
        unwatch: async ({ id }) => {
          this.watchCallLog.push({ id, on: false })
          this.watchedIds.delete(id)

          return { ok: true }
        },
        prThread: async ({ id, number, refresh }) => {
          this.refuseIfQuiet('workspace.prThread')
          this.workspace(id)
          this.prThreadCallLog.push({ id, number, refresh: refresh === true })
          const seeded = this.prThreads.get(keyOf(id, number))

          return seeded ? structuredClone(seeded) : null
        },
        checkPrs: async ({ id }) => {
          this.refuseIfQuiet('workspace.checkPrs')
          this.workspace(id)
          this.checkPrsCallLog.push(id)
          const refusal = await this.checkPrsGate.pass()

          // As gh's failure reaches the app: its message.
          if (refusal !== null) throw rpcError(ErrorCodes.Internal, refusal)
          const found = this.upstreamPrs.get(id)

          // The check stores what it found and announces it before it answers, as the daemon does.
          if (found) {
            this.upstreamPrs.delete(id)
            this.setWorkspacePrs(id, found)
          }

          return this.sent(this.workspace(id))
        },
        start: async ({ id, cols, rows }) => {
          this.refuseIfQuiet('workspace.start')
          const ws = this.workspace(id)
          this.startCallLog.push(id)
          const first = [...this.terminals.values()].find((t) => t.workspaceId === id && t.alive)

          const terminal = first
            ? toInfo(first)
            : this.createTerminal(
                { cwd: ws.path, cols: cols ?? 120, rows: rows ?? 30, name: ws.name },
                ws.id
              )

          return { terminal }
        },
        rename: async (p) => {
          const { id, title } = p
          const ws = this.workspace(id)

          if (!title.trim()) throw rpcError('bad_request', 'title is required')
          this.renameCallLog.push(structuredClone(p))
          const wanted = p.branch?.trim()

          if (wanted !== undefined && wanted !== ws.branch && this.pushedBranches.has(id)) {
            throw rpcError('conflict', `branch ${ws.branch} is on origin; it keeps its name`)
          }

          const branch = wanted || ws.branch
          const next: Workspace = { ...ws, title: title.trim(), titleSource: 'user', branch }
          this.putWorkspace(next)

          return this.sent(next)
        },
        seen: async ({ id }) => {
          const ws = this.workspace(id)
          this.seenCallLog.push(id)
          const next: Workspace = { ...ws, seenAt: new Date().toISOString() }
          this.putWorkspace(next)

          return this.sent(next)
        },
        canRenameBranch: async ({ id }) => {
          this.workspace(id)

          return { allowed: !this.pushedBranches.has(id) }
        },
        on: (event, cb) => this.subscribe(event, cb as Listener)
      }
    }
  }

  // ---- quiet hours and config ------------------------------------------------

  /** Replaces the quiet state and emits quiet.changed, as the daemon's clock would. */
  setQuietState(q: Partial<QuietState>): void {
    const next = { ...this.quiet, ...q }

    // Unless a test sets `locked` itself, it follows the window and the unlock.
    if (!('locked' in q)) next.locked = next.inQuietHours && !next.unlockedUntil

    if (!('kind' in q)) next.kind = next.inQuietHours ? (next.kind ?? 'scheduled') : null
    this.quiet = next
    this.emit('quiet.changed', { ...this.quiet })
  }

  /** Replaces the Claude plan usage reading and emits usage.changed, as the daemon would. */
  setUsage(u: Usage | null): void {
    this.usageBook = structuredClone(u)
    this.emit('usage.changed', structuredClone(u))
  }

  /** Every quiet.unlock call's params, in order. */
  unlockCalls(): Array<{ minutes?: number; why?: string }> {
    return this.unlockRequests.map((c) => ({ ...c }))
  }

  /** Puts unlocks in the quiet log silently. Call before render(). */
  seedUnlocks(unlocks: QuietUnlock[]): void {
    this.unlocks = unlocks.map((u) => ({ ...u }))
  }

  /** Puts a config in the book silently (what config.get answers). Call before render(). */
  setConfig(config: Partial<UserConfig>, raw: Record<string, unknown> = {}): void {
    this.configBook = { ...this.configBook, config: makeUserConfig(config) }
    this.configRaw = raw
  }

  /** The config file's table after the config.set calls so far (the file's own key names). */
  configFile(): Record<string, unknown> {
    return structuredClone(this.configRaw)
  }

  /** The instructions file's text (instructions.get); null means it does not exist yet. */
  seedInstructions(content: string | null): void {
    this.instructionsText = content
  }

  /** Every instructions.set call's content, in order. */
  instructionsSetCalls(): string[] {
    return [...this.instructionsSets]
  }

  private instructionsResult(): InstructionsGetResult {
    const path = this.configBook.config.instructionsFile

    if (!path) return { exists: false, content: '' }

    return { path, exists: this.instructionsText !== null, content: this.instructionsText ?? '' }
  }

  /** Makes the next config.set fail with this message, as the daemon refuses a bad value. */
  refuseConfigSet(message: string): void {
    this.configGate.refuse(message)
  }

  /** Holds every config.set until releaseConfigSets(), as a slow daemon would. */
  holdConfigSets(): void {
    this.configGate.hold()
  }

  /** Lets the held config.set calls through, in the order they arrived, and stops holding. */
  releaseConfigSets(): void {
    this.configGate.release()
  }

  /** Every config.set call's params, in order. */
  configSetCalls(): ConfigSetParams[] {
    return this.configSets.map((c) => structuredClone(c))
  }

  /** The daemon's refusal of detail while quiet hours are locked. */
  private refuseIfQuiet(method: (typeof QUIET_REFUSED_METHODS)[number]): void {
    if (!QUIET_REFUSED_METHODS.includes(method)) return

    if (this.quiet.locked) {
      // A state seeded without a window ends at 07:00, like the fixtures' night.
      const end = this.quiet.windowEnd
        ? Date.parse(this.quiet.windowEnd)
        : new Date(2026, 9, 14, 7, 0).getTime()

      throw rpcError(
        'quiet_hours',
        quietMessage(end, this.quiet.unlockMinutes, this.quiet.kind ?? 'scheduled')
      )
    }
  }

  // ---- workspaces ----------------------------------------------------------

  /** Puts a workspace in the book silently: "already in the daemon". Call before render(). */
  seedWorkspace(ws: Workspace): void {
    this.workspaces.set(ws.id, { ...ws })
  }

  /** Puts a project in the book silently. Call before render(). */
  /** Adds a workspace line to the report. */
  seedDigest(d: WorkspaceDigest): void {
    this.digests.push({ ...d })
  }

  /** Holds every report.get until releaseReports(), as a slow daemon would. */
  holdReports(): void {
    this.reportGate.hold()
  }

  /** Lets the held report.get calls through, in the order they arrived, and stops holding. */
  releaseReports(): void {
    this.reportGate.release()
  }

  seedProject(project: Project): void {
    this.projects.set(project.id, { ...project })
  }

  /** The daemon noticed the worktree change on disk: fires workspace.changed for the workspace. */
  changeWorkspace(id: string): void {
    this.workspace(id)
    this.emit('workspace.changed', { id })
  }

  /** The daemon's comment split for the workspace settled: fires workspace.diffSettled. */
  settleDiff(id: string): void {
    this.workspace(id)
    this.emit('workspace.diffSettled', { id })
  }

  /** Updates a workspace's status and emits workspace.updated with the row, as the status engine would. */
  setStatus(id: string, status: WorkspaceStatus, reason?: string): void {
    const ws = this.workspace(id)
    const at = new Date().toISOString()
    // A turn that ends (working to idle) leaves something to look at, as the daemon records.
    const finished = ws.status === 'working' && status === 'idle'

    const next = {
      ...ws,
      status,
      statusReason: reason ?? null,
      statusAt: at,
      finishedAt: finished ? at : ws.finishedAt
    }

    this.putWorkspace(next)
  }

  /** Replaces a workspace's background tasks and emits workspace.updated, as the daemon would. */
  setBackgroundTasks(id: string, tasks: Workspace['backgroundTasks']): void {
    this.putWorkspace({ ...this.workspace(id), backgroundTasks: tasks.map((t) => ({ ...t })) })
  }

  private putWorkspace(w: Workspace): void {
    this.workspaces.set(w.id, w)
    this.emit('workspace.updated', this.sent(w))
  }

  /** A workspace as the daemon's build sends it (every list, event and result): without the fields withoutFields named. */
  private sent(w: Workspace): Workspace {
    const fields = [...this.unsentFields]
    const own = fields.filter((f) => !f.startsWith('pr.'))
    const ofPrs = fields.flatMap((f) => (f.startsWith('pr.') ? [f.slice('pr.'.length)] : []))

    if (ofPrs.length === 0) return stripped(w, own)

    const pr = w.pr && stripped(w.pr, ofPrs)

    return stripped({ ...w, pr, prs: w.prs.map((p) => stripped(p, ofPrs)) }, own)
  }

  /** Replaces the session's pull requests (the current one first), as a daemon refresh would. */
  setWorkspacePrs(id: string, prs: PullRequest[]): void {
    this.putWorkspace({ ...this.workspace(id), pr: prs[0] ?? null, prs: structuredClone(prs) })
  }

  getWorkspace(id: string): Workspace | undefined {
    return this.workspaces.get(id)
  }

  // ---- terminals -----------------------------------------------------------

  /** Puts a running terminal in the book silently, as if created before launch. */
  seedTerminal(info: TermInfo, screen = ''): void {
    this.terminals.set(info.id, { ...info, input: '', screen })
  }

  /** Adds a terminal and emits term.created with its row, as the daemon does when another client opens one. */
  announceTerminal(info: TermInfo): void {
    this.terminals.set(info.id, { ...info, input: '', screen: '' })
    this.emit('term.created', { ...info })
  }

  /** How many times term.list was called. */
  termListCount(): number {
    return this.termListCalls
  }

  /** Sets a terminal's title and foreground program and emits term.updated with its row, as the daemon would. */
  updateTerminal(id: string, facts: Pick<TermInfo, 'title' | 'process'>): void {
    const t = this.terminal(id)
    t.title = facts.title
    t.process = facts.process
    this.emit('term.updated', toInfo(t))
  }

  /** Marks a terminal exited and emits term.exit, as the daemon would. */
  exitTerminal(id: string, exitCode: number): void {
    this.terminal(id).alive = false
    this.emit('term.exit', { id, exitCode })
  }

  getTerminal(id: string): FakeTerminal | undefined {
    return this.terminals.get(id)
  }

  // ---- app -----------------------------------------------------------------

  /** What app.openFolder() resolves to (null = the user cancelled the picker). */
  setOpenFolderResult(dir: string | null): void {
    this.folder = dir
  }

  /** What app.trayTitle() resolves to. */
  setTrayTitle(title: string): void {
    this.tray = title
  }

  /**
   * What app.update() resolves to. Set before render to model a check that
   * finished before the window opened; set after render to emit onUpdate.
   */
  setUpdate(info: UpdateInfo | null): void {
    this.updateInfo = info

    if (info) for (const cb of this.updateListeners) cb({ ...info })
  }

  /** How many times app.openUpdate() was called. */
  openUpdateCalls(): number {
    return this.updateOpens
  }

  /** Every path app.openInEditor was asked to open, in order. */
  openInEditorCalls(): string[] {
    return [...this.editorCalls]
  }

  /** Every workspace.create call's params, in order. */
  createWorkspaceCalls(): WorkspaceCreateParams[] {
    return structuredClone(this.createCallLog)
  }

  /** The workspace id of every workspace.start call, in order. */
  startCalls(): string[] {
    return [...this.startCallLog]
  }

  /** Every workspace.seen call's workspace id, in order. */
  seenCalls(): string[] {
    return [...this.seenCallLog]
  }

  /** Every workspace.rename call, in order. */
  renameCalls(): WorkspaceRenameParams[] {
    return this.renameCallLog.map((c) => ({ ...c }))
  }

  /** Marks a workspace's branch as pushed to origin, so it cannot be renamed. Call before render(). */
  setBranchPushed(id: string): void {
    this.pushedBranches.add(id)
  }

  /**
   * Drops the daemon connection: every onDisconnect listener fires, and daemon.state
   * calls wait (as the main process's reconnect does) until reconnect() or failReconnect().
   */
  disconnect(): void {
    this.down ??= []

    for (const cb of this.disconnectListeners) cb()
  }

  /** The daemon was restarted elsewhere (from the CLI): it comes back with no terminals. */
  forgetTerminals(): void {
    this.terminals.clear()
  }

  /** The connection is back: waiting daemon.state calls answer and daemon.reconnected fires. */
  reconnect(): void {
    const waiting = this.down ?? []
    this.down = null

    for (const w of waiting) w.resolve({ ...this.daemonBook })

    for (const cb of this.reconnectListeners) cb({ ...this.daemonBook })
  }

  /** The reconnect failed: waiting daemon.state calls reject with `message`; the connection stays down. */
  failReconnect(message: string): void {
    const waiting = this.down ?? []
    this.down = []

    for (const w of waiting) w.reject(rpcError('start_timeout', message))
  }

  /** What daemon.state answers: the daemon's build and the one this app would start. Call before render() to seed. */
  setDaemon(state: Partial<DaemonState>): void {
    this.daemonBook = { ...this.daemonBook, ...state }
  }

  /**
   * The daemon runs a build from before these methods: they answer unknown_method,
   * as the previous build does, until daemon.upgrade. Call before render() to seed.
   */
  withoutMethods(...methods: string[]): void {
    for (const m of methods) this.unknownMethods.add(m)
  }

  /**
   * The daemon runs a build from before these fields: every workspace it sends (workspace.list,
   * get, its events, every result that carries one) leaves them out, as the previous build
   * does, until daemon.upgrade. `pr.<field>` leaves a field out of each of its pull requests.
   * The book keeps them; only what is sent changes. Call before render() to seed.
   */
  withoutFields(...fields: BuildField[]): void {
    for (const f of fields) this.unsentFields.add(f)
  }

  private refuseIfUnknown(method: string): void {
    if (this.unknownMethods.has(method))
      throw rpcError('unknown_method', `unknown method ${method}`)
  }

  /** Makes the next daemon.upgrade reject with `message`, as a failed handoff does. */
  refuseUpgrade(message: string): void {
    this.upgradeGate.refuse(message)
  }

  /** Holds every daemon.upgrade until releaseUpgrade(), as a handoff in progress would. */
  holdUpgrade(): void {
    this.upgradeGate.hold()
  }

  /** Lets the held daemon.upgrade calls go on. */
  releaseUpgrade(): void {
    this.upgradeGate.release()
  }

  /** The terminal id of every term.attach, in order (a pane attaches on mount and on every reconnect). */
  attachCalls(): string[] {
    return [...this.attachCallLog]
  }

  /** How many times the window asked to update the daemon in place. */
  upgradeCalls(): number {
    return this.upgradeCount
  }

  /** How many times daemon.state was asked (each reconnect asks once). */
  daemonStateCalls(): number {
    return this.daemonStateCount
  }

  /** Empties the book and drops listeners. setup.ts calls it after every test. */
  private tickets = new Map<string, Ticket>()
  /** Tracker project key → que project id, as the daemon learns it. */
  private ticketProjects = new Map<string, string>()
  private ticketsSync: TicketsSyncState = { lastSyncAt: null, error: null, count: 0 }
  ticketSyncs = 0

  private ticketsResult(): TicketsListResult {
    return {
      tickets: [...this.tickets.values()].map((t) => ({ ...t })),
      sync: { ...this.ticketsSync, count: this.tickets.size }
    }
  }

  /** Seeds a ticket as the daemon would list it. */
  seedTicket(t: Ticket): void {
    this.tickets.set(t.key, { ...t })
  }

  /** Makes the next sync report this error (null clears it) and announces it. */
  setTicketsError(error: string | null): void {
    this.ticketsSync = { ...this.ticketsSync, error }
    this.emit('tickets.synced', this.ticketsResult())
  }

  /** Teaches the mapping a tracker project key → que project id. */
  mapTicketProject(projectKey: string, projectId: string): void {
    this.ticketProjects.set(projectKey, projectId)
  }

  private diffs = new Map<string, WorkspaceDiff>()
  private diffFailures = new Map<string, string>()
  private diffCallLog: Array<{
    id: string
    base: string | null
    commit: string | null
    head?: string
  }> = []

  /**
   * What workspace.diff answers for a workspace: in exactly this scope (base and commit), or
   * without one, the answer for any scope not seeded itself.
   */
  seedDiff(diff: WorkspaceDiff, scope: { base?: string; commit?: string } = {}): void {
    this.diffs.set(diffKey(diff.workspaceId, scope.base, scope.commit), structuredClone(diff))
  }

  private headDiffs = new Map<string, WorkspaceDiff>()

  /**
   * What workspace.diff answers with `head` (a branch's own committed files against `base`),
   * as a pull request's files ask for them; any other branch is refused.
   */
  seedBranchDiff(diff: WorkspaceDiff, scope: { base?: string; head: string }): void {
    this.headDiffs.set(diffKey(diff.workspaceId, scope.base, scope.head), structuredClone(diff))
  }

  /** Makes workspace.diff in exactly this scope fail with this message (the whole request fails, as when the workspace is gone). */
  failDiff(id: string, scope: { base?: string; commit?: string }, message: string): void {
    this.diffFailures.set(diffKey(id, scope.base, scope.commit), message)
  }

  /** Makes workspace.diff with this base answer as the daemon does for a ref that is not a commit: the default comparison, with `rejectedBase` set. */
  refuseDiffBase(id: string, base: string): void {
    this.refusedBases.add(diffKey(id, base))
  }

  private refusedBases = new Set<string>()

  private defaultDiff(ws: { id: string; branch: string }): WorkspaceDiff {
    return {
      workspaceId: ws.id,
      base: 'origin/main',
      head: ws.branch,
      commitsAhead: 0,
      commits: [],
      bases: ['origin/main'],
      commit: null,
      files: [],
      rejectedBase: null,
      generatedAt: new Date().toISOString()
    }
  }

  /** Every workspace.diff call, in order. */
  diffCalls(): Array<{ id: string; base: string | null; commit: string | null; head?: string }> {
    return this.diffCallLog.map((c) => ({ ...c }))
  }

  private diffFiles = new Map<string, WorkspaceDiffFile>()
  private diffFileCallLog: WorkspaceDiffFileParams[] = []

  /**
   * What workspace.diffFile answers for one path of a workspace, in any scope (with the scope
   * and whitespace asked for); an unseeded path gets its listed patch's lines, else a one-line change.
   */
  seedDiffFile(file: WorkspaceDiffFile): void {
    this.diffFiles.set(keyOf(file.workspaceId, file.path), structuredClone(file))
  }

  /** Every workspace.diffFile call, in order. */
  diffFileCalls(): WorkspaceDiffFileParams[] {
    return structuredClone(this.diffFileCallLog)
  }

  private files = new Map<string, WorkspaceFiles>()
  private fileContents = new Map<string, WorkspaceFile>()
  private filesCallLog: string[] = []
  private readFileCallLog: Array<{ id: string; path: string }> = []

  /** What workspace.files answers for a workspace. */
  seedFiles(files: WorkspaceFiles): void {
    this.files.set(files.workspaceId, structuredClone(files))
  }

  /** What workspace.readFile answers for one path of a workspace; unseeded paths are not found. */
  seedFile(file: WorkspaceFile): void {
    this.fileContents.set(keyOf(file.workspaceId, file.path), structuredClone(file))
  }

  /** Every workspace.files call, the workspace ids in order. */
  filesCalls(): string[] {
    return [...this.filesCallLog]
  }

  /** Every workspace.readFile call, in order. */
  readFileCalls(): Array<{ id: string; path: string }> {
    return this.readFileCallLog.map((c) => ({ ...c }))
  }

  private watchCallLog: Array<{ id: string; on: boolean }> = []
  private watchedIds = new Set<string>()

  /** Every workspace.watch (on) and workspace.unwatch (off) call, in order. */
  watchCalls(): Array<{ id: string; on: boolean }> {
    return this.watchCallLog.map((c) => ({ ...c }))
  }

  /** The workspaces currently watched, in the order they were first watched. */
  watched(): string[] {
    return [...this.watchedIds]
  }

  private prThreads = new Map<string, PrThread>()
  private prThreadCallLog: Array<{ id: string; number: number; refresh: boolean }> = []

  /** What workspace.prThread answers for a workspace's pull request `thread.number`. */
  seedPrThread(workspaceId: string, thread: Omit<PrThread, 'workspaceId'>): void {
    this.prThreads.set(
      keyOf(workspaceId, thread.number),
      structuredClone({ ...thread, workspaceId })
    )
  }

  /** Every workspace.prThread call, in order. */
  prThreadCalls(): Array<{ id: string; number: number; refresh: boolean }> {
    return this.prThreadCallLog.map((c) => ({ ...c }))
  }

  private checkPrsCallLog: string[] = []
  /** A test's hold or refusal on workspace.checkPrs. */
  private checkPrsGate = new Gate()
  /** Per workspace: the pull requests GitHub has now, for the next workspace.checkPrs to find. */
  private upstreamPrs = new Map<string, PullRequest[]>()

  /**
   * The pull requests GitHub has for a workspace now (the current one first). The fake never
   * polls: the next workspace.checkPrs finds them, stores them and emits workspace.updated.
   */
  setUpstreamPrs(id: string, prs: PullRequest[]): void {
    this.upstreamPrs.set(id, structuredClone(prs))
  }

  /** Holds every workspace.checkPrs until releaseCheckPrs(), as a slow gh would. */
  holdCheckPrs(): void {
    this.checkPrsGate.hold()
  }

  /** Lets the held workspace.checkPrs calls through, in the order they arrived, and stops holding. */
  releaseCheckPrs(): void {
    this.checkPrsGate.release()
  }

  /** Makes the next workspace.checkPrs fail with `message`, as when gh fails. */
  refuseCheckPrs(message: string): void {
    this.checkPrsGate.refuse(message)
  }

  /** The workspace id of every workspace.checkPrs call, in order. */
  checkPrsCalls(): string[] {
    return [...this.checkPrsCallLog]
  }

  reset(): void {
    this.projects.clear()
    this.diffs.clear()
    this.headDiffs.clear()
    this.diffFailures.clear()
    this.diffCallLog = []
    this.diffFiles.clear()
    this.diffFileCallLog = []
    this.files.clear()
    this.fileContents.clear()
    this.filesCallLog = []
    this.readFileCallLog = []
    this.watchCallLog = []
    this.watchedIds.clear()
    this.prThreads.clear()
    this.prThreadCallLog = []
    this.checkPrsCallLog = []
    this.checkPrsGate.reset()
    this.upstreamPrs.clear()
    this.tickets.clear()
    this.ticketProjects.clear()
    this.ticketsSync = { lastSyncAt: null, error: null, count: 0 }
    this.ticketSyncs = 0
    this.workspaces.clear()
    this.digests = []
    this.reportGate.reset()
    this.terminals.clear()
    this.listeners.clear()
    this.disconnectListeners.clear()
    this.reconnectListeners.clear()
    this.daemonBook = currentDaemon()
    this.down = null
    this.upgradeCount = 0
    this.attachCallLog = []
    this.upgradeGate.reset()
    this.daemonStateCount = 0
    this.folder = null
    this.tray = '● 0 ▸ 0 ✕ 0'
    this.editorCalls = []
    this.updateInfo = null
    this.updateListeners.clear()
    this.updateOpens = 0
    this.createCallLog = []
    this.startCallLog = []
    this.termListCalls = 0
    this.renameCallLog = []
    this.seenCallLog = []
    this.pushedBranches.clear()
    this.quiet = makeQuietState()
    this.usageBook = null
    this.unknownMethods.clear()
    this.unsentFields.clear()
    this.unlocks = []
    this.unlockRequests = []
    this.configBook = defaultConfigBook()
    this.configRaw = {}
    this.configSets = []
    this.configGate.reset()
    this.instructionsText = null
    this.instructionsSets = []
    this.removalsHeld = false
  }

  private workspace(id: string): Workspace {
    const ws = this.workspaces.get(id)

    if (!ws) throw notFound('workspace', id)

    return ws
  }

  /** Every seeded digest through the daemon's buildReport, with no time window. */
  private report(since?: string): Report {
    const rank = (s: WorkspaceStatus): number =>
      s === 'needs_input' ? 0 : s === 'stuck' ? 1 : s === 'working' ? 2 : 3

    const digests = this.digests
      .map((d) => ({ ...d }))
      .sort((a, b) => rank(a.status) - rank(b.status))

    const report = buildReport(digests, new Date(0).toISOString(), Date.now())

    return { ...report, since: since ?? report.generatedAt }
  }

  private killTerminalsOf(id: string): void {
    for (const t of [...this.terminals.values()]) {
      if (t.workspaceId === id) {
        this.terminals.delete(t.id)
        this.emit('term.killed', { id: t.id })
      }
    }
  }

  /** Gone at once, as a project's removal takes its workspaces. */
  private removeWorkspace(id: string): void {
    this.killTerminalsOf(id)
    this.workspaces.delete(id)
    this.emit('workspace.removed', { id })
  }

  /**
   * workspace.remove: kills the terminals, marks the row `removing` on its first step and emits
   * workspace.updated, as the daemon does before it answers. Then every step runs at once,
   * unless holdRemovals() leaves each one to advanceRemoval().
   */
  private startRemoval(id: string, deleteBranch: boolean): void {
    this.killTerminalsOf(id)
    const at = new Date().toISOString()
    const plan: RemovalStep[] = ['terminals', 'teardown', 'worktree']

    if (deleteBranch) plan.push('branch')

    this.putWorkspace({
      ...this.workspace(id),
      status: 'removing',
      statusReason: null,
      statusAt: at,
      removal: { plan, since: at, done: [] }
    })

    if (this.removalsHeld) return

    while (this.workspaces.has(id)) this.advanceRemoval(id)
  }

  /** From now until reset, workspace.remove stops on its first step; advanceRemoval() walks it. */
  holdRemovals(): void {
    this.removalsHeld = true
  }

  /**
   * Finishes the removal's current step (failed with `error` when given) and starts the next,
   * emitting workspace.updated; past the last step, the row goes with workspace.removed, whose
   * `failed` lists the steps that failed.
   */
  advanceRemoval(id: string, opts: { error?: string } = {}): void {
    const ws = this.workspace(id)
    const removal = ws.removal
    const step = removal ? removalStep(removal) : null

    if (ws.status !== 'removing' || !removal || !step) {
      throw new Error(`workspace ${id} is not being removed`)
    }

    const finished: RemovalResult = { step, ms: 4 }

    if (opts.error) finished.error = opts.error
    const done = [...removal.done, finished]

    if (done.length === removal.plan.length) {
      const failed = done.filter((d): d is RemovalFailure => d.error !== undefined)
      this.workspaces.delete(id)
      this.emit('workspace.removed', failed.length > 0 ? { id, failed } : { id })

      return
    }

    this.putWorkspace({ ...ws, removal: { ...removal, since: new Date().toISOString(), done } })
  }

  private createTerminal(
    p: { cwd?: string; cols: number; rows: number; name?: string; file?: string },
    workspaceId?: string
  ): TermInfo {
    const id = crypto.randomUUID()
    const file = p.file ?? '/bin/zsh'

    const created: FakeTerminal = {
      id,
      name: p.name || file.split('/').pop() || 'shell',
      cwd: p.cwd ?? this.home,
      cols: p.cols,
      rows: p.rows,
      pid: 40_000 + this.terminals.size,
      alive: true,
      createdAt: new Date().toISOString(),
      workspaceId: workspaceId || undefined,
      input: '',
      screen: ''
    }

    this.terminals.set(id, created)

    const info = toInfo(created)

    this.emit('term.created', { ...info })

    return info
  }

  private terminal(id: string): FakeTerminal {
    const t = this.terminals.get(id)

    if (!t) throw notFound('terminal', id)

    return t
  }

  private subscribe(event: string, cb: Listener): () => void {
    let set = this.listeners.get(event)

    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }

    set.add(cb)

    return () => set.delete(cb)
  }

  private emit<E extends keyof AnyEvents>(event: E, data: AnyEvents[E]): void {
    for (const cb of this.listeners.get(event) ?? []) (cb as (d: AnyEvents[E]) => void)(data)
  }
}

function toInfo({ input: _input, screen: _screen, ...info }: FakeTerminal): TermInfo {
  return info
}

function defaultConfigBook(): ConfigGetResult {
  return { path: '/Users/dev/.config/que/config.toml', config: makeUserConfig() }
}

export const fakeBridge = new FakeBridge()
