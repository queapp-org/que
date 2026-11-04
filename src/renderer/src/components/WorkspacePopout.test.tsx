import { describe, expect, it } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { fakeBridge } from '@renderer/testing/fake-bridge'
import {
  makeBackgroundTask,
  makePrCheck,
  makeProject,
  makePullRequest,
  makeTermInfo,
  makeWorkspace
} from '@renderer/testing/fixtures'
import { type PopoutDelays, QueStore, StoreContext } from '../store'
import Sidebar from './Sidebar'

const uploader = makeProject()

// A fixed clock, so `since HH:MM` and the ages never depend on the wall clock.
const NOW = new Date(2026, 9, 17, 16, 2).getTime()
const clock = (): number => NOW

const passing = makePullRequest({
  url: 'https://github.com/rquellh/uploader/pull/1',
  number: 1,
  title: 'Add retry logic to the uploader, with backoff and a cap on attempts',
  state: 'open',
  checks: 'passing',
  additions: 214,
  deletions: 38
})

const merged = makePullRequest({
  url: 'https://github.com/rquellh/uploader/pull/3',
  number: 3,
  title: 'Fix the flaky upload test',
  state: 'merged',
  checks: 'passing',
  additions: 12,
  deletions: 4
})

const retry = makeWorkspace({
  id: 'ws_01hzx3k9c2qf',
  name: 'app-1432-retry-logic',
  branch: 'feat/retry-logic',
  path: '/Users/dev/.que/worktrees/uploader/app-1432-retry-logic',
  status: 'idle',
  statusAt: new Date(2026, 9, 17, 14, 2).toISOString(),
  lastActivityAt: new Date(NOW - 2 * 3_600_000).toISOString(),
  prs: [merged, passing]
})

const stuck = makeWorkspace({
  id: 'ws_01hzx4m1p8rt',
  name: 'app-1440-quiet-board',
  status: 'stuck',
  statusReason: 'no_heartbeat',
  statusAt: new Date(2026, 9, 17, 15, 40).toISOString(),
  prs: [
    makePullRequest({
      url: 'https://github.com/rquellh/uploader/pull/7',
      number: 7,
      title: 'Draw the quiet board as a dim panel',
      state: 'open',
      checks: 'failing',
      checkRuns: [
        makePrCheck({ name: 'lint', state: 'passing' }),
        makePrCheck({ name: 'e2e', state: 'failing' }),
        makePrCheck({ name: 'unit', state: 'failing' })
      ]
    })
  ]
})

const lonely = makeWorkspace({
  id: 'ws_01hzx5t6y2wa',
  name: 'app-1451-token-refresh',
  status: 'idle'
})

// Being removed: the terminals went in 0.1s, the teardown timed out, the worktree is going
// now (12s in), and the branch waits.
const leaving = makeWorkspace({
  id: 'ws_01hzx6r3d8vn',
  name: 'app-1460-old-spike',
  status: 'removing',
  statusAt: new Date(2026, 9, 17, 16, 0).toISOString(),
  removal: {
    plan: ['terminals', 'teardown', 'worktree', 'branch'],
    since: new Date(NOW - 12_000).toISOString(),
    done: [
      { step: 'terminals', ms: 100 },
      { step: 'teardown', ms: 60_000, error: 'timed out 60s' }
    ]
  }
})

/** The sidebar on a store with the popout's delays injected, as the app would start it. */
function renderSidebar(delays: PopoutDelays = { open: 0, close: 0 }): void {
  fakeBridge.seedProject(uploader)
  fakeBridge.seedWorkspace(retry)
  fakeBridge.seedWorkspace(stuck)
  fakeBridge.seedWorkspace(lonely)
  const store = new QueStore(window.que, { now: clock, popoutDelays: delays })
  store.start()
  render(
    <StoreContext.Provider value={store}>
      <Sidebar />
    </StoreContext.Provider>
  )
}

const row = (id: string): Promise<HTMLElement> => screen.findByTestId(`sidebar-workspace-${id}`)

