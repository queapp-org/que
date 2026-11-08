---
name: e2e-testing
description: Expert at writing, debugging, running, and fixing Playwright E2E tests for que's Electron app. Use when the user asks about E2E tests, Playwright, Electron specs, testing a journey through the real app and daemon, debugging spec failures, or running the E2E suite. Applies que's testing standards with strict enforcement.
allowed-tools: Read, Edit, Write, Glob, Grep, Bash(npm run e2e*), Bash(npx playwright*), TodoWrite
---

# E2E Testing Skill - que

You are an expert Playwright test engineer for que. You write, debug, run, and fix E2E tests following strict best practices.

**What makes this app different from a typical E2E target:** que is a macOS Electron app (TypeScript strict, React 19, electron-vite), not a website — there is no URL and no `page.goto()`. Specs drive it through Playwright's Electron support (`_electron.launch`). The app is only a client: a long-running daemon (`src/daemon/`) owns the terminals, workspaces (git worktrees), the status engine, Create draft PR, the sessions report, and the quiet-hours clock, and it **outlives the app** — quitting que leaves the daemon and its terminals running, and the next launch reattaches. `npm run e2e` builds the app (`npm run build`) and then runs `playwright test`; every spec launches the built app with `QUE_HOME` pointed at a fresh temp dir (so the real daemon starts there, with its own SQLite, socket, and worktrees), `QUE_E2E=1` (so the renderer exposes `window.__que` with `activeTermId()` and `screenText()`), and `PATH` prepended with `tests/fakes/bin` (so the daemon's `claude` and `gh`, and the `open` that launches the editor app, are fakes, while `git` stays real against a temp repo). Test data setup is either (a) the deterministic repo fixture from `tests/e2e/utils/repo.ts` or (b) the real `que` CLI against the test's `QUE_HOME` via `tests/e2e/utils/que.ts`. One app launch per test; everything else is in-app state, except the deliberate **relaunch** in persistence specs. Screenshots go under `test-results/`.

**Scope:** This skill covers **how** to write Playwright E2E tests. For deciding **what** to test at which layer, use the `test-planning` skill. For Vitest daemon integration, renderer component, and logic tests, use the `vitest-testing` skill.

---

## 1. Renderer: Adding data-testid Attributes

**ALWAYS add data-testid attributes to components you touch for E2E coverage.** The renderer from the first work package has almost none — the terminal tabs carry a `data-term-id` attribute and BEM-ish class names, and the first spec reaches them with CSS selectors. Treat the conventions below as the standard to apply the first time a component becomes part of a spec: add the attributes in the same change, don't settle for brittle class or text selectors because the attribute isn't there today.

### Static vs Dynamic IDs

```tsx
// STATIC - for unique elements in a window
<aside data-testid="sidebar">
<div data-testid="quiet-board">
<button data-testid="quiet-board-unlock">

// DYNAMIC - for repeated items (use the daemon's opaque id, never the name)
<li data-testid={`sidebar-workspace-${ws.id}`}>
<span data-testid={`sidebar-workspace-${ws.id}-status`}>
<button data-testid={`terminal-tab-${term.id}`}>
```

### Naming Convention

Pattern: `{component}-{entity-id?}-{element}`

| Type              | Pattern                      | Example                                                                    |
| ----------------- | ---------------------------- | -------------------------------------------------------------------------- |
| Container         | `{component}`                | `sidebar`, `quiet-board`, `report`                                         |
| Container element | `{component}-{element}`      | `quiet-board-unlock`, `sidebar-add-project`                                |
| Dynamic container | `{component}-{id}`           | `sidebar-workspace-ws_01hzx3k9c2qf`, `terminal-tab-<id>`                   |
| Dynamic child     | `{component}-{id}-{element}` | `sidebar-workspace-ws_01hzx3k9c2qf-status`, `report-workspace-<id>-status` |

### Which ID to use for dynamic testids

Workspaces and terminals all carry an **opaque id minted by the daemon**. **Use that id for every dynamic testid.** Do **not** use the workspace name or branch — two projects can each have a `APP-1432-retry-logic`, names can contain characters that are awkward in selectors, and a rename would silently break the locator. Never key by row position either: the sidebar sorts by activity, so position changes as statuses change.

### Real Examples (target state — apply when touching these components)

**`src/renderer/src/App.tsx`** - terminal tabs, keyed by terminal id (already available as `t.id`):

```tsx
<span
  key={t.id}
  className={`tab${t.id === activeId ? ' active' : ''}`}
  data-testid={`terminal-tab-${t.id}`}
>
  <button
    type="button"
    data-term-id={t.id}
    data-testid={`terminal-tab-${t.id}-select`}
    onClick={() => select(t.id)}
  >
    {t.name}
    {!t.alive && (
      <span className="badge exited" data-testid={`terminal-tab-${t.id}-exited`}>
        exited
      </span>
    )}
    {t.reattached && (
      <span className="badge" data-testid={`terminal-tab-${t.id}-reattached`}>
        reattached
      </span>
    )}
  </button>
  <button
    type="button"
    className="close"
    data-testid={`terminal-tab-${t.id}-close`}
    aria-label={`Close ${t.name}`}
  >
    ×
  </button>
</span>
```

