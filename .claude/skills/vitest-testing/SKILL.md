---
name: vitest-testing
description: Expert at writing, debugging, and fixing Vitest tests for que — daemon integration tests (real pty, sqlite, git, socket, fake claude on PATH), renderer component tests with React Testing Library against the fake window.que bridge, and pure logic tests of the status engine, the workspace digest, clock math, framing, and parsing. Use when writing daemon, CLI, shared, or renderer tests, or fixing failing Vitest tests.
allowed-tools: Read, Edit, Write, Glob, Grep, Bash(npx vitest*), Bash(npm test*), Bash(npm run test*), TodoWrite
---

# Vitest Testing Skill - que

You are an expert test engineer for que, a macOS Electron app (TypeScript strict, React 19, electron-vite) for running Claude Code sessions in git worktrees. Everything long-lived lives in the daemon (`src/daemon/`): terminals (node-pty with an `@xterm/headless` mirror), projects and workspaces (git worktrees), the status engine, Create draft PR, the sessions report, the quiet-hours clock, SQLite through `node:sqlite`, and a unix-socket API spoken in newline-delimited JSON (`src/shared/protocol.ts`). The Electron main process and the `que` CLI reach it through `DaemonClient` (`src/shared/client.ts`); the renderer reaches it only through the `window.que` bridge. You write, debug, and fix Vitest tests following strict best practices.

**Scope:** This skill covers **how** to write the three kinds of Vitest tests que needs:

- **Daemon integration tests** — the real daemon pieces in-process (a real `DaemonServer` on a temp socket, the real `DaemonClient`, real node-pty, real `node:sqlite` in a temp `QUE_HOME`, real `git` on temp repos), with the fake `claude`/`gh`/`code` binaries from `tests/fakes/bin/` on `PATH` — never a `vi.mock` of `node:child_process`.
- **Renderer component tests** — rendered with React Testing Library in jsdom against the fake `window.que` bridge (`src/renderer/src/testing/fake-bridge.ts`), an in-memory fixture book that emits the same events the real daemon would — never a `vi.mock` of a component or module.
- **Logic tests** — calling pure exports directly: status-engine reducers, the workspace digest, quiet-hours and unlock math (with an injected `now()`), protocol framing, hook and `gh` JSON decoding, config parsing and defaults, worktree naming and slugs, report formatting.

For deciding **what** to test at which layer, use the `test-planning` skill. For Playwright Electron E2E, use the `e2e-testing` skill.

---

## 1. Philosophy & Scope

### Core Principles

1. **"Write tests. Not too many. Mostly integration."** Integration tests (real daemon pieces over a real socket; real components against the fake bridge) provide the best confidence-to-cost ratio. The bulk of testing effort belongs here, with a solid layer of fast logic tests underneath for the branchy rules (status transitions, task states, clock math, framing).

2. **Fake at the subprocess and bridge boundaries, never internal modules.** que's real boundaries are the `claude`, `git`, `gh`, and `code` subprocesses, the filesystem under `QUE_HOME`, the clock, and the Electron bridge. Put the fake binaries from `tests/fakes/bin/` on `PATH` (and keep `git` real on temp repos); give every test a fresh temp `QUE_HOME`; inject `now()` into time-dependent modules; in the renderer, let `fake-bridge.ts` stand in for `window.que`. **Never mock `node:child_process`, `node:fs`, `protocol.ts`, `client.ts`, the status engine, the store, or any component.**

3. **Accessibility-first queries.** The more your tests resemble how software is used, the more confidence they give you. Prefer `getByRole` > `getByLabelText` > `getByText` > `getByTestId`.

4. **Test behavior, not implementation.** Tests verify what a client or user can observe — a socket response, an emitted event, state re-read through the API, a line of terminal text, a rendered badge — or, for logic tests, what a pure function returns. Not private fields, call counts on internal helpers, or render counts. If your tests break when you refactor without changing behavior, they tested the wrong thing.

5. **RITE tests.**
   - **R**eadable - tests document expected behavior
   - **I**solated - from other tests (not from dependencies)
   - **T**horough - cover meaningful behavioral variations
   - **E**xplicit - assertions state exactly what's expected

6. **Practical quality rules.**
   - Prefer `toBeInTheDocument()` for presence checks, `toBeVisible()` when visibility matters
   - Use unique, realistic values in fixtures to prevent false positives (a workspace named `'APP-1432-retry-logic'` with id `'ws_01hzx3k9c2qf'`, not `'test'`)
   - No if/else in tests — tests should be linear and predictable
   - Never sleep. Anything touching a PTY, a socket, or a subprocess is waited on with `waitFor`/`expect.poll` against a condition, with real timers
   - For logic tests of reducers: assert the returned state is a _new_ object and the input was left untouched — the status engine and the digest are pure functions of their input, and the suite is the cheapest place to keep them honest

---

## 2. Infrastructure Quick Reference

| Item                  | Location                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Test runner           | Vitest, `vitest.config.ts` at the repo root, two projects: `node` and `renderer`                                               |
| `node` project        | Environment `node`: `src/daemon/`, `src/cli/`, `src/shared/`, `src/testing/` logic tests, and `tests/integration/**/*.test.ts` |
| `node` setup file     | `src/testing/setup.ts`: drops the variables of the que terminal a run was started from                                         |
| `renderer` project    | Environment `jsdom`: `src/renderer/src/**/*.test.tsx`, setup file `src/renderer/src/testing/setup.ts`                          |
| Component testing     | React Testing Library (`@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom`)                   |
| Subprocess fakes      | `tests/fakes/bin/claude`, `tests/fakes/bin/gh`, `tests/fakes/bin/code` (Node scripts, executable, put first on `PATH`)         |
| Bridge fake           | `src/renderer/src/testing/fake-bridge.ts` — in-memory `window.que` with a fixture book                                         |
| Custom render wrapper | **None.** The renderer has no providers to inject — import `render` straight from `@testing-library/react`                     |
| Fixture factories     | `src/testing/fixtures.ts` (node tests), `src/renderer/src/testing/fixtures.ts` (renderer tests)                                |
| Path aliases          | `@shared/*`, `@daemon/*`, `@renderer/*`                                                                                        |
| Globals               | **Off** — import `describe`, `it`, `expect`, `vi`, … from `'vitest'` in every file                                             |
| Run all tests         | `npm test` (`vitest run`, both projects)                                                                                       |
| Run in watch mode     | `npm run test:watch`                                                                                                           |
| Run a single file     | `npx vitest run src/daemon/status-engine.test.ts`                                                                              |
| Run one project       | `npx vitest run --project renderer`                                                                                            |

