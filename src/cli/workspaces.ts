// Projects, workspaces, and status commands.
import { execFile } from 'node:child_process'
import { join, resolve } from 'node:path'
import type { Command } from 'commander'
import { summarize } from '../daemon/status-engine'
import type { DaemonClient } from '../shared/client'
import {
  formatAge,
  formatDuration,
  formatStepDuration,
  removalStepLabel,
  spanMs
} from '../shared/format'
import { quePaths } from '../shared/paths'
import type { DiffFile, WorkspaceDiff, WorkspaceFiles } from '../shared/protocol'
import type {
  PrCheck,
  PrThread,
  Project,
  PullRequest,
  QuietState,
  RemovalResult,
  Workspace
} from '../shared/types'
import { attach } from './attach'
import {
  assertNotQuiet,
  CliError,
  findProject,
  findWorkspace,
  printJson,
  printTable,
  withClient
} from './common'
import { describeQuietState } from './quiet'

const DIFF_GLYPH: Record<DiffFile['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  untracked: '?'
}

/** The text `que ws diff` prints: the header, the commit it is narrowed to, the commits, the files. */
export function formatDiff(d: WorkspaceDiff, now = Date.now()): string {
  const lines = [`${d.head} vs ${d.base} · ${d.commitsAhead} commits ahead`]

  if (d.commit) {
    const narrowed = d.commits.find((c) => c.sha === d.commit)
    lines.push(`commit ${d.commit.slice(0, 7)}${narrowed ? ` ${narrowed.subject}` : ''}`)
  }

  for (const c of d.commits.slice(0, 200)) {
    lines.push(`  ${c.shortSha} ${c.subject} · ${formatAge(c.at, now)}`)
  }

  if (d.files.length === 0) lines.push('no changes')

  for (const f of d.files) {
    const name = f.from ? `${f.from} → ${f.path}` : f.path
    lines.push(
      `${DIFF_GLYPH[f.status]} ${name}  +${f.additions} -${f.deletions}${f.dirty ? ' *' : ''}`
    )
  }

  return lines.join('\n')
}

/** The text `que ws files` prints: one path per line, and a note when the listing was cut. */
export function formatFiles(f: WorkspaceFiles): string {
  const lines = [...f.files]

  if (f.truncated) lines.push(`… and more (listing cut at ${f.files.length})`)

  return lines.join('\n')
}

function formatCheck(c: PrCheck): string {
  const source = c.source ? ` (${c.source})` : ''
  // `1m 21s`, unpadded; nothing unless both times are known and in order.
  const ms = spanMs(c.startedAt, c.completedAt)
  const took = ms !== null && ms >= 0 ? formatDuration(ms, { pad: false }) : null

  return `${c.state.padEnd(7)}  ${c.name}${source}${took ? `  ${took}` : ''}`
}

/** The text `que ws pr` prints: the pull request, its checks, and its conversation. */
export function formatPrView(pr: PullRequest, thread: PrThread | null): string {
  const lines = [`#${pr.number} ${pr.state} · ${pr.title}`, pr.url]

  if (pr.updatedAt) lines.push(`updated ${pr.updatedAt}`)
  const runs = pr.checkRuns ?? []
  lines.push('', 'checks')

  if (runs.length === 0) lines.push('no checks')

  for (const c of runs) lines.push(formatCheck(c))
  lines.push('', 'thread')
  const entries = thread?.entries ?? []

  if (entries.length === 0) lines.push('no comments')

  for (const e of entries) {
    const what = e.kind === 'review' && e.state ? e.state.replace('_', ' ') : e.kind
    const where = e.kind === 'line' && e.path ? ` · ${e.path}${e.line ? `:${e.line}` : ''}` : ''
    lines.push(`${e.author} · ${e.at} · ${what}${where}`)

    for (const l of e.body.trimEnd().split('\n')) if (e.body.trim()) lines.push(`  ${l}`)
  }

  return lines.join('\n')
}

/** `-` when there is no pull request, else `#12 open` plus what needs attention. */
export function formatPr(pr: PullRequest | null): string {
  if (!pr) return '-'

  const notes = [
    pr.checks === 'failing' ? 'checks failing' : null,
    pr.review === 'changes_requested' ? 'changes requested' : null
  ].filter(Boolean)

  return `#${pr.number} ${pr.state}${notes.map((n) => `·${n}`).join('')}`
}

