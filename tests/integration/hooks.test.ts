// The status engine's wiring: the hooks wrapper in a real workspace terminal,
// `que hook` as a real subprocess, the stall tick, the `claude agents --json`
// poll, and terminal exits — each delivering to the engine and out as
// workspace.status. The rules themselves are in status-engine.test.ts.
import fs from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Workspace } from '@shared/types'
import { runCli, runCliWith } from '../../src/testing/cli'
import { FAKE_WRAPPERS, FAKES_BIN, readFakeLog, readWrapperLog } from '../../src/testing/fakes'
import {
  recordStatuses,
  type StatusChange,
  recordEvents,
  runClaude,
  startTestDaemon,
  type TestDaemon,
  type TestDaemonOptions,
  waitForStatus
} from '../../src/testing/daemon-harness'
import { makeHookEvent } from '../../src/testing/fixtures'
import { makeTempRepo } from '../../src/testing/temp-repo'

let daemon: TestDaemon | undefined

afterEach(async () => {
  await daemon?.close()
  daemon = undefined
})

/** A daemon plus one idle workspace in a fresh repo. */
async function idleWorkspace(
  opts: TestDaemonOptions = {}
): Promise<{ d: TestDaemon; ws: Workspace; statuses: StatusChange[] }> {
  const d = await startTestDaemon(opts)
  daemon = d
  const statuses = recordStatuses(d.client)
  const project = await d.client.request('project.add', { path: makeTempRepo(d.home) })

  const ws = await d.client.request('workspace.create', {
    projectId: project.id,
    name: 'app-1432-retry-logic'
  })

  await waitForStatus(d, ws.id, 'idle')

  return { d, ws, statuses }
}

const statusesOf = (all: StatusChange[], id: string) =>
  all.flatMap((s) => (s.id === id ? [s.status] : []))

