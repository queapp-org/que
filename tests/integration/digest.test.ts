// The overnight digest over the real socket: hook events land in the status
// log, report.get turns the log and the worktree into one digest per
// workspace, and workspaces nobody touched stay out. The window math itself
// is in src/daemon/digest.test.ts. A hook's reply means its change is logged,
// so each report is asked for once; where the report measures time, the test
// first waits for the clock to pass the change it measures from (#95).
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Report } from '@shared/protocol'
import type { Workspace } from '@shared/types'
import { startTestDaemon, type TestDaemon, waitForStatus } from '../../src/testing/daemon-harness'
import { makeHookEvent } from '../../src/testing/fixtures'
import { gitIn, makeTempRepo } from '../../src/testing/temp-repo'
import { writeFileSync } from 'node:fs'

let daemon: TestDaemon | undefined

afterEach(async () => {
  await daemon?.close()
  daemon = undefined
})

/** The workspace once it is idle, with the time of that change. */
async function idleWorkspace(d: TestDaemon, projectId: string, name: string): Promise<Workspace> {
  const ws = await d.client.request('workspace.create', { projectId, name })
  await waitForStatus(d, ws.id, 'idle')

  return d.client.request('workspace.get', { id: ws.id })
}

/** Waits for the wall clock to pass `at`'s millisecond, which the daemon's clock then has too. */
async function clockPast(at: string): Promise<void> {
  await expect.poll(() => Date.now()).toBeGreaterThan(Date.parse(at))
}

/** The workspace's statuses since it was created, and the whole report, for a failure to print. */
function evidence(d: TestDaemon, ws: Workspace, report: Report): string {
  const log = d.server.store.listStatusLog(ws.id, ws.createdAt)

  return `status log ${JSON.stringify(log)}\nreport ${JSON.stringify(report)}`
}

const digestOf = (report: Report, ws: Workspace) => report.workspaces.find((w) => w.id === ws.id)

async function setup(): Promise<{
  d: TestDaemon
  projectId: string
  busy: Workspace
  untouched: Workspace
  since: string
}> {
  const d = await startTestDaemon()
  daemon = d
  const project = await d.client.request('project.add', { path: makeTempRepo(d.home) })
  const busy = await idleWorkspace(d, project.id, 'app-1432-retry-logic')
  const untouched = await idleWorkspace(d, project.id, 'app-1433-docs')
  // Creation is behind us; the window opens after its last change, so that change is not in it.
  await clockPast(untouched.statusAt)
  const since = new Date().toISOString()

  return { d, projectId: project.id, busy, untouched, since }
}

const hook = (
  d: TestDaemon,
  ws: Workspace,
  event: Parameters<typeof makeHookEvent>[0],
  extra = {}
) =>
  d.client.request('hook.event', {
    workspaceId: ws.id,
    payload: makeHookEvent(event, { cwd: ws.path, ...extra })
  })

const permission = { notification_type: 'permission_prompt', message: 'needs permission' }

describe('the overnight digest', () => {
  it('logs each status change in order', async () => {
    const { d, busy } = await setup()

    await hook(d, busy, 'UserPromptSubmit')
    await hook(d, busy, 'Notification', permission)
    await hook(d, busy, 'Stop')

    await expect
      .poll(() =>
        d.server.store.listStatusLog(busy.id, '1970-01-01T00:00:00.000Z').map((r) => r.status)
      )
      .toEqual(['preparing', 'idle', 'working', 'needs_input', 'idle'])
  })

  it('reports a waiting session, then its time worked once it stops, and omits the untouched one', async () => {
    const { d, busy, untouched, since } = await setup()

    await hook(d, busy, 'UserPromptSubmit')
    // The open stretch counts up to the report's clock: past the prompt's millisecond, the
    // session has worked a measurable time. A report in the same millisecond says 0, rightly.
    await clockPast((await d.client.request('workspace.get', { id: busy.id })).statusAt)
    const working = await d.client.request('report.get', { since })
    expect(digestOf(working, busy)?.workingMs, evidence(d, busy, working)).toBeGreaterThan(0)
    await hook(d, busy, 'Notification', permission)

    const waiting = await d.client.request('report.get', { since })
    expect(
      waiting.workspaces.map((w) => w.id),
      evidence(d, untouched, waiting)
    ).toEqual([busy.id])
    expect(digestOf(waiting, busy)).toMatchObject({
      name: busy.name,
      status: 'needs_input',
      needsInputCount: 1,
      waitingSince: expect.any(String),
      commitsAhead: 0
    })
    expect(waiting.totals).toMatchObject({ workspaces: 1, needsInput: 1 })

    await hook(d, busy, 'Stop')

    const stopped = await d.client.request('report.get', { since })
    const why = evidence(d, busy, stopped)
    expect(digestOf(stopped, busy), why).toMatchObject({
      status: 'idle',
      waitingSince: null,
      needsInputCount: 1
    })
    expect(digestOf(stopped, busy)?.workingMs, why).toBeGreaterThan(0)
    expect(stopped.totals).toMatchObject({ workspaces: 1, needsInput: 0 })
  })

  it('counts the commits made in the worktree against the base', async () => {
    const { d, busy, since } = await setup()
    await hook(d, busy, 'UserPromptSubmit')
    writeFileSync(join(busy.path, 'retry.ts'), 'export const retries = 3\n')
    gitIn(busy.path, 'add', '.')
    gitIn(busy.path, 'commit', '-m', 'Retry uploads')

    const report = await d.client.request('report.get', { since })

    expect(report.workspaces[0]).toMatchObject({ id: busy.id, commitsAhead: 1 })
  })
})