**The sidebar** - workspaces under their project, keyed by workspace id:

```tsx
<li data-testid={`sidebar-workspace-${ws.id}`}>
  <button type="button" data-testid={`sidebar-workspace-${ws.id}-open`} onClick={() => open(ws.id)}>
    {ws.name}
  </button>
  <span
    className={`status status--${ws.status}`}
    data-testid={`sidebar-workspace-${ws.id}-status`}
    data-status={ws.status}
  >
    {statusLabel(ws.status)}
  </span>
</li>
```

**The quiet board** - static controls:

```tsx
<section data-testid="quiet-board" aria-label="Quiet hours">
  <p data-testid="quiet-board-until">Quiet until {formatTime(window.end)}</p>
  <button type="button" data-testid="quiet-board-unlock">
    Unlock for 15 minutes
  </button>
</section>
```

Expose machine-readable state as a `data-status` (or similar) attribute alongside the human label, so specs assert `toHaveAttribute('data-status', 'needs_input')` instead of matching copy that may change.

---

## 2. Page Objects: Locator-First Pattern

**Page objects contain LOCATORS and complex methods only.** Tests call Playwright methods directly on locators. Simple actions (1-3 lines) belong in tests, not page objects. One page object per area of a window; a page object takes the `Page` for the window it lives in.

### Core Principles

1. **Locators in constructor only** - define all locators in the constructor
2. **No wrapper methods for simple actions** - don't wrap `.click()`, `.fill()`, etc.
3. **Dynamic locators as arrow functions** - keyed by the daemon's opaque id
4. **Methods ONLY for complex logic (4+ lines)** - like `waitForLoad()` racing two possible outcomes, or polling terminal text
5. **No launch or navigation methods** - launching belongs to `tests/e2e/utils/app.ts`; see Section 4

### Correct Pattern (SidebarPage)

```typescript
// tests/e2e/pages/SidebarPage.ts
import type { Locator, Page } from '@playwright/test'

export class SidebarPage {
  page: Page
  root: Locator
  emptyState: Locator
  addProjectButton: Locator
  newWorkspaceButton: Locator
  newWorkspaceNameInput: Locator
  newWorkspaceSubmit: Locator
  project: (id: string) => Locator
  workspace: (id: string) => Locator
  workspaceOpen: (id: string) => Locator
  workspaceStatus: (id: string) => Locator
  workspaceMenu: (id: string) => Locator

  constructor(page: Page) {
    this.page = page
    // Static locators
    this.root = page.getByTestId('sidebar')
    this.emptyState = page.getByTestId('sidebar-empty')
    this.addProjectButton = page.getByTestId('sidebar-add-project')
    this.newWorkspaceButton = page.getByTestId('sidebar-new-workspace')
    this.newWorkspaceNameInput = page.getByTestId('sidebar-new-workspace-name')
    this.newWorkspaceSubmit = page.getByTestId('sidebar-new-workspace-submit')
    // Dynamic locators (arrow functions, keyed by daemon ids)
    this.project = (id: string) => page.getByTestId(`sidebar-project-${id}`)
    this.workspace = (id: string) => page.getByTestId(`sidebar-workspace-${id}`)
    this.workspaceOpen = (id: string) => page.getByTestId(`sidebar-workspace-${id}-open`)
    this.workspaceStatus = (id: string) => page.getByTestId(`sidebar-workspace-${id}-status`)
    this.workspaceMenu = (id: string) => page.getByTestId(`sidebar-workspace-${id}-menu`)
  }

  // OK - complex wait logic with Promise.race (see Section 7)
  async waitForLoad() {
    await this.root.waitFor({ state: 'visible' })
    await Promise.race([
      this.page
        .getByTestId(/^sidebar-workspace-/)
        .first()
        .waitFor({ state: 'visible' })
        .catch(() => {}),
      this.emptyState.waitFor({ state: 'visible' }).catch(() => {})
    ])
  }
}
```

### Correct Pattern (TerminalPage)

Terminal content is not in the DOM in any assertable form — xterm draws it. `TerminalPage` reads it through the test hook the renderer installs under `QUE_E2E=1`:

