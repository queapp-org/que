import { describe, expect, it } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { fakeBridge } from '@renderer/testing/fake-bridge'
import { openWorkspace } from '@renderer/testing/helpers'
import {
  makeDiffFile,
  makeProject,
  makePullRequest,
  makeWorkspace,
  makeWorkspaceDiff,
  makeWorkspaceFiles
} from '@renderer/testing/fixtures'
import App from '../App'

const retry = makeWorkspace({
  id: 'ws_01hzx3k9c2qf',
  name: 'app-1432-retry-logic',
  prs: [
    makePullRequest({ number: 43, state: 'open', head: 'app-1432-retry-logic' }),
    makePullRequest({ number: 42, state: 'draft', head: 'app-1432-retry-cap' }),
    makePullRequest({ number: 41, state: 'merged', head: 'app-1432-retry-base' })
  ]
})

const board = makeWorkspace({ id: 'ws_01hzx4m1p8rt', name: 'app-1440-quiet-board' })

function seed(): void {
  fakeBridge.seedProject(makeProject())
  fakeBridge.seedWorkspace(retry)
  fakeBridge.seedWorkspace(board)
  fakeBridge.seedDiff(
    makeWorkspaceDiff({
      workspaceId: retry.id,
      files: [makeDiffFile(), makeDiffFile({ path: 'README.md', status: 'added' })]
    })
  )
  fakeBridge.seedDiff(makeWorkspaceDiff({ workspaceId: board.id, files: [] }))
  fakeBridge.seedFiles(makeWorkspaceFiles({ workspaceId: retry.id }))
  fakeBridge.seedFiles(makeWorkspaceFiles({ workspaceId: board.id }))
}

async function openPane(user: ReturnType<typeof userEvent.setup>): Promise<string> {
  const term = await openWorkspace(user, retry.id)
  await user.click(screen.getByRole('button', { name: 'Show review' }))

  return term
}

