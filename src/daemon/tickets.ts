// The ticket queue: polls the user's issue tracker through `acli` (read only),
// caches the tickets assigned to them, and turns one into a workspace with a
// brief and a claude session on it.
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import type { UserConfig } from '../shared/config'
import { cleanSpawnEnv } from '../shared/env'
import { firstLine, run } from '../shared/exec'
import { ErrorCodes } from '../shared/protocol'
import type {
  TicketsListResult,
  TicketsStartParams,
  TermInfo,
  TicketsStartResult,
  WorkspaceCreateParams
} from '../shared/protocol'
import { cappedSlug, workspaceSlug } from '../shared/slug'
import type { JsonValue, Project, Ticket, Workspace } from '../shared/types'
import { adfToText } from './adf-text'
import { RpcError } from './errors'
import { Poller } from './poller'
import type { Emit } from './bus'
import type { Store } from './store'
import {
  decodeParentLink,
  decodeSearch,
  decodeWorkItemView,
  type WorkItem,
  type WorkItemView
} from './tickets.decode'
import { claudeCommand } from './wrapper'
import { excludeQueDir } from './workspaces'
import { errorMessage } from '../shared/errors.decode'

const SEARCH_FIELDS = 'key,summary,status,priority,issuetype,assignee,labels'
const VIEW_FIELDS = 'summary,description,status,priority,issuetype,labels'
const SEARCH_LIMIT = '200'
const PARENT_FIELDS = 'parent'
const PARENT_BRIEF_FIELDS = 'summary,description'
const PARENT_RECHECK_MS = 24 * 3_600_000
const PARENT_CONCURRENCY = 4
const FIRST_SYNC_MS = 1000
const KV_LAST_SYNC = 'tickets.last_sync_at'
const KV_ERROR = 'tickets.error'

/** The ticket's page on the tracker's `site`, or '' without one. */
function ticketUrl(site: string, key: string): string {
  return site ? `https://${site}/browse/${key}` : ''
}

/** A decoded work item as que keeps it: synced at `syncedAt`, linked to its page on `site`. */
export function ticketFrom(item: WorkItem, syncedAt: string, site = ''): Ticket {
  return {
    ...item,
    url: ticketUrl(site, item.key),
    syncedAt,
    workspaceId: null
  }
}

/** The brief a workspace's `.que/ticket.md` holds. */
export function renderBrief(
  ticket: Ticket,
  description: string,
  parent?: { key: string; summary: string; isEpic: boolean; description: string }
): string {
  const lines = [
    `# ${ticket.key} ${ticket.summary}`,
    '',
    ticket.url,
    `Status: ${ticket.status} · Priority: ${ticket.priority ?? 'none'} · Type: ${ticket.type}`
  ]

  if (ticket.labels.length > 0) lines.push(`Labels: ${ticket.labels.join(', ')}`)
  lines.push('', '## Description', '', description.trim() || '(none)', '')

  if (parent) {
    lines.push(
      `## ${parent.isEpic ? 'Epic' : 'Parent'} ${parent.key}: ${parent.summary}`,
      '',
      parent.description.trim() || '(none)',
      ''
    )
  }

  return lines.join('\n')
}

/** `<key lowercased>-<slug of summary>`, at most 64 characters, no trailing hyphen. */
export function workspaceNameFor(ticket: Ticket): string {
  const key = ticket.key.toLowerCase()

  return workspaceSlug(cappedSlug(`${key}-${ticket.summary}`, 64)) ?? key
}

async function acli(args: string[], signal?: AbortSignal): Promise<string> {
  const r = await run('acli', args, {
    timeoutMs: 30_000,
    maxBuffer: 32 * 1024 * 1024,
    env: cleanSpawnEnv(process.env),
    signal
  })

  if (r.ok) return r.stdout

  if (r.code === 'ENOENT') throw new Error('acli is not installed or not on PATH')

  throw new Error(firstLine(r.stderr).trim() || firstLine(r.stdout).trim() || r.error)
}

