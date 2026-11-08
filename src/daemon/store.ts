// SQLite store (node:sqlite) for projects, workspaces, hook events, and kv. A
// small typed layer over prepared statements; migrations are numbered and
// recorded in the `migrations` table.
import { randomBytes } from 'node:crypto'
import {
  DatabaseSync,
  type SQLInputValue,
  type StatementResultingChanges,
  type StatementSync
} from 'node:sqlite'
import { isArtifactUrl } from '../shared/artifact-url'
import { isObj, num, objects, str, strings } from '../shared/json.decode'
import type {
  Artifact,
  BackgroundTask,
  JsonValue,
  Preparation,
  PreparationStep,
  Project,
  PullRequest,
  QuietKind,
  QuietUnlock,
  Removal,
  RemovalStep,
  StepResult,
  StepRun,
  Ticket,
  TitleSource,
  Workspace,
  WorkspaceStatus
} from '../shared/types'
import { PREPARATION_STEPS, REMOVAL_STEPS, TITLE_SOURCES } from '../shared/types'
import { appendNew } from './branch-history'
import { currentPullRequest } from './pr-state'

const HOOK_EVENTS_PER_WORKSPACE = 500

const ARTIFACTS_PER_WORKSPACE = 50

/** Applied in order by index and recorded in `migrations`: append only, never edit or reorder. */
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE projects (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     path TEXT NOT NULL UNIQUE,
     default_branch TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE TABLE workspaces (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL REFERENCES projects(id),
     name TEXT NOT NULL,
     branch TEXT NOT NULL,
     path TEXT NOT NULL UNIQUE,
     base_ref TEXT NOT NULL,
     status TEXT NOT NULL,
     status_reason TEXT,
     status_at TEXT NOT NULL,
     last_activity_at TEXT,
     session_id TEXT,
     created_at TEXT NOT NULL,
     archived_at TEXT,
     UNIQUE(project_id, name)
   );
   CREATE TABLE hook_events (
     id INTEGER PRIMARY KEY,
     workspace_id TEXT NOT NULL,
     session_id TEXT,
     event TEXT NOT NULL,
     payload TEXT NOT NULL,
     received_at TEXT NOT NULL
   );
   CREATE INDEX hook_events_workspace ON hook_events(workspace_id, id);`,
  `CREATE TABLE tasks (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL,
     workspace_id TEXT,
     title TEXT NOT NULL,
     brief TEXT NOT NULL,
     source TEXT NOT NULL,
     resume_session_id TEXT,
     state TEXT NOT NULL,
     reason TEXT,
     session_id TEXT,
     pid INTEGER,
     attempts INTEGER NOT NULL DEFAULT 0,
     cost_usd REAL NOT NULL DEFAULT 0,
     turns INTEGER NOT NULL DEFAULT 0,
     max_turns INTEGER NOT NULL,
     max_budget_usd REAL NOT NULL,
     permission_mode TEXT,
     branch TEXT,
     pr_url TEXT,
     result_text TEXT,
     last_activity_at TEXT,
     started_at TEXT,
     finished_at TEXT,
     paused_until TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX tasks_state ON tasks(state, created_at);
   CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  `ALTER TABLE workspaces ADD COLUMN pr_url TEXT;`,
  `CREATE TABLE quiet_unlocks (
     id INTEGER PRIMARY KEY,
     at TEXT NOT NULL,
     minutes REAL NOT NULL,
     why TEXT,
     until TEXT NOT NULL,
     ended_at TEXT
   );`,
  `ALTER TABLE workspaces ADD COLUMN pr_json TEXT;`,
  `CREATE TABLE workspace_status_log (
     id INTEGER PRIMARY KEY,
     workspace_id TEXT NOT NULL,
     status TEXT NOT NULL,
     reason TEXT,
     at TEXT NOT NULL
   );
   CREATE INDEX workspace_status_log_ws ON workspace_status_log(workspace_id, at);
   INSERT INTO workspace_status_log (workspace_id, status, reason, at)
     SELECT id, status, status_reason, status_at FROM workspaces;`,
  `CREATE TABLE tickets (
     key TEXT PRIMARY KEY,
     summary TEXT NOT NULL,
     status TEXT NOT NULL,
     status_category TEXT NOT NULL,
     priority TEXT,
     type TEXT NOT NULL,
     assignee TEXT,
     project_key TEXT NOT NULL,
     project_name TEXT NOT NULL,
     url TEXT NOT NULL,
     labels_json TEXT NOT NULL,
     updated_at TEXT,
     synced_at TEXT NOT NULL,
     workspace_id TEXT
   );`,
  `ALTER TABLE tickets ADD COLUMN position INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE tickets ADD COLUMN parent_key TEXT;`,
  `ALTER TABLE tickets ADD COLUMN level TEXT NOT NULL DEFAULT 'standard';`,
  `ALTER TABLE tickets ADD COLUMN assigned INTEGER NOT NULL DEFAULT 1;`,
  `ALTER TABLE tickets ADD COLUMN parent_checked_at TEXT;`,
  `ALTER TABLE workspaces ADD COLUMN title TEXT;
   ALTER TABLE workspaces ADD COLUMN brief TEXT;`,
  `ALTER TABLE workspaces ADD COLUMN title_source TEXT;`,
  `ALTER TABLE workspaces ADD COLUMN prs_json TEXT;`,
  `ALTER TABLE workspaces ADD COLUMN finished_at TEXT;
   ALTER TABLE workspaces ADD COLUMN seen_at TEXT;`,
  `ALTER TABLE workspaces ADD COLUMN background_json TEXT;`,
  `CREATE TABLE quiet_manual (
     id INTEGER PRIMARY KEY,
     at TEXT NOT NULL,
     until TEXT NOT NULL,
     ended_at TEXT
   );
   ALTER TABLE quiet_unlocks ADD COLUMN kind TEXT NOT NULL DEFAULT 'scheduled';`,
  `DROP TABLE IF EXISTS tasks;
   DELETE FROM kv WHERE key IN ('queue.open', 'queue.opened_at', 'concurrency');`,
  `ALTER TABLE workspaces ADD COLUMN removal_json TEXT;`,
  `ALTER TABLE workspaces ADD COLUMN pr_urls_json TEXT;
   UPDATE workspaces SET pr_urls_json = json_array(pr_url) WHERE pr_url IS NOT NULL;
   ALTER TABLE workspaces ADD COLUMN branches_json TEXT;`,
  `ALTER TABLE workspaces ADD COLUMN preparation_json TEXT;`,
  `ALTER TABLE workspaces ADD COLUMN artifacts_json TEXT;`
]

const STATUS_LOG_RETENTION_MS = 30 * 24 * 3_600_000

/** A stored title source; one a retired release wrote (`summary`) reads as unset, like a row from before sources. */
function titleSourceOf(v: string | null): TitleSource | undefined {
  return v && (TITLE_SOURCES as readonly string[]).includes(v) ? (v as TitleSource) : undefined
}

export interface StatusLogRow {
  status: WorkspaceStatus
  reason: string | null
  at: string
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

/** `<prefix>` + 12 random base32 characters. */
export function newId(prefix: 'prj_' | 'ws_'): string {
  const bytes = randomBytes(12)
  let out = prefix

  for (const b of bytes) out += ID_ALPHABET[b & 31]

  return out
}

interface TicketRow {
  parent_key: string | null
  parent_checked_at: string | null
  level: string
  assigned: number
  key: string
  summary: string
  status: string
  status_category: string
  priority: string | null
  type: string
  assignee: string | null
  project_key: string
  project_name: string
  url: string
  labels_json: string
  updated_at: string | null
  synced_at: string
  workspace_id: string | null
}

function ticketFromRow(r: TicketRow): Ticket {
  let labels: string[] = []

  try {
    const parsed = JSON.parse(r.labels_json) as unknown

    if (Array.isArray(parsed)) labels = parsed.filter((l): l is string => typeof l === 'string')
  } catch {
    // Unreadable labels are no labels.
  }

  return {
    parentKey: r.parent_key ?? null,
    level: r.level === 'epic' || r.level === 'subtask' ? r.level : 'standard',
    assigned: r.assigned !== 0,
    key: r.key,
    summary: r.summary,
    status: r.status,
    statusCategory: r.status_category as Ticket['statusCategory'],
    priority: r.priority,
    type: r.type,
    assignee: r.assignee,
    projectKey: r.project_key,
    projectName: r.project_name,
    url: r.url,
    labels,
    updatedAt: r.updated_at,
    syncedAt: r.synced_at,
    workspaceId: r.workspace_id
  }
}

interface ProjectRow {
  id: string
  name: string
  path: string
  default_branch: string
  created_at: string
}

interface WorkspaceRow {
  id: string
  project_id: string
  name: string
  branch: string
  path: string
  base_ref: string
  status: string
  status_reason: string | null
  status_at: string
  last_activity_at: string | null
  session_id: string | null
  created_at: string
  archived_at: string | null
  pr_url: string | null
  pr_json: string | null
  prs_json: string | null
  title: string | null
  brief: string | null
  title_source: string | null
  finished_at: string | null
  seen_at: string | null
  background_json: string | null
  removal_json: string | null
  preparation_json: string | null
  pr_urls_json: string | null
  branches_json: string | null
  artifacts_json: string | null
}

export interface HookEventRow {
  id: number
  workspaceId: string
  sessionId: string | null
  event: string
  payload: string
  receivedAt: string
}

function toProject(r: ProjectRow): Project {
  return {
    id: r.id,
    name: r.name,
    path: r.path,
    defaultBranch: r.default_branch,
    createdAt: r.created_at
  }
}

/**
 * A stored pull request; one stored before line or comment counts were kept reads them as
 * null, one stored before its branches were kept reads them as empty.
 */
function storedPr(v: unknown): PullRequest | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? {
        ...(v as PullRequest),
        additions: (v as PullRequest).additions ?? null,
        deletions: (v as PullRequest).deletions ?? null,
        base: (v as PullRequest).base ?? '',
        head: (v as PullRequest).head ?? '',
        comments: (v as PullRequest).comments ?? null,
        commentedAt: (v as PullRequest).commentedAt ?? null
      }
    : null
}

/** A stored JSON column, parsed; undefined when missing, empty, or not JSON. */
function parseStored(json: string | null): JsonValue | undefined {
  if (!json) return undefined

  try {
    return JSON.parse(json) as JsonValue
  } catch {
    return undefined
  }
}

/** The stored list (prs_json); null when missing, not JSON, or not a list. */
function readPrList(json: string | null): PullRequest[] | null {
  const v = parseStored(json)

  return Array.isArray(v) ? v.flatMap((item) => storedPr(item) ?? []) : null
}

/** A row stored before prs_json existed: its one pull request (pr_json) as a list, or none. */
function readLegacyPrs(json: string | null): PullRequest[] {
  const pr = storedPr(parseStored(json))

  return pr ? [pr] : []
}

/** The stored background tasks (background_json); none when missing, not JSON, or not a list. */
function readBackgroundTasks(json: string | null): BackgroundTask[] {
  return objects(parseStored(json)).flatMap((v) => {
    const id = str(v.id)
    const kind = str(v.kind)
    const description = str(v.description)
    const since = str(v.since)

    return id && kind && description !== undefined && since
      ? [{ id, kind, description, since }]
      : []
  })
}

/** The stored artifacts (artifacts_json): each well-formed entry whose URL still passes the rule. */
function readArtifacts(json: string | null): Artifact[] {
  return objects(parseStored(json)).flatMap((v) => {
    const url = str(v.url)
    const title = str(v.title)
    const updatedAt = str(v.updatedAt)
    const openedAt = v.openedAt === null ? null : str(v.openedAt)

    return url && isArtifactUrl(url) && title && updatedAt && openedAt !== undefined
      ? [{ url, title, updatedAt, openedAt }]
      : []
  })
}

const isRemovalStep = (v: unknown): v is RemovalStep =>
  (REMOVAL_STEPS as readonly unknown[]).includes(v)

const isPreparationStep = (v: unknown): v is PreparationStep =>
  (PREPARATION_STEPS as readonly unknown[]).includes(v)

/** A stored run of steps (removal_json, preparation_json); undefined when missing or not one. */
function readSteps<S extends string>(
  json: string | null,
  isStep: (v: unknown) => v is S
): StepRun<S> | undefined {
  const v = parseStored(json)

  if (!isObj(v)) return undefined
  const since = str(v.since)

  if (!since) return undefined

  const done = objects(v.done).flatMap((d): StepResult<S>[] => {
    const ms = num(d.ms)
    const error = str(d.error)

    if (!isStep(d.step) || ms === undefined) return []

    return [error === undefined ? { step: d.step, ms } : { step: d.step, ms, error }]
  })

  return { plan: strings(v.plan).filter(isStep), since, done }
}

function toWorkspace(r: WorkspaceRow): Workspace {
  const prs = readPrList(r.prs_json ?? null) ?? readLegacyPrs(r.pr_json)

  const ws: Workspace = {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    branch: r.branch,
    path: r.path,
    baseRef: r.base_ref,
    status: r.status as WorkspaceStatus,
    statusReason: r.status_reason,
    statusAt: r.status_at,
    lastActivityAt: r.last_activity_at,
    sessionId: r.session_id,
    createdAt: r.created_at,
    archivedAt: r.archived_at,
    prUrls: strings(parseStored(r.pr_urls_json ?? null)),
    branches: strings(parseStored(r.branches_json ?? null)),
    pr: currentPullRequest(prs),
    prs,
    finishedAt: r.finished_at ?? null,
    seenAt: r.seen_at ?? null,
    artifacts: readArtifacts(r.artifacts_json ?? null),
    backgroundTasks: readBackgroundTasks(r.background_json ?? null)
  }

  if (r.title) ws.title = r.title

  if (r.brief) ws.brief = r.brief

  const removal = readSteps(r.removal_json ?? null, isRemovalStep)

  if (removal) ws.removal = removal

  const preparation = readSteps(r.preparation_json ?? null, isPreparationStep)

  if (preparation) ws.preparation = preparation

  const source = titleSourceOf(r.title_source)

  if (source) ws.titleSource = source

  return ws
}

export interface StatusUpdate {
  status: WorkspaceStatus
  reason: string | null
  at: string
  lastActivityAt: string | null
  sessionId: string | null
  backgroundTasks: BackgroundTask[]
}

export class Store {
  readonly db: DatabaseSync

  private readonly statements = new Map<string, StatementSync>()

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)'
    )

    const current =
      this.row<{ v: number | null }>('SELECT MAX(version) AS v FROM migrations')?.v ?? 0

    for (let i = current; i < MIGRATIONS.length; i++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[i])
        this.run(
          'INSERT INTO migrations (version, applied_at) VALUES (?, ?)',
          i + 1,
          new Date().toISOString()
        )
      })
    }
  }

  close(): void {
    this.statements.clear()

    if (this.db.isOpen) this.db.close()
  }

  /** The compiled statement for this SQL, prepared once per connection. */
  private statement(sql: string): StatementSync {
    let stmt = this.statements.get(sql)

    if (!stmt) {
      stmt = this.db.prepare(sql)
      this.statements.set(sql, stmt)
    }

    return stmt
  }

  /** Runs a write statement. */
  private run(sql: string, ...params: SQLInputValue[]): StatementResultingChanges {
    return this.statement(sql).run(...params)
  }

  /** Runs `fn` in one transaction, rolled back if it throws. */
  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN')

    try {
      const out = fn()

      this.db.exec('COMMIT')

      return out
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  // ---- projects -------------------------------------------------------------

  insertProject(p: Project): void {
    this.run(
      'INSERT INTO projects (id, name, path, default_branch, created_at) VALUES (?, ?, ?, ?, ?)',
      p.id,
      p.name,
      p.path,
      p.defaultBranch,
      p.createdAt
    )
  }

  /**
   * Rows from a SELECT, typed by the caller. node:sqlite returns untyped records;
   * the SELECT fixes the columns, so the row type is asserted once, here.
   */
  private rows<Row>(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.statement(sql).all(...params) as Row[]
  }

  /** The first row of a SELECT, typed by the caller (see rows). */
  private row<Row>(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.statement(sql).get(...params) as Row | undefined
  }

  getProject(id: string): Project | undefined {
    const r = this.row<ProjectRow>('SELECT * FROM projects WHERE id = ?', id)

    return r ? toProject(r) : undefined
  }

  getProjectByPath(path: string): Project | undefined {
    const r = this.row<ProjectRow>('SELECT * FROM projects WHERE path = ?', path)

    return r ? toProject(r) : undefined
  }

  listProjects(): Project[] {
    return this.rows<ProjectRow>('SELECT * FROM projects ORDER BY created_at, id').map(toProject)
  }

  deleteProject(id: string): void {
    this.tx(() => {
      this.run(
        'DELETE FROM hook_events WHERE workspace_id IN (SELECT id FROM workspaces WHERE project_id = ?)',
        id
      )
      this.run('DELETE FROM workspaces WHERE project_id = ?', id)
      this.run('DELETE FROM projects WHERE id = ?', id)
    })
  }

  // ---- workspaces -----------------------------------------------------------

  insertWorkspace(w: Workspace): void {
    this.run(
      `INSERT INTO workspaces (id, project_id, name, branch, path, base_ref, status, status_reason,
           status_at, last_activity_at, session_id, created_at, archived_at, pr_urls_json, pr_json,
           prs_json, title, brief, title_source, finished_at, seen_at, removal_json, branches_json,
           preparation_json, artifacts_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      w.id,
      w.projectId,
      w.name,
      w.branch,
      w.path,
      w.baseRef,
      w.status,
      w.statusReason,
      w.statusAt,
      w.lastActivityAt,
      w.sessionId,
      w.createdAt,
      w.archivedAt,
      JSON.stringify(w.prUrls),
      // pr_json is only read for a row stored before prs_json; the current one derives from prs.
      null,
      JSON.stringify(w.prs),
      w.title ?? null,
      w.brief ?? null,
      w.titleSource ?? null,
      w.finishedAt,
      w.seenAt,
      w.removal ? JSON.stringify(w.removal) : null,
      JSON.stringify(w.branches),
      w.preparation ? JSON.stringify(w.preparation) : null,
      JSON.stringify(w.artifacts)
    )
  }

  setWorkspaceTitle(id: string, title: string, source: TitleSource): void {
    this.run('UPDATE workspaces SET title = ?, title_source = ? WHERE id = ?', title, source, id)
  }

  /** The branch the worktree has checked out, and every branch it has had (oldest first). */
  setWorkspaceBranch(id: string, branch: string, branches: string[]): void {
    this.run(
      'UPDATE workspaces SET branch = ?, branches_json = ? WHERE id = ?',
      branch,
      JSON.stringify(branches),
      id
    )
  }

  getWorkspace(id: string): Workspace | undefined {
    const r = this.row<WorkspaceRow>('SELECT * FROM workspaces WHERE id = ?', id)

    return r ? toWorkspace(r) : undefined
  }

  /** Any workspace (archived included) holding this name or path in the project. */
  findWorkspaceConflicts(projectId: string, name: string, path: string): Workspace[] {
    return this.rows<WorkspaceRow>(
      'SELECT * FROM workspaces WHERE (project_id = ? AND name = ?) OR path = ?',
      projectId,
      name,
      path
    ).map(toWorkspace)
  }

  /** Unarchived workspaces, oldest first. */
  listWorkspaces(projectId?: string): Workspace[] {
    const rows = projectId
      ? this.rows<WorkspaceRow>(
          'SELECT * FROM workspaces WHERE archived_at IS NULL AND project_id = ? ORDER BY created_at, id',
          projectId
        )
      : this.rows<WorkspaceRow>(
          'SELECT * FROM workspaces WHERE archived_at IS NULL ORDER BY created_at, id'
        )

    return rows.map(toWorkspace)
  }

  updateStatus(id: string, u: StatusUpdate): void {
    this.run(
      `UPDATE workspaces SET status = ?, status_reason = ?, status_at = ?, last_activity_at = ?,
           session_id = ?, background_json = ? WHERE id = ?`,
      u.status,
      u.reason,
      u.at,
      u.lastActivityAt,
      u.sessionId,
      JSON.stringify(u.backgroundTasks),
      id
    )
  }

  /** A turn ended: the workspace has something new to look at. */
  setWorkspaceFinished(id: string, at: string): void {
    this.run('UPDATE workspaces SET finished_at = ? WHERE id = ?', at, id)
  }

  /** The app had the workspace selected in a focused window. */
  setWorkspaceSeen(id: string, at: string): void {
    this.run('UPDATE workspaces SET seen_at = ? WHERE id = ?', at, id)
  }

  /** Records pull requests the workspace's session created; true when one was new. */
  addWorkspacePrUrls(id: string, urls: string[]): boolean {
    return this.tx(() => {
      const r = this.row<{ pr_urls_json: string | null }>(
        'SELECT pr_urls_json FROM workspaces WHERE id = ?',
        id
      )

      if (!r) return false
      const known = strings(parseStored(r.pr_urls_json))
      const next = appendNew(known, urls)

      if (next.length === known.length) return false
      this.run('UPDATE workspaces SET pr_urls_json = ? WHERE id = ?', JSON.stringify(next), id)

      return true
    })
  }

  /** Rewrites the workspace's artifacts with what `change` returns; null leaves them. True when rewritten. */
  private changeArtifacts(id: string, change: (known: Artifact[]) => Artifact[] | null): boolean {
    return this.tx(() => {
      const r = this.row<{ artifacts_json: string | null }>(
        'SELECT artifacts_json FROM workspaces WHERE id = ?',
        id
      )

      if (!r) return false
      const next = change(readArtifacts(r.artifacts_json))

      if (!next) return false
      this.run('UPDATE workspaces SET artifacts_json = ? WHERE id = ?', JSON.stringify(next), id)

      return true
    })
  }

  /** A session published the page: first in the list, under its new title, unopened; the newest 50 stay. */
  publishWorkspaceArtifact(id: string, url: string, title: string, at: string): boolean {
    return this.changeArtifacts(id, (known) =>
      [{ url, title, updatedAt: at, openedAt: null }, ...known.filter((a) => a.url !== url)].slice(
        0,
        ARTIFACTS_PER_WORKSPACE
      )
    )
  }

  /** A session deleted the page; true when it was listed. */
  removeWorkspaceArtifact(id: string, url: string): boolean {
    return this.changeArtifacts(id, (known) =>
      known.some((a) => a.url === url) ? known.filter((a) => a.url !== url) : null
    )
  }

  /** The app opened the page; true when it was listed. */
  markWorkspaceArtifactOpened(id: string, url: string, at: string): boolean {
    return this.changeArtifacts(id, (known) =>
      known.some((a) => a.url === url)
        ? known.map((a) => (a.url === url ? { ...a, openedAt: at } : a))
        : null
    )
  }

  /** Stores the workspace's pull requests; the current one (Workspace.pr) is derived from them. */
  setWorkspacePrs(id: string, prs: PullRequest[]): void {
    this.run('UPDATE workspaces SET prs_json = ? WHERE id = ?', JSON.stringify(prs), id)
  }

  /** Where the workspace's removal stands; null clears it. */
  setWorkspaceRemoval(id: string, removal: Removal | null): void {
    this.run(
      'UPDATE workspaces SET removal_json = ? WHERE id = ?',
      removal ? JSON.stringify(removal) : null,
      id
    )
  }

  /** Where the workspace's preparation stands; null clears it. */
  setWorkspacePreparation(id: string, preparation: Preparation | null): void {
    this.run(
      'UPDATE workspaces SET preparation_json = ? WHERE id = ?',
      preparation ? JSON.stringify(preparation) : null,
      id
    )
  }

  /** The ref the worktree was made from, once a preparation has resolved it. */
  setWorkspaceBaseRef(id: string, baseRef: string): void {
    this.run('UPDATE workspaces SET base_ref = ? WHERE id = ?', baseRef, id)
  }

  archiveWorkspace(id: string, at: string): void {
    this.run('UPDATE workspaces SET archived_at = ? WHERE id = ?', at, id)
  }

  /** Hard-deletes an archived row so its name and path can be reused. */
  deleteWorkspace(id: string): void {
    this.run('DELETE FROM hook_events WHERE workspace_id = ?', id)
    this.run('DELETE FROM workspace_status_log WHERE workspace_id = ?', id)
    this.run('DELETE FROM workspaces WHERE id = ?', id)
  }

  // ---- status log -----------------------------------------------------------

  /** Records one status change; rows older than 30 days are pruned on the way. */
  insertStatusLog(
    workspaceId: string,
    status: WorkspaceStatus,
    reason: string | null,
    at: string
  ): void {
    this.run(
      'INSERT INTO workspace_status_log (workspace_id, status, reason, at) VALUES (?, ?, ?, ?)',
      workspaceId,
      status,
      reason,
      at
    )
    const cutoff = new Date(Date.parse(at) - STATUS_LOG_RETENTION_MS).toISOString()
    this.run('DELETE FROM workspace_status_log WHERE at < ?', cutoff)
  }

  /** Every change at or after `since`, plus the last one before it, oldest first. */
  listStatusLog(workspaceId: string, since: string): StatusLogRow[] {
    return this.rows<StatusLogRow>(
      `SELECT status, reason, at FROM workspace_status_log
         WHERE workspace_id = ? AND (at >= ? OR id = (
           SELECT id FROM workspace_status_log WHERE workspace_id = ? AND at < ?
             ORDER BY at DESC, id DESC LIMIT 1))
         ORDER BY at, id`,
      workspaceId,
      since,
      workspaceId,
      since
    )
  }

  // ---- hook events ----------------------------------------------------------

  /** Stores one hook payload, keeping only the newest rows per workspace. */
  insertHookEvent(
    workspaceId: string,
    sessionId: string | null,
    event: string,
    payload: unknown,
    receivedAt: string
  ): void {
    this.run(
      'INSERT INTO hook_events (workspace_id, session_id, event, payload, received_at) VALUES (?, ?, ?, ?, ?)',
      workspaceId,
      sessionId,
      event,
      JSON.stringify(payload),
      receivedAt
    )
    // Everything at or below the first id past the newest 500 goes; with 500 or fewer rows
    // the subquery is NULL and nothing does. Both sides walk the (workspace_id, id) index.
    this.run(
      `DELETE FROM hook_events WHERE workspace_id = ? AND id <=
         (SELECT id FROM hook_events WHERE workspace_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`,
      workspaceId,
      workspaceId,
      HOOK_EVENTS_PER_WORKSPACE
    )
  }

  listHookEvents(workspaceId: string): HookEventRow[] {
    return this.rows<{
      id: number
      workspace_id: string
      session_id: string | null
      event: string
      payload: string
      received_at: string
    }>('SELECT * FROM hook_events WHERE workspace_id = ? ORDER BY id', workspaceId).map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      sessionId: r.session_id,
      event: r.event,
      payload: r.payload,
      receivedAt: r.received_at
    }))
  }

  // ---- quiet unlocks ---------------------------------------------------------

  insertUnlock(u: {
    at: string
    minutes: number
    why: string | null
    until: string
    kind: QuietKind
  }): number {
    const r = this.run(
      'INSERT INTO quiet_unlocks (at, minutes, why, until, kind) VALUES (?, ?, ?, ?, ?)',
      u.at,
      u.minutes,
      u.why,
      u.until,
      u.kind
    )

    return Number(r.lastInsertRowid)
  }

  endUnlock(id: number, endedAt: string): void {
    this.run('UPDATE quiet_unlocks SET ended_at = ? WHERE id = ? AND ended_at IS NULL', endedAt, id)
  }

  /** The unlock still open (not ended), if any. */
  openUnlock():
    | { id: number; at: string; why: string | null; until: string; kind: QuietKind }
    | undefined {
    return this.row<{ id: number; at: string; why: string | null; until: string; kind: QuietKind }>(
      'SELECT id, at, why, until, kind FROM quiet_unlocks WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1'
    )
  }

  /** Scheduled-window unlocks started at or after `since`, oldest first; a manual quiet's peeks are not in the log. */
  listUnlocks(since?: string): QuietUnlock[] {
    type UnlockRow = { at: string; minutes: number; why: string | null; ended_at: string | null }

    const rows = since
      ? this.rows<UnlockRow>(
          "SELECT * FROM quiet_unlocks WHERE kind = 'scheduled' AND at >= ? ORDER BY id",
          since
        )
      : this.rows<UnlockRow>("SELECT * FROM quiet_unlocks WHERE kind = 'scheduled' ORDER BY id")

    return rows.map((r) => ({ at: r.at, minutes: r.minutes, why: r.why, endedAt: r.ended_at }))
  }

  // ---- manual quiet ------------------------------------------------------------

  insertManual(m: { at: string; until: string }): number {
    const r = this.run('INSERT INTO quiet_manual (at, until) VALUES (?, ?)', m.at, m.until)

    return Number(r.lastInsertRowid)
  }

  endManual(id: number, endedAt: string): void {
    this.run('UPDATE quiet_manual SET ended_at = ? WHERE id = ? AND ended_at IS NULL', endedAt, id)
  }

  /** The manual quiet still open (not ended), if any. */
  openManual(): { id: number; at: string; until: string } | undefined {
    return this.row<{ id: number; at: string; until: string }>(
      'SELECT id, at, until FROM quiet_manual WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1'
    )
  }

  // ---- tickets --------------------------------------------------------------

  /** Inserts or updates tickets by key (position is the index in `tickets`), keeping the workspace and the parent check time each one has. */
  upsertTickets(tickets: Ticket[]): void {
    const stmt = this.statement(
      `INSERT INTO tickets (key, summary, status, status_category, priority, type, assignee,
         project_key, project_name, url, labels_json, updated_at, synced_at, position,
         parent_key, level, assigned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET summary = excluded.summary, status = excluded.status,
         status_category = excluded.status_category, priority = excluded.priority,
         type = excluded.type, assignee = excluded.assignee, project_key = excluded.project_key,
         project_name = excluded.project_name, url = excluded.url,
         labels_json = excluded.labels_json, updated_at = excluded.updated_at,
         synced_at = excluded.synced_at, position = excluded.position,
         parent_key = excluded.parent_key, level = excluded.level, assigned = excluded.assigned`
    )

    this.tx(() => {
      for (const [position, t] of tickets.entries()) {
        stmt.run(
          t.key,
          t.summary,
          t.status,
          t.statusCategory,
          t.priority,
          t.type,
          t.assignee,
          t.projectKey,
          t.projectName,
          t.url,
          JSON.stringify(t.labels),
          t.updatedAt,
          t.syncedAt,
          position,
          t.parentKey,
          t.level,
          t.assigned ? 1 : 0
        )
      }
    })
  }

  /** Every cached ticket, in the order of the last sync (a parent sits with its children). */
  listTickets(): Ticket[] {
    return this.rows<TicketRow>('SELECT * FROM tickets ORDER BY position, assigned DESC, key').map(
      ticketFromRow
    )
  }

  getTicket(key: string): Ticket | undefined {
    const r = this.row<TicketRow>('SELECT * FROM tickets WHERE key = ?', key)

    return r ? ticketFromRow(r) : undefined
  }

  /** When the ticket's parent was last looked up (null: never, or no such ticket). */
  getTicketParentCheckedAt(key: string): string | null {
    return (
      this.row<{ parent_checked_at: string | null }>(
        'SELECT parent_checked_at FROM tickets WHERE key = ?',
        key
      )?.parent_checked_at ?? null
    )
  }

  /** Records a ticket's parent (null: none) and when it was looked up. */
  setTicketParent(key: string, parentKey: string | null, checkedAt: string): void {
    this.run(
      'UPDATE tickets SET parent_key = ?, parent_checked_at = ? WHERE key = ?',
      parentKey,
      checkedAt,
      key
    )
  }

  /**
   * Drops tickets that are not in `keys`, except those with a workspace, and
   * the parents que knows only through children (`assigned = 0`) once no
   * remaining ticket points at them.
   */
  deleteTicketsNotIn(keys: string[]): void {
    const keep = new Set(keys)
    const del = this.statement('DELETE FROM tickets WHERE key = ?')

    const rows = this.rows<{ key: string }>(
      'SELECT key FROM tickets WHERE workspace_id IS NULL AND assigned != 0'
    )

    for (const r of rows) if (!keep.has(r.key)) del.run(r.key)
    this.run(`DELETE FROM tickets WHERE assigned = 0 AND workspace_id IS NULL
           AND key NOT IN (SELECT parent_key FROM tickets WHERE parent_key IS NOT NULL)`)
  }

  setTicketWorkspace(key: string, workspaceId: string | null): void {
    this.run('UPDATE tickets SET workspace_id = ? WHERE key = ?', workspaceId, key)
  }

  // ---- kv -------------------------------------------------------------------

  getKv(key: string): string | undefined {
    return this.row<{ value: string }>('SELECT value FROM kv WHERE key = ?', key)?.value
  }

  setKv(key: string, value: string | null): void {
    if (value === null) this.run('DELETE FROM kv WHERE key = ?', key)
    else
      this.run(
        'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        key,
        value
      )
  }

  /** Ids of the unarchived workspaces whose stored status is `status`, oldest first. */
  listWorkspaceIdsByStatus(status: WorkspaceStatus): string[] {
    return this.rows<{ id: string }>(
      'SELECT id FROM workspaces WHERE archived_at IS NULL AND status = ? ORDER BY created_at, id',
      status
    ).map((r) => r.id)
  }
}