describe('ReviewPane', () => {
  describe('opening', () => {
    it('opens on Changes from the show chevron, beside the terminal, which stays selected', async () => {
      const user = userEvent.setup()
      seed()
      render(<App />)
      const term = await openWorkspace(user, retry.id)
      expect(screen.queryByTestId('review-pane')).not.toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: 'Show review' }))

      const pane = screen.getByTestId('review-pane')
      expect(pane).toHaveAttribute('data-view', 'changes')
      expect(within(pane).getByRole('tab', { name: 'Changes' })).toHaveAttribute(
        'aria-selected',
        'true'
      )
      expect(await within(pane).findByTestId('changes-file-0')).toHaveTextContent(
        'src/upload/put.ts'
      )
      expect(screen.getByTestId('pane-0')).toHaveAttribute('data-active-term', term)
      expect(screen.getByTestId('review-resizer')).toHaveAttribute('aria-valuenow', '320')
    })

    it('runs the full height of the window beside the top bar, not under it', async () => {
      const user = userEvent.setup()
      seed()
      render(<App />)
      await openPane(user)

      const pane = screen.getByTestId('review-pane')
      expect(pane.parentElement).toBe(screen.getByTestId('app-shell'))
      expect(within(pane).queryByTestId('pane-controls')).not.toBeInTheDocument()
      expect(screen.getByTestId('app-shell')).toHaveStyle({ '--review-width': '320px' })
    })
  })

  describe('folding', () => {
    it('folds to a rail holding the show chevron and the view icons with their counts under them', async () => {
      const user = userEvent.setup()
      seed()
      render(<App />)
      await openWorkspace(user, retry.id)

      const rail = screen.getByTestId('review-rail')
      expect(rail.parentElement).toBe(screen.getByTestId('app-shell'))
      expect(screen.queryByTestId('review-pane')).not.toBeInTheDocument()
      expect(screen.queryByTestId('review-resizer')).not.toBeInTheDocument()
      const show = within(rail).getByRole('button', { name: 'Show review' })
      expect(show).toHaveAttribute('title', 'Show review (⌘B)')
      expect(
        within(rail)
          .getAllByRole('button')
          .map((b) => b.getAttribute('aria-label'))
      ).toEqual(['Show review', 'Pull requests', 'Changes', 'Files', 'Artifacts'])
      // The open and draft pull requests, and the published pages; Files has no count.
      expect(screen.getByTestId('review-rail-prs-count')).toHaveTextContent('2')
      expect(screen.queryByTestId('review-rail-files-count')).not.toBeInTheDocument()
      expect(screen.getByTestId('review-rail-artifacts-count')).toHaveTextContent('0')
    })

    it('opens from a view icon on the rail on that view', async () => {
      const user = userEvent.setup()
      seed()
      render(<App />)
      await openWorkspace(user, retry.id)

      await user.click(
        within(screen.getByTestId('review-rail')).getByRole('button', { name: 'Files' })
      )

      expect(screen.getByTestId('review-pane')).toHaveAttribute('data-view', 'files')
      expect(screen.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true')
      expect(await screen.findByTestId('files-tree')).toBeInTheDocument()
      expect(screen.queryByTestId('review-rail')).not.toBeInTheDocument()
    })

    it("hides from the chevron at the strip's right end, back to the rail, and shows again on the same view", async () => {
      const user = userEvent.setup()
      seed()
      render(<App />)
      await openPane(user)
      await user.click(screen.getByRole('tab', { name: 'Pull requests' }))

      const hide = within(screen.getByTestId('review-bar')).getByRole('button', {
        name: 'Hide review'
      })

      expect(hide).toHaveAttribute('title', 'Hide review (⌘B)')

      await user.click(hide)

      expect(screen.queryByTestId('review-pane')).not.toBeInTheDocument()
      expect(screen.getByTestId('review-rail')).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: 'Show review' }))

      expect(screen.getByTestId('review-pane')).toHaveAttribute('data-view', 'prs')
    })

    it("can't be shown while the daemon is disconnected, but can still be hidden", async () => {
      const user = userEvent.setup()
      seed()
      render(<App />)
      await openPane(user)

      fakeBridge.disconnect()
      await user.click(await screen.findByRole('button', { name: 'Hide review' }))

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Show review' })).toBeDisabled()
      })
      expect(
        within(screen.getByTestId('review-rail')).getByRole('button', { name: 'Changes' })
      ).toBeDisabled()
    })

    it('leaves no rail in the loose sessions', async () => {
      render(<App />)

      expect(await screen.findByTestId('pane-0')).toBeInTheDocument()
      expect(screen.queryByTestId('review-rail')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Show review' })).not.toBeInTheDocument()
    })
  })

  describe('the icon strip', () => {
    it('holds pull requests, changes, files and artifacts as named icons with counts, and no close button', async () => {
      const user = userEvent.setup()
      seed()
      render(<App />)
      await openPane(user)

      const strip = screen.getByRole('tablist', { name: 'Review' })
      const tabs = within(strip).getAllByRole('tab')
      expect(tabs.map((t) => t.getAttribute('aria-label'))).toEqual([
        'Pull requests',
        'Changes',
        'Files',
        'Artifacts'
      ])
      expect(tabs.map((t) => t.getAttribute('title'))).toEqual([
        'Pull requests',
        'Changes',
        'Files',
        'Artifacts'
      ])
      // The open and draft pull requests, the changed files, the pages; Files has no count.
      expect(screen.getByTestId('review-view-prs-count')).toHaveTextContent('2')
      expect(await screen.findByTestId('review-view-changes-count')).toHaveTextContent('2')
      expect(screen.queryByTestId('review-view-files-count')).not.toBeInTheDocument()
      expect(screen.getByTestId('review-view-artifacts-count')).toHaveTextContent('0')
      expect(tabs[1]).toHaveAttribute('aria-selected', 'true')
      expect(tabs[0]).toHaveAttribute('aria-selected', 'false')
      expect(screen.queryByRole('button', { name: 'Close review' })).not.toBeInTheDocument()
    })

    it("switches views, the current icon marked, and holds the view's own buttons at its right end", async () => {
      const user = userEvent.setup()
      seed()
      render(<App />)
      await openPane(user)

      await user.click(screen.getByRole('tab', { name: 'Files' }))

      const pane = screen.getByTestId('review-pane')
      expect(pane).toHaveAttribute('data-view', 'files')
      expect(screen.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByRole('tab', { name: 'Changes' })).toHaveAttribute('aria-selected', 'false')
      expect(await within(pane).findByTestId('files-tree')).toBeInTheDocument()
      expect(screen.queryByTestId('changes-list')).not.toBeInTheDocument()
      expect(within(screen.getByTestId('review-bar')).getByTestId('files-refresh')).toBeVisible()
      expect(screen.getByTestId('files-open-editor')).toBeVisible()

      await user.click(screen.getByRole('tab', { name: 'Pull requests' }))

      expect(pane).toHaveAttribute('data-view', 'prs')
      expect(await screen.findByTestId('pr-list')).toBeInTheDocument()
      expect(within(screen.getByTestId('review-bar')).getByTestId('pr-refresh')).toBeVisible()
      expect(screen.getByTestId('pr-open-editor')).toBeVisible()
    })

    it('has no Refresh on Artifacts, where nothing polls; the other views keep theirs', async () => {
      const user = userEvent.setup()
      seed()
      render(<App />)
      await openPane(user)
      const bar = screen.getByTestId('review-bar')

      await user.click(screen.getByRole('tab', { name: 'Artifacts' }))

      expect(screen.getByTestId('review-pane')).toHaveAttribute('data-view', 'artifacts')
      expect(within(bar).queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument()
      expect(screen.getByTestId('artifacts-open-editor')).toBeVisible()
      expect(within(bar).getByRole('button', { name: 'Hide review' })).toBeVisible()

      await user.click(screen.getByRole('tab', { name: 'Changes' }))

      expect(within(bar).getByTestId('changes-refresh')).toBeVisible()
    })

    it('⌘F in the pane goes to Files and focuses its filter', async () => {
      const user = userEvent.setup()
      seed()
      render(<App />)
      await openPane(user)
      await user.click(screen.getByRole('tab', { name: 'Pull requests' }))

      await user.keyboard('{Meta>}f{/Meta}')

      expect(screen.getByTestId('review-pane')).toHaveAttribute('data-view', 'files')
      expect(await screen.findByRole('textbox', { name: 'Filter files' })).toHaveFocus()
    })
  })

  describe('remembering', () => {
    it('remembers the view per workspace', async () => {
      const user = userEvent.setup()
      seed()
      render(<App />)
      await openPane(user)
      await user.click(screen.getByRole('tab', { name: 'Files' }))

      await openWorkspace(user, board.id)
      await user.click(screen.getByRole('tab', { name: 'Pull requests' }))
      expect(screen.getByTestId('review-pane')).toHaveAttribute('data-view', 'prs')

      await openWorkspace(user, retry.id)
      expect(screen.getByTestId('review-pane')).toHaveAttribute('data-view', 'files')

      await openWorkspace(user, board.id)
      expect(screen.getByTestId('review-pane')).toHaveAttribute('data-view', 'prs')
    })

    it('comes back open on its view at its width after the app reloads', async () => {
      const user = userEvent.setup()
      seed()
      const first = render(<App />)
      await openPane(user)
      await user.click(screen.getByRole('tab', { name: 'Files' }))
      screen.getByTestId('review-resizer').focus()
      await user.keyboard('{ArrowLeft}{ArrowLeft}{ArrowLeft}')
      first.unmount()

      render(<App />)
      await openWorkspace(user, retry.id)

      expect(screen.getByTestId('review-pane')).toHaveAttribute('data-view', 'files')
      expect(screen.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByTestId('review-resizer')).toHaveAttribute('aria-valuenow', '368')
      expect(await screen.findByTestId('files-tree')).toBeInTheDocument()
    })

    it('comes back on Artifacts after the app reloads', async () => {
      const user = userEvent.setup()
      seed()
      const first = render(<App />)
      await openPane(user)
      await user.click(screen.getByRole('tab', { name: 'Artifacts' }))
      first.unmount()

      render(<App />)
      await openWorkspace(user, retry.id)

      expect(screen.getByTestId('review-pane')).toHaveAttribute('data-view', 'artifacts')
      expect(await screen.findByTestId('artifact-empty')).toBeInTheDocument()
    })

    it('brings a width remembered under the minimum up to it', async () => {
      const user = userEvent.setup()
      seed()
      localStorage.setItem('que.review', JSON.stringify({ open: true, width: 240, places: {} }))
      render(<App />)
      await openWorkspace(user, retry.id)

      expect(screen.getByTestId('review-resizer')).toHaveAttribute('aria-valuenow', '270')
    })

    it('falls back to the defaults for an unreadable or out-of-range memory', async () => {
      const user = userEvent.setup()
      seed()
      localStorage.setItem('que.review', '{not json')
      const first = render(<App />)
      await openWorkspace(user, retry.id)
      expect(screen.queryByTestId('review-pane')).not.toBeInTheDocument()
      first.unmount()

      localStorage.setItem(
        'que.review',
        JSON.stringify({ open: true, view: 'notes', width: 9999, places: { [retry.id]: 7 } })
      )
      render(<App />)
      await openWorkspace(user, retry.id)

      expect(screen.getByTestId('review-pane')).toHaveAttribute('data-view', 'changes')
      expect(screen.getByTestId('review-resizer')).toHaveAttribute('aria-valuenow', '520')
    })
  })

  describe('the loose sessions', () => {
    it('says there is no workspace to review, on any view, and lists nothing', async () => {
      const user = userEvent.setup()
      localStorage.setItem('que.review', JSON.stringify({ open: true, view: 'files', width: 320 }))
      render(<App />)
      expect(await screen.findByTestId('review-empty')).toHaveTextContent('No workspace')

      await user.click(screen.getByRole('tab', { name: 'Changes' }))
      await user.click(screen.getByRole('tab', { name: 'Pull requests' }))

      expect(screen.getByTestId('review-empty')).toHaveTextContent('No workspace')
      expect(screen.queryByTestId('changes-list')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument()
      expect(fakeBridge.filesCalls()).toEqual([])
    })
  })
})
