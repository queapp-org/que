// The in-process daemon for integration tests (vitest-testing skill, 5a): a
// fresh temp QUE_HOME, the fakes first on PATH, the real DaemonServer on the
// home's socket, and a connected DaemonClient. close() tears it all down and
// runs the leak check. The hooks wrapper's bin/que runs the CLI bundled from
// source, and the user config lives at <home>/config.toml (QUE_CONFIG). Git
// gets a fixed identity from <home>/gitconfig (GIT_CONFIG_GLOBAL), so commits
// made by a test or the fake claude never depend on the machine's config.
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import { DaemonServer } from '@daemon/server'
import { DaemonClient } from '@shared/client'
import { ensureDirs, quePaths } from '@shared/paths'
import type { Events } from '@shared/protocol'
import type { WorkspaceStatus } from '@shared/types'
import { bundleEntry } from './bundle'
import { fakeEnv, QUIET_OFF, writeGitconfig } from '../../tests/fakes/env.cjs'
import { assertPidsGone, LeakCheckedPtyHost } from './leak-check'

export interface TestDaemon {
  /** The temp QUE_HOME; removed by close(). */
  home: string
  /** The daemon socket inside `home`. */
  socket: string
  host: LeakCheckedPtyHost
  server: DaemonServer
  client: DaemonClient
  /** Every line the daemon has logged so far, in order. */
  logged: string[]
  /** Where the fakes record their calls (read with readFakeLog / readWrapperLog). */
  claudeLog: string
  ghLog: string
  /** The fake gh's pull requests (QUE_FAKE_GH_PRS), keyed by branch; see setFakePullRequest. */
  ghPrs: string
  /** The fake acli's call log and issue file (QUE_FAKE_ACLI_LOG / QUE_FAKE_ACLI_TICKETS). */
  acliLog: string
  acliTickets: string
  openLog: string
  wrapperLog: string
  /** QUE_CONFIG for this daemon (always written; see withQuietOff). */
  configPath: string
  /**
   * Tears down client, terminals, server, env, and home; fails on
   * leaked pids. `keepHome` leaves QUE_HOME for a second daemon (restart tests).
   */
  close(opts?: { keepHome?: boolean }): Promise<void>
}

/** A test config with quiet hours off (QUIET_OFF) unless it sets its own [quiet_hours]. */
export function withQuietOff(config = ''): string {
  return config.includes('[quiet_hours]') ? config : `${config}\n${QUIET_OFF}`
}

export interface TestDaemonOptions {
  /** Called after daemon.shutdown's response is flushed. */
  onShutdown?: () => void
  /** config.toml contents, written before the daemon starts (quiet hours off unless set). */
  config?: string
  /** The clock quiet hours read (e.g. real time shifted ahead). */
  now?: () => number
  /** Quiet-hours re-evaluation interval. Default 200 ms (the daemon's is 15 s). */
  quietTickMs?: number
  /** Status engine stall-check interval. Default 200 ms (the daemon's is 5 s). */
  statusTickMs?: number
  /** Reuse this QUE_HOME (from a daemon closed with keepHome) instead of a fresh one. */
  home?: string
  /** Directories put ahead of the fakes on the daemon's PATH (e.g. FAKE_WRAPPERS). */
  pathPrefix?: string[]
  /** Draws the names of workspaces created without one (e.g. scripted, to force clashes). */
  randomWorkspaceName?: () => string
  /** How long tokenizing one file may take before it is answered plain. The daemon's default (5 s). */
  tokenizeTimeoutMs?: number
  /** Run the test-only fault tokenizer (src/testing/fault-tokenizer-worker.ts) instead of the real one. */
  faultyTokenizer?: boolean
}

