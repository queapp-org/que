// Keeps each workspace's pull requests fresh: the session's pull requests are
// those whose head is any branch the worktree has had checked out (`gh pr list`),
// plus each one the session created with its own `gh pr create` (seen in a
// hook), looked up by number (`gh pr view <n>`) when it is not
// on those branches. One already stored is kept when its branch moves on. Stores
// what changed and emits workspace.updated. Each tick lists a project's newest
// pull requests without their checks, then asks for checks only on the heads that
// hold an open or draft one (or one that just settled), branch by branch.
// Also answers workspace.prThread: each pull request's conversation is fetched
// on demand and cached until the tracker sees its updatedAt move. After a check,
// the open and draft pull requests whose conversation is not cached for their
// updatedAt are fetched in the background (a few at a time), so each pull
// request carries its comment count and newest comment time.
// And workspace.checkPrs: one workspace checked now, failing with gh's message when a call fails.
import type { UserConfig } from '../shared/config'
import { firstLine, run } from '../shared/exec'
import { preparationUnfinished } from '../shared/preparation'
import type { HookEvent } from '../shared/protocol'
import type { JsonValue, PrThread, PullRequest, Workspace } from '../shared/types'
import { ghFailed, notFound } from './errors'
import { withBranch } from './branch-history'
import {
  commentCounts,
  currentPullRequest,
  isSettled,
  keepsStoredChecks,
  parsePullRequest,
  PR_LIST_CAP,
  pullRequestList,
  samePullRequests
} from './pr-state'
import {
  decodePullRequest,
  decodePullRequests,
  FIELDS,
  type GhPullRequest,
  LIST_FIELDS
} from './pr-state.decode'
import { Poller } from './poller'
import {
  createdPullRequests,
  githubRepo,
  prCreateCall,
  printsPullRequest,
  type Repo
} from './pr-created'
import { jsonPages, parsePrThread } from './pr-thread'
import { decodeLineComments, decodePrView } from './pr-thread.decode'
import type { EventBus } from './bus'
import type { Store } from './store'
import { git, type WorkspaceManager } from './workspaces'
import { errorMessage } from '../shared/errors.decode'
import { prUrlNumber } from '../shared/pr-url'

/** A project's tick lists at most this many of its most recent pull requests. */
const LIST_LIMIT = 100

/** A merged or closed pull request is only re-checked on every Nth tick. */
const SETTLED_EVERY = 5

/** At most this many conversations are fetched in the background at once. */
const PREFETCH_LIMIT = 3

export interface PrServiceOptions {
  store: Store
  workspaces: Pick<WorkspaceManager, 'get' | 'project' | 'syncBranch'>
  /** The daemon's bus: a removed workspace is forgotten. */
  bus: EventBus
  config: () => UserConfig
  log?: (msg: string) => void
}

/** Runs `gh <args>` in cwd and parses what it prints (as JSON, unless `parse` says otherwise). */
async function ghJson(
  args: string[],
  cwd: string,
  signal: AbortSignal,
  parse: (stdout: string) => JsonValue = (out) => JSON.parse(out) as JsonValue
): Promise<JsonValue> {
  const r = await run('gh', args, { cwd, timeoutMs: 15_000, signal, maxBuffer: 32 * 1024 * 1024 })

  if (!r.ok) throw new Error(firstLine(r.stderr, r.error))

  try {
    return parse(r.stdout)
  } catch {
    throw new Error('gh printed output that is not JSON')
  }
}

/**
 * The newest PR_LIST_CAP pull requests for `branch`, checks included, or with no branch the
 * repository's newest LIST_LIMIT without their checks (LIST_FIELDS).
 */
async function ghPrList(
  branch: string | null,
  cwd: string,
  signal: AbortSignal
): Promise<unknown[]> {
  const args = [
    'pr',
    'list',
    ...(branch ? ['--head', branch] : []),
    '--state',
    'all',
    '--limit',
    String(branch ? PR_LIST_CAP : LIST_LIMIT),
    '--json',
    branch ? FIELDS : LIST_FIELDS
  ]

  const parsed = await ghJson(args, cwd, signal)

  if (!Array.isArray(parsed)) throw new Error('gh printed output that is not JSON')

  return parsed
}

/**
 * `gh api --paginate` prints one JSON array per page, back to back; this joins
 * them. A single page parses as is.
 */
function ghLineComments(number: number, cwd: string, signal: AbortSignal): Promise<JsonValue> {
  return ghJson(
    ['api', `repos/{owner}/{repo}/pulls/${number}/comments`, '--paginate'],
    cwd,
    signal,
    (out) => jsonPages(out).flatMap((page) => (Array.isArray(page) ? page : [page])) as JsonValue
  )
}

