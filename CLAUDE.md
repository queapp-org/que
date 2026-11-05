# que

que is an open-source macOS Electron app for running Claude Code sessions in git worktrees.
A long-running daemon owns every terminal, workspace, the status engine, and quiet hours,
so sessions outlive the app; the app and the `que` CLI are thin clients of its unix socket.

## Layout

```
src/daemon/         daemon: PtyHost (node-pty + @xterm/headless mirror), DaemonServer (socket API),
                    workspaces, status engine, quiet hours, pull requests, the sessions report
src/shared/         protocol.ts (Methods, Events, framing), client.ts (DaemonClient), paths.ts, types.ts
src/cli/            the `que` CLI (commander), a DaemonClient
src/main/           Electron main: proxies the renderer's calls and events to the daemon
src/preload/        the window.que bridge (index.d.ts is the QueApi contract)
src/renderer/src/   React UI; testing/ holds the fake bridge, fixtures, and test setup
src/testing/        node-side test code: fixtures, daemon harness, leak check, temp repo, CLI runner
tests/integration/  daemon integration tests (in-process daemon, real pty/socket/git)
tests/contract/     opt-in tests against the real Claude Code CLI
tests/e2e/          Playwright Electron specs, pages/ (page objects), utils/ (app, que, repo)
tests/fakes/bin/    fake claude, gh, code, acli (see tests/fakes/README.md)
tools/oxlint/       the vendored anti-slop oxlint rules (see its README); config in .oxlintrc.json
scripts/            build-node.mjs (daemon, CLI, client bundles), smoke.mjs, verify.mjs,
                    smoke-packaged.mjs, install-local.mjs, flake-hunt.mjs, docs generators,
                    mac-jobs.mjs (whether the macOS CI jobs run)
build/              the app icon (scripts/make-icon.mjs); electron-builder.yml packages the app
```

Path aliases: `@shared/*`, `@daemon/*`, `@renderer/*`.

## Commands

| Command                  | What it does                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| `npm run dev`            | Build the node bundles and start the app with hot reload                                              |
| `npm run build`          | Build main, preload, renderer, daemon, and CLI into `out/`                                            |
| `npm run typecheck`      | `tsc` over the node and web projects                                                                  |
| `npm run lint`           | oxlint + oxfmt check (`npm run format` writes formatting)                                             |
| `npm test`               | Vitest, both projects (`node`, `renderer`); contract tests skip                                       |
| `npm run test:contract`  | Contract tests against the real `claude` (costs a few cents)                                          |
| `npm run test:coverage`  | Vitest with v8 coverage, failing under the floor; report in `coverage/`, numbers on Unit tests runs   |
| `npm run smoke`          | Start a daemon in a temp `QUE_HOME`, run one PTY, shut down                                           |
| `npm run e2e`            | Build, then run the Playwright Electron specs                                                         |
| `npm run verify`         | All of the above in order, stopping at the first failure (CI runs the same checks, one workflow each) |
| `npm run test:flaky`     | Vitest N times (`-- 10`), the last two under e2e load; log in test-results                            |
| `npm run package`        | An unsigned `que.app` in `release/mac-arm64` (`npm run dist`: DMG + zip)                              |
| `npm run smoke:packaged` | Package, launch the real app bundle, check daemon/terminal/tray/CLI                                   |
| `npm run install:local`  | Package, replace /Applications/que.app, link `que`, reopen; daemon untouched                          |
| `npm run docs`           | Regenerate `docs/cli.md` and the config/CLI blocks in the docs                                        |

## Rules

- **Tests follow the three skills to the letter**: `.claude/skills/test-planning` (what, at
  which layer), `vitest-testing` (logic, daemon integration, renderer component tests), and
  `e2e-testing` (Playwright). Read the relevant one before writing or changing a test.
- **Fakes on PATH, never the real binaries.** Tests put `tests/fakes/bin` first on `PATH`
  (the daemon harness and `launchApp()` do it). Only `tests/contract/` may reach the real
  `claude`, and only when `QUE_CONTRACT=1`. `git` stays real, against temp repos.
- **`QUE_HOME` isolation.** Every test, script, and spec runs with `QUE_HOME` set to a fresh
  temp dir. Never touch the real `~/.que`. Stop a stray test daemon with
  `QUE_HOME=<its home> node out/cli/index.js daemon stop`, never by process name.
- **Never write to `~/.claude/settings.json`.** Hooks are passed per session with `--settings`.
- No sleeps in tests: wait on a condition (`expect.poll`, `waitFor`, an event, a CLI query).
- No mocks of internal modules, `node:child_process`, or `node:fs`; fake the subprocess or the
  `window.que` bridge instead.
- **Packaged paths.** Node-side bundles find each other through `src/shared/packaged.ts`
  (`…/que.app/Contents/Resources/{daemon,cli,client}` when packaged, `out/` otherwise);
  never import `electron` in the daemon or CLI. Keep the `runAsNode` fuse enabled.
- License: Apache-2.0. Keep third-party product names out of the repo (code, comments, docs).
- UI follows `docs/design.md`: use the tokens in `styles.css`, no new colours or fonts inline.
- `.semgrep/que.yml` holds the mechanical form of these rules; when a rule is added here, add one there.
