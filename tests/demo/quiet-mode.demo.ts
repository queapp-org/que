// The website overview's quiet-mode GIF (`npm run demo:gif`, #229): not a test but a recording.
// It drives the built app and a real daemon with fake claude sessions (QUE_FAKE_CLAUDE_STREAM
// keeps a turn working until a signal ends it or makes it ask), and saves keyframes with their
// hold times to test-results/demo/; scripts/demo-gif.mjs encodes them. Playwright screenshots have no
// pointer, so an overlay cursor (demo only, never in the app) glides to each control first.
// Everything on screen is generic: a temp HOME so paths read `~/…`, and a bare zsh prompt.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { join } from 'node:path'
import { expect, type Locator, type Page, test } from '@playwright/test'
import type { Project, Workspace } from '../../src/shared/types'
import { readFakeLog, REPO_ROOT } from '../../src/testing/fakes'
import { makeTempRepo } from '../../src/testing/temp-repo'
import { QUIET_OFF, writeGitconfig } from '../fakes/env.cjs'
import { QuietBoardPage } from '../e2e/pages/QuietBoardPage'
import { SidebarPage } from '../e2e/pages/SidebarPage'
import { TerminalPage } from '../e2e/pages/TerminalPage'
import { findWindow, type LaunchedApp, launchApp, tempDir, testEnv } from '../e2e/utils/app'

const OUT = join(REPO_ROOT, 'test-results', 'demo')
const FRAMES = join(OUT, 'frames')

/** The size the GIF is recorded at (encoded smaller). */
const WIDTH = 1100
const HEIGHT = 720

/** How often a fake session prints its next tool step. */
const STEP_MS = 700

const SESSIONS = [
  { slug: 'add-retry-with-backoff', title: 'Add retry with backoff' },
  { slug: 'fix-flaky-upload-test', title: 'Fix flaky upload test' },
  { slug: 'document-config-keys', title: 'Document config keys' },
  { slug: 'bump-node-pty', title: 'Bump node-pty' }
] as const

const PROMPTS: Record<string, string> = {
  'add-retry-with-backoff': 'Retry failed uploads with exponential backoff, at most 5 tries',
  'fix-flaky-upload-test': 'The upload timeout test fails about one run in ten; find out why',
  'document-config-keys': 'Document every config key in docs/config.md',
  'bump-node-pty': 'Bump node-pty to the latest release and run the tests'
}

interface Frame {
  file: string
  window: 'main' | 'board'
  delay: number
}

interface DemoCursor {
  move(x: number, y: number, pressed: boolean): void
}

declare global {
  var __demoCursor: DemoCursor | undefined
}

// Plain JS evaluated in the page (a string, so it needs no DOM types here and the page's CSP
// does not apply): a fixed arrow above everything, never taking the pointer's events.
const CURSOR_SCRIPT = `(() => {
  if (globalThis.__demoCursor) return
  const el = document.createElement('div')
  el.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2 L3 18 L7.2 14.2 L10 20.5 L12.8 19.3 L10.1 13.1 L15.8 13.1 Z" fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>'
  Object.assign(el.style, {
    position: 'fixed', left: '0', top: '0', width: '22px', height: '22px', zIndex: '2147483647',
    pointerEvents: 'none', transformOrigin: '3px 2px', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.5))'
  })
  document.body.appendChild(el)
  globalThis.__demoCursor = {
    move(x, y, pressed) {
      el.style.transform = 'translate(' + (x - 3) + 'px,' + (y - 2) + 'px) scale(' + (pressed ? 0.82 : 1) + ')'
    }
  }
})()`

const frames: Frame[] = []
const cursorAt = new Map<Page, { x: number; y: number }>()
let launched: LaunchedApp

test.afterAll(async () => {
  await launched?.close() // quits the app AND stops the demo daemon
})

/** Saves the window as the next keyframe, shown for `delay` ms. */
async function capture(page: Page, window: Frame['window'], delay: number): Promise<void> {
  const file = `${String(frames.length).padStart(3, '0')}.png`
  await page.screenshot({ path: join(FRAMES, file) })
  frames.push({ file, window, delay })
}

