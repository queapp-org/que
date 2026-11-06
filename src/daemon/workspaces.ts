// Projects (registered git repos) and workspaces (git worktrees on their own
// branch). Every git call is execFile('git', [...]) with an explicit cwd; user
// input never reaches a shell string.
import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import { titleOf } from '../shared/brief'
import {
  defaultConfig,
  formatConfigErrors,
  loadRepoConfig,
  type RepoConfig,
  resolvePermissionMode,
  type UserConfig
} from '../shared/config'
import { errorMessage } from '../shared/errors.decode'
import { run } from '../shared/exec'
import { loginShell } from '../shared/login-path'
import type { QuePaths } from '../shared/paths'
import type {
  HookEvent,
  ProjectAddParams,
  WorkspaceCreateParams,
  WorkspacePrepareParams,
  WorkspaceRemoveParams,
  WorkspaceRenameParams
} from '../shared/protocol'
import { randomWorkspaceName } from '../shared/names'
import { preparationFailure, preparationStep, preparationUnfinished } from '../shared/preparation'
import { workspaceSlug } from '../shared/slug'
import { removalStep } from '../shared/removal'
import type {
  Preparation,
  PreparationResult,
  PreparationStep,
  Project,
  Removal,
  RemovalFailure,
  RemovalResult,
  RemovalStep,
  TitleSource,
  Workspace
} from '../shared/types'
import { decodeArtifactCall } from './artifacts.decode'
import { reflogBranches, renameBranch, withBranch } from './branch-history'
import { badRequest, conflict, notFound } from './errors'
import type { Emit } from './bus'
import type { StatusService } from './status'
import { newId, type Store } from './store'
import { findOnPath, zshDir } from './wrapper'

interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
}

export interface GitOptions {
  /** Trim stdout and stderr (default true); file contents and patches keep their edge whitespace with false. */
  trim?: boolean
  /** Bytes of output before the run is killed. Default 16 MB. */
  maxBuffer?: number
  /** Written to git's stdin (e.g. object ids for `cat-file --batch-check`). */
  input?: string
  /** Kills the run when it aborts. */
  signal?: AbortSignal
}

/** Runs git in `cwd`; never throws. */
export async function git(
  cwd: string,
  args: string[],
  timeoutMs = 60_000,
  opts: GitOptions = {}
): Promise<GitResult> {
  const r = await run('git', args, {
    cwd,
    timeoutMs,
    maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
    input: opts.input,
    signal: opts.signal,
    // Without this, each git status holds index.lock while it runs, and a git add or commit in
    // that worktree fails on the spot. The daemon reads a shown worktree after every change.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
  })

  if (opts.trim === false) return { ok: r.ok, stdout: r.stdout, stderr: r.stderr }

  return { ok: r.ok, stdout: r.stdout.trim(), stderr: r.stderr.trim() }
}

/**
 * Commits on the workspace's branch past its base: `origin/<default>` when
 * that ref exists, else the base it was created from. Null when git cannot say.
 */
