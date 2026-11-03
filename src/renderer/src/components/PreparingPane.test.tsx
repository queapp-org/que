import { describe, expect, it } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { fakeBridge } from '@renderer/testing/fake-bridge'
import { makeProject, makeWorkspace, makeWorkspaceDiff } from '@renderer/testing/fixtures'
import type { Preparation } from '@shared/types'
import App from '../App'

const uploader = makeProject()
const NOW = new Date(2026, 10, 3, 11, 0).getTime()

const preparation: Preparation = {
  plan: ['fetch', 'worktree', 'setup', 'claude'],
  since: new Date(NOW - 12_000).toISOString(),
  done: [
    { step: 'fetch', ms: 1_200 },
    { step: 'worktree', ms: 300 }
  ]
}

const preparing = makeWorkspace({
  id: 'ws_01hzx7q2n4ks',
  name: 'quiet-amber-fern',
  status: 'preparing',
  preparation
})

const elsewhere = makeWorkspace({ id: 'ws_01hzx3k9c2qf', name: 'app-1432-retry-logic' })

const pane = (id = preparing.id): HTMLElement => screen.getByTestId(`preparing-${id}`)

const line = (step: string, id = preparing.id): HTMLElement =>
  screen.getByTestId(`preparing-${id}-step-${step}`)

const right = (step: string, id = preparing.id): HTMLElement =>
  screen.getByTestId(`preparing-${id}-step-${step}-right`)

/** Mounts the app on a clock of our own, with the workspace selected. */
async function openIt(user: ReturnType<typeof userEvent.setup>, ws = preparing): Promise<void> {
  fakeBridge.seedProject(uploader)
  fakeBridge.seedWorkspace(ws)
  render(<App now={() => NOW} />)
  await user.click(await screen.findByTestId(`sidebar-workspace-${ws.id}-open`))
  await screen.findByTestId(`preparing-${ws.id}`)
}

/** Finishes every step left, as the daemon would. */
function finish(id = preparing.id): void {
  while (fakeBridge.getWorkspace(id)?.preparation) fakeBridge.advancePreparation(id)
}

/** The xterm input of the terminal on screen: its helper textarea. */
function terminalInput(): Element | null {
  return screen.getByTestId('terminal-viewport').querySelector('textarea')
}

