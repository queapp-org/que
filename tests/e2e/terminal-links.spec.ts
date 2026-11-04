// Links in a terminal: a plain URL and an OSC 8 hyperlink read as links under the pointer, a plain
// click does nothing, and Cmd+click sends http and https to the browser through the main process's
// filter (under e2e it records the link instead of opening it). xterm's own confirm dialog never appears.
import { expect, test } from '@playwright/test'
import { AppShellPage } from './pages/AppShellPage'
import { TerminalPage } from './pages/TerminalPage'
import { type LaunchedApp, launchApp, retryPointer } from './utils/app'

let launched: LaunchedApp
let terminal: TerminalPage
let id = ''
let dialogs: string[] = []

test.beforeEach(async () => {
  dialogs = []
  launched = await launchApp()
  await new AppShellPage(launched.window).waitForLoad()
  terminal = new TerminalPage(launched.window)
  id = await terminal.waitForActiveTerminal()
  launched.window.on('dialog', (d) => {
    dialogs.push(d.message())
    void d.dismiss()
  })
  await terminal.input.focus()
})

test.afterEach(async () => {
  await launched?.close() // quits the app AND stops the test daemon
})

/** Prints one line from the shell in the terminal and waits for it on screen. */
async function print(command: string, line: string): Promise<void> {
  await launched.window.keyboard.type(command)
  await launched.window.keyboard.press('Enter')
  await terminal.expectScreenToContain(line)
}

/** Moves onto the text until xterm says the link is under the pointer. */
async function hoverLink(text: string): Promise<{ x: number; y: number }> {
  const point = await terminal.pointOf(id, text)
  await retryPointer(async () => {
    await launched.window.mouse.move(point.x - 3, point.y)
    await launched.window.mouse.move(point.x, point.y)
    await expect(terminal.linkUnderPointer).toHaveCount(1, { timeout: 2_000 })
  })

  return point
}

async function cmdClick(point: { x: number; y: number }): Promise<void> {
  await launched.window.keyboard.down('Meta')
  await launched.window.mouse.click(point.x, point.y)
  await launched.window.keyboard.up('Meta')
}

test('a plain URL reads as a link under the pointer and opens only on Cmd+click', async () => {
  const url = `https://example.com/plain-${Math.random().toString(36).slice(2, 8)}`
  let point = { x: 0, y: 0 }

  await test.step('The URL is printed; under the pointer it reads as a link', async () => {
    await print(`printf '%s\\n' ${url}`, url)
    point = await hoverLink(url)
  })

  await test.step('A plain click does nothing, then Cmd+click reaches the browser path', async () => {
    await launched.window.mouse.click(point.x, point.y)
    await cmdClick(point)
    await expect.poll(() => launched.externalOpens()).toEqual([url])
    expect(dialogs).toEqual([])
  })
})

test('an OSC 8 link opens on Cmd+click without a dialog; another scheme is never a link', async () => {
  const suffix = Math.random().toString(36).slice(2, 8)
  const url = `https://example.com/osc-${suffix}`
  const label = `OSCLINK${suffix}`
  const fileLabel = `FILELINK${suffix}`
  let point = { x: 0, y: 0 }

  await test.step('A hyperlink is printed; under the pointer it reads as a link', async () => {
    await print(`printf '\\033]8;;${url}\\033\\\\${label}\\033]8;;\\033\\\\\\n'`, label)
    point = await hoverLink(label)
  })

  await test.step('A plain click does nothing, then Cmd+click reaches the browser path', async () => {
    await launched.window.mouse.click(point.x, point.y)
    await cmdClick(point)
    await expect.poll(() => launched.externalOpens()).toEqual([url])
    expect(dialogs).toEqual([])
  })

  await test.step('A file: hyperlink is no link: Cmd+click opens nothing and asks nothing', async () => {
    await print(
      `printf '\\033]8;;file:///etc/hosts\\033\\\\${fileLabel}\\033]8;;\\033\\\\\\n'`,
      fileLabel
    )
    const file = await terminal.pointOf(id, fileLabel)
    await launched.window.mouse.move(file.x, file.y)
    await cmdClick(file)
    // A link clicked after it reaches the list, so anything the first click sent would be there too.
    const after = `${url}/after`
    await print(`printf '%s\\n' ${after}`, after)
    await cmdClick(await hoverLink(after))
    await expect.poll(() => launched.externalOpens()).toEqual([url, after])
    expect(dialogs).toEqual([])
  })
})
