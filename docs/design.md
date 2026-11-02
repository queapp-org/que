# Design

que is a tool you look at all day and glance at all night, so it is drawn like a
technical drawing: black and dark grey surfaces, hairline borders, dashed guide
lines between regions, small mono labels in brackets, and one cool accent.
Nothing shouts, and nothing is tinted: the greys are neutral. Status is a dot and
a word, not a coloured block.

The tokens live in `src/renderer/src/styles.css` under `:root`. Components use
them; nothing sets a colour, font, or radius inline.

## Surfaces

| Token             | Value     | Use                                            |
| ----------------- | --------- | ---------------------------------------------- |
| `--bg-side`       | `#111111` | The sidebar, the review pane, the quiet board. |
| `--bg`            | `#181818` | The main area, the terminal, windows.          |
| `--bg-input`      | `#0e0e0e` | Text fields.                                   |
| `--bg-raised`     | `#202020` | Buttons, menus, dialogs, banners.              |
| `--bg-hover`      | `#262626` | Hover on rows, buttons, menu items.            |
| `--bg-active`     | `#2c2c2c` | The selected row; scrollbar thumbs.            |
| `--border`        | `#272727` | Hairlines and dashed guides.                   |
| `--border-strong` | `#363636` | Menus, dialogs, hovered buttons.               |

Surfaces step up by one token per layer: the sidebar is darker than the main
area, raised things (menus, dialogs) sit one step above it. Regions are divided
by a 1px hairline; the tab row uses the dashed
guide (`--dash`, 6px on, 6px off) instead, so the eye reads them as sections of
one drawing rather than separate panels. The sidebar's foot (the Quiet row and the icon strip) is pinned to
the window's bottom edge above a solid hairline.

## Text

| Token            | Value     | Use                                                  |
| ---------------- | --------- | ---------------------------------------------------- |
| `--fg`           | `#eeeeee` | Names, titles, the selected row, anything primary.   |
| `--fg-secondary` | `#c9c9c9` | Rows at rest, buttons, menu items.                   |
| `--fg-muted`     | `#9b9b9b` | Hints, form labels, totals, the branch.              |
| `--fg-faint`     | `#6f6f6f` | Section labels, paths, counts, breadcrumbs, empties. |

Body text is the system sans at 13px. Anything that is a label, an identifier,
or a measurement is mono at 10–11px: section labels, branch names, paths,
counts, short ids, costs, the unlock countdown. Section labels are uppercase,
letter-spaced, and bracketed (`[ PROJECTS ]`), drawn with `::before`/`::after`
so the DOM keeps the plain word.

## Accent and tones

| Token              | Value     | Use                                                                                                                                                |
| ------------------ | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--accent`         | `#3fcdb4` | Links, the active tab's underline, focus rings, the cursor, the unlock countdown, the working mark (sidebar and quiet board).                      |
| `--accent-hover`   | `#6adcc7` | The accent under the pointer.                                                                                                                      |
| `--inverse`        | `#e6e6e6` | The one primary button on a screen, light on dark.                                                                                                 |
| `--tone-busy`      | `#4f8cf5` | working, preparing, as a still dot or badge: status badges, the popout, the report. The sidebar and the quiet board draw the working mark instead. |
| `--tone-attention` | `#f99c00` | needs input; a Claude usage window at 80% and over.                                                                                                |
| `--tone-bad`       | `#fb2c36` | stuck, exited badly; the danger button; a Claude usage window at 100%.                                                                             |
| `--tone-good`      | `#34c26b` | idle after work: a sidebar row that finished since you last looked at it.                                                                          |
| `--tone-neutral`   | `#7a7a7a` | idle; the working mark while a workspace is being removed (sidebar and card).                                                                      |
| `--tone-muted`     | `#5a5a5a` | exited.                                                                                                                                            |

