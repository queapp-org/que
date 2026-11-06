// What the server and a handoff use of a terminal, whichever kind it is.
import type { TermInfo, TermSnapshotResult } from '../shared/protocol'
import type { SerializedMirror } from './mirror'

export interface ExitInfo {
  exitCode: number
  signal?: number
}

/**
 * What the server and a handoff use of a terminal, whether this daemon spawned
 * it (HostedTerminal) or took it over from its predecessor (AdoptedTerminal).
 */
export interface Term {
  readonly id: string
  readonly name: string
  readonly cwd: string
  readonly createdAt: string
  readonly workspaceId?: string
  readonly pid: number
  /** The master end of the PTY, passed to a successor on a handoff. */
  readonly masterFd: number
  readonly alive: boolean
  readonly cols: number
  readonly rows: number
  /** The last title the program set (OSC 0/2); undefined when none or empty. */
  readonly title: string | undefined
  /** The foreground program's name; undefined until first read, kept after exit. */
  readonly process: string | undefined
  write(data: string): void
  resize(cols: number, rows: number): void
  snapshot(): Promise<TermSnapshotResult>
  serializeNow(): Promise<SerializedMirror>
  /** Stops reading the PTY; what it prints from now on waits in the kernel. */
  holdReading(): void
  resumeReading(): void
  kill(): void
  dispose(): void
  info(): TermInfo
}

/** The protocol's view of a terminal. */
export function termInfo(t: Term): TermInfo {
  return {
    id: t.id,
    name: t.name,
    cwd: t.cwd,
    cols: t.cols,
    rows: t.rows,
    pid: t.pid,
    alive: t.alive,
    createdAt: t.createdAt,
    workspaceId: t.workspaceId || undefined,
    title: t.title,
    process: t.process
  }
}
