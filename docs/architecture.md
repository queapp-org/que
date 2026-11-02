# Architecture

que is three kinds of process around one long-lived daemon. The daemon owns
everything that must outlive a window: terminals, workspaces, statuses, and
quiet hours. The app and the `que` CLI hold no state of
their own; they are clients of the daemon's unix socket and can come and go.

```
  que.app (Electron)                          que CLI          Claude Code session
  ┌───────────────────────────┐            ┌──────────┐      ┌──────────────────────┐
  │ renderer (React, xterm)   │            │ commander│      │ hooks → `que hook`   │
  │   │ window.que (preload)  │            └────┬─────┘      └──────────┬───────────┘
  │ main: proxy, tray, board  │                 │                       │
  └────────────┬──────────────┘                 │                       │
               │   newline-delimited JSON over ~/.que/daemon.sock        │
               └───────────────┬────────────────┴───────────────────────┘
                               ▼
  ┌──────────────────────────────────────────────────────────────────────────────┐
  │ daemon (Electron binary as Node: ELECTRON_RUN_AS_NODE=1)                       │
  │  DaemonServer ─ quiet gate ─┬─ PtyHost: node-pty + @xterm/headless mirrors    │
  │                             ├─ Workspaces: projects, git worktrees, setup     │
  │                             ├─ Status engine: hooks + ticks → workspace status│
  │                             ├─ Pull request tracking (gh)                     │
  │                             └─ Store: SQLite (node:sqlite) in QUE_HOME        │
  └──────────────────────────────────────────────────────────────────────────────┘
          │ spawns                         │ spawns                    │ spawns
      login shells                 claude agents --json            git, gh
```

## The daemon

`src/daemon/index.ts` starts once per `QUE_HOME`. Clients find it through the
socket; if the socket is missing or stale, `DaemonClient.connectOrStart()`
spawns the daemon detached and waits for `daemon.ping`. It runs under the
Electron binary with `ELECTRON_RUN_AS_NODE=1`, so `node-pty` is the one native
module and it is built once, for Electron's ABI. In the packaged app the daemon,
CLI and client bundles live in `que.app/Contents/Resources/{daemon,cli,client}`
and `node-pty` in `Resources/daemon/node_modules`, outside the asar archive.
`que daemon install` adds an opt-in launchd agent that starts it at login.

Quitting the app closes a socket connection and nothing more: terminals and
the sessions in them keep running, and the next window reattaches.

A rebuilt daemon bundle does not reach a daemon that is already running, so
each side names the build it has. The daemon hashes its own bundle at start
(the first 12 hex characters of a sha256, `src/shared/build-id.ts`) and answers
`daemon.ping` with it as `buildId`; the app and the CLI hash the bundle they
would start. Only the daemon bundle counts, so a change to the window never
asks for a restart, and an unknown id on either side never does either.
`que daemon status` and `que doctor` show both ids and recommend `que daemon
upgrade`, with `que daemon restart` as the fallback. The app shows Restart at
the right end of the sidebar's Quiet row, which hands the terminals to the new
build in place (see below) and keeps every one running. If that fails (the
running daemon is too old to hand off, or the successor did not start), the
old daemon still serves, the error line says why, and the control stays for
another try. The app never ends a terminal to change builds; only `que daemon
restart` does. Both are always the user's click, never automatic.

When the connection drops, the window says it is reconnecting and asks the
main process for the daemon's state, which reconnects or starts a daemon (after
the old one has exited). Once it is back (`daemon.reconnected`), the store
loads everything again, attaches the terminals that still exist, marks the
rest exited, sends `workspace.watch` for the shown workspace again (watches
belong to a connection), and lets a visited workspace open a fresh shell. A
failed reconnect shows its error and waits for the user's Reconnect.

## The protocol

`src/shared/protocol.ts` is the contract. Requests are `{ id, method, params }`,
responses echo the `id` with `result` or a structured `error` (`code`,
`message`), and events are `{ event, data }` pushed to every connection. The
`Methods` and `Events` maps type every call end to end: the daemon's handlers,
`DaemonClient.request()`, the CLI, the main process allow-list, and the preload
bridge the renderer sees (`src/preload/index.d.ts`). Framing is a line splitter
that copes with chunks split anywhere, including inside a multi-byte character.