The accent is a teal, apart in hue from both the done green and the working
blue, and it is used sparingly, so it keeps meaning "this is the thing" (the
active tab, a link, the cursor, an unlock while it runs). It is the same colour
in the mark (the icon's dot), the UI and the quiet board. Status is a tone,
never the accent, with one exception: the working mark, drawn by the sidebar and
the quiet board (see Sidebar), since teal already marks the live thing. A status
badge (`.status.tone-*`) is a 5px dot and a mono word, tinted at 12% with a
32% border of its tone. It never fills with colour: at a glance the dot tells
the story, and a wall of filled pills is exactly the noise que exists to
remove. The quiet board uses the same tones on a dot or a word, never a badge.

## Syntax

The diff tabs colour code by what each piece is (the daemon names the kind of every
token). The palette deliberately matches a familiar dark editor's, so code reads the
way it does where it was written; that it overlaps the accent and the diff tones is
intended, and these tokens are used for code and nothing else.

| Token             | Value     | Use                                                     |
| ----------------- | --------- | ------------------------------------------------------- |
| `--syn-decl`      | `#569cd6` | Declarations: `const`, `function`, `class`, `async`.    |
| `--syn-ctrl`      | `#c586c0` | Control keywords: `if`, `return`, `await`, `import`.    |
| `--syn-fn`        | `#dcdcaa` | Function names.                                         |
| `--syn-type`      | `#4ec9b0` | Types and classes.                                      |
| `--syn-str`       | `#ce9178` | Strings.                                                |
| `--syn-num`       | `#b5cea8` | Numbers.                                                |
| `--syn-var`       | `#9cdcfe` | Variables and properties.                               |
| `--syn-comment`   | `#6a9955` | Comments.                                               |
| `--syn-text`      | `#d4d4d4` | Plain text and punctuation; a file with no language.    |
| `--syn-bracket-1` | `#ffd700` | Brackets by depth: the outermost, then every third one. |
| `--syn-bracket-2` | `#da70d6` | One level in.                                           |
| `--syn-bracket-3` | `#179fff` | Two levels in; the fourth level is gold again.          |

Each token is a span with a class per kind (`tok-decl`, `tok-str`, …), a bracket
`tok-b1`/`tok-b2`/`tok-b3`.

## Shapes

- Corners are nearly square: 2px on buttons, inputs, dialogs and fieldsets; 4px
  (`--radius`) on rows and menus. Nothing is a pill except the status dot.
- Borders are 1px. Shadows appear only under things that float (menus, dialogs).
- Dialogs carry four small corner points, the marks of a drawing's frame.
- Icons are 16px line drawings at a 1.5px stroke, inline SVG from
  `components/icons.tsx`, drawn in the current text colour: faint in a ghost
  button, bright on hover. The button carries the accessible name. No icon
  font or library. `button.icon` is 22px square; `button.icon.sm` is the 18px one
  for a row's own controls. A refresh icon turns, bright, while its work runs (one
  turn in 0.8s) and finishes the turn it is on when the work ends; under reduced
  motion it holds bright instead.
- Two panes are divided by a 7px track like the sidebar's: invisible until hover,
  focus or drag, then a 1px accent line. The focused pane's tab strip carries a
  1px accent line at its top; with one pane there is none.
- The review pane is a full-height column at the right of the window, the sidebar's
  mirror: it runs from the window's top edge to the bottom on `--bg-side` behind a 1px
  hairline, and the tab row spans only the middle column. It is 320px wide, dragged
  between 240 and 520px on a 7px track like the sidebar's (double-click resets, arrow
  keys move it), and remembered. Two chevrons are its toggle, both `button.ghost.icon`
  line icons: open, a double chevron pointing right (»), at the right end of the pane's
  strip, hides it ("Hide review (⌘B)"); ⌘B toggles it too.
