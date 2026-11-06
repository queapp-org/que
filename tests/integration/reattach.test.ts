// A terminal coming back on screen, as the window does it: listen for term.data, ask to attach,
// keep what arrives until the answer, then write the snapshot and only what is past it. Output the
// daemon sent ahead of the snapshot is in the snapshot too, and it can reach a client that has just
// started listening when its connection was already streaming that terminal.
import net from 'node:net'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TerminalMirror } from '@daemon/mirror'
import { DaemonClient } from '@shared/client'
import { type Events, pastSnapshot } from '@shared/protocol'
import { startTestDaemon, type TestDaemon } from '../../src/testing/daemon-harness'

const COLS = 80
const ROWS = 24

/**
 * A socket in front of the daemon that can keep back what its client sends: a request on its way
 * through the main process, while the daemon goes on sending to that client.
 */
class RequestGate {
  private held: Array<() => void> | null = null
  private readonly sockets = new Set<net.Socket>()
  private readonly server: net.Server

  constructor(
    readonly socket: string,
    daemonSocket: string
  ) {
    this.server = net.createServer((client) => {
      const daemon = net.connect(daemonSocket)

      for (const s of [client, daemon]) {
        this.sockets.add(s)
        s.setNoDelay(true)
        s.on('error', () => {})
      }

      daemon.pipe(client)
      client.on('data', (chunk) => {
        const send = (): void => void daemon.write(chunk)

        if (this.held) this.held.push(send)
        else send()
      })
      client.on('close', () => daemon.destroy())
      daemon.on('close', () => client.destroy())
    })
  }

  listen(): Promise<void> {
    return new Promise((resolve) => this.server.listen(this.socket, resolve))
  }

  hold(): void {
    this.held = []
  }

  release(): void {
    const held = this.held ?? []
    this.held = null

    for (const send of held) send()
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy()
    await new Promise((resolve) => this.server.close(resolve))
  }
}

/** What the window does with a terminal it puts on screen, on a headless terminal of the same size. */
function attachAsTheWindow(client: DaemonClient, id: string) {
  const screen = new TerminalMirror(COLS, ROWS)
  const queued: Array<Events['term.data']> = []
  const live: string[] = []
  let attached = false
  let snapshotSeq: number | undefined

  const write = ({ data, seq }: Events['term.data']): void => {
    if (pastSnapshot(seq, snapshotSeq)) screen.write(data)
  }

  const off = client.on('term.data', (e) => {
    if (e.id !== id) return

    if (attached) {
      live.push(e.data)
      write(e)
    } else queued.push(e)
  })

  const answered = client.request('term.attach', { id, cols: COLS, rows: ROWS }).then((res) => {
    screen.write(res.snapshot)
    snapshotSeq = res.seq

    for (const e of queued) write(e)
    attached = true
  })

  return {
    answered,
    queuedText: () => queued.map((e) => e.data).join(''),
    liveText: () => live.join(''),
    /** The chunks that arrived ahead of the answer, though the snapshot holds them. */
    alsoInSnapshot: () => queued.filter((e) => !pastSnapshot(e.seq, snapshotSeq)).length,
    lines: async () => (await screen.snapshot()).text.split('\n'),
    close: () => {
      off()
      screen.dispose()
    }
  }
}

function numbered(n: number): string {
  return `L${String(n).padStart(6, '0')}`
}

/** Every line that is not the number after the line above it. The last may still be arriving. */
function outOfSequence(lines: string[]): string[] {
  const whole = lines.slice(0, -1)

  return whole.filter((line, i) => i > 0 && line !== numbered(Number(whole[i - 1].slice(1)) + 1))
}

