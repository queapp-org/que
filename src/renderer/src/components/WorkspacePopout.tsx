import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PullRequest, Workspace } from '../../../preload/index.d'
import {
  formatAge,
  formatSince,
  formatStepDuration,
  removalStepLabel
} from '../../../shared/format'
import { prBadge, statusBadge } from '../format'
import { useStore } from '../store'
import { useNow } from '../useNow'
import { useDismiss } from '../useDismiss'
import { useFloatingPlace } from '../useFloatingPlace'
import { firstFailingCheck, removalLines, tildePath } from '../workspace-popout'
import { CopyIcon, EditorIcon, ExternalLinkIcon } from './icons'
import PreparationSteps, { SetupLogButton } from './PreparationSteps'
import { LineCounts } from './ReviewParts'
import StepLines from './StepLines'

/** The open card: which workspace, and the row it hangs off. */
export interface PopoutAnchor {
  id: string
  row: HTMLElement
}

export interface Popout {
  open: PopoutAnchor | null
  /** The pointer came onto a row (or its card): open after the delay, or keep it open. */
  enter: (id: string, row: HTMLElement) => void
  /** The pointer left the row and the card: close after the delay. */
  leave: () => void
  /** A press on the row is not a rest: it cancels a pending open. */
  press: () => void
  /** Opens at once (⌘I). */
  show: (id: string, row: HTMLElement) => void
  close: () => void
}

/**
 * When the workspace card is open: after the pointer rests on a row for the store's open
 * delay, until it has been off both the row and the card for the close delay. Nothing opens
 * while `enabled` is false, and an open card closes.
 */
export function usePopout(enabled: boolean): Popout {
  const store = useStore()
  const [open, setOpen] = useState<PopoutAnchor | null>(null)
  const current = useRef<PopoutAnchor | null>(null)
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelOpen = useCallback((): void => {
    if (openTimer.current !== null) clearTimeout(openTimer.current)
    openTimer.current = null
  }, [])

  const cancelClose = useCallback((): void => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current)
    closeTimer.current = null
  }, [])

  const set = useCallback(
    (next: PopoutAnchor | null): void => {
      cancelOpen()
      cancelClose()
      current.current = next
      setOpen(next)
    },
    [cancelOpen, cancelClose]
  )

  const close = useCallback((): void => set(null), [set])

  const show = useCallback(
    (id: string, row: HTMLElement): void => {
      if (enabled) set({ id, row })
    },
    [enabled, set]
  )

  const enter = useCallback(
    (id: string, row: HTMLElement): void => {
      if (!enabled) return

      if (current.current?.id === id) {
        cancelClose()

        return
      }

      cancelOpen()
      openTimer.current = setTimeout(() => set({ id, row }), store.popoutDelays().open)
    },
    [enabled, store, set, cancelOpen, cancelClose]
  )

  const leave = useCallback((): void => {
    cancelOpen()

    if (current.current === null || closeTimer.current !== null) return
    closeTimer.current = setTimeout(close, store.popoutDelays().close)
  }, [store, close, cancelOpen])

  // Quiet hours lock the app: the card closes and its timers stop.
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- closing also clears the timers, which live outside React
    if (!enabled) close()
  }, [enabled, close])

  useEffect(
    () => () => {
      cancelOpen()
      cancelClose()
    },
    [cancelOpen, cancelClose]
  )

  return { open, enter, leave, press: cancelOpen, show, close }
}

/** Beside the row, 10px right of it, its top 10px above the row's. */
const PLACEMENT = { gap: 10, align: 'top', rise: 10 } as const

function PullRequestRow({ ws, pr }: { ws: Workspace; pr: PullRequest }): React.JSX.Element {
  const { tone, text } = prBadge(pr)
  const failing = firstFailingCheck(pr)
  const id = `sidebar-workspace-${ws.id}-popout-pr-${pr.number}`

  return (
    <li className="workspace-popout-pr" data-testid={id}>
      <span className="pr-head">
        <span className="pr-number">#{pr.number}</span>{' '}
        <span className={`pr-state tone-${tone}`} data-testid={`${id}-state`} data-tone={tone}>
          {text}
        </span>
      </span>
      <span className="pr-diff" data-testid={`${id}-diff`}>
        {pr.additions !== null && pr.deletions !== null && (
          <LineCounts adds={pr.additions} dels={pr.deletions} />
        )}
      </span>
      <a
        className="popout-icon popout-link"
        href={pr.url}
        target="_blank"
        rel="noreferrer"
        aria-label={`Open pull request #${pr.number}`}
        title={`Open pull request #${pr.number}`}
        data-testid={`${id}-link`}
      >
        <ExternalLinkIcon />
      </a>
      <span className="popout-pr-title" data-testid={`${id}-title`}>
        {pr.title}
      </span>
      {failing && (
        <span className="pr-failing" data-testid={`${id}-failing`}>
          ✕ {failing}
        </span>
      )}
    </li>
  )
}

