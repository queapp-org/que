import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { fakeBridge } from '@renderer/testing/fake-bridge'
import { minutesAgo, openWorkspace } from '@renderer/testing/helpers'
import { makeProject, makeWorkspace } from '@renderer/testing/fixtures'
import type { Artifact } from '../../../preload/index.d'
import App from '../App'

const ID = 'ws_01hzx3k9c2qf'
const now = Date.now()
const RETRIES_URL = 'https://claude.ai/artifact/Bo2pUji8XumREbCYMXcoMe'
const REMOVAL_URL = 'https://claude.ai/code/artifact/5TzMcQgtfF2RmJrrpX3D7m'

const retries: Artifact = {
  url: RETRIES_URL,
  title: 'Upload retries',
  updatedAt: minutesAgo(now, 2),
  openedAt: null
}

const removal: Artifact = {
  url: REMOVAL_URL,
  title: 'Workspace removal flow',
  updatedAt: minutesAgo(now, 180),
  openedAt: minutesAgo(now, 90)
}

const row = (id: string): HTMLElement => screen.getByTestId(`artifact-${id}`)
const retriesRow = (): HTMLElement => row('Bo2pUji8XumREbCYMXcoMe')
const removalRow = (): HTMLElement => row('5TzMcQgtfF2RmJrrpX3D7m')

/** The app on the workspace's Artifacts view. */
async function openList(
  user: ReturnType<typeof userEvent.setup>,
  artifacts: Artifact[]
): Promise<HTMLElement> {
  fakeBridge.seedProject(makeProject())
  fakeBridge.seedWorkspace(makeWorkspace({ id: ID, name: 'app-1432-retry-logic', artifacts }))
  render(<App />)
  await openWorkspace(user, ID)
  await user.click(screen.getByRole('button', { name: 'Show review' }))
  await user.click(screen.getByRole('tab', { name: 'Artifacts' }))

  return screen.findByTestId('artifact-list')
}

