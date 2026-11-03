import { describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { fakeBridge } from '@renderer/testing/fake-bridge'
import { makeProject, makeTermInfo, makeWorkspace } from '@renderer/testing/fixtures'
import App from './App'

const uploader = makeTermInfo({ name: 'zsh', cwd: '/Users/dev/code/uploader' })
const api = makeTermInfo({ name: 'node', cwd: '/Users/dev/code/api' })

describe('App', () => {
  describe('rendering', () => {
    it('reattaches to the terminals already running in the daemon', async () => {
      fakeBridge.seedTerminal(uploader)
      fakeBridge.seedTerminal(api)

      render(<App />)

      expect(await screen.findByTestId(`terminal-tab-${api.id}`)).toBeInTheDocument()
      expect(screen.getByTestId(`terminal-tab-${uploader.id}-reattached`)).toBeInTheDocument()
      expect(screen.getByTestId(`terminal-tab-${api.id}-reattached`)).toBeInTheDocument()
      expect(screen.getByTestId(`terminal-tab-${api.id}-select`)).toHaveAttribute(
        'aria-selected',
        'true'
      )
    })

    it('opens one terminal in the home directory on a fresh launch', async () => {
      render(<App />)

      expect(await screen.findByRole('tab')).toBeInTheDocument()
      const terms = await window.que.term.list()
      expect(terms).toHaveLength(1)
      expect(terms[0].cwd).toBe('/Users/dev')
      expect(screen.queryByText('reattached')).not.toBeInTheDocument()
    })
  })

  describe('user interactions', () => {
    it('kills the terminal when its tab is closed', async () => {
      const user = userEvent.setup()
      fakeBridge.seedTerminal(uploader)
      render(<App />)

      await user.click(await screen.findByRole('button', { name: 'Close zsh' }))

      await waitFor(() => {
        expect(fakeBridge.getTerminal(uploader.id)).toBeUndefined()
      })
      expect(screen.queryByTestId(`terminal-tab-${uploader.id}`)).not.toBeInTheDocument()
      expect(screen.getByTestId('terminal-empty')).toBeInTheDocument()
    })

    it("opens a new terminal in the active terminal's directory", async () => {
      const user = userEvent.setup()
      fakeBridge.seedTerminal(api)
      render(<App />)
      await screen.findByTestId(`terminal-tab-${api.id}`)

      await user.click(screen.getByRole('button', { name: 'New terminal' }))

      await waitFor(() => {
        expect(screen.getAllByRole('tab')).toHaveLength(2)
      })
      const created = (await window.que.term.list()).find((t) => t.id !== api.id)
      expect(created?.cwd).toBe('/Users/dev/code/api')
    })
  })

  describe('keyboard', () => {
    it('opens a tab with Cmd+T and closes the active one with Cmd+W', async () => {
      const user = userEvent.setup()
      fakeBridge.seedTerminal(uploader)
      render(<App />)
      await screen.findByTestId(`terminal-tab-${uploader.id}`)

      await user.keyboard('{Meta>}t{/Meta}')

      await waitFor(() => {
        expect(screen.getAllByRole('tab')).toHaveLength(2)
      })
      const created = (await window.que.term.list()).find((t) => t.id !== uploader.id)
      expect(screen.getByTestId(`terminal-tab-${created?.id}-select`)).toHaveAttribute(
        'aria-selected',
        'true'
      )

      await user.keyboard('{Meta>}w{/Meta}')

      await waitFor(() => {
        expect(fakeBridge.getTerminal(created?.id ?? '')).toBeUndefined()
      })
      expect(screen.getAllByRole('tab')).toHaveLength(1)
    })
  })

  describe('review shortcut', () => {
    it('toggles the review pane with Cmd+B, on the view it was left on', async () => {
      const user = userEvent.setup()
      const retry = makeWorkspace({ id: 'ws_01hzx3k9c2qf', name: 'app-1432-retry-logic' })
      fakeBridge.seedProject(makeProject())
      fakeBridge.seedWorkspace(retry)
      render(<App />)
      await user.click(await screen.findByTestId(`sidebar-workspace-${retry.id}-open`))
      expect(await screen.findByTestId('review-rail')).toBeInTheDocument()

      await user.keyboard('{Meta>}b{/Meta}')

      expect(screen.getByTestId('review-pane')).toHaveAttribute('data-view', 'changes')
      expect(screen.queryByTestId('review-rail')).not.toBeInTheDocument()
      await user.click(screen.getByRole('tab', { name: 'Pull requests' }))

      await user.keyboard('{Meta>}b{/Meta}')

      expect(screen.queryByTestId('review-pane')).not.toBeInTheDocument()
      expect(screen.getByTestId('review-rail')).toBeInTheDocument()

      await user.keyboard('{Meta>}b{/Meta}')

      expect(screen.getByTestId('review-pane')).toHaveAttribute('data-view', 'prs')
    })

    it('leaves Cmd+B alone while a dialog is open', async () => {
      const user = userEvent.setup()
      const retry = makeWorkspace({ id: 'ws_01hzx3k9c2qf', name: 'app-1432-retry-logic' })
      fakeBridge.seedProject(makeProject())
      fakeBridge.seedWorkspace(retry)
      render(<App />)
      await user.click(await screen.findByTestId(`sidebar-workspace-${retry.id}-open`))
      await user.click(await screen.findByRole('button', { name: 'Show review' }))
      await user.click(screen.getByRole('button', { name: 'More actions for uploader' }))
      await user.click(screen.getByRole('menuitem', { name: 'New workspace…' }))
      expect(screen.getByRole('dialog')).toBeInTheDocument()

      await user.keyboard('{Meta>}b{/Meta}')

      expect(screen.getByTestId('review-pane')).toBeInTheDocument()
    })
  })

  describe('search shortcut', () => {
    it('opens the sidebar search with Cmd+K, focused', async () => {
      const user = userEvent.setup()
      fakeBridge.seedTerminal(uploader)
      render(<App />)
      await screen.findByTestId('sidebar-search-toggle')
      expect(screen.queryByTestId('sidebar-search')).not.toBeInTheDocument()

      await user.keyboard('{Meta>}k{/Meta}')

      expect(await screen.findByTestId('sidebar-search')).toHaveFocus()
    })

    it('focuses and selects the text again when Cmd+K is pressed while open', async () => {
      const user = userEvent.setup()
      fakeBridge.seedTerminal(uploader)
      render(<App />)
      await user.click(await screen.findByTestId('sidebar-search-toggle'))
      const field = (await screen.findByTestId('sidebar-search')) as HTMLInputElement
      await user.type(field, 'abc')
      field.blur()
      expect(field).not.toHaveFocus()

      await user.keyboard('{Meta>}k{/Meta}')

      expect(field).toHaveFocus()
      expect(field.selectionStart).toBe(0)
      expect(field.selectionEnd).toBe(3)
    })

    it('leaves Cmd+K alone while a dialog is open', async () => {
      const user = userEvent.setup()
      fakeBridge.seedProject(makeProject())
      render(<App />)
      await user.click(await screen.findByRole('button', { name: /^More actions for/ }))
      await user.click(screen.getByRole('menuitem', { name: 'New workspace…' }))
      await screen.findByRole('dialog')

      await user.keyboard('{Meta>}k{/Meta}')

      expect(screen.queryByTestId('sidebar-search')).not.toBeInTheDocument()
    })
  })

  describe('errors', () => {
    const board = makeWorkspace({ id: 'ws_01hzx4m1p8rt', name: 'app-1440-quiet-board' })

    it('names the workspace and each removal step that failed, with its reason, until dismissed', async () => {
      const user = userEvent.setup()
      fakeBridge.seedProject(makeProject())
      fakeBridge.seedWorkspace(board)
      fakeBridge.holdRemovals()
      render(<App />)
      await screen.findByTestId(`sidebar-workspace-${board.id}`)
      await window.que.workspace.remove({ id: board.id, deleteBranch: true })

      fakeBridge.advanceRemoval(board.id)
      fakeBridge.advanceRemoval(board.id, { error: 'timed out after 60s' })
      fakeBridge.advanceRemoval(board.id)
      fakeBridge.advanceRemoval(board.id, { error: 'not fully merged' })

      expect(await screen.findByRole('alert')).toHaveTextContent(
        /^Removing app-1440-quiet-board: running teardown failed, timed out after 60s; deleting branch failed, not fully merged×$/
      )
      expect(screen.queryByTestId(`sidebar-workspace-${board.id}`)).not.toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: 'Dismiss' }))

      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('says nothing after a clean removal', async () => {
      fakeBridge.seedProject(makeProject())
      fakeBridge.seedWorkspace(board)
      render(<App />)
      await screen.findByTestId(`sidebar-workspace-${board.id}`)

      await window.que.workspace.remove({ id: board.id, deleteBranch: true })

      await waitFor(() => {
        expect(screen.queryByTestId(`sidebar-workspace-${board.id}`)).not.toBeInTheDocument()
      })
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('says it is reconnecting when the daemon connection drops', async () => {
      fakeBridge.seedTerminal(uploader)
      render(<App />)
      await screen.findByTestId(`terminal-tab-${uploader.id}`)

      fakeBridge.disconnect()

      expect(await screen.findByTestId('app-reconnecting')).toHaveTextContent(
        'Reconnecting to the background service…'
      )
    })

    it('says why a reconnect failed, and tries again on Reconnect', async () => {
      const user = userEvent.setup()
      fakeBridge.seedTerminal(uploader)
      render(<App />)
      await screen.findByTestId(`terminal-tab-${uploader.id}`)
      fakeBridge.disconnect()
      await screen.findByTestId('app-reconnecting')

      fakeBridge.failReconnect('daemon did not answer within 5000 ms')

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Lost connection to the background service: daemon did not answer within 5000 ms'
      )
      const asked = fakeBridge.daemonStateCalls()

      await user.click(screen.getByRole('button', { name: 'Reconnect' }))
      expect(await screen.findByTestId('app-reconnecting')).toBeInTheDocument()
      expect(fakeBridge.daemonStateCalls()).toBe(asked + 1)

      fakeBridge.reconnect()

      await waitFor(() => {
        expect(screen.queryByTestId('app-reconnecting')).not.toBeInTheDocument()
      })
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('reloads after a reconnect: gone terminals read exited, the shown workspace is watched again and opens a fresh shell', async () => {
      const user = userEvent.setup()
      const retry = makeWorkspace({ id: 'ws_01hzx3k9c2qf', name: 'app-1432-retry-logic' })
      const shell = makeTermInfo({ name: 'claude', workspaceId: retry.id })
      fakeBridge.seedProject(makeProject())
      fakeBridge.seedWorkspace(retry)
      fakeBridge.seedTerminal(shell)
      render(<App />)
      await user.click(await screen.findByTestId(`sidebar-workspace-${retry.id}-open`))
      await screen.findByTestId(`terminal-tab-${shell.id}`)
      await waitFor(() => {
        expect(fakeBridge.watchCalls()).toEqual([{ id: retry.id, on: true }])
      })
      const lists = fakeBridge.termListCount()

      fakeBridge.disconnect()
      await screen.findByTestId('app-reconnecting')
      // The daemon was restarted elsewhere: it comes back without the old terminals.
      fakeBridge.forgetTerminals()
      fakeBridge.reconnect()

      expect(await screen.findByTestId(`terminal-tab-${shell.id}-exited`)).toBeInTheDocument()
      await waitFor(async () => {
        const fresh = await window.que.term.list({ workspaceId: retry.id })
        expect(fresh.filter((t) => t.alive)).toHaveLength(1)
      })
      expect(fakeBridge.termListCount()).toBeGreaterThan(lists)
      expect(fakeBridge.watchCalls()).toEqual([
        { id: retry.id, on: true },
        { id: retry.id, on: true }
      ])
      expect(screen.queryByTestId('app-reconnecting')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'New terminal' })).toBeEnabled()
    })

    it('disables every daemon action while disconnected', async () => {
      const user = userEvent.setup()
      const retry = makeWorkspace({ id: 'ws_01hzx3k9c2qf', name: 'app-1432-retry-logic' })
      fakeBridge.seedProject(makeProject())
      fakeBridge.seedWorkspace(retry)
      render(<App />)
      await user.click(await screen.findByTestId(`sidebar-workspace-${retry.id}-open`))
      await user.click(await screen.findByRole('button', { name: 'Show review' }))
      expect(await screen.findByRole('button', { name: 'Open in editor' })).toBeEnabled()

      fakeBridge.disconnect()

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Open in editor' })).toBeDisabled()
      })

      for (const name of [
        'Refresh',
        'New terminal',
        'Split beside',
        'Split below',
        'Add project',
        'New session'
      ]) {
        expect(screen.getByRole('button', { name })).toBeDisabled()
      }

      expect(
        screen.getByRole('button', { name: 'New workspace running Claude Code in uploader' })
      ).toBeDisabled()

      expect(screen.getByRole('button', { name: 'Open in editor' })).toBeDisabled()
    })
  })
})