/** The JSON shape of `que status --json`. */
export interface StatusJson {
  summary: ReturnType<typeof summarize>
  quiet: QuietState
  workspaces: Array<{
    id: string
    name: string
    project: string
    projectId: string
    branch: string
    path: string
    status: Workspace['status']
    reason: string | null
    lastActivityAt: string | null
    sessionId: string | null
    pr: PullRequest | null
  }>
}

function openInEditor(path: string): Promise<void> {
  return new Promise((res, rej) => {
    execFile('code', ['-n', path], (err) =>
      err ? rej(new CliError(`code -n failed: ${err.message}`)) : res()
    )
  })
}

/** Waits until a workspace leaves `preparing` (its setup command finished). */
async function waitForSetup(c: DaemonClient, ws: Workspace, seen: Workspace[]): Promise<Workspace> {
  const settled = (): boolean => seen.some((e) => e.id === ws.id && e.status !== 'preparing')

  if (!settled()) {
    const now = await c.request('workspace.get', { id: ws.id })

    if (now.status !== 'preparing') return now
    process.stderr.write(`que: running setup for ${ws.name}…\n`)
    await new Promise<void>((done) => {
      const off = c.on('workspace.updated', (e) => {
        if (e.id === ws.id && e.status !== 'preparing') {
          off()
          done()
        }
      })

      if (settled()) {
        off()
        done()
      }
    })
  }

  return c.request('workspace.get', { id: ws.id })
}

/** A finished removal step as `que ws remove` prints it: `killing terminals 0.1s`. */
function formatRemovalStep(r: RemovalResult): string {
  const line = `${removalStepLabel(r.step)} ${formatStepDuration(r.ms)}`

  return r.error ? `${line}: ${r.error}` : line
}

/**
 * Removes a workspace and waits for workspace.removed, printing each step as it finishes
 * (a failed one to stderr). Returns whether any step failed.
 */
async function removeWorkspace(
  c: DaemonClient,
  ws: Workspace,
  deleteBranch: boolean
): Promise<boolean> {
  let printed = 0
  let failed = false

  const print = (done: RemovalResult[]): void => {
    for (const r of done.slice(printed)) {
      if (r.error) {
        process.stderr.write(`que: ${formatRemovalStep(r)}\n`)
      } else {
        console.log(formatRemovalStep(r))
      }
    }

    printed = Math.max(printed, done.length)
  }

  const offs: Array<() => void> = []

  // Listening before the request, so no step can finish unseen.
  const removed = new Promise<void>((done) => {
    offs.push(
      c.on('workspace.updated', (e) => {
        if (e.id === ws.id && e.removal) print(e.removal.done)
      }),
      c.on('workspace.removed', (e) => {
        if (e.id !== ws.id) return

        if (e.failed?.length) failed = true
        done()
      })
    )
  })

  try {
    await c.request('workspace.remove', { id: ws.id, deleteBranch })
    await removed
  } finally {
    for (const off of offs) off()
  }

  return failed
}

/** The workspace's most recent live terminal, or a new one. */
async function workspaceTerminal(
  c: DaemonClient,
  ws: Workspace,
  forceNew = false
): Promise<string> {
  if (!forceNew) {
    const live = (await c.request('term.list', { workspaceId: ws.id }))
      .filter((t) => t.alive)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))

    if (live[0]) return live[0].id
  }

  const { id } = await c.request('workspace.openTerminal', {
    id: ws.id,
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24
  })

  return id
}

function projectName(projects: Project[], id: string): string {
  return projects.find((p) => p.id === id)?.name ?? id
}