export interface TicketServiceOptions {
  store: Store
  config: () => UserConfig
  emit: Emit
  log?: (msg: string) => void
  /** QUE_HOME: briefs for loose sessions go under `<home>/tickets/`. */
  home: string
  projects: () => Project[]
  createWorkspace: (p: WorkspaceCreateParams) => Promise<Workspace>
  openTerminal: (workspaceId: string) => Promise<TermInfo>
  createSession: (cwd: string) => Promise<TermInfo>
  /** Types a command that starts claude into a terminal, once its shell can take it. */
  typeCommand: (id: string, command: string) => void
  /** Records `tracker key = que project name` in the config file. */
  learnProject: (projectKey: string, projectName: string) => Promise<void>
}

export class TicketService {
  private running: Promise<void> | null = null
  private failing = false
  private site = ''

  private readonly poller = new Poller({
    intervalMs: () => Math.max(100, this.opts.config().jira.pollMinutes * 60_000),
    tick: async () => {
      await this.sync()
    }
  })

  constructor(private opts: TicketServiceOptions) {}

  start(): void {
    this.poller.start(FIRST_SYNC_MS)
  }

  stop(): void {
    this.poller.stop()
  }

  /** Resolves once every call that was running when stop() was called has ended. */
  drain(): Promise<void> {
    return this.poller.drain()
  }

  private get stopped(): boolean {
    return this.poller.stopped
  }

  /** The cached tickets and how the last sync went; never touches the network. */
  list(): TicketsListResult {
    const tickets = this.opts.store.listTickets()

    return {
      tickets,
      sync: {
        lastSyncAt: this.opts.store.getKv(KV_LAST_SYNC) ?? null,
        error: this.opts.store.getKv(KV_ERROR) ?? null,
        count: tickets.length
      }
    }
  }

  /** Fetches the queue now and returns the result (a failure shows in `sync.error`). */
  async sync(): Promise<TicketsListResult> {
    if (this.stopped) return this.list()

    if (!this.running) {
      this.running = this.syncOnce().finally(() => {
        this.running = null
      })
    }

    // Tracked through the read that follows, so drain() outlasts it and the store is still open.
    return this.poller.track(this.running.then(() => this.list()))
  }

  private async syncOnce(): Promise<void> {
    const { store } = this.opts
    let issues: WorkItem[]

    try {
      const stdout = await acli(
        [
          'jira',
          'workitem',
          'search',
          '--jql',
          this.opts.config().jira.jql,
          '--json',
          '--limit',
          SEARCH_LIMIT,
          '--fields',
          SEARCH_FIELDS
        ],
        this.poller.signal
      )

      let parsed: unknown

      try {
        parsed = JSON.parse(stdout)
      } catch {
        throw new Error('acli printed output that is not JSON')
      }

      const decoded = decodeSearch(parsed)

      if (!decoded) throw new Error('acli printed output that is not a list')
      issues = decoded
    } catch (err) {
      if (this.stopped) return
      const message = errorMessage(err)
      store.setKv(KV_ERROR, message)
      this.site = ''

      if (!this.failing) {
        this.failing = true
        this.opts.log?.(`ticket sync failed: ${message}`)
      }

      this.opts.emit('tickets.synced', this.list())

      return
    }

    if (this.stopped) return
    const at = new Date().toISOString()
    const site = await this.siteHost()
    const tickets = issues.map((i) => ticketFrom(i, at, site))
    const ordered = await this.withParents(tickets, at, site)

    if (this.stopped) return
    store.upsertTickets(ordered.tickets)

    for (const [key, parentKey] of ordered.checked) store.setTicketParent(key, parentKey, at)
    store.deleteTicketsNotIn(tickets.map((t) => t.key))
    store.setKv(KV_ERROR, null)
    store.setKv(KV_LAST_SYNC, at)

    if (this.failing) {
      this.failing = false
      this.opts.log?.('ticket sync recovered')
    }

    this.opts.emit('tickets.synced', this.list())
  }

