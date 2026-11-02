// Projects and workspaces over the real socket, against real git repos in the
// test's QUE_HOME: worktree creation, include copies, setup/teardown from
// que.toml, refusals, and removal in the background, step by step.
import fs from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DaemonClient } from '@shared/client'
import {
  recordStatuses,
  recordEvents,
  startTestDaemon,
  type TestDaemon,
  waitForStatus,
  withQuietOff
} from '../../src/testing/daemon-harness'
import { readFakeLog } from '../../src/testing/fakes'
import { pidAlive } from '../../src/shared/process'
import { removalStep } from '../../src/shared/removal'
import { addBareOrigin, gitIn, makeTempRepo } from '../../src/testing/temp-repo'

let daemon: TestDaemon
let client: DaemonClient

beforeEach(async () => {
  daemon = await startTestDaemon()
  client = daemon.client
})

afterEach(async () => {
  await daemon.close()
})

describe('projects', () => {
  it('registers the git toplevel once, with its default branch', async () => {
    const repo = makeTempRepo(daemon.home)
    fs.mkdirSync(join(repo, 'src'))

    const project = await client.request('project.add', { path: repo })
    const again = await client.request('project.add', { path: join(repo, 'src') })

    expect(project).toMatchObject({ name: 'uploader', path: repo, defaultBranch: 'main' })
    expect(project.id).toMatch(/^prj_[a-z2-7]{12}$/)
    expect(again.id).toBe(project.id)
    expect(await client.request('project.list')).toEqual([project])
  })

  it("takes the default branch from origin's HEAD in a clone", async () => {
    const origin = makeTempRepo(daemon.home, { name: 'origin-uploader', branch: 'develop' })
    gitIn(daemon.home, 'clone', '--quiet', origin, join(daemon.home, 'uploader'))

    const project = await client.request('project.add', { path: join(daemon.home, 'uploader') })

    expect(project).toMatchObject({ name: 'uploader', defaultBranch: 'develop' })
  })

  it('resolves repo through the config registry, then as a directory', async () => {
    const repo = makeTempRepo(daemon.home)
    const other = makeTempRepo(daemon.home, { name: 'other-dir' })
    fs.writeFileSync(daemon.configPath, withQuietOff(`[repos.uploader-api]\npath = "${repo}"\n`))

    const named = await client.request('project.add', { repo: 'uploader-api' })
    const dir = await client.request('project.add', { repo: other })

    expect(named).toMatchObject({ name: 'uploader-api', path: repo })
    expect(dir).toMatchObject({ name: 'other-dir', path: other })
  })

  it('refuses to add a project while the config file is invalid, but keeps answering other requests', async () => {
    const repo = makeTempRepo(daemon.home)
    const before = await client.request('config.get')
    fs.writeFileSync(daemon.configPath, 'stall_timeout_minutes = "many"\n')

    await expect(client.request('project.add', { path: repo })).rejects.toMatchObject({
      code: 'bad_request',
      message: 'invalid que config: stall_timeout_minutes: must be a positive number'
    })
    expect(await client.request('workspace.list')).toEqual([])
    expect((await client.request('config.get')).config).toEqual(before.config)

    fs.writeFileSync(daemon.configPath, withQuietOff())

    expect(await client.request('project.add', { path: repo })).toMatchObject({ path: repo })
  })

  it('prefers a configured name over a directory of that name under cwd', async () => {
    const repo = makeTempRepo(daemon.home)
    const shadow = join(daemon.home, 'shadow-parent')
    fs.mkdirSync(join(shadow, 'uploader-api'), { recursive: true })
    fs.writeFileSync(daemon.configPath, withQuietOff(`[repos.uploader-api]\npath = "${repo}"\n`))

    const project = await client.request('project.add', { repo: 'uploader-api', cwd: shadow })

    expect(project).toMatchObject({ name: 'uploader-api', path: repo })
  })

  it('resolves a relative repo directory against cwd', async () => {
    const repo = makeTempRepo(daemon.home)

    const project = await client.request('project.add', {
      repo: 'uploader',
      cwd: join(repo, '..')
    })

    expect(project.path).toBe(repo)
  })

  it('reports a repo that is neither configured nor a directory as not_found', async () => {
    await expect(client.request('project.add', { repo: 'nope' })).rejects.toMatchObject({
      code: 'not_found',
      message: 'no configured repo or directory named nope'
    })
  })

  it('needs exactly one of path or repo', async () => {
    const repo = makeTempRepo(daemon.home)

    await expect(client.request('project.add', {})).rejects.toMatchObject({ code: 'bad_request' })
    await expect(client.request('project.add', { path: repo, repo })).rejects.toMatchObject({
      code: 'bad_request'
    })
  })

  it('rejects a directory that is not a git repository', async () => {
    const plain = join(daemon.home, 'notes')
    fs.mkdirSync(plain)

    await expect(client.request('project.add', { path: plain })).rejects.toMatchObject({
      code: 'bad_request'
    })
  })

  it('refuses to remove a project with workspaces unless forced', async () => {
    const project = await client.request('project.add', { path: makeTempRepo(daemon.home) })

    const ws = await client.request('workspace.create', {
      projectId: project.id,
      name: 'app-1440-quiet-board'
    })

    await expect(client.request('project.remove', { id: project.id })).rejects.toMatchObject({
      code: 'conflict'
    })
    await client.request('project.remove', { id: project.id, force: true })

    expect(await client.request('project.list')).toEqual([])
    expect(fs.existsSync(ws.path)).toBe(false)
  }, 20_000)
})