interface CachedThread {
  thread: PrThread
  forUpdatedAt: string | null
}

/** One workspace's pull requests by number, in a map keyed by workspace id. */
type ByWorkspace<V> = Map<string, Map<number, V>>

/** The workspace's map in `outer`, made on first use. */
function inner<V>(outer: ByWorkspace<V>, id: string): Map<number, V> {
  let map = outer.get(id)

  if (!map) {
    map = new Map()
    outer.set(id, map)
  }

  return map
}

/** One head's pull requests, or gh's message when listing them failed (logged). */
type Listing = { prs: GhPullRequest[] } | { error: string }

/** One listing of a project's pull requests, grouped by head branch; `full` when it hit LIST_LIMIT. */
interface ProjectListing {
  byBranch: Map<string, GhPullRequest[]>
  full: boolean
}

export class PrService {
  private polling = false
  private tickCount = 0
  /** Workspaces whose last check failed (and were logged), until one succeeds. */
  private failing = new Set<string>()
  /** Projects whose last listing failed (and were logged), until one succeeds. */
  private failingListings = new Set<string>()
  /** Each pull request's last fetched conversation, valid while its updatedAt holds. */
  private threads: ByWorkspace<CachedThread> = new Map()
  private threadFetches: ByWorkspace<Promise<PrThread>> = new Map()
  /** Each workspace's checkNow while it runs, so callers at the same time share one check. */
  private checking = new Map<string, Promise<string | null>>()
  /** Each project's origin repository by project path, looked up once (until a lookup fails). */
  private origins = new Map<string, Promise<Repo | null>>()
  /** Conversations waiting to be fetched in the background, and the same as `<workspace id>:<number>`. */
  private prefetchQueue: Array<{ id: string; number: number }> = []
  private prefetchQueued = new Set<string>()
  private prefetching = 0

  private readonly poller = new Poller({
    intervalMs: () => Math.max(100, this.opts.config().prPollSeconds * 1000),
    tick: () => this.tick()
  })

  constructor(private opts: PrServiceOptions) {
    opts.bus.on('workspace.removed', ({ id }) => this.forget(id))
  }

  start(): void {
    this.poller.start()
  }

  stop(): void {
    this.poller.stop()
  }

  private get stopped(): boolean {
    return this.poller.stopped
  }

  /**
   * One pass over the workspaces: each branch re-read, then one `gh pr list` per project, and one
   * per head whose checks it cannot give.
   */
  async tick(): Promise<void> {
    if (this.polling) return
    this.polling = true

    try {
      const n = this.tickCount++
      const due = n % SETTLED_EVERY === 0
      // A workspace still being prepared has no worktree to ask in yet.
      const listed = this.opts.store.listWorkspaces().filter((ws) => !preparationUnfinished(ws))
      const checked = listed.filter((ws) => due || ws.pr === null || !isSettled(ws.pr))
      const byProject = new Map<string, Workspace[]>()

      for (const ws of await Promise.all(checked.map((ws) => this.sync(ws)))) {
        const list = byProject.get(ws.projectId)

        if (list) list.push(ws)
        else byProject.set(ws.projectId, [ws])
      }

      for (const list of byProject.values()) {
        if (this.stopped) return
        await this.poller.track(this.checkProject(list, due))
      }
    } finally {
      this.polling = false
    }
  }

  /** Checks one workspace now; the first gh failure's message (already logged), else null. */
  private async refresh(id: string): Promise<string | null> {
    if (this.stopped) return null
    const ws = this.opts.store.getWorkspace(id)

    return ws && !ws.archivedAt ? this.check(await this.sync(ws)) : null
  }

  /**
   * Checks one workspace now and answers it as stored after the check. Fails with gh's message
   * when a call failed; what the check did settle is stored anyway.
   */
  async checkNow(id: string): Promise<Workspace> {
    let running = this.checking.get(id)

    if (!running) {
      running = this.refresh(id).finally(() => this.checking.delete(id))
      this.checking.set(id, running)
    }

    const error = await running

    if (error !== null) throw ghFailed(error)

    return this.opts.workspaces.get(id)
  }