export async function commitsAhead(ws: Workspace, project: Project): Promise<number | null> {
  const def = project.defaultBranch

  const remote = await git(
    ws.path,
    ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${def}`],
    10_000
  )

  const base = remote.ok ? `origin/${def}` : ws.baseRef
  const counted = await git(ws.path, ['rev-list', '--count', `${base}..HEAD`], 10_000)

  if (!counted.ok) return null
  const n = Number(counted.stdout)

  return Number.isInteger(n) ? n : null
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  return (await git(cwd, ['show-ref', '--verify', '--quiet', ref])).ok
}

async function validBranch(cwd: string, branch: string): Promise<boolean> {
  return (await git(cwd, ['check-ref-format', '--branch', branch])).ok
}

/** Keeps `.que/` out of `git status` through the repository's exclude file. */
export async function excludeQueDir(worktree: string): Promise<void> {
  const r = await git(worktree, ['rev-parse', '--git-path', 'info/exclude'])

  if (!r.ok || !r.stdout) return
  const file = resolve(worktree, r.stdout)
  let current = ''

  try {
    current = fs.readFileSync(file, 'utf8')
  } catch {
    // Created below.
  }

  if (current.split('\n').some((l) => l.trim() === '.que/')) return
  fs.mkdirSync(dirname(file), { recursive: true })
  fs.writeFileSync(file, `${current}${current && !current.endsWith('\n') ? '\n' : ''}.que/\n`)
}

/** The branch `cwd` has checked out, or '' on a detached HEAD or when it cannot be read. */
async function currentBranch(cwd: string): Promise<string> {
  const r = await git(cwd, ['symbolic-ref', '--short', 'HEAD'], 10_000)

  return r.ok ? r.stdout : ''
}

async function detectDefaultBranch(repo: string): Promise<string> {
  const head = await git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])

  if (head.ok && head.stdout.startsWith('origin/')) return head.stdout.slice('origin/'.length)

  for (const b of ['main', 'master']) {
    if (
      (await refExists(repo, `refs/heads/${b}`)) ||
      (await refExists(repo, `refs/remotes/origin/${b}`))
    ) {
      return b
    }
  }

  return (await currentBranch(repo)) || 'main'
}

export interface WorkspaceManagerOptions {
  store: Store
  paths: QuePaths
  status: StatusService
  emit: Emit
  /** Kills (and announces) every terminal of a workspace. */
  killTerminals: (workspaceId: string) => void
  /** Opens the workspace's first terminal and has claude start there once its setup has ended. */
  startClaude: (workspaceId: string) => void
  /** The user config; throws bad_request when the file cannot be read. */
  config: () => UserConfig
  log?: (msg: string) => void
  /** Draws a name for a workspace created without one (default: randomWorkspaceName). */
  randomName?: () => string
}

/** A new workspace that passed every check that needs no worktree: its name, branch and folder are free. */
interface NewWorkspace {
  project: Project
  repo: RepoConfig
  name: string
  branch: string
  path: string
  brief?: string
  title?: string
  titleSource?: TitleSource
}

/** How a worktree is added: `resumed` after a restart stopped an earlier try, `signal` to kill it. */
interface AddWorktreeOptions {
  resumed?: boolean
  signal?: AbortSignal
}

export class WorkspaceManager {
  private setups = new Map<string, ChildProcess>()
  private teardowns = new Map<string, ChildProcess>()
  /** Each workspace's removal in progress, settling when it has finished. */
  private removals = new Map<string, Promise<void>>()
  /** Each workspace's preparation in progress: how to stop it, and when it has stopped. */
  private preparations = new Map<string, { stop: AbortController; done: Promise<void> }>()
  /** After close(): the store may be closed, so a removal stops where it is. */
  private closed = false

  constructor(private opts: WorkspaceManagerOptions) {}

  private log(msg: string): void {
    this.opts.log?.(msg)
  }

  private repoConfig(repo: string): RepoConfig {
    const r = loadRepoConfig(repo)

    if (!r.ok) throw badRequest(`invalid que.toml in ${repo}: ${formatConfigErrors(r.errors)}`)

    return r.config
  }

  // ---- projects -------------------------------------------------------------

  async addProject(p: ProjectAddParams): Promise<Project> {
    if ((p.path === undefined) === (p.repo === undefined)) {
      throw badRequest('path or repo is required, not both')
    }

    let dir = p.path ?? ''
    let given = p.name

    if (p.repo !== undefined) {
      // A configured name wins over a directory of the same name, as `-r` always has.
      const named = this.opts.config().repos[p.repo]

      if (named) {
        dir = named.path
        given ??= p.repo
      } else {
        const abs = resolve(p.cwd ?? '.', p.repo)

        if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
          throw notFound(`no configured repo or directory named ${p.repo}`)
        }

        dir = abs
      }
    }

    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw badRequest(`no such directory: ${dir}`)
    }

    const top = await git(dir, ['rev-parse', '--show-toplevel'])

    if (!top.ok || !top.stdout) throw badRequest(`not a git repository: ${dir}`)
    const path = top.stdout
    const existing = this.opts.store.getProjectByPath(path)

    if (existing) return existing

    const name = (given ?? basename(path)).trim()

    if (!name || name.includes('/') || name === '.' || name === '..') {
      throw badRequest(`invalid project name: ${JSON.stringify(name)}`)
    }

    const configured = Object.values(this.opts.config().repos).find((r) => r.path === path)

    const defaultBranch =
      this.repoConfig(path).defaultBranch ??
      configured?.defaultBranch ??
      (await detectDefaultBranch(path))

    const project: Project = {
      id: newId('prj_'),
      name,
      path,
      defaultBranch,
      createdAt: new Date().toISOString()
    }

    this.opts.store.insertProject(project)
    this.log(`project ${project.id} added: ${path} (default ${defaultBranch})`)

    return project
  }

  listProjects(): Project[] {
    return this.opts.store.listProjects()
  }

  project(id: string): Project {
    const p = this.opts.store.getProject(id)

    if (!p) throw notFound(`no project ${id}`)

    return p
  }

  async removeProject(id: string, force = false): Promise<void> {
    this.project(id)
    const open = this.opts.store.listWorkspaces(id)

    if (open.length > 0 && !force) {
      throw conflict(`project ${id} has ${open.length} workspace(s); remove them or pass force`)
    }

    // A project removed by force keeps its branches.
    for (const ws of open) await this.remove({ id: ws.id, deleteBranch: false })
    await Promise.all(open.map((ws) => this.removals.get(ws.id)))
    this.opts.store.deleteProject(id)
  }

  // ---- workspaces -----------------------------------------------------------

  get(id: string): Workspace {
    const ws = this.opts.store.getWorkspace(id)

    if (!ws || ws.archivedAt) throw notFound(`no workspace ${id}`)

    return ws
  }

  /** Records that the app had the workspace selected in a focused window. */
  seen(id: string): Workspace {
    this.get(id)
    this.opts.store.setWorkspaceSeen(id, new Date().toISOString())
    const next = this.get(id)
    this.opts.emit('workspace.updated', next)

    return next
  }

  /** Records that the app opened one of the workspace's artifacts; another URL changes nothing. */
  artifactOpened(id: string, url: string): Workspace {
    const ws = this.get(id)

    if (!this.opts.store.markWorkspaceArtifactOpened(id, url, new Date().toISOString())) return ws
    const next = this.get(id)
    this.opts.emit('workspace.updated', next)

    return next
  }

  /** Applies the Artifact call a hook event shows, if any, and announces a list that changed. */
  recordArtifact(id: string, event: HookEvent): void {
    const call = decodeArtifactCall(event)

    if (!call) return
    const { store } = this.opts

    const changed =
      call.kind === 'published'
        ? store.publishWorkspaceArtifact(id, call.url, call.title, new Date().toISOString())
        : store.removeWorkspaceArtifact(id, call.url)

    if (!changed) return
    this.log(`workspace ${id} ${call.kind} ${call.url}`)
    this.opts.emit('workspace.updated', this.get(id))
  }

  list(projectId?: string): Workspace[] {
    return this.opts.store.listWorkspaces(projectId)
  }

  /**
   * Makes a workspace from a name (a clash is refused) or, without one, under a random
   * three-word name (drawn again on a clash, up to 50 times). The title defaults to the
   * brief's first line; a brief goes to `.que/brief.md`. Answers once the worktree exists, with
   * setup running in the background; nothing is left behind when it is refused.
   */
  async create(p: WorkspaceCreateParams): Promise<Workspace> {
    const fresh = await this.newWorkspace(p)
    await this.fetchOrigin(fresh.project)
    const baseRef = await this.addWorktree(fresh, p.baseRef)
    const ws = this.insertWorkspace(fresh, baseRef)
    this.startSetup(ws, fresh.repo.setup)

    return ws
  }

  /**
   * As create, but answers with the row before any of the slow work: a refused name still fails
   * here, and the steps then run in the background (see runPreparation).
   */
  async prepare(p: WorkspacePrepareParams): Promise<Workspace> {
    const fresh = await this.newWorkspace(p)
    const plan: PreparationStep[] = ['fetch', 'worktree']

    if (fresh.repo.setup) plan.push('setup')

    if (p.start) plan.push('claude')

    const ws = this.insertWorkspace(fresh, p.baseRef ?? '', {
      plan,
      since: new Date().toISOString(),
      done: []
    })

    this.log(`workspace ${ws.id} preparing: ${plan.join(', ')}`)
    this.beginPreparation(ws.id)

    return ws
  }

  /** Checks the name and draws one when none is given; throws when it cannot be used. */
  private async newWorkspace(p: WorkspaceCreateParams): Promise<NewWorkspace> {
    const project = this.project(p.projectId)
    const brief = p.brief?.trim() ? p.brief : undefined
    const explicitTitle = p.title?.trim() || undefined
    const title = explicitTitle || (brief ? titleOf(brief) : undefined) || undefined
    const titleSource = title ? (explicitTitle ? 'user' : 'brief') : undefined
    const explicit = p.name !== undefined
    const draw = this.opts.randomName ?? (() => randomWorkspaceName())
    const wanted = explicit ? workspaceSlug(p.name ?? '') : draw()

    if (!wanted) {
      throw badRequest(
        `invalid workspace name ${JSON.stringify(p.name ?? '')}: use letters, digits, '.', '_' or '-' (max 64)`
      )
    }

    if (p.branch !== undefined && !(await validBranch(project.path, p.branch))) {
      throw badRequest(`invalid branch name ${JSON.stringify(p.branch)}`)
    }

    if (!(await validBranch(project.path, wanted))) {
      throw badRequest(`invalid branch name ${JSON.stringify(wanted)}`)
    }

    const config = this.opts.config()
    const repo = this.repoConfig(project.path)

    // The first free name: only the given one for an explicit name, else up to 50 draws.
    let name = ''
    let branch = ''
    let path = ''
    let clash = ''

    for (let i = 1; i <= (explicit ? 1 : 50); i++) {
      name = i === 1 ? wanted : draw()
      branch = p.branch ?? name
      path = join(config.worktreeRoot, project.name, name)
      clash = await this.clash(project, name, branch, path)

      if (!clash) break

      if (p.branch !== undefined && clash.startsWith('branch')) break
    }

    if (clash) throw conflict(clash)

    return { project, repo, name, branch, path, brief, title, titleSource }
  }

  /** Fetches origin, when there is one; a failure is logged and the work goes on from what is known. */
  private async fetchOrigin(project: Project, signal?: AbortSignal): Promise<void> {
    const remotes = await git(project.path, ['remote'], 60_000, { signal })

    if (!remotes.ok || !remotes.stdout.split('\n').includes('origin')) return
    const fetched = await git(project.path, ['fetch', 'origin'], 30_000, { signal })

    if (!fetched.ok) this.log(`git fetch origin failed (continuing): ${fetched.stderr}`)
  }

  /**
   * `git worktree add` from the asked base, else from origin/<default branch> when that ref
   * exists, else <default branch>; then the files worktree_include lists, and the brief. Answers
   * with the base. A try the daemon's restart stopped may have got as far as the branch or the
   * whole worktree, so a resumed one goes on from there.
   */
  private async addWorktree(
    w: Pick<NewWorkspace, 'project' | 'repo' | 'branch' | 'path' | 'brief'>,
    asked: string | undefined,
    opts: AddWorktreeOptions = {}
  ): Promise<string> {
    const { project, branch, path, brief } = w

    const base =
      asked ??
      ((await refExists(project.path, `refs/remotes/origin/${project.defaultBranch}`))
        ? `origin/${project.defaultBranch}`
        : project.defaultBranch)

    if (!(await git(project.path, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`])).ok) {
      throw badRequest(`unknown base ref ${base}`)
    }

    fs.mkdirSync(dirname(path), { recursive: true })

    if (!opts.resumed || !fs.existsSync(join(path, '.git'))) {
      const branched = opts.resumed && (await refExists(project.path, `refs/heads/${branch}`))

      const added = await git(
        project.path,
        branched
          ? ['worktree', 'add', path, branch]
          : ['worktree', 'add', '--no-track', '-b', branch, path, base],
        60_000,
        { signal: opts.signal }
      )

      if (!added.ok) throw badRequest(`git worktree add failed: ${added.stderr}`)
    }

    copyIncludes(project.path, path, w.repo.worktreeInclude, (m) => this.log(m))

    if (brief) {
      fs.mkdirSync(join(path, '.que'), { recursive: true })
      fs.writeFileSync(join(path, '.que', 'brief.md'), brief)
      await excludeQueDir(path)
    }

    return base
  }

  /** Stores the new workspace in `preparing` and announces it. */
  private insertWorkspace(w: NewWorkspace, baseRef: string, preparation?: Preparation): Workspace {
    const now = new Date().toISOString()

    const ws: Workspace = {
      id: newId('ws_'),
      projectId: w.project.id,
      name: w.name,
      branch: w.branch,
      branches: [w.branch],
      path: w.path,
      baseRef,
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
      artifacts: [],
      backgroundTasks: []
    }

    if (w.title) ws.title = w.title

    if (w.brief) ws.brief = w.brief

    if (w.titleSource) ws.titleSource = w.titleSource

    if (preparation) ws.preparation = preparation

    this.opts.store.insertWorkspace(ws)
    this.log(
      `workspace ${ws.id} created at ${w.path} on ${w.branch}${baseRef && ` from ${baseRef}`}`
    )
    this.opts.emit('workspace.created', ws)
    this.opts.status.begin(ws)

    return ws
  }

  /** Starts running a stored preparation in the background. */
  private beginPreparation(id: string, resumed = false): void {
    const stop = new AbortController()

    this.preparations.set(id, {
      stop,
      done: this.runPreparation(id, stop.signal, resumed).finally(() =>
        this.preparations.delete(id)
      )
    })
  }

  /**
   * Runs the planned steps from the current one, announcing each result (which starts the next
   * step's clock). A step that fails stops the rest, except setup: claude starts after a failed
   * setup, as it does in a workspace that was created and started. The workspace leaves
   * `preparing` only when the steps end. Stops where it is when the daemon shuts down, to be
   * resumed by start(), and when the workspace is being removed.
   */
  private async runPreparation(id: string, signal: AbortSignal, resumed: boolean): Promise<void> {
    try {
      const ws = this.opts.store.getWorkspace(id)

      if (!ws?.preparation) return
      let preparation = ws.preparation

      for (const step of preparation.plan.slice(preparation.done.length)) {
        const started = Date.now()

        // A step a child still holds (a stuck fetch's helper, say) must not hold up a removal.
        const error = await Promise.race([
          this.runPreparationStep(step, ws, signal, resumed),
          whenAborted(signal)
        ])

        if (this.closed || signal.aborted) return
        const result: PreparationResult = { step, ms: Date.now() - started }

        if (error) {
          result.error = error
          this.log(`workspace ${id} preparation: ${step} failed: ${error}`)
        }

        preparation = withResult(preparation, result)

        if (error && step !== 'setup') {
          this.opts.store.setWorkspacePreparation(id, preparation)
          // The engine commits `stuck` and announces the row, the failed step included.
          this.opts.status.apply(id, { kind: 'preparation_failed' })

          return
        }

        if (preparation.done.length < preparation.plan.length) {
          this.savePreparation(id, preparation)
        }
      }

      this.finishPreparation(id, preparation)
    } catch (err) {
      if (!this.closed) this.log(`workspace ${id} preparation stopped: ${errorMessage(err)}`)
    }
  }

  /** Runs one preparation step; returns why it failed, or undefined. Never throws. */
  private async runPreparationStep(
    step: PreparationStep,
    ws: Workspace,
    signal: AbortSignal,
    resumed: boolean
  ): Promise<string | undefined> {
    try {
      const project = this.project(ws.projectId)

      switch (step) {
        case 'fetch':
          await this.fetchOrigin(project, signal)

          return undefined
        case 'worktree': {
          const repo = this.repoConfig(project.path)
          const { branch, path, brief } = ws
          const asked = ws.baseRef || undefined
          const opts = { resumed, signal }
          const made = { project, repo, branch, path, brief }

          this.opts.store.setWorkspaceBaseRef(ws.id, await this.addWorktree(made, asked, opts))

          return undefined
        }

        case 'setup': {
          // Read now, not when it was planned: que.toml may have changed since, a restart apart.
          const command = this.repoConfig(project.path).setup

          return command ? await this.runSetup(ws, command, signal) : undefined
        }

        case 'claude':
          this.opts.startClaude(ws.id)

          return undefined
      }
    } catch (err) {
      return errorMessage(err)
    }
  }

  /** Stores where the preparation stands and announces the row with workspace.updated. */
  private savePreparation(id: string, preparation: Preparation): void {
    this.opts.store.setWorkspacePreparation(id, preparation)
    const ws = this.opts.store.getWorkspace(id)

    if (ws) this.opts.emit('workspace.updated', ws)
  }

  /**
   * Every step has run: the workspace leaves `preparing`, which is what starts claude typing, and
   * the row says so once. A failed setup stays on it, so the reason can still be shown.
   */
  private finishPreparation(id: string, preparation: Preparation): void {
    const failed = preparationFailure(preparation) !== null
    this.opts.store.setWorkspacePreparation(id, failed ? preparation : null)
    const stillPreparing = this.opts.store.getWorkspace(id)?.status === 'preparing'
    this.opts.status.apply(id, { kind: failed ? 'setup_failed' : 'setup_done' })
    this.log(`workspace ${id} prepared${failed ? ' (setup failed)' : ''}`)

    // Moved on already, the engine has nothing to announce.
    if (stillPreparing) return
    const ws = this.opts.store.getWorkspace(id)

    if (ws) this.opts.emit('workspace.updated', ws)
  }

  /** Refuses what needs a finished worktree on a workspace still being prepared, or stopped by a failed step. */
  requireWorktree(id: string): void {
    const ws = this.get(id)

    if (preparationUnfinished(ws)) {
      throw conflict(`workspace ${ws.name} is not ready: its preparation has not finished`)
    }
  }

  /** Why this name, branch, or path cannot be used, or '' (archived rows holding it are dropped). */
  private async clash(project: Project, slug: string, branch: string, path: string) {
    for (const other of this.opts.store.findWorkspaceConflicts(project.id, slug, path)) {
      if (!other.archivedAt) return `workspace ${slug} already exists (${other.id})`
      this.opts.store.deleteWorkspace(other.id)
    }

    if (await refExists(project.path, `refs/heads/${branch}`)) {
      return `branch ${branch} already exists`
    }

    if (fs.existsSync(path)) return `path already exists: ${path}`

    return ''
  }

  /**
   * Records the branch the worktree has checked out when it is not the stored one, adds it to
   * the branches it has had, and announces it with workspace.updated. A detached HEAD or a
   * missing worktree keeps it. A workspace stored before branches were kept has them seeded
   * from the worktree's HEAD reflog first.
   */
  async syncBranch(id: string): Promise<Workspace> {
    const ws = this.get(id)
    const head = await currentBranch(ws.path)
    const branch = head || ws.branch
    const known = ws.branches.length > 0 ? ws.branches : await this.branchHistory(ws)
    const branches = withBranch(known, branch)
    const moved = branch !== ws.branch

    // A list seeded from the reflog is never empty, so it is stored even on the same branch.
    if (!moved && branches.length === ws.branches.length) return ws
    this.opts.store.setWorkspaceBranch(ws.id, branch, branches)
    const next = this.get(ws.id)

    if (moved) this.log(`workspace ${ws.id} is on ${branch} (was ${ws.branch})`)
    this.opts.emit('workspace.updated', next)

    return next
  }

  /** The branches the worktree's HEAD reflog has checked out, then the stored one. */
  private async branchHistory(ws: Workspace): Promise<string[]> {
    const r = await git(ws.path, ['reflog', 'show', '--format=%gs', 'HEAD'], 10_000)

    return withBranch(r.ok ? reflogBranches(r.stdout) : [], ws.branch)
  }

  /** True when the branch was never pushed: no `origin/<branch>` in the worktree. */
  async canRenameBranch(id: string): Promise<boolean> {
    return this.neverPushed(await this.syncBranch(id))
  }

  private async neverPushed(ws: Workspace): Promise<boolean> {
    const remote = await git(ws.path, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/remotes/origin/${ws.branch}`
    ])

    return !remote.ok
  }

  /**
   * Sets the title and, given a different branch, renames a never-pushed branch to it (the
   * folder keeps its name). Announces the change with workspace.updated.
   */
  async rename(p: WorkspaceRenameParams): Promise<Workspace> {
    const ws = await this.syncBranch(p.id)
    const title = p.title.trim()

    if (!title) throw badRequest('title is required')
    const branch = p.branch?.trim()

    if (branch !== undefined && branch !== ws.branch) {
      this.requireWorktree(ws.id)

      if (!(await validBranch(ws.path, branch))) {
        throw badRequest(`invalid branch name ${JSON.stringify(branch)}`)
      }

      if (!(await this.neverPushed(ws))) {
        throw conflict(`branch ${ws.branch} is on origin; it keeps its name`)
      }

      if (await refExists(ws.path, `refs/heads/${branch}`)) {
        throw conflict(`branch ${branch} already exists`)
      }

      const moved = await git(ws.path, ['branch', '-m', ws.branch, branch])

      if (!moved.ok) throw badRequest(`git branch -m failed: ${moved.stderr}`)
      // The old name never reached origin, so no pull request can name it.
      const branches = renameBranch(ws.branches, ws.branch, branch)
      this.opts.store.setWorkspaceBranch(ws.id, branch, withBranch(branches, branch))
    }

    this.opts.store.setWorkspaceTitle(ws.id, title, 'user')
    const next = this.get(ws.id)
    this.log(`workspace ${ws.id} renamed to ${JSON.stringify(title)} on ${next.branch}`)
    this.opts.emit('workspace.updated', next)

    return next
  }

  /**
   * The session in one of the workspace's terminals named itself `label`: it becomes the
   * title unless the user set one or it is already the title. Announces a change with
   * workspace.updated.
   */
  labelFromSession(id: string, label: string): void {
    const ws = this.opts.store.getWorkspace(id)

    if (!ws || ws.archivedAt || ws.titleSource === 'user' || ws.title === label) return
    this.opts.store.setWorkspaceTitle(id, label, 'terminal')
    this.opts.emit('workspace.updated', this.get(id))
  }

  /** Runs a created workspace's setup in the background; the status follows its end. */
  private startSetup(ws: Workspace, command: string | undefined): void {
    if (!command) {
      this.opts.status.apply(ws.id, { kind: 'setup_done' })

      return
    }

    void this.runSetup(ws, command).then((error) =>
      this.opts.status.apply(ws.id, { kind: error ? 'setup_failed' : 'setup_done' })
    )
  }

  /** Runs the repo's setup command to its end; returns why it failed, or undefined. Never throws. */
  private async runSetup(
    ws: Workspace,
    command: string,
    signal?: AbortSignal
  ): Promise<string | undefined> {
    let child: ChildProcess

    try {
      child = this.runInWorktree(ws, 'setup', command)
    } catch (err) {
      return errorMessage(err)
    }

    this.setups.set(ws.id, child)
    signal?.addEventListener('abort', () => killGroup(child), { once: true })
    const { code, error } = await exited(child)

    if (this.setups.get(ws.id) === child) this.setups.delete(ws.id)
    const failure = error ?? (code === 0 ? undefined : `exited with code ${code ?? 'null'}`)
    this.log(`workspace ${ws.id} setup ${failure ? 'failed' : 'finished'}`)

    return failure
  }

  /** Runs a que.toml command in the worktree via /bin/sh, logging to logs/workspaces/. */
  private runInWorktree(ws: Workspace, kind: 'setup' | 'teardown', command: string): ChildProcess {
    const logs = this.opts.paths.workspaceLogsDir
    fs.mkdirSync(logs, { recursive: true, mode: 0o700 })
    const fd = fs.openSync(join(logs, `${ws.id}-${kind}.log`), 'a')

    try {
      return spawn('/bin/sh', ['-c', command], {
        cwd: ws.path,
        stdio: ['ignore', fd, fd],
        detached: true,
        env: { ...process.env, QUE_WORKSPACE_ID: ws.id, QUE_WORKSPACE_PATH: ws.path }
      })
    } finally {
      fs.closeSync(fd)
    }
  }

  /**
   * Marks the workspace `removing` and starts its removal in the background (see runRemoval);
   * resolves once it is marked. A workspace already being removed is left to that removal.
   */
  async remove(p: WorkspaceRemoveParams): Promise<void> {
    const ws = this.get(p.id)

    if (ws.status === 'removing' || this.removals.has(ws.id)) return
    // A preparation still running stops here, and is gone before the first removal step.
    const preparing = this.preparations.get(ws.id)
    preparing?.stop.abort()
    const marked = this.markRemoving(ws.id, p.deleteBranch)

    // Held from the first await, so a second remove of the same workspace finds it.
    this.removals.set(
      ws.id,
      marked
        .then(() => preparing?.done)
        .then(() => this.runRemoval(ws.id))
        .catch(() => {})
        .finally(() => this.removals.delete(ws.id))
    )
    await marked
  }

  /**
   * Resumes the preparations and the removals a previous daemon left unfinished, from the step
   * each one was on, and empties the trash in the background.
   */
  start(): void {
    this.resumePreparations()

    for (const id of this.opts.store.listWorkspaceIdsByStatus('removing')) {
      if (this.removals.has(id)) continue
      const ws = this.opts.store.getWorkspace(id)

      if (!ws?.removal) continue
      const removal = ws.removal
      this.log(`workspace ${id} removal resumes at ${removalStep(removal) ?? 'the end'}`)
      this.saveRemoval(id, { ...removal, since: new Date().toISOString() })
      this.removals.set(
        id,
        this.runRemoval(id).finally(() => this.removals.delete(id))
      )
    }

    const trash = this.trashDir()
    void fs.promises
      .readdir(trash)
      .then((names) => {
        for (const name of names) this.discard(join(trash, name))
      })
      .catch(() => {})
  }

  /**
   * A workspace the last daemon left `preparing` goes on from its step. One from workspace.create
   * has no steps: it got that far with its setup running, and the daemon's stop ended that.
   */
  private resumePreparations(): void {
    for (const id of this.opts.store.listWorkspaceIdsByStatus('preparing')) {
      const ws = this.opts.store.getWorkspace(id)
      const project = ws && this.opts.store.getProject(ws.projectId)

      if (!ws || !project) continue

      if (!ws.preparation) {
        this.log(`workspace ${id} setup runs again`)
        this.startSetup(ws, this.repoCommand(project, 'setup'))
        continue
      }

      this.log(
        `workspace ${id} preparation resumes at ${preparationStep(ws.preparation) ?? 'the end'}`
      )
      this.savePreparation(id, { ...ws.preparation, since: new Date().toISOString() })
      this.beginPreparation(id, true)
    }
  }

  /** Records the branch it has checked out, plans the steps, and moves it to `removing`. */
  private async markRemoving(id: string, deleteBranch: boolean): Promise<void> {
    const ws = await this.syncBranch(id)
    const project = this.opts.store.getProject(ws.projectId)
    const plan: RemovalStep[] = ['terminals']

    // Teardown undoes setup: a workspace whose worktree step never finished has nothing to undo.
    const made =
      !ws.preparation || ws.preparation.done.some((r) => r.step === 'worktree' && !r.error)

    if (project && made && fs.existsSync(ws.path) && this.repoCommand(project, 'teardown')) {
      plan.push('teardown')
    }

    if (project) plan.push('worktree')

    if (project && deleteBranch) plan.push('branch')
    this.opts.store.setWorkspaceRemoval(ws.id, newRemoval(plan))
    // The engine commits `removing` and announces the row, removal included.
    this.opts.status.apply(ws.id, { kind: 'remove' })
    this.log(`workspace ${ws.id} removing: ${plan.join(', ')}`)
  }

  /** The repo's setup or teardown command; none when que.toml has none or cannot be read. */
  private repoCommand(project: Project, kind: 'setup' | 'teardown'): string | undefined {
    const r = loadRepoConfig(project.path)

    return r.ok ? r.config[kind] : undefined
  }

  /** Stores where the removal stands and announces the row with workspace.updated. */
  private saveRemoval(id: string, removal: Removal): Removal {
    this.opts.store.setWorkspaceRemoval(id, removal)
    const ws = this.opts.store.getWorkspace(id)

    if (ws) this.opts.emit('workspace.updated', ws)

    return removal
  }

  /**
   * Runs the planned steps from the current one, announcing each result (which starts the next
   * step's clock); a step that fails is recorded and the rest still run. Then archives the row
   * and sends workspace.removed with the failures. Stops where it is when the daemon shuts down, to be resumed by start().
   */
  private async runRemoval(id: string): Promise<void> {
    try {
      const ws = this.opts.store.getWorkspace(id)

      if (!ws?.removal) return
      const project = this.opts.store.getProject(ws.projectId)
      let removal = ws.removal

      for (const step of removal.plan.slice(removal.done.length)) {
        const started = Date.now()
        const error = await this.runStep(step, ws, project)

        if (this.closed) return
        const result: RemovalResult = { step, ms: Date.now() - started }

        if (error) {
          result.error = error
          this.log(`workspace ${id} removal: ${step} failed: ${error}`)
        }

        removal = this.saveRemoval(id, {
          ...removal,
          done: [...removal.done, result],
          since: new Date().toISOString()
        })
      }

      this.opts.store.archiveWorkspace(id, new Date().toISOString())
      this.opts.status.forget(id)
      const failed = removal.done.filter((r): r is RemovalFailure => r.error !== undefined)
      this.log(
        `workspace ${id} removed${failed.length ? ` (${failed.length} step(s) failed)` : ''}`
      )
      this.opts.emit('workspace.removed', failed.length ? { id, failed } : { id })
    } catch (err) {
      if (!this.closed) this.log(`workspace ${id} removal stopped: ${errorMessage(err)}`)
    }
  }

  /** Runs one removal step; returns why it failed, or undefined. Never throws. */
  private async runStep(
    step: RemovalStep,
    ws: Workspace,
    project: Project | undefined
  ): Promise<string | undefined> {
    try {
      switch (step) {
        case 'terminals':
          this.killAll(ws.id)

          return undefined
        case 'teardown':
          return project ? await this.teardown(ws, project) : undefined
        case 'worktree':
          return project ? await this.removeWorktree(ws, project) : 'its project is gone'
        case 'branch': {
          if (!project) return 'its project is gone'

          // Removed before its worktree step made the branch.
          if (ws.preparation && !(await refExists(project.path, `refs/heads/${ws.branch}`))) {
            return undefined
          }

          const deleted = await git(project.path, ['branch', '-D', ws.branch])

          return deleted.ok ? undefined : `git branch -D ${ws.branch} failed: ${deleted.stderr}`
        }
      }
    } catch (err) {
      return errorMessage(err)
    }
  }

  /** Kills the workspace's terminals and a setup command still running. */
  private killAll(id: string): void {
    this.opts.killTerminals(id)
    const setup = this.setups.get(id)

    if (setup) {
      this.setups.delete(id)
      killGroup(setup)
    }
  }

  /** The repo's teardown hook, killed after teardown_timeout_seconds; skipped when the worktree is gone. */
  private async teardown(ws: Workspace, project: Project): Promise<string | undefined> {
    const command = this.repoCommand(project, 'teardown')

    if (!command || !fs.existsSync(ws.path)) return undefined
    const seconds = this.configOrDefaults().teardownTimeoutSeconds
    const child = this.runInWorktree(ws, 'teardown', command)
    this.teardowns.set(ws.id, child)
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      killGroup(child)
    }, seconds * 1000)

    const exit = await exited(child)

    clearTimeout(timer)

    if (this.teardowns.get(ws.id) === child) this.teardowns.delete(ws.id)

    if (timedOut) return `timed out after ${seconds}s`

    if (exit.error) return exit.error

    return exit.code === 0 || this.closed ? undefined : `exited with code ${exit.code ?? 'null'}`
  }

  /**
   * Moves the worktree into `<worktree_root>/.trash/<id>` (instant on the same volume) and
   * prunes git's record of it; the folder is deleted afterwards with nothing waiting on it.
   * When the move fails, `git worktree remove --force` deletes it in place.
   */
  private async removeWorktree(ws: Workspace, project: Project): Promise<string | undefined> {
    if (!fs.existsSync(ws.path)) {
      // Moved already (a removal resumed after a restart), or deleted by hand.
      const pruned = await git(project.path, ['worktree', 'prune'])

      return pruned.ok ? undefined : `git worktree prune failed: ${pruned.stderr}`
    }

    const trash = join(this.trashDir(), ws.id)
    let moveError = ''

    try {
      await fs.promises.mkdir(dirname(trash), { recursive: true })
      await fs.promises.rm(trash, { recursive: true, force: true })
      await fs.promises.rename(ws.path, trash)
    } catch (err) {
      moveError = errorMessage(err)
    }

    if (!moveError) {
      this.discard(trash)
      const pruned = await git(project.path, ['worktree', 'prune'])

      return pruned.ok ? undefined : `git worktree prune failed: ${pruned.stderr}`
    }

    this.log(`moving ${ws.path} to the trash failed (${moveError}); removing it in place`)
    const removed = await git(project.path, ['worktree', 'remove', '--force', ws.path])
    await git(project.path, ['worktree', 'prune'])

    if (removed.ok) return undefined

    return `could not move ${ws.path} to the trash (${moveError}) or remove it (${removed.stderr}); it is still there`
  }

  /** Deletes a trash folder in the background; a failure is logged and swept at the next start. */
  private discard(path: string): void {
    void fs.promises
      .rm(path, { recursive: true, force: true })
      .catch((err: Error) => this.log(`deleting ${path} failed: ${errorMessage(err)}`))
  }

  /** The user config, or its defaults while the file cannot be read: a removal goes on regardless. */
  private configOrDefaults(): UserConfig {
    try {
      return this.opts.config()
    } catch {
      return defaultConfig({ queHome: this.opts.paths.home })
    }
  }

  /** Where removed worktrees go before they are deleted: `<worktree_root>/.trash`. */
  private trashDir(): string {
    return join(this.configOrDefaults().worktreeRoot, '.trash')
  }

  /** Stops preparations and setup and teardown commands still running (daemon shutdown); preparations and removals resume at the next start. */
  close(): void {
    this.closed = true

    for (const { stop } of this.preparations.values()) stop.abort()

    for (const child of this.setups.values()) killGroup(child)

    for (const child of this.teardowns.values()) killGroup(child)
    this.setups.clear()
    this.teardowns.clear()
  }
}

/** A removal at the first of its planned steps, starting now. */
function newRemoval(plan: RemovalStep[]): Removal {
  return { plan, since: new Date().toISOString(), done: [] }
}

/** The preparation with one more step done, and the next step's clock starting now. */
function withResult(preparation: Preparation, result: PreparationResult): Preparation {
  return {
    ...preparation,
    done: [...preparation.done, result],
    since: new Date().toISOString()
  }
}

/** Settles when `signal` aborts, and never otherwise. */
function whenAborted(signal: AbortSignal): Promise<undefined> {
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(undefined), { once: true })
  })
}

/** The child's exit: its code, or the spawn error's message. */
function exited(child: ChildProcess): Promise<{ code: number | null; error?: string }> {
  return new Promise((resolve) => {
    child.once('exit', (code) => resolve({ code }))
    child.once('error', (err) => resolve({ code: null, error: err.message }))
  })
}

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return

  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    // Already gone.
  }
}

/** Copies gitignored files/dirs listed in worktree_include; missing ones are skipped. */
function copyIncludes(from: string, to: string, entries: string[], log: (m: string) => void): void {
  for (const entry of entries) {
    const rel = normalize(entry).replace(/\/+$/, '')

    if (!rel || rel === '.' || isAbsolute(rel) || rel === '..' || rel.startsWith('../')) {
      log(`worktree_include: skipping unsafe path ${entry}`)
      continue
    }

    const src = join(from, rel)

    if (!fs.existsSync(src)) continue
    const dest = join(to, rel)
    fs.mkdirSync(dirname(dest), { recursive: true })
    fs.cpSync(src, dest, { recursive: true, force: true, verbatimSymlinks: true })
  }
}

/** What the claude wrapper adds to a session, from the config and que.toml. */
export type SessionEnv = {
  /** The configured instructions file, whether or not it exists yet. */
  QUE_INSTRUCTIONS?: string
  /** que.toml's permission_mode, else default_permission_mode, gated by allow_bypass_permissions. */
  QUE_PERMISSION_MODE?: string
}

/**
 * QUE_INSTRUCTIONS and QUE_PERMISSION_MODE for a workspace session; each is
 * omitted when its config is not set.
 */
export function sessionEnv(
  config: Pick<UserConfig, 'instructionsFile' | 'defaultPermissionMode' | 'allowBypassPermissions'>,
  repo: Pick<RepoConfig, 'permissionMode'>
): SessionEnv {
  const env: SessionEnv = {}

  if (config.instructionsFile) env.QUE_INSTRUCTIONS = config.instructionsFile

  if (repo.permissionMode || config.defaultPermissionMode) {
    env.QUE_PERMISSION_MODE = resolvePermissionMode(repo, config).mode
  }

  return env
}

/** The variables que adds to every terminal's environment, loose or a workspace's. */
export type TerminalEnv = {
  QUE_SOCKET: string
  QUE_HOME: string
  PATH: string
  /** The claude the hooks wrapper runs. */
  QUE_REAL_CLAUDE?: string
  /** Set for zsh: que's startup files, which source the user's own. */
  ZDOTDIR?: string
  QUE_USER_ZDOTDIR?: string
}

/** The variables que adds to a workspace terminal's environment. */
export type WorkspaceTerminalEnv = SessionEnv & TerminalEnv & { QUE_WORKSPACE_ID: string }

/**
 * Extra environment for every terminal the daemon opens: the hooks wrapper
 * first on PATH, so a claude started there reports its session.
 */
export function terminalEnv(paths: QuePaths, socket: string): TerminalEnv {
  const env: TerminalEnv = {
    QUE_SOCKET: socket,
    QUE_HOME: paths.home,
    PATH: `${paths.binDir}:${process.env.PATH ?? ''}`
  }

  // The claude the daemon itself would run; the wrapper prefers it, so a
  // profile that reorders PATH cannot swap in a different binary.
  const real = findOnPath('claude', process.env.PATH, [paths.binDir])

  if (real) env.QUE_REAL_CLAUDE = real

  if (basename(loginShell()) === 'zsh') {
    env.ZDOTDIR = zshDir(paths)

    if (process.env.ZDOTDIR) env.QUE_USER_ZDOTDIR = process.env.ZDOTDIR
  }

  return env
}

/** Extra environment for a workspace terminal: every terminal's, plus the workspace and its session. */
export function workspaceTerminalEnv(
  ws: Workspace,
  paths: QuePaths,
  socket: string,
  session: SessionEnv = {}
): WorkspaceTerminalEnv {
  return { ...session, ...terminalEnv(paths, socket), QUE_WORKSPACE_ID: ws.id }
}
