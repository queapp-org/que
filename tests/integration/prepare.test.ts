// workspace.prepare over the real socket, against real git repos: the row exists before the slow
// work, the steps run in order and are announced, a step can fail, a restart resumes them, and a
// removal stops them. And the blocking workspace.create beside it, whose contract stays as it was.
import fs from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DaemonClient } from '@shared/client'
import { preparationStep } from '@shared/preparation'
import { METHODS, type MethodName } from '@shared/protocol'
import type { PreparationStep, Workspace } from '@shared/types'
import {
  recordEvents,
  recordStatuses,
  startTestDaemon,
  type TestDaemon,
  waitForStatus
} from '../../src/testing/daemon-harness'
import { readFakeLog } from '../../src/testing/fakes'
import { addBareOrigin, gitIn, makeTempRepo } from '../../src/testing/temp-repo'

const THREE_WORDS = /^[a-z]+-[a-z]+-[a-z]+$/

let daemon: TestDaemon
let client: DaemonClient

beforeEach(async () => {
  daemon = await startTestDaemon()
  client = daemon.client
})

afterEach(async () => {
  await daemon.close()
})

/** A daemon on the same home, as after a restart. */
async function restart(): Promise<void> {
  await daemon.close({ keepHome: true })
  daemon = await startTestDaemon({ home: daemon.home })
  client = daemon.client
}

async function addProject(repo: string): Promise<string> {
  return (await client.request('project.add', { path: repo })).id
}

/**
 * Makes `git fetch origin` wait while the returned `hold` file exists (remove it to let the fetch
 * go); `reached` resolves once a fetch is waiting there.
 */
function holdFetch(repo: string): { hold: string; reached: () => Promise<void> } {
  const hold = join(daemon.home, 'fetch-hold')
  const marker = join(daemon.home, 'fetch-reached')
  const script = join(daemon.home, 'held-upload-pack')
  fs.writeFileSync(hold, '')
  fs.writeFileSync(
    script,
    `#!/bin/sh\n: > '${marker}'\nwhile [ -e '${hold}' ]; do sleep 0.05; done\nexec git upload-pack "$@"\n`,
    { mode: 0o755 }
  )
  gitIn(repo, 'config', 'remote.origin.uploadpack', script)

  return {
    hold,
    reached: async () => {
      await expect.poll(() => fs.existsSync(marker), { timeout: 10_000 }).toBe(true)
    }
  }
}

/** A setup that waits until the returned file exists, then records a run in `.setup-runs`. */
function heldSetup(): { gate: string; queToml: string } {
  const gate = join(daemon.home, 'setup-gate')

  return {
    gate,
    queToml: `setup = "until [ -f '${gate}' ]; do sleep 0.05; done; echo ran >> .setup-runs"\n`
  }
}

async function stepOf(id: string): Promise<PreparationStep | null | undefined> {
  const { preparation } = await client.request('workspace.get', { id })

  return preparation && preparationStep(preparation)
}

async function claudeRuns(n = 1): Promise<ReturnType<typeof readFakeLog>> {
  await expect
    .poll(() => readFakeLog(daemon.claudeLog).length, { timeout: 20_000 })
    .toBeGreaterThanOrEqual(n)

  return readFakeLog(daemon.claudeLog)
}

/** Every method that needs a finished worktree, with params it would otherwise take. */
const NEEDS_WORKTREE: Partial<Record<MethodName, (id: string) => Record<string, unknown>>> = {
  'workspace.openTerminal': (id) => ({ id, cols: 80, rows: 24 }),
  'workspace.start': (id) => ({ id }),
  'workspace.canRenameBranch': (id) => ({ id }),
  'workspace.diff': (id) => ({ id }),
  'workspace.diffFile': (id) => ({ id, path: 'README.md' }),
  'workspace.prThread': (id) => ({ id, number: 1 }),
  'workspace.checkPrs': (id) => ({ id }),
  'workspace.files': (id) => ({ id }),
  'workspace.readFile': (id) => ({ id, path: 'README.md' }),
  'workspace.watch': (id) => ({ id })
}

