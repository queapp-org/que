// How a sidebar row reads at rest and under the pointer: the dot (or the working
// mark), its tone, the weight of the name, the background mark or the removal step, and the status word. Pure rules over the
// workspace; Sidebar.tsx draws them. docs/design.md "Sidebar".
import type { Workspace } from '../../preload/index.d'
import { formatAge, preparationStepLabel, removalStepLabel } from '../../shared/format'
import {
  type PreparationFailure,
  preparationFailure,
  preparationStep
} from '../../shared/preparation'
import { removalStep } from '../../shared/removal'
import { statusBadge, type Tone } from './format'

/** The name's text colour: `--fg` when it needs you, `--fg-secondary` while working, else `--fg-faint`. */
export type Weight = 'fg' | 'secondary' | 'faint'

export interface RowTone {
  /** What the row reports as `data-status`: the workspace's status. */
  status: string
  /** The dot's tone. */
  tone: Tone
  /** The working mark (four rippling accent dots) instead of the dot. */
  working: boolean
  /**
   * Being removed: the working mark in the neutral tone instead of the dot, the step word
   * always shown at the row's right end, and nothing to open or act on.
   */
  removing: boolean
  /**
   * Being prepared: the working mark in the neutral tone and the step word always shown, as
   * while being removed, but it opens like any row.
   */
  preparing: boolean
  /** The preparation step that failed, while the row is stuck on it: shown with its reason. */
  failed: PreparationFailure | null
  /** Finished since the app last had it selected. */
  unseen: boolean
  weight: Weight
  /**
   * The distinct kinds running in the background, in the daemon's order, while the row is idle;
   * else none. The engine leaves only shells and monitors on an idle row, so
   * idle with background work is the whole rule. Non-empty draws `›_` at the row's right end.
   */
  background: string[]
}

/**
 * Whether a workspace has something new to look at: it finished (a turn ended) since the app last had it selected in a focused window. True when `finishedAt` is
 * later than `seenAt` (or it finished and was never seen).
 */
export function unseenDone(ws: Pick<Workspace, 'finishedAt' | 'seenAt'>): boolean {
  const finished = ws.finishedAt ? Date.parse(ws.finishedAt) : Number.NaN

  if (!Number.isFinite(finished)) return false
  const seen = ws.seenAt ? Date.parse(ws.seenAt) : Number.NaN

  return !Number.isFinite(seen) || finished > seen
}

/**
 * The distinct kinds still running in the background of an idle workspace, in the daemon's
 * order; none unless idle. The engine leaves only shells and monitors on an idle row, so idle
 * with background work is the whole rule. Non-empty draws `›_`, on the sidebar and the board.
 */
export function backgroundKinds(ws: Pick<Workspace, 'status' | 'backgroundTasks'>): string[] {
  return ws.status === 'idle' ? [...new Set(ws.backgroundTasks.map((t) => t.kind))] : []
}

/** Statuses that already mean "now": a fresh finish does not paint over them. */
const URGENT: ReadonlySet<string> = new Set(['working', 'needs_input', 'stuck'])

/** The failed preparation step a stuck row is stuck on; a session moving it on leaves that to the card. */
function stuckOnPreparation(
  ws: Pick<Workspace, 'status' | 'statusReason' | 'preparation'>
): PreparationFailure | null {
  if (ws.status !== 'stuck' || !ws.preparation) return null

  return ws.statusReason === 'preparation_failed' || ws.statusReason === 'setup_failed'
    ? preparationFailure(ws.preparation)
    : null
}

/**
 * The row's look: the workspace's status, green with its name at full strength while it
 * finished unseen. The selected row is looked at, so never unseen, and always reads `--fg`.
 */
export function rowTone(ws: Workspace, selected = false): RowTone {
  const removing = ws.status === 'removing'
  const unseen = !selected && !removing && !URGENT.has(ws.status) && unseenDone(ws)
  const working = ws.status === 'working'

  return {
    status: ws.status,
    tone: unseen ? 'good' : statusBadge(ws.status).tone,
    working,
    removing,
    preparing: ws.status === 'preparing',
    failed: stuckOnPreparation(ws),
    unseen,
    weight: removing
      ? 'faint'
      : nameWeight(
          selected || unseen || ws.status === 'needs_input' || ws.status === 'stuck',
          working
        ),
    background: backgroundKinds(ws)
  }
}

function nameWeight(needsYou: boolean, working: boolean): Weight {
  if (needsYou) return 'fg'

  return working ? 'secondary' : 'faint'
}

/** The word under the pointer, and its tone when it takes one (needs input, stuck). */
export interface HoverWord {
  word: string
  tone: Tone | null
}

/**
 * A removing workspace's step and how long it has run: `running teardown 12s`; `removing` once
 * every step has run (or before the daemon says which).
 */
export function removalWord(ws: Pick<Workspace, 'removal'>, now: number): string {
  const step = ws.removal ? removalStep(ws.removal) : null

  if (!step) return 'removing'

  return `${removalStepLabel(step)} ${formatAge(ws.removal?.since ?? null, now)}`
}

/**
 * A preparing workspace's step and how long it has run: `running setup 12s`; `preparing` for one
 * with no steps (a workspace.create whose setup runs).
 */
export function preparationWord(ws: Pick<Workspace, 'preparation'>, now: number): string {
  const step = ws.preparation ? preparationStep(ws.preparation) : null

  if (!step) return 'preparing'

  return `${preparationStepLabel(step)} ${formatAge(ws.preparation?.since ?? null, now)}`
}

/** A failed preparation step and why: `creating worktree failed: unknown base ref v9`. */
export function preparationFailedText(failure: PreparationFailure): string {
  return `${preparationStepLabel(failure.step)} failed: ${failure.error}`
}

export function hoverWord(ws: Workspace, look: RowTone, now: number): HoverWord {
  if (look.removing) return { word: removalWord(ws, now), tone: null }

  if (look.failed) return { word: `${preparationStepLabel(look.failed.step)} failed`, tone: 'bad' }

  if (look.preparing) return { word: preparationWord(ws, now), tone: null }

  const toned = look.tone === 'attention' || look.tone === 'bad' ? look.tone : null

  if (look.unseen) return { word: `done · ${formatAge(ws.finishedAt, now, ' ago')}`, tone: null }

  if (look.background.length > 0) {
    return { word: ['idle', ...look.background].join(' · '), tone: null }
  }

  return { word: statusBadge(ws.status).label, tone: toned }
}
