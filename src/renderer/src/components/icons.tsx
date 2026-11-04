// que's icons: 16px line drawings at a 1.5px stroke, in the current text
// colour, inline so the app needs no icon font or library. Each is decorative;
// the button around it carries the accessible name.
const base = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  focusable: false
} as const

/**
 * Claude Code's 8-bit character, 16×10, filled in its own colour (`.claude-code-mark`): the one
 * drawing here that is neither a line nor in the current text colour. docs/design.md "Accent and tones".
 */
export function ClaudeCodeIcon(): React.JSX.Element {
  return (
    <svg
      className="claude-code-mark"
      width={16}
      height={10}
      viewBox="1 0 16 10"
      focusable={false}
      aria-hidden="true"
    >
      <path d="M3 0h12v2H3zM3 2h2v2H3zM6 2h6v2H6zM13 2h2v2h-2zM1 4h16v2H1zM3 6h12v2H3zM4 8h1v2H4zM6 8h1v2H6zM11 8h1v2h-1zM13 8h1v2h-1z" />
    </svg>
  )
}

/** A folder: a project in the sidebar. */
export function FolderIcon(): React.JSX.Element {
  return (
    <svg {...base} aria-hidden="true" className="folder">
      <path d="M1.75 4.5a1 1 0 0 1 1-1h3.85l1.5 1.75h5.15a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z" />
    </svg>
  )
}

/** A page with a plus over a minus: the worktree's changes. */
export function ChangesIcon(): React.JSX.Element {
  return (
    <svg {...base} aria-hidden="true">
      <path d="M9.5 1.75h-5.75a1 1 0 0 0-1 1v10.5a1 1 0 0 0 1 1h8.5a1 1 0 0 0 1-1V5.5z" />
      <path d="M8 5.25v3.5M6.25 7h3.5M6.25 11.25h3.5" />
    </svg>
  )
}

/** A speech bubble: a pull request's comments. */
export function CommentIcon(): React.JSX.Element {
  return (
    <svg {...base} aria-hidden="true">
      <path d="M2.5 3h11v7.5H8l-3.5 2.75V10.5h-2z" />
    </svg>
  )
}

/** A folder with a plus on its bottom-right corner: add a repository. */
export function FolderPlusIcon(): React.JSX.Element {
  return (
    <svg {...base} aria-hidden="true">
      <path d="M1.75 4.5a1 1 0 0 1 1-1h3.85l1.5 1.75h5.15a1 1 0 0 1 1 1v1" />
      <path d="M1.75 4.5v8.25a1 1 0 0 0 1 1h5" />
      <path d="M12.25 9.25v5M9.75 11.75h5" />
    </svg>
  )
}

/** A magnifier: a circle and a short handle: search. */
export function SearchIcon(): React.JSX.Element {
  return (
    <svg {...base} aria-hidden="true">
      <circle cx="7" cy="7" r="4.25" />
      <path d="M10.25 10.25L13.5 13.5" />
    </svg>
  )
}

/** Three horizontal lines of decreasing length: sort. */
export function SortIcon(): React.JSX.Element {
  return (
    <svg {...base} aria-hidden="true">
      <path d="M2.5 4h11M2.5 8h7.5M2.5 12h4" />
    </svg>
  )
}

/** A rounded rectangle with a vertical line through the middle: split into two side by side. */
export function SplitBesideIcon(): React.JSX.Element {
  return (
    <svg {...base} aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M8 3v10" />
    </svg>
  )
}

/** Two chevrons pointing left: show the review pane. */
export function ChevronsLeftIcon(): React.JSX.Element {
  return (
    <svg {...base} aria-hidden="true">
      <path d="M7.75 4l-4 4 4 4M12.25 4l-4 4 4 4" />
    </svg>
  )
}

/** Two chevrons pointing right: hide the review pane. */
export function ChevronsRightIcon(): React.JSX.Element {
  return (
    <svg {...base} aria-hidden="true">
      <path d="M3.75 4l4 4-4 4M8.25 4l4 4-4 4" />
    </svg>
  )
}

/** A rounded rectangle with a horizontal line through the middle: split into two stacked. */
export function SplitBelowIcon(): React.JSX.Element {
  return (
    <svg {...base} aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M2 8h12" />
    </svg>
  )
}

/** The rectangle alone: join two panes back into one. */
export function JoinPanesIcon(): React.JSX.Element {
  return (
    <svg {...base} aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
    </svg>
  )
}

/** A plus: open or create one more of something. */
export function PlusIcon(): React.JSX.Element {
  return (
    <svg {...base} aria-hidden="true">
      <path d="M8 3.25v9.5M3.25 8h9.5" />
    </svg>
  )
}

/** A plus over a minus: a file's changes. */
export function DiffIcon(): React.JSX.Element {
  return (
    <svg {...base} aria-hidden="true">
      <path d="M8 2.5v6M5 5.5h6M5 12h6" />
    </svg>
  )
}

/** Two branches, one merging into the other: a pull request. */
export function PullRequestIcon(): React.JSX.Element {
  return (
    <svg {...base} aria-hidden="true">
      <circle cx="4.5" cy="3.75" r="1.5" />
      <circle cx="4.5" cy="12.25" r="1.5" />
      <circle cx="11.5" cy="12.25" r="1.5" />
      <path d="M4.5 5.25v5.5M11.5 10.75V6.25a1.5 1.5 0 0 0-1.5-1.5H7.5M9 3.25l-1.5 1.5L9 6.25" />
    </svg>
  )
}