```typescript
// tests/e2e/pages/TerminalPage.ts
import { expect, type Locator, type Page } from '@playwright/test'

export class TerminalPage {
  page: Page
  viewport: Locator
  input: Locator
  emptyState: Locator
  tab: (id: string) => Locator
  tabSelect: (id: string) => Locator
  tabClose: (id: string) => Locator
  tabExited: (id: string) => Locator
  tabReattached: (id: string) => Locator

  constructor(page: Page) {
    this.page = page
    this.viewport = page.getByTestId('terminal-viewport')
    this.input = page.getByTestId('terminal-viewport').locator('.xterm-helper-textarea')
    this.emptyState = page.getByTestId('terminal-empty')
    this.tab = (id: string) => page.getByTestId(`terminal-tab-${id}`)
    this.tabSelect = (id: string) => page.getByTestId(`terminal-tab-${id}-select`)
    this.tabClose = (id: string) => page.getByTestId(`terminal-tab-${id}-close`)
    this.tabExited = (id: string) => page.getByTestId(`terminal-tab-${id}-exited`)
    this.tabReattached = (id: string) => page.getByTestId(`terminal-tab-${id}-reattached`)
  }

  async activeTermId(): Promise<string | null> {
    return this.page.evaluate(() => window.__que!.activeTermId())
  }

  async screenText(): Promise<string> {
    return this.page.evaluate(() => window.__que!.screenText())
  }

  // OK - polls the xterm buffer until a whole line matches, with the screen in the failure message
  async expectScreenToContain(text: string, timeout = 15_000) {
    await expect
      .poll(
        async () => (await this.screenText()).split('\n').some((line) => line.trim() === text),
        {
          message: `no screen line "${text}"`,
          timeout
        }
      )
      .toBe(true)
  }
}
```

`expectScreenToContain` matches a **whole line**, so typing `echo QUE_MARKER` doesn't satisfy it by echoing the command — only the command's output does.

### Wrong Pattern (DO NOT USE)

```typescript
// WRONG - wrapper methods for simple actions
export class SidebarPage {
  // ...locators...

  // DON'T DO THIS - unnecessary wrapper
  async openWorkspace(id: string) {
    await this.workspaceOpen(id).click()
  }

  // DON'T DO THIS - simple boolean check
  async isEmpty() {
    return await this.emptyState.isVisible()
  }

  // DON'T DO THIS - name-based lookup when the id is available
  async statusOf(name: string) {
    return this.root.locator('li').filter({ hasText: name }).locator('.status').textContent()
  }

  // DON'T DO THIS - launching is utils/app.ts's job, once per test
  async launch() {
    /* electron.launch(...) */
  }
}
```

### When Methods ARE Allowed (4+ lines of complex logic)

```typescript
// OK - a session runs through several states; wait for the one wanted and surface the history on failure
async waitForWorkspaceStatus(id: string, status: string, timeout = 30_000) {
  const badge = this.workspaceStatus(id)
  await badge.waitFor({ state: 'visible' })
  await expect(badge, `workspace ${id} never reached ${status}`).toHaveAttribute('data-status', status, {
    timeout,
  })
}
```

---

## 3. Refactoring Existing Page Objects

When cleaning up page objects or migrating inline helpers into them, follow this checklist.

### Cleanup Checklist

1. **Identify wrapper methods to remove:**
   - Methods that just call `.click()` on a locator
   - Methods that return `.isVisible()` or `.count()`
   - Methods that call `.fill()` then `.press('Enter')`
   - Launch/relaunch methods (those belong to `utils/app.ts`)

2. **Keep ALL locators** - even if unused in current tests
   - Locators document what `data-testid` attributes exist in the renderer
   - Makes it easy for test engineers to see available selectors
   - Don't be overzealous removing "unused" locators during refactors
   - Only remove a locator if its `data-testid` was removed from the renderer

3. **Convert name-based or CSS-based lookups to id-based locators:**

   ```typescript
   // BEFORE: CSS selector keyed by an attribute, plus a class for the badge
   page.locator(`[data-term-id="${termId}"] .badge`)

   // AFTER: dynamic locator by id
   this.tabReattached = (id: string) => page.getByTestId(`terminal-tab-${id}-reattached`)
   ```

4. **Update tests to use direct locator access:**
   ```typescript
   // BEFORE
   await expect(page.locator(`[data-term-id="${termId}"] .badge`)).toHaveText('reattached')

   // AFTER
   await expect(terminal.tabReattached(termId)).toBeVisible()
   ```

### Example: Migrating `persistence.spec.ts`

The first work package's `tests/e2e/persistence.spec.ts` predates these conventions: it inlines `launch()`, `cli()`, and `env()`, reaches tabs with CSS selectors, and its `waitForPrompt` loop polls with `page.waitForTimeout(100)`. The first time you touch it:

**Before (inline helpers):**

```typescript
// These move OUT of the spec:
function cli(...args: string[]): string {
  /* execFileSync out/cli/index.js */
}
async function launch() {
  /* electron.launch + firstWindow + waitForFunction */
}
async function waitForOutputLine(page: Page, marker: string) {
  /* page.waitForFunction */
}
async function typeLine(page: Page, line: string) {
  /* focus .xterm-helper-textarea, type, Enter */
}
```

