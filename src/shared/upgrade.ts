// Updating the daemon in place: the running daemon hands every live terminal
// to a successor started from the given bundle (daemon.handoff), which then
// serves the socket. Both `que daemon upgrade` and the app's Restart control go
// through here. A failure is an answer, not a throw, and handOffFailedText
// puts what it means into words for both.
import { DaemonClient, DaemonError, resolveDaemonScript, resolveRuntime } from './client'
import { errorMessage } from './errors.decode'
import type { QuePaths } from './paths'
import { delay } from './process'
import { ErrorCodes, type HandoffResult } from './protocol'

export interface HandOffOptions {
  /** The daemon bundle the successor runs; default: the one of this que. */
  script?: string
  /** The program that runs it as Node; default: the one of this que. */
  runtime?: string
}

export interface HandOffFailure {
  ok: false
  /** Why, as a short clause: the daemon's own message when it refused. */
  reason: string
  /** No successor answered in time (the handoff itself was not refused). */
  timedOut: boolean
}

export type HandOffOutcome =
  | {
      ok: true
      /** The daemon that handed over. */
      oldPid: number
      /** The successor, now serving the socket. */
      pid: number
      /** Live terminals it serves. */
      terminals: number
    }
  | HandOffFailure

/** How long to wait for a successor when the old daemon's connection dropped before its answer. */
const SUCCESSOR_TIMEOUT_MS = 10_000

/** What a daemon from before the handoff answers to it, in words. */
export const TOO_OLD_TO_HAND_OFF = 'the running service is too old to update in place'

/** Asks the daemon on `c` to hand over to a daemon from `opts`, and says who serves `paths` now. */
export async function handOffDaemon(
  c: DaemonClient,
  paths: QuePaths,
  opts: HandOffOptions = {}
): Promise<HandOffOutcome> {
  let oldPid: number
  let result: HandoffResult | null

  try {
    oldPid = (await c.request('daemon.ping')).pid
    result = await c
      .request('daemon.handoff', {
        script: opts.script ?? resolveDaemonScript(),
        runtime: opts.runtime ?? resolveRuntime()
      })
      .catch((err: Error) => {
        // The old daemon may exit before its answer arrives; the new pid tells.
        if (err instanceof DaemonError && err.code === 'disconnected') return null

        throw err
      })
  } catch (err) {
    const tooOld = err instanceof DaemonError && err.code === ErrorCodes.UnknownMethod

    return { ok: false, reason: tooOld ? TOO_OLD_TO_HAND_OFF : errorMessage(err), timedOut: false }
  }

  // The daemon answers only once its successor serves the socket, so the answer is the outcome.
  if (result) return { ok: true, oldPid, pid: result.pid, terminals: result.terminals }

  const next = await successor(paths, oldPid, SUCCESSOR_TIMEOUT_MS)

  if (!next) {
    return {
      ok: false,
      reason: `no new service answered within ${SUCCESSOR_TIMEOUT_MS / 1000} seconds`,
      timedOut: true
    }
  }

  return { ok: true, oldPid, ...next }
}

/**
 * What a failed hand-off means and what to do next, in lower case: the CLI
 * prints it after `que: `, the app capitalises it on its error line.
 */
export function handOffFailedText(outcome: HandOffFailure, paths: QuePaths): string {
  if (outcome.timedOut) {
    return `${outcome.reason} after the handoff; see the service log at ${paths.daemonLog}`
  }

  return `the handoff failed: ${outcome.reason}. Nothing changed: the previous build keeps serving every terminal, and que daemon restart would end them and start this build`
}

/** Polls the socket until a daemon other than `oldPid` answers; null after `timeoutMs`. */
async function successor(
  paths: QuePaths,
  oldPid: number,
  timeoutMs: number
): Promise<{ pid: number; terminals: number } | null> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const c = await DaemonClient.tryConnect(paths)

    if (c) {
      try {
        const { pid } = await c.request('daemon.ping')

        if (pid !== oldPid) {
          const terms = await c.request('term.list')

          return { pid, terminals: terms.filter((t) => t.alive).length }
        }
      } catch {
        // Between daemons; try again.
      } finally {
        c.close()
      }
    }

    await delay(100)
  }

  return null
}