describe('hook delivery', () => {
  it('reports claude in a workspace terminal through the wrapper: idle → working → needs input', async () => {
    const { d, ws, statuses } = await idleWorkspace()

    const { id } = await d.client.request('workspace.openTerminal', {
      id: ws.id,
      cols: 100,
      rows: 30
    })

    await d.client.request('term.write', { id, data: 'claude\r' })
    await expect
      .poll(async () => (await d.client.request('workspace.get', { id: ws.id })).sessionId, {
        timeout: 20_000
      })
      .toMatch(/^[0-9a-f-]{36}$/)
    await d.client.request('term.write', { id, data: '/needs-input\r' })

    await expect
      .poll(() => statusesOf(statuses, ws.id), { timeout: 15_000 })
      .toEqual(['preparing', 'idle', 'working', 'needs_input'])

    // The Notification hook fires before the prompt is printed, so the status
    // can change before the mirror has the line: wait for the screen too.
    const screen = async (): Promise<string> =>
      (await d.client.request('term.snapshot', { id })).text

    await expect
      .poll(screen, { timeout: 10_000 })
      .toContain('Claude needs your permission to use Bash')
    expect(await screen()).toContain('Claude Code v2.1.0 (fake)')
  }, 45_000)

  it('records when a turn ends, announced with workspace.updated, until the app has seen it', async () => {
    const { d, ws } = await idleWorkspace()
    const updated = recordEvents(d.client, 'workspace.updated')

    const { id } = await d.client.request('workspace.openTerminal', {
      id: ws.id,
      cols: 100,
      rows: 30
    })

    await d.client.request('term.write', { id, data: 'claude\r' })
    await expect
      .poll(async () => (await d.client.request('workspace.get', { id: ws.id })).sessionId, {
        timeout: 20_000
      })
      .toMatch(/^[0-9a-f-]{36}$/)
    expect((await d.client.request('workspace.get', { id: ws.id })).finishedAt).toBeNull()
    await d.client.request('term.write', { id, data: 'hello\r' })

    await expect
      .poll(async () => (await d.client.request('workspace.get', { id: ws.id })).finishedAt, {
        timeout: 15_000
      })
      .toMatch(/^\d{4}-\d\d-\d\dT/)
    const after = await d.client.request('workspace.get', { id: ws.id })
    expect(after).toMatchObject({ status: 'idle', seenAt: null })
    expect(updated.filter((w) => w.id === ws.id).at(-1)?.finishedAt).toBe(after.finishedAt)
  }, 45_000)

  it('reaches claude through another claude wrapper ahead of it on PATH', async () => {
    // A machine where some other tool's wrapper sits in front of claude: the
    // daemon pins QUE_REAL_CLAUDE to that wrapper, and the wrapper looks past
    // its own directory and hands the command back to que's. The session must
    // start once, with hooks, rather than the two wrappers looping.
    const { d, ws } = await idleWorkspace({ pathPrefix: [FAKE_WRAPPERS] })

    const { id } = await d.client.request('workspace.openTerminal', {
      id: ws.id,
      cols: 100,
      rows: 30
    })

    await d.client.request('term.write', {
      id,
      data: `PATH="$QUE_HOME/bin:${FAKE_WRAPPERS}:${FAKES_BIN}:$PATH" claude\r`
    })

    await expect
      .poll(async () => (await d.client.request('workspace.get', { id: ws.id })).sessionId, {
        timeout: 20_000
      })
      .toMatch(/^[0-9a-f-]{36}$/)
    await expect
      .poll(async () => (await d.client.request('term.snapshot', { id })).text, {
        timeout: 10_000
      })
      .toContain('Claude Code v2.1.0 (fake)')
    const claudeCalls = readFakeLog(d.claudeLog)
    expect(claudeCalls).toHaveLength(1)
    expect(claudeCalls[0].argv.filter((a) => a === '--settings')).toEqual(['--settings'])
    expect(readWrapperLog(d.wrapperLog)).toHaveLength(1)
  }, 45_000)

  it('starts claude with the instructions file and the permission mode set after the daemon started', async () => {
    // The user default is plan; the repo's que.toml says acceptEdits, which wins.
    const d = await startTestDaemon({ config: 'default_permission_mode = "plan"\n' })
    daemon = d

    const project = await d.client.request('project.add', {
      path: makeTempRepo(d.home, { queToml: 'setup = "true"\npermission_mode = "acceptEdits"\n' })
    })

    const ws = await d.client.request('workspace.create', {
      projectId: project.id,
      name: 'app-1488-delegation-rules'
    })

    const instructions = join(d.home, 'instructions', 'delegation.md')
    fs.mkdirSync(join(d.home, 'instructions'))
    fs.writeFileSync(instructions, 'Delegate broad searches to a smaller model.\n')
    const set = await runCli('config', 'set', `instructions_file=${instructions}`)
    expect(set).toMatchObject({ code: 0, stdout: `updated ${d.configPath}\n` })

    const { id } = await d.client.request('workspace.openTerminal', {
      id: ws.id,
      cols: 100,
      rows: 30
    })

    await d.client.request('term.write', { id, data: 'claude\r' })

    await expect.poll(() => readFakeLog(d.claudeLog).length, { timeout: 20_000 }).toBe(1)
    expect(readFakeLog(d.claudeLog)[0].argv).toEqual([
      '--settings',
      join(d.home, 'hooks.json'),
      '--append-system-prompt-file',
      instructions,
      '--permission-mode',
      'acceptEdits'
    ])
  }, 45_000)

  it('accepts hook JSON from `que hook` on stdin, printing nothing', async () => {
    const { d, ws } = await idleWorkspace()

    const payload = makeHookEvent('UserPromptSubmit', {
      session_id: '7d0c5b2a-0000-4000-8000-3e4f5a6b7c8d',
      cwd: ws.path,
      prompt: 'Add retry logic to the uploader'
    })

    const r = await runCliWith(
      { input: JSON.stringify(payload), env: { QUE_WORKSPACE_ID: ws.id, QUE_SOCKET: d.socket } },
      'hook'
    )

    expect(r).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(await d.client.request('workspace.get', { id: ws.id })).toMatchObject({
      status: 'working',
      sessionId: '7d0c5b2a-0000-4000-8000-3e4f5a6b7c8d'
    })
  }, 30_000)

  it('answers not_found for a hook from an unknown workspace', async () => {
    daemon = await startTestDaemon()

    await expect(
      daemon.client.request('hook.event', {
        workspaceId: 'ws_missing00000',
        payload: makeHookEvent('Stop')
      })
    ).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('background tasks', () => {
  it('keeps the workspace working through a Stop while a subagent runs, and idles at the final Stop', async () => {
    const { d, ws, statuses } = await idleWorkspace()
    const updated = recordEvents(d.client, 'workspace.updated')
    const { term: id } = await runClaude(d, ws.id)
    const get = () => d.client.request('workspace.get', { id: ws.id })

    await d.client.request('term.write', { id, data: '/background subagent shell\r' })

    await expect
      .poll(async () => (await get()).backgroundTasks.map((t) => t.kind), { timeout: 15_000 })
      .toEqual(['subagent', 'shell'])
    const during = await get()
    expect(during).toMatchObject({ status: 'working', finishedAt: null })
    expect(during.backgroundTasks).toEqual([
      expect.objectContaining({ kind: 'subagent', description: 'Explore the repo' }),
      expect.objectContaining({ kind: 'shell', description: 'npm run dev' })
    ])

    for (const t of during.backgroundTasks) expect(t.since).toMatch(/^\d{4}-\d\d-\d\dT/)
    expect(statusesOf(statuses, ws.id)).toEqual(['preparing', 'idle', 'working'])

    await d.client.request('term.write', { id, data: '/background done\r' })

    await expect
      .poll(() => statusesOf(statuses, ws.id), { timeout: 15_000 })
      .toEqual(['preparing', 'idle', 'working', 'idle'])
    const after = await get()
    expect(after).toMatchObject({ status: 'idle', backgroundTasks: [] })
    expect(after.finishedAt).toMatch(/^\d{4}-\d\d-\d\dT/)

    const finished = new Set(
      updated.flatMap((w) => (w.id === ws.id && w.finishedAt ? [w.finishedAt] : []))
    )

    expect([...finished]).toEqual([after.finishedAt])
  }, 45_000)

  it('goes idle at a Stop that leaves only a shell running, and lists the shell', async () => {
    const { d, ws } = await idleWorkspace()
    const { term: id } = await runClaude(d, ws.id)

    await d.client.request('term.write', { id, data: '/background shell\r' })

    await expect
      .poll(async () => d.client.request('workspace.get', { id: ws.id }), { timeout: 15_000 })
      .toMatchObject({
        status: 'idle',
        backgroundTasks: [expect.objectContaining({ kind: 'shell', description: 'npm run dev' })]
      })
  }, 45_000)

  it("a subagent's hooks keep a waiting session from going stuck while they arrive", async () => {
    // Well above a slow step on a busy machine, which must not pass for a session gone quiet.
    const stallMs = 3_000

    const { d, ws } = await idleWorkspace({
      config: `stall_timeout_minutes = ${stallMs / 60_000}\n`
    })

    const { term: id } = await runClaude(d, ws.id)
    const get = () => d.client.request('workspace.get', { id: ws.id })
    const activityAt = async () => Date.parse((await get()).lastActivityAt as string)

    await d.client.request('term.write', { id, data: '/background subagent\r' })
    await expect
      .poll(async () => (await get()).backgroundTasks.map((t) => t.kind), { timeout: 15_000 })
      .toEqual(['subagent'])
    const agentId = (await get()).backgroundTasks[0].id
    const stoppedAt = await activityAt()

    // The Stop is the session's own last activity. Send until a hook lands a full stall timeout
    // after it: the tick that takes that hook in would find the session stalled without the hooks.
    await expect
      .poll(
        async () => {
          await d.client.request('hook.event', {
            workspaceId: ws.id,
            payload: makeHookEvent('PreToolUse', {
              cwd: ws.path,
              agent_id: agentId,
              tool_name: 'Read'
            })
          })

          return (await activityAt()) - stoppedAt
        },
        { timeout: 10_000 }
      )
      .toBeGreaterThan(stallMs)

    expect(await get()).toMatchObject({ status: 'working', statusReason: null })

    await waitForStatus(d, ws.id, 'stuck')
    expect((await get()).statusReason).toBe('no_heartbeat')
  }, 45_000)
})

describe('status engine wiring', () => {
  it('marks a silent working session stuck, and the next hook clears it', async () => {
    const { d, ws, statuses } = await idleWorkspace({ config: 'stall_timeout_minutes = 0.005\n' })

    await d.client.request('hook.event', {
      workspaceId: ws.id,
      payload: makeHookEvent('UserPromptSubmit', { cwd: ws.path })
    })

    await expect
      .poll(async () => d.client.request('workspace.get', { id: ws.id }), { timeout: 10_000 })
      .toMatchObject({ status: 'stuck', statusReason: 'no_heartbeat' })
    expect(statuses.filter((s) => s.id === ws.id).at(-1)).toMatchObject({
      status: 'stuck',
      reason: 'no_heartbeat'
    })

    await d.client.request('hook.event', {
      workspaceId: ws.id,
      payload: makeHookEvent('PostToolUse', { cwd: ws.path, tool_name: 'Bash' })
    })

    // From the recorded changes: with a timeout this short, a slow read could find it stuck again.
    expect(statusesOf(statuses, ws.id).slice(3, 5)).toEqual(['stuck', 'working'])
  }, 30_000)

  it('announces a hook-driven change as one workspace.updated carrying the whole row', async () => {
    const { d, ws } = await idleWorkspace()
    const updated = recordEvents(d.client, 'workspace.updated')

    await d.client.request('hook.event', {
      workspaceId: ws.id,
      payload: makeHookEvent('UserPromptSubmit', { cwd: ws.path })
    })

    await expect.poll(() => updated.length).toBe(1)
    const stored = await d.client.request('workspace.get', { id: ws.id })
    expect(updated[0]).toEqual(stored)
    expect(updated[0]).toMatchObject({ id: ws.id, status: 'working', statusReason: null })
    expect(updated[0].statusAt).not.toBe(ws.statusAt)
    expect(updated[0].lastActivityAt).not.toBeNull()
  }, 30_000)

  it('takes needs input from `claude agents --json` for a workspace with no hooks', async () => {
    const { d, ws } = await idleWorkspace({ config: 'status_poll_seconds = 0.2\n' })
    const agents = join(d.home, 'agents.json')
    fs.writeFileSync(agents, JSON.stringify([{ cwd: ws.path, status: 'waiting_for_input' }]))

    vi.stubEnv('QUE_FAKE_CLAUDE_AGENTS_JSON', agents)

    await expect
      .poll(async () => (await d.client.request('workspace.get', { id: ws.id })).status, {
        timeout: 10_000
      })
      .toBe('needs_input')
  }, 30_000)

  it('has exited once the last workspace terminal exits', async () => {
    const { d, ws } = await idleWorkspace()

    const { id } = await d.client.request('workspace.openTerminal', {
      id: ws.id,
      cols: 80,
      rows: 24
    })

    await d.client.request('term.write', { id, data: 'exit\r' })

    await expect
      .poll(async () => (await d.client.request('workspace.get', { id: ws.id })).status, {
        timeout: 15_000
      })
      .toBe('exited')
  }, 30_000)
})
