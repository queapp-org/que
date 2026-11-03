import { describe, expect, it } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { fakeBridge } from '@renderer/testing/fake-bridge'
import { makeProject, makeWorkspace } from '@renderer/testing/fixtures'
import App from '../App'

const uploader = makeProject()

/** The dialog is reached only from the project's menu. */
async function openNewWorkspace(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(await screen.findByRole('button', { name: 'More actions for uploader' }))
  await user.click(screen.getByRole('menuitem', { name: 'New workspace…' }))

  return screen.getByRole('dialog', { name: 'New workspace' })
}

/** Finishes every step of the workspace's preparation, as the daemon would. */
function finishPreparation(id: string): void {
  while (fakeBridge.getWorkspace(id)?.preparation) fakeBridge.advancePreparation(id)
}

describe('work-mode dialogs', () => {
  describe('new workspace', () => {
    it('offers a random name, draws another on New name, and slugs a typed one live', async () => {
      const user = userEvent.setup()
      fakeBridge.seedProject(uploader)
      render(<App />)
      const dialog = await openNewWorkspace(user)
      const brief = within(dialog).getByRole('textbox', { name: 'What are you doing? (optional)' })
      const name = within(dialog).getByRole('textbox', { name: 'Branch and folder' })
      const submit = within(dialog).getByRole('button', { name: 'Create workspace' })
      expect(brief).toHaveFocus()
      expect((name as HTMLInputElement).value).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/)
      expect(submit).toBeEnabled() // the brief is optional, with Start Claude on too
      expect(within(dialog).getByRole('checkbox', { name: 'Start Claude' })).toBeChecked()

      await user.type(brief, 'Retry uploads{Shift>}{Enter}{/Shift}Back off three times.')
      expect(submit).toBeEnabled()
      const drawn = new Set([(name as HTMLInputElement).value])

      for (let i = 0; i < 5; i++) {
        await user.click(within(dialog).getByRole('button', { name: 'New name' }))
        expect((name as HTMLInputElement).value).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/)
        drawn.add((name as HTMLInputElement).value)
      }

      expect(drawn.size).toBeGreaterThan(1)

      await user.clear(name)
      await user.type(name, '!!!')
      expect(submit).toBeDisabled()
      expect(within(dialog).getByTestId('dialog-new-workspace-slug')).toHaveTextContent(
        /Use letters, digits/
      )
      await user.clear(name)
      await user.type(name, 'APP-1432 Retry logic')
      expect(within(dialog).getByTestId('dialog-new-workspace-slug')).toHaveTextContent(
        'Becomes app-1432-retry-logic'
      )
      expect(submit).toBeEnabled()
    })

    it('shows a name clash in the dialog and keeps it open', async () => {
      const user = userEvent.setup()
      fakeBridge.seedProject(uploader)
      fakeBridge.seedWorkspace(makeWorkspace({ projectId: uploader.id, name: 'calm-amber-otter' }))
      render(<App />)
      const dialog = await openNewWorkspace(user)
      const name = within(dialog).getByRole('textbox', { name: 'Branch and folder' })
      await user.clear(name)
      await user.type(name, 'calm-amber-otter')
      await user.click(within(dialog).getByRole('button', { name: 'Create workspace' }))

      expect(await within(dialog).findByRole('alert')).toHaveTextContent(
        'workspace calm-amber-otter already exists'
      )
      expect(screen.getByRole('dialog', { name: 'New workspace' })).toBeInTheDocument()
    })

    it('closes once the name is accepted, and the row takes over while claude waits for the steps', async () => {
      const user = userEvent.setup()
      fakeBridge.seedProject(uploader)
      render(<App />)
      const dialog = await openNewWorkspace(user)

      const name = (
        within(dialog).getByRole('textbox', { name: 'Branch and folder' }) as HTMLInputElement
      ).value

      await user.click(within(dialog).getByText('Advanced'))
      await user.type(within(dialog).getByRole('textbox', { name: /Base ref/ }), 'origin/release')

      await user.type(
        within(dialog).getByRole('textbox', { name: 'What are you doing? (optional)' }),
        'Add retry logic to the uploader{Shift>}{Enter}{/Shift}Back off exponentially.'
      )
      await user.keyboard('{Meta>}{Enter}{/Meta}')

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      })
      expect(fakeBridge.prepareWorkspaceCalls()).toEqual([
        {
          projectId: uploader.id,
          brief: 'Add retry logic to the uploader\nBack off exponentially.',
          name,
          baseRef: 'origin/release',
          start: true
        }
      ])
      const [ws] = await window.que.workspace.list()
      expect(ws).toMatchObject({ name, title: 'Add retry logic to the uploader' })
      expect(await screen.findByTestId(`preparing-${ws.id}`)).toBeInTheDocument()
      expect(screen.queryAllByRole('tab')).toEqual([])
      expect(await window.que.term.list({ workspaceId: ws.id })).toEqual([])

      act(() => finishPreparation(ws.id))

      await waitFor(() => {
        expect(screen.getAllByRole('tab')).toHaveLength(1)
      })
      expect(await window.que.term.list({ workspaceId: ws.id })).toHaveLength(1)
    })

    it('starts Claude with an empty brief', async () => {
      const user = userEvent.setup()
      fakeBridge.seedProject(uploader)
      render(<App />)
      const dialog = await openNewWorkspace(user)

      const name = (
        within(dialog).getByRole('textbox', { name: 'Branch and folder' }) as HTMLInputElement
      ).value

      await user.click(within(dialog).getByRole('button', { name: 'Create workspace' }))

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      })
      expect(fakeBridge.prepareWorkspaceCalls()).toEqual([
        { projectId: uploader.id, brief: '', name, start: true }
      ])
      const [ws] = await window.que.workspace.list()
      expect(ws.title).toBeUndefined()
      expect(ws.preparation?.plan).toContain('claude')
    })

    it('only opens a shell when Start Claude is off, once the steps have run', async () => {
      const user = userEvent.setup()
      fakeBridge.seedProject(uploader)
      render(<App />)
      const dialog = await openNewWorkspace(user)
      const name = within(dialog).getByRole('textbox', { name: 'Branch and folder' })

      await user.click(within(dialog).getByRole('checkbox', { name: 'Start Claude' }))
      await user.clear(name)
      await user.type(name, 'fix-flaky-upload')
      await user.click(within(dialog).getByRole('button', { name: 'Create workspace' }))

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      })
      const [ws] = await window.que.workspace.list()
      expect(ws.preparation?.plan).toEqual(['fetch', 'worktree'])
      expect(await screen.findByTestId(`preparing-${ws.id}`)).toBeInTheDocument()
      expect(await window.que.term.list({ workspaceId: ws.id })).toEqual([])

      act(() => finishPreparation(ws.id))

      await waitFor(() => {
        expect(screen.getAllByRole('tab')).toHaveLength(1)
      })
      expect(
        screen.getByRole('button', { current: 'page', name: /fix-flaky-upload/ })
      ).toHaveAttribute('data-testid', expect.stringMatching(/^sidebar-workspace-/))
    })

    it('says to restart a background service older than the app, and keeps the brief', async () => {
      const user = userEvent.setup()
      fakeBridge.seedProject(uploader)
      fakeBridge.withoutMethods('workspace.prepare')
      render(<App />)
      const dialog = await openNewWorkspace(user)
      const brief = within(dialog).getByRole('textbox', { name: 'What are you doing? (optional)' })

      await user.type(brief, 'Add retry logic to the uploader')
      await user.click(within(dialog).getByRole('button', { name: 'Create workspace' }))

      expect(await within(dialog).findByRole('alert')).toHaveTextContent(
        "Restart que's background service to create a workspace"
      )
      expect(brief).toHaveValue('Add retry logic to the uploader')
      expect(await window.que.workspace.list()).toEqual([])
    })

    it('returns focus to the opener when cancelled with Escape', async () => {
      const user = userEvent.setup()
      fakeBridge.seedProject(uploader)
      render(<App />)
      const opener = await screen.findByRole('button', { name: 'More actions for uploader' })
      await openNewWorkspace(user)

      await user.keyboard('{Escape}')

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(opener).toHaveFocus()
    })
  })
})