describe('the preparing pane', () => {
  it('shows no tab and no terminal, the label, and each step in its state', async () => {
    const user = userEvent.setup()
    await openIt(user)

    expect(screen.queryAllByRole('tab')).toEqual([])
    expect(screen.queryByTestId('terminal-viewport')).not.toBeInTheDocument()
    expect(within(pane()).getByRole('heading', { name: 'Preparing' })).toHaveClass('label')

    expect(line('fetch')).toHaveAttribute('data-state', 'done')
    expect(line('fetch')).toHaveTextContent('fetching origin')
    expect(right('fetch')).toHaveTextContent('1s')
    expect(line('worktree')).toHaveAttribute('data-state', 'done')
    expect(line('worktree')).toHaveTextContent('creating worktree')
    expect(line('setup')).toHaveAttribute('data-state', 'current')
    expect(line('setup')).toHaveTextContent('running setup')
    expect(line('setup').querySelector('.working-mark.neutral')).not.toBeNull()
    expect(right('setup')).toHaveTextContent('12s')
    expect(line('claude')).toHaveAttribute('data-state', 'pending')
    expect(line('claude')).toHaveTextContent('starting Claude')
    expect(right('claude')).toHaveTextContent('')
  })

  it('says Claude starts on the brief when there is one', async () => {
    const user = userEvent.setup()
    await openIt(user, { ...preparing, brief: 'Add retry logic to the uploader' })

    expect(line('claude')).toHaveTextContent('starting Claude with your brief')
  })

  it('opens no terminal on its own, and has none to offer with + or the keyboard', async () => {
    const user = userEvent.setup()
    await openIt(user)

    expect(screen.getByRole('button', { name: 'New terminal' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Split beside' })).toBeDisabled()

    await user.keyboard('{Meta>}t{/Meta}')
    await user.keyboard('{Meta>}d{/Meta}')

    expect(await window.que.term.list({ workspaceId: preparing.id })).toEqual([])
  })

  describe('the setup log', () => {
    const button = (): HTMLElement => screen.getByRole('button', { name: 'Open setup log' })

    it('opens through the app once setup has started', async () => {
      const user = userEvent.setup()
      await openIt(user)

      await user.click(button())

      expect(fakeBridge.openSetupLogCalls()).toEqual([preparing.id])
    })

    it('waits for setup to start', async () => {
      const user = userEvent.setup()
      await openIt(user, { ...preparing, preparation: { ...preparation, done: [] } })

      expect(button()).toBeDisabled()

      act(() => {
        fakeBridge.advancePreparation(preparing.id)
        fakeBridge.advancePreparation(preparing.id)
      })

      await waitFor(() => {
        expect(button()).toBeEnabled()
      })
    })

    it('is not there without a setup command', async () => {
      const user = userEvent.setup()

      await openIt(user, {
        ...preparing,
        preparation: { ...preparation, plan: ['fetch', 'worktree', 'claude'] }
      })

      expect(screen.queryByRole('button', { name: 'Open setup log' })).not.toBeInTheDocument()
    })

    it('stays for a setup that ran, and is gone when a step stopped it before setup', async () => {
      const user = userEvent.setup()

      await openIt(user, {
        ...preparing,
        status: 'stuck',
        statusReason: 'preparation_failed',
        preparation: {
          ...preparation,
          done: [
            { step: 'fetch', ms: 900 },
            { step: 'worktree', ms: 40, error: 'no such ref' }
          ]
        }
      })

      expect(screen.queryByRole('button', { name: 'Open setup log' })).not.toBeInTheDocument()
    })
  })

  describe('a step that fails', () => {
    it('shows which step and why, leaves the rest pending, and offers Remove', async () => {
      const user = userEvent.setup()
      await openIt(user)

      act(() => fakeBridge.advancePreparation(preparing.id))
      act(() => fakeBridge.advancePreparation(preparing.id, { error: 'spawn failed: EAGAIN' }))

      await waitFor(() => {
        expect(line('claude')).toHaveAttribute('data-state', 'failed')
      })
      expect(right('claude')).toHaveTextContent('spawn failed: EAGAIN')
      expect(line('claude').querySelector('.working-mark')).toBeNull()

      await user.click(within(pane()).getByRole('button', { name: 'Remove…' }))

      expect(screen.getByRole('dialog', { name: `Remove ${preparing.name}?` })).toBeInTheDocument()
    })

    it('leaves steps after it pending, none current', async () => {
      const user = userEvent.setup()
      await openIt(user, { ...preparing, preparation: { ...preparation, done: [] } })

      act(() => fakeBridge.advancePreparation(preparing.id))
      act(() => fakeBridge.advancePreparation(preparing.id, { error: 'unknown base ref v9' }))

      await waitFor(() => {
        expect(line('worktree')).toHaveAttribute('data-state', 'failed')
      })
      expect(line('setup')).toHaveAttribute('data-state', 'pending')
      expect(line('claude')).toHaveAttribute('data-state', 'pending')
      expect(await window.que.term.list({ workspaceId: preparing.id })).toEqual([])
    })
  })

  describe("when Claude's terminal appears", () => {
    it('selects its tab and gives it the keyboard, on the workspace the user is still on', async () => {
      const user = userEvent.setup()
      await openIt(user)

      act(() => finish())

      const [tab] = await screen.findAllByRole('tab')
      expect(tab).toHaveAttribute('aria-selected', 'true')
      expect(screen.queryByTestId(`preparing-${preparing.id}`)).not.toBeInTheDocument()
      await waitFor(() => {
        expect(terminalInput()).toHaveFocus()
      })
      expect(await window.que.term.list({ workspaceId: preparing.id })).toHaveLength(1)
    })

    it('leaves the user where they have moved to, and is there when they come back', async () => {
      const user = userEvent.setup()
      fakeBridge.seedWorkspace(elsewhere)
      await openIt(user)
      const other = screen.getByTestId(`sidebar-workspace-${elsewhere.id}-open`)
      await user.click(other)
      await waitFor(() => {
        expect(other).toHaveAttribute('aria-current', 'page')
      })
      const shown = await screen.findByTestId('pane-0')
      await waitFor(() => {
        expect(shown.dataset.activeTerm).not.toBe('')
      })
      const shownTerm = shown.dataset.activeTerm

      act(() => finish())

      await waitFor(async () => {
        expect(await window.que.term.list({ workspaceId: preparing.id })).toHaveLength(1)
      })
      expect(other).toHaveAttribute('aria-current', 'page')
      expect(shown.dataset.activeTerm).toBe(shownTerm)
      const [claude] = await window.que.term.list({ workspaceId: preparing.id })

      await user.click(screen.getByTestId(`sidebar-workspace-${preparing.id}-open`))

      await waitFor(() => {
        expect(shown.dataset.activeTerm).toBe(claude.id)
      })
    })

    it('leaves the keyboard in a field the user moved to on the same workspace', async () => {
      const user = userEvent.setup()
      await openIt(user)
      await user.keyboard('{Meta>}k{/Meta}')
      const search = await screen.findByTestId('sidebar-search')
      expect(search).toHaveFocus()

      act(() => finish())

      await screen.findByTestId('terminal-viewport')
      await waitFor(() => {
        expect(search).toHaveFocus()
      })
    })

    it('leaves the keyboard in a dialog open over the pane', async () => {
      const user = userEvent.setup()
      await openIt(user)
      await user.click(screen.getByRole('button', { name: 'More actions for uploader' }))
      await user.click(screen.getByRole('menuitem', { name: 'New workspace…' }))
      const brief = screen.getByRole('textbox', { name: 'What are you doing? (optional)' })
      expect(brief).toHaveFocus()

      act(() => finish())

      await screen.findByTestId('terminal-viewport')
      await waitFor(() => {
        expect(brief).toHaveFocus()
      })
    })

    it('gives the keyboard back to the rule when its pane next gets focus', async () => {
      const user = userEvent.setup()
      await openIt(user)
      await user.keyboard('{Meta>}k{/Meta}')
      const search = await screen.findByTestId('sidebar-search')

      act(() => finish())

      await screen.findByTestId('terminal-viewport')
      expect(search).toHaveFocus()

      // The new pane takes the focus from it, and going back to it brings the keyboard along.
      await user.keyboard('{Meta>}d{/Meta}')
      await screen.findByTestId('pane-1')
      await waitFor(() => {
        expect(screen.getByTestId('pane-1')).toHaveAttribute('data-focused', 'true')
      })
      await user.keyboard('{Meta>}{Alt>}{ArrowLeft}{/Alt}{/Meta}')

      await waitFor(() => {
        expect(
          within(screen.getByTestId('pane-0'))
            .getByTestId('terminal-viewport')
            .querySelector('textarea')
        ).toHaveFocus()
      })
    })

    it('says on the error line that setup failed, and still shows Claude’s terminal', async () => {
      const user = userEvent.setup()
      await openIt(user)

      act(() => fakeBridge.advancePreparation(preparing.id, { error: 'exited with code 3' }))
      act(() => fakeBridge.advancePreparation(preparing.id))

      expect(await screen.findByRole('alert')).toHaveTextContent(
        `Preparing ${preparing.name}: running setup failed, exited with code 3`
      )
      expect(await screen.findByTestId('terminal-viewport')).toBeInTheDocument()
      expect(await window.que.term.list({ workspaceId: preparing.id })).toHaveLength(1)
      expect(screen.getByTestId(`sidebar-workspace-${preparing.id}-step`)).toHaveTextContent(
        'running setup failed: exited with code 3'
      )
    })
  })

  describe('what waits for the worktree', () => {
    it('shows no refusal for being on the workspace, and asks again once the steps have run', async () => {
      const user = userEvent.setup()
      fakeBridge.seedDiff(makeWorkspaceDiff({ workspaceId: preparing.id, files: [] }))
      await openIt(user)
      await user.click(screen.getByRole('button', { name: 'Show review' }))
      await user.click(screen.getByRole('tab', { name: 'Changes' }))

      expect(await screen.findByTestId('review-preparing')).toHaveTextContent(
        'Nothing to review yet.'
      )
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(screen.queryByText(/is not ready/)).not.toBeInTheDocument()
      // The fake answers as dispatch does: refused before it counts as a call.
      expect(fakeBridge.watchCalls()).not.toContainEqual({ id: preparing.id, on: true })
      expect(fakeBridge.diffCalls().filter((c) => c.id === preparing.id)).toEqual([])

      act(() => finish())

      await waitFor(() => {
        expect(fakeBridge.watchCalls()).toContainEqual({ id: preparing.id, on: true })
      })
      await waitFor(() => {
        expect(fakeBridge.diffCalls().some((c) => c.id === preparing.id)).toBe(true)
      })
      expect(screen.queryByTestId('review-preparing')).not.toBeInTheDocument()
    })
  })
})
