// A terminal this daemon took over from the daemon before it: the shell keeps
// running on the PTY whose master fd was inherited through the stdio array.
// node-pty cannot adopt an existing master, so this reads the fd through a tty
// stream as node-pty does, writes and resizes it directly, and signals the
// shell by pid.
import tty from 'node:tty'
import type { TermInfo, TermSnapshotResult } from '../shared/protocol'
import { errorCode } from '../shared/errors.decode'
import { TerminalFacts } from './foreground'
import { type SerializedMirror, TerminalMirror } from './mirror'
import { FdWriter, holdReading, ptyBinding, resumeReading } from './pty-fd'
import { termInfo, type ExitInfo, type Term } from './term'

/** What a successor learns about one terminal from the handoff snapshot. */
export interface AdoptSpec {
  id: string
  name: string
  cwd: string
  createdAt: string
  workspaceId?: string
  pid: number
  cols: number
  rows: number
  /** The inherited master fd in this process. */
  fd: number
  /** The predecessor's mirror, serialized: screen and scrollback. */
  serialized: string
  /** The last title the program set; the serialized screen does not carry it. */
  title?: string
  /** The foreground program's name as the predecessor last knew it. */
  process?: string
}

export class AdoptedTerminal implements Term {
  readonly id: string
  readonly name: string
  readonly cwd: string
  readonly createdAt: string
  readonly workspaceId?: string
  readonly pid: number
  readonly masterFd: number
  alive = true
  cols: number
  rows: number
  private readonly mirror: TerminalMirror
  private readonly stream: tty.ReadStream
  private readonly writer: FdWriter
  private readonly facts: TerminalFacts
  private exited = false

  constructor(
    spec: AdoptSpec,
    onData: (data: string, seq: number) => void,
    private readonly onExit: (e: ExitInfo) => void,
    onUpdate: (info: TermInfo) => void
  ) {
    this.id = spec.id
    this.name = spec.name
    this.cwd = spec.cwd
    this.createdAt = spec.createdAt
    this.workspaceId = spec.workspaceId
    this.pid = spec.pid
    this.masterFd = spec.fd
    this.cols = spec.cols
    this.rows = spec.rows
    this.mirror = new TerminalMirror(spec.cols, spec.rows)
    this.mirror.write(spec.serialized)
    this.facts = new TerminalFacts(
      {
        pid: spec.pid,
        masterFd: spec.fd,
        alive: () => this.alive,
        mirror: this.mirror,
        onChange: () => onUpdate(this.info())
      },
      { title: spec.title, process: spec.process }
    )
    this.writer = new FdWriter(spec.fd)

    // A tty stream does not read until it flows; paused first, the listener
    // below does not start it either.
    this.stream = new tty.ReadStream(spec.fd)
    this.stream.setEncoding('utf8')
    this.stream.pause()
    this.stream.on('data', (data: string) => {
      onData(data, this.mirror.write(data))
    })
    // The shell's exit closes the slave end: EOF, or EIO on some systems.
    this.stream.on('end', () => this.exit())
    this.stream.on('close', () => this.exit())
    this.stream.on('error', (err) => {
      if (errorCode(err) !== 'EAGAIN') this.exit()
    })
    this.facts.start()
  }

  get title(): string | undefined {
    return this.facts.title
  }

  get process(): string | undefined {
    return this.facts.process
  }

  write(data: string): void {
    if (this.alive) this.writer.write(data)
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
      ptyBinding().resize(this.masterFd, cols, rows)
    } catch {
      // The shell may have exited between the check and the resize.
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
        // The signal node-pty sends by default.
        process.kill(this.pid, 'SIGHUP')
      } catch {
        // Already gone.
      }
    }

    this.alive = false
    this.facts.stop()
    this.writer.close()
    this.stream.destroy()
  }

  dispose(): void {
    this.kill()
    this.mirror.dispose()
  }

  info(): TermInfo {
    return termInfo(this)
  }

  private exit(): void {
    if (this.exited) return
    this.exited = true
    this.alive = false
    this.facts.stop()
    this.writer.close()
    // This daemon is not the shell's parent, so it cannot learn the exit
    // status; an ended terminal reports 0, as the protocol needs a number.
    this.onExit({ exitCode: 0 })
  }
}
