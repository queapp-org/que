// Dropping files on a terminal, through real File objects and the real preload bridge: their
// shell-quoted paths land at the cursor with no Enter, and a drop never navigates the window,
// on the terminal or anywhere else.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { AppShellPage } from './pages/AppShellPage'
import { SidebarPage } from './pages/SidebarPage'
import { TerminalPage } from './pages/TerminalPage'
import { type LaunchedApp, launchApp, tempDir } from './utils/app'

let launched: LaunchedApp

test.afterEach(async () => {
  await launched?.close() // quits the app AND stops the test daemon
})

test('dropped files paste their quoted paths at the cursor, and nothing navigates', async () => {
  const dir = tempDir('que e2e drop ')
  const shot = join(dir, 'my shot.png')
  const quote = join(dir, "it's here.txt")
  writeFileSync(shot, 'png')
  writeFileSync(quote, 'text')
  const quoted = `'${shot}' '${quote.replace("'", `'\\''`)}'`
  let terminal: TerminalPage
  let id = ''
  let url = ''

  // The paths are longer than a row, so they wrap: compare with the whitespace taken out.
  const flat = (s: string): string => s.replace(/\s/g, '')

  /** How many copies of the quoted paths are on the screen. */
  const copies = async (): Promise<number> =>
    flat(await terminal.screenTextOf(id)).split(flat(quoted)).length - 1

  await test.step('A program holds the terminal, so a line it reads comes back as a second copy', async () => {
    launched = await launchApp()
    await new AppShellPage(launched.window).waitForLoad()
    terminal = new TerminalPage(launched.window)
    id = await terminal.waitForActiveTerminal()
    url = launched.window.url()
    await terminal.input.focus()
    await launched.window.keyboard.type('cat')
    await launched.window.keyboard.press('Enter')
    await expect.poll(() => terminal.tabSelect(id).textContent()).toBe('cat')
  })

  await test.step('The drop puts the quoted paths at the cursor, and no Enter follows', async () => {
    await terminal.dropFiles([shot, quote], await terminal.viewportCenter())
    await expect.poll(copies, { message: 'the paths are not on screen' }).toBe(1)
    expect(launched.window.url()).toBe(url)
  })

  await test.step('The program had not read the line: Enter sends it, and it comes back', async () => {
    await launched.window.keyboard.press('Enter')
    await expect.poll(copies).toBe(2)
  })

  await test.step('A file dropped outside a terminal leaves the window where it is', async () => {
    const box = await new SidebarPage(launched.window).root.boundingBox()
    expect(box).not.toBeNull()
    const { x, y, width, height } = box as { x: number; y: number; width: number; height: number }
    await terminal.dropFiles([shot], { x: x + width / 2, y: y + height / 2 })
    await launched.window.keyboard.type('STILLHERE')
    await launched.window.keyboard.press('Enter')
    await terminal.expectScreenToContain('STILLHERE')
    expect(launched.window.url()).toBe(url)
  })

  await test.step('A program that enabled bracketed paste gets the paths bracketed', async () => {
    await launched.window.keyboard.press('Control+c')
    await expect.poll(() => terminal.tabSelect(id).textContent()).not.toBe('cat')
    await launched.window.keyboard.type(`printf '\\033[?2004h'; cat -v`)
    await launched.window.keyboard.press('Enter')
    await expect.poll(() => terminal.tabSelect(id).textContent()).toBe('cat')
    await terminal.dropFiles([shot], await terminal.viewportCenter())
    await expect
      .poll(async () => flat(await terminal.screenTextOf(id)))
      .toContain(flat(`^[[200~'${shot}'^[[201~`))
  })
})