## Terminals

`PtyHost` runs each terminal as a node-pty process and feeds every byte into a
`@xterm/headless` terminal as well as to subscribers. Attaching takes a serialized snapshot
of that mirror (screen, scrollback, modes) and then streams live data, with
anything that arrives during the snapshot buffered so nothing is lost or
duplicated. That is what lets a relaunched app, or `que attach` in another
terminal, pick up exactly where the screen was. A terminal handed over by a
previous daemon (see below) is an `AdoptedTerminal` over the inherited master
fd; `PtyHost` holds both kinds behind one interface.

Each terminal also reports two facts in its row (`TermInfo`): `title`, the
last title its program set with OSC 0 or 2, raw (an empty title clears it),
and `process`, the name of the program in its foreground (`zsh`, `claude`,
`cat`), kept after the terminal exits. The foreground program is read with
node-pty's native call on the master fd on every title change and once a
second; the kernel's name can be a versioned file the launcher points at, so
when it changes, `ps` on the terminal's tty finds the foreground group's
leader and its argv[0]. `term.updated` carries the row whenever either fact
changes, and only then.

The renderer's xterm sends what a terminal sends, with one addition. xterm
cannot tell Shift+Enter from Enter (both are a bare carriage return), so the
app sends a line feed for Shift+Enter: the Ctrl+J newline Claude Code accepts
in any terminal, and plain Enter to a shell or anything else that reads lines.

## Upgrading the daemon without ending terminals

A PTY is a file descriptor, so a terminal can change owners without the shell
noticing. `que daemon upgrade`, and the sidebar's Restart through the app's main
process, ask the running daemon for `daemon.handoff` (the renderer cannot call
it directly), naming the daemon bundle and runtime of the que that asks,
normally the newly installed app's. Both go through `src/shared/upgrade.ts`,
which reports a failure as an answer, not a throw, and puts what it means into
words for both surfaces (`handOffFailedText`). The running daemon then:

1. stops reading every live terminal at the handle, so what the shells print
   from then on waits in the kernel, and serializes each mirror;
2. writes a versioned snapshot under `QUE_HOME` (per terminal: id, workspace,
   name, cwd, pid, size, its fd index, title, foreground program, and the
   serialized screen and scrollback) and spawns the new bundle detached, as `connectOrStart` would,
   with `--handoff --snapshot <file>`, the IPC channel at fd 3 and the master
   fds from fd 4.

The successor deletes the snapshot, adopts each fd (a tty stream for reading,
direct writes, node-pty's own native binding for resizing, the pid for
signals, end of stream as exit), rebuilds each mirror from the serialized
state and answers `adopted`. The old daemon stops its services, drops every
connection but the caller's and removes the socket, then says `bind`. The
successor binds the socket, writes the pid file, starts its services, starts
reading the terminals and answers `ready`. The old daemon answers the caller
with the new pid and exits without signalling any terminal, leaving the socket
and pid file to its successor. Clients reconnect and attach to the same
terminal ids; the attach replays the rebuilt mirror.

Carried over: every live terminal, with its id, shell, screen and scrollback.
Not carried over: file watches and pollers (they start fresh), exited terminals, the
start time (it is a new daemon), and an adopted terminal's exit code (the new
daemon is not the shell's parent, so an ended terminal reports 0).

Every wait on the successor has a timeout. If it fails, exits or does not
answer before `adopted`, the old daemon reads its terminals again and answers
with the error; after it has let go of the socket, it also kills the successor
(SIGKILL, so it shuts nothing down), listens again with fresh services and
then answers. Either way no terminal ends; the error reaches the app's error
line or the CLI's stderr, and the fallback is `que daemon restart`.

After a Restart the app reconnects as after any drop (the reconnect contract
above): the old connection closes as that daemon exits, the next one reaches
the successor, and `daemon.reconnected` fires. The terminal ids are the same,
so every pane attaches its terminal again and none is marked exited.
The sender lives in the running daemon, so the first upgrade to a que that has
this is still a restart.

## Workspaces and the hooks wrapper

