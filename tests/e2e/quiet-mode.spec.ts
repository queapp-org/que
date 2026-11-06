// Quiet mode end to end: a workspace with a running terminal made with the
// CLI, then quiet hours turned on (with `que config set`) around the current
// time. Launched inside them, the board is the only window shown, with the
// workspace counted as idle and its row; the CLI's attach is refused (exit 3);
// Unlock brings the main window back with its countdown in the sidebar's foot, and when the
// (six-second) unlock runs out the board returns on its own.
import { expect, test } from '@playwright/test'
import { hhmm } from '../../src/shared/format'
import type { Workspace } from '../../src/shared/types'
import { makeTempRepo } from '../../src/testing/temp-repo'
import { QuietBoardPage } from './pages/QuietBoardPage'
import { SidebarPage } from './pages/SidebarPage'
import {
  findWindow,
  type LaunchedApp,
  launchApp,
  newQueHome,
  retryPointer,
  windowStates,
  tempDir
} from './utils/app'
import { que, queJson, queResult } from './utils/que'

let launched: LaunchedApp

test.afterEach(async () => {
  await launched?.close() // quits the app AND stops the test daemon
})

/** A workspace on `repo` with one running terminal, made with the CLI. */
function workspaceWithTerminal(queHome: string, repo: string, name: string): Workspace {
  const workspace = queJson<Workspace>(queHome, 'work', '--name', name, '-r', repo, '--json')
  expect(que(queHome, 'ws', 'terminal', workspace.id).trim()).toMatch(/^[0-9a-f-]{36}$/)

  return workspace
}

/** Quiet hours on, an hour either side of `now`, with any other settings. */
function quietHoursAroundNow(queHome: string, now: number, ...settings: string[]): void {
  que(
    queHome,
    'config',
    'set',
    'quiet_hours.enabled=true',
    `quiet_hours.default=${hhmm(now - 60 * 60_000)},${hhmm(now + 60 * 60_000)}`,
    ...settings
  )
}

test('quiet hours show only the board; an unlock brings detail back until it runs out', async () => {
  const repo = makeTempRepo(tempDir('que-e2e-repo-'))
  // A window an hour either side of now, and a 0.1-minute unlock.
  const now = Date.now()
  const windowEnd = hhmm(now + 60 * 60_000)
  const queHome = newQueHome()
  let workspace: Workspace
  let board: QuietBoardPage

  await test.step('Create a workspace with a running terminal with the CLI', async () => {
    workspace = workspaceWithTerminal(queHome, repo, 'app-1500-quiet-board')
  })

  await test.step('Turn quiet hours on around now, with a 0.1-minute unlock', async () => {
    quietHoursAroundNow(queHome, now, 'quiet_hours.unlock_minutes=0.1')
    expect(que(queHome, 'quiet', 'status').trim()).toBe(`quiet hours until ${windowEnd}`)
  })

  await test.step('Launch: the board is the visible window, the main window is hidden', async () => {
    launched = await launchApp({ queHome })
    board = new QuietBoardPage(await findWindow(launched.app, true))
    await board.waitForLoad()
    await expect
      .poll(() => windowStates(launched.app))
      .toEqual(
        expect.arrayContaining([
          { board: true, visible: true },
          { board: false, visible: false }
        ])
      )
    await expect(board.header).toHaveText(
      new RegExp(`^Quiet hours \\d\\d:\\d\\d · until ${windowEnd}$`)
    )
    await expect(board.counts).toHaveText('1 idle')
    await expect(board.row(workspace.id)).toContainText('app-1500-quiet-board')
    await expect(board.row(workspace.id)).toHaveAttribute('data-state', 'idle')
    await expect(board.row(workspace.id)).toContainText('idle')
    await expect(board.unlockButton).toHaveText('Unlock 0.1 min')
    await board.page.screenshot({ path: 'test-results/wp5-quiet-board.png' })
  })

  await test.step('The CLI refuses to attach while quiet, with exit code 3', async () => {
    const r = queResult(queHome, 'attach', workspace.id)
    expect(r.code).toBe(3)
    expect(r.stderr).toBe(`quiet hours until ${windowEnd}; run \`que unlock\` for 0.1 minutes\n`)
  })

  await test.step('Unlock: the main window comes back with the countdown', async () => {
    await board.unlockButton.click()
    const main = await findWindow(launched.app, false)
    const sidebar = new SidebarPage(main)
    await expect.poll(() => windowStates(launched.app)).toEqual([{ board: false, visible: true }])
    await expect(sidebar.unlockCountdown).toHaveText(/^0:0\d left$/)
    await expect(sidebar.lockButton).toHaveText('lock now')
    await expect(sidebar.lockButton).toBeVisible()
  })

  await test.step('When the unlock runs out, the board returns with no prompt', async () => {
    await expect
      .poll(() => windowStates(launched.app), { timeout: 20_000 })
      .toEqual(
        expect.arrayContaining([
          { board: true, visible: true },
          { board: false, visible: false }
        ])
      )
    board = new QuietBoardPage(await findWindow(launched.app, true))
    await board.waitForLoad()
    expect(queResult(queHome, 'attach', workspace.id).code).toBe(3)
  })
})