describe('workspaces', () => {
  describe('create', () => {
    it('makes a worktree on its own branch, copies includes, runs setup, and goes idle', async () => {
      const repo = makeTempRepo(daemon.home, {
        queToml: `setup = "printf ready > .que-setup-ok; echo setup-output-3e1d"
worktree_include = ["config/local", "missing.json"]
`,
        ignored: { '.env': 'API_TOKEN=tok_51f2\n', 'config/local/db.json': '{"port":5433}\n' }
      })

      fs.writeFileSync(join(repo, '.worktreeinclude'), '.env\n')
      const mainHead = gitIn(repo, 'rev-parse', 'HEAD')
      const created = recordEvents(client, 'workspace.created')
      const statuses = recordStatuses(client)
      const project = await client.request('project.add', { path: repo })

      const ws = await client.request('workspace.create', {
        projectId: project.id,
        name: 'APP-1432 retry logic'
      })

      expect(ws).toMatchObject({
        projectId: project.id,
        name: 'app-1432-retry-logic',
        branch: 'app-1432-retry-logic',
        path: join(daemon.home, 'worktrees', 'uploader', 'app-1432-retry-logic'),
        baseRef: 'main',
        status: 'preparing'
      })
      expect(ws.id).toMatch(/^ws_[a-z2-7]{12}$/)
      expect(created).toEqual([ws])
      expect(gitIn(ws.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('app-1432-retry-logic')
      expect(gitIn(ws.path, 'rev-parse', 'HEAD')).toBe(mainHead)
      expect(fs.readFileSync(join(ws.path, '.env'), 'utf8')).toBe('API_TOKEN=tok_51f2\n')
      expect(fs.readFileSync(join(ws.path, 'config/local/db.json'), 'utf8')).toContain('5433')

      await expect
        .poll(() => statuses.filter((s) => s.id === ws.id).map((s) => s.status), {
          timeout: 10_000
        })
        .toEqual(['preparing', 'idle'])
      expect(fs.readFileSync(join(ws.path, '.que-setup-ok'), 'utf8')).toBe('ready')
      expect(
        fs.readFileSync(join(daemon.home, 'logs', 'workspaces', `${ws.id}-setup.log`), 'utf8')
      ).toContain('setup-output-3e1d')
      expect(await client.request('workspace.get', { id: ws.id })).toMatchObject({
        status: 'idle'
      })
      expect(await client.request('workspace.list', { projectId: project.id })).toHaveLength(1)
    }, 20_000)

    it('is stuck with setup_failed when the setup command fails', async () => {
      const repo = makeTempRepo(daemon.home, { queToml: 'setup = "echo boom-7a2c >&2; exit 3"\n' })
      const project = await client.request('project.add', { path: repo })

      const ws = await client.request('workspace.create', {
        projectId: project.id,
        name: 'app-1433-flaky-setup'
      })

      await expect
        .poll(async () => client.request('workspace.get', { id: ws.id }), { timeout: 10_000 })
        .toMatchObject({ status: 'stuck', statusReason: 'setup_failed' })
      expect(
        fs.readFileSync(join(daemon.home, 'logs', 'workspaces', `${ws.id}-setup.log`), 'utf8')
      ).toContain('boom-7a2c')
    }, 20_000)

    it('bases a clone on origin/<default branch> after fetching', async () => {
      const origin = makeTempRepo(daemon.home, { name: 'origin-uploader', branch: 'develop' })
      const clone = join(daemon.home, 'uploader')
      gitIn(daemon.home, 'clone', '--quiet', origin, clone)
      fs.writeFileSync(join(origin, 'CHANGELOG.md'), '## 2.1.0\n')
      gitIn(origin, 'add', '.')
      gitIn(origin, 'commit', '-m', 'Changelog for 2.1.0')
      const project = await client.request('project.add', { path: clone })

      const ws = await client.request('workspace.create', {
        projectId: project.id,
        name: 'app-1450-changelog'
      })

      expect(ws.baseRef).toBe('origin/develop')
      expect(gitIn(ws.path, 'rev-parse', 'HEAD')).toBe(gitIn(origin, 'rev-parse', 'HEAD'))
    }, 20_000)
  })

  describe('errors', () => {
    it('refuses bad names, taken branches, duplicates, and unknown projects', async () => {
      const repo = makeTempRepo(daemon.home)
      gitIn(repo, 'branch', 'app-1460-taken')
      const project = await client.request('project.add', { path: repo })
      await client.request('workspace.create', { projectId: project.id, name: 'app-1461-dupe' })

      await expect(
        client.request('workspace.create', { projectId: project.id, name: '!!!' })
      ).rejects.toMatchObject({ code: 'bad_request' })
      await expect(
        client.request('workspace.create', { projectId: project.id, name: 'app-1460-taken' })
      ).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('branch') })
      await expect(
        client.request('workspace.create', { projectId: project.id, name: 'APP-1461 dupe' })
      ).rejects.toMatchObject({ code: 'conflict' })
      await expect(
        client.request('workspace.create', { projectId: 'prj_missing0000', name: 'app-1462' })
      ).rejects.toMatchObject({ code: 'not_found' })
      expect(fs.existsSync(join(daemon.home, 'worktrees', 'uploader', 'app-1460-taken'))).toBe(
        false
      )
    }, 20_000)
  })

  describe('remove', () => {
    /** A teardown that waits while `hold` exists, then writes the directory it ran in to `marker`. */
    function heldTeardown(): { hold: string; marker: string; queToml: string } {
      const hold = join(daemon.home, 'teardown-hold')
      const marker = join(daemon.home, 'teardown-ran.txt')
      fs.writeFileSync(hold, '')

      return {
        hold,
        marker,
        queToml: `setup = "true"\nteardown = "while [ -e '${hold}' ]; do sleep 0.05; done; pwd > '${marker}'"\n`
      }
    }

    async function createIn(repo: string, name: string) {
      const project = await client.request('project.add', { path: repo })
      const ws = await client.request('workspace.create', { projectId: project.id, name })
      await waitForStatus(daemon, ws.id, 'idle')

      return ws
    }

    async function stepOf(id: string) {
      const { removal } = await client.request('workspace.get', { id })

      return removal && removalStep(removal)
    }

    it('returns while the removal runs, reporting each step, then removes the worktree and branch', async () => {
      const teardown = heldTeardown()
      const repo = makeTempRepo(daemon.home, { queToml: teardown.queToml })
      const ws = await createIn(repo, 'app-1470-cleanup')
      const created = recordEvents(client, 'term.created')

      const { id: termId } = await client.request('workspace.openTerminal', {
        id: ws.id,
        cols: 80,
        rows: 24
      })

      const [term] = await client.request('term.list', { workspaceId: ws.id })
      // The foreground program is read after the announcement and may be known by the list.
      await expect.poll(() => created.length).toBe(1)
      expect(term).toMatchObject({ id: termId, workspaceId: ws.id, cwd: ws.path, alive: true })
      const killed = recordEvents(client, 'term.killed')
      const updated = recordEvents(client, 'workspace.updated')
      const removed = recordEvents(client, 'workspace.removed')

      expect(await client.request('workspace.remove', { id: ws.id, deleteBranch: true })).toEqual({
        ok: true
      })

      expect(fs.existsSync(ws.path)).toBe(true)
      expect(await client.request('workspace.get', { id: ws.id })).toMatchObject({
        status: 'removing',
        removal: { plan: ['terminals', 'teardown', 'worktree', 'branch'] }
      })
      await expect.poll(() => stepOf(ws.id), { timeout: 5_000 }).toBe('teardown')
      expect(killed).toContainEqual({ id: termId })
      await expect.poll(() => pidAlive(term.pid), { timeout: 5_000 }).toBe(false)

      fs.rmSync(teardown.hold)

      await expect.poll(() => removed, { timeout: 10_000 }).toEqual([{ id: ws.id }])
      const rows = updated.filter((u) => u.id === ws.id)
      expect(rows.every((u) => u.status === 'removing')).toBe(true)
      expect(rows.map((u) => u.removal && removalStep(u.removal))).toEqual([
        'terminals',
        'teardown',
        'worktree',
        'branch',
        null
      ])
      expect(rows.map((u) => u.removal?.done.map((d) => d.step))).toEqual([
        [],
        ['terminals'],
        ['terminals', 'teardown'],
        ['terminals', 'teardown', 'worktree'],
        ['terminals', 'teardown', 'worktree', 'branch']
      ])
      expect(rows.at(-1)?.removal?.done).toEqual(
        ['terminals', 'teardown', 'worktree', 'branch'].map((step) => ({
          step,
          ms: expect.any(Number)
        }))
      )
      expect(fs.readFileSync(teardown.marker, 'utf8').trim()).toBe(ws.path)
      expect(fs.existsSync(ws.path)).toBe(false)
      expect(gitIn(repo, 'worktree', 'list')).not.toContain(ws.path)
      expect(gitIn(repo, 'branch', '--list', 'app-1470-cleanup')).toBe('')
      expect(await client.request('workspace.list')).toEqual([])
      await expect(client.request('workspace.get', { id: ws.id })).rejects.toMatchObject({
        code: 'not_found'
      })
    }, 30_000)

    it('keeps the branch when deleteBranch is false and empties the trash afterwards', async () => {
      const repo = makeTempRepo(daemon.home)
      const ws = await createIn(repo, 'app-1472-keep-branch')
      fs.writeFileSync(join(ws.path, 'notes.txt'), 'kept out of git\n')
      const removed = recordEvents(client, 'workspace.removed')

      await client.request('workspace.remove', { id: ws.id, deleteBranch: false })

      expect((await client.request('workspace.get', { id: ws.id })).removal?.plan).toEqual([
        'terminals',
        'worktree'
      ])
      await expect.poll(() => removed, { timeout: 10_000 }).toEqual([{ id: ws.id }])
      expect(fs.existsSync(ws.path)).toBe(false)
      expect(gitIn(repo, 'worktree', 'list')).not.toContain(ws.path)
      expect(gitIn(repo, 'branch', '--list', 'app-1472-keep-branch')).toBe('app-1472-keep-branch')
      await expect
        .poll(() => fs.readdirSync(join(daemon.home, 'worktrees', '.trash')), { timeout: 10_000 })
        .toEqual([])
    }, 30_000)

    it('deletes the branch checked out in the worktree after it was created', async () => {
      const repo = makeTempRepo(daemon.home)
      const ws = await createIn(repo, 'app-1471-switch')
      gitIn(ws.path, 'checkout', '--quiet', '-b', 'fix/upload-timeout')
      const removed = recordEvents(client, 'workspace.removed')

      await client.request('workspace.remove', { id: ws.id, deleteBranch: true })

      await expect.poll(() => removed, { timeout: 10_000 }).toEqual([{ id: ws.id }])
      expect(fs.existsSync(ws.path)).toBe(false)
      expect(gitIn(repo, 'branch', '--list', 'fix/upload-timeout')).toBe('')
    }, 20_000)

    it('records a teardown that outlives teardown_timeout_seconds as failed and still removes the rest', async () => {
      fs.writeFileSync(daemon.configPath, withQuietOff('teardown_timeout_seconds = 1\n'))
      const repo = makeTempRepo(daemon.home, { queToml: 'setup = "true"\nteardown = "sleep 30"\n' })
      const ws = await createIn(repo, 'app-1473-slow-teardown')
      const removed = recordEvents(client, 'workspace.removed')

      await client.request('workspace.remove', { id: ws.id, deleteBranch: true })

      await expect.poll(() => removed, { timeout: 10_000 }).toHaveLength(1)
      expect(removed[0]).toEqual({
        id: ws.id,
        failed: [{ step: 'teardown', ms: expect.any(Number), error: 'timed out after 1s' }]
      })
      expect(removed[0].failed?.[0].ms).toBeGreaterThanOrEqual(1_000)
      expect(fs.existsSync(ws.path)).toBe(false)
      expect(gitIn(repo, 'branch', '--list', 'app-1473-slow-teardown')).toBe('')
      expect(await client.request('workspace.list')).toEqual([])
    }, 20_000)

    it('leaves the status removing when a terminal of the workspace exits during the removal', async () => {
      const teardown = heldTeardown()
      const repo = makeTempRepo(daemon.home, { queToml: teardown.queToml })
      const ws = await createIn(repo, 'app-1474-late-exit')
      await client.request('workspace.remove', { id: ws.id, deleteBranch: false })
      await expect.poll(() => stepOf(ws.id), { timeout: 5_000 }).toBe('teardown')
      const exited = recordEvents(client, 'term.exit')

      const { id: termId } = await client.request('workspace.openTerminal', {
        id: ws.id,
        cols: 80,
        rows: 24
      })

      await client.request('term.write', { id: termId, data: 'exit\r' })

      await expect.poll(() => exited.map((e) => e.id), { timeout: 10_000 }).toContain(termId)
      const during = await client.request('workspace.get', { id: ws.id })
      expect(during.status).toBe('removing')
      expect(during.removal && removalStep(during.removal)).toBe('teardown')

      const removed = recordEvents(client, 'workspace.removed')
      fs.rmSync(teardown.hold)
      await expect.poll(() => removed, { timeout: 10_000 }).toEqual([{ id: ws.id }])
    }, 30_000)

    it('resumes a removal the daemon was stopped in when it starts again', async () => {
      const teardown = heldTeardown()
      const repo = makeTempRepo(daemon.home, { queToml: teardown.queToml })
      const ws = await createIn(repo, 'app-1475-restart')
      await client.request('workspace.remove', { id: ws.id, deleteBranch: true })
      await expect.poll(() => stepOf(ws.id), { timeout: 5_000 }).toBe('teardown')

      await daemon.close({ keepHome: true })
      fs.rmSync(teardown.hold)
      daemon = await startTestDaemon({ home: daemon.home })
      client = daemon.client

      await expect.poll(() => client.request('workspace.list'), { timeout: 10_000 }).toEqual([])
      expect(fs.readFileSync(teardown.marker, 'utf8').trim()).toBe(ws.path)
      expect(fs.existsSync(ws.path)).toBe(false)
      expect(gitIn(repo, 'worktree', 'list')).not.toContain(ws.path)
      expect(gitIn(repo, 'branch', '--list', 'app-1475-restart')).toBe('')
    }, 30_000)
  })
})