**After (utils + page objects):**

```typescript
// utils/que.ts and utils/app.ts own process concerns:
const { app, window, queHome } = await launchApp()
que(queHome, 'term', 'list', '--json')

// TerminalPage owns terminal locators and the screen-text poll:
await terminal.input.focus()
await window.keyboard.type(`echo ${marker}`)
await window.keyboard.press('Enter')
await terminal.expectScreenToContain(marker)
```

The "prompt has settled" wait goes away entirely: typing into the terminal before the shell prompt draws is safe because the PTY buffers input, and the whole-line match proves the command ran.

---

## 4. Test Files: Writing Tests

### Core Rules

1. **ALWAYS use page objects** - never call `window.getByTestId()` or `window.getByRole()` directly in test files
2. **Wrap every action in `test.step()`** - required for debugging
3. **Use locators directly with Playwright assertions** - via page object properties
4. **State-first data setup** - build the repo with `utils/repo.ts` and register it or create workspaces with the real CLI through `utils/que.ts`; never click through a dozen dialogs to build state the test isn't about (see Section 5)
5. **One app launch per test** - `launchApp()` once, then drive everything through in-app state (sidebar, tabs, settings, the quiet board). The only exception is a **relaunch** in a persistence spec, which is the behavior under test.

### Page Object Requirement

**Test files must NEVER contain direct locator calls.** All element access goes through page objects.

```typescript
// WRONG - direct locator in test file
await window.getByTestId('sidebar-new-workspace').click()
await expect(window.locator('[data-term-id] .badge')).toHaveText('reattached')

// CORRECT - use page object locators
await sidebar.newWorkspaceButton.click()
await expect(terminal.tabReattached(termId)).toBeVisible()
```

**Why?**

- Locators are defined once in page objects, not scattered across tests
- When a `data-testid` changes, update ONE file (the page object)
- Page objects document available selectors for each window and area
- Tests become more readable and maintainable

### Correct Test Pattern

This example relies on a temp repo from `makeTempRepo()` and the fake `claude`, typed into the workspace terminal like the real one. It starts a session through the CLI and the app and checks that the morning report shows it waiting.

```typescript
// tests/e2e/workspace.spec.ts
import { expect, test } from '@playwright/test'
import type { Project, Workspace } from '../../src/shared/types'
import { makeTempRepo } from '../../src/testing/temp-repo'
import { AppShellPage } from './pages/AppShellPage'
import { ReportPage } from './pages/ReportPage'
import { SidebarPage } from './pages/SidebarPage'
import { TerminalPage } from './pages/TerminalPage'
import { type LaunchedApp, launchApp, tempDir } from './utils/app'
import { que, queJson } from './utils/que'

let launched: LaunchedApp

test.afterEach(async () => {
  await launched?.close() // quits the app AND stops the test daemon
})

test('a session that asks for input shows as waiting in the morning report', async () => {
  const repo = makeTempRepo(tempDir('que-e2e-repo-'))
  let workspace: Workspace
  let termId = ''

  await test.step('Launch the app on a fresh QUE_HOME', async () => {
    launched = await launchApp()
    await new AppShellPage(launched.window).waitForLoad()
  })

  const sidebar = new SidebarPage(launched.window)
  const terminal = new TerminalPage(launched.window)
  const report = new ReportPage(launched.window)

  await test.step('Add the project and create a workspace with the CLI', async () => {
    queJson<Project>(launched.queHome, 'project', 'add', repo, '--json')
    workspace = queJson<Workspace>(
      launched.queHome,
      'work',
      '--name',
      'APP-1432 retry logic',
      '-r',
      repo,
      '--json'
    )
  })

  await test.step('Open its terminal and start claude', async () => {
    termId = que(launched.queHome, 'ws', 'terminal', workspace.id).trim()
    await sidebar.workspaceOpen(workspace.id).click()
    await terminal.tabSelect(termId).click()
    await terminal.input.focus()
    await launched.window.keyboard.type('claude')
    await launched.window.keyboard.press('Enter')
  })

  await test.step('Ask for something that needs permission; the sidebar says needs input', async () => {
    await launched.window.keyboard.type('/needs-input')
    await launched.window.keyboard.press('Enter')
    await sidebar.waitForWorkspaceStatus(workspace.id, 'needs_input')
  })

  await test.step('The morning report lists the workspace as waiting', async () => {
    await sidebar.reportButton.click()
    await report.waitForLoad()
    await expect(report.workspaceState(workspace.id)).toHaveAttribute('data-status', 'needs_input')
    await expect(report.workspaceFacts(workspace.id)).toContainText('asked for input 1×')
    await launched.window.screenshot({ path: 'test-results/workspace-report.png' })
  })
})
```

### Key Patterns in Tests

**Direct locator usage:**

