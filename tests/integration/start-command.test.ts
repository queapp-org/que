// The command que types to start claude, into a real login shell whose profile
// is still running. Typed too soon, the tty echoes it and the line editor then
// draws it again, so the terminal opens on the command twice. The shells read a
// fixture profile from a temp HOME, never the real one; it says when it is
// running and holds the shell there until the test opens its gate. The rules of
// the wait itself are in src/daemon/shell-ready.test.ts.
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  startTestDaemon,
  type TestDaemon,
  type TestDaemonOptions
} from '../../src/testing/daemon-harness'
import { makeFakeIssue, readFakeLog, writeFakeTickets } from '../../src/testing/fakes'
import { makeTempRepo } from '../../src/testing/temp-repo'

const PROFILE_RUNNING = 'QUE_PROFILE_RUNNING_7f3a'
const PROMPT = 'que-prompt> '
const CLAUDE_BANNER = 'Claude Code v2.1.0 (fake)'
const SESSION = '6b2e9f4c-1a7d-4c3e-8f5b-2d9a6e1c7b40'

interface Shell {
  name: string
  file: string
  profile: string
  /** The end of the profile: sets the prompt. */
  setup: string
}

const ZSH: Shell = {
  name: 'zsh',
  file: '/bin/zsh',
  profile: '.zshrc',
  setup: `PROMPT='${PROMPT}'`
}

const BASH: Shell = {
  name: 'bash',
  file: '/bin/bash',
  profile: '.bash_profile',
  // The system profile's path_helper moves the fake claude's wrapper behind the system's folders.
  setup: `PS1='${PROMPT}'\nexport PATH="$QUE_HOME/bin:$PATH"`
}

let daemon: TestDaemon | undefined
const dirs: string[] = []

afterEach(async () => {
  await daemon?.close()
  daemon = undefined

  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'que-shell-')))
  dirs.push(dir)

  return dir
}

/** Terminals start `file` as the login shell and see `dir` as home. */
function stubShell(file: string, dir: string): void {
  vi.stubEnv('SHELL', file)
  vi.stubEnv('HOME', dir)
  vi.stubEnv('ZDOTDIR', dir)
}

/** A temp HOME with the shell's profile, which waits for the file `gate`. */
function shellHome(shell: Shell): { dir: string; gate: string } {
  const dir = tempDir()
  const gate = join(dir, 'profile-gate')

  fs.writeFileSync(
    join(dir, shell.profile),
    `echo ${PROFILE_RUNNING}\nuntil [ -f '${gate}' ]; do sleep 0.02; done\n${shell.setup}\n`
  )
  stubShell(shell.file, dir)

  return { dir, gate }
}

async function startDaemon(opts?: TestDaemonOptions): Promise<TestDaemon> {
  daemon = await startTestDaemon(opts)

  return daemon
}

async function screen(d: TestDaemon, id: string): Promise<string> {
  return (await d.client.request('term.snapshot', { id })).text
}

async function waitForScreen(d: TestDaemon, id: string, text: string): Promise<void> {
  await expect.poll(() => screen(d, id), { timeout: 20_000 }).toContain(text)
}

async function screenLines(d: TestDaemon, id: string): Promise<string[]> {
  return (await screen(d, id)).split('\n').map((line) => line.trimEnd())
}

async function newWorkspace(d: TestDaemon): Promise<string> {
  const project = await d.client.request('project.add', { path: makeTempRepo(d.home) })

  const ws = await d.client.request('workspace.create', {
    projectId: project.id,
    name: 'app-302-start-command'
  })

  return ws.id
}