/**
 * The card beside a sidebar workspace row: the name, the worktree and its branch, the status,
 * the shells, monitors and subagents running in the background (or, while it is being
 * removed, where the removal stands), where its preparation stands while one runs or a step of
 * it failed, and every pull request opened from it. It holds no destructive action; Remove… stays in the row's ⋯ menu. Escape or a press
 * outside the row and the card closes it.
 */
export default function WorkspacePopout({
  ws,
  row,
  onClose
}: {
  ws: Workspace
  /** The row it hangs off: its top lines up with the row's, beside it. */
  row: HTMLElement
  onClose: () => void
}): React.JSX.Element {
  const store = useStore()
  // Everything here reads in minutes; the clock of a step running now ticks on its own.
  const now = useNow()
  const ref = useRef<HTMLElement>(null)
  const [home, setHome] = useState<string | null>(null)

  const rowRef = useMemo(() => ({ current: row }), [row])
  // Placed before paint, kept inside the window: a row near the bottom lifts the card until
  // it fits.
  const place = useFloatingPlace(ref, rowRef, PLACEMENT, [ws])

  useEffect(() => {
    let live = true
    store
      .homedir()
      .then((h) => live && setHome(h))
      .catch(() => {})

    return () => {
      live = false
    }
  }, [store])

  useDismiss(onClose, ref, rowRef)

  const id = `sidebar-workspace-${ws.id}-popout`
  const status = statusBadge(ws.status)
  const copy = (text: string): void => void navigator.clipboard.writeText(text).catch(() => {})

  return (
    <section
      ref={ref}
      className="floating-card workspace-popout"
      aria-label={ws.title ?? ws.name}
      data-testid={id}
      style={place ?? undefined}
    >
      <h3 className="popout-name">{ws.title ?? ws.name}</h3>
      <span className="label">Worktree</span>
      <div className="popout-line popout-path">
        <span className="popout-text" data-testid={`${id}-path`} title={ws.path}>
          <bdi>{tildePath(ws.path, home)}</bdi>
        </span>
        <button
          type="button"
          className="ghost icon popout-icon on-hover"
          aria-label="Copy path"
          title="Copy path"
          data-testid={`${id}-copy-path`}
          onClick={() => copy(ws.path)}
        >
          <CopyIcon />
        </button>
        <button
          type="button"
          className="ghost icon popout-icon far"
          aria-label="Open in editor"
          title="Open in editor"
          data-testid={`${id}-open-editor`}
          onClick={() => void store.openInEditor(ws.path)}
        >
          <EditorIcon />
        </button>
      </div>
      <div className="popout-line popout-branch">
        <span className="popout-text" data-testid={`${id}-branch`}>
          <span className="word">branch</span> {ws.branch}
        </span>
        <button
          type="button"
          className="ghost icon popout-icon on-hover"
          aria-label="Copy branch"
          title="Copy branch"
          data-testid={`${id}-copy-branch`}
          onClick={() => copy(ws.branch)}
        >
          <CopyIcon />
        </button>
      </div>
      <div className="popout-status" data-testid={`${id}-status`} data-status={ws.status}>
        <span className={`status-dot tone-${status.tone}`} aria-hidden="true" />
        {status.label}
        {ws.statusReason && (
          <>
            {' '}
            <span className="reason" data-testid={`${id}-reason`}>
              {ws.statusReason}
            </span>
          </>
        )}{' '}
        {formatSince(Date.parse(ws.statusAt), now)}
        {ws.lastActivityAt && ` · last activity ${formatAge(ws.lastActivityAt, now, ' ago')}`}
      </div>
      {ws.backgroundTasks.length > 0 && (
        <>
          <span className="label">Background</span>
          <ul className="popout-tasks" data-testid={`${id}-background`}>
            {ws.backgroundTasks.map((t, i) => (
              <li key={t.id} className="popout-task" data-testid={`${id}-background-${i}`}>
                <span className="task-kind">{t.kind}</span>
                <span className="task-text" title={t.description}>
                  {t.description}
                </span>
                <span className="task-age">{formatAge(t.since, now, '')}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {ws.removal && (
        <>
          <span className="label">Removing</span>
          <StepLines
            testId={`${id}-removal`}
            lines={removalLines(ws.removal)}
            label={removalStepLabel}
            took={formatStepDuration}
            since={ws.removal.since}
          />
        </>
      )}
      {ws.preparation && !ws.removal && (
        <>
          <span className="label">Preparing</span>
          <PreparationSteps
            preparation={ws.preparation}
            brief={ws.brief}
            testId={`${id}-preparation`}
          />
          <SetupLogButton ws={ws} testId={`${id}-setup-log`} />
        </>
      )}
      <hr />
      <span className="label">Pull requests</span>
      {ws.prs.length === 0 ? (
        <p className="popout-empty" data-testid={`${id}-no-pr`}>
          no pull request
        </p>
      ) : (
        <ul className="popout-prs">
          {ws.prs.map((pr) => (
            <PullRequestRow key={pr.url} ws={ws} pr={pr} />
          ))}
        </ul>
      )}
    </section>
  )
}