```typescript
// Click actions - call .click() on locator
await sidebar.workspaceOpen(workspaceId).click()
await quietBoard.unlockButton.click()

// Assertions - use expect() with locator
await expect(sidebar.workspaceStatus(workspaceId)).toHaveAttribute('data-status', 'needs_input')
await expect(terminal.tab(termId)).toBeVisible()
await expect(quietBoard.root).not.toBeVisible()
```

**One launch, then in-app state:**

```typescript
// In every test - launch exactly once
launched = await launchApp()

// Then everything else is in-app state, not a relaunch:
await sidebar.workspaceOpen(workspaceId).click() // switch workspace
await terminal.tabSelect(termId).click() // switch terminal
await settings.openButton.click() // open settings
```

### Persistence Specs: The Deliberate Relaunch

The one thing only E2E can prove is that the daemon outlives the app. A persistence spec quits, checks the daemon through the CLI while no app is running, and launches again **on the same `QUE_HOME`**:

```typescript
await test.step('Quit the app; the daemon keeps the terminal', async () => {
  await launched.app.close() // the app only — NOT launched.close(), which also stops the daemon
  const terms = queJson<TermInfo[]>(launched.queHome, 'term', 'list', '--json')
  expect(terms.find((t) => t.id === termId)?.alive).toBe(true)
  expect(que(launched.queHome, 'term', 'snapshot', termId)).toContain(marker)
})

await test.step('Relaunch on the same home; the terminal reattaches and replays', async () => {
  launched = await launchApp({ queHome: launched.queHome })
  terminal = new TerminalPage(launched.window)
  expect(await terminal.activeTermId()).toBe(termId)
  await terminal.expectScreenToContain(marker)
  await expect(terminal.tabReattached(termId)).toBeVisible()
})
```

### Multiple Windows

que has more than one window (the main window, the quiet board popover). Never assume `firstWindow()` is the one you want after the app is up:

```typescript
const popoverPromise = launched.app.waitForEvent('window')
await appShell.quietBoardButton.click()
const popover = await popoverPromise
const quietBoard = new QuietBoardPage(popover)
await quietBoard.waitForLoad()
```

Each window gets its own page objects. To find an already-open window, filter `launched.app.windows()` by something stable (its URL hash or a root testid), not by index. Don't try to click the tray — Playwright can't reach the macOS menu bar; every window the tray opens must also be reachable from inside the app, and what the tray shows (`trayView`) is a logic test.

### Shared State Inside One Launch

Every window of one app instance talks to the same daemon in the same `QUE_HOME`. A change made in the popover is real in the main window, which is exactly what a cross-window spec asserts — but it also means a test that needs isolation must not share an app with another test. That's the default: each test calls `launchApp()`, which creates a fresh `QUE_HOME`.

---

## 5. Test Data Setup (tests/e2e/utils/)

Every test gets its own temp `QUE_HOME` (and therefore its own daemon, SQLite database, socket, and worktrees) and its own temp git repo, so specs are order-independent by construction. Set up state the way a user's tools would — real `git`, the real `que` CLI — and only click through the UI for the flow the test is actually about.

### `utils/app.ts` - launch the built app

```typescript
// tests/e2e/utils/app.ts
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { que } from './que'

export const ROOT = resolve(__dirname, '../../..')
export const FAKES_BIN = join(ROOT, 'tests/fakes/bin')

export interface LaunchedApp {
  app: ElectronApplication
  window: Page
  queHome: string
  ghCalls(): string[][]
  close(): Promise<void>
}

/** The env every process in a test shares: app, daemon, CLI, fakes. */
export function testEnv(
  queHome: string,
  extra: Record<string, string> = {}
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  return {
    ...env,
    QUE_HOME: queHome,
    QUE_E2E: '1',
    PATH: `${FAKES_BIN}:${env.PATH}`,
    QUE_FAKE_GH_LOG: join(queHome, 'fake-gh.log'),
    ...extra
  }
}

export async function launchApp(
  opts: { queHome?: string; env?: Record<string, string> } = {}
): Promise<LaunchedApp> {
  const queHome = opts.queHome ?? mkdtempSync(join(os.tmpdir(), 'que-e2e-'))
  const app = await electron.launch({ args: ['.'], cwd: ROOT, env: testEnv(queHome, opts.env) })
  const window = await app.firstWindow()
  return {
    app,
    window,
    queHome,
    ghCalls: () => {
      const log = join(queHome, 'fake-gh.log')
      if (!existsSync(log)) return []
      return readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as string[])
    },
    close: async () => {
      await app.close().catch(() => {})
      try {
        que(queHome, 'daemon', 'stop')
      } catch {
        // already stopped
      }
    }
  }
}
```

**Always stop the daemon** in `afterEach` (`launched.close()`): it outlives the app by design, so a spec that only closes the app leaves a daemon running against a deleted temp dir.

