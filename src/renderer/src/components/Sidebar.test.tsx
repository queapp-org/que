import { describe, expect, it } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { fakeBridge } from '@renderer/testing/fake-bridge'
import {
  makeBackgroundTask,
  makeProject,
  makePullRequest,
  makeQuietState,
  makeTicket,
  makeTermInfo,
  makeWorkspace
} from '@renderer/testing/fixtures'
import { minutesAgo, openWorkspace } from '@renderer/testing/helpers'
import type { PreparationStep } from '@shared/types'
import App from '../App'

const uploader = makeProject()
const api = makeProject({ id: 'prj_01hzw9c4v7kd', name: 'api', path: '/Users/dev/code/api' })

const retry = makeWorkspace({
  id: 'ws_01hzx3k9c2qf',
  name: 'app-1432-retry-logic',
  status: 'working'
})

const board = makeWorkspace({
  id: 'ws_01hzx4m1p8rt',
  name: 'app-1440-quiet-board',
  status: 'stuck',
  statusReason: 'no_heartbeat'
})

const auth = makeWorkspace({
  id: 'ws_01hzx5t6y2wa',
  projectId: api.id,
  name: 'app-1451-token-refresh',
  status: 'needs_input'
})

// A fixed clock, so the hover word's age never depends on the wall clock.
const NOW = new Date(2026, 9, 17, 21, 30).getTime()
const clock = (): number => NOW

function seed(): void {
  fakeBridge.seedProject(uploader)
  fakeBridge.seedProject(api)
  fakeBridge.seedWorkspace(retry)
  fakeBridge.seedWorkspace(board)
  fakeBridge.seedWorkspace(auth)
}

const mark = (id: string): HTMLElement => screen.getByTestId(`sidebar-workspace-${id}-status`)
const word = (id: string): HTMLElement => screen.getByTestId(`sidebar-workspace-${id}-word`)
const row = (id: string): HTMLElement => screen.getByTestId(`sidebar-workspace-${id}`)

