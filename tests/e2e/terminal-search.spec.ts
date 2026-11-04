// Finding text in a terminal's scrollback with the real xterm: ⌘F opens the control at the focused
// terminal's top right, the count follows Enter, Shift+Enter and the buttons, and Escape closes it
// and hands the keyboard back to the terminal.
import { expect, test } from '@playwright/test'
import { AppShellPage } from './pages/AppShellPage'
import { TerminalPage } from './pages/TerminalPage'
import { type LaunchedApp, launchApp } from './utils/app'

let launched: LaunchedApp

test.afterEach(async () => {
  await launched?.close() // quits the app AND stops the test daemon
})

test('⌘F finds text in the scrollback, steps through the matches, and Escape returns to the terminal', async () => {
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase()
  const needle = `NEEDLE${suffix}`
  let terminal: TerminalPage
  let id = ''

  await test.step('Three lines hold the text, a screen apart; the typed command does not', async () => {
    launched = await launchApp()
    await new AppShellPage(launched.window).waitForLoad()
    terminal = new TerminalPage(launched.window)
    id = await terminal.waitForActiveTerminal()
    await terminal.input.focus()
    await launched.window.keyboard.type(
      `for n in 1 2 3; do printf '%s%s\\n' NEEDLE ${suffix}; seq 1 100; done`
    )
    await launched.window.keyboard.press('Enter')
    await terminal.expectScreenToContain(needle)
  })

  const find = () => terminal.find(id)

  await test.step('⌘F opens the control with the keyboard in its field', async () => {
    await launched.window.keyboard.press('Meta+f')
    await expect(find().root).toBeVisible()
    await expect(find().input).toBeFocused()
  })

  await test.step('Typing finds every match, scrolls to the current one and outlines it', async () => {
    await launched.window.keyboard.type(needle)
    await expect(find().count).toHaveText('1/3')
    // xterm shows a decoration only while its line is in the viewport, so this proves the scroll.
    await expect(find().current).toBeVisible()
    await launched.window.screenshot({ path: 'test-results/terminal-find.png' })
  })

  await test.step('Enter goes forward, Shift+Enter back, and past the end it wraps', async () => {
    await launched.window.keyboard.press('Enter')
    await expect(find().count).toHaveText('2/3')
    await launched.window.keyboard.press('Shift+Enter')
    await expect(find().count).toHaveText('1/3')
    await launched.window.keyboard.press('Shift+Enter')
    await expect(find().count).toHaveText('3/3')
  })

  await test.step('The buttons step too', async () => {
    await find().next.click()
    await expect(find().count).toHaveText('1/3')
    await find().previous.click()
    await expect(find().count).toHaveText('3/3')
  })

  await test.step('Escape closes it and the keyboard is back in the terminal', async () => {
    await find().input.focus()
    await launched.window.keyboard.press('Escape')
    await expect(find().root).toHaveCount(0)
    await expect(terminal.input).toBeFocused()
    await launched.window.keyboard.type(`echo BACK${suffix}`)
    await launched.window.keyboard.press('Enter')
    await terminal.expectScreenToContain(`BACK${suffix}`)
  })
})