  /** The tracker's host for links: `[jira] site`, else the CLI's auth status (cached), else ''. */
  private async siteHost(): Promise<string> {
    const configured = this.opts.config().jira.site

    if (configured) return configured

    if (this.site) return this.site

    try {
      const out = await acli(['jira', 'auth', 'status'], this.poller.signal)
      this.site = /^\s*Site:\s*(\S+)/m.exec(out)?.[1] ?? ''
    } catch (err) {
      if (!this.stopped) this.opts.log?.(`reading the tracker site failed: ${errorMessage(err)}`)
    }

    return this.site
  }

  /**
   * Learns the parent of every ticket not checked lately, synthesizes parents the
   * search did not return, and returns all tickets in list order (a synthesized
   * parent just before its first child) plus the parents looked up this sync.
   */
  private async withParents(
    found: Ticket[],
    at: string,
    site: string
  ): Promise<{ tickets: Ticket[]; checked: Map<string, string | null> }> {
    const { store } = this.opts
    const inSearch = new Set(found.map((t) => t.key))
    const now = Date.now()
    const parentOf = new Map<string, string | null>()
    const synthesized = new Map<string, Ticket>()

    const stale = (t: Ticket): boolean => {
      const stored = store.getTicket(t.key)
      const checkedAt = store.getTicketParentCheckedAt(t.key)

      if (!checkedAt || now - Date.parse(checkedAt) > PARENT_RECHECK_MS) return true
      const parent = stored?.parentKey

      return !!parent && !inSearch.has(parent) && !store.getTicket(parent)
    }

    for (const t of found) parentOf.set(t.key, store.getTicket(t.key)?.parentKey ?? null)
    const todo = found.filter((t) => t.level !== 'epic' && stale(t))
    const checked = new Map<string, string | null>()
    let next = 0

    const worker = async (): Promise<void> => {
      while (next < todo.length && !this.stopped) {
        const t = todo[next++]

        try {
          const link = decodeParentLink(await this.viewItem(t.key, PARENT_FIELDS))
          const parentKey = link?.key ?? null
          checked.set(t.key, parentKey)
          parentOf.set(t.key, parentKey)

          if (parentKey && !inSearch.has(parentKey) && !synthesized.has(parentKey)) {
            if (link?.item) {
              synthesized.set(parentKey, {
                ...ticketFrom(link.item, at, site),
                assigned: false,
                assignee: null,
                updatedAt: null,
                projectKey: parentKey.split('-')[0],
                projectName: parentKey.split('-')[0]
              })
            }
          }
        } catch (err) {
          if (!this.stopped) {
            this.opts.log?.(`looking up the parent of ${t.key} failed: ${errorMessage(err)}`)
          }
        }
      }
    }

    await Promise.all(Array.from({ length: PARENT_CONCURRENCY }, worker))

    const out: Ticket[] = []
    const placed = new Set<string>()

    for (const t of found) {
      const parentKey = parentOf.get(t.key) ?? null

      if (parentKey && !inSearch.has(parentKey) && !placed.has(parentKey)) {
        const parent = synthesized.get(parentKey) ?? store.getTicket(parentKey)

        if (parent && !parent.assigned) {
          placed.add(parentKey)
          out.push({
            ...parent,
            syncedAt: at,
            url: ticketUrl(site, parentKey)
          })
        }
      }

      out.push({ ...t, parentKey })
    }

    return { tickets: out, checked }
  }

  /** The id of the que project a ticket's tracker project is mapped to, or null. */
  projectFor(key: string): string | null {
    const ticket = this.opts.store.getTicket(key)

    if (!ticket) return null

    return this.mappedProject(ticket)?.id ?? null
  }

  private mappedProject(ticket: Ticket): Project | null {
    const name = this.opts.config().jira.projects[ticket.projectKey]

    if (!name) return null

    return this.opts.projects().find((p) => p.name === name) ?? null
  }