  /**
   * The conversation of the workspace's pull request `number`. Cached until the tracker sees
   * that pull request change, or fetched now with `refresh`. Null when the workspace has no
   * such pull request.
   */
  async thread(id: string, number: number, refresh = false): Promise<PrThread | null> {
    const ws = this.opts.store.getWorkspace(id)

    if (!ws || ws.archivedAt) throw notFound(`no workspace ${id}`)
    const pr = ws.prs.find((p) => p.number === number)

    if (!pr) return null
    const cached = this.threads.get(id)?.get(number)

    if (!refresh && cached && cached.forUpdatedAt === (pr.updatedAt ?? null)) return cached.thread

    const fetches = inner(this.threadFetches, id)
    const running = fetches.get(number)

    if (running) return running
    const fetch = this.fetchThread(ws, pr).finally(() => fetches.delete(number))
    fetches.set(number, fetch)

    return fetch
  }

  /** Drops what is cached for a removed workspace. */
  forget(id: string): void {
    this.threads.delete(id)
    this.threadFetches.delete(id)
  }

  /**
   * Queues the conversations of a workspace's open and draft pull requests that are not cached
   * for their updatedAt, and starts fetching them a few at a time. A failure is left for the
   * next check.
   */
  private prefetch(id: string, prs: PullRequest[]): void {
    const cached = this.threads.get(id)

    for (const pr of prs) {
      const key = `${id}:${pr.number}`

      if (isSettled(pr) || this.prefetchQueued.has(key)) continue

      if (cached?.get(pr.number)?.forUpdatedAt === (pr.updatedAt ?? null)) continue
      this.prefetchQueued.add(key)
      this.prefetchQueue.push({ id, number: pr.number })
    }

    this.drainPrefetch()
  }

  private drainPrefetch(): void {
    while (this.prefetching < PREFETCH_LIMIT && !this.stopped) {
      const next = this.prefetchQueue.shift()

      if (!next) return
      this.prefetching++
      void this.poller.track(
        this.thread(next.id, next.number)
          .catch(() => null)
          .finally(() => {
            this.prefetching--
            this.prefetchQueued.delete(`${next.id}:${next.number}`)
            this.drainPrefetch()
          })
      )
    }
  }

  /** The pull request with the comment counts of its cached conversation, else as `stored` had them. */
  private withCounts(id: string, pr: PullRequest, stored: PullRequest[]): PullRequest {
    const cached = this.threads.get(id)?.get(pr.number)

    if (cached) return { ...pr, ...commentCounts(cached.thread) }
    const old = stored.find((p) => p.number === pr.number)

    return old ? { ...pr, comments: old.comments, commentedAt: old.commentedAt } : pr
  }

  /** Stores and announces a freshly fetched conversation's counts on its pull request. */
  private storeCounts(id: string, thread: PrThread): void {
    const ws = this.opts.store.getWorkspace(id)

    if (!ws || ws.archivedAt) return
    const counts = commentCounts(thread)
    const prs = ws.prs.map((p) => (p.number === thread.number ? { ...p, ...counts } : p))

    if (samePullRequests(ws.prs, prs)) return
    this.opts.store.setWorkspacePrs(id, prs)
    this.opts.bus.emit('workspace.updated', { ...ws, pr: currentPullRequest(prs), prs })
  }

  /** Drops the cached conversations of a workspace's pull requests not in `keep`. */
  private prune(id: string, keep: PullRequest[]): void {
    const cached = this.threads.get(id)

    if (!cached) return
    const kept = new Set(keep.map((pr) => pr.number))

    for (const number of cached.keys()) if (!kept.has(number)) cached.delete(number)
  }

  private async fetchThread(ws: Workspace, pr: PullRequest): Promise<PrThread> {
    let view: unknown
    let lines: unknown

    try {
      ;[view, lines] = await Promise.all([
        ghJson(
          ['pr', 'view', String(pr.number), '--json', 'comments,reviews'],
          ws.path,
          this.poller.signal
        ),
        ghLineComments(pr.number, ws.path, this.poller.signal)
      ])
    } catch (err) {
      throw ghFailed(errorMessage(err))
    }

    const thread = parsePrThread(
      decodePrView(view),
      decodeLineComments(lines),
      ws.id,
      pr.number,
      new Date().toISOString()
    )

    inner(this.threads, ws.id).set(pr.number, { thread, forUpdatedAt: pr.updatedAt ?? null })
    this.storeCounts(ws.id, thread)

    return thread
  }

  /** Resolves once every check that was running when stop() was called has ended. */
  drain(): Promise<void> {
    return this.poller.drain()
  }

  /** The workspace with the branch its worktree has checked out; as stored when that cannot be read. */
  private sync(ws: Workspace): Promise<Workspace> {
    return this.poller.track(this.opts.workspaces.syncBranch(ws.id).catch(() => ws))
  }