async function placeCursor(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(CURSOR_SCRIPT)
  await page.evaluate(([cx, cy]) => globalThis.__demoCursor?.move(cx, cy, false), [x, y])
  cursorAt.set(page, { x, y })
}

/** Glides the cursor to the middle of `target` in a few captured frames, presses, and clicks it. */
async function glideAndClick(page: Page, window: Frame['window'], target: Locator): Promise<void> {
  const box = await target.boundingBox()

  if (!box) throw new Error('the click target has no box')
  const to = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
  const from = cursorAt.get(page) ?? { x: WIDTH / 2, y: HEIGHT / 2 }
  const steps = 9

  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
    const x = from.x + (to.x - from.x) * ease
    const y = from.y + (to.y - from.y) * ease
    await page.evaluate(([cx, cy]) => globalThis.__demoCursor?.move(cx, cy, false), [x, y])
    await capture(page, window, i === steps ? 260 : 40)
  }

  await page.evaluate(([cx, cy]) => globalThis.__demoCursor?.move(cx, cy, true), [to.x, to.y])
  await capture(page, window, 140)
  await page.evaluate(([cx, cy]) => globalThis.__demoCursor?.move(cx, cy, false), [to.x, to.y])
  cursorAt.set(page, to)
  await target.click()
}

test('records quiet mode for the website overview', async () => {
  test.setTimeout(240_000)
  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(FRAMES, { recursive: true })

  // A temp HOME (resolved, so the fake's `~` matches the cwd it sees) holding QUE_HOME and
  // the repo, and a zsh whose prompt is the folder name: nothing of the machine shows.
  const home = fs.realpathSync(tempDir('que-demo-'))
  const queHome = join(home, '.que')
  fs.mkdirSync(queHome)
  writeGitconfig(queHome, 'demo')
  fs.writeFileSync(join(queHome, 'config.toml'), QUIET_OFF)
  fs.writeFileSync(join(home, '.zshrc'), "PROMPT='%1~ %# '\nunsetopt PROMPT_SP\n")
  const repo = makeTempRepo(join(home, 'code'))

  const env = {
    HOME: home,
    ZDOTDIR: home,
    SHELL: '/bin/zsh',
    QUE_FAKE_CLAUDE_STREAM: String(STEP_MS)
  }

  const que = (...args: string[]): string =>
    execFileSync(process.execPath, [join(REPO_ROOT, 'out/cli/index.js'), ...args], {
      env: testEnv(queHome, env),
      encoding: 'utf8'
    })

  const snapshot = (termId: string): string => que('term', 'snapshot', termId)

  /** The pid of the fake claude running in a workspace's worktree. */
  const claudePid = (slug: string): number => {
    const call = readFakeLog(join(queHome, 'fake-claude.log')).find(
      (c) => c.cwd.endsWith(`/${slug}`) && c.argv[0] !== 'agents'
    )

    if (call?.pid === undefined) throw new Error(`no claude in ${slug}`)

    return call.pid
  }

  // The app first, so the daemon it starts carries the demo env into every terminal.
  launched = await launchApp({ queHome, env })
  const main = launched.window
  const browserWindow = await launched.app.browserWindow(main)
  await browserWindow.evaluate(
    (w, [width, height]) => {
      w.setSize(width, height)
      w.center()
    },
    [WIDTH, HEIGHT]
  )
  const sidebar = new SidebarPage(main)
  const terminal = new TerminalPage(main)
  await sidebar.waitForLoad()

  const workspaces: Record<string, Workspace> = {}

  await test.step('One project, four workspaces, a claude session working in each', async () => {
    JSON.parse(que('project', 'add', repo, '--json')) as Project

    // The one the work view shows starts last, so its banner and prompt are still on screen.
    for (const s of [...SESSIONS].reverse()) {
      workspaces[s.slug] = JSON.parse(
        que('work', s.title, '--name', s.slug, '-r', repo, '--json')
      ) as Workspace
      const termId = que('ws', 'terminal', workspaces[s.slug].id).trim()
      await expect.poll(() => snapshot(termId)).toContain(`${s.slug} %`)
      await terminal.writeTo(termId, 'clear; claude\r')
      await expect.poll(() => snapshot(termId)).toMatch(/^>\s*$/m)
      await terminal.writeTo(termId, `${PROMPTS[s.slug]}\r`)
    }

    for (const s of SESSIONS) await sidebar.waitForWorkspaceStatus(workspaces[s.slug].id, 'working')
  })

  await test.step('The bump finishes before the recording starts', async () => {
    const bump = workspaces['bump-node-pty']
    const termId = que('ws', 'terminal', bump.id).trim()
    await expect.poll(() => snapshot(termId).split('● Bash').length).toBeGreaterThan(1)
    process.kill(claudePid('bump-node-pty'), 'SIGUSR1')
    await sidebar.waitForWorkspaceStatus(bump.id, 'idle')
  })

  await test.step('1. The work view: sessions working, the terminal moving', async () => {
    const retry = workspaces['add-retry-with-backoff']
    await sidebar.workspaceOpen(retry.id).click()
    // The real pointer off the rows, so no card opens; the overlay cursor is what shows.
    await main.mouse.move(WIDTH - 40, HEIGHT / 2)
    await terminal.waitForActiveTerminal()
    // A few steps on screen, so the terminal reads as busy under its prompt.
    await expect
      .poll(async () => (await terminal.screenText()).split('● ').length, { timeout: 20_000 })
      .toBeGreaterThan(3)
    await placeCursor(main, 620, 300)

    let last = ''

    for (let i = 0; i < 5; i++) {
      await expect.poll(() => terminal.screenText(), { timeout: 10_000 }).not.toBe(last)
      last = await terminal.screenText()
      await capture(main, 'main', 550)
    }
  })

  let board: QuietBoardPage

  await test.step('2. Quiet from the sidebar foot: an hour', async () => {
    await glideAndClick(main, 'main', sidebar.quietButton)
    board = new QuietBoardPage(await findWindow(launched.app, true))
    await board.waitForLoad()
    await expect(board.header).toHaveText(/^Quiet \d\d:\d\d · until \d\d:\d\d$/)
    await expect(board.counts).toContainText('3 running')
    await expect(board.counts).toContainText('1 idle')
  })

  await test.step('3. The board', async () => {
    await placeCursor(board.page, 470, 330)
    await capture(board.page, 'board', 3000)
  })

  await test.step('4. While quiet, one session finishes and another needs input', async () => {
    process.kill(claudePid('add-retry-with-backoff'), 'SIGUSR1')
    await expect(board.row(workspaces['add-retry-with-backoff'].id)).toHaveAttribute(
      'data-state',
      'idle'
    )
    await expect(board.counts).toContainText('2 idle')
    await capture(board.page, 'board', 2000)

    process.kill(claudePid('fix-flaky-upload-test'), 'SIGUSR2')
    await expect(board.row(workspaces['fix-flaky-upload-test'].id)).toHaveAttribute(
      'data-state',
      'needs_input'
    )
    await expect(board.counts).toContainText('1 waiting')
    await capture(board.page, 'board', 2000)
  })

  await test.step('5. Unlock: the terminals come back', async () => {
    await glideAndClick(board.page, 'board', board.unlockButton)
    await expect(sidebar.unlockCountdown).toBeVisible()
    await main.mouse.move(WIDTH - 40, HEIGHT / 2)
    // Where the board's Unlock was, roughly, rather than where Quiet was clicked.
    await placeCursor(main, 760, 520)
    await capture(main, 'main', 900)

    const flaky = workspaces['fix-flaky-upload-test']
    await glideAndClick(main, 'main', sidebar.workspaceOpen(flaky.id))
    await main.mouse.move(WIDTH - 40, HEIGHT / 2)
    await terminal.expectScreenToContain('Claude needs your permission to use Bash. Allow? (y/n)')
    await expect(sidebar.workspaceOpen(flaky.id)).toHaveAttribute('aria-current', 'page')
    await capture(main, 'main', 2500)
  })

  await test.step('6. Lock now: back to the board', async () => {
    await glideAndClick(main, 'main', sidebar.lockButton)
    board = new QuietBoardPage(await findWindow(launched.app, true))
    await board.waitForLoad()
    await expect(board.counts).toContainText('1 waiting')
    await placeCursor(board.page, 470, 330)
    await capture(board.page, 'board', 2200)
  })

  fs.writeFileSync(join(OUT, 'frames.json'), `${JSON.stringify(frames, null, 2)}\n`)
})
