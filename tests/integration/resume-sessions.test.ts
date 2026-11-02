// Interactive Claude sessions across a daemon restart: the fake claude in a
// workspace terminal reports its session through the hooks wrapper, the daemon
// stops the way the real shutdown does (every terminal killed, then the server
// closed), and the next daemon on the same QUE_HOME opens a terminal in the
// workspace that resumes the session. A session in a loose terminal comes back
// in a loose terminal opened in the folder it started in. Ended sessions,
// killed terminals, a folder that is gone, and a locked quiet-hours start are
// the cases that wait or stay closed. The candidate rules themselves are in
// src/daemon/live-sessions.test.ts.
import fs from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { shQuote } from '@daemon/wrapper'
import type { Workspace } from '@shared/types'
import { readFakeLog } from '../../src/testing/fakes'
import {
  runClaude,
  startTestDaemon,
  type TestDaemon,
  waitForStatus
} from '../../src/testing/daemon-harness'
import { makeTempRepo } from '../../src/testing/temp-repo'

let daemon: TestDaemon | undefined

afterEach(async () => {
  await daemon?.close()
  daemon = undefined
})

/** A daemon with one project; workspaces are added with `workspace()`. */
async function start(): Promise<{ d: TestDaemon; projectId: string }> {
  const d = await startTestDaemon()
  daemon = d
  const project = await d.client.request('project.add', { path: makeTempRepo(d.home) })

  return { d, projectId: project.id }
}

async function workspace(d: TestDaemon, projectId: string, name: string): Promise<Workspace> {
  const ws = await d.client.request('workspace.create', { projectId, name })
  await waitForStatus(d, ws.id, 'idle')

  return ws
}

/** Waits until the terminal's screen shows `text`. */
async function waitForScreen(d: TestDaemon, id: string, text: string): Promise<void> {
  await expect
    .poll(async () => (await d.client.request('term.snapshot', { id })).text, { timeout: 15_000 })
    .toContain(text)
}

/** The sessions the fake claude was asked to resume, in order. */
function resumed(d: TestDaemon): string[] {
  return readFakeLog(d.claudeLog).flatMap((call) => {
    const i = call.argv.indexOf('--resume')

    return i >= 0 ? [call.argv[i + 1]] : []
  })
}

async function terminalsOf(d: TestDaemon, wsId: string): Promise<string[]> {
  return (await d.client.request('term.list', { workspaceId: wsId })).map((t) => t.id)
}

/** The loose terminals (in no workspace) and the folder each opened in. */
async function looseTerminals(d: TestDaemon): Promise<Array<{ id: string; cwd: string }>> {
  return (await d.client.request('term.list'))
    .filter((t) => t.workspaceId === undefined)
    .map((t) => ({ id: t.id, cwd: t.cwd }))
}

/** The folder each resumed claude ran in, by session. */
function resumedIn(d: TestDaemon): Array<{ session: string; cwd: string }> {
  return readFakeLog(d.claudeLog).flatMap((call) => {
    const i = call.argv.indexOf('--resume')

    return i >= 0 ? [{ session: call.argv[i + 1], cwd: call.cwd }] : []
  })
}

/**
 * Opens a loose terminal in the home, as the sidebar's Sessions does, then cds
 * into `folder` and starts claude there on `session`. Returns the terminal.
 */
async function runLooseClaude(d: TestDaemon, folder: string, session: string): Promise<string> {
  fs.mkdirSync(folder, { recursive: true })
  const { id } = await d.client.request('term.create', { cwd: d.home, cols: 100, rows: 30 })

  await d.client.request('term.write', {
    id,
    data: `cd ${shQuote(folder)} && claude --session-id ${session}\r`
  })
  await waitForScreen(d, id, 'Claude Code v2.1.0 (fake)')
  // A reply means the session's start hook has been delivered: it reads input only after.
  await d.client.request('term.write', { id, data: 'jot this down\r' })
  await waitForScreen(d, id, 'Fake reply to: jot this down')

  return id
}

const LOOSE_SESSION = '6b2e9f4c-1a7d-4c3e-8f5b-2d9a6e1c7b40'

/** Real time, shifted so that "now" starts at `at` (local wall clock). */
function clockFrom(at: Date): () => number {
  const offset = at.getTime() - Date.now()

  return () => Date.now() + offset
}

const QUIET = '[quiet_hours]\nenabled = true\ndefault = ["19:00", "07:00"]\n'

/** Wed 14 Oct 2026, 02:00: inside Tuesday's 19:00-07:00 window. */
const NIGHT = new Date(2026, 9, 14, 2, 0)