const card = (id: string): HTMLElement | null =>
  screen.queryByTestId(`sidebar-workspace-${id}-popout`)

async function hoverCard(
  user: ReturnType<typeof userEvent.setup>,
  id: string
): Promise<HTMLElement> {
  await user.hover(await row(id))

  return screen.findByTestId(`sidebar-workspace-${id}-popout`)
}

describe('WorkspacePopout', () => {
  describe('opening and closing', () => {
    it('opens beside the row once the pointer has rested for the injected delay', async () => {
      const user = userEvent.setup()
      renderSidebar()

      const popout = await hoverCard(user, retry.id)

      expect(within(popout).getByRole('heading', { name: 'app-1432-retry-logic' })).toBeVisible()
    })

    it('waits for the delay: a pointer that has not rested long enough opens nothing', async () => {
      const user = userEvent.setup()
      renderSidebar({ open: 60_000, close: 0 })

      await user.hover(await row(retry.id))

      expect(card(retry.id)).not.toBeInTheDocument()
    })

    it('opens on ⌘I for the selected workspace without waiting for the delay', async () => {
      const user = userEvent.setup()
      renderSidebar({ open: 60_000, close: 0 })
      await user.click(await screen.findByTestId(`sidebar-workspace-${retry.id}-open`))
      await user.unhover(await row(retry.id))

      await user.keyboard('{Meta>}i{/Meta}')

      expect(await screen.findByTestId(`sidebar-workspace-${retry.id}-popout`)).toBeVisible()
    })

    it('closes when the pointer leaves the row and the card', async () => {
      const user = userEvent.setup()
      renderSidebar()
      await hoverCard(user, retry.id)

      await user.unhover(await row(retry.id))

      await waitFor(() => expect(card(retry.id)).not.toBeInTheDocument())
    })

    it('stays while the pointer is on the card', async () => {
      const user = userEvent.setup()
      renderSidebar({ open: 0, close: 60_000 })
      const popout = await hoverCard(user, retry.id)

      await user.hover(popout)

      expect(card(retry.id)).toBeInTheDocument()
    })

    it('closes on Escape', async () => {
      const user = userEvent.setup()
      renderSidebar({ open: 0, close: 60_000 })
      await hoverCard(user, retry.id)

      await user.keyboard('{Escape}')

      await waitFor(() => expect(card(retry.id)).not.toBeInTheDocument())
    })

    it('closes on a press elsewhere and when the row’s ⋯ menu opens', async () => {
      const user = userEvent.setup()
      renderSidebar({ open: 0, close: 60_000 })
      await hoverCard(user, retry.id)

      await user.click(screen.getByTestId('sidebar-settings'))
      await waitFor(() => expect(card(retry.id)).not.toBeInTheDocument())

      await hoverCard(user, retry.id)
      await user.click(screen.getByTestId(`sidebar-workspace-${retry.id}-menu`))

      expect(card(retry.id)).not.toBeInTheDocument()
      expect(screen.getByRole('menu', { name: 'Actions for app-1432-retry-logic' })).toBeVisible()
    })

    it('never opens on a session row', async () => {
      const user = userEvent.setup()

      const zsh = makeTermInfo({
        id: '7d0c5b2a-5555-4000-8000-3e4f5a6b7c8d',
        name: 'zsh',
        cwd: '/Users/dev'
      })

      fakeBridge.seedTerminal(zsh)
      renderSidebar()

      await user.hover(await screen.findByTestId(`sidebar-session-${zsh.id}`))

      expect(screen.queryByTestId(/-popout$/)).not.toBeInTheDocument()
    })
  })

  describe('rendering', () => {
    it('reads the worktree with ~ for home, the branch, and the status since when', async () => {
      const user = userEvent.setup()
      renderSidebar()
      await hoverCard(user, retry.id)
      const id = `sidebar-workspace-${retry.id}-popout`

      await waitFor(() =>
        expect(screen.getByTestId(`${id}-path`)).toHaveTextContent(
          '~/.que/worktrees/uploader/app-1432-retry-logic'
        )
      )
      expect(screen.getByTestId(`${id}-branch`)).toHaveTextContent('branch feat/retry-logic')
      expect(screen.getByTestId(`${id}-status`)).toHaveTextContent(
        'idle since 14:02 · last activity 2h ago'
      )
      expect(screen.queryByTestId(`${id}-reason`)).not.toBeInTheDocument()
    })

    it('lists the background shell and monitor under [ BACKGROUND ], each with its kind, description and age', async () => {
      const user = userEvent.setup()
      fakeBridge.seedProject(uploader)
      fakeBridge.seedWorkspace({
        ...lonely,
        backgroundTasks: [
          makeBackgroundTask({ since: new Date(NOW - 31 * 60_000).toISOString() }),
          makeBackgroundTask({
            kind: 'monitor',
            description: 'tail -f logs/api.log',
            since: new Date(NOW - 18 * 60_000).toISOString()
          })
        ]
      })
      const store = new QueStore(window.que, { now: clock, popoutDelays: { open: 0, close: 0 } })
      store.start()
      render(
        <StoreContext.Provider value={store}>
          <Sidebar />
        </StoreContext.Provider>
      )
      const popout = await hoverCard(user, lonely.id)
      const id = `sidebar-workspace-${lonely.id}-popout`

      expect(within(popout).getByText('Background')).toHaveClass('label')
      const lines = within(screen.getByTestId(`${id}-background`)).getAllByRole('listitem')
      expect(lines.map((l) => l.textContent)).toEqual([
        'shellnpm run dev31m',
        'monitortail -f logs/api.log18m'
      ])
      expect(screen.getByTestId(`${id}-status`)).not.toContainElement(
        screen.getByTestId(`${id}-background`)
      )
    })

    it('has no background block when nothing runs in the background', async () => {
      const user = userEvent.setup()
      renderSidebar()
      const popout = await hoverCard(user, retry.id)

      expect(
        screen.queryByTestId(`sidebar-workspace-${retry.id}-popout-background`)
      ).not.toBeInTheDocument()
      expect(within(popout).queryByText('Background')).not.toBeInTheDocument()
    })

    it('lists the pull requests in the daemon’s order, newest first, each in its tone with its line counts', async () => {
      const user = userEvent.setup()
      renderSidebar()
      const popout = await hoverCard(user, retry.id)

      const pr = (n: number, part: string): HTMLElement =>
        screen.getByTestId(`sidebar-workspace-${retry.id}-popout-pr-${n}-${part}`)

      const rows = within(popout).getAllByTestId(/-popout-pr-\d+$/)
      expect(rows.map((r) => r.dataset.testid)).toEqual([
        `sidebar-workspace-${retry.id}-popout-pr-3`,
        `sidebar-workspace-${retry.id}-popout-pr-1`
      ])
      expect(pr(1, 'state')).toHaveTextContent('open · checks passing')
      expect(pr(1, 'state')).toHaveClass('tone-busy')
      expect(pr(1, 'diff')).toHaveTextContent('+214 −38')
      expect(pr(1, 'title')).toHaveTextContent(
        'Add retry logic to the uploader, with backoff and a cap on attempts'
      )
      expect(pr(3, 'state')).toHaveTextContent('merged')
      expect(pr(3, 'state')).toHaveClass('tone-good')
      expect(pr(3, 'diff')).toHaveTextContent('+12 −4')
    })

    it('leaves the counts out while they are unknown', async () => {
      const user = userEvent.setup()
      renderSidebar()
      await hoverCard(user, stuck.id)

      expect(
        screen.getByTestId(`sidebar-workspace-${stuck.id}-popout-pr-7-diff`)
      ).toBeEmptyDOMElement()
    })

    it('gives a stuck workspace its reason, and a failing check its first failing run', async () => {
      const user = userEvent.setup()
      renderSidebar()
      await hoverCard(user, stuck.id)
      const id = `sidebar-workspace-${stuck.id}-popout`

      expect(screen.getByTestId(`${id}-status`)).toHaveTextContent('stuck no_heartbeat since 15:40')
      expect(screen.getByTestId(`${id}-reason`)).toHaveTextContent('no_heartbeat')
      expect(screen.getByTestId(`${id}-pr-7-state`)).toHaveTextContent('open · checks failing')
      expect(screen.getByTestId(`${id}-pr-7-state`)).toHaveClass('tone-bad')
      expect(screen.getByTestId(`${id}-pr-7-failing`)).toHaveTextContent('✕ e2e')
    })

    it('says no pull request when there is none', async () => {
      const user = userEvent.setup()
      renderSidebar()
      const popout = await hoverCard(user, lonely.id)

      expect(screen.getByTestId(`sidebar-workspace-${lonely.id}-popout-no-pr`)).toHaveTextContent(
        'no pull request'
      )
      expect(within(popout).queryByTestId(/-popout-pr-\d+$/)).not.toBeInTheDocument()
    })

    it('lists a removal’s steps under [ REMOVING ]: done with its time, failed with its reason, the current one with its clock, the rest pending', async () => {
      const user = userEvent.setup()
      fakeBridge.seedProject(uploader)
      fakeBridge.seedWorkspace(leaving)
      const store = new QueStore(window.que, { now: clock, popoutDelays: { open: 0, close: 0 } })
      store.start()
      render(
        <StoreContext.Provider value={store}>
          <Sidebar />
        </StoreContext.Provider>
      )
      const popout = await hoverCard(user, leaving.id)
      const id = `sidebar-workspace-${leaving.id}-popout`
      const step = (s: string): HTMLElement => screen.getByTestId(`${id}-removal-${s}`)
      const right = (s: string): HTMLElement => screen.getByTestId(`${id}-removal-${s}-right`)

      expect(within(popout).getByText('Removing')).toHaveClass('label')
      expect(screen.getByTestId(`${id}-status`)).toHaveTextContent('removing since 16:00')
      const lines = within(screen.getByTestId(`${id}-removal`)).getAllByRole('listitem')
      expect(lines.map((l) => [l.dataset.state, l.textContent])).toEqual([
        ['done', 'killing terminals0.1s'],
        ['failed', 'running teardowntimed out 60s'],
        ['current', 'removing worktree12s'],
        ['pending', 'deleting branch']
      ])
      expect(right('teardown')).toHaveAttribute('title', 'timed out 60s')
      expect(right('branch')).toBeEmptyDOMElement()
      expect(step('worktree').querySelector('.working-mark.neutral')).toBeInTheDocument()
      expect(step('terminals').querySelector('.working-mark')).not.toBeInTheDocument()
      expect(within(popout).queryByText('Background')).not.toBeInTheDocument()
    })

    it('ticks the current step’s clock every second with the store’s clock', async () => {
      const user = userEvent.setup()
      let t = NOW
      fakeBridge.seedProject(uploader)
      fakeBridge.seedWorkspace(leaving)
      const store = new QueStore(window.que, { now: () => t, popoutDelays: { open: 0, close: 0 } })
      store.start()
      render(
        <StoreContext.Provider value={store}>
          <Sidebar />
        </StoreContext.Provider>
      )
      await hoverCard(user, leaving.id)

      const right = screen.getByTestId(
        `sidebar-workspace-${leaving.id}-popout-removal-worktree-right`
      )

      expect(right).toHaveTextContent('12s')

      t = NOW + 5_000

      await waitFor(() => expect(right).toHaveTextContent('17s'), { timeout: 3_000 })
    })

    it('lists a preparation’s steps under [ PREPARING ], with the way to the setup log', async () => {
      const user = userEvent.setup()

      const preparing = makeWorkspace({
        id: 'ws_01hzx7q2n4ks',
        name: 'quiet-amber-fern',
        status: 'preparing',
        preparation: {
          plan: ['fetch', 'worktree', 'setup', 'claude'],
          since: new Date(NOW - 12_000).toISOString(),
          done: [
            { step: 'fetch', ms: 1_200 },
            { step: 'worktree', ms: 300 }
          ]
        }
      })

      fakeBridge.seedProject(uploader)
      fakeBridge.seedWorkspace(preparing)
      const store = new QueStore(window.que, { now: clock, popoutDelays: { open: 0, close: 0 } })
      store.start()
      render(
        <StoreContext.Provider value={store}>
          <Sidebar />
        </StoreContext.Provider>
      )
      const popout = await hoverCard(user, preparing.id)
      const id = `sidebar-workspace-${preparing.id}-popout`

      expect(within(popout).getByText('Preparing')).toHaveClass('label')
      expect(screen.getByTestId(`${id}-preparation-fetch-right`)).toHaveTextContent('1s')
      expect(screen.getByTestId(`${id}-preparation-setup`)).toHaveAttribute('data-state', 'current')
      expect(screen.getByTestId(`${id}-preparation-setup-right`)).toHaveTextContent('12s')
      expect(screen.getByTestId(`${id}-preparation-claude`)).toHaveAttribute(
        'data-state',
        'pending'
      )

      await user.click(within(popout).getByRole('button', { name: 'Open setup log' }))

      expect(fakeBridge.openSetupLogCalls()).toEqual([preparing.id])
    })

    it('has no removal section while the workspace is not being removed', async () => {
      const user = userEvent.setup()
      renderSidebar()
      const popout = await hoverCard(user, retry.id)

      expect(
        screen.queryByTestId(`sidebar-workspace-${retry.id}-popout-removal`)
      ).not.toBeInTheDocument()
      expect(within(popout).queryByText('Removing')).not.toBeInTheDocument()
    })

    it('draws the copy icons only under the pointer, the editor icon and the links always', async () => {
      const user = userEvent.setup()
      renderSidebar()
      const popout = await hoverCard(user, retry.id)

      expect(within(popout).getByRole('button', { name: 'Copy path' })).toHaveClass('on-hover')
      expect(within(popout).getByRole('button', { name: 'Copy branch' })).toHaveClass('on-hover')
      expect(within(popout).getByRole('button', { name: 'Open in editor' })).not.toHaveClass(
        'on-hover'
      )
      expect(within(popout).getByRole('link', { name: 'Open pull request #1' })).not.toHaveClass(
        'on-hover'
      )
      expect(within(popout).getByRole('link', { name: 'Open pull request #3' })).not.toHaveClass(
        'on-hover'
      )
      expect(within(popout).queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument()
    })
  })

  describe('user interactions', () => {
    it('copies the worktree path and the branch to the clipboard', async () => {
      const user = userEvent.setup()
      renderSidebar()
      const popout = await hoverCard(user, retry.id)

      await user.click(within(popout).getByRole('button', { name: 'Copy path' }))
      await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(retry.path))

      await user.click(within(popout).getByRole('button', { name: 'Copy branch' }))
      await waitFor(async () =>
        expect(await navigator.clipboard.readText()).toBe('feat/retry-logic')
      )
    })

    it('opens the worktree in the editor', async () => {
      const user = userEvent.setup()
      renderSidebar()
      const popout = await hoverCard(user, retry.id)

      await user.click(within(popout).getByRole('button', { name: 'Open in editor' }))

      await waitFor(() => expect(fakeBridge.openInEditorCalls()).toEqual([retry.path]))
    })

    it('links each pull request to its own page, opened outside the app', async () => {
      const user = userEvent.setup()
      renderSidebar()
      const popout = await hoverCard(user, retry.id)

      for (const pr of [merged, passing]) {
        const link = within(popout).getByRole('link', { name: `Open pull request #${pr.number}` })
        expect(link).toHaveAttribute('href', pr.url)
        expect(link).toHaveAttribute('target', '_blank')
      }
    })
  })
})