export function registerWorkspaceCommands(program: Command): void {
  const project = program.command('project').description('manage projects (git repositories)')
  project
    .command('add <path>')
    .description('register a git repository')
    .option('--name <name>', 'display name (defaults to the folder name)')
    .option('--json', 'print JSON')
    .action((path: string, opts: { name?: string; json?: boolean }) =>
      withClient(async (c) => {
        const p = await c.request('project.add', { path: resolve(path), name: opts.name })

        if (opts.json) printJson(p)
        else console.log(`${p.id}  ${p.name}  ${p.path}  (default branch ${p.defaultBranch})`)
      })
    )
  project
    .command('list')
    .description('list projects')
    .option('--json', 'print JSON')
    .action((opts: { json?: boolean }) =>
      withClient(async (c) => {
        const projects = await c.request('project.list')

        if (opts.json) return printJson(projects)

        if (projects.length === 0) return console.log('no projects')
        printTable(
          ['ID', 'NAME', 'DEFAULT', 'PATH'],
          projects.map((p) => [p.id, p.name, p.defaultBranch, p.path])
        )
      })
    )

  program
    .command('work [brief]')
    .description(
      'create a workspace (git worktree) from a brief and print its path; the first line of the brief is its title, and its branch and folder get a random three-word name unless --name is given'
    )
    .requiredOption('-r, --repo <repo>', 'repository path or configured repo name')
    .option(
      '--name <name>',
      'name the workspace, branch and folder yourself (default: random words)'
    )
    .option('--base <ref>', 'base ref (default: origin/<default branch>)')
    .option('--open', 'open the workspace with `code -n`')
    .option('--json', 'print the workspace as JSON')
    .action(
      (
        brief: string | undefined,
        opts: { repo: string; name?: string; base?: string; open?: boolean; json?: boolean }
      ) => {
        if (!brief?.trim() && opts.name === undefined) {
          console.error('que: give a brief (what you are doing) or --name')
          process.exitCode = 2

          return
        }

        return withClient(async (c) => {
          const p = await c.request('project.add', { repo: opts.repo, cwd: process.cwd() })
          const seen: Workspace[] = []
          c.on('workspace.updated', (e) => seen.push(e))

          const created = await c.request('workspace.create', {
            projectId: p.id,
            name: opts.name,
            brief: brief?.trim() ? brief : undefined,
            baseRef: opts.base
          })

          const ws = await waitForSetup(c, created, seen)

          if (opts.json) printJson(ws)
          else console.log(ws.path)

          if (ws.status === 'stuck') {
            const log = join(quePaths().workspaceLogsDir, `${ws.id}-setup.log`)
            console.error(`que: setup failed for ${ws.name}; see ${log}`)
            process.exitCode = 1
          }

          if (opts.open) await openInEditor(ws.path)
        })
      }
    )

  const ws = program.command('ws').description('manage workspaces')
  ws.command('list')
    .description('list workspaces')
    .option('--project <project>', 'only this project (id, name, or path)')
    .option('--json', 'print JSON')
    .action((opts: { project?: string; json?: boolean }) =>
      withClient(async (c) => {
        const projectId = opts.project ? (await findProject(c, opts.project)).id : undefined
        const list = await c.request('workspace.list', { projectId })

        if (opts.json) return printJson(list)

        if (list.length === 0) return console.log('no workspaces')
        const projects = await c.request('project.list')
        printTable(
          ['ID', 'WORKSPACE', 'PROJECT', 'BRANCH', 'STATUS', 'PATH'],
          list.map((w) => [
            w.id,
            w.title ?? w.name,
            projectName(projects, w.projectId),
            w.branch,
            w.status,
            w.path
          ])
        )
      })
    )
  ws.command('remove <workspace>')
    .description(
      'remove a workspace: kill its terminals, run teardown, remove the worktree and delete its branch'
    )
    .option('--keep-branch', 'keep its branch')
    .action((ref: string, opts: { keepBranch?: boolean }) =>
      withClient(async (c) => {
        const w = await findWorkspace(c, ref)
        const failed = await removeWorkspace(c, w, opts.keepBranch !== true)
        console.log(`removed ${w.id} (${w.name})`)

        if (failed) process.exitCode = 1
      })
    )
  ws.command('diff <workspace>')
    .description(
      'what a workspace changed against its base, committed and uncommitted, with its commits'
    )
    .option('--json', 'print JSON')
    .option('--base <ref>', 'compare against this ref instead of the default branch')
    .option('--commit <sha>', "only that commit's own changes")
    .action((ref: string, opts: { json?: boolean; base?: string; commit?: string }) =>
      withClient(async (c) => {
        const w = await findWorkspace(c, ref)

        const diff = await c.request('workspace.diff', {
          id: w.id,
          base: opts.base,
          commit: opts.commit
        })

        // The daemon falls back for a remembered base; a base typed here is an error.
        if (diff.rejectedBase !== null)
          throw new CliError(`base ${diff.rejectedBase} is not a commit`)

        if (opts.json) printJson(diff)
        else console.log(formatDiff(diff))
      })
    )
  ws.command('files <workspace>')
    .description("every file of a workspace's worktree, tracked and untracked, never ignored")
    .option('--json', 'print JSON')
    .action((ref: string, opts: { json?: boolean }) =>
      withClient(async (c) => {
        const w = await findWorkspace(c, ref)
        const listing = await c.request('workspace.files', { id: w.id })

        if (opts.json) printJson(listing)
        else console.log(formatFiles(listing))
      })
    )
  ws.command('pr <workspace>')
    .description("a workspace's pull request: its checks and its conversation")
    .option('--json', 'print JSON ({ pr, thread })')
    .option('--refresh', 'check the pull request with GitHub and fetch its conversation again')
    .action((ref: string, opts: { json?: boolean; refresh?: boolean }) =>
      withClient(async (c) => {
        await assertNotQuiet(c)
        const w = await findWorkspace(c, ref)

        const fresh =
          opts.refresh === true
            ? await c.request('workspace.checkPrs', { id: w.id })
            : await c.request('workspace.get', { id: w.id })

        const pr = fresh.pr

        const thread = pr
          ? await c.request('workspace.prThread', {
              id: w.id,
              number: pr.number,
              refresh: opts.refresh === true
            })
          : null

        if (opts.json) return printJson({ pr, thread })
        console.log(pr ? formatPrView(pr, thread) : 'no pull request')
      })
    )
  ws.command('terminal <workspace>')
    .description("print the id of the workspace's latest live terminal, opening one if needed")
    .option('--new', 'always open a new terminal')
    .action((ref: string, opts: { new?: boolean }) =>
      withClient(async (c) => {
        await assertNotQuiet(c)
        console.log(await workspaceTerminal(c, await findWorkspace(c, ref), opts.new === true))
      })
    )

  program
    .command('status')
    .description('summary and per-workspace status')
    .option('--json', 'print JSON')
    .action((opts: { json?: boolean }) =>
      withClient(async (c) => {
        const [list, projects, quiet] = await Promise.all([
          c.request('workspace.list'),
          c.request('project.list'),
          c.request('quiet.state')
        ])

        const summary = summarize(list)

        if (opts.json) {
          const out: StatusJson = {
            summary,
            quiet,
            workspaces: list.map((w) => ({
              id: w.id,
              name: w.name,
              project: projectName(projects, w.projectId),
              projectId: w.projectId,
              branch: w.branch,
              path: w.path,
              status: w.status,
              reason: w.statusReason,
              lastActivityAt: w.lastActivityAt,
              sessionId: w.sessionId,
              pr: w.pr
            }))
          }

          return printJson(out)
        }

        if (quiet.inQuietHours) console.log(describeQuietState(quiet))
        console.log(
          `working ${summary.working} · needs input ${summary.needs_input} · stuck ${summary.stuck} · idle ${summary.idle} · exited ${summary.exited} · preparing ${summary.preparing} · removing ${summary.removing}`
        )

        if (list.length === 0) return console.log('no workspaces')
        printTable(
          ['WORKSPACE', 'PROJECT', 'STATUS', 'REASON', 'PR', 'ACTIVE', 'SESSION'],
          list.map((w) => [
            w.name,
            projectName(projects, w.projectId),
            w.status,
            w.statusReason ?? '-',
            formatPr(w.pr),
            formatAge(w.lastActivityAt ?? w.statusAt, Date.now()),
            w.sessionId ? w.sessionId.slice(0, 8) : '-'
          ])
        )
      }, false)
    )

  program
    .command('attach <workspace>')
    .description(
      "attach to the workspace's latest terminal, opening one if needed (Ctrl-] detaches)"
    )
    .action(async (ref: string) => {
      const id = await withClient(async (c) => workspaceTerminal(c, await findWorkspace(c, ref)))
      await attach(id)
    })

  program
    .command('open <workspace>')
    .description('open the workspace with `code -n`')
    .action((ref: string) =>
      withClient(async (c) => {
        await assertNotQuiet(c)
        await openInEditor((await findWorkspace(c, ref)).path)
      }, false)
    )
}