describe('reattach', () => {
  let daemon: TestDaemon
  let gate: RequestGate
  let client: DaemonClient

  beforeEach(async () => {
    daemon = await startTestDaemon()
    gate = new RequestGate(join(daemon.home, 'gate.sock'), daemon.socket)
    await gate.listen()
    client = new DaemonClient(gate.socket)
    await client.connect()
  })

  afterEach(async () => {
    client.close()
    await gate.close()
    await daemon.close()
  })

  async function inMirror(id: string, text: string): Promise<void> {
    await expect
      .poll(async () => (await daemon.client.request('term.snapshot', { id })).text, {
        timeout: 10_000
      })
      .toContain(text)
  }

  /** A terminal that prints each line typed at it, and only that: `print` is a chunk of output. */
  async function openPrinter(): Promise<{ id: string; print: (line: string) => Promise<void> }> {
    const { id } = await daemon.client.request('term.create', {
      file: '/bin/sh',
      args: ['-c', 'stty -echo; echo READY; exec cat'],
      cols: COLS,
      rows: ROWS
    })

    await inMirror(id, 'READY')

    return {
      id,
      print: async (line) => {
        await daemon.client.request('term.write', { id, data: `${line}\n` })
        await inMirror(id, line)
      }
    }
  }

  describe('output printed while the attach is on its way', () => {
    it('is written once on a connection already streaming the terminal', async () => {
      const { id, print } = await openPrinter()
      // A window closed or reloaded with this terminal on screen never detached it.
      await client.request('term.attach', { id, cols: COLS, rows: ROWS })
      await print('QUE_BEFORE_3a1f')

      gate.hold()
      const pane = attachAsTheWindow(client, id)
      await print('QUE_DURING_3a1f')
      await expect.poll(() => pane.queuedText(), { timeout: 10_000 }).toContain('QUE_DURING_3a1f')
      gate.release()
      await pane.answered

      await print('QUE_AFTER_3a1f')
      await expect.poll(() => pane.liveText(), { timeout: 10_000 }).toContain('QUE_AFTER_3a1f')
      expect(await pane.lines()).toEqual([
        'READY',
        'QUE_BEFORE_3a1f',
        'QUE_DURING_3a1f',
        'QUE_AFTER_3a1f'
      ])
      pane.close()
    }, 30_000)

    it('is written once when a detach goes just ahead of the attach, as a pane moving does', async () => {
      const { id, print } = await openPrinter()
      await client.request('term.attach', { id, cols: COLS, rows: ROWS })
      await print('QUE_BEFORE_8c2e')

      gate.hold()
      void client.request('term.detach', { id })
      const pane = attachAsTheWindow(client, id)
      await print('QUE_DURING_8c2e')
      await expect.poll(() => pane.queuedText(), { timeout: 10_000 }).toContain('QUE_DURING_8c2e')
      gate.release()
      await pane.answered

      await print('QUE_AFTER_8c2e')
      await expect.poll(() => pane.liveText(), { timeout: 10_000 }).toContain('QUE_AFTER_8c2e')
      expect(await pane.lines()).toEqual([
        'READY',
        'QUE_BEFORE_8c2e',
        'QUE_DURING_8c2e',
        'QUE_AFTER_8c2e'
      ])
      pane.close()
    }, 30_000)
  })

  describe('a terminal printing as fast as it can', () => {
    const ATTACHES = 20

    // Whether the snapshot and the queue overlap at all depends on the connection; the screen is
    // whole either way. `overlaps` keeps these from passing because the race was never hit.
    it.each([
      {
        how: 'a first attach on its own connection',
        overlaps: false,
        connectionFor: async () => {
          const fresh = new DaemonClient(gate.socket)
          await fresh.connect()

          return fresh
        }
      },
      {
        how: 'a re-attach on a connection already streaming it',
        overlaps: true,
        connectionFor: async () => client
      },
      {
        how: 'a detach and an attach sent together',
        overlaps: true,
        connectionFor: async (id: string) => {
          void client.request('term.detach', { id })

          return client
        }
      },
      {
        how: 'an attach after the detach was answered, as a tab switched away and back',
        overlaps: false,
        connectionFor: async (id: string) => {
          await client.request('term.detach', { id })

          return client
        }
      }
    ])(
      'writes every line once, in order, on $how',
      async ({ overlaps, connectionFor }) => {
        const { id } = await daemon.client.request('term.create', {
          file: '/bin/sh',
          args: ['-c', 'i=0; while :; do i=$((i+1)); printf "L%06d\\n" "$i"; done'],
          cols: COLS,
          rows: ROWS
        })

        await inMirror(id, 'L')
        await client.request('term.attach', { id, cols: COLS, rows: ROWS })

        const broken: string[] = []
        let alsoInSnapshot = 0

        for (let i = 0; i < ATTACHES; i++) {
          const pane = attachAsTheWindow(await connectionFor(id), id)
          await pane.answered
          const liveBefore = pane.liveText().length
          await expect
            .poll(() => pane.liveText().slice(liveBefore).split('\n').length, {
              timeout: 20_000,
              interval: 2
            })
            .toBeGreaterThan(2)
          broken.push(...outOfSequence(await pane.lines()))
          alsoInSnapshot += pane.alsoInSnapshot()
          pane.close()
        }

        expect(broken).toEqual([])
        expect(alsoInSnapshot > 0).toBe(overlaps)
      },
      120_000
    )
  })
})