describe('typing the start command into a shell that is still starting', () => {
  it.each([ZSH, BASH])(
    'shows it once, after the prompt, in a new workspace under $name',
    async (shell) => {
      const { gate } = shellHome(shell)
      const d = await startDaemon()
      const id = await newWorkspace(d)

      const { terminal } = await d.client.request('workspace.start', { id })

      await waitForScreen(d, terminal.id, PROFILE_RUNNING)
      fs.writeFileSync(gate, '')
      await waitForScreen(d, terminal.id, CLAUDE_BANNER)

      const shown = (await screenLines(d, terminal.id)).filter((line) => line.endsWith('claude'))
      expect(shown).toEqual([`${PROMPT}claude`])
      expect(readFakeLog(d.claudeLog)).toHaveLength(1)
    },
    60_000
  )

  it.each([ZSH, BASH])(
    "shows a resumed session's command once in the loose terminal reopened after a restart, under $name",
    async (shell) => {
      const { dir, gate } = shellHome(shell)
      fs.writeFileSync(gate, '')
      const first = await startDaemon()

      const { id: loose } = await first.client.request('term.create', {
        cwd: first.home,
        cols: 100,
        rows: 30
      })

      await first.client.request('term.write', {
        id: loose,
        data: `claude --session-id ${SESSION}\r`
      })
      await waitForScreen(first, loose, CLAUDE_BANNER)
      // A reply means the session's start hook has been delivered: it reads input only after.
      await first.client.request('term.write', { id: loose, data: 'jot this down\r' })
      await waitForScreen(first, loose, 'Fake reply to: jot this down')

      await first.close({ keepHome: true })
      fs.rmSync(gate)
      stubShell(shell.file, dir)
      const d = await startDaemon({ home: first.home })

      await expect.poll(() => d.client.request('term.list'), { timeout: 20_000 }).toHaveLength(1)
      const [{ id }] = await d.client.request('term.list')
      await waitForScreen(d, id, PROFILE_RUNNING)
      fs.writeFileSync(gate, '')
      await waitForScreen(d, id, CLAUDE_BANNER)

      const command = `claude --resume '${SESSION}'`
      const shown = (await screenLines(d, id)).filter((line) => line.includes(command))
      expect(shown).toEqual([`${PROMPT}${command}`])
    },
    90_000
  )

  it('shows it once in the loose session of a ticket', async () => {
    const { gate } = shellHome(ZSH)
    const d = await startDaemon({ config: '[jira]\npoll_minutes = 0.002\n' })
    writeFakeTickets(d.acliTickets, [makeFakeIssue()])

    await expect
      .poll(async () => (await d.client.request('tickets.list', {})).tickets.length, {
        timeout: 10_000
      })
      .toBe(1)

    const started = await d.client.request('tickets.start', { key: 'APP-1432', session: true })
    expect(started.kind).toBe('session')

    if (started.kind !== 'session') return
    const { id } = started.terminal
    await waitForScreen(d, id, PROFILE_RUNNING)
    fs.writeFileSync(gate, '')
    await waitForScreen(d, id, CLAUDE_BANNER)

    const shown = (await screenLines(d, id)).filter((line) => line.includes("claude 'Read "))
    expect(shown).toHaveLength(1)
    expect(shown[0].startsWith(`${PROMPT}claude 'Read `)).toBe(true)
  }, 60_000)

  it('logs that claude was not started when the terminal dies during the wait', async () => {
    shellHome(ZSH)
    const d = await startDaemon()
    const id = await newWorkspace(d)

    const { terminal } = await d.client.request('workspace.start', { id })

    await waitForScreen(d, terminal.id, PROFILE_RUNNING)
    await d.client.request('term.kill', { id: terminal.id })

    await expect
      .poll(() => d.logged, { timeout: 10_000 })
      .toContain(`workspace ${id}: terminal ${terminal.id} is gone; claude not started`)
    expect(readFakeLog(d.claudeLog)).toEqual([])
  }, 30_000)

  it('types it anyway, and logs so, when a shell has no line editor', async () => {
    const plainShell = join(tempDir(), 'plain-shell')

    fs.writeFileSync(
      plainShell,
      '#!/bin/sh\n# Reads lines straight from the tty, which keeps ECHO on.\nwhile IFS= read -r line; do eval "$line"; done\n',
      { mode: 0o755 }
    )
    stubShell(plainShell, tempDir())
    const d = await startDaemon()
    const id = await newWorkspace(d)

    const { terminal } = await d.client.request('workspace.start', { id })

    await waitForScreen(d, terminal.id, CLAUDE_BANNER)

    expect(d.logged).toContain(
      `workspace ${id}: terminal ${terminal.id} has no line editor after 10s; typing the command anyway`
    )
    const shown = (await screenLines(d, terminal.id)).filter((line) => line.endsWith('claude'))
    expect(shown).toEqual(['claude'])
  }, 60_000)
})