Test file locations: logic tests and renderer component tests are **colocated** with the code (`status-engine.test.ts` next to `status-engine.ts`, `Sidebar.test.tsx` next to `Sidebar.tsx`); daemon integration tests live under `tests/integration/`. The first work package's tests (`tests/unit/protocol.test.ts`, `pty-host.test.ts`, `server.test.ts`) predate this layout and a single-project config — move each into place (colocated logic test, or `tests/integration/`) the first time you touch it, and don't add new files under `tests/unit/`.

### What the Renderer Setup Provides (`src/renderer/src/testing/setup.ts`)

- `@testing-library/jest-dom/vitest` matchers (`.toBeInTheDocument()`, `.toBeVisible()`, `.toHaveTextContent()`, …) — imported once, available in every renderer test
- `window.que` installed as the fake bridge's API before any test runs, so components that call `window.que.workspace.list()` or subscribe with `window.que.workspace.on('workspace.status', …)` hit the fixture book
- `afterEach(() => { cleanup(); fakeBridge.reset() })` — unmounts every rendered tree, drops every subscription, and empties the fixture book, so tests never leak state into each other

The `node` project has **no** global setup: each daemon integration test builds its own temp `QUE_HOME`, socket, and `PATH` (Section 5a), so nothing is shared between files.

### The Fake Bridge (`src/renderer/src/testing/fake-bridge.ts`)

| Export                         | What it does                                                                                                                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fakeBridge.api`               | The in-memory `QueApi` (`term.*`, `workspace.*`, `report.*`, `quiet.*`, `app.*`) installed as `window.que` by `setup.ts`. Types come from `src/preload/index.d.ts`, so it can't drift silently. |
| `fakeBridge.seedWorkspace(ws)` | Puts a workspace in the book **silently** — state "already in the daemon" when the component first asks. Call **before** `render()`.                                                            |
| `fakeBridge.setStatus(id, s)`  | Updates a workspace's status **and emits** `workspace.status`, exactly as the daemon's status engine would. Call before render to seed, or after render to drive a live update.                 |
| `fakeBridge.setQuietState(q)`  | Updates the quiet-hours state **and emits** `quiet.state` (active, window, unlock deadline).                                                                                                    |
| `fakeBridge.getWorkspace(id)`  | Reads the book back — to assert that a UI action reached the "daemon" (Section 5b).                                                                                                             |
| `fakeBridge.reset()`           | Empties the book and drops listeners. Called by `setup.ts`'s `afterEach`; never call it mid-test.                                                                                               |

### The Subprocess Fakes (`tests/fakes/bin/`)

| Binary   | Behavior                                                                                                                                                                                                                                                                                                                                                             |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude` | An interactive session only: honours `--settings` (runs the configured hook commands with realistic hook JSON on stdin), `--session-id`, `--resume`, `--permission-mode`; also `claude agents --json`. Driven by what is typed into its terminal: a prompt runs a turn, `/needs-input` asks for permission, `/background` and `/exit` (see `tests/fakes/README.md`). |
| `gh`     | Appends each invocation's argv to `QUE_FAKE_GH_LOG` (one JSON array per line) and prints a fake PR URL for `gh pr create`.                                                                                                                                                                                                                                           |
| `code`   | Records its invocation the same way, so "open in VS Code" is assertable without launching an editor.                                                                                                                                                                                                                                                                 |

### Fixture Factories

| Export (file)                                     | What it does                                                                                                                                                          |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `makeWorkspace(overrides)` (both)                 | A realistic workspace: opaque id (`ws_01h…`), branch-style name (`APP-1432-retry-logic`), worktree path under `~/.que/worktrees/<project>/<name>`, status `idle`.     |
| `makeHookEvent(name, overrides)` (`src/testing`)  | A realistic Claude Code hook payload: `hook_event_name`, `session_id`, `cwd`, `transcript_path`, plus per-event fields (`notification_type`, `message`, `tool_name`). |
| `makeWorkspaceDigest(overrides)` (`src/renderer`) | What one session did in the report window: working time, needs-input count, `waitingSince`, stuck count, commits ahead, pull request.                                 |
| `makeConfig(overrides)` (`src/testing`)           | A fully-defaulted config (quiet window, stall timeout) for logic tests.                                                                                               |

---

## 3. Test File Imports

Every test file should follow this canonical import structure.

```tsx
// 1. Test framework — globals are NOT enabled, import everything explicitly
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// 2. Node built-ins (integration tests only)
import fs from 'node:fs'
import os from 'node:os'
import { join, resolve } from 'node:path'

// 3. Testing Library utilities (renderer tests only)
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// 4. Fakes and fixtures
import { fakeBridge } from '@renderer/testing/fake-bridge'
import { makeWorkspace } from '@renderer/testing/fixtures'

// 5. Real modules the test drives (never mocked)
import { DaemonClient } from '@shared/client'
import { DaemonServer } from '@daemon/server'

// 6. Unit under test
import { Sidebar } from './Sidebar'
```

**Key rules:**

- Import `render`, `screen`, and `waitFor` directly from `@testing-library/react` — there is no custom wrapper, because there are no providers to inject.
- Import `userEvent` from `@testing-library/user-event`, never `fireEvent`.
- Import `fakeBridge` only in renderer tests that seed or inspect the book — `setup.ts` already installs it, so a test that only renders an empty state needs no import at all.
- Cross-directory imports use the `@shared/*`, `@daemon/*`, `@renderer/*` aliases; same-directory imports (`./Sidebar`, `./status-engine`) stay relative. `src/testing/fixtures.ts` has no alias — import it relatively.
- Vitest globals are **off** — every file needs its own `import { describe, it, expect, ... } from 'vitest'`, even though jest-dom matchers are wired up globally for the renderer.
- A renderer test never imports from `@daemon/*`, and a daemon test never imports from `@renderer/*`. The protocol types in `@shared/protocol` are the only thing both sides share.

---

## 4. Rendering Components

### There Is No Custom `render()` — And That's Correct

The renderer has no context providers to thread through a tree: components talk to `window.que`, and `setup.ts` has already installed the fake there. Plain `render()` is always sufficient:

```tsx
render(<Sidebar />)
await screen.findByRole('navigation', { name: 'Workspaces' }) // waits out the first bridge round trip
```

### Seed the Fixture Book Before Render

Components load their initial state with an async bridge call (`window.que.workspace.list()`), then subscribe to events. Seed the book **before** `render()` so the first call returns it; the book starts empty in every test.