  /** Checks a workspace's heads and linked pull requests; the first gh failure's message, else null. */
  private check(ws: Workspace): Promise<string | null> {
    return this.poller.track(this.checkHeads(ws, true, (head) => this.list(ws, head)))
  }

  /**
   * The branches que may ask about for a workspace: each it has had checked out, never the
   * project's default branch or a configured `protected_branches` entry.
   */
  private heads(ws: Workspace): string[] {
    const project = this.opts.workspaces.project(ws.projectId)
    const { protectedBranches } = this.opts.config()

    return withBranch(ws.branches, ws.branch).filter(
      (b) => b !== project.defaultBranch && !protectedBranches.includes(b)
    )
  }

  /**
   * Checks one project's workspaces with one listing, grouped by head branch, which carries no
   * checks. A workspace with no branch to ask about still has the pull requests it created looked
   * up. `due`: a settled pull request is re-checked on this tick.
   */
  private async checkProject(list: Workspace[], due: boolean): Promise<void> {
    const listing = await this.listProject(list)

    for (const ws of list) {
      if (this.stopped) return
      await this.checkHeads(ws, due, (head) => this.fromListing(ws, head, listing, due))
    }
  }

  /**
   * A head's pull requests as the project's listing has them. The head is asked about on its
   * own, checks included, when the listing cannot answer: it failed, a full page (LIST_LIMIT)
   * misses the head (which may hold an older pull request), or the head holds a pull request
   * whose checks are not kept from before (keepsStoredChecks).
   */
  private fromListing(
    ws: Workspace,
    head: string,
    listing: ProjectListing | null,
    due: boolean
  ): Listing | Promise<Listing | null> {
    if (!listing) return this.list(ws, head)
    const prs = listing.byBranch.get(head)

    if (!prs) return listing.full ? this.list(ws, head) : { prs: [] }

    return prs.every((pr) => keepsStoredChecks(pr, ws.prs, due)) ? { prs } : this.list(ws, head)
  }

  /**
   * The project's newest pull requests by head branch, listed from a workspace with a branch to
   * ask about (none listed when none has one); null when gh failed (logged for the project).
   */
  private async listProject(list: Workspace[]): Promise<ProjectListing | null> {
    const asking = list.find((ws) => this.heads(ws).length > 0)
    const byBranch = new Map<string, GhPullRequest[]>()

    if (!asking) return { byBranch, full: false }
    let items: unknown[]

    try {
      items = await ghPrList(null, asking.path, this.poller.signal)
    } catch (err) {
      this.listingFailed(asking.projectId, errorMessage(err))

      return null
    }

    if (this.failingListings.delete(asking.projectId)) {
      this.opts.log?.(`pr listing recovered for project ${asking.projectId}`)
    }

    for (const item of items) {
      const pr = decodePullRequest(item)

      if (!pr?.headRefName) continue
      const prs = byBranch.get(pr.headRefName)

      if (prs) prs.push(pr)
      else byBranch.set(pr.headRefName, [pr])
    }

    return { byBranch, full: items.length >= LIST_LIMIT }
  }

  /**
   * Settles a workspace with the pull requests `listed` finds on each of its heads; none when one
   * listing failed. Answers the first gh failure's message, else null.
   */
  private async checkHeads(
    ws: Workspace,
    due: boolean,
    listed: (head: string) => Listing | Promise<Listing | null>
  ): Promise<string | null> {
    const lists = await Promise.all(this.heads(ws).map(async (head) => listed(head)))
    const raw: GhPullRequest[] = []

    for (const listing of lists) {
      if (listing === null) return null

      if ('error' in listing) return listing.error
      raw.push(...listing.prs)
    }

    return this.stopped ? null : this.settle(ws, raw, due)
  }

  /** The pull requests whose head is `branch`, or why gh failed (logged); null when the service stopped. */
  private async list(ws: Workspace, branch: string): Promise<Listing | null> {
    try {
      const items = await ghPrList(branch, ws.path, this.poller.signal)

      return this.stopped ? null : { prs: decodePullRequests(items) }
    } catch (err) {
      const error = errorMessage(err)
      this.failed(ws, error)

      return { error }
    }
  }

  /** Logs a project's first failed listing (until one succeeds). */
  private listingFailed(projectId: string, message: string): void {
    if (this.stopped || this.failingListings.has(projectId)) return
    this.failingListings.add(projectId)
    this.opts.log?.(`pr listing failed for project ${projectId}: ${message}; asking each branch`)
  }

  /** Logs a workspace's first failed check (until one succeeds). */
  private failed(ws: Workspace, message: string): void {
    if (this.stopped || this.failing.has(ws.id)) return
    this.failing.add(ws.id)
    this.opts.log?.(`pr check failed for ${ws.id}: ${message}`)
  }

