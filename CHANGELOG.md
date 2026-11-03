# Changelog

All notable changes to que are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and que uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Settings has an Updates section: the version you are running, a Check for updates button that asks GitHub right away, and its answer: up to date, a newer release with a Download button, or that it couldn't check. Builds made by `npm run package` or `npm run install:local`, and runs from source, say they don't check for releases.
- An app left open keeps looking for new releases, so one shows up within about seven hours with no relaunch. Before, que asked only at launch, and at most once a day. `QUE_UPDATE_CHECK=0` turns these automatic checks off; the button still asks when clicked.

### Changed

- Releases are signed with a Developer ID and notarized by Apple, so macOS opens a downloaded que with its usual prompt. Before, macOS refused to open them and could report them as damaged.
- que moved to [github.com/queapp-org/que](https://github.com/queapp-org/que). The old `rquellh/que` and `que-agents/que` addresses redirect, so 0.2.0 keeps finding updates.
- The banner saying a newer release is available is gone. The control at the right end of the Quiet row now has two states: Update when a newer release is published, which opens its download page, and Restart (formerly Update) when the background service runs an older build than the app. Restart shows while both hold. Builds made by `npm run package` or `npm run install:local`, and runs from source, never check for releases.
- The README is now a short landing page that points to [queapp.org](https://queapp.org) for download, the guides and the CLI and configuration references; the notes on running que from source moved to `DEVELOPING.md`.

### Fixed

- Pull request checks lag less on busy repositories. The poll's listing of a repository's recent pull requests no longer asks for their checks, which made it time out; checks are asked only for the open and draft pull requests your workspaces hold. When that listing fails anyway, each workspace is still checked in the same poll instead of waiting for the next one.
- A Claude session started in a loose terminal (the sidebar's Sessions) now comes back after a restart or a crash, as workspace sessions do: a new loose terminal opens in the folder where the session started, even if you changed directory after opening the terminal, and picks the session up with `claude --resume`. While quiet hours are locked it waits for the unlock, and a session whose folder has since been deleted is skipped. This covers loose terminals opened after the update; loose sessions still show no status.
- A daemon started from inside a que terminal no longer passes that terminal's workspace, socket, instructions file, permission mode or claude wrapper state on to the terminals it opens, so its sessions get only their own repo's instructions and permission mode.
- An app newer than its background service no longer opens to a blank window. It reads the previous build's workspaces with defaults for the fields that build does not send, so every row, card and pull request draws and Restart shows. If a part of the window still cannot be drawn, that part shows an error line in its place while the rest stays up, Restart included, and it draws again once the service restarts, without relaunching the app.

- When the home path is too long for a unix socket, the socket moved to `/tmp/que-<uid>/daemon.sock` for every such home, so two daemons with different long homes shared one socket. Each home now gets its own, `/tmp/que-<uid>/<hash of the home>.sock`, and `que daemon status` and `que doctor` say when the socket has moved.
- A launch with no network no longer hides a newer release que already knew about, or blocks the next check for the whole interval. A failed check keeps what it knew and tries again within the hour.
- `git add` and `git commit` in a workspace fail far less often with `index.lock: File exists` while que shows that workspace, because the background service's `git status` no longer takes the lock.
- Removing a workspace whose worktree holds an Electron app now deletes all of it. A `.asar` file made the background delete fail, so the folder stayed in `<worktree_root>/.trash` and the background service logged the same failure at every start. Folders already stuck there go the next time the service starts.

## [0.2.0] - 2026-10-28

The first published release of que: Claude Code sessions in git worktrees, terminals that outlive the app, and quiet hours that keep you out of them when you need focus. Builds are unsigned for now; the README has the first-launch steps. 0.1.0 was only built locally, so everything since it is listed here.

### Added

- Refresh on the review pane's Pull requests list checks each pull request with GitHub at once instead of waiting for the next poll; inside a pull request it also fetches the conversation and files again. The icon turns while it works, a failed check shows gh's message under the list's head, and refreshes started together from the app and the CLI share one check. `que ws pr <workspace> --refresh` checks with GitHub too.
- `teardown_timeout_seconds` (default 60): how long a repo's teardown hook may run when a workspace is removed before it is killed and recorded as timed out.
- While a workspace is being removed, its card lists the removal's steps under `[ REMOVING ]`: each finished step with how long it took or why it failed, the one running now with a clock that ticks each second, and those still to come.
- The daemon watches the worktree of every workspace a window shows (`workspace.watch`, `workspace.unwatch`) or has an attached terminal in, and sends `workspace.changed` when its files, index or commits change, at most once per 300 ms.
- `workspace.files` lists a worktree's tracked and untracked files, `workspace.readFile` reads one of them (text capped, binary detected, never outside the worktree), and `que ws files <workspace>` prints the listing; `--json`.
- A Files tab in the review pane: the workspace's files as a tree, changed files marked as in Changes and their directories open with a count; a changed file opens its diff, any other file opens read-only as a tab beside the terminals.
- `workspace.diff` takes a `base` to compare against and a `commit` to narrow the files to that commit's own changes, and returns the branch's commits and the refs worth comparing against.
- `que ws diff --base <ref>` and `--commit <sha>`; the text output lists the branch's commits with their age.
- Two menus in the Changes header: `Commits n` lists the branch's commits and narrows the files to one commit's changes, and `vs base` compares against another branch, remembered per workspace.
- `que ws pr <workspace>`: a workspace's pull request with each check (state, workflow, how long it took) and its conversation, comments, reviews and line comments oldest first; `--json` and `--refresh`.
- The daemon keeps every check run behind a pull request's checks, so a finished check updates the workspace, and answers `workspace.prThread` with the conversation, cached until the pull request changes.
- A review pane at the right of the window with two tabs: Changes, the files a workspace changed, each opening its diff as a tab beside the terminals; and Pull request, its checks and conversation. Drag to resize; the pane and its tab are remembered.
- Tickets know their epic: the queue groups tickets under their epics, a started ticket's brief carries the epic's overview, and `que tickets list` prints the tree.
- Filter the sidebar with `⌘K`: sessions, projects and workspaces narrow as you type, and so does the tickets list; sort projects by name or last activity from the Projects head.
- A Changes view for a workspace: what it changed against its base, file by file with the patch, committed and uncommitted, read-only.
- `que ws diff <workspace>` and `workspace.diff`: what a workspace changed against its base, committed and uncommitted, file by file with patches.
- Split a workspace's terminals in two: ⌘D beside, ⌘⇧D below, ⌘⌥ arrows to move between panes, or use the split and join buttons in the top bar; drag the divider; the layout is remembered and both panes reattach after a relaunch.
- A Tickets view in the app: the tickets assigned to you, Start on each (asking which project the first time), and the workspace it made; the start prompt and the sync filter are in Settings.
- The tickets view groups tickets under their epics, with subtasks beneath theirs; epics are overviews and have no Start.
- A ticket queue: `que tickets` lists the tickets assigned to you from the tracker, `que tickets start KEY` makes a workspace for one under its project (learned the first time you choose), writes the ticket as a brief and starts claude on it.
- `npm run install:local` builds que from your checkout, replaces `/Applications/que.app`, links the `que` command and reopens the app, leaving the background service and every terminal running.
- The daemon reports the build it runs (`buildId` in `daemon.ping`); `que daemon status` and `que doctor` show it beside the build this que would start and say when they differ.
- When the background service runs an older build than the app, an Update control appears beside Settings in the sidebar. It hands every terminal to the new build and keeps them all running; if that is refused, the service keeps serving as it was and the error line says why. `que daemon restart` stops it and starts the current build, ending every terminal.
- The window says when it is reconnecting to the background service, and comes back on the same workspace with its terminals reattached, or a fresh shell where they ended.
- Claude sessions come back after the background service restarts: each workspace terminal that had a live session reopens and resumes it where it left off. Sessions Claude ended and terminals you closed stay closed, and during locked quiet hours they wait for the unlock.
- `que daemon upgrade` swaps in the newly installed background service without ending any terminal: shells, their screens and scrollback move to the new daemon under the same ids, and if the new one cannot start, the running one keeps serving them. `que daemon status` and `que doctor` recommend it before `que daemon restart`.
- The morning report, `que report` and the morning summary now cover interactive sessions: per workspace, time working, needs-input moments, whether it is still waiting, commits ahead of base, and the pull request.
- Pull request tracking: every workspace's PR state (draft, open, merged, closed; checks; review decision) is refreshed from GitHub and shown in `que status` (the app side arrives separately).
- The sidebar is resizable: drag the divider (180 to 520px), double-click it
  to reset, or use the arrow keys when it has focus. The width is remembered.
  The app's own data (such as this) now lives under `QUE_HOME/app`, so a test
  `QUE_HOME` isolates it too.
- Right-click a project or a workspace in the sidebar for its actions (the ⋯
  button offers the same). Projects can now be removed from the app; their
  workspaces go with them, worktrees deleted and branches kept.

### Changed

- `npm run release` prepares a release pull request from a `release/<version>` branch: it runs `npm run verify`, moves the `[Unreleased]` notes under the new version, bumps the version, commits, pushes and opens the pull request; `--dry-run` shows each step and writes nothing.
- Merging the release pull request drafts the GitHub release: the release workflow builds que.app and attaches the DMG, the zip and the update manifest (`latest-mac.yml`), with the version's changelog section as the notes; a `-beta.N` version is drafted as a prerelease. Run from the Actions tab, it rehearses the build and uploads the files instead.
- The release build signs and notarizes que.app once the signing certificate and the notarization credentials are added as repository secrets, and stays unsigned until then; pull request builds and `npm run dist` stay unsigned.
- Removing a workspace answers at once and runs in the background, step by step: killing terminals, running teardown, removing the worktree (moved to a trash folder and deleted afterwards, so a large worktree no longer holds it up), deleting the branch. The workspace shows `removing` with the step it is on, a failed step no longer stops the rest, `workspace.removed` lists the steps that failed, and a removal cut short by a restart finishes when the daemon starts again.
- `que ws remove` deletes the branch by default (`--keep-branch` keeps it; `--delete-branch` is gone), prints each step as it finishes, and exits 1 when one failed.
- Removing a workspace no longer waits on its teardown: the dialog closes at once (deleting the branch is now the default), the view moves off it, and its row stays with a grey moving mark and the step it is on, `running teardown 12s`, until it is gone. A step that fails is named on the error line, `Removing breezy-trusty-mole: running teardown failed, timed out after 60s`.
- Changes and Files follow the worktree without a click.
- The top bar has one review pane toggle, an icon at its right end, in place of its `Changes`, `Pull request`, `Open in editor` and `Create draft PR` buttons; `⌘B` toggles the pane too.
- The review pane's Changes header is a single line, `Commits n vs base`, with refresh and open-in-editor icons at its right end; the full counts are in its tooltip.
- `Create draft PR` lives only in the review pane's Pull request tab, while the workspace has no pull request.
- The review pane runs the window's full height at its right edge, like the sidebar, with the top bar beside it.
- The Changes view no longer replaces the terminals: the list lives in the review pane and a file's diff opens as a tab in the middle.
- The sidebar filter is a search icon in the title strip, in line with the window buttons; it pops the field out on click or `⌘K` and folds away when cleared.
- The Tickets entry sits in the sidebar's bottom group with Report and Settings, which stays pinned to the bottom of the window above a solid line.
- Add project is a folder-plus line icon, and the other add buttons (session,
  workspace, terminal tab) use a matching plus; icons are inline SVG.
- The sidebar starts with a Sessions section: one row per terminal outside a
  workspace, a + to open another, and the selected one marked. It replaces
  the single Terminals row, and the view it opens is titled Sessions.
- The window no longer has a native title bar: the app's chrome runs to the
  top, the traffic lights sit over the sidebar, and that strip and the top
  bar's empty space drag the window.
- A new look: a black-and-grey dark theme with hairline borders and
  dashed guide lines between regions, system sans for reading and mono for
  labels and metadata, one coral accent, and status shown as a dot and a
  word. The top bar reads project / workspace. `docs/design.md` records the
  tokens and the rules.
- Settings no longer shows the overnight queue's defaults (concurrency, turn
  and dollar caps, default permission mode); they live in the config file.
  Protected branches, which also guard Create draft PR, sit under a Pull
  requests heading.

### Removed

- The overnight task queue: `que add`, `que task`, `que run`, `que queue`, the
  headless runner and the pull requests it opened on its own. Sessions in
  worktrees are the one model; `que report` and the morning summary describe
  what those sessions did. The config keys `concurrency`, `max_turns` and
  `max_budget_usd`, and the `que.toml` keys `test`, `instructions` and
  `allowed_tools`, are ignored, so files that still set them keep loading;
  `que config set` refuses them as unknown keys.
- The Tonight panel in the sidebar (add task, queue control, task list) and
  the hand-off of a live session to the queue (`que handoff`, the Hand off…
  actions, `handoff.create`). Sessions keep running in their own worktrees.

### Fixed

- A pull request whose cancelled checks were run again no longer reads failing once the new run passes: que keeps only the newest run of each check, as GitHub does.
- Shift+Enter in a terminal sent the same carriage return as Enter, so Claude Code submitted the prompt instead of inserting a newline. It now sends a line feed, the Ctrl+J newline Claude Code accepts in any terminal; a shell takes it as Enter.
- The completion chime only played for queued tasks; it now also plays when a session in a workspace finishes a turn (work hours only), and a task's workspace chimes once, when the task finishes.
- Ticket links pointed at the tracker's API host; they now use the site from the CLI's auth status or `[jira] site`.
- Ticket sync asked the Jira CLI for `project` and `updated`, which its search refuses; que now requests only the allowed fields, takes the project from the key, and keeps the queue in the JQL's order.
- Launched from Finder, the app now resolves the login shell's PATH for the daemon, so `claude` and `gh` are found the same way they are in a terminal; `que doctor` reports what is on the daemon's PATH.
- Terminals and headless runs start with a cleaned environment: the markers a
  running coding-agent session leaves in its shells are removed (a session in
  que is a top-level one again, with transcripts saved), and the launching
  terminal emulator's identity is removed (programs no longer try keyboard
  protocols the embedded terminal cannot serve, so Tab accepts prompt
  suggestions). `QUE_TERMINAL=1` marks a que terminal.
- The `claude` wrapper in workspace terminals no longer hangs when another
  `claude` wrapper on `PATH` hands the command back to it. The chain now ends
  at the real executable with `--settings` added once, and a wrapper that
  keeps spawning instead fails with a message. `QUE_REAL_CLAUDE` pins the
  executable when `PATH` resolution is not what you want.
- A branch checked out inside a workspace's worktree after it was created is
  now the workspace's branch: the Pull request tab finds pull requests opened
  from it, Create draft PR and a finished task push it, and removing the
  workspace deletes it.

## [0.1.0] - 2026-10-14

Built and used locally; never published.

### Added

- A daemon that owns every terminal (node-pty with a headless mirror for
  reattach), project, workspace, and task, on a unix socket in `~/.que`; the
  app and the CLI are clients, so sessions outlive the app.
- Workspaces: git worktrees on their own branch, with per-repo setup and
  teardown from `que.toml` and `.worktreeinclude`.
- A status engine fed by Claude Code hooks through a per-session wrapper (the
  user's settings are never written): working, idle, needs input, stuck.
- The work-mode app: a sidebar of projects and workspaces with live status,
  terminal tabs, a tasks panel, and a menu-bar title.
- Overnight tasks: `que add` and `que run` queue briefs that run headless in
  their own workspaces with turn and dollar caps, a stall timeout, rate-limit
  pauses, and a keep-awake; the finisher pushes the branch and opens a draft
  pull request; `que report` and the app show the morning report.
- Quiet mode: quiet hours enforced by the daemon, a quiet board that only says
  what is running and whether it is stuck, unlocks with a reason log, chimes,
  a morning summary, and settings.
- The `que` CLI, `que doctor`, and an opt-in launchd agent.
- Packaging: an unsigned macOS app (DMG and zip) with the daemon, CLI and
  node-pty outside the asar, an "Install 'que' command in PATH" menu item, and
  a daily check for a newer release.

[Unreleased]: https://github.com/queapp-org/que/compare/v0.2.0...HEAD
[0.1.0]: https://github.com/queapp-org/que/tree/afc5c9f345c965a15703283dc36e1fd7256ff010
[0.2.0]: https://github.com/queapp-org/que/compare/afc5c9f345c965a15703283dc36e1fd7256ff010...v0.2.0
