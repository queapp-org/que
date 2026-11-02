// `que daemon upgrade` (and so handOffDaemon, which the app's Restart control also
// goes through) against a real daemon process: its terminals move to a
// new daemon process with the same ids and the same shells, and a successor
// that cannot start leaves the running daemon serving them. A Claude session
// live in a workspace terminal stays the same live session across the move (it
// is not resumed a second time), and the next hard restart still resumes it.
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeLiveSessions } from '@daemon/live-sessions.decode'
import type { LiveSession } from '@daemon/live-sessions'
import { DaemonClient } from '@shared/client'
import { quePaths } from '@shared/paths'
import { pidAlive } from '@shared/process'
import type { Events, TermInfo } from '@shared/protocol'
import { bundleEntry } from '../../src/testing/bundle'
import { runCli } from '../../src/testing/cli'
import { readFakeLog } from '../../src/testing/fakes'
import { makeTempRepo } from '../../src/testing/temp-repo'
import { assertPidsGone } from '../../src/testing/leak-check'
import { fakeEnv, QUIET_OFF, writeGitconfig } from '../fakes/env.cjs'

const UPGRADE_LINE = /^daemon upgraded: pid (\d+) → (\d+), (\d+) terminals? carried over$/m

let home: string
let scratch: string

/** Every daemon and shell pid a test saw, all of which must be gone at the end. */
let pids: Set<number>
let clients: DaemonClient[]

async function connect(): Promise<DaemonClient> {
  const c = new DaemonClient(quePaths().socket)
  await c.connect()
  clients.push(c)

  return c
}

async function shell(c: DaemonClient): Promise<TermInfo> {
  const t = await c.request('term.create', { file: '/bin/sh', cwd: home, cols: 80, rows: 24 })
  pids.add(t.pid)

  return t
}

async function screen(c: DaemonClient, id: string): Promise<string> {
  return (await c.request('term.snapshot', { id })).text
}

/** The live-sessions record as the daemon persisted it (the kv row); [] when it is cleared. */
function liveRecord(): LiveSession[] {
  const db = new DatabaseSync(quePaths().db, { readOnly: true })

  try {
    const row = db.prepare("SELECT value FROM kv WHERE key = 'live_sessions'").get() as
      | { value: string }
      | undefined

    return decodeLiveSessions(row?.value)
  } finally {
    db.close()
  }
}

/** Every run of the fake claude. */
function claudeRuns(): Array<{ pid: number; resume: string | null }> {
  return readFakeLog(process.env.QUE_FAKE_CLAUDE_LOG as string).map((call) => {
    const i = call.argv.indexOf('--resume')

    return { pid: call.pid as number, resume: i >= 0 ? call.argv[i + 1] : null }
  })
}

async function terminalsOf(c: DaemonClient, wsId: string): Promise<TermInfo[]> {
  return c.request('term.list', { workspaceId: wsId })
}

function upgrade(script = bundleEntry('src/daemon/index.ts')): ReturnType<typeof runCli> {
  return runCli('daemon', 'upgrade', '--script', script, '--runtime', process.execPath)
}

beforeEach(async () => {
  // Short enough for the socket to stay inside the home.
  home = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'que-ho-')))
  scratch = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'que-ho-bin-')))
  pids = new Set()
  clients = []
  const env = fakeEnv(home)

  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
  writeGitconfig(home, 'handoff')
  fs.writeFileSync(env.QUE_CONFIG, QUIET_OFF)

  const c = await DaemonClient.connectOrStart({
    paths: quePaths(),
    runtime: process.execPath,
    daemonScript: bundleEntry('src/daemon/index.ts'),
    timeoutMs: 10_000
  })

  clients.push(c)
  pids.add((await c.request('daemon.ping')).pid)
}, 20_000)