const THREE_WORDS = /^[a-z]+-[a-z]+-[a-z]+$/

describe('workspaces from a brief', () => {
  const brief = 'Fix the flaky upload test\n\nIt times out on slow CI runners; raise the timeout.'

  it('takes the title from the first line, draws a three-word name, and writes the brief', async () => {
    const repo = makeTempRepo(daemon.home)
    const project = await client.request('project.add', { path: repo })

    const ws = await client.request('workspace.create', { projectId: project.id, brief })

    expect(ws.name).toMatch(THREE_WORDS)
    expect(ws).toMatchObject({
      branch: ws.name,
      path: join(daemon.home, 'worktrees', 'uploader', ws.name),
      title: 'Fix the flaky upload test',
      brief
    })
    expect(gitIn(ws.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(ws.name)
    expect(fs.readFileSync(join(ws.path, '.que', 'brief.md'), 'utf8')).toBe(brief)
    expect(gitIn(ws.path, 'status', '--porcelain')).toBe('')
    expect(await client.request('workspace.get', { id: ws.id })).toMatchObject({
      title: 'Fix the flaky upload test',
      brief
    })
  }, 20_000)

  it('gives two workspaces from the same brief different names, and keeps a given name exactly', async () => {
    const project = await client.request('project.add', { path: makeTempRepo(daemon.home) })

    const first = await client.request('workspace.create', { projectId: project.id, brief })

    const second = await client.request('workspace.create', {
      projectId: project.id,
      title: 'Speed up the diff view',
      brief
    })

    const named = await client.request('workspace.create', {
      projectId: project.id,
      name: 'APP-1490 upload timeout',
      brief
    })

    expect(second.name).toMatch(THREE_WORDS)
    expect(second.name).not.toBe(first.name)
    expect(second.title).toBe('Speed up the diff view')
    expect(named).toMatchObject({
      name: 'app-1490-upload-timeout',
      title: 'Fix the flaky upload test'
    })
    await expect(
      client.request('workspace.create', { projectId: project.id, name: first.name, brief })
    ).rejects.toMatchObject({ code: 'conflict' })
  }, 20_000)

  it('draws again when the name, branch, or folder is taken, and gives up after 50 draws', async () => {
    await daemon.close()
    const draws = ['taken-branch-name', 'calm-amber-otter', 'calm-amber-otter', 'brisk-tidy-heron']
    let n = 0
    daemon = await startTestDaemon({
      randomWorkspaceName: () => draws[Math.min(n++, draws.length - 1)]
    })
    client = daemon.client
    const repo = makeTempRepo(daemon.home)
    gitIn(repo, 'branch', 'taken-branch-name')
    const project = await client.request('project.add', { path: repo })

    const first = await client.request('workspace.create', { projectId: project.id, brief })
    const second = await client.request('workspace.create', { projectId: project.id, brief })
    expect([first.name, second.name]).toEqual(['calm-amber-otter', 'brisk-tidy-heron'])

    await expect(
      client.request('workspace.create', { projectId: project.id, brief })
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(n).toBe(54)
  }, 30_000)
})

describe('workspace.start', () => {
  /** The claude runs the fake recorded, once at least `n` have started. */
  async function claudeRuns(n = 1) {
    await expect
      .poll(() => readFakeLog(daemon.claudeLog).length, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(n)

    return readFakeLog(daemon.claudeLog)
  }

  it('opens the first terminal at once and, once setup ends, starts claude on the brief verbatim', async () => {
    const gate = join(daemon.home, 'setup-gate')

    const repo = makeTempRepo(daemon.home, {
      queToml: `setup = "until [ -f '${gate}' ]; do sleep 0.05; done"\n`
    })

    const instructions = join(daemon.home, 'instructions.md')
    fs.writeFileSync(instructions, 'Delegate broad searches to a smaller model.\n')
    await client.request('config.set', { patch: { instructionsFile: instructions } })
    const project = await client.request('project.add', { path: repo })

    const brief =
      'Don\'t drop uploads on a 503\n\nRetry with backoff; cap the wait at $MAX_WAIT seconds.\n  Keep `the` indent and "quotes".'

    const ws = await client.request('workspace.create', { projectId: project.id, brief })

    const { terminal } = await client.request('workspace.start', { id: ws.id })

    expect(await client.request('term.list', { workspaceId: ws.id })).toMatchObject([
      { id: terminal.id, cwd: ws.path, alive: true }
    ])
    expect((await client.request('workspace.get', { id: ws.id })).status).toBe('preparing')
    expect(readFakeLog(daemon.claudeLog)).toEqual([])

    fs.writeFileSync(gate, '')

    const [started] = await claudeRuns()
    expect(started.argv.at(-1)).toBe(brief)
    expect(started.argv[started.argv.indexOf('--append-system-prompt-file') + 1]).toBe(instructions)
    const again = await client.request('workspace.start', { id: ws.id })
    expect(again.terminal.id).toBe(terminal.id)
    expect(await client.request('term.list', { workspaceId: ws.id })).toHaveLength(1)
  }, 30_000)

  it('sends a configured start prompt instead of the brief', async () => {
    await client.request('config.set', {
      patch: { startPrompt: "Read .que/brief.md, then say what you'd do first." }
    })
    const project = await client.request('project.add', { path: makeTempRepo(daemon.home) })

    const ws = await client.request('workspace.create', {
      projectId: project.id,
      brief: 'Fix the flaky upload test'
    })

    await client.request('workspace.start', { id: ws.id })

    const [started] = await claudeRuns()
    expect(started.argv.at(-1)).toBe("Read .que/brief.md, then say what you'd do first.")
  }, 30_000)

  it('starts a bare claude in a workspace without a brief', async () => {
    const project = await client.request('project.add', { path: makeTempRepo(daemon.home) })

    const ws = await client.request('workspace.create', {
      projectId: project.id,
      name: 'app-1490-no-brief'
    })

    await client.request('workspace.start', { id: ws.id })

    const [started] = await claudeRuns()
    expect(started.argv).toEqual(['--settings', join(daemon.home, 'hooks.json')])
  }, 30_000)

  it('answers not_found for an unknown workspace', async () => {
    await expect(
      client.request('workspace.start', { id: 'ws_missing00000' })
    ).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('workspace.rename', () => {
  async function created() {
    const repo = makeTempRepo(daemon.home)
    const project = await client.request('project.add', { path: repo })

    const ws = await client.request('workspace.create', {
      projectId: project.id,
      brief: 'Fix the flaky upload test'
    })

    // Setup's own workspace.updated is out of the way before a test records events.
    await waitForStatus(daemon, ws.id, 'idle')

    return { repo, ws }
  }

  it('changes the title, announces it, and keeps the branch and folder', async () => {
    const { ws } = await created()
    const updated = recordEvents(client, 'workspace.updated')

    const renamed = await client.request('workspace.rename', {
      id: ws.id,
      title: '  Raise the upload test timeout '
    })

    expect(renamed).toMatchObject({
      title: 'Raise the upload test timeout',
      name: ws.name,
      branch: ws.branch,
      path: ws.path
    })
    expect(updated).toEqual([renamed])
    expect(await client.request('workspace.get', { id: ws.id })).toEqual(renamed)
    await expect(
      client.request('workspace.rename', { id: ws.id, title: ' ' })
    ).rejects.toMatchObject({ code: 'bad_request' })
  }, 20_000)

  it('renames a branch never pushed, but not to an invalid or existing name', async () => {
    const { repo, ws } = await created()
    gitIn(repo, 'branch', 'taken-branch-name')
    expect(await client.request('workspace.canRenameBranch', { id: ws.id })).toEqual({
      allowed: true
    })

    const renamed = await client.request('workspace.rename', {
      id: ws.id,
      title: 'Raise the upload test timeout',
      branch: 'fix/upload-timeout'
    })

    expect(renamed).toMatchObject({
      branch: 'fix/upload-timeout',
      name: ws.name,
      path: ws.path
    })
    expect(gitIn(ws.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('fix/upload-timeout')
    await expect(
      client.request('workspace.rename', { id: ws.id, title: 'Again', branch: 'taken-branch-name' })
    ).rejects.toMatchObject({ code: 'conflict' })
    await expect(
      client.request('workspace.rename', { id: ws.id, title: 'Again', branch: 'bad..name' })
    ).rejects.toMatchObject({ code: 'bad_request' })
    expect(await client.request('workspace.get', { id: ws.id })).toMatchObject({
      title: 'Raise the upload test timeout',
      branch: 'fix/upload-timeout'
    })
  }, 20_000)

  it('keeps the name of a branch that is on origin', async () => {
    const { repo, ws } = await created()
    addBareOrigin(repo)
    gitIn(ws.path, 'push', '--quiet', 'origin', ws.branch)
    gitIn(ws.path, 'fetch', '--quiet', 'origin')

    expect(await client.request('workspace.canRenameBranch', { id: ws.id })).toEqual({
      allowed: false
    })
    await expect(
      client.request('workspace.rename', {
        id: ws.id,
        title: 'Raise the upload test timeout',
        branch: 'raise-the-upload-test-timeout'
      })
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(gitIn(ws.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(ws.branch)

    // The same branch is not a rename: the title still changes.
    const renamed = await client.request('workspace.rename', {
      id: ws.id,
      title: 'Raise the upload test timeout',
      branch: ws.branch
    })

    expect(renamed).toMatchObject({ title: 'Raise the upload test timeout', branch: ws.branch })
  }, 20_000)
})

describe('workspace.seen', () => {
  it('records when the app had it selected, announces it, and keeps it', async () => {
    const repo = makeTempRepo(daemon.home)
    const project = await client.request('project.add', { path: repo })

    const ws = await client.request('workspace.create', {
      projectId: project.id,
      name: 'app-1501-chunked-uploads'
    })

    expect(ws).toMatchObject({ finishedAt: null, seenAt: null })
    // Setup's own workspace.updated is out of the way before the test records events.
    await waitForStatus(daemon, ws.id, 'idle')
    const updated = recordEvents(client, 'workspace.updated')

    const seen = await client.request('workspace.seen', { id: ws.id })

    expect(seen.seenAt).toMatch(/^\d{4}-\d\d-\d\dT/)
    expect(updated).toEqual([seen])
    expect((await client.request('workspace.get', { id: ws.id })).seenAt).toBe(seen.seenAt)
    await expect(client.request('workspace.seen', { id: 'ws_01hzxnope000' })).rejects.toMatchObject(
      { code: 'not_found' }
    )
  }, 20_000)
})