A project is a registered git repository; a workspace is a git worktree on its
own branch under `worktree_root`, with the repo's `que.toml` setup command run
inside it. Workspace terminals start with `<QUE_HOME>/bin` first on `PATH`.
That directory holds two small scripts the daemon writes at startup:

- `claude` runs the `claude` the daemon resolved (`QUE_REAL_CLAUDE`, else the
  next one down `PATH`) and, inside a que workspace, adds
  `--settings <QUE_HOME>/hooks.json`. Outside one it is transparent. The
  user's own settings files are never written. If what it runs is another
  tool's wrapper that hands the command back (wrappers exec, so the pid is the
  same), it skips what it already tried and does not add `--settings` twice;
  a chain that keeps going fails with a message instead of looping.
- `que` runs the bundled CLI (with the app's own binary in a packaged build).

`hooks.json` registers `que hook` for every hook event, so each event a session
fires arrives at the daemon as JSON on stdin, tagged with the workspace it ran in.

It also sets the session's status line to `que statusline`. Claude Code runs it
after each reply with the session JSON on stdin; on a plan account that carries
`rate_limits`, the five-hour and weekly windows (percent used, reset time).
`que statusline` sends them to the daemon (`usage.report`, a one-second budget,
never failing the line), then runs the user's own status line, the first
`statusLine` command in the project's `.claude/settings.local.json`, its
`.claude/settings.json`, then `~/.claude/settings.json` (read only, que's own
command skipped), with the same stdin, and passes its output and exit status
through; with none it prints nothing. The daemon keeps the newest reading from
any session (the numbers are account-wide), ignores an older one arriving late,
drops a window once it resets, keeps the reading in `<QUE_HOME>/usage.json`
across restarts, and announces each change as `usage.changed` (`usage.get`
reads it).

Removing a workspace (`workspace.remove`) marks it `removing` and answers at
once; the removal runs in the background. `Workspace.removal` holds its plan,
the steps done with their durations and failures (the step running now is the
first one not done), and since when it has run; it is stored with the row, so
every `workspace.updated` carries it, and each step's result is announced. The
steps, in order: `terminals` kills its terminals and a setup still running;
`teardown` runs the repo's `teardown`
hook when `que.toml` has one and the worktree exists, killed after
`teardown_timeout_seconds`; `worktree` renames the worktree into
`<worktree_root>/.trash/<workspace id>` (the same volume, so it is instant),
runs `git worktree prune`, and deletes the moved folder with nothing waiting on
it, falling back to `git worktree remove --force` when the rename fails;
`branch` runs `git branch -D`, only when asked. A step that fails is recorded
and the rest still run. Then the row is archived and `workspace.removed`
carries the steps that failed. The status engine ignores every input for a
removing workspace, so the exits of its killed terminals cannot move it. A
removal the daemon was stopped in resumes from its step when the daemon starts
again, and leftovers in `.trash` are deleted then. `project.remove` with
`force` waits for every removal to finish.

## What a process que starts can see

The daemon and every terminal get a cleaned copy of the
environment (`src/shared/env.ts`): the markers a running coding-agent session
leaves in the shells it spawns are removed, so a session started in que is a
normal top-level one; the identity of whichever terminal emulator launched que
is removed, so programs pick generic terminal features that an embedded xterm
serves; app internals go too. `QUE_TERMINAL=1` is set. The user's own
configuration (an alternate config directory, provider selectors, limits) is
kept.

The app resolves the login shell's PATH once at start (`src/shared/login-path.ts`)
and merges it in front of its own, and the daemon and editor launches inherit
it, so a Finder launch finds the same tools a terminal does. `que doctor`
reports what is on the daemon's PATH.

## The status engine

`status-engine.ts` is a set of pure functions: a hook event, a terminal exit,
a clock tick, or a `claude agents --json` entry goes in with the previous
status and `now`; the next status comes out. A prompt or tool use means
working, a stop means idle, a permission prompt means needs input, and no sign
of life for `stall_timeout_minutes` (a transcript file growing counts as life)
means stuck. A stop with agent-like background tasks (subagents, workflows,
teammates) still running keeps it working; a shell or monitor does not.
`status.ts` runs those rules per workspace, persists transitions,
and emits `workspace.updated` with the full row. Nothing in the rules reads the clock, so they are
tested exhaustively as plain functions.

The same hooks keep a record of the sessions that are live in workspace
terminals (`live-sessions.ts`). Every terminal carries its own id
(`QUE_TERMINAL_ID`), which `que hook` passes along, so a session start names
the terminal it runs in. An entry is written on the session's start and cleared
when Claude ends the session, when the terminal exits, or when it is killed. The
record is saved in the store as it changes and frozen when shutdown begins, so
a crash leaves it as current as a clean stop. At start the next daemon consumes
each entry once and, unless the workspace is gone or archived, opens a terminal
in it that types `claude --resume <session>` once setup is done. An entry whose terminal is
alive in the new daemon came over with it and stays live rather than being resumed
again. While quiet
hours are locked the entries wait for the unlock. If a resume fails, the shell
shows the error and nothing else is typed; the daemon log names each session
it resumed or skipped.

## The sessions report

Every change of a workspace's status or reason is also appended to the
`workspace_status_log` table (and its creation, as `preparing`); rows older than
30 days are pruned as new ones arrive, and a workspace's rows go with it. The
morning report, `que report` and the morning summary build on that log alone:
`gather-report.ts` gathers every open workspace's rows for the window (by
default the last 24 hours) and `report.ts` turns the digests into the report and
its count line. `digest.ts` turns one
workspace's log rows for the window (plus the last row before it, so time already
spent in a state when the window opened counts) into a `WorkspaceDigest`: time
spent working, how many times it asked for input, whether it is still waiting and
since when, how many times it got stuck, its pull request, and its commits ahead
of base. Commits ahead are counted against `origin/<default branch>` when that
ref exists, else the base the workspace was created from. Workspaces that did
nothing in the window and are not working, waiting or stuck are left out; the
rest are sorted with those needing input first, then stuck, then working.