/** A box with an arrow leaving its corner: open elsewhere. */
export function ExternalLinkIcon(): React.JSX.Element {
  return (
    <svg {...base} aria-hidden="true">
      <path d="M12.25 9v3.25a1 1 0 0 1-1 1h-7.5a1 1 0 0 1-1-1v-7.5a1 1 0 0 1 1-1H7" />
      <path d="M9.5 2.75h3.75v3.75M13.25 2.75 7.5 8.5" />
    </svg>
  )
}

/** Two overlapping rounded squares: copy to the clipboard. */
export function CopyIcon(): React.JSX.Element {
  return (
    <svg {...base} aria-hidden="true">
      <rect x="5.75" y="5.75" width="7.5" height="7.5" rx="1.25" />
      <path d="M10.25 3.75v-.5a1 1 0 0 0-1-1h-5.5a1 1 0 0 0-1 1v5.5a1 1 0 0 0 1 1h.5" />
    </svg>
  )
}

/** Two crossed lines: close. */
export function CloseIcon(): React.JSX.Element {
  return (
    <svg {...base} aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  )
}

/** An open circle with an arrowhead at its gap: refresh. */
export function RefreshIcon(): React.JSX.Element {
  return (
    <svg {...base} aria-hidden="true">
      <path d="M13 8a5 5 0 1 1-1.46-3.54" />
      <path d="M13 2.75v2.5h-2.5" />
    </svg>
  )
}

/** Two angle brackets: open the code in an editor. */
export function EditorIcon(): React.JSX.Element {
  return (
    <svg {...base} aria-hidden="true">
      <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" />
    </svg>
  )
}

/** A small angle pointing right, turned down while open: a directory in a tree. */
export function ChevronIcon({ open = false }: { open?: boolean }): React.JSX.Element {
  return (
    <svg {...base} aria-hidden="true" className={open ? 'chevron open' : 'chevron'}>
      <path d="M6.5 4.5 10 8l-3.5 3.5" />
    </svg>
  )
}

/** A chevron pointing up: the previous match. */
export function ChevronUpIcon(): React.JSX.Element {
  return (
    <svg {...base} aria-hidden="true">
      <path d="M4.5 10 8 6.5l3.5 3.5" />
    </svg>
  )
}

/** A chevron pointing down: the next match. */
export function ChevronDownIcon(): React.JSX.Element {
  return (
    <svg {...base} aria-hidden="true">
      <path d="M4.5 6.5 8 10l3.5-3.5" />
    </svg>
  )
}

/** A page with a folded corner: a file of the worktree. */
export function FileIcon(): React.JSX.Element {
  return (
    <svg {...base} aria-hidden="true">
      <path d="M9 2.25H4.75a1 1 0 0 0-1 1v9.5a1 1 0 0 0 1 1h6.5a1 1 0 0 0 1-1V5.5z" />
      <path d="M9 2.25V5.5h3.25" />
    </svg>
  )
}

/** A page with three lines of text, the last one short: the report. */
export function ReportIcon(): React.JSX.Element {
  return (
    <svg {...base} aria-hidden="true">
      <rect x="3" y="1.75" width="10" height="12.5" rx="1" />
      <path d="M5.5 5.25h5M5.5 8h5M5.5 10.75h3" />
    </svg>
  )
}

/** A ticket: a card with a notch out of each side and a perforation near its right end. */
export function TicketIcon(): React.JSX.Element {
  return (
    <svg {...base} aria-hidden="true">
      <path d="M1.75 3.75h12.5v2.75a1.5 1.5 0 0 0 0 3v2.75H1.75V9.5a1.5 1.5 0 0 0 0-3z" />
      <path d="M10.5 6v.25M10.5 7.875v.25M10.5 9.75V10" />
    </svg>
  )
}

/** A cog: six square teeth around a ring, and the hole at its centre: settings. */
export function GearIcon(): React.JSX.Element {
  return (
    <svg {...base} aria-hidden="true">
      <path d="M6.38 3.54L6.6 1.4A6.75 6.75 0 0 1 9.4 1.4L9.62 3.54A4.75 4.75 0 0 1 11.05 4.36L13.02 3.48A6.75 6.75 0 0 1 14.42 5.91L12.68 7.18A4.75 4.75 0 0 1 12.68 8.82L14.42 10.09A6.75 6.75 0 0 1 13.02 12.52L11.05 11.64A4.75 4.75 0 0 1 9.62 12.46L9.4 14.6A6.75 6.75 0 0 1 6.6 14.6L6.38 12.46A4.75 4.75 0 0 1 4.95 11.64L2.98 12.52A6.75 6.75 0 0 1 1.58 10.09L3.32 8.82A4.75 4.75 0 0 1 3.32 7.18L1.58 5.91A6.75 6.75 0 0 1 2.98 3.48L4.95 4.36A4.75 4.75 0 0 1 6.38 3.54Z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  )
}

/** An open padlock, its shackle lifted off the right side: unlocked during quiet hours. */
export function UnlockIcon(): React.JSX.Element {
  return (
    <svg {...base} aria-hidden="true">
      <rect x="3" y="7.25" width="10" height="6.5" rx="1" />
      <path d="M5.25 7.25V5a2.75 2.75 0 0 1 5.4-.75" />
    </svg>
  )
}

/**
 * que's mark: a ring with a stem down its right side from the equator, and a
 * dot in the accent. The numbers are the app icon's own (scripts/make-icon.mjs,
 * a 1024 canvas), the viewBox cropped square around the glyph, drawn at 18px.
 */
export function QMarkIcon(): React.JSX.Element {
  return (
    <svg
      {...base}
      width={18}
      height={18}
      viewBox="287 290 514 514"
      strokeWidth={64}
      aria-hidden="true"
    >
      <circle cx="482" cy="472" r="150" />
      <path d="M632 472V772" />
      <circle cx="742" cy="742" r="46" fill="var(--accent)" stroke="none" />
    </svg>
  )
}