afterEach(async () => {
  for (const c of clients) c.close()
  await runCli('daemon', 'stop')

  try {
    await assertPidsGone(pids, 5_000)
  } finally {
    vi.unstubAllEnvs()
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}, 20_000)

describe('daemon handoff', () => {
  describe('upgrade', () => {
    it('moves a running shell to a new daemon with its id, pid and screen', async () => {
      const before = clients[0]
      const oldPid = (await before.request('daemon.ping')).pid
      const term = await shell(before)
      await before.request('term.write', { id: term.id, data: 'echo BEFORE-$((6*7))\r' })
      await expect.poll(() => screen(before, term.id), { timeout: 5_000 }).toContain('BEFORE-42')

      const r = await upgrade()

      expect(r.code, r.stderr).toBe(0)
      const [, from, to, carried] = UPGRADE_LINE.exec(r.stdout) ?? []

      expect([Number(from), carried]).toEqual([oldPid, '1'])
      const newPid = Number(to)
      pids.add(newPid)

      expect(newPid).not.toBe(oldPid)
      await expect.poll(() => pidAlive(oldPid), { timeout: 5_000 }).toBe(false)

      const after = await connect()

      expect((await after.request('daemon.ping')).pid).toBe(newPid)
      expect(await after.request('term.list')).toEqual([
        expect.objectContaining({ id: term.id, pid: term.pid, alive: true })
      ])

      // Attach replays the screen rebuilt from the old daemon's mirror.
      const attached = await after.request('term.attach', { id: term.id, cols: 100, rows: 40 })

      expect(attached.snapshot).toContain('BEFORE-42')

      const data: string[] = []
      after.on('term.data', (d) => data.push(d.data))
      await after.request('term.write', { id: term.id, data: 'echo AFTER-$((5*5)); stty size\r' })
      await expect.poll(() => data.join(''), { timeout: 5_000 }).toContain('AFTER-25')
      // The attach's size reached the shell through the adopted fd.
      await expect.poll(() => data.join(''), { timeout: 5_000 }).toContain('40 100')
      expect(await screen(after, term.id)).toContain('BEFORE-42')

      const exits: Events['term.exit'][] = []
      after.on('term.exit', (e) => exits.push(e))
      await after.request('term.write', { id: term.id, data: 'exit\r' })

      await expect.poll(() => exits.map((e) => e.id), { timeout: 5_000 }).toEqual([term.id])
      await expect.poll(() => pidAlive(term.pid), { timeout: 5_000 }).toBe(false)
      expect(await after.request('term.list')).toEqual([
        expect.objectContaining({ id: term.id, alive: false })
      ])
    })

    it("carries a terminal's title and program over, and the new daemon follows its foreground", async () => {
      const before = clients[0]
      const term = await shell(before)
      await before.request('term.write', {
        id: term.id,
        data: "printf '\\033]0;QUE_CARRIED_2f7a\\007'\r"
      })
      await expect
        .poll(async () => (await before.request('term.list'))[0], { timeout: 5_000 })
        .toMatchObject({ title: 'QUE_CARRIED_2f7a', process: expect.any(String) })
      const { process: shellName } = (await before.request('term.list'))[0]

      const r = await upgrade()

      expect(r.code, r.stderr).toBe(0)
      pids.add(Number(UPGRADE_LINE.exec(r.stdout)?.[2]))
      const after = await connect()
      expect((await after.request('term.list'))[0]).toMatchObject({
        id: term.id,
        title: 'QUE_CARRIED_2f7a',
        process: shellName
      })

      await after.request('term.write', { id: term.id, data: 'cat\r' })

      await expect
        .poll(async () => (await after.request('term.list'))[0]?.process, { timeout: 5_000 })
        .toBe('cat')
    })

    it('carries terminals over twice, and stop afterwards ends every one of them', async () => {
      const first = await shell(clients[0])

      expect((await upgrade()).code).toBe(0)
      const middle = await connect()
      const second = await shell(middle)
      const r = await upgrade()

      expect(r.code, r.stderr).toBe(0)
      const [, , to, carried] = UPGRADE_LINE.exec(r.stdout) ?? []
      pids.add(Number(to))

      expect(carried).toBe('2')
      const last = await connect()
      const ids = (await last.request('term.list')).map((t) => [t.id, t.pid, t.alive])

      expect(ids.sort()).toEqual(
        [
          [first.id, first.pid, true],
          [second.id, second.pid, true]
        ].sort()
      )
      await last.request('term.write', { id: first.id, data: 'echo FIRST-$((2*9))\r' })
      await expect.poll(() => screen(last, first.id), { timeout: 5_000 }).toContain('FIRST-18')
      // afterEach stops the daemon and fails if a shell or daemon is left.
    })
  })

  describe('with a live Claude session', () => {
    it('keeps the session live across the upgrade, and a later restart resumes it', async () => {
      // The hooks wrapper the daemon installs runs this CLI bundle.
      bundleEntry('src/cli/index.ts')
      const before = clients[0]
      const project = await before.request('project.add', { path: makeTempRepo(home) })

      const ws = await before.request('workspace.create', {
        projectId: project.id,
        name: 'app-1432-retry-logic'
      })

      await expect
        .poll(async () => (await before.request('workspace.get', { id: ws.id })).status, {
          timeout: 10_000
        })
        .toBe('idle')

      const term = await before.request('workspace.openTerminal', {
        id: ws.id,
        cols: 100,
        rows: 30
      })

      pids.add(term.pid)
      await before.request('term.write', { id: term.id, data: 'claude\r' })
      await expect
        .poll(async () => (await before.request('workspace.get', { id: ws.id })).sessionId, {
          timeout: 20_000
        })
        .toMatch(/^[0-9a-f-]{36}$/)
      const session = (await before.request('workspace.get', { id: ws.id })).sessionId as string
      const entry = { workspaceId: ws.id, terminalId: term.id, sessionId: session }
      await expect.poll(liveRecord, { timeout: 10_000 }).toEqual([entry])
      const [claude] = claudeRuns()
      pids.add(claude.pid)

      expect(claudeRuns()).toEqual([{ pid: claude.pid, resume: null }])

      const r = await upgrade()

      expect(r.code, r.stderr).toBe(0)
      const [, , to, carried] = UPGRADE_LINE.exec(r.stdout) ?? []
      const newPid = Number(to)
      pids.add(newPid)

      expect(carried).toBe('1')
      const after = await connect()

      expect((await after.request('daemon.ping')).pid).toBe(newPid)
      // The new daemon took the session as live in its adopted terminal: no
      // second terminal resumes it, and the same claude process still answers.
      expect(await terminalsOf(after, ws.id)).toEqual([
        expect.objectContaining({ id: term.id, pid: term.pid, alive: true })
      ])
      expect(pidAlive(claude.pid)).toBe(true)
      expect(liveRecord()).toEqual([entry])
      await after.request('term.write', { id: term.id, data: 'still there\r' })
      await expect
        .poll(() => screen(after, term.id), { timeout: 10_000 })
        .toContain('Fake reply to: still there')
      expect(claudeRuns()).toEqual([{ pid: claude.pid, resume: null }])
      expect(await terminalsOf(after, ws.id)).toHaveLength(1)

      // A hard restart: the stop ends the terminal, and the next daemon on the
      // same home resumes the session the handoff kept in the record.
      const stop = await runCli('daemon', 'stop')

      expect(stop.code, stop.stderr).toBe(0)
      await expect.poll(() => pidAlive(newPid), { timeout: 5_000 }).toBe(false)
      expect(liveRecord()).toEqual([entry])

      const restarted = await DaemonClient.connectOrStart({
        paths: quePaths(),
        runtime: process.execPath,
        daemonScript: bundleEntry('src/daemon/index.ts'),
        timeoutMs: 10_000
      })

      clients.push(restarted)
      pids.add((await restarted.request('daemon.ping')).pid)

      await expect.poll(() => terminalsOf(restarted, ws.id), { timeout: 10_000 }).toHaveLength(1)
      const [restored] = await terminalsOf(restarted, ws.id)
      pids.add(restored.pid)

      expect(restored.id).not.toBe(term.id)
      await expect
        .poll(() => claudeRuns().map((run) => run.resume), { timeout: 20_000 })
        .toEqual([null, session])

      for (const run of claudeRuns()) pids.add(run.pid)
      // afterEach stops the daemon and fails if a shell, claude or daemon is left.
    }, 90_000)
  })

  describe('errors', () => {
    it('keeps the old daemon serving its terminals when the new one fails to start', async () => {
      const c = clients[0]
      const oldPid = (await c.request('daemon.ping')).pid
      const term = await shell(c)
      const broken = join(scratch, 'broken-daemon.js')
      fs.writeFileSync(broken, 'process.exit(3)\n')

      const r = await upgrade(broken)

      expect(r.code).toBe(1)
      expect(r.stderr).toContain('the handoff failed: the new daemon exited (code 3)')
      expect(r.stderr).toContain('que daemon restart')
      expect((await c.request('daemon.ping')).pid).toBe(oldPid)
      expect(await c.request('term.list')).toEqual([
        expect.objectContaining({ id: term.id, pid: term.pid, alive: true })
      ])
      // Reading resumed: what is typed now still comes back.
      await c.request('term.write', { id: term.id, data: 'echo STILL-$((8*8))\r' })
      await expect.poll(() => screen(c, term.id), { timeout: 5_000 }).toContain('STILL-64')
    })

    it('refuses a daemon bundle that does not exist', async () => {
      const r = await upgrade(join(scratch, 'missing', 'index.js'))

      expect(r.code).toBe(1)
      expect(r.stderr).toContain(`no daemon bundle at ${join(scratch, 'missing', 'index.js')}`)
    })
  })
})