## Pull request tracking

`prs.ts` keeps `Workspace.prs`, the session's pull requests, fresh, and
`Workspace.pr`, the current one among them. The session's pull requests are
those whose head is any branch the worktree has had checked out, plus every one
the session created, on any branch:

- **Branch history.** `Workspace.branches` lists every branch the worktree has
  had checked out, oldest first (`branches_json`). `syncBranch` appends the
  branch it finds checked out; a workspace stored before the list was kept has
  it seeded once from the worktree's own `git reflog show HEAD` (the
  `checkout: moving from <a> to <b>` entries; `branch-history.ts`).
- **Created pull requests.** `Workspace.prUrls` (`pr_urls_json`, the old
  `pr_url` migrated in) has one writer: `hook.event` appends any pull request a
  Bash `PostToolUse` shows `gh pr create` printing (stdout, stderr or a plain
  string), main session and subagents alike, when its owner and name match the
  project's `origin` remote (`pr-created.ts`; the origin is read once per
  project). A URL for another repository is ignored.

Every `pr_poll_seconds` (default 60) it lists each project's newest pull
requests once (`gh pr list --state all --limit 100`), grouped by head branch; a
branch missing from a full page is asked about on its own (`--head <branch>`).
Protected branches are never asked about, but a created pull request is always
looked up (`gh pr view <n>`) when no listed branch holds it. A merged or closed
pull request is re-checked only every fifth time. `pr-state.ts` maps each answer
to state (draft, open, merged, closed), checks (none, pending, passing,
failing), review decision, and the branches it merges into and from
(`base`/`head`, from `baseRefName`/`headRefName`; the app derives a stack from
them). One already stored stays when its branch moves on, so nothing drops out;
the list is newest first by number, at most 20. When it differs from the stored
one (ignoring `checkedAt`) it is saved in `prs_json` and `workspace.updated` is
emitted. A failed `gh` keeps the stored value and logs one line until a call
succeeds again. A created pull request seen in a hook triggers an immediate
check of that workspace.

Each check run and commit status from the rollup is kept too, as
`PullRequest.checkRuns`: name, workflow, state (failing, pending, passing,
skipped), link and times, failing first. The `checks` summary is derived from
them, and a run that changes counts as a change, so `workspace.updated` fires
when a check finishes even though `updatedAt` stays put.

`workspace.checkPrs` checks one workspace's pull requests now (the app's refresh,
`que ws pr --refresh`) and fails with gh's message when a call fails; the poll and
the hooks only log.

