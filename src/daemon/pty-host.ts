import { randomUUID } from 'node:crypto'
import { cleanSpawnEnv } from '../shared/env'
import { loginShell } from '../shared/login-path'
import os from 'node:os'
import type tty from 'node:tty'
import * as pty from 'node-pty'
import type { TermCreateParams, TermInfo, TermSnapshotResult } from '../shared/protocol'
import { AdoptedTerminal, type AdoptSpec } from './adopted-terminal'
import { TerminalFacts } from './foreground'
import { type SerializedMirror, TerminalMirror } from './mirror'
import { holdReading, resumeReading } from './pty-fd'
import { termInfo, type ExitInfo, type Term } from './term'

export type { ExitInfo, Term } from './term'

/** Daemon-internal terminal options that clients cannot set directly. */
export interface TermExtra {
  /** Merged over the daemon's environment. */
  env?: Record<string, string>
  workspaceId?: string
}

/** What node-pty keeps on a terminal and its typings leave out: the master fd and the stream reading it. */
interface PtyInternals {
  fd: number
  _socket: tty.ReadStream
}

function internals(proc: pty.IPty): pty.IPty & PtyInternals {
  return proc as pty.IPty & PtyInternals
}

/** One PTY plus an @xterm/headless mirror of everything it has printed. */
export class HostedTerminal implements Term {
  readonly id: string
  readonly name: string
  readonly cwd: string
  readonly createdAt: string
  readonly proc: pty.IPty
  readonly workspaceId?: string
  private readonly mirror: TerminalMirror
  private readonly facts: TerminalFacts
  alive = true
  cols: number
  rows: number

  constructor(
    opts: TermCreateParams,
    onData: (data: string, seq: number) => void,
    onExit: (e: ExitInfo) => void,
    onUpdate: (info: TermInfo) => void,
    extra: TermExtra = {}
  ) {
    this.id = randomUUID()
    this.workspaceId = extra.workspaceId
    this.cols = Math.max(1, Math.floor(opts.cols) || 80)
    this.rows = Math.max(1, Math.floor(opts.rows) || 24)
    this.cwd = opts.cwd || os.homedir()
    this.createdAt = new Date().toISOString()

    const file = opts.file ?? loginShell()
    // A login shell picks up the user's profile, as a terminal app would.
    const args = opts.args ?? (opts.file ? [] : ['-l'])
    this.name = opts.name || file.split('/').pop() || 'shell'

    this.mirror = new TerminalMirror(this.cols, this.rows)

    this.proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      // QUE_TERMINAL_ID: hooks of a session started here name the terminal they fired in.
      env: { ...spawnEnv(), ...extra.env, QUE_TERMINAL_ID: this.id }
    })
    this.proc.onData((data) => {
      onData(data, this.mirror.write(data))
    })
    this.proc.onExit(({ exitCode, signal }) => {
      this.alive = false
      this.facts.stop()
      onExit({ exitCode, signal })
    })
    this.facts = new TerminalFacts({
      pid: this.proc.pid,
      masterFd: this.masterFd,
      alive: () => this.alive,
      mirror: this.mirror,
      onChange: () => onUpdate(this.info())
    })
    this.facts.start()
  }

  get title(): string | undefined {
    return this.facts.title
  }

  get process(): string | undefined {
    return this.facts.process
  }

  get pid(): number {
    return this.proc.pid
  }

  get masterFd(): number {
    return internals(this.proc).fd
  }

  /** node-pty reads the master through a tty stream it keeps to itself. */
  private get stream(): tty.ReadStream {
    return internals(this.proc)._socket
  }

  write(data: string): void {
    if (this.alive) this.proc.write(data)
  }

  resize(cols: number, rows: number): void {
    cols = Math.floor(cols)
    rows = Math.floor(rows)

    if (!(cols >= 1 && rows >= 1)) return

    if (cols === this.cols && rows === this.rows) return
    this.cols = cols
    this.rows = rows
    this.mirror.resize(cols, rows)

    if (!this.alive) return

    try {
      this.proc.resize(cols, rows)
    } catch {
      // The process may have exited between the check and the resize.
    }
  }

  snapshot(): Promise<TermSnapshotResult> {
    return this.mirror.snapshot()
  }

  serializeNow(): Promise<SerializedMirror> {
    return this.mirror.serializeNow()
  }

  holdReading(): void {
    holdReading(this.stream)
  }

  resumeReading(): void {
    resumeReading(this.stream)
  }

  kill(): void {
    if (this.alive) {
      try {
        this.proc.kill()
      } catch {
        // Already gone.
      }
    }

    this.alive = false
  }

  dispose(): void {
    this.kill()
    this.facts.stop()
    this.mirror.dispose()
  }

  info(): TermInfo {
    return termInfo(this)
  }
}

/** The environment of a terminal: the daemon's, cleaned (see shared/env.ts), as an xterm. */
export function spawnEnv(): Record<string, string> {
  const env = cleanSpawnEnv(process.env)
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'

  return env
}

type DataListener = (id: string, data: string, seq: number) => void

type ExitListener = (id: string, info: ExitInfo) => void

type UpdateListener = (info: TermInfo) => void

/** Owns every terminal in the daemon; terminals outlive client connections. */
export class PtyHost {
  private terms = new Map<string, Term>()
  private dataListeners = new Set<DataListener>()
  private exitListeners = new Set<ExitListener>()
  private updateListeners = new Set<UpdateListener>()

  create(opts: TermCreateParams, extra?: TermExtra): HostedTerminal {
    let id = ''

    const t = new HostedTerminal(
      opts,
      (data, seq) => this.emitData(id, data, seq),
      (info) => this.emitExit(id, info),
      (info) => this.emitUpdate(info),
      extra
    )

    id = t.id
    this.terms.set(id, t)

    return t
  }

  /**
   * Takes over a terminal a predecessor daemon handed over, under its old id.
   * It does not read until resumeReading(), so nothing is taken from the PTY
   * before this daemon serves.
   */
  adopt(spec: AdoptSpec): AdoptedTerminal {
    const t = new AdoptedTerminal(
      spec,
      (data, seq) => this.emitData(spec.id, data, seq),
      (info) => this.emitExit(spec.id, info),
      (info) => this.emitUpdate(info)
    )

    this.terms.set(t.id, t)

    return t
  }

  get(id: string): Term | undefined {
    return this.terms.get(id)
  }

  list(): Term[] {
    return [...this.terms.values()]
  }

  /** Kills the process and forgets the terminal. Returns false if unknown. */
  kill(id: string): boolean {
    const t = this.terms.get(id)

    if (!t) return false
    this.terms.delete(id)
    t.dispose()

    return true
  }

  killAll(): void {
    for (const id of [...this.terms.keys()]) this.kill(id)
  }

  onData(l: DataListener): () => void {
    this.dataListeners.add(l)

    return () => this.dataListeners.delete(l)
  }

  onExit(l: ExitListener): () => void {
    this.exitListeners.add(l)

    return () => this.exitListeners.delete(l)
  }

  /** Fires when a terminal's title or foreground program changed. */
  onUpdate(l: UpdateListener): () => void {
    this.updateListeners.add(l)

    return () => this.updateListeners.delete(l)
  }

  private emitData(id: string, data: string, seq: number): void {
    for (const l of this.dataListeners) l(id, data, seq)
  }

  private emitExit(id: string, info: ExitInfo): void {
    for (const l of this.exitListeners) l(id, info)
  }

  private emitUpdate(info: TermInfo): void {
    for (const l of this.updateListeners) l(info)
  }
}