  /** One work item's `fields`, as the tracker CLI prints them. */
  private async viewItem(key: string, fields: string): Promise<JsonValue> {
    const stdout = await acli(
      ['jira', 'workitem', 'view', key, '--json', '--fields', fields],
      this.poller.signal
    )

    return JSON.parse(stdout) as JsonValue
  }

  private async brief(ticket: Ticket): Promise<string> {
    const view = async (key: string, fields: string): Promise<WorkItemView | null> =>
      decodeWorkItemView(await this.viewItem(key, fields))

    let description = '(could not be fetched)'

    try {
      description = adfToText((await view(ticket.key, VIEW_FIELDS))?.description ?? null)
    } catch (err) {
      this.opts.log?.(`fetching ${ticket.key} failed: ${errorMessage(err)}`)
    }

    let parent: Parameters<typeof renderBrief>[2]

    if (ticket.parentKey) {
      const known = this.opts.store.getTicket(ticket.parentKey)

      const base = {
        key: ticket.parentKey,
        summary: known?.summary ?? '',
        isEpic: known?.level === 'epic'
      }

      try {
        const f = await view(ticket.parentKey, PARENT_BRIEF_FIELDS)
        parent = {
          ...base,
          summary: f?.summary ?? base.summary,
          description: adfToText(f?.description ?? null)
        }
      } catch (err) {
        this.opts.log?.(`fetching ${ticket.parentKey} failed: ${errorMessage(err)}`)
        parent = { ...base, description: '(could not be fetched)' }
      }
    }

    return renderBrief(ticket, description, parent)
  }

  /** Starts work on a ticket: a workspace under its project, or a loose session. */
  startTicket(params: TicketsStartParams): Promise<TicketsStartResult> {
    return this.poller.track(this.startOnce(params))
  }

  private async startOnce(params: TicketsStartParams): Promise<TicketsStartResult> {
    const { store, home } = this.opts
    const ticket = store.getTicket(params.key)

    if (!ticket) throw new RpcError(ErrorCodes.NotFound, `no ticket ${params.key}`)

    if (ticket.level === 'epic') {
      throw new RpcError(
        ErrorCodes.BadRequest,
        `${ticket.key} is an epic, an overview; start one of its tickets`
      )
    }

    const brief = await this.brief(ticket)

    if (params.session) {
      const dir = join(home, 'tickets')
      fs.mkdirSync(dir, { recursive: true })
      const file = join(dir, `${ticket.key}.md`)
      fs.writeFileSync(file, brief)
      const t = await this.opts.createSession(os.homedir())
      const prompt = `Read ${file}, the ticket I am working on. Restate the goal in a sentence, then propose a plan before changing anything.`
      this.opts.typeCommand(t.id, claudeCommand(prompt))

      return { kind: 'session', terminal: t }
    }

    const mapped = this.mappedProject(ticket)
    const projects = this.opts.projects()
    const project = params.projectId ? projects.find((p) => p.id === params.projectId) : mapped

    if (params.projectId && !project) {
      throw new RpcError(ErrorCodes.NotFound, `no project ${params.projectId}`)
    }

    if (!project) return { kind: 'needs_project', projects }

    if (mapped?.id !== project.id) await this.opts.learnProject(ticket.projectKey, project.name)

    const name = workspaceNameFor(ticket)

    const existing = store
      .listWorkspaces()
      .find((w) => w.projectId === project.id && w.name === name && !w.archivedAt)

    const workspace =
      existing ??
      (await this.opts.createWorkspace({
        projectId: project.id,
        name,
        title: `${ticket.key} ${ticket.summary}`,
        brief
      }))

    const dir = join(workspace.path, '.que')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(join(dir, 'ticket.md'), brief)
    await excludeQueDir(workspace.path)
    store.setTicketWorkspace(ticket.key, workspace.id)

    const t = await this.opts.openTerminal(workspace.id)
    this.opts.typeCommand(t.id, claudeCommand(this.opts.config().jira.startPrompt))
    this.opts.emit('tickets.synced', this.list())

    return { kind: 'workspace', workspace }
  }
}