`workspace.prThread` (`que ws pr`) answers the conversation: issue comments and
reviews from `gh pr view <n> --json comments,reviews`, line comments from
`gh api repos/{owner}/{repo}/pulls/<n>/comments --paginate`, parsed by
`pr-thread.ts` and sorted oldest first. It answers for the pull request
`number` among the workspace's (the app passes the one it shows).
Each thread is cached per workspace and pull request number with the
`updatedAt` it was fetched for, and reused until the tracker stores a different
one (or the caller passes `refresh`). Concurrent calls share one fetch. A failed
`gh` raises `gh_failed` and caches nothing; the cache entries go when the
workspace is removed or its pull request leaves the list. After each check the
tracker fetches, three at a time, the threads of the open and draft pull
requests not cached for their current `updatedAt`, so each `PullRequest`
carries `comments` (how many entries) and `commentedAt` (the newest entry's
time), filled from the cache and stored; both stay null until a thread has been
fetched, and a merged or closed one keeps what it had. A fetched thread whose
counts differ updates the workspace and emits `workspace.updated`.

## The diff view

`workspace.diff` (`que ws diff`) compares a workspace against its base: `origin/<default>` when that remote ref exists, else the default branch, unless the caller names another ref as `base` (`--base`), which must resolve to a commit. Everything is measured from the merge base of the base and `HEAD`, so committed and uncommitted changes appear together, and untracked files are listed too. Each file carries its status, line counts, whether it is still uncommitted, and a unified patch (null for binary files and patches over 200,000 characters). The result also lists the branch's commits past the base, newest first (at most 200), and the refs worth comparing against: the base, the default branch here and on origin, then the other local and origin branches, never the workspace's own (at most 50). Given a `commit` (`--commit`) that is on the branch and not on the base, the files narrow to that commit's own changes, against its parent (or the empty tree for a root commit), with nothing from the working tree; the commit count and list still describe the whole branch. A base or commit that does not qualify is a `bad_request`. Given a `head`, it compares that branch instead of the worktree, for one pull request's own files: `merge-base(base, head)..head`, committed changes only, with no working tree and no untracked files. The head and the base each resolve as a branch here first (refs are shared between worktrees, so a subagent's branch usually is one), then as `origin/<ref>`; a head that resolves to neither is a `bad_request`. A pull request into another pull request's branch passes that branch as `base`, so it diffs against it, not the default. It only reads: `git diff`, `git status`, `git log`, `git ls-files`, and `git for-each-ref`. Quiet hours refuse it like any other workspace read.

Each file of `workspace.diff` also splits its counts into code and comment lines (`codeAdditions`, `commentAdditions`, `codeDeletions`, `commentDeletions`, summing to `additions` and `deletions`) and is `commentOnly` when it changed at least one line and every changed line is a comment line, as `workspace.diffFile` flags them (below). The answer never waits for the split. A split already worked out is in it; any other file counts as all code there and is worked out in the background: both sides read and tokenized as `workspace.diffFile` does, on the same worker and through the same cache of tokenized sides (so opening a diff tab after the split, or splitting after a diff tab, does not tokenize again), its tokens laid on the list's own patch (git's default context, whitespace shown, no word marks). At most four files are worked out at once, one job per file version however many calls ask for it. Splits are kept in memory (2,000 entries) by both sides' blob ids (one `git diff --raw` per call) and the paths; a working-tree file is known by the hash of its content, kept while its modification time and size stay the same, so a refresh reads and hashes only files that changed, and only in their job. When everything a workspace's calls queued has finished and any split landed, the daemon sends `workspace.diffSettled { id }`, and a client asking again gets the splits from memory; the app fetches the diffs on screen again, nothing else. A file tokenized plain because the worker timed out or crashed lands nothing and is tried on the next call. Files without a patch (binary, or a patch over the cap), in a language without a grammar, with either side over the whole-file context limits (5,000 lines, 400,000 characters), and every file of a diff listing more than 300 files count as all code and are never `commentOnly`. `que ws diff` prints what it printed before; its `--json` carries the new fields.

