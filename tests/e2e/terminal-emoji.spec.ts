// Emoji widths, renderer and daemon together: the real xterm counts an emoji as two cells, and so
// does the daemon's mirror, so a terminal attached again from the mirror's snapshot draws the same
// screen, with its cursor in the same place.
import { expect, test } from '@playwright/test'
import { AppShellPage } from './pages/AppShellPage'
import { TerminalPage } from './pages/TerminalPage'
import { type LaunchedApp, launchApp } from './utils/app'
import { que } from './utils/que'

let launched: LaunchedApp

test.afterEach(async () => {
  await launched?.close() // quits the app AND stops the test daemon
})

test('an emoji takes two cells on screen, live and after attaching again', async () => {
  const marker = `Z${Math.random().toString(36).slice(2, 8)}`
  // ✅🚀🧠, in octal so the typed command stays ASCII.
  const emoji = String.raw`\342\234\205\360\237\232\200\360\237\247\240`
  let terminal: TerminalPage
  let id = ''

  await test.step('Three emoji are printed and a program holds the cursor after them', async () => {
    launched = await launchApp()
    await new AppShellPage(launched.window).waitForLoad()
    terminal = new TerminalPage(launched.window)
    id = await terminal.waitForActiveTerminal()
    await terminal.input.focus()
    await launched.window.keyboard.type(`clear; printf '${emoji}'; cat`)
    await launched.window.keyboard.press('Enter')
    await expect.poll(() => terminal.tabSelect(id).textContent()).toBe('cat')
  })

  await test.step('The cursor stands six cells in', async () => {
    await expect.poll(() => terminal.cursorColumn(id)).toBe(6)
  })

  await test.step('Attached again from the snapshot, the cursor stands in the same cell', async () => {
    await launched.window.keyboard.press('Meta+t')
    await expect.poll(async () => (await terminal.panes())[0]?.activeTermId).not.toBe(id)
    await terminal.tabSelect(id).click()
    await expect.poll(() => terminal.activeTermId()).toBe(id)
    await expect.poll(() => terminal.cursorColumn(id)).toBe(6)
  })

  await test.step('What is typed next lands right after them, on screen and in the mirror', async () => {
    await terminal.input.focus()
    await launched.window.keyboard.type(marker)
    const line = `✅🚀🧠${marker}`
    await terminal.expectScreenToContain(line)
    await expect.poll(() => terminal.cursorColumn(id)).toBe(6 + marker.length)
    await expect
      .poll(() => que(launched.queHome, 'term', 'snapshot', id).split('\n'))
      .toContain(line)
  })
})
