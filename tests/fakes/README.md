# Subprocess fakes

`tests/fakes/bin/` holds stand-ins for the external programs que spawns. Tests put
the directory **first on `PATH`**, so the daemon, the CLI, and the app find these instead of the real
binaries. `git` is never faked: tests use real repos in temp dirs. All of them are
dependency-free Node scripts.

`tests/fakes/env.cjs` builds that environment once for every caller (the Vitest
daemon harness, the Playwright `testEnv()`, the packaged-smoke script):
`fakeEnv(home)` gives `QUE_HOME`, `QUE_CONFIG`, the `PATH`, each fake's log and
data file under the home, and `GIT_CONFIG_GLOBAL`; `writeGitconfig(home, name)`
writes that fixed git identity; `QUIET_OFF` is the config table that turns quiet
hours off.

## `claude`

Parses the flags que uses (`--settings`, `--session-id`, `--resume`,
`--permission-mode`, `--append-system-prompt-file`, `--model`, `--version`) and
`agents --json`. Unknown flags are ignored. It runs only as an interactive session; there is no print mode.

**Hooks.** Every `command` hook in the `--settings` `hooks` map (inline JSON or a
file) runs through `/bin/sh -c` with the session cwd and the inherited env, with
the hook JSON on stdin (`hook_event_name`, `session_id`, `cwd`, `transcript_path`,
`permission_mode`, plus the per-event fields). Matchers are honoured.

**Interactive mode**: prints a banner and `> `; each line fires
UserPromptSubmit, a fake `Read` (Pre/PostToolUse), a reply, and Stop.
`/needs-input` fires UserPromptSubmit, then the permission Notification, and waits for `y`; `/exit` fires
SessionEnd and exits 0. The banner shows the cwd with `$HOME` as `~`.
With `QUE_FAKE_CLAUDE_STREAM=<ms>` a prompt's turn keeps working instead:
every `<ms>` it prints a tool step (`● Edit(src/upload.ts)`) and fires Pre/PostToolUse, ignoring
further lines, until `SIGUSR1` ends the turn with a reply and Stop, or `SIGUSR2` fires the
permission Notification and waits for `y` as `/needs-input` does.
With `QUE_FAKE_CLAUDE_TITLE=<text>` it sets the terminal title (OSC 0) as the real CLI
does: `✳ <text>` at startup and after each Stop, `◐ <text>` when a prompt arrives, and the
empty title on `/exit` and at the end of its input. `/rename <name>` replaces the text (set or
not) and writes `✳ <name>` at once, printing `Session renamed to: <name>`, with no hooks.

**Status line.** `/statusline` runs the `--settings` `statusLine` command (type
`command`) through `/bin/sh -c` in the session cwd, with the status line JSON on stdin
(`hook_event_name: 'Status'`, `session_id`, `transcript_path`, `cwd`, `model`,
`workspace.current_dir` and `workspace.project_dir` both the cwd, `version`, `cost`) plus
`rate_limits`: by default `five_hour` at `used_percentage: 42.5` resetting in 2 hours and
`seven_day` at `18` resetting in 5 days (`resets_at` in Unix seconds, as the real CLI
sends). `/statusline <json>` sends that JSON as `rate_limits` instead; `/statusline none`
leaves the field out. Each line the command prints appears in the terminal as
`status line: <text>`. No hooks fire.

| Command                  | Hooks                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/background <kinds...>` | UserPromptSubmit; a SubagentStart (`agent_id` a fresh hex id, `agent_type: 'Explore'`, the parent `session_id`) per `subagent`; a reply; Stop whose `background_tasks` lists each kind as `running` with an `id` and a `description` (`Explore the repo` for a subagent, `npm run dev` for a shell, `checks on #141` for a monitor), plus `command` (shell) and `agent_type` (subagent). The session remembers the list. |
| `/background done`       | SubagentStop per remembered subagent (`agent_id`, `agent_type`, the parent `session_id`, and `background_tasks` still listing it as running, as the real CLI does), then UserPromptSubmit, then Stop with `background_tasks: []`; the list is forgotten.                                                                                                                                                                 |

Other knobs: `QUE_FAKE_CLAUDE_TRANSCRIPT_DIR` (where `<session_id>.jsonl`
transcripts go; default under the OS temp dir), `QUE_FAKE_CLAUDE_AGENTS_JSON` (a
file whose contents `agents --json` prints instead of `[]`),
`QUE_FAKE_CLAUDE_VERSION`. With `QUE_FAKE_CLAUDE_LOG` set, every invocation
first appends one JSON line `{ "argv": [...], "cwd": "...", "pid": <n>, "ts": "...",
"env": [...] }` to it (`env` is the sorted CLAUDE*, TERM* and QUE_* variable names it
saw), as `gh` and `code` do.

## `gh` and `code`

Each invocation appends one JSON line `{ "argv": [...], "cwd": "...", "ts": "..." }`
to `$QUE_FAKE_GH_LOG` / `$QUE_FAKE_CODE_LOG` when set. `gh auth status` reports
a logged-in account; `gh pr create ...` prints
`https://github.com/rquellh/que/pull/<n>`, where `n` counts the `pr create` calls
already in the log. Everything else exits 0 silently.

