// Keys in a terminal, through the real xterm on macOS into a real program: Option acts as Meta until
// the setting turns it off, Cmd moves on the line and clears it, Cmd+C copies a selection, and a
// held Space (hold-to-talk dictation watches for it) reaches the program whole.
import { expect, test } from '@playwright/test'
import { AppShellPage } from './pages/AppShellPage'
import { TerminalPage } from './pages/TerminalPage'
import { type LaunchedApp, launchApp } from './utils/app'
import { stubClipboard } from './utils/helpers'
import { que } from './utils/que'

declare global {
  interface Window {
    /** The `repeat` flag of every Space keydown since the spec started recording. */
    spaceRepeats?: boolean[]
  }
}

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

/** Runs a program in the shell and waits until it holds the foreground. */
async function run(command: string, program: string): Promise<void> {
  await launched.window.keyboard.type(command)
  await launched.window.keyboard.press('Enter')
  await expect.poll(() => terminal.tabSelect(id).textContent()).toBe(program)
}

test('Option acts as Meta until the setting turns it off, live', async () => {
  const keyboard = () => launched.window.keyboard

  await test.step('A program sees Option+B as Meta+B', async () => {
    await run('cat -v', 'cat')
    await keyboard().press('Alt+b')
    await keyboard().type('META')
    await keyboard().press('Enter')
    await terminal.expectScreenToContain('^[bMETA')
  })

  await test.step('With the setting off, the open terminal stops sending Meta', async () => {
    que(launched.queHome, 'config', 'set', 'terminal.option_as_meta=false')
    let attempt = 0
    await expect(async () => {
      attempt += 1
      await keyboard().press('Alt+b')
      await keyboard().type(`PLAIN${attempt}`)
      await keyboard().press('Enter')
      await terminal.expectScreenToContain(`PLAIN${attempt}`, 1_000)
    }).toPass({ timeout: 15_000 })
  })
})

test('Cmd moves on the line and clears it, and Cmd+C still copies a selection', async () => {
  const keyboard = () => launched.window.keyboard
  const clipboardWrites = await stubClipboard(launched.window)

  await test.step('Cmd+Left sends Ctrl+A and Cmd+Right sends Ctrl+E', async () => {
    await run('cat -v', 'cat')
    await keyboard().press('Meta+ArrowLeft')
    await keyboard().press('Meta+ArrowRight')
    await keyboard().press('Enter')
    await terminal.expectScreenToContain('^A^E')
  })

  await test.step('Cmd+Backspace sends Ctrl+U, which clears the line', async () => {
    await keyboard().type('GONE')
    await keyboard().press('Meta+Backspace')
    await keyboard().type('KEPT')
    await keyboard().press('Enter')
    await terminal.expectScreenToContain('KEPT')
  })

  await test.step('Cmd+C copies the selection and sends nothing to the program', async () => {
    await keyboard().press('Meta+a')
    await keyboard().press('Meta+c')
    await expect.poll(clipboardWrites).toEqual([expect.stringContaining('KEPT')])
    await keyboard().type('STILLCAT')
    await keyboard().press('Enter')
    await terminal.expectScreenToContain('STILLCAT')
  })
})

test('a held Space reaches the running program, every repeat of it', async () => {
  const keyboard = () => launched.window.keyboard

  await test.step('A program turns each space it reads into an underscore', async () => {
    await run(`tr ' ' _`, 'tr')
  })

  await test.step('Eight keydowns of one held key arrive as eight spaces', async () => {
    await launched.window.evaluate(() => {
      const repeats: boolean[] = []
      window.spaceRepeats = repeats
      window.addEventListener(
        'keydown',
        (e) => {
          if (e.key === ' ') repeats.push(e.repeat)
        },
        true
      )
    })

    for (let i = 0; i < 8; i++) await keyboard().down(' ')
    await keyboard().up(' ')
    await keyboard().type('HELD')
    await keyboard().press('Enter')
    await terminal.expectScreenToContain('________HELD')

    expect(await launched.window.evaluate(() => window.spaceRepeats)).toEqual([
      false,
      true,
      true,
      true,
      true,
      true,
      true,
      true
    ])
  })
})