- Hidden, the pane folds to a 40px rail for a workspace (the Sessions view has none):
  the same `--bg-side` column behind its hairline, full height. Its top, in the 40px
  strip row above a solid hairline, holds a double chevron pointing left («, "Show
  review (⌘B)") and drags the window from its empty space; under it the three view icons
  stack, each with its count under it in mono 11px `--fg-faint`. A view icon opens the
  pane on that view. The resize track exists only while the pane is open.
- The pane's strip is 40px tall, lined up with the tab row above a solid hairline. At
  its left, lined up with the session tabs, three `button.ghost.icon`s pick the view:
  pull requests (a branch-merge line icon), changes (a page with ±) and files (a
  folder). Pull requests and changes carry a count in mono 11px `--fg-faint` beside the
  icon (the open and draft pull requests; the changed files); never a dot, since a
  failure shows inside the pane and in the workspace popout. Each icon's name is its
  tooltip and accessible name. The current one reads `--fg` with a 1px `--fg` line under
  it, the others `--fg-faint`. The view's own buttons sit at the strip's right end, then
  the hide chevron: refresh on every view (on Pull requests it checks them with GitHub
  now) and open in editor. The pane remembers its view per workspace. Each view opens with
  a head: its `[ LABEL ]` at the left, its counts in mono `--fg-faint` at the right.
- Pull requests lists every pull request the session opened (#192): `[ PULL REQUESTS ]`
  with `n open · k failing` (only `k failing` in `--tone-bad`), then one two-line row
  each. Line one: the dot, `#n` in mono `--fg-muted`, the title on one line with an
  ellipsis, and the comment count with a line icon at the right, `--fg` while there are
  comments since the pull request was last opened (remembered in the app), else
  `--fg-faint` (the daemon counts them; nothing shows until it has). Line two in mono 11px `--fg-faint`: `into <base>` (or `#n` when the base
  is another of the session's pull requests), the checks (`✓ 7/7` good, `✗ <first
  failing> · 6/7` bad, `running 4/7` busy, skipped runs left out), `+a −d` in the diff
  tones, and `· subagent` when its branch is none this worktree checked out. A draft's
  dot is a hollow ring, an open one takes the checks' tone, a merged or closed one
  `--tone-muted`. Open and draft come first, newest first, every row aligned (no indent
  for a stack; `into #n` is its only sign); then a dashed rule, `[ MERGED · CLOSED ]`,
  and those rows with their number and title in `--fg-faint`. With none: `No pull
  requests from this session yet.`, centred. There is no button to open a pull
  request and no "checked … ago" in the pane: sessions open their own pull requests.
- A row opens its pull request in place; the strip's left end becomes `‹ #188`, the
  back link. The title at 14px 600, then in mono `● open · #188 ↗ · into <base>` (the
  number is the link, in `--accent`). Three sections follow in this order, each folding at
  its head (a chevron and `[ CHANGES ]`, the fold kept for every pull request this session), dashed rules
  between: `[ CHANGES ]` with `+a −d · n · vs <base>`, the pull request's own committed
  files against its base, rows like Changes; `[ CHECKS ]` with `k failing · m passing`,
  the failing runs first (dot, name, source dim, duration, a link on hover), then the
  running and skipped ones, the passing ones folded into one mono line (`n passing · their
  names`) that expands (then just `n passing`); `[ COMMENTS ]` with `n · <review
  decision>`, then the conversation oldest first, each review with its own state. A line comment's `path:line →` (in
  `--accent`) opens the diff at that line.
- Changes is `[ CHANGES ]` with `+a −d · n files` (the worktree against its base,
  uncommitted included), then one mono `--fg-faint` line: `commits n ▾ · vs base ▾ · k
  uncommitted`. Each of its first two parts opens a menu: `commits n` lists the commits,
  newest first with their age, and narrows the files to one (the line then reads
  `commit <sha>`, its subject in the tooltip), and `vs base` picks the ref to compare
  against, remembered per workspace; the current choice is marked with the active fill.
  A row is the glyph, the path, `+a −d` in the diff tones; an uncommitted file carries
  a 5px `--tone-attention` dot after its name. Files where only comments changed come
  after the others, under one line in mono 11px `--fg-faint` lined up with the paths:
  `comments only · 2 files · +10 −3` (their totals). It has no bracketed head, no dashed
  rule and no hint, the head's totals stay whole, and the rows under it look like any
  other; a pull request's files group the same way. Their diffs open dimmed.
- Clicking a file in Changes opens that file's diff as a tab in the middle, in the
  focused pane's strip beside the session tabs: a line icon and the file's name, never a
  status dot, closed with ⌘W like a terminal tab. A file inside a pull request opens the
  same way as a tab of its own (its id carries the branch and base, so it never collides
  with the Changes diff of the path), headed `#188 vs #187`, the pull request's line comments
  under their lines on `--bg-side` behind a `--border-strong` hairline; the line a
  comment asked for carries a 2px `--accent` edge, and a fold that hid it opens.
- A diff tab opens with a 36px toolbar above a `--border` hairline, mono 11px
  `--fg-faint`: the path in `--fg` (`from → path` for a rename; at least 120px, its folders
  cut from their start with an ellipsis so the file's name stays whole, the full path its
  tooltip), `+a` in `--tone-good`,
  `−d` in `--tone-bad`, and for a pull request's diff `#188 vs <base>`; at its right a
  segmented `Unified | Split`, a `Wrap` toggle (on by default) and a `Whitespace` toggle
  (on: whitespace is ignored).
  These are mono 11px buttons behind a 1px `--border` at a 2px radius, the chosen one
  `--fg` on `--bg-raised`; every choice is remembered for every tab. When the pane is too
  narrow for both, the controls drop to a second line of the toolbar rather than clip
  the path. The lines are mono
  12px/18px on `--bg-input`, never a raw diff header: the old line number and the new
  one (44px each, right-aligned, `--fg-faint`), the sign (18px, `+` or `−`), then the
  code in its syntax colours. With Wrap on, a long line wraps inside its own column, its
  continuation lines under its code and its number and sign on its first line, so the area
  scrolls only up and down (a split row is as tall as its taller side); with it off, the
  whole area scrolls both ways. An added line takes
  `--tone-good` at 12% behind it, a removed one `--tone-bad`, its numbers and sign tinted
  toward the tone; within a changed pair the words that changed carry the tone at 30%
  with a 2px radius. When the diff carries the whole file, a run of more than 8
  unchanged lines folds, leaving 3 lines beside each change: a 26px row on `--bg-side`
  between hairlines, mono 11px `--fg-faint`, with `↑ 20` and `↓ 20` (`--fg-muted`, only
  the sides that touch a change) and `n unchanged lines`, which opens the whole run, then
  the enclosing function in `--fg-muted` when there is one. Without the whole file, the
  lines between hunks are the same row without buttons. What a tab unfolds stays unfolded
  while it is open. Split puts old at the left and new at the right in two equal columns
  divided by a `--border` hairline (number 44px, sign 16px, code): a removed line beside
  the added line it became, a hatch of `--bg-raised` where a side has nothing, context on
  both; folds and comments span both. A binary file reads `Binary file.`, one over the
  size cap `Too large to show.`
- A changed line that is only a comment (the daemon marks it) is drawn dimmed by default,
  so the code changes are what the eye lands on: no green or red behind it, its code in
  its own syntax colours at 50% opacity, a 2px `--border-strong` edge at its left, its sign
  and numbers leaning only 35% toward the tone, no word marks, and a removed one struck
  through. When a file has comment lines, the toolbar splits its counts, `+2 −1 code · +7
  −2 comments` (the code counts in the diff tones, the comment ones `--fg-faint`), leaving
  out a part or a side that is zero (a file of comments alone reads `+2 comments`), and a
  `Comments dimmed ▾` button (`shown`, `folded`) joins the tools, drawn like them and
  pressed while its menu is open. The menu is the app's menu (`--bg-raised`, a 1px
  `--border-strong`, the shadow, `--radius`) in mono 12px: a bracketed head, `[ COMMENT
  CHANGES · 8 LINES ]`, then Dim (`default`), Show (`as code`) and Fold (`one row each`),
  each hint in `--fg-faint` at the right and the current one on the active fill; a
  hairline; and a checkbox item, **Always show removed comments** (a ✓ while on, which it
  is by default). The choice is remembered per project. Show draws comment lines like
  code. Fold turns each run of consecutive comment lines in a change into one 20px row with
  the same faint left edge: its line range where the numbers go (the new file's, or the
  old one's for removed lines) and, mono 11px `--fg-faint` lined up with the code, `▸ 3
  comment lines added` (`removed`, or `changed` for a mix), which opens the run in place
  (`▾`) and folds it again. A change made only of comment lines, between two unchanged
  runs, folds into the unchanged-lines row around it, which then reads `18 unchanged lines
  · ▸ comment-only change: 1 removed, 4 added`; the second part shows the change. While
  Always show removed comments is on, removed comment lines never fold: they stay dimmed
  and struck, tagged at their right end with `COMMENT REMOVED` in mono 10px
  `--tone-attention`. In a pull request's diff a run holding a line a review comment points
  at stays open, its row reading `▾ comment lines · opened for a review comment`, and a
  `path:line →` link into a folded run opens it the same way. In Split a run's row spans
  both sides.
- Files is `[ FILES ]` with `n · m changed`, then a filter field: mono 12px on
  `--bg-input` behind a 1px `--border`, `--accent` on focus, ⌘F while the pane has focus.
  It narrows the tree to the matching paths with their folders open, `n matches · ⏎
  opens` at its right end; Enter opens the first match, Escape clears it. Below it the
  worktree is a tree: directories first, then files, each sorted without regard to case,
  12px of indent per level, a chevron on each directory that turns while it is open, and
  a directory holding only another directory folded into one row (`src/renderer/src`).
  A file Changes lists carries its glyph and reads `--fg`, an unchanged one `--fg-muted`,
  a deleted one `--fg-faint`; a directory reads `--fg-secondary` and counts the changed
  files beneath it at its right end in mono `--fg-faint`. Directories with changes start
  open, the rest closed; after that the user's clicks stand for the session. A changed
  file opens its diff tab; an unchanged one opens a read-only file tab the same way (a
  page icon and the name): the path in mono `--fg-faint` above the text in mono 12px
  with faint line numbers, unwrapped, scrolling both ways. Nothing replaces or hides
  the terminals.
- Row actions (the ⋯ button) show on hover, focus, or while their menu is open.
- The window has no native title bar. The traffic lights sit in the 40px strip
  above the sidebar's content; that strip, the tab row's empty space and the review
  pane strip's empty space (or the rail's top) drag the window (every button in them is
  excluded).
- The sidebar's divider drags between 180 and 520px, double-click resets it, and
  the arrow keys move it when it has focus; the width is remembered.
- Search is an icon in the title strip (`button.ghost.icon`, a magnifier), in line
  with the window buttons at the strip's right end; it takes `--accent` while the
  field is open. Click or ⌘K pops out a field in the first row: a mono 12px input on
  `--bg-raised` with a 1px `--border` (`--accent` on focus). Escape, or leaving it
  empty, folds it away and clears the narrowing; text keeps it open. The Projects head
  carries a sort toggle (`button.ghost.icon`, three lines of decreasing length)
  between name and last activity; the choice is remembered.
- There is no top bar. The main column's first row is the tab strip, 40px tall like
  the sidebar's title strip and the review pane's bar, so one line runs across the
  window, with the dashed guide under it. With two panes beside each other each pane
  has its strip in that row; split below, the second pane's strip sits under the first
  pane. At the right end of the top-right strip (the second pane's beside, the first's
  below) sit split beside and split below, or join while split, both `button.ghost.icon`;
  the Sessions view has the same row. The review pane's toggle is its own chevrons. The `+` after the last tab is always visible; a tab's × waits at
  opacity 0 until the tab is under the pointer, holds the keyboard focus, or is the
  active one, so the tab keeps its width. A tab reads the program running in it (`claude`,
  `zsh`, `node`), the terminal's name standing in until the daemon knows; an exited
  terminal keeps its last program, read in `--fg-faint`, with no badge; `reattached` is
  a small mono badge. A tab's tooltip is its folder, the title its program set, and the
  first four characters of its id, one to a line. The workspace's name lives in the
  sidebar's selected row alone, its status in the row's dot, and the error line sits above the row.

## Sidebar

The sidebar is a list you glance at: a dot per row, a word only when asked, controls
only under the pointer.

- **The rail.** `.sidebar` is padded `40px 6px 0`. Every row is 26px tall with a
  `0 8px` inset and `--radius`; section heads are 24px with the same inset. Each row
  starts with a 16px icon column and a 6px gap, so every name sits on one rail, 36px
  from the edge, and the dots line up under the folders. A project head carries a
  folder (`--fg-faint`) and its name in sans 12px 500 `--fg-muted` (`--fg-secondary`
  under the pointer); a session carries `›_` in mono; a workspace carries its dot.
- **The dot.** A workspace row is a 5px dot in its tone and the name, nothing else:
  the tone is the workspace status. A workspace that is working shows the working mark
  instead: four 3px `--accent` dots on a 2×2 grid at a 5px pitch, with a
  diagonal ripple across them (the top-left first, the top-right and bottom-left 120ms
  later, the bottom-right 120ms after that; each grows over 0.36s, holds 0.3s, shrinks
  over 0.36s, in a 1.2s loop, so the mark is never empty). It is a CSS animation, no
  timers, and under `prefers-reduced-motion` the four dots stand still at full size.
  This is the one way status takes the accent, so `--tone-busy` never appears in the
  sidebar, and the quiet board draws the same mark on its working rows (see Quiet
  board). An idle row with a shell or monitor still running in the background shows
  `›_` in mono 11px `--fg-faint` at its right end (the session glyph: something is
  still running there); the overlay under the pointer covers it, and a working row
  never shows it, since the ripple already says so.
- **Being removed.** A workspace keeps its row until the daemon has removed it. Its
  mark is the working mark drawn in `--tone-neutral` (the one other place the mark
  appears, and the one time it is not the accent: the ripple says something is moving,
  the grey says it is not a session), its name reads `--fg-faint`, and it is never
  painted as unseen. Where `›_` would sit, always shown, is the step it is on with its
  verb and a clock since the step started: `killing terminals 1s`, `running teardown
  12s`, `removing worktree 0s`, `deleting branch 0s`, mono 11px `--fg-faint` with
  tabular numbers, ticking every second; the name gives way with its ellipsis before the
  word does. Under the pointer the overlay shows the same word and no ⋯; the row cannot
  be selected and has no menu, but its card still opens. The quiet board leaves it out.
- **The weight of a name.** `--fg` when the row needs you (finished since you last
  looked, needs input, or stuck); `--fg-secondary` while it works; `--fg-faint` once you have
  looked and nothing is new, and the same faint for an exited workspace, told apart by
  its `--tone-muted` dot. The selected row reads `--fg` on `--bg-active` whatever its
  state. Most rows sit faint most of the time; the few that need you are two steps
  brighter.
- **Finished, not looked at.** A workspace whose turn ended (working to idle) since the app last had it selected in a focused window shows the done
  tone, `--tone-good` (the tone table's "idle after work"), on its dot and its name at
  `--fg`. Selecting it returns it to its own dot and the faint weight. Needs input and
  stuck keep their tones: orange and red already mean "now", green means "fresh". A
  collapsed project head counts these before its total, `1 done · 3`, the `done` in
  `--tone-good`; otherwise it shows its count alone, mono 11px `--fg-faint`. The daemon
  keeps the two timestamps (`finishedAt`, `seenAt`); the quiet board ignores the state.
- **Under the pointer** (and on keyboard focus, and while the row's menu is open) a
  row shows an overlay at its right end, painted on the row's own hover background:
  the status word in mono 11px `--fg-faint` (its tone for needs input and stuck), then
  ⋯. For a fresh finish the word is the age, `done · 12m ago`. An idle row with background work names its kinds,
  `idle · shell`, `idle · monitor`, or `idle · shell · monitor`. The overlay covers the end of a long name rather
  than reflowing it, so nothing jumps. A project head under the pointer turns its
  folder into its chevron and shows `+` and ⋯, which stay at opacity 0 until the head
  is under the pointer, holds the keyboard focus, or has its menu open; the section
  heads' buttons (Sessions `+`, Projects add and sort) always show, since the two heads
  are the way in. Clicking anywhere on a project head folds it. An exited session reads faint, with `exited` as its word.
- **The card.** When the pointer rests on a workspace row for 500ms (or on ⌘I for the
  selected one) a 340px card opens beside it, over the main area, its top level with the
  row's: `--bg-raised`, a 1px `--border-strong`, `--radius` and the menu's shadow. It
  replaces the row's tooltip, stays while the pointer is on the row or the card, and
  closes 150ms after it leaves both, on Escape, on a press elsewhere, and when the row's
  ⋯ menu opens; never on a session row, and not while quiet hours lock the app. It holds
  the name (sans 13px 600 `--fg`, wrapping); `[ WORKTREE ]`, then the path in mono 12px
  `--fg-secondary` (`~` for home, clipped from the left) and `branch <name>` in mono 11px
  (as are the status and background lines), the word `--fg-faint`; the status line in
  `--fg-faint` (the dot in its tone, the word, a reason, `since HH:MM`, the last
  activity); while anything runs in the background, `[ BACKGROUND ]` and a line per task:
  the kind in `--fg-faint`, the description in `--fg-secondary`, and its age at the right
  (a working row lists its subagents here); while the workspace is being removed (the
  status line reads `removing`, and there is no background, since its terminals are gone),
  `[ REMOVING ]` and a line per step it runs, mono 11px, the dot in an 8px column so the
  dots and the mark line up: a done step's filled `--tone-muted` dot, its words in
  `--fg-faint` and its time at the right (`0.1s`, `12s`); a failed step's `--tone-bad` dot,
  its words in `--fg-secondary` and the reason at the right in `--tone-bad`; the step
  running now with the working mark in `--tone-neutral`, its words in `--fg-secondary` and
  its clock at the right, ticking each second; a step still to come with a hollow dot (a
  1px `--tone-muted` ring), its words in `--fg-faint` and nothing at the right; a hairline;
  and `[ PULL REQUESTS ]`, newest
  first: `#n` in `--fg-secondary`, the state in its tone, `+added −removed` in
  `--tone-good` and `--tone-bad` at the right, then the title in sans 12px
  `--fg-secondary` over at most two lines and a failing check's name in `--fg-faint`
  (`no pull request` when there is none). The copy icons (path, branch) sit right after
  their text and wait for the pointer on their line; the editor icon at the path's far end
  and each pull request's link in its 18px column always show, the link `--accent` under
  the pointer. Every action sits on the line it belongs to, and the card never holds a
  destructive one: Remove… stays in the ⋯ menu.
- **The foot.** Above a solid hairline, two rows: the Quiet row, then a 36px icon strip.
  The Quiet row starts a manual quiet: the word Quiet in `--fg-muted` starts an hour, and
  right after it (6px on) `30m`, `1h` and `2h` in mono 11px tabular pick a length, `1h` in
  `--fg-muted` as the default and the other two in `--fg-faint`, each `--fg` under the
  pointer. The four are a `role="group"` of buttons, as wide as they are, so the group
  takes `--bg-hover` as a whole and the word brightens with it; it is absent while a quiet
  window is in progress. A 20px control sits at the Quiet row's right end, so it never
  pushes the icons around: the 5px status dot in `--accent` and one word in 11px
  `--fg-muted`, hairline-bordered, `--fg` under the pointer, its tooltip saying why it is
  there. It has two states and shows one at a time. Restart, while the background service
  runs an older build than the app: it hands every terminal to this build, reads
  Restarting… at 0.4 opacity while that runs, and a failed restart goes to the error line
  above the tab strip. Update, while the service runs this build and a newer release is
  published: it opens the release's download page, since an unsigned build cannot install
  itself, and stays until the update is taken; there is no dismiss. When both hold, Restart
  shows, because it can be done now, and Update follows once the service is current. With
  neither, the control is absent. During an unlock the unlock row takes the Quiet row's
  place: the open lock at 12px and `m:ss left` in mono 11px `--accent`, and `lock now` in
  mono 11px `--fg-faint` at its right end (`--fg-muted` under the pointer), always visible:
  locking again is the behaviour we want. The row is a `role="status"` region, and Restart
  or Update, when one is waiting, sits after `lock now`. The strip holds three `button.ghost.icon`s: Report (a
  page with lines), Tickets (a ticket outline, the open tickets counted beside it in mono
  11px `--fg-faint`) and Settings (a gear), in `--fg-faint`, `--fg` under the pointer. Each
  icon's name is its tooltip and accessible name. The view open in the main area reads
  `--fg` with a 1px `--fg` line under it, like the review pane's strip. The strip's right
  end shows the Claude plan's usage, one button reading `5h 42%  wk 18%` in mono 11px
  tabular, the labels `--fg-faint` and the numbers `--fg-muted`, 10px between the pairs;
  under the pointer and while its card is open the numbers read `--fg` and the labels
  `--fg-muted` on `--bg-hover` (2px radius). A number takes `--tone-attention` at 80% and
  `--tone-bad` at 100%, where it is followed by the time until that window resets in
  `--fg-faint` (`5h 100% · 38m`). A window without a reading shows `—`; before any reading
  it reads `5h —  wk —` in `--fg-faint`, its tooltip saying it fills in after a session's
  first reply, on plans with usage limits. Its accessible name reads the numbers out
  (`Claude usage: 5-hour 42%, weekly 18%`). A click opens the usage card just right of the
  sidebar, its bottom edge level with the strip's, drawn like the workspace card (340px,
  `--bg-raised`, 1px `--border-strong`, `--radius`, the menu's shadow), in mono 11px:
  `[ CLAUDE USAGE ]`; a line per window, `5-hour` and `weekly` in a 64px `--fg-faint`
  column, the percent in `--fg` (or its tone), and at the right in `--fg-faint`
  `resets 16:20 · in 2h 10m` (ticking each minute) or `resets Mon 09:00`, with a 2px meter
  under it lined up with the percent (track `--border`, fill `--fg-muted` or the tone, as
  wide as the percent, up to full); a hairline; and `as of 14:08 · <workspace>`, the name in
  `--fg-muted` when it is known. It closes on Escape, a press elsewhere, or a second click.
  Usage is not in the tray and not on the quiet board.

## Quiet board

The quiet board is the only window during quiet hours, and its one question is
"running and not stuck?". It answers from across the room without pulling you
in, so nothing on it may read as a message or a call to action: no sentences,
no large type, no filled badges, no emoji. It is a dim instrument panel on
`--bg-side` with the four corner points (3px, `--fg-faint`): a 24px strip with
the q mark at 18px (`--fg-muted`, its dot and the working mark the board's
only uses of the accent), the `[ QUIET HOURS ]` label and the clock in mono
`--fg-muted` with `· until HH:MM` faint; one faint mono count line
(`.count-line`) that lists only the non-zero counts, where only `stuck` takes a
tone (`--tone-bad`) and `running` reads `--fg-muted`; 30px dot rows
(`.dot-row`) one notch dimmer than the sidebar, the name in `--fg-secondary`
and everything else in mono `--fg-faint`; a working row draws the working mark in
place of its dot, the same four rippling accent dots as the sidebar, so "still happening"
reads the same across the room as in the rail: it is the board's one moving
thing, and stands still under `prefers-reduced-motion`; an idle row whose
session still has a shell or monitor running shows the sidebar's `›_` after
its state word, the kinds in its tooltip; and a footer holding
only the Unlock button, the one control, drawn not to tempt: a word and the
open-lock icon in the same mono `--fg-faint`, no border and no fill, with a
`--border` hairline and `--fg-muted` only under the pointer. The window end
appears once, as `until HH:MM` in the strip.
Needs input is not a night state: it reads `waiting`, faint, with a neutral
dot, and the locked tray title leaves its count out (`● 3 ✕ 0`).
A manual quiet (`que quiet start`, or the tray's `Quiet for …`) shows the same
board with plainer words, since it need not be night: the label reads `[ QUIET ]`
and the list `Running` instead of `Running tonight`, and an `End quiet` button
sits beside Unlock, drawn the same way. Those two buttons stay the board's only
controls. The board window and the tray
tooltip read `que · quiet`.
The board is frameless and drags by its strip, its count line and its
margins; the list of rows opts out of the drag region, since a draggable area
swallows pointer events, the wheel included, and the list must scroll when it
is taller than the window.

## Report

The report is the morning page (what the sessions did, what needs a look) and
reads in the quiet board's language: a left-aligned 720px column;
`since 19:00 yesterday` in the topbar in mono `--fg-faint` beside a refresh
icon; one count line with only the non-zero items (`3 sessions · 1 stuck · 1
needs input · 2 PRs open · worked 2h 10m`, or `nothing ran since 19:00`), built
by the same function as the morning notification so both say the same words; a
faint unlocks line (`2 unlocks · 23:40 for 20 min · 01:12 for 11 min`) when
there were any; then the bracketed `Workspaces` label over 30px dot rows, one
per workspace, those waiting for input first, then stuck, then working. Each
row reads its name, its project, its state, its pull request and its facts
(`worked 1h 12m · asked for input 2× · 3 ahead`). Unlike the board, needs
input keeps its tone in the morning, since that is when it is acted on; still
one tone per row, on the dot and the state, never a filled block, and a
working row keeps a still `--tone-busy` dot, since the report is read after
the fact. The pull request is a mono `--accent` link that reads `#67 draft`
(`· checks failing` when they are), never its URL.

## Adding something

Pick the surface by layer, the text colour by role, and the tone by meaning.
If a new element needs a colour that is not a token, the design is probably
wrong rather than the palette. Check the screenshots the e2e specs leave in
`test-results/` after `npm run e2e`.
