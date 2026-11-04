// A terminal's right-click menu and OSC 52, with the real xterm and the real daemon. The clipboard
// is an in-memory stand-in (see stubClipboard); the rules of OSC 52 are in the logic and renderer
// tests, and this proves the one thing they cannot: a real re-attach does not repeat a write.
import { expect, test } from '@playwright/test'
import { AppShellPage } from './pages/AppShellPage'
import { TerminalPage } from './pages/TerminalPage'
import { type LaunchedApp, launchApp } from './utils/app'
import { stubClipboard } from './utils/helpers'

let launched: LaunchedApp
let terminal: TerminalPage
let id = ''

test.beforeEach(async () => {
  launched = await launchApp()
  await new AppShellPage(launched.window).waitForLoad()
  terminal = new TerminalPage(launched.window)
  id = await terminal.waitForActiveTerminal()
  await terminal.input.focus()
})

test.afterEach(async () => {
  await launched?.close() // quits the app AND stops the test daemon
})

test('right-click offers Copy only with a selection, and Paste reaches the program', async () => {
  const pasted = `PASTED${Math.random().toString(36).slice(2, 8)}`
  const clipboardWrites = await stubClipboard(launched.window, pasted)
  const at = { x: 120, y: 80 }
  const menu = () => terminal.menu(id)

  await test.step('A program holds the terminal', async () => {
    await launched.window.keyboard.type('cat')
    await launched.window.keyboard.press('Enter')
    await expect.poll(() => terminal.tabSelect(id).textContent()).toBe('cat')
  })

  await test.step('With no selection the menu holds Paste alone, at the pointer', async () => {
    await terminal.viewport.click({ button: 'right', position: at })
    await expect(menu().paste).toBeVisible()
    await expect(menu().copy).toHaveCount(0)
    const viewport = await terminal.viewport.boundingBox()
    const item = await menu().paste.boundingBox()
    expect(viewport).not.toBeNull()
    expect(item).not.toBeNull()
    const { x, y } = viewport as { x: number; y: number }
    const { x: itemX, y: itemY } = item as { x: number; y: number }
    expect(Math.abs(itemX - (x + at.x))).toBeLessThan(12)
    expect(Math.abs(itemY - (y + at.y))).toBeLessThan(12)
  })

  await test.step('Escape closes it and the keyboard is back in the terminal', async () => {
    await launched.window.keyboard.press('Escape')
    await expect(menu().paste).toHaveCount(0)
    await expect(terminal.input).toBeFocused()
  })

  await test.step('Paste types the clipboard into the program', async () => {
    await terminal.viewport.click({ button: 'right', position: at })
    await menu().paste.click()
    await terminal.expectScreenToContain(pasted)
    await launched.window.keyboard.press('Enter')
  })

  await test.step('With a selection the menu adds Copy, which copies it', async () => {
    await launched.window.keyboard.press('Meta+a')
    await terminal.viewport.click({ button: 'right', position: at })
    await expect(menu().copy).toBeVisible()
    await expect(menu().paste).toBeVisible()
    await launched.window.screenshot({ path: 'test-results/terminal-menu.png' })
    await menu().copy.click()
    await expect.poll(clipboardWrites).toEqual([expect.stringContaining(pasted)])
  })
})

test('a paste event in the real window: text loses its escapes, and an image is left alone', async () => {
  await test.step('A program that enabled bracketed paste holds the terminal', async () => {
    await launched.window.keyboard.type(`printf '\\033[?2004h'; cat -v`)
    await launched.window.keyboard.press('Enter')
    await expect.poll(() => terminal.tabSelect(id).textContent()).toBe('cat')
  })

  await test.step('Text cannot end the bracketed paste: only the real closing bracket is there', async () => {
    await terminal.firePaste({ text: 'safe\x1b[201~run' })
    await terminal.expectScreenToContain('^[[200~safe[201~run^[[201~')
    await launched.window.keyboard.press('Enter')
  })

  await test.step('An image holds no text: the program gets the empty paste it gets today', async () => {
    await terminal.firePaste({ imageName: 'shot.png' })
    await terminal.expectScreenToContain('^[[200~^[[201~')
  })
})

test('a program sets the clipboard with OSC 52, and attaching again does not repeat it', async () => {
  const suffix = Math.random().toString(36).slice(2, 8)
  const first = `FIRST${suffix}`
  const second = `SECOND${suffix}`
  const clipboardWrites = await stubClipboard(launched.window)
  const osc52 = (text: string): string => `printf '\\033]52;c;%s\\a' "$(printf ${text} | base64)"`

  await test.step('A program writes to the clipboard', async () => {
    await launched.window.keyboard.type(osc52(first))
    await launched.window.keyboard.press('Enter')
    await expect.poll(clipboardWrites).toEqual([first])
  })

  await test.step('The terminal is left and attached again from the snapshot', async () => {
    await launched.window.keyboard.press('Meta+t')
    await expect.poll(async () => (await terminal.panes())[0]?.activeTermId).not.toBe(id)
    await terminal.tabSelect(id).click()
    await expect.poll(() => terminal.activeTermId()).toBe(id)
  })

  await test.step('Only the next write arrives: the old one did not fire again', async () => {
    await terminal.input.focus()
    await launched.window.keyboard.type(osc52(second))
    await launched.window.keyboard.press('Enter')
    await expect.poll(clipboardWrites).toEqual([first, second])
  })
})