`workspace.diffFile` gives one file of that same scope (`base`, `head`, `commit`, resolved by the same code) as structured lines instead of a patch, for the diff tab; it has no CLI command. The path is the file's new path, relative and inside the worktree (else `bad_request`); a path with no change in the scope is `not_found`. `whitespace: 'ignore'` diffs with `git diff -w`. When both sides are at most 5,000 lines and 400,000 characters the diff is taken with the whole file as context (`-U` the longer side's line count) and `fullContext` is true, so the app can fold unchanged runs and open them on request; otherwise git's default context. A side over 2 MB is `skipped: 'too-large'` and a binary one `skipped: 'binary'`, both with no hunks. Each hunk keeps its numbers and git's function context as `label`; each line has its kind (context, added, removed), its old and new line numbers, and its text as tokens whose texts join to exactly the line. The tokens come from the whole old and new files, not the patch: both sides are read whole (`git cat-file` for a blob, the file itself for the working tree, nothing for an added or untracked file) and tokenized with a grammar-based highlighter in the daemon (`shiki`, JavaScript regex engine, a fixed list of about thirty languages chosen by file name and extension), so a block comment or a multi-line string colours every line it spans; each diff line takes the tokens of its line number on its side. The highlighter is asked for each token's scope stack, and the daemon maps scopes to a small fixed set of kinds (`decl`, `ctrl`, `fn`, `type`, `str`, `num`, `var`, `prop`, `punct`, `comment`, `plain`): anything inside a comment is a comment, otherwise the innermost scope a rule knows decides (in `src/daemon/highlight.ts`). An unknown language, a file over 1,000,000 characters, or a highlighter failure gives one plain token per line and `language: null`. Every `( [ {` and `) ] }` outside strings and comments, a template's `${ }` included, is its own `punct` token carrying its nesting depth counted through the file. An added or removed line is a comment line, and carries `comment: true`, when every token with visible text on it is a `comment` token: line, block and doc comments, the inner lines of a block comment included, since the whole file is tokenized; code with a trailing comment is code, and so is a docstring, which grammars give as a string. A blank changed line is a comment line when the nearest non-blank lines above and below it in its run of added (or removed) lines are both comment lines. A file tokenized plain (no grammar, a timeout, a crash) has no comment tokens, so no comment lines. Within a change block (removed lines then added lines), the i-th removed line pairs with the i-th added line, and the words that differ (`diffWordsWithSpace` from `diff`) carry `mark`; a pair sharing under 30% of its characters gets no marks, and a file past 2,000 pairs or 200,000 paired characters gets no more. Both sides' blob ids come from one `git diff --raw` and their sizes from one `git cat-file --batch-check`. Results are kept in memory, about 250,000 lines in all, by both sides' blob ids (a content hash for a working-tree file), the paths, and the whitespace option, so asking again for an unchanged file costs only the `git` calls that find those ids; each tokenized side is kept the same way by its id and language, for other readers of the same file. Tokenizing never runs on the daemon's main thread, which pumps every terminal: one long-lived worker thread (`highlight-worker.js`, bundled beside the daemon bundle in `out/daemon` and in the app's `Resources/daemon`, found through `src/shared/packaged.ts`) starts on first use and takes requests by id. A file that takes over 5 s, queueing included, or a worker that crashes or cannot start, gets plain tokens and `language: null` instead of a failed request, a stuck worker is terminated and replaced on the next request, and such a result is not cached. The worker stops with the daemon. Quiet hours refuse it like `workspace.diff`.

`workspace.files` (`que ws files`) lists every file of a workspace's worktree that git would show: tracked and untracked, never ignored (`git ls-files --cached --others --exclude-standard`), deduplicated and sorted, cut at 20,000 paths with `truncated` set; a missing worktree lists nothing. `workspace.readFile` reads one of them for the file view. The path must be relative and strictly inside the worktree: an absolute path, the root itself, or any empty, `.` or `..` segment is a `bad_request`, and so is a path whose real location, symlinks followed, falls outside the worktree's real root, or a directory. A missing path is `not_found`. A NUL byte in the first 8 KB marks the file binary and its content null; text is decoded as UTF-8 and cut at 500,000 characters with `truncated` set; `size` is always the byte size on disk. Both only read, and quiet hours refuse them like any other workspace read.