```tsx
import { render, screen } from '@testing-library/react'
import { fakeBridge } from '@renderer/testing/fake-bridge'
import { makeWorkspace } from '@renderer/testing/fixtures'
import { Sidebar } from './Sidebar'

it('lists each workspace under its project with a status badge', async () => {
  fakeBridge.seedWorkspace(
    makeWorkspace({
      id: 'ws_01hzx3k9c2qf',
      project: 'que',
      name: 'APP-1432-retry-logic',
      status: 'working'
    })
  )
  fakeBridge.seedWorkspace(
    makeWorkspace({
      id: 'ws_01hzx4m1p8rt',
      project: 'que',
      name: 'APP-1440-quiet-board',
      status: 'idle'
    })
  )

  render(<Sidebar />)

  expect(await screen.findByRole('button', { name: /APP-1432-retry-logic/ })).toBeInTheDocument()
  expect(screen.getByTestId('sidebar-workspace-ws_01hzx3k9c2qf-status')).toHaveTextContent(
    'working'
  )
  expect(screen.getByTestId('sidebar-workspace-ws_01hzx4m1p8rt-status')).toHaveTextContent('idle')
})
```

For a pure logic test that renders nothing, build inputs with the factories in `src/testing/fixtures.ts` instead (Section 6).

### Driving a Live Update After Render

The daemon pushes events; the fake bridge pushes the same ones. `setStatus` and `setQuietState` emit, so calling them **after** render is how a test proves the component reacts to the daemon:

```tsx
it('moves the badge to needs input when the status engine says so', async () => {
  fakeBridge.seedWorkspace(
    makeWorkspace({ id: 'ws_01hzx3k9c2qf', name: 'APP-1432-retry-logic', status: 'working' })
  )
  render(<Sidebar />)
  const badge = await screen.findByTestId('sidebar-workspace-ws_01hzx3k9c2qf-status')

  fakeBridge.setStatus('ws_01hzx3k9c2qf', 'needs_input')

  await waitFor(() => {
    expect(badge).toHaveTextContent('needs input')
  })
})
```

Seeding (`seedWorkspace`) is silent and belongs before `render()`; emitting (`setStatus`, `setQuietState`) is an event and belongs wherever the scenario says the daemon would send it. Don't confuse the two (Common Mistake #6).

### Components That Take Props

Some leaf components (a status badge, a report row) take plain props rather than calling the bridge. Render them with props built from the renderer fixtures — no harness, no bridge:

```tsx
render(
  <ReportRow
    digest={makeWorkspaceDigest({
      id: 'ws_01hzx3k9c2qf',
      pr: makePullRequest({ number: 88, url: 'https://github.com/rquellh/que/pull/88' })
    })}
  />
)
expect(screen.getByRole('link', { name: /#88/ })).toHaveAttribute(
  'href',
  'https://github.com/rquellh/que/pull/88'
)
```

Don't build a general-purpose wrapper around either pattern; write the two or three lines each test needs.

---

## 5. Daemon, Bridge & State Patterns

This is the most important section — it covers running the daemon in-process against real resources, asserting through the bridge, waiting on time, driving the fake binaries, and testing the pure core directly.

### (a) Running the Daemon In-Process

A daemon integration test builds everything it needs in a fresh temp dir and tears it down afterwards. Prepend `tests/fakes/bin` to `PATH` with `vi.stubEnv` so every subprocess the daemon spawns finds the fakes first (child processes inherit `process.env`), and point `QUE_HOME` at the temp dir so SQLite, sockets, and worktrees land there:

```ts
import fs from 'node:fs'
import os from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonClient } from '@shared/client'
import { DaemonServer } from '@daemon/server'
import { PtyHost } from '@daemon/pty-host'

const FAKES_BIN = resolve(__dirname, '../fakes/bin')

let home: string
let host: PtyHost
let server: DaemonServer
let client: DaemonClient

beforeEach(async () => {
  home = fs.mkdtempSync(join(os.tmpdir(), 'que-it-'))
  vi.stubEnv('QUE_HOME', home)
  vi.stubEnv('PATH', `${FAKES_BIN}:${process.env.PATH}`)
  host = new PtyHost()
  server = new DaemonServer({ host, version: 'test', onShutdown: () => {} })
  await server.listen(join(home, 'que.sock'))
  client = new DaemonClient(join(home, 'que.sock'))
  await client.connect()
})

afterEach(async () => {
  client.close()
  host.killAll()
  await server.close()
  vi.unstubAllEnvs()
  fs.rmSync(home, { recursive: true, force: true })
})
```

Seed state the way a client would — through `client.request(...)` — or by building a real git repo in the temp dir (`git init`, two commits, a `que.toml`) with `execFileSync('git', [...])`. Never write rows into SQLite behind the daemon's back, and never `vi.mock` anything the daemon imports. When a second test file needs the same harness, extract it into `src/testing/` rather than copying it a third time.

### (b) Asserting a Write Landed

**Daemon:** re-read through the API, not the database. If the method persisted something, a second request (or a fresh `DaemonClient`) proves it:

```ts
it('creates a workspace as a git worktree on its own branch', async () => {
  const repo = makeTempRepo(home) // real git: two commits on main
  const { id: projectId } = await client.request('project.add', { path: repo })

  const ws = await client.request('workspace.create', { projectId, name: 'APP-1432-retry-logic' })

  expect(ws.branch).toBe('APP-1432-retry-logic')
  expect(fs.existsSync(join(ws.path, '.git'))).toBe(true)
  const listed = await client.request('workspace.list', { projectId })
  expect(listed.map((w) => w.id)).toContain(ws.id)
})
```

**Renderer:** read the fixture book back with `fakeBridge.getWorkspace(id)`. The UI update may be instant, but the bridge call is a real promise, so wrap the assertion in `waitFor`:

```tsx
it('archives a workspace from its context menu', async () => {
  const user = userEvent.setup()
  fakeBridge.seedWorkspace(makeWorkspace({ id: 'ws_01hzx3k9c2qf', name: 'APP-1432-retry-logic' }))
  render(<Sidebar />)

  await user.click(
    await screen.findByRole('button', { name: /more actions for APP-1432-retry-logic/i })
  )
  await user.click(screen.getByRole('menuitem', { name: 'Archive' }))

  await waitFor(() => {
    expect(fakeBridge.getWorkspace('ws_01hzx3k9c2qf')?.archived).toBe(true)
  })
})
```

### (c) Time: Real Timers Near I/O, an Injected Clock Everywhere Else

que is full of time: PTY output arrives when it arrives, the stall timeout marks a session stuck when it goes quiet, quiet hours and the unlock window follow the wall clock. Two rules cover all of it:

1. **Anything touching a PTY, a socket, or a subprocess runs on real timers** and waits on a condition with `waitFor` or `expect.poll`, with an explicit timeout and a per-test timeout above it. `vi.useFakeTimers()` freezes the timers node-pty, `net`, and `child_process` rely on, and the test hangs or passes for the wrong reason.
2. **Modules that decide things based on time take an injected `now()`** (the quiet-hours clock, the unlock window, the stall detector). Logic tests pass a fixed clock; integration tests pass short durations (a 1s stall timeout from config) instead of rewinding time.

```ts
it('replays the screen to a client that attaches after the output was written', async () => {
  const { id } = await client.request('term.create', {
    cols: 80,
    rows: 24,
    file: '/bin/sh',
    args: ['-c', 'printf QUE_ATTACH_7f3a; sleep 30']
  })

  await expect
    .poll(async () => (await client.request('term.snapshot', { id })).text, { timeout: 10_000 })
    .toContain('QUE_ATTACH_7f3a')

  const late = new DaemonClient(join(home, 'que.sock'))
  await late.connect()
  const { snapshot } = await late.request('term.attach', { id, cols: 80, rows: 24 })
  expect(snapshot).toContain('QUE_ATTACH_7f3a')
  late.close()
}, 20_000)
```

```ts
it('marks a silent working session stuck', async () => {
  // file-local helper: temp repo + project.add + workspace.create, stall_timeout_minutes = 0.02
  const ws = await createWorkspace(client, home)
  await client.request('hook.event', {
    workspaceId: ws.id,
    payload: makeHookEvent('UserPromptSubmit', { prompt: 'Add retry logic to the uploader' })
  })

  await expect
    .poll(async () => (await client.request('workspace.get', { id: ws.id })).status, {
      timeout: 10_000
    })
    .toBe('stuck')
}, 20_000)
```

Fake timers are allowed **only** in pure logic tests with no I/O at all, and even there an injected `now()` is preferred — it makes the input visible in the test instead of hidden in global state.

### (d) Driving the Fake Binaries

The fakes are the contract with the outside world; their knobs and call logs are all environment, so `vi.stubEnv` is the only tool needed, and the fake `claude` is driven by typing into its terminal like the real one.

```ts
it('opens a draft PR through gh for a workspace with work in it', async () => {
  const ghLog = join(home, 'gh.log')
  vi.stubEnv('QUE_FAKE_GH_LOG', ghLog)
  const ws = await createWorkspace(client, home)
  fs.writeFileSync(join(ws.path, 'retry.ts'), 'export const retries = 3\n')

  const { prUrl } = await client.request('workspace.createPr', {
    id: ws.id,
    title: 'Add retry logic to the uploader'
  })

  const calls = fs
    .readFileSync(ghLog, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l).argv as string[])
  expect(calls).toContainEqual(expect.arrayContaining(['pr', 'create', '--draft']))
  expect(prUrl).toMatch(/^https:\/\/github\.com\/.+\/pull\/\d+$/)
}, 30_000)
```

The same pattern covers a live session: open a workspace terminal, type `claude\r`, then `/needs-input\r` → the fake runs the `Notification` hook with `notification_type: 'permission_prompt'`, and the workspace status becomes `needs_input`; `/background subagent` → a Stop that keeps it working. One integration test per path proves the wiring; the branch logic behind each outcome belongs in logic tests.

### (e) Logic Tests: Reducers, State Machines, Clock Math, Framing

Pure modules are tested directly, no sockets, no processes, no DOM. For reducers, check two things every time: the _shape_ of the returned state, and that **the input was not mutated**. Module paths in these examples are illustrative where the module is named differently; use the real path.

```ts
import { describe, it, expect } from 'vitest'
import { applyHookEvent, checkStall, initialStatus } from './status-engine'
import { makeHookEvent } from '../testing/fixtures'

const T0 = new Date(2026, 9, 13, 22, 0).getTime()

describe('applyHookEvent', () => {
  it('goes idle on Stop without mutating the previous state', () => {
    const prev = {
      ...initialStatus('ws_01hzx3k9c2qf'),
      status: 'working' as const,
      lastEventAt: T0
    }
    const before = structuredClone(prev)

    const next = applyHookEvent(
      prev,
      makeHookEvent('Stop', { session_id: 'sess_8c1d2e' }),
      T0 + 5_000
    )

    expect(next.status).toBe('idle')
    expect(prev).toEqual(before) // the reducer never touched its argument
    expect(next).not.toBe(prev) // a genuinely new object came back
  })

  it('needs input on a permission prompt notification', () => {
    const prev = {
      ...initialStatus('ws_01hzx3k9c2qf'),
      status: 'working' as const,
      lastEventAt: T0
    }

    const next = applyHookEvent(
      prev,
      makeHookEvent('Notification', {
        notification_type: 'permission_prompt',
        message: 'Claude needs your permission to use Bash'
      }),
      T0 + 1_000
    )

    expect(next.status).toBe('needs_input')
  })
})

describe('checkStall', () => {
  it('marks a working session stuck once no event has arrived for the stall timeout', () => {
    const working = {
      ...initialStatus('ws_01hzx3k9c2qf'),
      status: 'working' as const,
      lastEventAt: T0
    }

    expect(checkStall(working, T0 + 299_000, { stallMs: 300_000 }).status).toBe('working')
    expect(checkStall(working, T0 + 300_000, { stallMs: 300_000 }).status).toBe('stuck')
  })
})
```

```ts
import { describe, it, expect } from 'vitest'
import { isQuiet, applyScheduleEdit } from './quiet-hours'
import { makeConfig } from '../testing/fixtures'

// Quiet hours are wall-clock local time: build dates with the local constructor,
// never ISO strings ending in Z.
const at = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m).getTime()

describe('isQuiet', () => {
  it('handles a window that crosses midnight', () => {
    const config = makeConfig({ quiet: { start: '22:00', end: '07:00' } })

    expect(isQuiet(config, at(13, 21, 59))).toBe(false)
    expect(isQuiet(config, at(13, 23, 30))).toBe(true)
    expect(isQuiet(config, at(14, 6, 59))).toBe(true)
    expect(isQuiet(config, at(14, 7, 0))).toBe(false)
  })

  it('lets a per-day override replace the default window', () => {
    const config = makeConfig({
      quiet: { start: '22:00', end: '07:00', overrides: { fri: { start: '23:30', end: '09:00' } } }
    })

    expect(isQuiet(config, at(16, 22, 30))).toBe(false) // Friday 16 Oct 2026
  })
})

describe('applyScheduleEdit', () => {
  it('never shortens the window already in progress; the edit applies tonight', () => {
    const config = makeConfig({ quiet: { start: '22:00', end: '07:00' } })

    const next = applyScheduleEdit(config, { start: '22:00', end: '05:00' }, at(14, 2, 0))

    expect(isQuiet(next, at(14, 6, 0))).toBe(true) // still tonight's original window
    expect(isQuiet(next, at(15, 6, 0))).toBe(false) // the new window from tonight on
  })
})
```