/** What each guarded method answers for the workspace: `ok`, or its error code. */
async function answers(id: string): Promise<Record<string, string>> {
  const seen: Record<string, string> = {}

  for (const [method, params] of Object.entries(NEEDS_WORKTREE)) {
    seen[method] = await client.request(method as MethodName, params(id) as never).then(
      () => 'ok',
      (e: { code?: string }) => e.code ?? 'error'
    )
  }

  return seen
}

const REFUSED = Object.fromEntries(Object.keys(NEEDS_WORKTREE).map((m) => [m, 'conflict']))

describe('workspace.prepare', () => {
  it('answers with the row before the fetch, runs the steps in order, and starts a bare claude with the hooks', async () => {
    const repo = makeTempRepo(daemon.home, { queToml: 'setup = "echo ready > .setup-ran"\n' })
    addBareOrigin(repo)
    const fetch = holdFetch(repo)
    const projectId = await addProject(repo)
    const created = recordEvents(client, 'workspace.created')
    const journey: Array<PreparationStep | 'terminal' | 'ready' | null> = []

    const note = (w: Workspace): void => {
      journey.push(w.preparation ? preparationStep(w.preparation) : 'ready')
    }

    client.on('workspace.updated', note)
    client.on('term.created', () => journey.push('terminal'))

    const ws = await client.request('workspace.prepare', { projectId, start: true })

    expect(ws).toMatchObject({ status: 'preparing', baseRef: '' })
    expect(ws.name).toMatch(THREE_WORDS)
    expect(ws.preparation).toMatchObject({
      plan: ['fetch', 'worktree', 'setup', 'claude'],
      done: []
    })
    expect(created).toEqual([ws])
    await fetch.reached()
    expect(await stepOf(ws.id)).toBe('fetch')
    expect(fs.existsSync(ws.path)).toBe(false)
    expect(await client.request('term.list', { workspaceId: ws.id })).toEqual([])

    fs.rmSync(fetch.hold)

    const [started] = await claudeRuns()

    expect(started.argv).toEqual(['--settings', join(daemon.home, 'hooks.json')])
    expect(journey.slice(0, 5)).toEqual(['worktree', 'setup', 'claude', 'terminal', 'ready'])
    const row = await client.request('workspace.get', { id: ws.id })
    expect(row.preparation).toBeUndefined()
    expect(row.baseRef).toBe('origin/main')
    expect(fs.readFileSync(join(ws.path, '.setup-ran'), 'utf8')).toBe('ready\n')
    expect(gitIn(ws.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(ws.name)
    expect(await client.request('term.list', { workspaceId: ws.id })).toMatchObject([
      { cwd: ws.path, alive: true }
    ])
    expect(await client.request('workspace.list')).toHaveLength(1)
  }, 40_000)

  it('refuses a taken or invalid name at once, leaving only the row that holds it', async () => {
    const projectId = await addProject(makeTempRepo(daemon.home))

    const first = await client.request('workspace.prepare', {
      projectId,
      name: 'app-1500-taken'
    })

    await expect(
      client.request('workspace.prepare', { projectId, name: 'app-1500-taken' })
    ).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('workspace app-1500-taken already exists')
    })
    await expect(
      client.request('workspace.prepare', { projectId, name: '!!!' })
    ).rejects.toMatchObject({
      code: 'bad_request',
      message: expect.stringContaining('invalid workspace name')
    })
    expect((await client.request('workspace.list')).map((w) => w.id)).toEqual([first.id])
  }, 20_000)

  it('stops at a failed step and says why, opens nothing, and the workspace can be removed', async () => {
    const repo = makeTempRepo(daemon.home)
    const projectId = await addProject(repo)
    const removed = recordEvents(client, 'workspace.removed')

    const ws = await client.request('workspace.prepare', {
      projectId,
      name: 'app-1501-bad-base',
      baseRef: 'no-such-ref',
      start: true
    })

    await waitForStatus(daemon, ws.id, 'stuck')
    const row = await client.request('workspace.get', { id: ws.id })
    expect(row.statusReason).toBe('preparation_failed')
    expect(row.preparation?.done).toMatchObject([
      { step: 'fetch' },
      { step: 'worktree', error: 'unknown base ref no-such-ref' }
    ])
    expect(await stepOf(ws.id)).toBeNull()
    expect(await client.request('term.list', { workspaceId: ws.id })).toEqual([])
    expect(readFakeLog(daemon.claudeLog)).toEqual([])

    await client.request('workspace.remove', { id: ws.id, deleteBranch: true })

    await expect.poll(() => client.request('workspace.list'), { timeout: 10_000 }).toEqual([])
    expect(removed).toEqual([{ id: ws.id }])
    expect(gitIn(repo, 'branch', '--list', 'app-1501-bad-base')).toBe('')
  }, 30_000)

  it('goes on from what it knows when the fetch fails', async () => {
    const repo = makeTempRepo(daemon.home)
    const origin = addBareOrigin(repo)
    const projectId = await addProject(repo)
    fs.rmSync(origin, { recursive: true, force: true })

    const ws = await client.request('workspace.prepare', { projectId, name: 'app-1502-offline' })

    await waitForStatus(daemon, ws.id, 'idle')
    const row = await client.request('workspace.get', { id: ws.id })
    expect(row.baseRef).toBe('origin/main')
    expect(row.preparation).toBeUndefined()
    expect(fs.existsSync(join(ws.path, '.git'))).toBe(true)
  }, 20_000)

  it('records a setup that fails, keeps the reason, and starts claude as a started workspace does', async () => {
    const repo = makeTempRepo(daemon.home, { queToml: 'setup = "echo boom-9d3e >&2; exit 3"\n' })
    const projectId = await addProject(repo)
    const statuses = recordStatuses(client)

    const ws = await client.request('workspace.prepare', {
      projectId,
      name: 'app-1503-flaky-setup',
      start: true
    })

    await claudeRuns()

    expect(statuses).toContainEqual({ id: ws.id, status: 'stuck', reason: 'setup_failed' })
    const row = await client.request('workspace.get', { id: ws.id })
    expect(row.preparation?.done).toMatchObject([
      { step: 'fetch' },
      { step: 'worktree' },
      { step: 'setup', error: 'exited with code 3' },
      { step: 'claude' }
    ])
    expect(await stepOf(ws.id)).toBeNull()
    expect(
      fs.readFileSync(join(daemon.home, 'logs', 'workspaces', `${ws.id}-setup.log`), 'utf8')
    ).toContain('boom-9d3e')
    // Unlike a step that stops it, its terminals can open: the worktree is there.
    await client.request('workspace.openTerminal', { id: ws.id, cols: 80, rows: 24 })
  }, 30_000)

  it('skips setup with no setup command, and opens no terminal unless asked to start', async () => {
    const repo = makeTempRepo(daemon.home, { queToml: '' })
    const projectId = await addProject(repo)

    const ws = await client.request('workspace.prepare', { projectId, name: 'app-1504-plain' })

    expect(ws.preparation?.plan).toEqual(['fetch', 'worktree'])
    await waitForStatus(daemon, ws.id, 'idle')
    expect((await client.request('workspace.get', { id: ws.id })).preparation).toBeUndefined()
    expect(await client.request('term.list', { workspaceId: ws.id })).toEqual([])
    expect(readFakeLog(daemon.claudeLog)).toEqual([])
    await client.request('workspace.openTerminal', { id: ws.id, cols: 80, rows: 24 })
  }, 20_000)

  it('sends a configured start prompt to a workspace with a brief, never to a bare start', async () => {
    await client.request('config.set', { patch: { startPrompt: 'Read .que/brief.md first.' } })
    const projectId = await addProject(makeTempRepo(daemon.home))

    const bare = await client.request('workspace.prepare', {
      projectId,
      name: 'app-1505-bare',
      start: true
    })

    const [first] = await claudeRuns()
    expect(first.argv).toEqual(['--settings', join(daemon.home, 'hooks.json')])

    const briefed = await client.request('workspace.prepare', {
      projectId,
      brief: 'Fix the flaky upload test\n\nIt fails on the second retry.',
      start: true
    })

    const runs = await claudeRuns(2)

    expect(runs[1].argv.at(-1)).toBe('Read .que/brief.md first.')
    expect(briefed.title).toBe('Fix the flaky upload test')
    expect(bare.title).toBeUndefined()
    expect(fs.readFileSync(join(briefed.path, '.que', 'brief.md'), 'utf8')).toContain(
      'second retry'
    )
  }, 40_000)

  it('lists every method marked needsWorktree', () => {
    const marked = Object.entries(METHODS).flatMap(([m, policy]) =>
      policy.needsWorktree ? [m] : []
    )

    expect(Object.keys(NEEDS_WORKTREE).sort()).toEqual(marked.sort())
  })

  it('refuses what needs the worktree until its steps have run, in one answer, then lets it through', async () => {
    const repo = makeTempRepo(daemon.home)
    addBareOrigin(repo)
    const fetch = holdFetch(repo)
    const projectId = await addProject(repo)

    const ws = await client.request('workspace.prepare', { projectId, name: 'app-1506-not-yet' })

    expect(await answers(ws.id)).toEqual(REFUSED)
    await expect(client.request('workspace.diff', { id: ws.id })).rejects.toMatchObject({
      message: expect.stringContaining('app-1506-not-yet is not ready')
    })
    await expect(client.request('workspace.diff', { id: 'ws_missing00000' })).rejects.toMatchObject(
      { code: 'not_found' }
    )

    fs.rmSync(fetch.hold)
    await waitForStatus(daemon, ws.id, 'idle')

    expect(Object.values(await answers(ws.id))).not.toContain('conflict')
  }, 30_000)

  it('keeps refusing them after a step has stopped it', async () => {
    const projectId = await addProject(makeTempRepo(daemon.home))

    const ws = await client.request('workspace.prepare', {
      projectId,
      name: 'app-1507-stopped',
      baseRef: 'no-such-ref'
    })

    await waitForStatus(daemon, ws.id, 'stuck')

    expect(await answers(ws.id)).toEqual(REFUSED)
  }, 30_000)

  it('lets the title change while it prepares, but not the branch', async () => {
    const repo = makeTempRepo(daemon.home)
    addBareOrigin(repo)
    const fetch = holdFetch(repo)
    const projectId = await addProject(repo)
    const ws = await client.request('workspace.prepare', { projectId, name: 'app-1508-titled' })

    await expect(
      client.request('workspace.rename', { id: ws.id, title: 'Later', branch: 'other-name' })
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(
      await client.request('workspace.rename', { id: ws.id, title: 'Retry uploads' })
    ).toMatchObject({ title: 'Retry uploads', branch: 'app-1508-titled' })

    fs.rmSync(fetch.hold)
    await waitForStatus(daemon, ws.id, 'idle')
  }, 30_000)

  it('skips setup when que.toml has lost its command since the plan was made', async () => {
    const repo = makeTempRepo(daemon.home, { queToml: 'setup = "touch .setup-ran"\n' })
    addBareOrigin(repo)
    const fetch = holdFetch(repo)
    const projectId = await addProject(repo)
    const ws = await client.request('workspace.prepare', { projectId, name: 'app-1509-edited' })

    expect(ws.preparation?.plan).toContain('setup')
    fs.writeFileSync(join(repo, 'que.toml'), '')
    fs.rmSync(fetch.hold)

    await waitForStatus(daemon, ws.id, 'idle')
    expect(fs.existsSync(join(ws.path, '.setup-ran'))).toBe(false)
  }, 30_000)

  describe('after a restart', () => {
    it('resumes at the step it was on, running a stopped setup again and starting claude', async () => {
      const setup = heldSetup()
      const repo = makeTempRepo(daemon.home, { queToml: setup.queToml })
      const projectId = await addProject(repo)

      const ws = await client.request('workspace.prepare', {
        projectId,
        name: 'app-1510-restart',
        start: true
      })

      await expect.poll(() => stepOf(ws.id), { timeout: 10_000 }).toBe('setup')

      await restart()

      expect(await stepOf(ws.id)).toBe('setup')
      fs.writeFileSync(setup.gate, '')
      const [started] = await claudeRuns()

      expect(started.argv).toEqual(['--settings', join(daemon.home, 'hooks.json')])
      const row = await client.request('workspace.get', { id: ws.id })
      expect(row.preparation).toBeUndefined()
      expect(fs.readFileSync(join(ws.path, '.setup-runs'), 'utf8')).toBe('ran\n')
    }, 40_000)

    it('finishes a preparation stopped in its fetch', async () => {
      const repo = makeTempRepo(daemon.home)
      addBareOrigin(repo)
      const fetch = holdFetch(repo)
      const projectId = await addProject(repo)

      const ws = await client.request('workspace.prepare', { projectId, name: 'app-1511-fetch' })

      await fetch.reached()
      await restart()
      fs.rmSync(fetch.hold)

      await waitForStatus(daemon, ws.id, 'idle')
      expect(fs.existsSync(join(ws.path, '.git'))).toBe(true)
    }, 30_000)

    it('goes on from the branch or the worktree an earlier try made', async () => {
      const repo = makeTempRepo(daemon.home)
      addBareOrigin(repo)
      const fetch = holdFetch(repo)
      const projectId = await addProject(repo)

      const branched = await client.request('workspace.prepare', {
        projectId,
        name: 'app-1512-branched'
      })

      const added = await client.request('workspace.prepare', {
        projectId,
        name: 'app-1512-added'
      })

      await daemon.close({ keepHome: true })
      gitIn(repo, 'branch', branched.branch, 'main')
      gitIn(repo, 'worktree', 'add', '-b', added.branch, added.path, 'main')
      fs.rmSync(fetch.hold)
      daemon = await startTestDaemon({ home: daemon.home })
      client = daemon.client

      await waitForStatus(daemon, branched.id, 'idle')
      await waitForStatus(daemon, added.id, 'idle')
      expect(gitIn(branched.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branched.branch)
      expect(gitIn(added.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(added.branch)
    }, 30_000)

    it('leaves a failed one as it was, for the user to remove', async () => {
      const projectId = await addProject(makeTempRepo(daemon.home))

      const ws = await client.request('workspace.prepare', {
        projectId,
        name: 'app-1513-failed',
        baseRef: 'no-such-ref'
      })

      await waitForStatus(daemon, ws.id, 'stuck')

      await restart()

      expect(await client.request('workspace.get', { id: ws.id })).toMatchObject({
        status: 'stuck',
        statusReason: 'preparation_failed',
        preparation: { done: [{ step: 'fetch' }, { step: 'worktree' }] }
      })
    }, 30_000)
  })

  describe('removed while it runs', () => {
    it('stops in the fetch and leaves nothing behind, not even a failed branch step', async () => {
      const repo = makeTempRepo(daemon.home, { queToml: 'teardown = "touch .teardown-ran"\n' })
      addBareOrigin(repo)
      const fetch = holdFetch(repo)
      const projectId = await addProject(repo)
      const removed = recordEvents(client, 'workspace.removed')

      const ws = await client.request('workspace.prepare', {
        projectId,
        name: 'app-1520-gone',
        start: true
      })

      await fetch.reached()
      await client.request('workspace.remove', { id: ws.id, deleteBranch: true })

      await expect.poll(() => client.request('workspace.list'), { timeout: 10_000 }).toEqual([])
      expect(removed).toEqual([{ id: ws.id }])
      expect(fs.existsSync(ws.path)).toBe(false)
      expect(gitIn(repo, 'branch', '--list', 'app-1520-gone')).toBe('')
      expect(readFakeLog(daemon.claudeLog)).toEqual([])
      fs.rmSync(fetch.hold)
    }, 30_000)

    it('kills a setup still running and never starts claude', async () => {
      const setup = heldSetup()
      const repo = makeTempRepo(daemon.home, { queToml: setup.queToml })
      const projectId = await addProject(repo)
      const removed = recordEvents(client, 'workspace.removed')

      const ws = await client.request('workspace.prepare', {
        projectId,
        name: 'app-1521-gone',
        start: true
      })

      await expect.poll(() => stepOf(ws.id), { timeout: 10_000 }).toBe('setup')

      await client.request('workspace.remove', { id: ws.id, deleteBranch: true })

      await expect.poll(() => client.request('workspace.list'), { timeout: 10_000 }).toEqual([])
      expect(removed).toEqual([{ id: ws.id }])
      expect(gitIn(repo, 'branch', '--list', 'app-1521-gone')).toBe('')
      expect(gitIn(repo, 'worktree', 'list')).not.toContain(ws.path)
      expect(readFakeLog(daemon.claudeLog)).toEqual([])
    }, 30_000)
  })
})

describe('workspace.create beside it', () => {
  it('still answers once the worktree exists, with setup running on and no steps', async () => {
    const setup = heldSetup()
    const projectId = await addProject(makeTempRepo(daemon.home, { queToml: setup.queToml }))
    const created = recordEvents(client, 'workspace.created')

    const ws = await client.request('workspace.create', { projectId, name: 'app-1530-blocking' })

    expect(ws).toMatchObject({ status: 'preparing', baseRef: 'main' })
    expect(ws.preparation).toBeUndefined()
    expect(created).toEqual([ws])
    expect(fs.existsSync(join(ws.path, '.git'))).toBe(true)
    expect(await client.request('term.list', { workspaceId: ws.id })).toEqual([])
    // A terminal can open while its setup runs, as it always could.
    await client.request('workspace.openTerminal', { id: ws.id, cols: 80, rows: 24 })

    fs.writeFileSync(setup.gate, '')
    await waitForStatus(daemon, ws.id, 'idle')
  }, 20_000)

  it('still refuses an unknown base ref, leaving no row and no branch', async () => {
    const repo = makeTempRepo(daemon.home)
    const projectId = await addProject(repo)
    const created = recordEvents(client, 'workspace.created')

    await expect(
      client.request('workspace.create', {
        projectId,
        name: 'app-1531-bad-base',
        baseRef: 'no-such-ref'
      })
    ).rejects.toMatchObject({ code: 'bad_request', message: 'unknown base ref no-such-ref' })

    expect(created).toEqual([])
    expect(await client.request('workspace.list')).toEqual([])
    expect(gitIn(repo, 'branch', '--list', 'app-1531-bad-base')).toBe('')
  }, 20_000)

  it('runs a setup the daemon was stopped in again after a restart, so the row is not stuck preparing', async () => {
    const setup = heldSetup()
    const projectId = await addProject(makeTempRepo(daemon.home, { queToml: setup.queToml }))

    const ws = await client.request('workspace.create', { projectId, name: 'app-1532-restart' })

    await restart()
    expect((await client.request('workspace.get', { id: ws.id })).status).toBe('preparing')

    fs.writeFileSync(setup.gate, '')

    await waitForStatus(daemon, ws.id, 'idle')
    expect(fs.readFileSync(join(ws.path, '.setup-runs'), 'utf8')).toBe('ran\n')
  }, 30_000)
})