In the app, Changes and Files follow `workspace.changed` for the workspace on screen: while the review pane or one of its diff or file tabs is open, the store fetches the diff again in its scope (the base and commit stay), and while Files or a file tab is open, the listing and every open file tab too. A change that arrives during that fetch is followed once more after it lands; a closed pane with no view tabs fetches nothing until it opens, and a failure is kept for the views as any other. The Files tree keeps the directories the user opened and closed, except that a directory that newly holds a changed file opens. A pull request open in the pane, and each of its diff tabs, fetches its own files again too (`head` set to its branch, `base` to its base). The pull requests list reads each pull request's `comments` and `commentedAt` from the daemon and fetches no conversation itself; only the pull request open in the pane fetches its own, again when its `updatedAt` moves, and the pane's Refresh fetches only that one with `refresh`. A conversation fetched earlier stays cached in the app until its pull request's `updatedAt` moves. Which comments are new since a pull request was last opened is the app's own memory (in the review pane's local storage, the newest entry's time when it was opened, compared with `commentedAt`); the daemon keeps nothing of it.
`workspace.changed { id }` tells clients a workspace's worktree changed, so they can ask for the diff or the files again; the event carries nothing else and the daemon computes nothing for it. The daemon watches a workspace only while a window shows it or some connection is attached to one of its live terminals. The app says which workspace a window shows with `workspace.watch { id }` when it shows one and `workspace.unwatch { id }` when it leaves it, so the watch holds while a diff or a file tab covers the terminal; the daemon keeps the ids per connection. A watch or an attach starts the watch, and it stops when no connection wants the workspace any more: an unwatch, the last detach, the terminal's exit or kill, the connection closing, or the workspace's removal; shutdown closes every watch. Each watched workspace has two recursive watches. One is the worktree, ignoring the `.git` entry and everything under it. The other is the gitdir: a linked worktree's `.git` is a file whose `gitdir:` line points into the repository's `.git/worktrees/<name>`, which is where a commit, checkout or reset writes, and a main worktree's `.git` is the gitdir itself. Only `HEAD`, `ORIG_HEAD`, `index`, `packed-refs` and anything under `logs/` and `refs/` count there, so object writes do not. The first change that counts opens a 300 ms window and the event goes out when it closes, once per window per workspace however many changes it held.

## The ticket queue

`tickets.ts` keeps the tickets assigned to the user in the `tickets` table, the
way the pull request service keeps pull requests. It never writes to the
tracker. The tracker is read through the user's own `acli` (already signed in):
every `jira.poll_minutes` (first run a second after the daemon starts) it runs
`acli jira workitem search --jql <jira.jql> --json --fields key,summary,status,priority,issuetype,assignee,labels`
(the search refuses any other field, so the project comes from the key's prefix and there is
no updated time), upserts what came back,
drops tickets that vanished unless a workspace was started for them, and emits
`tickets.synced`. The queue keeps the order the search returned (a `position` column), so the
JQL's `ORDER BY` decides it. A failure stores the first line of stderr in the `kv` table as
the sync error (the list stays), logs once, and is cleared by the next success.
`tickets.list` only reads the cache.

Ticket links are `https://<site>/browse/<key>`, with the site from `[jira] site` or else from
`acli jira auth status` (read once per sync and cached; the search's `self` URLs point at an
internal API host). The search cannot return a ticket's parent, so after it the daemon runs
`workitem view KEY --fields parent` for every non-epic ticket whose parent was never checked
or was checked over a day ago (at most four at a time; a failure is logged and retried next
sync) and stores `parent_key` and `parent_checked_at`. A parent the search did not return is
kept as a synthesized ticket (`assigned = false`) built from the view's parent fields; it takes
the position of its first child, just before it, and is dropped when no ticket points at it any
more. Epics are overviews: `tickets.start` refuses them, and a started ticket's brief ends
with its parent's summary and description.