describe('Sidebar', () => {
  describe('rendering', () => {
    it('lists each workspace under its project with a dot in its tone, and no word at rest', async () => {
      seed()
      render(<App />)

      const project = await screen.findByTestId(`sidebar-project-${uploader.id}`)
      expect(within(project).getByText('app-1432-retry-logic')).toBeInTheDocument()
      expect(within(project).getByText('app-1440-quiet-board')).toBeInTheDocument()
      expect(within(project).queryByText('app-1451-token-refresh')).not.toBeInTheDocument()
      expect(
        within(screen.getByTestId(`sidebar-project-${api.id}`)).getByText('app-1451-token-refresh')
      ).toBeInTheDocument()
      expect(mark(auth.id)).toHaveAttribute('data-status', 'needs_input')
      expect(mark(auth.id)).toHaveClass('status-dot', 'tone-attention')
      expect(mark(auth.id)).toBeEmptyDOMElement()
      expect(mark(board.id)).toHaveAttribute('data-status', 'stuck')
      expect(mark(board.id)).toHaveClass('status-dot', 'tone-bad')
      expect(mark(board.id)).toHaveAttribute('title', 'stuck: no_heartbeat')
    })

    it('draws a working workspace with the working mark: four dots, a CSS animation, no tone', async () => {
      seed()
      render(<App />)

      const working = await screen.findByTestId(`sidebar-workspace-${retry.id}-status`)
      expect(working).toHaveAttribute('data-status', 'working')
      expect(working).toHaveClass('working-mark')
      expect(working).not.toHaveClass('status-dot')
      expect(working.querySelectorAll('i')).toHaveLength(4)
      expect(working.className).not.toMatch(/tone-/)
    })

    it('keeps the status word and ⋯ in the row overlay the pointer and keyboard focus reveal', async () => {
      seed()
      render(<App />)
      await screen.findByTestId(`sidebar-workspace-${retry.id}`)

      const overlay = word(retry.id).parentElement as HTMLElement
      expect(overlay).toHaveClass('reveal')
      expect(word(retry.id)).toHaveTextContent('working')
      expect(word(retry.id)).not.toHaveClass('toned')
      expect(
        within(overlay).getByRole('button', { name: 'More actions for app-1432-retry-logic' })
      ).toBeInTheDocument()
      expect(word(auth.id)).toHaveTextContent('needs input')
      expect(word(auth.id)).toHaveClass('toned', 'tone-attention')
      expect(word(board.id)).toHaveTextContent('stuck')
      expect(word(board.id)).toHaveClass('toned', 'tone-bad')
      // The overlay sits beside the row's button, so its name is the workspace's alone.
      expect(screen.getByRole('button', { name: 'app-1432-retry-logic' })).not.toContainElement(
        word(retry.id)
      )
    })

    it('draws the selected row at full strength on the active background', async () => {
      const user = userEvent.setup()
      const idle = makeWorkspace({ id: 'ws_01hzx8q3r5tw', name: 'app-1477-signed-urls' })
      fakeBridge.seedProject(uploader)
      fakeBridge.seedWorkspace(idle)
      render(<App />)

      await user.click(await screen.findByRole('button', { name: 'app-1477-signed-urls' }))

      expect(row(idle.id)).toHaveClass('weight-fg')
      expect(screen.getByTestId(`sidebar-workspace-${idle.id}-open`)).toHaveAttribute(
        'aria-current',
        'page'
      )
    })

    it('shows the title instead of the name, with no tooltip on the row: the card replaces it', async () => {
      const briefed = makeWorkspace({
        id: 'ws_01hzx7b2n4qe',
        name: 'speed-up-the-diff-view-for-large-change',
        title: 'Speed up the diff view for large changesets',
        brief: 'Speed up the diff view for large changesets\n\nVirtualize the file list.'
      })

      fakeBridge.seedProject(uploader)
      fakeBridge.seedWorkspace(briefed)
      render(<App />)

      expect(await screen.findByTestId(`sidebar-workspace-${briefed.id}-name`)).toHaveTextContent(
        'Speed up the diff view for large changesets'
      )
      expect(screen.queryByText(briefed.name)).not.toBeInTheDocument()
      expect(screen.getByTestId(`sidebar-workspace-${briefed.id}-open`)).not.toHaveAttribute(
        'title'
      )
    })

    it('collapses a project from anywhere on its head, turning its chevron and counting its rows', async () => {
      const user = userEvent.setup()
      seed()
      render(<App />)
      const head = await screen.findByRole('button', { name: 'uploader', expanded: true })
      expect(head.querySelector('.folder')).toBeInTheDocument()
      expect(head.querySelector('.chevron')).toHaveClass('open')
      expect(screen.queryByTestId(`sidebar-project-${uploader.id}-count`)).not.toBeInTheDocument()

      await user.click(within(head).getByText('uploader'))

      expect(screen.queryByText('app-1432-retry-logic')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'uploader', expanded: false })).toBe(head)
      expect(head.querySelector('.chevron')).not.toHaveClass('open')
      expect(screen.getByTestId(`sidebar-project-${uploader.id}-count`)).toHaveTextContent(/^2$/)
    })

    it("keeps the section heads' buttons in view, and a project head's in the actions its hover, focus or open menu reveal", async () => {
      seed()
      render(<App />)
      await screen.findByTestId(`sidebar-project-${uploader.id}`)

      for (const name of ['New session', 'Add project', 'Sorted by name']) {
        const actions = screen.getByRole('button', { name }).closest('.head-actions')
        expect(actions?.closest('.section-head')).not.toBeNull()
        expect(actions?.closest('.project-head')).toBeNull()
      }

      for (const name of [
        'New workspace running Claude Code in uploader',
        'More actions for uploader'
      ]) {
        expect(
          screen.getByRole('button', { name }).closest('.project-head .head-actions')
        ).not.toBeNull()
      }
    })

    it('shows no pull request mark on a workspace that has one', async () => {
      seed()
      fakeBridge.seedWorkspace({ ...retry, pr: makePullRequest({ state: 'draft' }) })
      render(<App />)

      await screen.findByTestId(`sidebar-workspace-${retry.id}`)
      expect(within(row(retry.id)).queryByRole('link')).not.toBeInTheDocument()
      expect(row(retry.id)).not.toHaveTextContent('#41')
    })

    it('invites adding a repository when there are no projects', async () => {
      render(<App />)

      expect(await screen.findByTestId('sidebar-empty')).toHaveTextContent(
        'Add a git repository to start a workspace.'
      )
    })
  })

  describe('background tasks', () => {
    const devServer = makeBackgroundTask({ since: minutesAgo(NOW, 31) })

    const serving = makeWorkspace({
      id: 'ws_01hzx9d4f6gh',
      name: 'app-1488-dev-server',
      status: 'idle',
      backgroundTasks: [devServer]
    })

    const exploring = {
      ...retry,
      backgroundTasks: [
        makeBackgroundTask({
          kind: 'subagent',
          description: 'Explore the repo',
          since: minutesAgo(NOW, 2)
        })
      ]
    }

    const background = (id: string): HTMLElement | null =>
      screen.queryByTestId(`sidebar-workspace-${id}-background`)

    it('marks an idle row running a shell with ›_ after its name, and a working row with its ripple alone', async () => {
      fakeBridge.seedProject(uploader)
      fakeBridge.seedWorkspace(serving)
      fakeBridge.seedWorkspace(exploring)
      render(<App now={clock} />)

      const open = await screen.findByTestId(`sidebar-workspace-${serving.id}-open`)
      expect(background(serving.id)).toHaveTextContent(/^›_$/)
      expect(open).toContainElement(background(serving.id))
      expect(mark(serving.id)).toHaveClass('status-dot', 'tone-neutral')
      // The word stays in the overlay the pointer reveals, not in the row at rest.
      expect(open).not.toContainElement(word(serving.id))
      expect(mark(exploring.id)).toHaveClass('working-mark')
      expect(background(exploring.id)).not.toBeInTheDocument()
    })

    it('names the background kind under the pointer, and in the dot’s tooltip', async () => {
      const user = userEvent.setup()
      fakeBridge.seedProject(uploader)
      fakeBridge.seedWorkspace(serving)
      render(<App now={clock} />)

      await user.hover(await screen.findByTestId(`sidebar-workspace-${serving.id}-open`))

      expect(word(serving.id)).toHaveTextContent(/^idle · shell$/)
      expect(word(serving.id)).not.toHaveClass('toned')
      expect(mark(serving.id)).toHaveAttribute('title', 'idle · shell')
    })

    it('drops the mark when the daemon reports the shell gone', async () => {
      fakeBridge.seedProject(uploader)
      fakeBridge.seedWorkspace(serving)
      render(<App now={clock} />)
      expect(
        await screen.findByTestId(`sidebar-workspace-${serving.id}-background`)
      ).toBeInTheDocument()

      fakeBridge.setBackgroundTasks(serving.id, [])

      await waitFor(() => {
        expect(background(serving.id)).not.toBeInTheDocument()
      })
      expect(word(serving.id)).toHaveTextContent(/^idle$/)
    })
  })

  describe('status updates', () => {
    it('moves the dot and the word when the status engine says so', async () => {
      seed()
      render(<App />)
      await screen.findByTestId(`sidebar-workspace-${board.id}`)

      fakeBridge.setStatus(board.id, 'needs_input')

      await waitFor(() => {
        expect(mark(board.id)).toHaveAttribute('data-status', 'needs_input')
      })
      expect(mark(board.id)).toHaveClass('tone-attention')
      expect(word(board.id)).toHaveTextContent('needs input')
      expect(row(board.id)).toHaveClass('weight-fg')
    })

    it('shows a workspace created elsewhere while it prepares, and drops a removed one', async () => {
      seed()
      render(<App />)
      await screen.findByTestId(`sidebar-workspace-${retry.id}`)

      const created = fakeBridge.createElsewhere({
        projectId: uploader.id,
        name: 'APP-1460 upload resume'
      })

      await window.que.workspace.remove({ id: board.id, deleteBranch: false })

      expect(await screen.findByTestId(`sidebar-workspace-${created.id}-status`)).toHaveAttribute(
        'data-status',
        'preparing'
      )
      expect(screen.queryByTestId(`sidebar-workspace-${board.id}`)).not.toBeInTheDocument()
    })
  })

  describe('the project head button', () => {
    const start = (name = 'uploader'): Promise<HTMLElement> =>
      screen.findByRole('button', { name: `New workspace running Claude Code in ${name}` })

    it('is the 8-bit character alone, with no plus and no text, and says what it does', async () => {
      seed()
      render(<App />)

      const button = await start()

      expect(button).toHaveAttribute('title', 'New workspace running Claude Code')
      expect(button).toHaveTextContent('')
      expect(button.closest('.project-head .head-actions')).not.toBeNull()
      const svg = button.querySelector('svg')
      expect(svg).toHaveAttribute('viewBox', '1 0 16 10')
      expect(svg).toHaveAttribute('width', '16')
      expect(svg).toHaveAttribute('height', '10')
      expect(svg).toHaveClass('claude-code-mark')
    })

    it('makes a workspace with a generated name, starting Claude, and shows it at once', async () => {
      const user = userEvent.setup()
      fakeBridge.seedProject(uploader)
      render(<App />)

      await user.click(await start())

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(fakeBridge.prepareWorkspaceCalls()).toEqual([{ projectId: uploader.id, start: true }])
      const [ws] = await window.que.workspace.list()
      expect(ws.name).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/)
      expect(await screen.findByTestId(`sidebar-workspace-${ws.id}-open`)).toHaveAttribute(
        'aria-current',
        'page'
      )
      expect(mark(ws.id)).toHaveAttribute('data-status', 'preparing')
      expect(mark(ws.id)).toHaveClass('working-mark', 'neutral')
      expect(screen.getByTestId(`sidebar-workspace-${ws.id}-step`)).toHaveTextContent(
        /^fetching origin \ds$/
      )
    })

    it('makes one workspace from a double click', async () => {
      const user = userEvent.setup()
      fakeBridge.seedProject(uploader)
      render(<App />)

      await user.dblClick(await start())

      await waitFor(() => {
        expect(fakeBridge.prepareWorkspaceCalls()).toHaveLength(1)
      })
      expect(await window.que.workspace.list()).toHaveLength(1)
    })

    it('leaves the dialog to the project menu', async () => {
      const user = userEvent.setup()
      fakeBridge.seedProject(uploader)
      render(<App />)

      await user.click(await screen.findByRole('button', { name: 'More actions for uploader' }))
      await user.click(screen.getByRole('menuitem', { name: 'New workspace…' }))

      expect(screen.getByRole('dialog', { name: 'New workspace' })).toBeInTheDocument()
      expect(fakeBridge.prepareWorkspaceCalls()).toEqual([])
    })

    it('says to restart a background service older than the app, on the error line', async () => {
      const user = userEvent.setup()
      fakeBridge.seedProject(uploader)
      fakeBridge.withoutMethods('workspace.prepare')
      render(<App />)

      await user.click(await start())

      expect(await screen.findByRole('alert')).toHaveTextContent(
        "Restart que's background service to create a workspace"
      )
      expect(await window.que.workspace.list()).toEqual([])
    })

    it('puts a refusal on the error line', async () => {
      const user = userEvent.setup()
      fakeBridge.seedProject(uploader)
      fakeBridge.refusePrepare('invalid que.toml in /Users/dev/code/uploader: setup: not a string')
      render(<App />)

      await user.click(await start())

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'invalid que.toml in /Users/dev/code/uploader: setup: not a string'
      )
      expect(await window.que.workspace.list()).toEqual([])
    })
  })

  describe('preparing', () => {
    const steps = {
      plan: ['fetch', 'worktree', 'setup', 'claude'] as PreparationStep[],
      since: new Date(NOW - 12_000).toISOString(),
      done: [
        { step: 'fetch' as const, ms: 900 },
        { step: 'worktree' as const, ms: 200 }
      ]
    }

    const preparing = makeWorkspace({
      id: 'ws_01hzx7q2n4ks',
      name: 'quiet-amber-fern',
      status: 'preparing',
      preparation: steps
    })

    const stopped = makeWorkspace({
      id: 'ws_01hzx8w5c9tb',
      name: 'still-coral-reef',
      status: 'stuck',
      statusReason: 'preparation_failed',
      preparation: {
        ...steps,
        done: [
          { step: 'fetch' as const, ms: 900 },
          { step: 'worktree' as const, ms: 40, error: 'unknown base ref v9' }
        ]
      }
    })

    it('draws the neutral mark and the step with its clock, always shown, ticking each second', async () => {
      let t = NOW
      fakeBridge.seedProject(uploader)
      fakeBridge.seedWorkspace(preparing)
      render(<App now={() => t} />)

      const step = await screen.findByTestId(`sidebar-workspace-${preparing.id}-step`)

      expect(step).toHaveTextContent('running setup 12s')
      expect(screen.getByTestId(`sidebar-workspace-${preparing.id}-open`)).toContainElement(step)
      expect(mark(preparing.id)).toHaveClass('working-mark', 'neutral')
      expect(screen.getByTestId(`sidebar-workspace-${preparing.id}-open`)).toBeEnabled()

      t = NOW + 3_000
      await waitFor(
        () => {
          expect(step).toHaveTextContent('running setup 15s')
        },
        { timeout: 3_000 }
      )
    })

    it('offers only Remove in its menu', async () => {
      const user = userEvent.setup()
      fakeBridge.seedProject(uploader)
      fakeBridge.seedWorkspace(preparing)
      render(<App />)

      await user.click(
        await screen.findByRole('button', { name: `More actions for ${preparing.name}` })
      )

      expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Remove…'])
    })

    it('shows a failed step and why at the right end, in the bad tone, and can be removed', async () => {
      const user = userEvent.setup()
      fakeBridge.seedProject(uploader)
      fakeBridge.seedWorkspace(stopped)
      render(<App />)

      const step = await screen.findByTestId(`sidebar-workspace-${stopped.id}-step`)

      expect(step).toHaveTextContent('creating worktree failed: unknown base ref v9')
      expect(step).toHaveClass('failed')
      expect(step).toHaveAttribute('title', 'creating worktree failed: unknown base ref v9')
      expect(mark(stopped.id)).toHaveClass('tone-bad')
      expect(mark(stopped.id)).toHaveAttribute(
        'title',
        'creating worktree failed: unknown base ref v9'
      )
      expect(word(stopped.id)).toHaveTextContent('creating worktree failed')
      expect(word(stopped.id)).toHaveClass('tone-bad')

      await user.click(screen.getByRole('button', { name: `More actions for ${stopped.name}` }))
      await user.click(screen.getByRole('menuitem', { name: 'Remove…' }))

      expect(screen.getByRole('dialog', { name: `Remove ${stopped.name}?` })).toBeInTheDocument()
    })
  })

  describe('removing', () => {
    const step = (id: string): HTMLElement => screen.getByTestId(`sidebar-workspace-${id}-step`)

    /** When the removal's current step started, as the daemon stamped it. */
    const since = (id: string): number =>
      Date.parse(fakeBridge.getWorkspace(id)?.removal?.since ?? '')

    it('draws the working mark in the neutral tone, the step and its clock at the right end, and a faint name', async () => {
      seed()
      fakeBridge.holdRemovals()
      render(<App />)
      await screen.findByTestId(`sidebar-workspace-${auth.id}`)

      await window.que.workspace.remove({ id: auth.id, deleteBranch: true })

      await waitFor(() => {
        expect(mark(auth.id)).toHaveAttribute('data-status', 'removing')
      })
      expect(mark(auth.id)).toHaveClass('working-mark', 'neutral')
      expect(mark(auth.id).querySelectorAll('i')).toHaveLength(4)
      expect(mark(auth.id)).toHaveAttribute('data-unseen', 'false')
      expect(row(auth.id)).toHaveClass('weight-faint')
      expect(step(auth.id)).toHaveTextContent(/^killing terminals \ds$/)
      // Always shown, in the row itself, not the overlay the pointer reveals.
      expect(screen.getByTestId(`sidebar-workspace-${auth.id}-open`)).toContainElement(
        step(auth.id)
      )
    })

    it('changes the word with the step, and ticks its clock every second', async () => {
      let t = NOW
      seed()
      fakeBridge.holdRemovals()
      render(<App now={() => t} />)
      await screen.findByTestId(`sidebar-workspace-${board.id}`)
      await window.que.workspace.remove({ id: board.id, deleteBranch: true })
      await screen.findByTestId(`sidebar-workspace-${board.id}-step`)

      fakeBridge.advanceRemoval(board.id)
      t = since(board.id) + 12_000

      // Nothing else re-renders the row: the second-long tick brings the new age.
      await waitFor(
        () => {
          expect(step(board.id)).toHaveTextContent(/^running teardown 12s$/)
        },
        { timeout: 2_500 }
      )
      t += 1_000
      await waitFor(
        () => {
          expect(step(board.id)).toHaveTextContent(/^running teardown 13s$/)
        },
        { timeout: 2_500 }
      )

      fakeBridge.advanceRemoval(board.id)
      t = since(board.id) + 3_000

      await waitFor(
        () => {
          expect(step(board.id)).toHaveTextContent(/^removing worktree 3s$/)
        },
        { timeout: 2_500 }
      )

      fakeBridge.advanceRemoval(board.id)
      t = since(board.id)

      await waitFor(
        () => {
          expect(step(board.id)).toHaveTextContent(/^deleting branch 0s$/)
        },
        { timeout: 2_500 }
      )
    })

    it('disables the row: no menu, no ⋯, and the step as the hover word', async () => {
      const user = userEvent.setup()
      seed()
      fakeBridge.holdRemovals()
      render(<App />)
      await screen.findByTestId(`sidebar-workspace-${retry.id}`)
      await window.que.workspace.remove({ id: retry.id, deleteBranch: false })

      await waitFor(() => {
        expect(screen.getByTestId(`sidebar-workspace-${retry.id}-open`)).toBeDisabled()
      })
      expect(screen.queryByTestId(`sidebar-workspace-${retry.id}-menu`)).not.toBeInTheDocument()
      expect(word(retry.id)).toHaveTextContent(/^killing terminals \ds$/)
      expect(word(retry.id)).not.toHaveClass('toned')

      await user.pointer({ keys: '[MouseRight]', target: row(retry.id) })

      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })

    it('keeps the row through every step and drops it when the daemon says it is gone', async () => {
      seed()
      fakeBridge.holdRemovals()
      render(<App />)
      await screen.findByTestId(`sidebar-workspace-${board.id}`)
      await window.que.workspace.remove({ id: board.id, deleteBranch: false })
      await screen.findByTestId(`sidebar-workspace-${board.id}-step`)

      fakeBridge.advanceRemoval(board.id)
      fakeBridge.advanceRemoval(board.id)
      await waitFor(() => {
        expect(step(board.id)).toHaveTextContent(/^removing worktree \ds$/)
      })

      fakeBridge.advanceRemoval(board.id)

      await waitFor(() => {
        expect(screen.queryByTestId(`sidebar-workspace-${board.id}`)).not.toBeInTheDocument()
      })
    })
  })

  describe('finished, not looked at', () => {
    it('turns green with its name at full strength when a turn ends unseen, and greys once selected', async () => {
      const user = userEvent.setup()
      seed()
      render(<App now={clock} />)
      await screen.findByTestId(`sidebar-workspace-${retry.id}`)
      expect(mark(retry.id)).toHaveAttribute('data-unseen', 'false')

      fakeBridge.setStatus(retry.id, 'idle')

      await waitFor(() => {
        expect(mark(retry.id)).toHaveAttribute('data-unseen', 'true')
      })
      expect(mark(retry.id)).toHaveAttribute('data-status', 'idle')
      expect(mark(retry.id)).toHaveClass('status-dot', 'tone-good')
      expect(row(retry.id)).toHaveClass('weight-fg')
      expect(word(retry.id)).toHaveTextContent(/^done · \d+s ago$/)
      // The dot's tooltip is the same word.
      expect(mark(retry.id)).toHaveAttribute('title', word(retry.id).textContent)
      expect(fakeBridge.seenCalls()).toEqual([])

      await user.click(screen.getByRole('button', { name: 'app-1432-retry-logic' }))

      await waitFor(() => {
        expect(fakeBridge.seenCalls()).toEqual([retry.id])
      })
      expect(fakeBridge.getWorkspace(retry.id)?.seenAt).not.toBeNull()
      expect(mark(retry.id)).toHaveAttribute('data-unseen', 'false')
      expect(mark(retry.id)).toHaveClass('tone-neutral')

      await user.click(screen.getByRole('button', { name: 'app-1440-quiet-board' }))

      expect(row(retry.id)).toHaveClass('weight-faint')
      expect(mark(retry.id)).toHaveAttribute('data-unseen', 'false')
    })

    it('marks the selected workspace seen again when the window regains focus, and when it finishes', async () => {
      const user = userEvent.setup()
      seed()
      render(<App />)
      await user.click(await screen.findByRole('button', { name: 'app-1432-retry-logic' }))
      await waitFor(() => expect(fakeBridge.seenCalls()).toEqual([retry.id]))

      window.dispatchEvent(new FocusEvent('focus'))

      await waitFor(() => expect(fakeBridge.seenCalls()).toEqual([retry.id, retry.id]))

      fakeBridge.setStatus(retry.id, 'idle')

      await waitFor(() => expect(fakeBridge.seenCalls()).toEqual([retry.id, retry.id, retry.id]))
      expect(mark(retry.id)).toHaveAttribute('data-unseen', 'false')
      expect(mark(retry.id)).toHaveClass('tone-neutral')
    })

    it('marks nothing seen while quiet hours lock the app, and the selected one once they unlock', async () => {
      const user = userEvent.setup()
      fakeBridge.setQuietState(makeQuietState({ inQuietHours: true }))
      seed()
      render(<App />)
      await screen.findByTestId('quiet-locked')

      await user.click(screen.getByRole('button', { name: 'app-1432-retry-logic' }))

      expect(screen.getByTestId(`sidebar-workspace-${retry.id}-open`)).toHaveAttribute(
        'aria-current',
        'page'
      )
      expect(fakeBridge.seenCalls()).toEqual([])

      await window.que.quiet.unlock({ minutes: 5, why: 'check the deploy' })

      await waitFor(() => expect(fakeBridge.seenCalls()).toEqual([retry.id]))
    })

    it('counts the unseen finishes on a collapsed project before its total', async () => {
      const user = userEvent.setup()
      seed()
      fakeBridge.seedWorkspace({ ...board, status: 'idle', finishedAt: minutesAgo(NOW, 5) })
      render(<App now={clock} />)

      await user.click(await screen.findByRole('button', { name: 'uploader', expanded: true }))

      const count = screen.getByTestId(`sidebar-project-${uploader.id}-count`)
      expect(count).toHaveTextContent(/^1 done · 2$/)
      expect(within(count).getByText('1 done')).toHaveClass('done')
    })
  })

  describe('unlock', () => {
    it("counts the unlock down in the Quiet row's place, and locks again from lock now", async () => {
      const user = userEvent.setup()
      fakeBridge.setQuietState(makeQuietState({ inQuietHours: true }))
      await window.que.quiet.unlock({ minutes: 5, why: 'check the deploy' })
      render(<App />)

      const countdown = await screen.findByTestId('sidebar-unlock-countdown')
      expect(countdown).toHaveTextContent(/^[45]:\d\d left$/)
      const unlock = screen.getByTestId('sidebar-unlock')
      expect(unlock).toHaveAttribute('role', 'status')
      expect(unlock.parentElement).toBe(screen.getByTestId('sidebar-foot-row'))
      expect(screen.queryByRole('group', { name: 'Quiet' })).not.toBeInTheDocument()

      await user.click(screen.getByTestId('sidebar-lock'))

      expect(await screen.findByTestId('quiet-locked')).toBeInTheDocument()
      expect((await window.que.quiet.log())[0]).toMatchObject({ endedAt: expect.any(String) })
      expect(screen.queryByTestId('sidebar-unlock-countdown')).not.toBeInTheDocument()
    })

    it('shows no unlock row in work hours', async () => {
      seed()
      render(<App />)

      await screen.findByTestId(`sidebar-project-${uploader.id}`)
      expect(screen.queryByTestId('sidebar-unlock')).not.toBeInTheDocument()
    })
  })

  describe('quiet row', () => {
    const minutes = (q: { windowStart: string | null; windowEnd: string | null }): number =>
      (Date.parse(q.windowEnd ?? '') - Date.parse(q.windowStart ?? '')) / 60_000

    it('sits above the icon strip as a group of four buttons, the word first and the lengths after it', async () => {
      render(<App />)

      const group = await screen.findByRole('group', { name: 'Quiet' })
      expect(
        group.compareDocumentPosition(screen.getByTestId('sidebar-strip')) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
      expect(
        within(group)
          .getAllByRole('button')
          .map((b) => b.textContent)
      ).toEqual(['Quiet', '30m', '1h', '2h'])
    })

    it('offers 30m, 1h and 2h as buttons with their labels', async () => {
      render(<App />)

      const group = await screen.findByRole('group', { name: 'Quiet' })
      expect(within(group).getByRole('button', { name: 'Quiet for 30 minutes' })).toHaveTextContent(
        '30m'
      )
      expect(within(group).getByRole('button', { name: 'Quiet for 1 hour' })).toHaveTextContent(
        '1h'
      )
      expect(within(group).getByRole('button', { name: 'Quiet for 2 hours' })).toHaveTextContent(
        '2h'
      )
    })

    it('starts an hour of manual quiet from the word, and locks the app', async () => {
      const user = userEvent.setup()
      render(<App />)

      await user.click(await screen.findByTestId('sidebar-quiet'))

      expect(await screen.findByTestId('quiet-locked')).toBeInTheDocument()
      const quiet = await window.que.quiet.state()
      expect(quiet).toMatchObject({ kind: 'manual', inQuietHours: true })
      expect(minutes(quiet)).toBe(60)
    })

    it('starts thirty minutes from 30m, not the hour', async () => {
      const user = userEvent.setup()
      render(<App />)

      await user.click(await screen.findByRole('button', { name: 'Quiet for 30 minutes' }))

      expect(await screen.findByTestId('quiet-locked')).toBeInTheDocument()
      const quiet = await window.que.quiet.state()
      expect(quiet).toMatchObject({ kind: 'manual' })
      expect(minutes(quiet)).toBe(30)
    })

    it('is absent during a scheduled quiet window', async () => {
      fakeBridge.setQuietState(makeQuietState({ inQuietHours: true }))
      await window.que.quiet.unlock({ minutes: 5, why: 'check the deploy' })
      render(<App />)

      await screen.findByTestId('sidebar-unlock')
      expect(screen.queryByRole('group', { name: 'Quiet' })).not.toBeInTheDocument()
    })

    it('disables its buttons while the daemon is disconnected', async () => {
      render(<App />)
      const group = await screen.findByRole('group', { name: 'Quiet' })
      expect(within(group).getByTestId('sidebar-quiet')).toBeEnabled()

      fakeBridge.disconnect()

      await waitFor(() => {
        for (const b of within(group).getAllByRole('button')) expect(b).toBeDisabled()
      })
    })
  })

  describe('icon strip', () => {
    const views = [
      { name: 'Report', view: 'report-view' },
      { name: 'Tickets', view: 'tickets-view' },
      { name: 'Settings', view: 'settings-view' }
    ]

    it('names Report, Tickets and Settings by their tooltips, in that order, then usage', async () => {
      render(<App />)

      const strip = await screen.findByTestId('sidebar-strip')
      const buttons = within(strip).getAllByRole('button')
      expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
        'Report',
        'Tickets',
        'Settings',
        'Claude usage: no reading yet'
      ])
      expect(buttons.slice(0, 3).map((b) => b.getAttribute('title'))).toEqual([
        'Report',
        'Tickets',
        'Settings'
      ])
    })

    it.each(views)('opens $name and reads it as the open view', async ({ name, view }) => {
      const user = userEvent.setup()
      render(<App />)
      const strip = await screen.findByTestId('sidebar-strip')
      const button = within(strip).getByRole('button', { name })
      expect(button).not.toHaveAttribute('aria-current')

      await user.click(button)

      expect(await screen.findByTestId(view)).toBeInTheDocument()
      // Only the open view's icon is current.
      expect(
        within(strip)
          .getAllByRole('button')
          .map((b) => b.getAttribute('aria-current'))
      ).toEqual([...views.map((v) => (v.name === name ? 'page' : null)), null])
    })

    it('carries the open ticket count beside the Tickets icon', async () => {
      fakeBridge.seedTicket(makeTicket({ key: 'APP-1' }))
      fakeBridge.seedTicket(makeTicket({ key: 'APP-2' }))
      fakeBridge.seedTicket(makeTicket({ key: 'APP-3' }))
      render(<App />)

      const tickets = await screen.findByRole('button', { name: 'Tickets' })
      await waitFor(() => {
        expect(within(tickets).getByTestId('sidebar-tickets-count')).toHaveTextContent('3')
      })
    })

    it('holds Claude usage at its right end', async () => {
      render(<App />)

      const usage = await screen.findByTestId('sidebar-usage')
      expect(usage.parentElement).toBe(screen.getByTestId('sidebar-strip'))
      expect(usage.parentElement?.lastElementChild).toBe(usage)
    })
  })

  describe('projects added elsewhere', () => {
    it('shows a project the CLI added, live', async () => {
      seed()
      render(<App />)
      await screen.findByTestId(`sidebar-project-${uploader.id}`)

      const billing = await window.que.project.add({ path: '/Users/dev/code/billing' })

      expect(await screen.findByTestId(`sidebar-project-${billing.id}`)).toHaveTextContent(
        'billing'
      )
    })

    it('drops a project removed elsewhere', async () => {
      seed()
      render(<App />)
      await screen.findByTestId(`sidebar-project-${api.id}`)

      await window.que.project.remove({ id: api.id, force: true })

      await waitFor(() => {
        expect(screen.queryByTestId(`sidebar-project-${api.id}`)).not.toBeInTheDocument()
      })
    })
  })

  describe('user interactions', () => {
    it('adds the folder picked in the dialog as a project', async () => {
      const user = userEvent.setup()
      fakeBridge.setOpenFolderResult('/Users/dev/code/billing')
      render(<App />)

      await user.click(await screen.findByRole('button', { name: 'Add project' }))

      expect(
        await screen.findByRole('button', { name: /billing/, expanded: true })
      ).toBeInTheDocument()
      expect((await window.que.project.list()).map((p) => p.path)).toEqual([
        '/Users/dev/code/billing'
      ])
    })

    it('removes a workspace from its menu, deleting the branch unless told not to', async () => {
      const user = userEvent.setup()
      seed()
      render(<App />)

      await user.click(
        await screen.findByRole('button', { name: 'More actions for app-1440-quiet-board' })
      )
      await user.click(screen.getByRole('menuitem', { name: 'Remove…' }))
      const dialog = screen.getByRole('dialog', { name: 'Remove app-1440-quiet-board?' })
      expect(within(dialog).getByRole('checkbox', { name: /delete the branch/ })).toBeChecked()
      await user.click(within(dialog).getByRole('button', { name: 'Remove' }))

      await waitFor(() => {
        expect(fakeBridge.getWorkspace(board.id)).toBeUndefined()
      })
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(screen.queryByTestId(`sidebar-workspace-${board.id}`)).not.toBeInTheDocument()
    })

    it('closes the remove dialog at once, leaving the row removing and the view off it', async () => {
      const user = userEvent.setup()
      seed()
      fakeBridge.holdRemovals()
      render(<App />)
      await openWorkspace(user, board.id)
      expect(screen.getByTestId(`sidebar-workspace-${board.id}-open`)).toHaveAttribute(
        'aria-current',
        'page'
      )

      await user.click(
        screen.getByRole('button', { name: 'More actions for app-1440-quiet-board' })
      )
      await user.click(screen.getByRole('menuitem', { name: 'Remove…' }))
      const dialog = screen.getByRole('dialog', { name: 'Remove app-1440-quiet-board?' })
      await user.click(within(dialog).getByRole('button', { name: 'Remove' }))

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      })
      expect(mark(board.id)).toHaveAttribute('data-status', 'removing')
      expect(screen.getByTestId(`sidebar-workspace-${board.id}-open`)).not.toHaveAttribute(
        'aria-current'
      )
      expect(fakeBridge.getWorkspace(board.id)?.removal?.plan).toEqual([
        'terminals',
        'teardown',
        'worktree',
        'branch'
      ])
    })

    it('keeps the branch when the box is unchecked', async () => {
      const user = userEvent.setup()
      seed()
      fakeBridge.holdRemovals()
      render(<App />)

      await user.click(
        await screen.findByRole('button', { name: 'More actions for app-1440-quiet-board' })
      )
      await user.click(screen.getByRole('menuitem', { name: 'Remove…' }))
      const dialog = screen.getByRole('dialog', { name: 'Remove app-1440-quiet-board?' })
      await user.click(within(dialog).getByRole('checkbox', { name: /delete the branch/ }))
      await user.click(within(dialog).getByRole('button', { name: 'Remove' }))

      await waitFor(() => {
        expect(fakeBridge.getWorkspace(board.id)?.removal?.plan).toEqual([
          'terminals',
          'teardown',
          'worktree'
        ])
      })
    })

    it('renames a workspace from its menu, and its branch when it was never pushed', async () => {
      const user = userEvent.setup()
      seed()
      render(<App />)

      await user.click(
        await screen.findByRole('button', { name: 'More actions for app-1432-retry-logic' })
      )
      await user.click(screen.getByRole('menuitem', { name: 'Rename…' }))
      const dialog = screen.getByRole('dialog', { name: 'Rename app-1432-retry-logic' })
      const title = within(dialog).getByRole('textbox', { name: 'Title' })
      const branch = within(dialog).getByRole('textbox', { name: 'Branch' })
      expect(title).toHaveValue('app-1432-retry-logic')
      expect(branch).toHaveValue(retry.branch)
      await waitFor(() => expect(branch).toBeEnabled())
      await user.clear(title)
      await user.type(title, 'Retry uploads with backoff')
      await user.clear(branch)
      await user.type(branch, 'fix/retry-backoff')
      await user.click(within(dialog).getByRole('button', { name: 'Rename' }))

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      })
      expect(fakeBridge.renameCalls()).toEqual([
        { id: retry.id, title: 'Retry uploads with backoff', branch: 'fix/retry-backoff' }
      ])
      expect(screen.getByTestId(`sidebar-workspace-${retry.id}-name`)).toHaveTextContent(
        'Retry uploads with backoff'
      )
    })

    it('keeps a pushed branch read-only and renames only the title', async () => {
      const user = userEvent.setup()
      seed()
      fakeBridge.setBranchPushed(board.id)
      render(<App />)

      await user.click(
        await screen.findByRole('button', { name: 'More actions for app-1440-quiet-board' })
      )
      await user.click(screen.getByRole('menuitem', { name: 'Rename…' }))
      const dialog = screen.getByRole('dialog', { name: 'Rename app-1440-quiet-board' })
      expect(await within(dialog).findByText('Pushed branches keep their name')).toBeInTheDocument()
      expect(within(dialog).getByRole('textbox', { name: 'Branch' })).toBeDisabled()
      await user.clear(within(dialog).getByRole('textbox', { name: 'Title' }))
      await user.type(within(dialog).getByRole('textbox', { name: 'Title' }), 'Quiet board polish')
      await user.click(within(dialog).getByRole('button', { name: 'Rename' }))

      await waitFor(() => {
        expect(fakeBridge.renameCalls()).toEqual([{ id: board.id, title: 'Quiet board polish' }])
      })
    })

    it('opens the workspace in the editor from its menu', async () => {
      const user = userEvent.setup()
      seed()
      render(<App />)

      await user.click(
        await screen.findByRole('button', { name: 'More actions for app-1432-retry-logic' })
      )
      await user.click(screen.getByRole('menuitem', { name: 'Open in editor' }))

      await waitFor(() => {
        expect(fakeBridge.openInEditorCalls()).toEqual([retry.path])
      })
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })

    it('removes a project and its workspaces from its right-click menu', async () => {
      const user = userEvent.setup()
      seed()
      render(<App />)
      const row = await screen.findByRole('button', { name: 'uploader', expanded: true })

      await user.pointer({ keys: '[MouseRight]', target: row })
      const menu = screen.getByRole('menu', { name: 'Actions for uploader' })
      expect(
        within(menu)
          .getAllByRole('menuitem')
          .map((m) => m.textContent)
      ).toEqual(['New workspace…', 'Open in editor', 'Remove project…'])
      await user.click(within(menu).getByRole('menuitem', { name: 'Remove project…' }))
      const dialog = screen.getByRole('dialog', { name: 'Remove uploader?' })
      expect(dialog).toHaveTextContent('the repository itself is not touched')
      expect(dialog).toHaveTextContent('Its 2 workspaces are removed too')
      await user.click(within(dialog).getByRole('button', { name: 'Remove' }))

      await waitFor(() => {
        expect(screen.queryByTestId(`sidebar-project-${uploader.id}`)).not.toBeInTheDocument()
      })
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect((await window.que.project.list()).map((p) => p.id)).toEqual([api.id])
      expect(fakeBridge.getWorkspace(retry.id)).toBeUndefined()
      expect(fakeBridge.getWorkspace(board.id)).toBeUndefined()
      expect(screen.getByTestId(`sidebar-project-${api.id}`)).toBeInTheDocument()
    })

    it('removes a project from its ⋯ button too, saying nothing about workspaces when it has none', async () => {
      const user = userEvent.setup()

      const billing = makeProject({
        id: 'prj_01hzwb2x9m4e',
        name: 'billing',
        path: '/Users/dev/code/billing'
      })

      seed()
      fakeBridge.seedProject(billing)
      render(<App />)

      await user.click(await screen.findByRole('button', { name: 'More actions for billing' }))
      await user.click(screen.getByRole('menuitem', { name: 'Remove project…' }))
      const dialog = screen.getByRole('dialog', { name: 'Remove billing?' })
      expect(dialog).not.toHaveTextContent('removed too')
      await user.click(within(dialog).getByRole('button', { name: 'Remove' }))

      await waitFor(() => {
        expect(screen.queryByTestId(`sidebar-project-${billing.id}`)).not.toBeInTheDocument()
      })
    })

    it('offers the workspace actions on right-click too, and closes them with Escape', async () => {
      const user = userEvent.setup()
      seed()
      render(<App />)
      const row = await screen.findByTestId(`sidebar-workspace-${retry.id}`)

      await user.pointer({ keys: '[MouseRight]', target: row })
      const menu = screen.getByRole('menu', { name: 'Actions for app-1432-retry-logic' })
      expect(
        within(menu)
          .getAllByRole('menuitem')
          .map((m) => m.textContent)
      ).toEqual(['Rename…', 'Open in editor', 'Remove…'])
      await user.keyboard('{Escape}')

      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })

    describe('sessions', () => {
      const zsh = makeTermInfo({
        id: '7d0c5b2a-1111-4000-8000-3e4f5a6b7c8d',
        name: 'zsh',
        cwd: '/Users/dev'
      })

      const node = makeTermInfo({
        id: '7d0c5b2a-2222-4000-8000-3e4f5a6b7c8d',
        name: 'node',
        cwd: '/Users/dev/code/api'
      })

      it('lists the terminals outside any workspace above the projects, and opens the one clicked', async () => {
        const user = userEvent.setup()
        fakeBridge.seedTerminal(zsh)
        fakeBridge.seedTerminal(node)
        seed()
        render(<App />)

        const sessions = await screen.findByRole('navigation', { name: 'Sessions' })
        const projects = screen.getByRole('navigation', { name: 'Projects' })
        expect(
          sessions.compareDocumentPosition(projects) & Node.DOCUMENT_POSITION_FOLLOWING
        ).toBeTruthy()
        expect(
          within(sessions)
            .getAllByRole('listitem')
            .map((li) => li.textContent)
        ).toEqual(['›_zsh', '›_node'])

        await user.click(within(sessions).getByRole('button', { name: 'node' }))

        expect(screen.getByTestId(`sidebar-session-${node.id}-open`)).toHaveAttribute(
          'aria-current',
          'page'
        )
        expect(screen.getByTestId(`sidebar-session-${zsh.id}-open`)).not.toHaveAttribute(
          'aria-current'
        )
        expect(screen.getByTestId(`terminal-tab-${node.id}-select`)).toHaveAttribute(
          'aria-selected',
          'true'
        )
      })

      it('reads a session by the program running in it', async () => {
        fakeBridge.seedTerminal(zsh)
        render(<App />)

        const open = await screen.findByTestId(`sidebar-session-${zsh.id}-open`)
        expect(open).toHaveTextContent(/zsh$/)

        act(() => fakeBridge.updateTerminal(zsh.id, { title: undefined, process: 'claude' }))
        await waitFor(() => expect(open).toHaveTextContent(/^›_\s*claude$/))
      })

      it('reads an exited session faint, with exited as its hover word and no badge', async () => {
        fakeBridge.seedTerminal(zsh)
        render(<App />)
        const session = await screen.findByTestId(`sidebar-session-${zsh.id}`)
        expect(session).not.toHaveClass('weight-faint')

        fakeBridge.exitTerminal(zsh.id, 1)

        await waitFor(() => expect(session).toHaveClass('weight-faint'))
        const exited = screen.getByTestId(`sidebar-session-${zsh.id}-exited`)
        expect(exited).toHaveTextContent('exited')
        expect(exited.parentElement).toHaveClass('reveal')
        expect(within(session).queryByText('EXITED')).not.toBeInTheDocument()
        expect(screen.getByTestId(`sidebar-session-${zsh.id}-open`)).toHaveAttribute(
          'title',
          '/Users/dev'
        )
      })

      it('opens a new session from +, and selects it', async () => {
        const user = userEvent.setup()
        fakeBridge.seedTerminal(zsh)
        render(<App />)
        const sessions = await screen.findByRole('navigation', { name: 'Sessions' })
        await within(sessions).findByRole('button', { name: 'zsh' })

        await user.click(screen.getByRole('button', { name: 'New session' }))

        await waitFor(() => {
          expect(within(sessions).getAllByRole('listitem')).toHaveLength(2)
        })
        const [, created] = within(sessions).getAllByRole('listitem')
        expect(within(created).getByRole('button')).toHaveAttribute('aria-current', 'page')
        expect((await window.que.term.list()).filter((t) => !t.workspaceId)).toHaveLength(2)
      })
    })
  })
})

