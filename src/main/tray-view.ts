// What the menu-bar item says, as a pure function of the daemon's rows, the quiet state and the
// clock; tray.ts draws it. docs/design.md "Menu bar".
import { summarize } from '../daemon/status-engine'
import { type CountItem, countItemText } from '../shared/count-line'
import { finishedUnseen } from '../shared/finished'
import { formatMinSec } from '../shared/format'
import type { QuietState, TrayView, Workspace } from '../shared/types'

export function trayView(
  workspaces: ReadonlyArray<Pick<Workspace, 'status' | 'finishedAt' | 'seenAt'>>,
  quiet: Pick<QuietState, 'inQuietHours' | 'unlockedUntil' | 'locked'> | null,
  now: number
): TrayView {
  const locked = quiet?.locked ?? false
  const unlockedUntil = quiet?.inQuietHours ? quiet.unlockedUntil : null
  const s = summarize(workspaces)
  const finished = workspaces.filter(finishedUnseen).length

  const items: CountItem[] = locked
    ? [
        { count: s.working, label: 'running' },
        { count: s.stuck, label: 'stuck' }
      ]
    : [
        { count: s.working, label: 'working' },
        { count: s.needs_input, label: 'needs input' },
        { count: s.stuck, label: 'stuck' },
        { count: finished, label: 'finished' }
      ]

  return {
    mark: markOf(s.working > 0, locked ? s.stuck > 0 : s.needs_input + s.stuck + finished > 0),
    title: unlockedUntil ? formatMinSec(Date.parse(unlockedUntil) - now) : '',
    counts: items.flatMap((item) => (item.count > 0 ? [countItemText(item)] : []))
  }
}

/** Working wins: while anything works the mark says only that, and the menu's counts carry the rest. */
function markOf(working: boolean, needsYou: boolean): TrayView['mark'] {
  if (working) return 'working'

  return needsYou ? 'attention' : 'none'
}

/** What the menu's rows do. */
export interface TrayActions {
  show: () => void
  quit: () => void
  unlock: () => void
  lock: () => void
  /** Starts a manual quiet window of `minutes`. */
  start: (minutes: number) => void
  /** Ends a manual quiet window. */
  end: () => void
}

/** The rows of the menu a click opens: the counts, Open que, the quiet controls, Quit que. No sessions. */
export function trayMenu(
  view: TrayView,
  quiet: QuietState | null,
  actions: TrayActions
): Electron.MenuItemConstructorOptions[] {
  const counts: Electron.MenuItemConstructorOptions[] = view.counts.map((label) => ({
    label,
    enabled: false
  }))

  return [
    ...(counts.length > 0 ? [...counts, { type: 'separator' as const }] : []),
    { label: 'Open que', click: actions.show },
    ...quietItems(quiet, actions),
    { type: 'separator' },
    { label: 'Quit que', click: actions.quit }
  ]
}

// In a window: End quiet (a manual one only) over Unlock or Lock now.
// Outside one: the three ways to go quiet now.
function quietItems(
  quiet: QuietState | null,
  actions: TrayActions
): Electron.MenuItemConstructorOptions[] {
  if (!quiet?.inQuietHours) {
    return [
      {
        label: 'Go quiet',
        submenu: [
          { label: '30 min', click: () => actions.start(30) },
          { label: '1 hour', click: () => actions.start(60) },
          { label: '2 hours', click: () => actions.start(120) }
        ]
      }
    ]
  }

  return [
    ...(quiet.kind === 'manual' ? [{ label: 'End quiet', click: actions.end }] : []),
    quiet.unlockedUntil
      ? { label: 'Lock now', click: actions.lock }
      : { label: `Unlock ${quiet.unlockMinutes} min`, click: actions.unlock }
  ]
}