### `utils/que.ts` - the real CLI against the test home

```typescript
// tests/e2e/utils/que.ts
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { ROOT, testEnv } from './app'

export function que(queHome: string, ...args: string[]): string {
  return execFileSync(process.execPath, [join(ROOT, 'out/cli/index.js'), ...args], {
    env: testEnv(queHome),
    encoding: 'utf8'
  })
}

export function queJson<T>(queHome: string, ...args: string[]): T {
  return JSON.parse(que(queHome, ...args)) as T
}
```

Use it both to **seed** (`que project add`, `que work`) and to **assert** daemon state with no window in the way (`que term list --json`, `que status --json`) — the CLI is a real client of the same socket, so it sees exactly what the app sees.

### `utils/repo.ts` - the deterministic repo fixture

```typescript
// tests/e2e/utils/repo.ts
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'que e2e',
  GIT_AUTHOR_EMAIL: 'e2e@que.invalid',
  GIT_COMMITTER_NAME: 'que e2e',
  GIT_COMMITTER_EMAIL: 'e2e@que.invalid',
  GIT_AUTHOR_DATE: '2026-10-01T09:00:00Z',
  GIT_COMMITTER_DATE: '2026-10-01T09:00:00Z'
}

/** The same small repo every run: two commits on main and a que.toml with a trivial setup command. */
export function makeRepo(): string {
  const dir = mkdtempSync(join(os.tmpdir(), 'que-e2e-repo-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env: GIT_ENV })
  git('init', '-b', 'main')
  writeFileSync(join(dir, 'README.md'), '# uploader\n')
  git('add', '.')
  git('commit', '-m', 'Initial commit')
  writeFileSync(join(dir, 'que.toml'), '[setup]\ncommand = "echo setup-ok > .que-setup"\n')
  git('add', '.')
  git('commit', '-m', 'Add que.toml')
  return dir
}
```

Fixed author and dates make commit hashes identical every run, so a spec may assert on them if it ever needs to.

### Default pattern: a fresh home, the stock repo, the fake session

Most specs need nothing beyond `makeRepo()` and `launchApp()`. The fake `claude` is an interactive session: type `claude` into a workspace terminal, then a prompt or `/needs-input`, as a user would. Knobs such as `QUE_FAKE_CLAUDE_TITLE` go in `launchApp({ env })` — the daemon inherits the env and passes it to every terminal it opens.

```typescript
test('a session asking for permission shows needs input in the sidebar', async () => {
  const repo = makeRepo()
  launched = await launchApp()
  const ws = queJson<{ id: string }>(
    launched.queHome,
    'work',
    repo,
    'APP-1440-quiet-board',
    '--json'
  )
  // ...open the workspace, type claude and /needs-input, assert sidebar.workspaceStatus(ws.id) reaches needs_input...
})
```

### When a spec needs something the CLI can't seed

Drive it through the UI if it **is** the flow under test (creating a workspace from the sidebar dialog, editing quiet hours in Settings). Otherwise, add the missing CLI command or flag first — a CLI gap is a product gap for scripting users too — rather than writing files into `QUE_HOME` behind the daemon's back.

---

## 6. Driving the Fakes: claude, gh, open

The subprocess fakes in `tests/fakes/bin/` are what make E2E deterministic. They are the same binaries the Vitest integration suite uses.

| Fake     | What a spec can rely on                                                                                                                                                                                                                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude` | An interactive session only: prints a banner and a prompt into the PTY; `--settings` hooks fire with real hook JSON, so the status engine sees `UserPromptSubmit`, `Notification`, `Stop` as it would from the real thing. Typed commands drive it: a prompt runs a turn, `/needs-input` asks for permission, `/background`, `/exit`. |
| `gh`     | Logs argv to `QUE_FAKE_GH_LOG` (`launched.ghCalls()` reads it back) and prints a fake PR URL from `gh pr create`.                                                                                                                                                                                                                     |
| `open`   | Logs its invocation (`launched.openCalls()`), so Open in editor (`open -a <app> <folder>`) is assertable without an app opening. The system's file picker is out of reach; `launched.pickInOpenDialog(path)` answers it.                                                                                                              |

**Session paths belong in integration tests.** E2E uses the fakes to make a journey run end to end — a prompt and `/needs-input` for the spec that proves a hook reaches the sidebar and the report through the real app. Every other path (a stall, background tasks, a resumed session) is proven once in the Vitest hooks integration tests; an E2E spec per path is the overlap the `test-planning` skill exists to prevent.

**Never let a spec reach the real binaries.** `testEnv()` puts `tests/fakes/bin` first on `PATH` for the app, the daemon, and the CLI alike. A spec that builds its own env without it will run your real `claude` against a temp repo and open a real PR through your real `gh`.

### Typing into a terminal

Type into the real xterm through its helper textarea (a `TerminalPage` locator), then wait on the output line:

```typescript
await test.step('Run a command in the workspace terminal', async () => {
  await terminal.input.focus()
  await launched.window.keyboard.type('echo QUE_MARKER_5c2e')
  await launched.window.keyboard.press('Enter')
  await terminal.expectScreenToContain('QUE_MARKER_5c2e')
})
```

Use a unique marker per test (a fixed string with a random suffix is fine) so the assertion can't match leftover output from another command.

---

## 7. Wait Strategy: Element-Based Waits Only

**NEVER sleep, and never wait on load states.** The daemon, the PTYs, and the fakes all run on their own schedule; a fixed delay is either too short under load or wastefully long when idle. Wait for the specific thing the test cares about: an element, a line of terminal text, or a CLI query.

### Banned Patterns

```typescript
// NEVER - arbitrary sleeps, including inside "poll until stable" loops
await window.waitForTimeout(1000)
await new Promise((r) => setTimeout(r, 500))