describe('resuming sessions after a daemon restart', () => {
  it('reopens the workspace terminal with claude resuming the same session', async () => {
    const first = await start()
    const ws = await workspace(first.d, first.projectId, 'app-1432-retry-logic')
    const { term, session } = await runClaude(first.d, ws.id)

    await first.d.close({ keepHome: true })
    daemon = await startTestDaemon({ home: first.d.home })
    const d = daemon

    await expect.poll(() => terminalsOf(d, ws.id), { timeout: 10_000 }).toHaveLength(1)
    const [restored] = await terminalsOf(d, ws.id)
    expect(restored).not.toBe(term)
    await expect.poll(() => resumed(d), { timeout: 20_000 }).toEqual([session])
    // A reply means the session's start hook has been delivered: it reads input only after.
    await d.client.request('term.write', { id: restored, data: 'where were we\r' })
    await waitForScreen(d, restored, 'Fake reply to: where were we')

    // The resumed session reports from its new terminal like any other, so the
    // next restart brings it back again.
    await d.close({ keepHome: true })
    daemon = await startTestDaemon({ home: first.d.home })
    const again = daemon

    await expect.poll(() => resumed(again), { timeout: 20_000 }).toEqual([session, session])
    expect(await terminalsOf(again, ws.id)).toHaveLength(1)
  }, 120_000)

  it('leaves closed a session Claude ended and a terminal the user killed', async () => {
    const first = await start()
    const live = await workspace(first.d, first.projectId, 'app-1432-retry-logic')
    const ended = await workspace(first.d, first.projectId, 'app-1433-upload-progress')
    const killed = await workspace(first.d, first.projectId, 'app-1434-flaky-login')
    const kept = await runClaude(first.d, live.id)
    const exited = await runClaude(first.d, ended.id)
    const closed = await runClaude(first.d, killed.id)

    // /exit fires SessionEnd (its hook delivered before claude exits), then the shell prompts again.
    await first.d.client.request('term.write', { id: exited.term, data: '/exit\r' })
    await first.d.client.request('term.write', {
      id: exited.term,
      data: 'echo que-exited-$((6*7))\r'
    })
    await waitForScreen(first.d, exited.term, 'que-exited-42')
    await first.d.client.request('term.kill', { id: closed.term })

    await first.d.close({ keepHome: true })
    daemon = await startTestDaemon({ home: first.d.home })
    const d = daemon

    await expect.poll(() => resumed(d), { timeout: 20_000 }).toEqual([kept.session])
    expect(await terminalsOf(d, live.id)).toHaveLength(1)
    expect(await terminalsOf(d, ended.id)).toEqual([])
    expect(await terminalsOf(d, killed.id)).toEqual([])
  }, 120_000)

  it('opens nothing while quiet hours are locked, then restores at the unlock', async () => {
    const first = await start()
    const ws = await workspace(first.d, first.projectId, 'app-1432-retry-logic')
    const { session } = await runClaude(first.d, ws.id)

    await first.d.close({ keepHome: true })
    daemon = await startTestDaemon({ home: first.d.home, config: QUIET, now: clockFrom(NIGHT) })
    const d = daemon

    expect((await d.client.request('quiet.state')).locked).toBe(true)
    // The restore runs as the daemon starts listening, so a locked start has already passed it.
    expect(await terminalsOf(d, ws.id)).toEqual([])
    expect(resumed(d)).toEqual([])

    await d.client.request('quiet.unlock', { why: 'pick the session back up' })

    await expect.poll(() => terminalsOf(d, ws.id), { timeout: 10_000 }).toHaveLength(1)
    await expect.poll(() => resumed(d), { timeout: 20_000 }).toEqual([session])
  }, 90_000)
})

describe('resuming loose terminal sessions after a daemon restart', () => {
  it('reopens a loose terminal in the folder the session started in, resuming it', async () => {
    const first = await startTestDaemon()
    daemon = first
    const notes = join(first.home, 'notes', 'meeting-prep')
    const spike = join(first.home, 'scratch', 'deleted-spike')
    await runLooseClaude(first, notes, LOOSE_SESSION)
    await runLooseClaude(first, spike, 'a9d3f7b1-5e2c-4a8f-b6d1-3c7e9a2f5b84')

    await first.close({ keepHome: true })
    // The second session's folder is gone by the next start: it has nowhere to resume.
    fs.rmSync(spike, { recursive: true, force: true })
    daemon = await startTestDaemon({ home: first.home })
    const d = daemon

    await expect.poll(() => looseTerminals(d), { timeout: 10_000 }).toHaveLength(1)
    const [restored] = await looseTerminals(d)
    expect(restored.cwd).toBe(notes)
    await expect
      .poll(() => resumedIn(d), { timeout: 20_000 })
      .toEqual([{ session: LOOSE_SESSION, cwd: notes }])
    await d.client.request('term.write', { id: restored.id, data: 'where were we\r' })
    await waitForScreen(d, restored.id, 'Fake reply to: where were we')

    // The restored terminal is a loose one like any other: its session reports
    // again, so the next restart brings it back once more.
    await d.close({ keepHome: true })
    daemon = await startTestDaemon({ home: first.home })
    const again = daemon

    await expect
      .poll(() => resumed(again), { timeout: 20_000 })
      .toEqual([LOOSE_SESSION, LOOSE_SESSION])
    expect(await looseTerminals(again)).toEqual([{ id: expect.any(String), cwd: notes }])
  }, 120_000)

  it('opens no loose terminal while quiet hours are locked, then restores at the unlock', async () => {
    const first = await startTestDaemon()
    daemon = first
    const notes = join(first.home, 'notes', 'meeting-prep')
    await runLooseClaude(first, notes, LOOSE_SESSION)

    await first.close({ keepHome: true })
    daemon = await startTestDaemon({ home: first.home, config: QUIET, now: clockFrom(NIGHT) })
    const d = daemon

    expect((await d.client.request('quiet.state')).locked).toBe(true)
    // The restore runs as the daemon starts listening, so a locked start has already passed it.
    expect(await looseTerminals(d)).toEqual([])
    expect(resumed(d)).toEqual([])

    await d.client.request('quiet.unlock', { why: 'finish the meeting notes' })

    await expect
      .poll(() => looseTerminals(d), { timeout: 10_000 })
      .toEqual([{ id: expect.any(String), cwd: notes }])
    await expect
      .poll(() => resumedIn(d), { timeout: 20_000 })
      .toEqual([{ session: LOOSE_SESSION, cwd: notes }])
  }, 90_000)
})
