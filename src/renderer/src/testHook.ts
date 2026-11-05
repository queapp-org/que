import type { Terminal } from '@xterm/xterm'
import { type ChimeKind, setChimePlayer } from './sound'

export interface PaneInfo {
  index: number
  /** The pane's terminal, or null while a view tab is selected. */
  activeTermId: string | null
  /** The selected tab: a terminal id or a view tab id (`view:diff:<path>`, `view:file:<path>`). */
  activeTab: string | null
  focused: boolean
}

export interface ReviewInfo {
  open: boolean
  /** The shown workspace's view, and the pull request open in it. */
  view: 'prs' | 'changes' | 'files'
  pr: number | null
  width: number
}

// Registry of the xterms currently on screen, by terminal id, read by the e2e test hook.
const mounted = new Map<string, Terminal>()

// Where the panes are, supplied by <Panes> while it is on screen.
let paneSource: (() => PaneInfo[]) | null = null

// The review pane's state, supplied by the app shell.
let reviewSource: (() => ReviewInfo) | null = null

export function setReviewSource(source: (() => ReviewInfo) | null): void {
  reviewSource = source
}

export function setActiveTerminal(id: string, term: Terminal): void {
  mounted.set(id, term)
}

export function clearActiveTerminal(term: Terminal): void {
  for (const [id, t] of mounted) if (t === term) mounted.delete(id)
}

export function setPaneSource(source: (() => PaneInfo[]) | null): void {
  paneSource = source
}

function textOf(term: Terminal): string {
  const buf = term.buffer.active
  const lines: string[] = []

  for (let i = 0; i < buf.length; i++) {
    lines.push(buf.getLine(i)?.translateToString(true) ?? '')
  }

  return lines.join('\n')
}

/** The middle of the first character of the last place `text` is on screen, in window coordinates. */
function pointOf(term: Terminal, text: string): { x: number; y: number } | null {
  const screen = term.element?.querySelector('.xterm-screen')?.getBoundingClientRect()

  if (!screen) return null
  const buf = term.buffer.active

  for (let row = term.rows - 1; row >= 0; row--) {
    const col =
      buf
        .getLine(buf.viewportY + row)
        ?.translateToString(true)
        .lastIndexOf(text) ?? -1

    if (col === -1) continue

    return {
      x: screen.left + ((col + 0.5) * screen.width) / term.cols,
      y: screen.top + ((row + 0.5) * screen.height) / term.rows
    }
  }

  return null
}

/**
 * Installs window.__que, only when the app was launched with QUE_E2E=1. Call
 * it before the store subscribes to daemon events: under e2e the chimes are
 * recorded, never played, so a test run stays silent.
 */
export function installTestHook(): void {
  if (window.que.app.e2e !== true) return
  const chimes: ChimeKind[] = []
  setChimePlayer({ play: (kind) => chimes.push(kind) })

  const screenTextOf = (termId: string): string => {
    const term = mounted.get(termId)

    return term ? textOf(term) : ''
  }

  // The focused pane's terminal, once it is attached.
  const activeTermId = (): string | null => {
    const focused = paneSource?.().find((p) => p.focused)

    return focused?.activeTermId && mounted.has(focused.activeTermId) ? focused.activeTermId : null
  }

  window.__que = {
    activeTermId,
    screenText: () => {
      const id = activeTermId()

      return id ? screenTextOf(id) : ''
    },
    panes: () => paneSource?.() ?? [],
    review: () => {
      const r = reviewSource?.() ?? { open: false, view: 'changes', pr: null, width: 0 }

      return { open: r.open, view: r.view, pr: r.pr, width: r.width }
    },
    screenTextOf,
    trayView: () => window.que.app.trayView(),
    cursorOf: (termId) => {
      const buf = mounted.get(termId)?.buffer.active

      return buf ? { col: buf.cursorX, row: buf.cursorY } : null
    },
    pointOf: (termId, text) => {
      const term = mounted.get(termId)

      return term ? pointOf(term, text) : null
    },
    chimes: () => [...chimes]
  }
}