describe('ArtifactList', () => {
  describe('rendering', () => {
    it('lists the pages in the order the daemon keeps them, each with its title and age', async () => {
      const list = await openList(userEvent.setup(), [retries, removal])

      expect(
        within(list)
          .getAllByRole('link')
          .map((link) => link.textContent)
      ).toEqual(['Upload retries', 'Workspace removal flow'])
      expect(screen.getByTestId('artifact-Bo2pUji8XumREbCYMXcoMe-age')).toHaveTextContent(/^2m$/)
      expect(screen.getByTestId('artifact-5TzMcQgtfF2RmJrrpX3D7m-age')).toHaveTextContent(/^3h$/)
      expect(screen.getByTestId('artifact-Bo2pUji8XumREbCYMXcoMe-age')).toHaveAttribute(
        'title',
        `Updated ${new Date(retries.updatedAt).toLocaleString()}`
      )
    })

    it('heads the list with its count, as the strip counts it', async () => {
      const list = await openList(userEvent.setup(), [retries, removal])

      expect(within(list).getByRole('heading', { name: '[ Artifacts ]' })).toBeInTheDocument()
      expect(screen.getByTestId('artifact-list-summary')).toHaveTextContent('2 published')
      expect(screen.getByTestId('review-view-artifacts-count')).toHaveTextContent('2')
    })

    it('says none are published, with no head, and the strip counts 0', async () => {
      const list = await openList(userEvent.setup(), [])

      expect(screen.getByTestId('artifact-empty')).toHaveTextContent(
        'No artifacts from this session yet.'
      )
      expect(within(list).queryByRole('heading')).not.toBeInTheDocument()
      expect(screen.getByTestId('review-view-artifacts-count')).toHaveTextContent('0')
    })

    it('reads an unopened page at full strength and an opened one quieter', async () => {
      await openList(userEvent.setup(), [retries, removal])

      expect(retriesRow()).toHaveAttribute('data-opened', 'false')
      expect(retriesRow()).not.toHaveClass('opened')
      expect(removalRow()).toHaveAttribute('data-opened', 'true')
      expect(removalRow()).toHaveClass('opened')
    })
  })

  describe('opening a page', () => {
    it('links the title to the page outside the app', async () => {
      await openList(userEvent.setup(), [retries])

      const link = screen.getByRole('link', { name: 'Upload retries' })
      expect(link).toHaveAttribute('href', RETRIES_URL)
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noreferrer')
    })

    it('marks the page opened on a click, once the daemon says so', async () => {
      const user = userEvent.setup()
      await openList(user, [retries, removal])

      await user.click(screen.getByRole('link', { name: 'Upload retries' }))

      await waitFor(() => {
        expect(retriesRow()).toHaveAttribute('data-opened', 'true')
      })
      expect(fakeBridge.getWorkspace(ID)?.artifacts[0]?.openedAt).not.toBeNull()
    })

    it('opens from the age too, which sits above the link for its tooltip', async () => {
      const user = userEvent.setup()
      await openList(user, [retries])

      await user.click(screen.getByTestId('artifact-Bo2pUji8XumREbCYMXcoMe-age'))

      await waitFor(() => {
        expect(retriesRow()).toHaveAttribute('data-opened', 'true')
      })
    })

    it('stays unopened and raises no error line against a daemon without the method', async () => {
      const user = userEvent.setup()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      fakeBridge.withoutMethods('workspace.artifactOpened')
      await openList(user, [retries])

      await user.click(screen.getByRole('link', { name: 'Upload retries' }))

      await waitFor(() => {
        expect(warn).toHaveBeenCalledWith(
          'Could not record the opened artifact',
          expect.objectContaining({ code: 'unknown_method' })
        )
      })
      expect(retriesRow()).toHaveAttribute('data-opened', 'false')
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      warn.mockRestore()
    })
  })

  describe('Copy link', () => {
    it('writes the URL to the clipboard and leaves the page unopened', async () => {
      const user = userEvent.setup()
      await openList(user, [retries])

      await user.click(within(retriesRow()).getByRole('button', { name: 'Copy link' }))

      await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(RETRIES_URL))
      expect(fakeBridge.getWorkspace(ID)?.artifacts[0]?.openedAt).toBeNull()
      expect(retriesRow()).toHaveAttribute('data-opened', 'false')
    })

    it('is no part of the link', async () => {
      await openList(userEvent.setup(), [retries])

      const copy = within(retriesRow()).getByRole('button', { name: 'Copy link' })
      expect(copy.closest('a')).toBeNull()
    })
  })

  describe('untrusted data', () => {
    it('gives an entry with a bad URL no row and no link, and leaves it out of the count', async () => {
      const list = await openList(userEvent.setup(), [
        retries,
        { ...removal, url: 'javascript:alert(1)//claude.ai/artifact/x', title: 'Not a page' },
        { ...removal, url: 'https://claude.ai.example.com/artifact/x', title: 'Another host' }
      ])

      expect(within(list).getAllByRole('link')).toHaveLength(1)
      expect(screen.queryByText('Not a page')).not.toBeInTheDocument()
      expect(screen.queryByText('Another host')).not.toBeInTheDocument()
      expect(screen.getByTestId('artifact-list-summary')).toHaveTextContent('1 published')
    })

    it('says none are published when no entry has a good URL', async () => {
      await openList(userEvent.setup(), [
        { ...removal, url: 'https://claude.ai/artifact/x/../../evil', title: 'Not a page' }
      ])

      expect(screen.getByTestId('artifact-empty')).toBeInTheDocument()
      expect(screen.queryByRole('link', { name: 'Not a page' })).not.toBeInTheDocument()
    })

    it('shows a title with markup as literal text', async () => {
      const title = '<img src=x onerror=alert(1)><b>Retries</b>'
      const list = await openList(userEvent.setup(), [{ ...retries, title }])

      expect(within(list).getByRole('link', { name: title })).toHaveTextContent(title)
      expect(list.querySelector('img, b')).toBeNull()
    })
  })
})