`tickets.start` fetches the full ticket with `acli jira workitem view`, flattens
its description (`adf-text.ts`) and renders a brief. The ticket's tracker project
picks the que project through `[jira.projects]`; with no mapping the daemon
answers `needs_project` and does nothing, and once the caller passes a project
the choice is written back to the config. The workspace is named
`<key>-<summary slug>`; the brief goes to `<worktree>/.que/ticket.md` (with
`.que/` added to the repository's `info/exclude`), and a terminal in the
workspace is typed `claude '<jira.start_prompt>'`. A second start reuses the
workspace. A loose session instead gets the brief at `<QUE_HOME>/tickets/<KEY>.md`
and a terminal in the home directory. Starting is refused in quiet hours.

A workspace can also start from a brief. `workspace.create` without a `name`
draws a random three-word name (`adjective-adjective-noun`, `names.ts`) for the
workspace, branch and folder, drawing again on a clash up to 50 times; an
explicit name is refused on a clash instead. The new-workspace dialog prefills
such a name and lets the user draw another or type their own, which it sends as
the explicit name. Tickets pass their own name. The
title is the given one, else the brief's first line (`brief.ts`), and is what the
sidebar shows; the brief goes verbatim to `<worktree>/.que/brief.md`.
`workspace.start` opens the workspace's first terminal when it has none, answers
with it, and once setup has ended types the command that starts Claude. By
default the brief is the first prompt: `claude "$(cat '<worktree>/.que/brief.md')"`,
so the shell hands it over verbatim. With `start_prompt` set, that text is sent
instead (`claude '<start_prompt>'`; it can tell Claude to read `.que/brief.md`),
and a workspace without a brief gets a bare `claude`. `workspace.rename`
changes the title and, for a branch with no `origin/<branch>`, can rename the
branch to a name the user gives; the folder keeps its name.

Once a session is running, the title is the session's own. Claude Code names a
session from its first prompt (or `/rename`) and writes the name to the terminal
title, `✳ <name>` when idle and `◐ <name>` while busy; `session-label.ts` drops
the glyph, the unnamed placeholder `Claude Code` and the empty exit title. The
daemon reads it on every `term.updated` and on each `SessionStart` hook (a
resumed session writes its name before the hook lands), but only from a
terminal the live-session record holds, so a shell's own title never counts. A
new name is stored with `title_source = 'terminal'` and announced with
`workspace.updated`; the empty title on exit leaves it in place. A title the
user gave, at creation or with `workspace.rename` (`title_source = 'user'`),
pins it: later session titles never replace it.

## Quiet enforcement

Quiet hours are enforced in the daemon, not the UI, so no client can see past
them. While a window is in progress and not unlocked, the server refuses the
detail methods (terminal attach and snapshot, reports, diffs and files,
starting a session or a terminal) with a `quiet_hours` error and drops every live
terminal subscription the moment the window starts. Status and counts keep
working, and so do the sessions already running, which is all the quiet board needs: it answers "is it running, and is
it stuck?" and nothing else. An unlock lasts `unlock_minutes`, is logged with
its reason, and ends on its own. A config edit made during a window never
shortens tonight's window unless asked to. When the window ends, the daemon
emits one morning summary.

A manual quiet (`quiet.start`, `que quiet start [minutes]`) is a second source
of windows for the same enforcement: a start and a required end, at most 12
hours out, persisted in `quiet_manual` so it survives a daemon restart. The
scheduled window wins whenever both cover a moment, and one that starts during
a manual quiet ends it for good. Starting again replaces the window (and ends
any unlock); `quiet.end` ends it at once. It holds with quiet hours disabled,
config edits never end it, and the apply-tonight guardrail covers only the
scheduled windows. Unlocks inside it work the same and reach the daemon log,
but the unlock log (`quiet.log`, the report's unlocks line) keeps only the
night's. Its end, by expiry or `quiet.end`, emits the same summary with `kind:
'manual'`, worded for the day and skipped when nothing ran or waits; one that
quiet hours end leaves the night to the morning summary.

## The app

The main process proxies an allow-list of methods and forwards events to the
renderer, keeps the menu-bar title (`● 3 ▸ 1 ✕ 0`), shows the quiet board window
while locked, and checks once a day for a newer release, which the sidebar's
Quiet row offers as Update while the daemon runs this build. Only a release
build checks: one run from source is not packaged, and `npm run package` (which
`npm run install:local` runs) marks its bundle's package.json with
`queLocalBuild`; releases build with `npm run dist`. The renderer only
ever talks to `window.que`, which is why its component tests can run against
an in-memory fake of that bridge.