export async function startTestDaemon(opts: TestDaemonOptions = {}): Promise<TestDaemon> {
  const home = opts.home ?? fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'que-it-')))
  const env = fakeEnv(home, opts.pathPrefix)
  writeGitconfig(home, 'test')

  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
  vi.stubEnv('QUE_NODE', process.execPath)
  const configPath = env.QUE_CONFIG
  fs.writeFileSync(configPath, withQuietOff(opts.config))

  const paths = ensureDirs(quePaths())
  const host = new LeakCheckedPtyHost()
  const logged: string[] = []

  const server = new DaemonServer({
    host,
    version: 'test',
    log: (msg) => logged.push(msg),
    onShutdown: opts.onShutdown,
    cliScript: bundleEntry('src/cli/index.ts'),
    statusTickMs: opts.statusTickMs ?? 200,
    quietTickMs: opts.quietTickMs ?? 200,
    now: opts.now,
    randomWorkspaceName: opts.randomWorkspaceName,
    tokenizerWorker: bundleEntry(
      opts.faultyTokenizer
        ? 'src/testing/fault-tokenizer-worker.ts'
        : 'src/daemon/highlight-worker.ts'
    ),
    tokenizeTimeoutMs: opts.tokenizeTimeoutMs
  })

  await server.listen(paths.socket)
  const client = new DaemonClient(paths.socket)
  await client.connect()

  let closed = false

  return {
    home,
    socket: paths.socket,
    host,
    server,
    client,
    logged,
    claudeLog: env.QUE_FAKE_CLAUDE_LOG,
    ghLog: env.QUE_FAKE_GH_LOG,
    ghPrs: env.QUE_FAKE_GH_PRS,
    acliLog: env.QUE_FAKE_ACLI_LOG,
    acliTickets: env.QUE_FAKE_ACLI_TICKETS,
    openLog: env.QUE_FAKE_OPEN_LOG,
    wrapperLog: env.QUE_FAKE_WRAPPER_LOG,
    configPath,
    async close(closeOpts = {}) {
      if (closed) return
      closed = true
      client.close()
      host.killAll()
      await server.close()
      vi.unstubAllEnvs()

      try {
        await assertPidsGone(host.pids)
      } finally {
        if (!closeOpts.keepHome) fs.rmSync(home, { recursive: true, force: true })
      }
    }
  }
}

/** Every `event` the client receives from now on, in order. */
export function recordEvents<E extends keyof Events>(client: DaemonClient, event: E): Events[E][] {
  const seen: Events[E][] = []
  client.on(event, (data) => seen.push(data))

  return seen
}

export interface StatusChange {
  id: string
  status: WorkspaceStatus
  reason: string | null
}

/** Records a row's projection each time it differs from the last one recorded for that id. */
function recordChanges<R extends { id: string }, C extends { id: string }>(
  events: Array<(cb: (row: R) => void) => void>,
  project: (row: R) => C
): C[] {
  const seen: C[] = []

  const note = (row: R): void => {
    const next = project(row)
    const last = seen.findLast((c) => c.id === next.id)

    if (last && Object.entries(next).every(([k, v]) => last[k as keyof C] === v)) return
    seen.push(next)
  }

  for (const subscribe of events) subscribe(note)

  return seen
}

/**
 * The status each workspace moves through, from its created row and every
 * update after it. An update that leaves status and reason as they were (a
 * new activity stamp, a rename) adds nothing.
 */
export function recordStatuses(client: DaemonClient): StatusChange[] {
  return recordChanges<Events['workspace.updated'], StatusChange>(
    [(cb) => client.on('workspace.created', cb), (cb) => client.on('workspace.updated', cb)],
    (w) => ({ id: w.id, status: w.status, reason: w.statusReason })
  )
}

/** Polls workspace.get until the workspace's status is `status`. */
export async function waitForStatus(
  d: TestDaemon,
  wsId: string,
  status: WorkspaceStatus,
  timeoutMs = 10_000
): Promise<void> {
  await expect
    .poll(async () => (await d.client.request('workspace.get', { id: wsId })).status, {
      timeout: timeoutMs
    })
    .toBe(status)
}

/** Opens a terminal in the workspace and starts claude there; returns the terminal and session ids. */
export async function runClaude(
  d: TestDaemon,
  wsId: string
): Promise<{ term: string; session: string }> {
  const { id } = await d.client.request('workspace.openTerminal', { id: wsId, cols: 100, rows: 30 })
  await d.client.request('term.write', { id, data: 'claude\r' })
  await expect
    .poll(async () => (await d.client.request('workspace.get', { id: wsId })).sessionId, {
      timeout: 20_000
    })
    .toMatch(/^[0-9a-f-]{36}$/)
  const { sessionId } = await d.client.request('workspace.get', { id: wsId })

  return { term: id, session: sessionId as string }
}
