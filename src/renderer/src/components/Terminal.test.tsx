import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { fakeBridge } from '@renderer/testing/fake-bridge'
import { makeTermInfo } from '@renderer/testing/fixtures'
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
})