// NEVER - load states say nothing about the daemon, the PTY, or the renderer's data
await window.waitForLoadState('networkidle')
await window.waitForLoadState('domcontentloaded')

// NEVER - sleeping "for the daemon to start" after launch or before a CLI call
```

### Correct Pattern: Page Object `waitForLoad()`

Every page object a test lands on after launch or after opening a window should have a `waitForLoad()` that waits for **actual DOM elements**:

```typescript
// Simple area - wait for the container
async waitForLoad() {
  await this.root.waitFor({ state: 'visible' })
}

// Branching area - race two possible outcomes, since which one renders
// depends on state (a fresh home has no projects; a reused one does)
async waitForLoad() {
  await Promise.race([
    this.workspacesSection.waitFor({ state: 'visible' }).catch(() => {}),
    this.emptyState.waitFor({ state: 'visible' }).catch(() => {}),
  ])
}
```

### The Three Waits que Needs

```typescript
// 1. An element reflecting daemon state - Playwright's auto-retrying assertions
await expect(sidebar.workspaceStatus(workspaceId)).toHaveAttribute('data-status', 'idle', {
  timeout: 30_000
})

// 2. Terminal content - expect.poll over screenText(), via TerminalPage
await terminal.expectScreenToContain('QUE_MARKER_5c2e')

// 3. Daemon state with no window involved - expect.poll over a CLI query
await expect
  .poll(() => queJson<StatusJson>(launched.queHome, 'status', '--json').workspaces[0]?.status, {
    timeout: 30_000
  })
  .toBe('needs_input')
```

Give anything that waits on a claude session or Create draft PR an explicit timeout well above Playwright's default; the suite's per-test timeout (`timeout: 90_000` in `playwright.config.ts`) is the ceiling.

### After UI Actions: Wait for the Rendered Result

Clicking "New workspace" creates a worktree and runs the `que.toml` setup command before the workspace is usable; clicking "Unlock" changes quiet state in the daemon before the board goes away. Assert the rendered outcome, not the click:

```typescript
await sidebar.newWorkspaceSubmit.click()
await expect(sidebar.workspace(workspaceId)).toBeVisible()
await expect(sidebar.workspaceStatus(workspaceId)).toHaveAttribute('data-status', 'idle')

await quietBoard.unlockButton.click()
await expect(quietBoard.root).not.toBeVisible()
await expect(terminal.viewport).toBeVisible()
```

### Shared utilities

`tests/e2e/utils/` holds `app.ts`, `que.ts`, and `repo.ts` (Section 5). Anything else that is neither process setup nor a page object — a `formatClock(ms)` mirroring the renderer's countdown text, say — goes in a `helpers.ts` alongside them, created by the first spec that needs it. Keep it thin: most waits belong in a page object.

---

## 8. Project Structure

```
playwright.config.ts           # repo root: testDir 'tests/e2e', workers 1, timeout 90s, outputDir test-results/artifacts
tests/
├── e2e/
│   ├── *.spec.ts              # Specs (persistence, workspace, review, quiet-mode, ...)
│   ├── pages/                 # Page objects (locators + complex methods only)
│   │   ├── AppShellPage.ts     # Window chrome: topbar, quiet board button, report/settings entry points
│   │   ├── SidebarPage.ts      # Projects → workspaces, status badges, new-workspace dialog
│   │   ├── TerminalPage.ts     # Tabs, viewport, screenText(), expectScreenToContain()
│   │   ├── QuietBoardPage.ts   # The quiet board (main window or popover), unlock, countdown
│   │   ├── ReportPage.ts       # The morning report, rows keyed by workspace id
│   │   └── SettingsPage.ts     # Quiet hours, per-day overrides, notifications
│   └── utils/
│       ├── app.ts              # launchApp(), testEnv(): QUE_HOME, QUE_E2E=1, fakes on PATH
│       ├── que.ts              # que()/queJson(): the real CLI against the test home
│       └── repo.ts             # makeRepo(): the deterministic two-commit repo with que.toml
│                               # (helpers.ts alongside when a spec first needs one - Section 7)
└── fakes/
    └── bin/
        ├── claude              # Fake Claude Code: interactive session, hooks
        ├── gh                  # Records calls, prints a fake PR URL
        └── open                # Records calls (Open in editor)