describe('Sidebar tickets entry', () => {
  it('does not count epics or unassigned parents', async () => {
    fakeBridge.seedTicket(makeTicket({ key: 'EP-1', level: 'epic' }))
    fakeBridge.seedTicket(makeTicket({ key: 'EP-2', level: 'epic', assigned: false }))
    fakeBridge.seedTicket(makeTicket({ key: 'APP-1', parentKey: 'EP-1' }))
    fakeBridge.seedTicket(makeTicket({ key: 'APP-2', assigned: false }))
    render(<App />)

    await waitFor(() => expect(screen.getByTestId('sidebar-tickets-count')).toHaveTextContent('1'))
  })

  it('counts the open tickets and opens the view', async () => {
    const user = userEvent.setup()
    fakeBridge.seedTicket(makeTicket({ key: 'APP-1' }))
    fakeBridge.seedTicket(makeTicket({ key: 'APP-2', statusCategory: 'new' }))
    fakeBridge.seedTicket(makeTicket({ key: 'APP-3', statusCategory: 'done' }))
    render(<App />)

    const entry = await screen.findByRole('button', { name: /^Tickets/ })
    await waitFor(() => expect(screen.getByTestId('sidebar-tickets-count')).toHaveTextContent('2'))
    expect(screen.queryByTestId('sidebar-tickets-error')).not.toBeInTheDocument()
    expect(entry).not.toHaveAttribute('aria-current')

    await user.click(entry)

    expect(await screen.findByTestId('tickets-view')).toBeInTheDocument()
    expect(entry).toHaveAttribute('aria-current', 'page')
  })
  describe('filter and sort', () => {
    const zsh = makeTermInfo({
      id: '7d0c5b2a-3333-4000-8000-3e4f5a6b7c8d',
      name: 'zsh',
      cwd: '/Users/dev/code/uploader'
    })

    const node = makeTermInfo({
      id: '7d0c5b2a-4444-4000-8000-3e4f5a6b7c8d',
      name: 'node',
      cwd: '/Users/dev/code/api'
    })

    const openSearch = (user: ReturnType<typeof userEvent.setup>): Promise<void> =>
      user.click(screen.getByTestId('sidebar-search-toggle'))

    it('narrows projects to those with a matching workspace, and shows only those workspaces', async () => {
      const user = userEvent.setup()
      seed()
      render(<App />)
      await screen.findByTestId(`sidebar-project-${uploader.id}`)
      await openSearch(user)

      await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'RETRY')

      const project = screen.getByTestId(`sidebar-project-${uploader.id}`)
      expect(within(project).getByText('app-1432-retry-logic')).toBeInTheDocument()
      expect(within(project).queryByText('app-1440-quiet-board')).not.toBeInTheDocument()
      expect(screen.queryByTestId(`sidebar-project-${api.id}`)).not.toBeInTheDocument()
    })

    it('keeps all the workspaces of a project whose name matches', async () => {
      const user = userEvent.setup()
      seed()
      render(<App />)
      await screen.findByTestId(`sidebar-project-${uploader.id}`)
      await openSearch(user)

      await user.type(screen.getByTestId('sidebar-search'), 'uploa')

      const project = screen.getByTestId(`sidebar-project-${uploader.id}`)
      expect(within(project).getByText('app-1432-retry-logic')).toBeInTheDocument()
      expect(within(project).getByText('app-1440-quiet-board')).toBeInTheDocument()
      expect(screen.queryByTestId(`sidebar-project-${api.id}`)).not.toBeInTheDocument()
    })

    it('opens a collapsed project that has a match while filtering', async () => {
      const user = userEvent.setup()
      seed()
      render(<App />)
      await user.click(await screen.findByTestId(`sidebar-project-${uploader.id}-toggle`))
      expect(screen.queryByText('app-1432-retry-logic')).not.toBeInTheDocument()
      await openSearch(user)

      await user.type(screen.getByTestId('sidebar-search'), 'retry')

      expect(screen.getByText('app-1432-retry-logic')).toBeInTheDocument()
      expect(screen.getByTestId(`sidebar-project-${uploader.id}-toggle`)).toHaveAttribute(
        'aria-expanded',
        'true'
      )
    })

    it('narrows sessions by title and says when nothing matches', async () => {
      const user = userEvent.setup()
      fakeBridge.seedTerminal(zsh)
      fakeBridge.seedTerminal(node)
      seed()
      render(<App />)
      const sessions = await screen.findByRole('navigation', { name: 'Sessions' })
      await within(sessions).findByText('zsh')
      await openSearch(user)

      await user.type(screen.getByTestId('sidebar-search'), 'nod')

      expect(within(sessions).queryByText('zsh')).not.toBeInTheDocument()
      expect(within(sessions).getByText('node')).toBeInTheDocument()

      await user.type(screen.getByTestId('sidebar-search'), 'zzz')

      expect(screen.getByTestId('sidebar-sessions-nomatch')).toHaveTextContent('Nothing matches')
      expect(screen.getByTestId('sidebar-projects-nomatch')).toHaveTextContent('Nothing matches')
      expect(screen.queryByTestId('sidebar-empty')).not.toBeInTheDocument()
    })

    it('closes the search on Escape and clears the narrowing', async () => {
      const user = userEvent.setup()
      seed()
      render(<App />)
      await screen.findByTestId(`sidebar-project-${uploader.id}`)
      await openSearch(user)

      await user.type(screen.getByTestId('sidebar-search'), 'zzz')
      expect(screen.getByTestId('sidebar-projects-nomatch')).toBeInTheDocument()
      await user.keyboard('{Escape}')

      expect(screen.queryByTestId('sidebar-search')).not.toBeInTheDocument()
      expect(screen.getByTestId('sidebar-search-toggle')).toHaveAttribute('aria-expanded', 'false')
      expect(screen.getByText('app-1432-retry-logic')).toBeInTheDocument()
      expect(screen.queryByTestId('sidebar-projects-nomatch')).not.toBeInTheDocument()
    })

    it('opens from the toggle, which reports aria-expanded and focuses the field', async () => {
      const user = userEvent.setup()
      seed()
      render(<App />)
      await screen.findByTestId(`sidebar-project-${uploader.id}`)
      const toggle = screen.getByTestId('sidebar-search-toggle')
      expect(toggle).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByTestId('sidebar-search')).not.toBeInTheDocument()

      await user.click(toggle)

      expect(toggle).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByTestId('sidebar-search')).toHaveFocus()
    })

    it('keeps the search open on blur while it has text, and closes it when empty', async () => {
      const user = userEvent.setup()
      seed()
      render(<App />)
      await screen.findByTestId(`sidebar-project-${uploader.id}`)
      await openSearch(user)
      const field = screen.getByTestId('sidebar-search')

      await user.type(field, 'retry')
      await user.click(document.body)
      expect(screen.getByTestId('sidebar-search')).toHaveValue('retry')
      expect(screen.queryByTestId(`sidebar-project-${api.id}`)).not.toBeInTheDocument()

      await user.clear(field)
      await user.click(document.body)
      expect(screen.queryByTestId('sidebar-search')).not.toBeInTheDocument()
      expect(screen.getByTestId(`sidebar-project-${api.id}`)).toBeInTheDocument()
    })

    it('closes and clears when the toggle is clicked while open', async () => {
      const user = userEvent.setup()
      seed()
      render(<App />)
      await screen.findByTestId(`sidebar-project-${uploader.id}`)
      await openSearch(user)
      await user.type(screen.getByTestId('sidebar-search'), 'zzz')
      expect(screen.getByTestId('sidebar-projects-nomatch')).toBeInTheDocument()

      await user.click(screen.getByTestId('sidebar-search-toggle'))

      expect(screen.queryByTestId('sidebar-search')).not.toBeInTheDocument()
      expect(screen.getByText('app-1432-retry-logic')).toBeInTheDocument()
    })

    it('counts only the open tickets that match the filter', async () => {
      const user = userEvent.setup()
      fakeBridge.seedTicket(makeTicket())
      fakeBridge.seedTicket(
        makeTicket({ key: 'APP-1440', summary: 'Refresh the auth token', url: 'https://x/1440' })
      )
      seed()
      render(<App />)
      await waitFor(() =>
        expect(screen.getByTestId('sidebar-tickets-count')).toHaveTextContent('2')
      )
      await openSearch(user)

      await user.type(screen.getByTestId('sidebar-search'), 'auth')

      expect(screen.getByTestId('sidebar-tickets-count')).toHaveTextContent('1')
    })

    describe('sort', () => {
      const names = (): string[] =>
        screen.getAllByTestId(/^sidebar-project-prj_\w+-toggle$/).map((b) => b.textContent ?? '')

      it('reorders projects by last activity, workspaces too, and flips its label', async () => {
        const user = userEvent.setup()
        fakeBridge.seedProject(uploader)
        fakeBridge.seedProject(api)
        fakeBridge.seedWorkspace(
          makeWorkspace({ name: 'u-old', statusAt: '2026-10-01T00:00:00.000Z' })
        )
        fakeBridge.seedWorkspace(
          makeWorkspace({ name: 'a-old', projectId: api.id, statusAt: '2026-10-02T00:00:00.000Z' })
        )
        fakeBridge.seedWorkspace(
          makeWorkspace({
            name: 'a-zz-new',
            projectId: api.id,
            statusAt: '2026-10-03T00:00:00.000Z',
            lastActivityAt: '2026-10-12T00:00:00.000Z'
          })
        )
        render(<App />)
        const sort = await screen.findByTestId('sidebar-sort')
        expect(sort).toHaveAttribute('data-sort', 'name')
        expect(sort).toHaveAccessibleName('Sorted by name')
        expect(sort).toHaveAttribute('title', 'Sort by last activity')
        expect(names()[0]).toContain('api')

        const apiRows = (): string[] =>
          within(screen.getByTestId(`sidebar-project-${api.id}`))
            .getAllByTestId(/^sidebar-workspace-ws_\w+$/)
            .map((r) => r.textContent ?? '')

        expect(apiRows()[0]).toContain('a-old')

        await user.click(sort)

        expect(sort).toHaveAttribute('data-sort', 'activity')
        expect(sort).toHaveAccessibleName('Sorted by last activity')
        expect(sort).toHaveAttribute('title', 'Sort by name')
        expect(apiRows()[0]).toContain('a-zz-new')
      })

      it('puts the project with the newest activity first', async () => {
        const user = userEvent.setup()
        fakeBridge.seedProject(uploader)
        fakeBridge.seedProject(api)
        fakeBridge.seedWorkspace(
          makeWorkspace({ name: 'u-new', lastActivityAt: '2026-10-12T00:00:00.000Z' })
        )
        fakeBridge.seedWorkspace(
          makeWorkspace({
            name: 'a-mid',
            projectId: api.id,
            statusAt: '2026-10-09T00:00:00.000Z'
          })
        )
        render(<App />)
        await screen.findByTestId('sidebar-sort')
        expect(names()[0]).toContain('api')

        await user.click(screen.getByTestId('sidebar-sort'))

        expect(names()[0]).toContain('uploader')
        expect(names()[1]).toContain('api')
      })

      it('remembers the sort across a remount, and falls back to name for a bad value', async () => {
        const user = userEvent.setup()
        seed()
        const first = render(<App />)
        await user.click(await screen.findByTestId('sidebar-sort'))
        first.unmount()

        const second = render(<App />)
        expect(await screen.findByTestId('sidebar-sort')).toHaveAttribute('data-sort', 'activity')
        second.unmount()

        localStorage.setItem('que.sidebarSort', 'sideways')
        render(<App />)
        expect(await screen.findByTestId('sidebar-sort')).toHaveAttribute('data-sort', 'name')
      })
    })
  })
})