```ts
import { describe, it, expect } from 'vitest'
import { buildWorkspaceDigest } from './digest'
import { makeWorkspace } from '../testing/fixtures'

describe('buildWorkspaceDigest', () => {
  it('sums the time worked and counts the times it asked for input', () => {
    const ws = makeWorkspace({ status: 'idle', statusAt: '2026-10-14T00:02:00.000Z' })
    const log = [
      { status: 'working', reason: null, at: '2026-10-13T23:00:00.000Z' },
      { status: 'needs_input', reason: null, at: '2026-10-13T23:20:00.000Z' },
      { status: 'working', reason: null, at: '2026-10-13T23:25:00.000Z' },
      { status: 'idle', reason: null, at: '2026-10-14T00:02:00.000Z' }
    ] as const

    const digest = buildWorkspaceDigest(
      ws,
      PROJECT,
      [...log],
      Date.parse('2026-10-13T22:00:00.000Z'),
      Date.parse('2026-10-14T07:30:00.000Z')
    )

    expect(digest).toMatchObject({
      workingMs: (20 + 37) * 60_000,
      needsInputCount: 1,
      stuckCount: 0
    })
  })
})
```

Protocol framing is already the model for this layer — feed `LineSplitter`/`MessageDecoder` arbitrary chunk boundaries, one byte at a time for multi-byte UTF-8, and malformed lines between good ones, and assert on exactly what comes out:

```ts
import { describe, it, expect } from 'vitest'
import { LineSplitter } from './protocol'

it('splits lines across arbitrary chunk boundaries', () => {
  const s = new LineSplitter()
  expect(s.push('{"id":1,"method":"term.')).toEqual([])
  expect(s.push('list"}\n{"id":2')).toEqual(['{"id":1,"method":"term.list"}'])
  expect(s.pending).toBe('{"id":2')
})
```

---

## 6. Mock Data Patterns