test-results/                  # Screenshots and Playwright artifacts (gitignored)
```

`playwright.config.ts` sits at the repo root, next to `package.json`, so the Playwright CLI and editor integrations find it without `-c`. `workers: 1` today because every test launches a full Electron app plus a daemon; specs must stay order-independent anyway (they are, by construction, with a fresh `QUE_HOME` and repo each). The suite runs against the **built** app in `out/` — `npm run e2e` rebuilds first; `npx playwright test` alone does not, so rebuild (`npm run build`) after changing source before running a single spec.

**Window convention:** `launchApp()` returns the first window; get every later window from `app.waitForEvent('window')` at the moment the test opens it. Never `app.windows()[1]`.

---

## 9. Commands

| Command                                             | Purpose                                                                                         |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `npm run e2e`                                       | Build the app, then run the full E2E suite - **DEFAULT**                                        |
| `npx playwright test tests/e2e/persistence.spec.ts` | Run a single spec against the current build (run `npm run build` first if source changed)       |
| `npx playwright test -g "reattaches"`               | Run tests whose title matches                                                                   |
| `npx playwright test --ui`                          | Open Playwright UI mode for debugging                                                           |
| `npx playwright show-report`                        | View the HTML report from the last run (requires the `html` reporter in `playwright.config.ts`) |
| `npm run smoke`                                     | Daemon smoke check (`scripts/smoke.mjs`) — not E2E, but the fastest "is the build alive" signal |

If a run is interrupted and leaves a daemon behind, stop it through the CLI with the same `QUE_HOME` the spec used (`QUE_HOME=/tmp/que-e2e-… node out/cli/index.js daemon stop`); never kill processes by name, which could hit the daemon serving your real `~/.que`.

---

## 10. Strict Enforcement Rules

**REFUSE to write code that violates these rules:**

### Locator Strategy

1. `getByTestId()` - USE THIS. Almost always.
2. `getByRole()`, `getByText()`, `getByLabel()`, CSS selectors - LAST RESORT only (the xterm helper textarea, which xterm renders and we don't own, is the accepted exception — and it lives in `TerminalPage`, scoped under the `terminal-viewport` testid)

**If a data-testid doesn't exist, ADD IT to the renderer component first.** Don't settle for alternatives.

### ALWAYS Required

- ✅ Page objects for ALL element access - never direct `window.getByTestId()` in tests
- ✅ `test.step()` wrapping all actions
- ✅ `launchApp()` from `utils/app.ts` with a fresh `QUE_HOME`, `QUE_E2E=1`, and `tests/fakes/bin` first on `PATH`
- ✅ `makeRepo()` and the real CLI (`utils/que.ts`) for test data - never build state the test isn't about by clicking through the UI
- ✅ Stop the daemon after every test (`launched.close()` in `afterEach`)
- ✅ Dynamic locators keyed by the daemon's opaque ids (never names, branches, or position)
- ✅ Terminal content asserted through `TerminalPage.expectScreenToContain()` / `screenText()`, with a unique marker
- ✅ Later windows obtained with `app.waitForEvent('window')`, each with its own page objects
- ✅ Direct locator usage via page objects (`.click()`, `expect().toBeVisible()`)
- ✅ TypeScript — page objects type their `page: Page` constructor param (`import type { Page } from '@playwright/test'`)

### NEVER Do

- ❌ Direct `window.getByTestId()` or `window.getByRole()` in test files - use page objects
- ❌ Wrapper methods for 1-3 line actions in page objects
- ❌ Launch methods on page objects, or more than one launch per test outside a persistence spec's deliberate relaunch
- ❌ `waitForTimeout()`, `setTimeout` sleeps, or "poll until stable" loops - wait on an element, `expect.poll` over `screenText()`, or a CLI query
- ❌ `waitForLoadState('networkidle')` or `'domcontentloaded'` - they say nothing about the daemon or the PTY
- ❌ Sharing a `QUE_HOME` or a repo between tests, or running against the real `~/.que`
- ❌ Letting any process in a spec find the real `claude`, `gh`, or `open`
- ❌ Writing files into `QUE_HOME` behind the daemon's back to seed state - use the CLI, or add the missing CLI command
- ❌ One E2E spec per fake `claude` session path - those are proven in the Vitest integration suite
- ❌ Clicking the tray or indexing `app.windows()` by position
- ❌ Matching workspaces or terminals by name or position when the id is available
- ❌ Killing daemons by process name
