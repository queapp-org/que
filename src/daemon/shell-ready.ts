// When a terminal's shell can take a typed command. Until its line editor
// starts, the tty echoes what is typed and the editor then draws it again, so
// the command shows twice. Line editors turn the tty's ECHO flag off as they
// take over, so ECHO being off is exactly what showing a command once needs, in
// any shell and with no change to the user's config.
//
// The flag is read through the terminal's tty path. Passing the pty master to
// stty would work, but libuv on darwin clears O_NONBLOCK on every fd it hands a
// child, and the flag belongs to the open file the daemon goes on using: the
// first poll would leave the master blocking for the rest of its life.
import { run } from '../shared/exec'
import { ttyOf } from './foreground'

const STTY = '/bin/stty'
const STTY_TIMEOUT_MS = 2000
const POLL_MS = 50
export const SHELL_WAIT_MS = 10_000

/**
 * How a wait ended: the shell is ready, it took too long (a shell with no line
 * editor never turns ECHO off), or the caller stopped it.
 */
export type ShellWait = 'ready' | 'timeout' | 'stopped'

export interface ShellWaitOptions {
  /** Whether the shell can take a command now; polls never overlap. */
  probe: () => Promise<boolean>
  /** True once there is nothing to wait for any more. */
  stopped: () => boolean
  intervalMs?: number
  timeoutMs?: number
}

/** Polls until the shell is ready, the timeout passes, or the caller stops it. */
export async function waitForShell(o: ShellWaitOptions): Promise<ShellWait> {
  const deadline = Date.now() + (o.timeoutMs ?? SHELL_WAIT_MS)

  while (!o.stopped()) {
    if (await o.probe()) return 'ready'

    if (Date.now() >= deadline) return 'timeout'

    await new Promise((resolve) => setTimeout(resolve, o.intervalMs ?? POLL_MS).unref())
  }

  return 'stopped'
}

/** Whether `stty -a` output has ECHO off: `-echo` as a word of its own, not `-echonl` or `-echoprt`. */
export function echoIsOff(sttyOutput: string): boolean {
  return /(^|\s)-echo(;|\s|$)/.test(sttyOutput)
}

/** A probe of the ECHO flag on the tty of the terminal whose shell is `pid`. */
export function echoOffProbe(pid: number): () => Promise<boolean> {
  let tty: string | null = null

  return async () => {
    // A shell that has only just been spawned may not have its tty yet.
    tty ??= await ttyOf(pid)

    if (!tty) return false

    const r = await run(STTY, ['-f', `/dev/${tty}`, '-a'], { timeoutMs: STTY_TIMEOUT_MS })

    return r.ok && echoIsOff(r.stdout)
  }
}