Fixtures are plain objects from factory functions typed against the real types (`@shared/protocol`, the daemon's config types). The factory signature is the one place in this layer worth annotating by hand; test bodies stay annotation-free and let inference flow from it. Shared factories live in `src/testing/fixtures.ts` (node) and `src/renderer/src/testing/fixtures.ts` (renderer); keep one-off variants at file scope in the test that needs them.

### Hook Event Factory

Hook payloads are what Claude Code actually sends on stdin. Keep them realistic so the status engine is tested against the real shape:

```ts
import type { HookEvent, HookEventName } from '@shared/protocol'

let sessionCounter = 0

/** A realistic Claude Code hook payload. Per-event fields go in overrides. */
export function makeHookEvent(name: HookEventName, overrides: Partial<HookEvent> = {}): HookEvent {
  sessionCounter += 1
  const sessionId = overrides.session_id ?? `sess_${sessionCounter.toString(16).padStart(6, '0')}`
  return {
    hook_event_name: name,
    session_id: sessionId,
    cwd: '/Users/dev/.que/worktrees/que/APP-1432-retry-logic',
    transcript_path: `/Users/dev/.claude/projects/-Users-dev--que-worktrees-que-APP-1432-retry-logic/${sessionId}.jsonl`,
    permission_mode: 'default',
    ...overrides
  }
}
```

### Workspace Digest Factory

```ts
import type { WorkspaceDigest } from '@shared/types'

/** What one session did in the report window: an idle session that worked 42 minutes. */
export function makeWorkspaceDigest(overrides: Partial<WorkspaceDigest> = {}): WorkspaceDigest {
  const name = overrides.name ?? 'app-1432-retry-logic'
  return {
    id: 'ws_01hzx3k9c2qf',
    name,
    project: 'uploader',
    branch: name,
    status: 'idle',
    statusReason: null,
    firstActivityAt: '2026-10-14T01:00:00.000Z',
    lastActivityAt: '2026-10-14T01:42:00.000Z',
    workingMs: 42 * 60_000,
    needsInputCount: 0,
    waitingSince: null,
    stuckCount: 0,
    commitsAhead: 2,
    pr: null,
    sessionId: null,
    ...overrides
  }
}
```

### Workspace Factory

```ts
import type { WorkspaceInfo } from '@shared/protocol'

let wsCounter = 0

export function makeWorkspace(overrides: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  wsCounter += 1
  const name = overrides.name ?? `HA-${1430 + wsCounter}-retry-logic`
  const project = overrides.project ?? 'que'
  return {
    id: `ws_01hzx${wsCounter.toString(36).padStart(7, '0')}`,
    project,
    name,
    branch: name,
    path: `/Users/dev/.que/worktrees/${project}/${name}`,
    status: 'idle',
    archived: false,
    createdAt: '2026-10-13T21:04:00.000Z',
    ...overrides
  }
}
```

### Variant Fixtures for Edge Cases

Name fixtures for the case they represent, same as any other test data:

```ts
const waitingSession = makeWorkspaceDigest({
  status: 'needs_input',
  needsInputCount: 1,
  waitingSince: '2026-10-14T02:14:00.000Z'
})
const stuckSession = makeWorkspaceDigest({
  status: 'stuck',
  statusReason: 'no_heartbeat',
  stuckCount: 1
})
const idlePrompt = makeHookEvent('Notification', {
  notification_type: 'idle_prompt',
  message: 'Claude is waiting for your input'
})
```

### The Identity Invariants Fixtures Must Respect

- Workspaces and terminals are identified by **opaque ids minted by the daemon** (`ws_…`, terminal ids). Every lookup, testid, and assertion keys by id, never by name — two projects can each have a workspace called `APP-1432-retry-logic`.
- A workspace's branch name and worktree directory derive from its name through the slug rules; a fixture whose `branch` or `path` disagrees with its `name` is lying about a state the daemon can't produce. Override `name` and let the factory derive the rest, unless the test is about the derivation itself.

---

## 7. User Interactions

### Always Use `userEvent.setup()`

```tsx
it('opens a new terminal tab when the plus button is clicked', async () => {
  const user = userEvent.setup()
  fakeBridge.seedWorkspace(makeWorkspace({ id: 'ws_01hzx3k9c2qf' }))
  render(<TerminalTabs workspaceId="ws_01hzx3k9c2qf" />)

  await user.click(await screen.findByRole('button', { name: 'New terminal' }))

  expect(await screen.findAllByRole('tab')).toHaveLength(1)
})
```

**NEVER use `fireEvent`.** Always use `userEvent`, which simulates the real sequence of events (focus, pointerdown, click, keyup) rather than dispatching a single synthetic event.

### Common Interactions

```tsx
const user = userEvent.setup()

// Click
await user.click(screen.getByRole('button', { name: 'Unlock for 15 minutes' }))

// Clear and retype
await user.clear(screen.getByLabelText('Quiet hours start'))
await user.type(screen.getByLabelText('Quiet hours start'), '22:30')

// Native <select>
await user.selectOptions(screen.getByLabelText('Unlock duration'), '30')

// Checkbox
await user.click(screen.getByRole('checkbox', { name: 'Morning summary' }))

// Keyboard
await user.keyboard('{Meta>}t{/Meta}')
```

---

## 8. Query Priority

### RTL Query Priority Table

Use the highest-priority query that works for your case:

| Priority | Query                  | When to Use                                                      |
| -------- | ---------------------- | ---------------------------------------------------------------- |
| 1        | `getByRole`            | Buttons, tabs, menu items, headings, inputs, selects, checkboxes |
| 2        | `getByLabelText`       | Form fields with a `<label htmlFor>`                             |
| 3        | `getByPlaceholderText` | Inputs identified only by placeholder                            |
| 4        | `getByText`            | Non-interactive text content                                     |
| 5        | `getByDisplayValue`    | Inputs identified by their current value                         |
| 6        | `getByTestId`          | Only when no semantic query works                                |

### When `getByTestId` Is Correct

- Elements identified by an opaque entity id with no unique visible text — a status badge inside `sidebar-workspace-<id>`, a row in `report-workspace-<id>`
- Text that is legitimately duplicated (every badge says `idle`; two projects both have a `APP-1432-retry-logic`)

The testid pattern is shared with the E2E suite: `{component}-{entity-id?}-{element}`, keyed by the daemon's ids (`sidebar-workspace-<id>-status`, `terminal-tab-<id>`, `quiet-board-unlock`).

### The Terminal Quirk

xterm.js renders to a canvas (with the webgl addon) that jsdom cannot draw, and its accessibility tree is not the screen. **Never assert terminal _content_ in a renderer test.** Assert the chrome around it — the tab, its name, the `exited` / `reattached` badges, the empty state — and prove content where it is real:

- In daemon integration tests, through `client.request('term.snapshot', { id })`'s `text` (the `@xterm/headless` mirror) — Section 5c.
- In E2E, through `window.__que.screenText()` — see the `e2e-testing` skill.

---

## 9. Assertions & Waiting

### Sync Assertions (Immediate)

Use for elements already in the DOM after a synchronous render or state update:

```tsx
expect(screen.getByRole('dialog', { name: 'Quiet hours' })).toBeInTheDocument()
expect(screen.getByRole('button', { name: 'Unlock for 15 minutes' })).toBeDisabled()
```

### Async Assertions with `waitFor`

Use when something appears after async work — a bridge promise, an emitted event:

```tsx
await waitFor(() => {
  expect(screen.getByTestId('quiet-board')).toBeVisible()
})
```

### `expect.poll` for the Daemon

In daemon integration tests there is no DOM to wait on; poll the API instead. `expect.poll` retries the async getter until the matcher passes or the timeout expires, and its failure message shows the last value seen:

```ts
await expect
  .poll(async () => (await client.request('workspace.get', { id })).status, { timeout: 15_000 })
  .toBe('needs_input')
```

Prefer waiting on an **event** when the method emits one and the test already subscribes; prefer `expect.poll` over a re-request when it doesn't. Never a hand-rolled `while` loop with `setTimeout` — the first work package's `server.test.ts` has one; replace it with `expect.poll` when you move that file.

### `waitFor` vs `findBy*`

Both wait for async elements; `findBy*` is shorthand for `waitFor` + `getBy*`:

```tsx
// Equivalent:
await waitFor(() => {
  expect(screen.getByText('APP-1432-retry-logic')).toBeInTheDocument()
})

const el = await screen.findByText('APP-1432-retry-logic')
expect(el).toBeInTheDocument()
```

**Prefer `waitFor` when:**

- You need multiple assertions after the wait
- You're waiting for something to _disappear_
- You need a custom timeout

### Negative Assertions with `queryBy*`

```tsx
// CORRECT - queryBy returns null when not found
expect(screen.queryByTestId('quiet-board')).not.toBeInTheDocument()

// WRONG - getBy throws when not found, crashing the test before the assertion runs
expect(screen.getByTestId('quiet-board')).not.toBeInTheDocument() // THROWS!
```

### Negative Async Assertions

```tsx
// The quiet board goes away when the unlock window opens
fakeBridge.setQuietState({ active: true, unlockedUntil: Date.now() + 15 * 60_000 })
await waitFor(() => {
  expect(screen.queryByTestId('quiet-board')).not.toBeInTheDocument()
})
```

### Common Matchers Reference

| Matcher                            | Use For                                        |
| ---------------------------------- | ---------------------------------------------- |
| `.toBeInTheDocument()`             | Element exists in DOM                          |
| `.toBeVisible()`                   | Element exists AND is visible to the user      |
| `.toHaveTextContent('text')`       | Element contains text                          |
| `.toHaveValue('value')`            | Input has value                                |
| `.toBeDisabled()`                  | Button/input is disabled                       |
| `.toBeChecked()`                   | Checkbox is checked                            |
| `.toHaveAttribute('attr', 'val')`  | Element has an HTML attribute                  |
| `.toMatchObject({...})`            | Socket result / row carries these fields       |
| `.toContainEqual(...)`             | A recorded fake-binary call is in the log      |
| `.rejects.toMatchObject({ code })` | A daemon request fails with a structured error |
| `.not.toBeInTheDocument()`         | Element does NOT exist (use with `queryBy`)    |

---

## 10. Mocking & Spying

With the fake binaries, the fake bridge, temp dirs, and an injected clock, almost nothing else needs faking. What remains:

### Environment

`vi.stubEnv` is the only way to set `QUE_HOME`, `PATH`, `QUE_FAKE_CLAUDE_TITLE`, `QUE_FAKE_GH_LOG`, and friends, and `vi.unstubAllEnvs()` in `afterEach` restores them. Never assign `process.env.X = …` directly — it leaks into the next test file in the same worker.

### Spying on Console Methods

Only when the code under test _intentionally_ logs (the daemon logging a malformed line from a client, say) — check the code first rather than assuming a call site exists:

```ts
it('logs and survives a malformed line from a client', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

  // ... write "not json\n" to the socket, then a valid request ...

  expect(warn).toHaveBeenCalledWith(expect.stringContaining('not json'))
  warn.mockRestore()
})
```

### Callbacks the Test Owns

`vi.fn()` is fine for a callback the **test** passes in (an `onClose` prop, the `onShutdown` option of `DaemonServer`) — that is the test standing in for the caller, not a mock of an internal module.

That's the extent of it — no `vi.mock` of any module, no stubbed `child_process`, no fake filesystem, no global fake timers near I/O.

---

## 11. Test File Structure

### Canonical Ordering — Renderer Component Test

```tsx
// ── Imports ──────────────────────────────────
import { describe, it, expect } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { fakeBridge } from '@renderer/testing/fake-bridge'
import { makeWorkspace } from '@renderer/testing/fixtures'
import { QuietBoard } from './QuietBoard'

// ── File-scope fixtures (only what this file needs) ──
const retryLogic = makeWorkspace({
  id: 'ws_01hzx3k9c2qf',
  name: 'APP-1432-retry-logic',
  status: 'working'
})

// ── Test Suites ──────────────────────────────
describe('QuietBoard', () => {
  describe('rendering', () => {
    /* ... */
  })
  describe('status updates', () => {
    /* ... */
  })
  describe('unlock', () => {
    /* ... */
  })
  describe('empty state', () => {
    /* ... */
  })
})
```

### Canonical Ordering — Daemon Integration Test

```ts
// ── Imports ──────────────────────────────────
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonClient } from '@shared/client'
import { DaemonServer } from '@daemon/server'

// ── Harness (temp QUE_HOME, PATH with fakes, server, client) ──
beforeEach(async () => {
  /* ... */
})
afterEach(async () => {
  /* ... */
})

// ── File-local helpers (createWorkspace, makeTempRepo) ──

// ── Test Suites ──────────────────────────────
describe('hooks', () => {
  describe('status', () => {
    /* ... */
  })
  describe('needs input', () => {
    /* ... */
  })
  describe('background tasks', () => {
    /* ... */
  })
  describe('stall', () => {
    /* ... */
  })
})
```

### Canonical Ordering — Logic Test

```ts
// ── Imports ──────────────────────────────────
import { describe, it, expect } from 'vitest'
import { applyHookEvent, initialStatus } from './status-engine'
import { makeHookEvent } from '../testing/fixtures'

// ── Test Suites ──────────────────────────────
describe('applyHookEvent', () => {
  describe('transitions', () => {
    /* ... */
  })
  describe('stale session ids', () => {
    /* ... */
  })
  describe('purity', () => {
    /* ... */
  }) // input-not-mutated assertions
})
```

### Naming Conventions

- **Test files:** Logic and renderer tests colocated with the code: `status-engine.test.ts`, `protocol.test.ts`, `Sidebar.test.tsx`, `QuietBoard.test.tsx`. Integration tests under `tests/integration/` named for the capability: `terminals.test.ts`, `workspaces.test.ts`, `hooks.test.ts`, `prs.test.ts`, `cli.test.ts`
- **Describe blocks:** Name of the component, function, or capability: `describe('Sidebar', ...)`, `describe('buildWorkspaceDigest', ...)`, `describe('hooks', ...)`
- **Nested describes:** Behavioral groupings: `describe('needs input', ...)`, `describe('rendering', ...)`
- **Test names:** Describe observable behavior: `it('marks a session needs input when claude asks for permission', ...)`

### Standard Behavioral Describe Groupings

| Grouping            | When to Use                                                     |
| ------------------- | --------------------------------------------------------------- |
| `rendering`         | Static rendering, initial state, layout                         |
| `status updates`    | UI reacting to `workspace.status` / `quiet.state` events        |
| `user interactions` | Clicks, typing, selecting, and the bridge calls they make       |
| `transitions`       | Reducer / state-machine steps                                   |
| `clock`             | Behavior that depends on `now()` (quiet window, unlock, stall)  |
| `sessions`          | One per fake `claude` session path in a hooks integration test  |
| `errors`            | Structured daemon errors, crashes, malformed input, disconnects |
| `purity`            | Input-not-mutated checks on pure reducers                       |

---

## 12. Testing Hooks

Renderer hooks that wrap a bridge call and an event subscription are best tested through the component that uses them. Reach for `renderHook` only when a hook is shared by several components and you need to assert on its return value directly:

```tsx
import { act, renderHook, waitFor } from '@testing-library/react'
import { fakeBridge } from '@renderer/testing/fake-bridge'
import { makeWorkspace } from '@renderer/testing/fixtures'
import { useWorkspaces } from './useWorkspaces'

it('reflects a status event pushed after the first load', async () => {
  fakeBridge.seedWorkspace(makeWorkspace({ id: 'ws_01hzx3k9c2qf', status: 'working' }))
  const { result } = renderHook(() => useWorkspaces())
  await waitFor(() => expect(result.current).toHaveLength(1))

  act(() => {
    fakeBridge.setStatus('ws_01hzx3k9c2qf', 'done')
  })

  await waitFor(() => expect(result.current[0].status).toBe('done'))
})
```

An event emitted from the test (rather than through `userEvent`) triggers a React state update outside React's own handlers, so wrap it in `act()` when the test reads `result.current` directly. `render`, `userEvent`, `waitFor`, and `findBy*` already handle `act()` for you.

---

## 13. Common Mistakes

### 1. Inventing a Custom Render Wrapper

```tsx
// WRONG - the renderer has no providers, so there's nothing to wrap
import { render } from '@renderer/testing/render-with-providers' // doesn't exist, don't create it

// CORRECT - render straight from Testing Library; setup.ts already installed the bridge
import { render } from '@testing-library/react'
```

### 2. Using `fireEvent` Instead of `userEvent`

```tsx
// WRONG - synthetic event, skips the realistic event sequence
fireEvent.click(button)

// CORRECT - simulates the real event sequence
const user = userEvent.setup()
await user.click(button)
```

### 3. Using `getBy` for Negative Assertions

```tsx
// WRONG - getBy throws if not found, crashing the test
expect(screen.getByTestId('quiet-board')).not.toBeInTheDocument()

// CORRECT - queryBy returns null if not found
expect(screen.queryByTestId('quiet-board')).not.toBeInTheDocument()
```

### 4. Sleeping Instead of Waiting

```ts
// WRONG - guesses how long the daemon takes; flaky under load, slow when idle
await client.request('term.write', { id: termId, data: '/needs-input\r' })
await new Promise((r) => setTimeout(r, 2000))
expect((await client.request('workspace.get', { id })).status).toBe('needs_input')

// CORRECT - wait on the condition, with real timers
await expect
  .poll(async () => (await client.request('workspace.get', { id })).status, { timeout: 15_000 })
  .toBe('needs_input')
```

```ts
// WRONG - fake timers near a PTY/socket/subprocess: the test hangs or lies
vi.useFakeTimers()
await client.request('term.write', { id: termId, data: 'claude\r' })
vi.advanceTimersByTime(300_000)

// CORRECT - a short stall timeout from config, real timers, expect.poll
fs.writeFileSync(configPath, 'stall_timeout_minutes = 0.02\n')
```

### 5. Mocking Internals or the OS Instead of Faking the Boundary

```ts
// WRONG - bypasses the real spawn, argv building, env, and output parsing
vi.mock('node:child_process', () => ({ spawn: vi.fn(() => fakeChild) }))

// WRONG - bypasses the real engine the whole daemon depends on
vi.mock('@daemon/status-engine', () => ({ applyHookEvent: vi.fn() }))

// CORRECT - the real daemon spawns the fake claude found first on PATH
vi.stubEnv('PATH', `${FAKES_BIN}:${process.env.PATH}`)
await client.request('term.write', { id: termId, data: 'claude\r' })
```

```tsx
// WRONG - replaces the bridge contract with whatever this test happened to need
window.que = { workspace: { list: vi.fn().mockResolvedValue([ws]) } } as never

// CORRECT - seed the fake bridge's fixture book
fakeBridge.seedWorkspace(ws)
```

### 6. Seeding the Fixture Book After Render

```tsx
// WRONG - Sidebar already called workspace.list(); seedWorkspace is silent, so nothing re-renders
render(<Sidebar />)
fakeBridge.seedWorkspace(makeWorkspace({ id: 'ws_01hzx3k9c2qf' }))

// CORRECT - seed first, mount second; use setStatus/setQuietState (which emit) for live changes
fakeBridge.seedWorkspace(makeWorkspace({ id: 'ws_01hzx3k9c2qf' }))
render(<Sidebar />)
```

### 7. Sharing a `QUE_HOME` Between Tests

```ts
// WRONG - one home for the whole file: SQLite rows, worktrees, and sockets leak between tests
const home = fs.mkdtempSync(join(os.tmpdir(), 'que-it-'))
beforeAll(async () => {
  /* start the daemon once in home */
})

// CORRECT - a fresh temp home per test, removed in afterEach
beforeEach(async () => {
  home = fs.mkdtempSync(join(os.tmpdir(), 'que-it-'))
  vi.stubEnv('QUE_HOME', home)
})
```

A file whose tests are read-only against one daemon (ping, error shapes) may share it in `beforeAll`; the moment a test writes state, give it its own home.

### 8. Wrapping in Manual `act()`

```tsx
// WRONG - unnecessary manual act()
await act(async () => {
  render(<Sidebar />)
})

// CORRECT - render() and userEvent already handle act() internally
render(<Sidebar />)
```

Manual `act()` is only needed around updates the test triggers outside React with `renderHook` (Section 12).

### 9. Testing Implementation Details

```ts
// WRONG - reaches into the runner's private state
expect((runner as any).children.size).toBe(0)

// WRONG - asserts which internal function ran
expect(applyHookEventSpy).toHaveBeenCalledTimes(1)

// CORRECT - asserts what a client observes
expect((await client.request('workspace.get', { id })).status).toBe('idle')
```

### 10. Asserting Terminal Content in jsdom

```tsx
// WRONG - xterm draws to a canvas jsdom can't render; this text is never there
expect(screen.getByText('QUE_ATTACH_7f3a')).toBeInTheDocument()

// CORRECT - content via the daemon's xterm mirror (integration) or screenText() (E2E)
await expect
  .poll(async () => (await client.request('term.snapshot', { id })).text)
  .toContain('QUE_ATTACH_7f3a')
```

---

## 14. Strict Enforcement Rules

**REFUSE to write code that violates these rules:**

### ALWAYS

- Import `render`, `screen`, `waitFor` from `@testing-library/react` directly
- Seed the fake bridge's fixture book **before** `render()`; drive live changes with the emitting mutators (`setStatus`, `setQuietState`)
- Give every daemon integration test that writes state its own temp `QUE_HOME`, socket, and repo, and remove them in `afterEach`
- Put `tests/fakes/bin` first on `PATH` and set the fakes' knobs (`QUE_FAKE_GH_PRS`, `QUE_FAKE_CLAUDE_TITLE`, …) via `vi.stubEnv`, restored with `vi.unstubAllEnvs()`; drive the fake `claude` by typing into its terminal
- Seed and assert daemon state through the real `DaemonClient` (`client.request(...)`), and real `git` for repos
- Use real timers and `waitFor`/`expect.poll` with explicit timeouts for anything touching a PTY, socket, or subprocess, plus a per-test timeout above them
- Inject `now()` into time-dependent logic and test it with fixed local-time dates
- Use `userEvent.setup()` for all user interactions
- Use `queryBy*` for negative assertions
- Write logic tests for branchy rules (status transitions, the digest, quiet-hours math, framing, parsing) rather than exercising them only through the socket or the UI
- Assert that pure reducers return a new object and leave their input untouched
- Key lookups, testids, and assertions by the daemon's opaque ids, never by name
- Follow the canonical import order
- Group tests into behavioral `describe` blocks

### NEVER

- Mock `protocol.ts`, `client.ts`, the status engine, the store, any component, or any other internal module
- Mock `node:child_process`, `node:fs`, `node:net`, or `node-pty` — fake the binary on `PATH` and use temp dirs instead
- Hand-roll a `window.que` stub — use `fakeBridge`
- Sleep (`setTimeout` in a test body, hand-rolled polling loops) to wait for the daemon
- Use `vi.useFakeTimers()` in a test that touches a PTY, socket, or subprocess
- Write rows into SQLite or files into `QUE_HOME` behind the daemon's back to set up state
- Run against the real `~/.que` or with the real `claude`/`gh`/`code` reachable on `PATH`
- Assert terminal content in a jsdom renderer test
- Use `fireEvent` instead of `userEvent`
- Use `getBy*` in negative assertions
- Wrap `render()` calls in manual `act()`
- Invent a custom render wrapper or context provider — none exist in this app
- Test private fields, render counts, or which internal function ran