**Pull requests.** `$QUE_FAKE_GH_PRS` names a JSON file keyed by head branch name (a
missing file means no pull requests). A branch's entry is a list of its pull request
objects (one merged and a newer one open, say). When
it is set, `gh pr create` records `{ number, url, title, state: "OPEN", isDraft,
baseRefName, headRefName, reviewDecision: "", statusCheckRollup: [], mergedAt: null, updatedAt }`
(`updatedAt` now) under its head: `--head` when given, else the current branch of its cwd;
`baseRefName` is `--base` when given, else origin's default branch (`origin/HEAD`, else `main`).
It replaces the head's open pull request, and otherwise joins its merged and closed ones in
the list. `gh pr list --head
<branch> --state all --limit <n> --json <fields>` prints a JSON array of that branch's pull
requests, newest first by number, with only the requested fields (`additions`,
`deletions`, `baseRefName` and `headRefName` among them when the entry has them), or `[]`; without `--head` it prints every
branch's, up to `--limit` (default 30). With `$QUE_FAKE_GH_FAIL` set, `pr list` exits 1
printing `gh: failed (fake)` on stderr. Tests edit the file with `setFakePullRequest()`
(merges into the branch's pull request with the patch's `number`, else the newest,
creating one when the branch has none) and `addFakePullRequest()` (adds another to the branch, numbered one past
the highest in the file unless told), and read it with `readFakePullRequests()`, all from
`src/testing/fakes.ts`.
**The conversation.** `gh pr view <n> --json <fields>` finds the pull request (in any branch's entry) whose `number` is
`n` and prints an object with the requested fields among `number,url,title,state,isDraft,
reviewDecision,statusCheckRollup,mergedAt,updatedAt,additions,deletions,baseRefName,headRefName,comments,reviews` (`comments` and
`reviews` default to `[]`); an unknown number exits 1 with `gh: no pull request #<n> (fake)`.
`gh api repos/<owner>/<repo>/pulls/<n>/comments` (literal `{owner}`/`{repo}`, `--paginate`,
`-X GET` and `--method GET` are fine) prints that entry's `lineComments` (default `[]`).
Both honour `$QUE_FAKE_GH_FAIL` and are logged like every other call. Seed the data with
the builders in `src/testing/fakes.ts`, which use GitHub's own field names:
`fakeCheckRun({ name, conclusion?, status?, workflowName?, detailsUrl?, startedAt?, completedAt? })`
and `fakeStatusContext({ context, state, targetUrl? })` for `statusCheckRollup`;
`fakeComment({ author, body, createdAt?, url? })` and `fakeReview({ author, state, body?, submittedAt? })`
for `comments` / `reviews`; `fakeLineComment({ author, body, path, line, hunk?, createdAt? })`
for `lineComments`. A check run defaults to a completed success; times default to
2026-10-14 around 03:00 UTC.
Read the call logs back with `readFakeLog()` from `src/testing/fakes.ts` (Vitest) or `launched.ghCalls()` (E2E).

## `acli`

Appends `{ "argv": [...], "cwd": "...", "ts": "..." }` to `$QUE_FAKE_ACLI_LOG` for
every call. `jira auth status` prints the signed-in lines (`Site: example.atlassian.net`).
`jira workitem search ... --limit N` prints the first N issues of the JSON array in
`$QUE_FAKE_ACLI_TICKETS` (acli's shape; a missing file means `[]`), keeping only the
requested `--fields` (plus `id`, `key`, `self`). Like the real CLI it refuses any field outside
`issuetype, key, assignee, priority, status, summary, labels, reporter, description` with
`✗ Error: fields '<names>' are not allowed` and exit 1; `view` accepts any list. And
`jira workitem view KEY` prints the whole matching issue, whatever `--fields` says (so a child written with
`fields.parent` returns it, and an issue without one returns no `parent` key; `search` never leaks `parent`) or exits 1 with
`No work item found: KEY`. `$QUE_FAKE_ACLI_FAIL=auth` makes every call exit 1 with
`Not authenticated. Run acli jira auth login.`; `network` makes `search` and `view`
exit 1 with `dial tcp: connection refused`. Tests write the file with
`writeFakeTickets()` and build issues with `makeFakeIssue()` from `src/testing/fakes.ts`.

## `wrappers/claude`

Not a fake of a program que spawns but of something found on a user's machine:
another tool's `claude` wrapper, the kind that runs the next `claude` on `PATH`
outside its own directory. Tests put `tests/fakes/wrappers` **ahead of**
`tests/fakes/bin` (`FAKE_WRAPPERS` in `src/testing/fakes.ts`, or the harness's
`pathPrefix`) to check that que's own wrapper composes with it instead of the two
handing the command back and forth. It appends `<pid>\t<arguments>` to
`$QUE_FAKE_WRAPPER_LOG` when set (read with `readWrapperLog()`), and with
`QUE_FAKE_WRAPPER_STYLE=spawn` it runs the next `claude` as a child instead of
exec'ing it.
