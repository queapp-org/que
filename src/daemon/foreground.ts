// What a terminal reports about itself beyond its screen: the title its program
// last set and the name of the program in its foreground.
//
// The foreground program is found in two steps. A cheap native call on the
// master fd (tcgetpgrp + sysctl) names it as the kernel does, and is read on
// every title change and once a second; when that raw name changes, `ps` on the
// terminal's tty finds the foreground group's leader and its argv[0], the name
// a terminal app shows (the kernel's name can be a versioned file the launcher
// symlink points at).
import { basename } from 'node:path'
import { run } from '../shared/exec'
import type { TermInfo } from '../shared/protocol'
import type { TerminalMirror } from './mirror'
import { foregroundProcess } from './pty-fd'

const POLL_MS = 1000
const PS = '/bin/ps'
const PS_TIMEOUT_MS = 5000

/**
 * The display name of the foreground process group's leader, from the output
 * of `ps -ww -t <tty> -o pid=,pgid=,ucomm=,comm=`: the row whose pid is its
 * pgid and whose ucomm is the raw name, by the basename of its comm, without
 * the leading `-` of a login shell. Null when no row matches.
 */
export function foregroundName(psOutput: string, raw: string): string | null {
  for (const line of psOutput.split('\n')) {
    // ucomm may hold spaces, so it is matched as the raw name rather than split off.
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)

    if (!m || m[1] !== m[2] || !m[3].startsWith(raw)) continue
    const comm = m[3].slice(raw.length)

    if (!/^\s/.test(comm)) continue
    const base = basename(comm.trim())
    const name = base.startsWith('-') ? base.slice(1) : base

    if (name) return name
  }

  return null
}

/** The terminal whose facts are kept. */
export interface FactsSource {
  /** The shell's pid, to find the terminal's tty. */
  pid: number
  masterFd: number
  alive: () => boolean
  /** Its screen mirror, which sees the titles the program sets. */
  mirror: TerminalMirror
  /** Called after title or process changed. */
  onChange: () => void
}

/** The title and foreground program of one terminal, kept current while it lives. */
export class TerminalFacts {
  title: string | undefined
  process: string | undefined
  /** The kernel's name the current process name was resolved for. */
  private raw: string | undefined
  private tty: Promise<string | null> | undefined
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly source: FactsSource,
    carried: Pick<TermInfo, 'title' | 'process'> = {}
  ) {
    this.title = carried.title || undefined
    this.process = carried.process || undefined
    source.mirror.onTitleChange((title) => this.titleChanged(title))
  }

  /** Starts the once-a-second poll and reads the foreground program now. */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.check(), POLL_MS)
    this.timer.unref()
    this.check()
  }

  /** The terminal ended: polling stops, the last process name stays. */
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** The program set a title (OSC 0 or 2); empty clears it. */
  private titleChanged(title: string): void {
    const next = title || undefined

    if (next !== this.title) {
      this.title = next
      this.source.onChange()
    }

    // The program that just wrote the title is the one in the foreground.
    this.check()
  }

  private check(): void {
    if (!this.timer || !this.source.alive()) return
    const raw = foregroundProcess(this.source.masterFd)

    if (!raw || raw === this.raw) return
    this.raw = raw
    void this.resolve(raw)
  }

  /** The latest raw name wins: a resolve the name moved past publishes nothing. */
  private async resolve(raw: string): Promise<void> {
    const name = await this.displayName(raw)

    if (!this.timer || raw !== this.raw || name === this.process) return
    this.process = name
    this.source.onChange()
  }

  private async displayName(raw: string): Promise<string> {
    const tty = await (this.tty ??= ttyOf(this.source.pid))

    if (!tty) return raw

    const r = await run(PS, ['-ww', '-t', tty, '-o', 'pid=,pgid=,ucomm=,comm='], {
      timeoutMs: PS_TIMEOUT_MS
    })

    return (r.ok && foregroundName(r.stdout, raw)) || raw
  }
}

/** The terminal's tty (`ttys016`) by its shell's pid; null when it has none (`??`). */
export async function ttyOf(pid: number): Promise<string | null> {
  const r = await run(PS, ['-o', 'tty=', '-p', String(pid)], { timeoutMs: PS_TIMEOUT_MS })
  const name = r.ok ? r.stdout.trim() : ''

  return name && !name.startsWith('?') ? name : null
}
