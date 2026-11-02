// Split panes end to end: ⌘D splits the sessions view beside with a new
// terminal, a command runs in each pane, the divider drags, the app quits and
// relaunches on the same home, and both panes come back attached to their
// terminals, which still show what they printed.
import { expect, test } from '@playwright/test'
import { AppShellPage } from './pages/AppShellPage'
import { TerminalPage } from './pages/TerminalPage'
import { TabRowPage } from './pages/TabRowPage'
import { type LaunchedApp, launchApp, retryPointer } from './utils/app'

let launched: LaunchedApp

test.afterEach(async () => {
  await launched?.close() // quits the app AND stops the test daemon
})

test('a split survives quitting the app and comes back with both terminals', async () => {
  const suffix = Math.random().toString(36).slice(2, 8)
  const left = `QUE_LEFT_${suffix}`
  const right = `QUE_RIGHT_${suffix}`
  let terminal: TerminalPage
  let tabRow: TabRowPage
  let firstId = ''
  let secondId = ''

  await test.step('Launch on a fresh QUE_HOME; one pane with one terminal', async () => {
    launched = await launchApp()
    await new AppShellPage(launched.window).waitForLoad()
    terminal = new TerminalPage(launched.window)
    tabRow = new TabRowPage(launched.window)
    firstId = await terminal.waitForActiveTerminal()
    await expect(terminal.pane(1).root).toHaveCount(0)
  })

  await test.step('⌘D splits beside, with a new terminal focused in the second pane', async () => {
    await terminal.pane(0).input.focus()
    await launched.window.keyboard.press('Meta+d')
    await expect(terminal.pane(1).root).toBeVisible()
    await expect(terminal.divider).toHaveAttribute('aria-orientation', 'vertical')
    await expect.poll(async () => (await terminal.panes()).length).toBe(2)
    await expect.poll(async () => (await terminal.panes())[1]?.activeTermId ?? null).not.toBeNull()
    const panes = await terminal.panes()
    secondId = panes[1].activeTermId as string
    expect(secondId).not.toBe(firstId)
    expect(panes[1].focused).toBe(true)
    // The split and join controls move to the second pane's strip, the top-right corner.
    await expect(terminal.pane(1).controls).toBeVisible()
    await expect(terminal.pane(0).controls).toHaveCount(0)
    await expect(tabRow.joinButton).toBeVisible()
  })

  await test.step('A command in each pane lands in its own terminal', async () => {
    await terminal.pane(1).input.focus()
    await launched.window.keyboard.type(`echo ${right}`)
    await launched.window.keyboard.press('Enter')
    await terminal.expectPaneScreenToContain(1, right)
    await terminal.pane(0).input.focus()
    await launched.window.keyboard.type(`echo ${left}`)
    await launched.window.keyboard.press('Enter')
    await terminal.expectPaneScreenToContain(0, left)
    expect(await terminal.screenTextOf(secondId)).not.toContain(left)
  })

  await test.step('Dragging the divider changes the split', async () => {
    const box = await terminal.divider.boundingBox()
    expect(box).not.toBeNull()
    const { x, y, width, height } = box as { x: number; y: number; width: number; height: number }
    await retryPointer(async () => {
      // From wherever the last attempt left the divider.
      const from = await terminal.divider.boundingBox()
      await launched.window.mouse.move((from as { x: number }).x + width / 2, y + height / 2)
      await launched.window.mouse.down()
      await launched.window.mouse.move(x + width / 2 + 120, y + height / 2, { steps: 6 })
      await launched.window.mouse.up()
      const after = await terminal.divider.boundingBox()
      expect((after as { x: number }).x).toBeGreaterThan(x + 60)
    })
    await launched.window.screenshot({ path: 'test-results/split-panes.png' })
  })

  await test.step('Quit the app; relaunch on the same home: both panes reattach', async () => {
    await launched.app.close() // the app only, NOT launched.close(), which also stops the daemon
    launched = await launchApp({ queHome: launched.queHome })
    await new AppShellPage(launched.window).waitForLoad()
    terminal = new TerminalPage(launched.window)
    tabRow = new TabRowPage(launched.window)
    await expect(terminal.pane(1).root).toBeVisible()
    await expect
      .poll(async () => (await terminal.panes()).map((p) => p.activeTermId).sort())
      .toEqual([firstId, secondId].sort())
    await expect
      .poll(async () => (await terminal.screenTextOf(firstId)).includes(left), { timeout: 15_000 })
      .toBe(true)
    await expect
      .poll(async () => (await terminal.screenTextOf(secondId)).includes(right), {
        timeout: 15_000
      })
      .toBe(true)
  })

  await test.step('Join panes from the tab row: one pane holds both tabs, nothing is killed', async () => {
    await tabRow.joinButton.click()
    await expect(terminal.pane(1).root).toHaveCount(0)
    await expect(terminal.tab(firstId)).toBeVisible()
    await expect(terminal.tab(secondId)).toBeVisible()
    await expect.poll(async () => (await terminal.panes()).length).toBe(1)
  })

  await test.step("An inactive tab's × is invisible until the tab is hovered, and keeps its width", async () => {
    const active = (await terminal.panes())[0]?.activeTermId
    const inactive = active === firstId ? secondId : firstId
    await expect(terminal.tabClose(inactive)).toBeVisible()
    await expect(terminal.tabClose(inactive)).toHaveCSS('opacity', '0')
    await retryPointer(async () => {
      await terminal.tabSelect(inactive).hover()
      await expect(terminal.tabClose(inactive)).toHaveCSS('opacity', '0.5')
    })
  })

  await test.step('Split below from the tab row; the controls stay in the top strip, the first', async () => {
    await expect(terminal.pane(0).controls).toBeVisible()
    await tabRow.splitBelowButton.click()
    await expect(terminal.divider).toHaveAttribute('aria-orientation', 'horizontal')
    await expect.poll(async () => (await terminal.panes()).length).toBe(2)
    await expect(terminal.pane(0).controls).toBeVisible()
    await expect(terminal.pane(1).controls).toHaveCount(0)
    await expect(tabRow.joinButton).toBeVisible()
  })
})
