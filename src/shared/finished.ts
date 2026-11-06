// Whether a workspace finished since the app last looked: one rule for the sidebar's green dot
// and the menu bar's `finished` count. Pure, no Node imports.
import type { Workspace } from './types'

/** Statuses that already mean "now": a fresh finish does not paint over them. */
const URGENT: ReadonlySet<string> = new Set(['working', 'needs_input', 'stuck'])

/**
 * Whether a workspace has something new to look at: it finished (a turn ended) since the app last had it selected in a focused window. True when `finishedAt` is
 * later than `seenAt` (or it finished and was never seen).
 */
function unseenDone(ws: Pick<Workspace, 'finishedAt' | 'seenAt'>): boolean {
  const finished = ws.finishedAt ? Date.parse(ws.finishedAt) : Number.NaN

  if (!Number.isFinite(finished)) return false
  const seen = ws.seenAt ? Date.parse(ws.seenAt) : Number.NaN

  return !Number.isFinite(seen) || finished > seen
}

/** A finish that reads as one: unseen, on a row neither being removed nor already urgent. */
export function finishedUnseen(ws: Pick<Workspace, 'status' | 'finishedAt' | 'seenAt'>): boolean {
  return ws.status !== 'removing' && !URGENT.has(ws.status) && unseenDone(ws)
}