test('a board with more rows than fit scrolls them under the wheel', async () => {
  const repo = makeTempRepo(tempDir('que-e2e-repo-'))
  const now = Date.now()
  const queHome = newQueHome()
  let board: QuietBoardPage

  await test.step('Ten workspaces with running terminals, made with the CLI', async () => {
    for (let i = 0; i < 10; i++) workspaceWithTerminal(queHome, repo, `app-15${i}0-board-row`)
    quietHoursAroundNow(queHome, now)
  })

  await test.step("Launch at the board's own size: the last row is below the fold", async () => {
    launched = await launchApp({ queHome })
    const page = await findWindow(launched.app, true)
    board = new QuietBoardPage(page)
    await board.waitForLoad()
    // launchApp sizes the first window for the specs; the board is 600×400 in the app.
    const win = await launched.app.browserWindow(page)
    await win.evaluate((w) => w.setSize(600, 400))
    await expect(board.counts).toHaveText('10 idle')
    await expect(board.rows.locator('li')).toHaveCount(10)
    await expect(board.rows.locator('li').last()).not.toBeInViewport()
  })

  await test.step('A wheel over the rows scrolls the last row into view', async () => {
    await retryPointer(async () => {
      // Back to the top first, so only this attempt's wheel can bring the last row into view.
      await board.rows.evaluate((el) => {
        el.scrollTop = 0
      })
      await expect(board.rows.locator('li').last()).not.toBeInViewport()
      const box = await board.rows.boundingBox()

      if (!box) throw new Error('the rows have no box')
      await board.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await board.page.mouse.wheel(0, 400)
      await expect.poll(() => board.rows.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
      await expect(board.rows.locator('li').last()).toBeInViewport()
    })
    await board.page.screenshot({ path: 'test-results/quiet-board-scrolled.png' })
  })
})

test('a manual quiet from the CLI shows the board; End quiet brings the main window back', async () => {
  // Quiet hours stay off (the default test config): only the manual window locks.
  launched = await launchApp()
  const { app, queHome } = launched
  let board: QuietBoardPage

  await test.step('Start a manual quiet with the CLI: the board replaces the main window', async () => {
    // Ten minutes, so only End quiet can close the board within the test.
    expect(que(queHome, 'quiet', 'start', '10').trim()).toMatch(/^quiet until \d\d:\d\d$/)
    board = new QuietBoardPage(await findWindow(app, true))
    await board.waitForLoad()
    await expect
      .poll(() => windowStates(app))
      .toEqual(
        expect.arrayContaining([
          { board: true, visible: true },
          { board: false, visible: false }
        ])
      )
    await expect(board.header).toHaveText(/^Quiet \d\d:\d\d · until \d\d:\d\d$/)
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()))
      )
      .toContain('que · quiet')
  })

  await test.step('End quiet: the board closes and the main window shows', async () => {
    await board.end.click()
    await expect.poll(() => windowStates(app)).toEqual([{ board: false, visible: true }])
    expect(que(queHome, 'quiet', 'status').trim()).toBe('quiet hours off')
  })
})
