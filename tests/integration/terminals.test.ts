// Terminals over the real socket: real node-pty, the headless mirror, and the
// real DaemonClient against an in-process DaemonServer (migrated from the
// first work package's pty-host and server tests).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonClient } from '@shared/client'
import type { TermInfo } from '@shared/protocol'
import { recordEvents, startTestDaemon, type TestDaemon } from '../../src/testing/daemon-harness'

let daemon: TestDaemon
let client: DaemonClient

beforeEach(async () => {
  daemon = await startTestDaemon()
  client = daemon.client
})

afterEach(async () => {
  await daemon.close()
})

/** A shell without the user's profile, quick to start; `zsh` in the foreground. */
const SHELL = { file: '/bin/zsh', args: ['-f'], cols: 80, rows: 24 }

const listed = async (id: string): Promise<TermInfo | undefined> =>
  (await client.request('term.list')).find((t) => t.id === id)

describe('terminals', () => {
  describe('output', () => {
    it('mirrors program output into the snapshot and reports the exit code', async () => {
      const exits = recordEvents(client, 'term.exit')

      const { id } = await client.request('term.create', {
        file: '/bin/sh',
        args: ['-c', 'printf "QUE_MIRROR_4b1e\\n"; exit 3'],
        cols: 80,
        rows: 24
      })

      await expect
        .poll(async () => (await client.request('term.snapshot', { id })).text, { timeout: 10_000 })
        .toContain('QUE_MIRROR_4b1e')
      expect((await client.request('term.snapshot', { id })).serialized).toContain(
        'QUE_MIRROR_4b1e'
      )

      await expect
        .poll(() => exits, { timeout: 10_000 })
        .toContainEqual(expect.objectContaining({ id, exitCode: 3 }))
      const listed = await client.request('term.list')
      expect(listed.find((t) => t.id === id)).toMatchObject({ alive: false })
    }, 20_000)

    it('counts an emoji as two cells, so the cursor stands where the program thinks it does', async () => {
      // Back to the line's start and two cells right: B lands on A only if the emoji took two.
      const line = (emoji: string): string => `${emoji}A\\r\\033[2CB\\n\\r`

      const { id } = await client.request('term.create', {
        file: '/bin/sh',
        args: ['-c', `printf '${line('✅')}${line('🚀')}${line('🧠')}'; sleep 30`],
        cols: 80,
        rows: 24
      })

      await expect
        .poll(async () => (await client.request('term.snapshot', { id })).text, { timeout: 10_000 })
        .toBe('✅B\n🚀B\n🧠B')
    }, 20_000)

    it('keeps a clipboard write out of the snapshot', async () => {
      const { id } = await client.request('term.create', {
        file: '/bin/sh',
        args: ['-c', `printf 'QUE_BEFORE_6d1a\\033]52;c;aGk=\\007QUE_AFTER_6d1a'; sleep 30`],
        cols: 80,
        rows: 24
      })

      await expect
        .poll(async () => (await client.request('term.snapshot', { id })).text, { timeout: 10_000 })
        .toContain('QUE_AFTER_6d1a')

      const { snapshot } = await client.request('term.attach', { id, cols: 80, rows: 24 })

      expect(snapshot).toContain('QUE_BEFORE_6d1aQUE_AFTER_6d1a')
      expect(snapshot).not.toContain(']52')
    }, 20_000)

    it('streams live output to an attached client', async () => {
      const data = recordEvents(client, 'term.data')
      const { id } = await client.request('term.create', { file: '/bin/cat', cols: 80, rows: 24 })
      await client.request('term.attach', { id, cols: 80, rows: 24 })

      await client.request('term.write', { id, data: 'QUE_STREAM_91c0\n' })

      await expect
        .poll(
          () =>
            data
              .filter((d) => d.id === id)
              .map((d) => d.data)
              .join(''),
          { timeout: 10_000 }
        )
        .toContain('QUE_STREAM_91c0')
    }, 20_000)
  })

  describe('environment', () => {
    it("starts a shell without the launching terminal's identity or an agent session's markers", async () => {
      // As when the daemon was started from a shell inside another terminal
      // emulator, by an agent's tool: none of that belongs to a new terminal.
      vi.stubEnv('TERM_PROGRAM', 'kitty')
      vi.stubEnv('KITTY_WINDOW_ID', '3')
      vi.stubEnv('CLAUDECODE', '1')
      vi.stubEnv('CLAUDE_CODE_CHILD_SESSION', '1')
      vi.stubEnv('CLAUDE_CONFIG_DIR', '/Users/dev/.claude-work')

      const { id } = await client.request('term.create', {
        file: '/bin/sh',
        args: [
          '-c',
          'env | grep -E "^(TERM|TERM_PROGRAM|KITTY_WINDOW_ID|CLAUDECODE|CLAUDE_CODE_CHILD_SESSION|CLAUDE_CONFIG_DIR|QUE_TERMINAL)=" | sort; echo QUE_ENV_END'
        ],
        cols: 80,
        rows: 24
      })

      await expect
        .poll(async () => (await client.request('term.snapshot', { id })).text, { timeout: 10_000 })
        .toContain('QUE_ENV_END')

      const lines = (await client.request('term.snapshot', { id })).text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.includes('='))

      expect(lines).toEqual([
        'CLAUDE_CONFIG_DIR=/Users/dev/.claude-work',
        'QUE_TERMINAL=1',
        'TERM=xterm-256color'
      ])
    })
  })

  describe('attach', () => {
    it('replays the screen to a client that attaches after the output was written', async () => {
      const { id } = await client.request('term.create', {
        cols: 80,
        rows: 24,
        file: '/bin/sh',
        args: ['-c', 'printf QUE_ATTACH_7f3a; sleep 30']
      })

      await expect
        .poll(async () => (await client.request('term.snapshot', { id })).text, { timeout: 10_000 })
        .toContain('QUE_ATTACH_7f3a')

      const late = new DaemonClient(daemon.socket)
      await late.connect()
      const { snapshot } = await late.request('term.attach', { id, cols: 80, rows: 24 })
      late.close()

      expect(snapshot).toContain('QUE_ATTACH_7f3a')
    }, 20_000)

    it('stops streaming to a client once it detaches', async () => {
      const data = recordEvents(client, 'term.data')
      const { id } = await client.request('term.create', { file: '/bin/cat', cols: 80, rows: 24 })
      await client.request('term.attach', { id, cols: 80, rows: 24 })
      await client.request('term.write', { id, data: 'QUE_BEFORE_d2a8\n' })
      await expect
        .poll(() => data.map((d) => d.data).join(''), { timeout: 10_000 })
        .toContain('QUE_BEFORE_d2a8')

      await client.request('term.detach', { id })
      const seenBefore = data.length
      await client.request('term.write', { id, data: 'QUE_AFTER_5e17\n' })

      await expect
        .poll(async () => (await client.request('term.snapshot', { id })).text, { timeout: 10_000 })
        .toContain('QUE_AFTER_5e17')
      expect(
        data
          .slice(seenBefore)
          .map((d) => d.data)
          .join('')
      ).not.toContain('QUE_AFTER_5e17')
    }, 20_000)
  })

  describe('resize', () => {
    it('applies the size requested on attach and on resize', async () => {
      const { id } = await client.request('term.create', { file: '/bin/cat', cols: 80, rows: 24 })

      const attached = await client.request('term.attach', { id, cols: 90, rows: 20 })
      expect(attached).toMatchObject({ cols: 90, rows: 20 })

      await client.request('term.resize', { id, cols: 100, rows: 30 })
      const listed = await client.request('term.list')
      expect(listed.find((t) => t.id === id)).toMatchObject({ cols: 100, rows: 30, alive: true })
    }, 20_000)
  })

  describe('create', () => {
    it('announces the terminal with the same row the reply and the list carry', async () => {
      const created = recordEvents(client, 'term.created')

      const reply = await client.request('term.create', {
        cwd: daemon.home,
        file: '/bin/cat',
        cols: 80,
        rows: 24
      })

      await expect.poll(() => created, { timeout: 5_000 }).toHaveLength(1)
      const listed = (await client.request('term.list')).find((t) => t.id === reply.id)
      expect(reply).toMatchObject({ cwd: daemon.home, alive: true })
      expect(created[0]).toEqual(reply)
      // The foreground program is resolved after the announcement, so the row may know it by now.
      expect(listed).toMatchObject(created[0])
    }, 20_000)
  })

  describe('kill', () => {
    it('kills a terminal, announces it, and drops it from the list', async () => {
      const killed = recordEvents(client, 'term.killed')
      const { id } = await client.request('term.create', { file: '/bin/cat', cols: 80, rows: 24 })

      await client.request('term.kill', { id })

      await expect.poll(() => killed, { timeout: 5_000 }).toContainEqual({ id })
      expect((await client.request('term.list')).map((t) => t.id)).not.toContain(id)
    }, 20_000)
  })
  describe('title and foreground program', () => {
    it('reports the title a program sets, and drops it when the title is emptied', async () => {
      const updates = recordEvents(client, 'term.updated')
      const { id } = await client.request('term.create', SHELL)

      await client.request('term.write', { id, data: "printf '\\033]0;QUE_TITLE_5d2c\\007'\r" })

      await expect
        .poll(() => updates.filter((u) => u.id === id).map((u) => u.title), { timeout: 10_000 })
        .toContain('QUE_TITLE_5d2c')
      expect((await listed(id))?.title).toBe('QUE_TITLE_5d2c')

      await client.request('term.write', { id, data: "printf '\\033]0;\\007'\r" })

      await expect.poll(async () => listed(id), { timeout: 10_000 }).not.toHaveProperty('title')
      expect(updates.filter((u) => u.id === id).at(-1)).not.toHaveProperty('title')
    }, 20_000)

    it('follows the program in the foreground, announcing each change once', async () => {
      const updates = recordEvents(client, 'term.updated')
      const { id } = await client.request('term.create', SHELL)

      await expect.poll(async () => (await listed(id))?.process, { timeout: 10_000 }).toBe('zsh')

      await client.request('term.write', { id, data: 'cat\r' })

      await expect.poll(async () => (await listed(id))?.process, { timeout: 10_000 }).toBe('cat')

      await client.request('term.write', { id, data: '\x03' })

      await expect.poll(async () => (await listed(id))?.process, { timeout: 10_000 }).toBe('zsh')

      // One event per change, none repeating the one before.
      expect(updates.filter((u) => u.id === id).map((u) => u.process)).toEqual([
        'zsh',
        'cat',
        'zsh'
      ])
    }, 20_000)

    it('keeps the last foreground program after the terminal exits', async () => {
      const exits = recordEvents(client, 'term.exit')
      const { id } = await client.request('term.create', SHELL)
      await expect.poll(async () => (await listed(id))?.process, { timeout: 10_000 }).toBe('zsh')

      await client.request('term.write', { id, data: 'exit\r' })

      await expect.poll(() => exits.map((e) => e.id), { timeout: 10_000 }).toContain(id)
      expect(await listed(id)).toMatchObject({ alive: false, process: 'zsh' })
    }, 20_000)

    it("reports the session's title while Claude Code runs and none after it exits", async () => {
      vi.stubEnv('QUE_FAKE_CLAUDE_TITLE', 'QUE_SESSION_8e41')
      const { id } = await client.request('term.create', { file: 'claude', cols: 80, rows: 24 })

      await expect
        .poll(async () => (await listed(id))?.title, { timeout: 10_000 })
        .toBe('✳ QUE_SESSION_8e41')

      await client.request('term.write', { id, data: '/exit\r' })

      await expect.poll(async () => listed(id), { timeout: 10_000 }).toMatchObject({ alive: false })
      expect(await listed(id)).not.toHaveProperty('title')
    }, 20_000)
  })
})