  /**
   * The pull requests the session created (prUrls) that are not among
   * `onBranch`, each looked up by number. A settled one
   * already stored is reused until `due`; one that cannot be looked up keeps
   * its stored copy, and the first failure is reported in `error`.
   */
  private async linked(
    ws: Workspace,
    onBranch: PullRequest[],
    due: boolean,
    checkedAt: string
  ): Promise<{ prs: PullRequest[]; error: string | null }> {
    const known = new Set(onBranch.map((pr) => pr.number))
    const numbers = new Set<number>()

    for (const url of ws.prUrls) {
      const n = prUrlNumber(url)

      if (n !== null && !known.has(n)) numbers.add(n)
    }

    const stored = new Map(ws.prs.map((pr) => [pr.number, pr]))

    const looked = await Promise.all(
      [...numbers].map(async (n): Promise<{ pr: PullRequest | null; error: string | null }> => {
        const old = stored.get(n) ?? null

        if (old && isSettled(old) && !due) return { pr: old, error: null }

        try {
          const raw = decodePullRequest(
            await ghJson(['pr', 'view', String(n), '--json', FIELDS], ws.path, this.poller.signal)
          )

          return { pr: raw ? parsePullRequest(raw, checkedAt) : old, error: null }
        } catch (err) {
          return { pr: old, error: errorMessage(err) }
        }
      })
    )

    return {
      prs: looked.flatMap(({ pr }) => (pr ? [pr] : [])),
      error: looked.find(({ error }) => error !== null)?.error ?? null
    }
  }

  /**
   * Stores and announces the pull requests `gh` reported for a workspace's
   * branches, joined with those the session created elsewhere and those stored
   * before, and the current one among them.
   */
  private async settle(ws: Workspace, raw: GhPullRequest[], due: boolean): Promise<string | null> {
    const checkedAt = new Date().toISOString()
    // A settled one listed without its checks keeps those stored (see fromListing).
    const onBranch = raw.map((r) => parsePullRequest(r, checkedAt, ws.prs))
    const extra = await this.linked(ws, onBranch, due, checkedAt)

    if (this.stopped) return null

    if (extra.error !== null) this.failed(ws, extra.error)
    else if (this.failing.delete(ws.id)) this.opts.log?.(`pr check recovered for ${ws.id}`)
    const current = this.opts.store.getWorkspace(ws.id)

    if (!current || current.archivedAt) return null

    const prs = pullRequestList([...onBranch, ...extra.prs], current.prs).map((pr) =>
      this.withCounts(ws.id, pr, current.prs)
    )

    this.prune(ws.id, prs)

    if (!samePullRequests(current.prs, prs)) {
      this.opts.store.setWorkspacePrs(ws.id, prs)
      this.opts.bus.emit('workspace.updated', { ...current, pr: currentPullRequest(prs), prs })
    }

    // After storing, so each fetch sees the updatedAt it caches the conversation for.
    this.prefetch(ws.id, prs)

    return extra.error
  }

  /**
   * Records the pull requests a hook event shows the workspace's session (or one of its
   * subagents) creating with `gh pr create` on the project's origin, and checks them now.
   */
  async hook(id: string, event: HookEvent): Promise<void> {
    const call = prCreateCall(event)

    if (this.stopped || !call || !printsPullRequest(call)) return
    const ws = this.opts.store.getWorkspace(id)

    if (!ws || ws.archivedAt) return
    const repo = await this.origin(this.opts.workspaces.project(ws.projectId).path)
    const urls = repo ? createdPullRequests(call, repo) : []

    if (urls.length === 0 || !this.opts.store.addWorkspacePrUrls(id, urls)) return
    this.opts.log?.(`workspace ${id} created ${urls.join(', ')}`)
    this.opts.bus.emit('workspace.updated', this.opts.workspaces.get(id))
    await this.refresh(id)
  }

  /**
   * The GitHub repository a project's origin names; null for none. Hooks waiting on the same
   * lookup resume in the order they asked, so what they record keeps the order it was made in.
   */
  private origin(path: string): Promise<Repo | null> {
    const known = this.origins.get(path)

    if (known) return known

    // A project may gain an origin later: only a repository found is kept.
    const found = git(path, ['remote', 'get-url', 'origin'], 10_000).then((r) => {
      const repo = r.ok ? githubRepo(r.stdout) : null

      if (repo === null) this.origins.delete(path)

      return repo
    })

    this.origins.set(path, found)

    return found
  }
}
