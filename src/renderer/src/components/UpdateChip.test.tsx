import { describe, expect, it } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { fakeBridge, type UnsentFields } from '@renderer/testing/fake-bridge'
import {
  makeBackgroundTask,
  makeProject,
  makePullRequest,
  makeQuietState,
  makeTermInfo,
  makeWorkspace
} from '@renderer/testing/fixtures'
import { openWorkspace } from '@renderer/testing/helpers'
import App from '../App'

const project = makeProject({ id: 'prj_01hzx2a7k4mn', name: 'uploader' })

const retry = makeWorkspace({
  id: 'ws_01hzx3k9c2qf',
  projectId: project.id,
  name: 'app-1432-retry-logic'
})

const docs = makeWorkspace({ id: 'ws_01hzx4m1p8rt', projectId: project.id, name: 'app-1440-docs' })

const RESTART_TITLE =
  'que was updated. The background service still runs the previous build. Restart it on this build; every terminal keeps running.'

/** A newer release, as the main process's update check reports it. */
const RELEASE = { version: '0.3.0', url: 'https://github.com/queapp-org/que/releases/tag/v0.3.0' }

/** A daemon still running the build before this app's. */
const STALE = { buildId: '8c41e07d92aa', expectedBuildId: '3f9a2c71b0de', stale: true }

/** A Claude plan usage reading, as `que statusline` reports it. */
const USAGE = {
  fiveHour: { pct: 42.4, resetsAt: Date.UTC(2026, 9, 27, 20, 20) },
  sevenDay: { pct: 17.6, resetsAt: Date.UTC(2026, 10, 2, 14, 0) },
  at: Date.UTC(2026, 9, 27, 18, 8)
}

/**
 * What the build before background tasks (#145) did not send yet: a workspace's background
 * tasks, its branches and the pull requests it created, and each pull request's base, head
 * and comment count.
 */
const BEFORE_BACKGROUND_TASKS: UnsentFields = {
  workspace: ['backgroundTasks', 'branches', 'prUrls'],
  pr: ['base', 'head', 'comments', 'commentedAt']
}

/** The session's open pull request. */
const retryPr = makePullRequest({
  url: 'https://github.com/rquellh/uploader/pull/88',
  number: 88,
  title: 'Retry failed uploads with backoff',
  state: 'open',
  head: retry.branch,
  additions: 120,
  deletions: 14
})

/** As the main process words a failed hand-off (src/shared/upgrade.ts). */
const REFUSED =
  'The handoff failed: the new daemon exited (code 3) while taking over the terminals. Nothing changed: the previous build keeps serving every terminal, and que daemon restart would end them and start this build'

/** As the main process words a failed download and a release that went away (src/main/update-install.ts). */
const DOWNLOAD_FAILED =
  "Couldn't download the update: no connection to GitHub. Settings > Updates links to the release page."

const NOTHING_TO_DOWNLOAD = 'que found no newer release to download. It may have been withdrawn.'

const claude = makeTermInfo({ name: 'claude', workspaceId: retry.id })
const docsShell = makeTermInfo({ name: 'zsh', workspaceId: docs.id })
const homeShell = makeTermInfo({ name: 'zsh', cwd: '/Users/dev' })

function seed(): void {
  fakeBridge.seedProject(project)
  fakeBridge.seedWorkspace(retry)
  fakeBridge.seedWorkspace(docs)
  fakeBridge.seedTerminal(claude)
  fakeBridge.seedTerminal(docsShell)
  fakeBridge.seedTerminal(homeShell)
}

/** Whether each terminal the fake daemon has is alive, in its order. */
async function aliveFlags(): Promise<boolean[]> {
  return (await window.que.term.list()).map((t) => t.alive)
}

describe('UpdateChip', () => {
  describe('rendering', () => {
    it('sits at the right end of the Quiet row while the service runs the previous build, and says why', async () => {
      seed()
      fakeBridge.setDaemon(STALE)

      render(<App />)

      const restart = await screen.findByRole('button', { name: 'Restart' })
      expect(restart).toBeEnabled()
      expect(restart).toHaveAttribute('title', RESTART_TITLE)
      const row = screen.getByTestId('sidebar-foot-row')
      const quiet = within(row).getByRole('group', { name: 'Quiet' })
      expect(restart.parentElement).toBe(row)
      expect(quiet.compareDocumentPosition(restart) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      // Outside the Quiet group, and never in the icon strip.
      expect(within(quiet).queryByRole('button', { name: 'Restart' })).not.toBeInTheDocument()
      expect(
        within(screen.getByTestId('sidebar-strip')).queryByRole('button', { name: 'Restart' })
      ).not.toBeInTheDocument()
    })

    it('sits after lock now while an unlock runs', async () => {
      seed()
      fakeBridge.setDaemon(STALE)
      fakeBridge.setQuietState(makeQuietState({ inQuietHours: true }))
      await window.que.quiet.unlock({ minutes: 5, why: 'check the deploy' })

      render(<App />)

      const restart = await screen.findByRole('button', { name: 'Restart' })
      const row = screen.getByTestId('sidebar-foot-row')
      expect(restart.parentElement).toBe(row)
      expect(
        screen.getByTestId('sidebar-lock').compareDocumentPosition(restart) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
    })

    it('reads Update in the same place when the check already found a newer release, and says what it does', async () => {
      seed()
      fakeBridge.setUpdateStatus({ update: RELEASE })

      render(<App />)

      const update = await screen.findByRole('button', { name: 'Update' })
      expect(update).toHaveAttribute('data-testid', 'sidebar-app-update')
      expect(update).toHaveAttribute('data-state', 'update')
      expect(update).toHaveAttribute(
        'title',
        'que 0.3.0 has been released. Downloads it in the background; nothing installs until you click Restart.'
      )
      expect(update.parentElement).toBe(screen.getByTestId('sidebar-foot-row'))
      expect(screen.queryByTestId('sidebar-daemon-update')).not.toBeInTheDocument()
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('reads Restart while both hold, and Update once the service runs this build', async () => {
      const user = userEvent.setup()
      seed()
      fakeBridge.setDaemon(STALE)
      fakeBridge.setUpdateStatus({ update: RELEASE })
      render(<App />)

      const restart = await screen.findByRole('button', { name: 'Restart' })
      expect(screen.queryByTestId('sidebar-app-update')).not.toBeInTheDocument()

      await user.click(restart)

      expect(await screen.findByRole('button', { name: 'Update' })).toBeInTheDocument()
      expect(screen.queryByTestId('sidebar-daemon-update')).not.toBeInTheDocument()
    })
  })

  describe('status updates', () => {
    it('reads Update when the check finishes after the window opened', async () => {
      seed()
      render(<App />)
      await screen.findByTestId('sidebar-settings')
      expect(screen.queryByTestId('sidebar-app-update')).not.toBeInTheDocument()

      fakeBridge.setUpdateStatus({ update: RELEASE })

      expect(await screen.findByRole('button', { name: 'Update' })).toBeInTheDocument()
    })
  })

  describe('a previous build without the newest methods', () => {
    it('still lists every workspace and offers Restart, then brings the usage reading in once restarted', async () => {
      const user = userEvent.setup()
      seed()
      fakeBridge.setUsage(USAGE)
      fakeBridge.setDaemon(STALE)
      // As the build before usage answers: unknown method usage.get.
      fakeBridge.withoutMethods('usage.get', 'tickets.list')
      render(<App />)

      expect(await screen.findByTestId(`sidebar-workspace-${retry.id}`)).toBeInTheDocument()
      expect(screen.getByTestId(`sidebar-workspace-${docs.id}`)).toBeInTheDocument()
      expect(screen.getByTestId('sidebar-usage')).toHaveClass('no-reading')

      await user.click(await screen.findByRole('button', { name: 'Restart' }))

      await waitFor(() => {
        expect(screen.getByTestId('sidebar-usage')).not.toHaveClass('no-reading')
      })
      expect(screen.getByTestId(`sidebar-workspace-${retry.id}`)).toBeInTheDocument()
    })
  })

  describe('a previous build without the newest fields', () => {
    it('draws every row, idle ones and their card included, and the review pane, offers Restart, and reads the new fields once restarted', async () => {
      const user = userEvent.setup()
      fakeBridge.seedProject(project)
      fakeBridge.seedWorkspace({ ...retry, pr: retryPr, prs: [retryPr] })
      fakeBridge.seedWorkspace({
        ...docs,
        backgroundTasks: [makeBackgroundTask({ kind: 'shell' })]
      })
      fakeBridge.seedTerminal(claude)
      fakeBridge.setDaemon(STALE)
      fakeBridge.withoutFields(BEFORE_BACKGROUND_TASKS)
      render(<App />)

      expect(await screen.findByTestId(`sidebar-workspace-${retry.id}`)).toBeInTheDocument()
      expect(screen.getByTestId(`sidebar-workspace-${docs.id}`)).toBeInTheDocument()
      // The previous build sends no background tasks, so its idle row reads plain idle.
      expect(
        screen.queryByTestId(`sidebar-workspace-${docs.id}-background`)
      ).not.toBeInTheDocument()
      expect(await screen.findByRole('button', { name: 'Restart' })).toBeInTheDocument()

      // The idle workspace's card, with its pull request.
      expect(await openWorkspace(user, retry.id)).toBe(claude.id)
      await user.keyboard('{Meta>}i{/Meta}')
      const card = await screen.findByTestId(`sidebar-workspace-${retry.id}-popout`)
      expect(
        within(card).getByTestId(`sidebar-workspace-${retry.id}-popout-pr-88`)
      ).toBeInTheDocument()

      // The review pane lists the same pull request.
      await user.click(
        within(screen.getByTestId('review-rail')).getByRole('button', { name: 'Pull requests' })
      )
      expect(await screen.findByTestId('pr-row-88')).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: 'Restart' }))

      // This build's service sends every field: the idle row's shell shows.
      expect(
        await screen.findByTestId(`sidebar-workspace-${docs.id}-background`)
      ).toBeInTheDocument()
      expect(screen.queryByTestId('sidebar-daemon-update')).not.toBeInTheDocument()
      expect(screen.getByTestId(`sidebar-workspace-${retry.id}`)).toBeInTheDocument()
      expect(screen.getByTestId('pr-row-88')).toBeInTheDocument()
    })
  })

  describe('user interactions', () => {
    it('restarts the service in place on the click, then goes away with the stale build', async () => {
      const user = userEvent.setup()
      seed()
      fakeBridge.setDaemon(STALE)
      render(<App />)

      await user.click(await screen.findByRole('button', { name: 'Restart' }))

      await waitFor(() => {
        expect(screen.queryByTestId('sidebar-daemon-update')).not.toBeInTheDocument()
      })
      expect(fakeBridge.upgradeCalls()).toBe(1)
      expect(screen.getByTestId('sidebar-settings')).toBeInTheDocument()
    })

    it('reads Restarting… and takes no second click until the service answers', async () => {
      const user = userEvent.setup()
      seed()
      fakeBridge.setDaemon(STALE)
      fakeBridge.holdUpgrade()
      render(<App />)

      await user.click(await screen.findByRole('button', { name: 'Restart' }))

      expect(await screen.findByRole('button', { name: 'Restarting…' })).toBeDisabled()
      fakeBridge.releaseUpgrade()
      await waitFor(() => {
        expect(screen.queryByTestId('sidebar-daemon-update')).not.toBeInTheDocument()
      })
      expect(fakeBridge.upgradeCalls()).toBe(1)
    })

    it('keeps every terminal through the restart: each attaches again with its id and none reads exited', async () => {
      const user = userEvent.setup()
      seed()
      fakeBridge.setDaemon(STALE)
      render(<App />)
      expect(await openWorkspace(user, retry.id)).toBe(claude.id)
      await waitFor(() => {
        expect(fakeBridge.attachCalls()).toContain(claude.id)
      })
      const attached = fakeBridge.attachCalls().filter((id) => id === claude.id).length

      await user.click(screen.getByRole('button', { name: 'Restart' }))

      await waitFor(() => {
        expect(screen.queryByTestId('sidebar-daemon-update')).not.toBeInTheDocument()
      })
      // The shown pane attached the same terminal again on the new connection.
      await waitFor(() => {
        expect(fakeBridge.attachCalls().filter((id) => id === claude.id)).toHaveLength(attached + 1)
      })
      expect(screen.getByTestId(`terminal-tab-${claude.id}`)).toBeInTheDocument()
      expect(screen.getByTestId(`terminal-tab-${claude.id}-select`)).toHaveAttribute(
        'aria-selected',
        'true'
      )

      for (const t of [claude, docsShell, homeShell]) {
        expect(screen.queryByTestId(`terminal-tab-${t.id}-exited`)).not.toBeInTheDocument()
      }

      expect(await aliveFlags()).toEqual([true, true, true])
    })
  })

  describe('installing a release', () => {
    it('downloads on Update and shows the percent, with no second click and no browser', async () => {
      const user = userEvent.setup()
      seed()
      fakeBridge.setUpdateStatus({ update: RELEASE })
      render(<App />)

      await user.click(await screen.findByRole('button', { name: 'Update' }))

      expect(await screen.findByRole('button', { name: 'Updating 0%' })).toBeDisabled()
      expect(fakeBridge.installUpdateCalls()).toBe(1)
      expect(fakeBridge.openUpdateCalls()).toBe(0)
      expect(fakeBridge.upgradeCalls()).toBe(0)

      fakeBridge.setUpdateStatus({ install: { phase: 'downloading', percent: 42 } })

      const updating = await screen.findByRole('button', { name: 'Updating 42%' })
      expect(updating).toBeDisabled()
      expect(updating).toHaveAttribute('data-testid', 'sidebar-app-update')
      expect(updating).toHaveAttribute('data-state', 'downloading')
      expect(updating).toHaveAttribute(
        'title',
        'Downloading que 0.3.0 in the background. Nothing installs until you click Restart.'
      )
    })

    it('reads Restart once downloaded, and that click installs without touching the service', async () => {
      const user = userEvent.setup()
      seed()
      fakeBridge.setUpdateStatus({ update: RELEASE })
      render(<App />)
      await screen.findByRole('button', { name: 'Update' })

      fakeBridge.setUpdateStatus({ install: { phase: 'ready', version: '0.3.0' } })

      const restart = await screen.findByRole('button', { name: 'Restart' })
      expect(restart).toHaveAttribute('data-testid', 'sidebar-app-update')
      expect(restart).toHaveAttribute('data-state', 'ready')
      expect(restart).toHaveAttribute(
        'title',
        'que 0.3.0 is downloaded. Restart to install it; every terminal keeps running.'
      )

      await user.click(restart)

      const restarting = await screen.findByRole('button', { name: 'Restarting…' })
      expect(restarting).toBeDisabled()
      expect(restarting).toHaveAttribute('data-state', 'installing')
      expect(restarting).toHaveAttribute(
        'title',
        'Installing que 0.3.0. que reopens by itself; every terminal keeps running.'
      )
      expect(fakeBridge.restartToInstallCalls()).toBe(1)
      expect(fakeBridge.upgradeCalls()).toBe(0)
    })

    it('puts the install first with a stale service too, since the new app hands over by itself', async () => {
      const user = userEvent.setup()
      seed()
      fakeBridge.setDaemon(STALE)
      fakeBridge.setUpdateStatus({
        update: RELEASE,
        install: { phase: 'ready', version: '0.3.0' }
      })
      render(<App />)

      const restart = await screen.findByTestId('sidebar-app-update')
      expect(restart).toHaveAttribute('data-state', 'ready')
      expect(screen.queryByTestId('sidebar-daemon-update')).not.toBeInTheDocument()

      await user.click(restart)

      await waitFor(() => {
        expect(fakeBridge.restartToInstallCalls()).toBe(1)
      })
      expect(fakeBridge.upgradeCalls()).toBe(0)
    })

    it('reads the service restart over a download running behind it, then the percent again', async () => {
      const user = userEvent.setup()
      seed()
      fakeBridge.setDaemon(STALE)
      fakeBridge.setUpdateStatus({
        update: RELEASE,
        install: { phase: 'downloading', percent: 17 }
      })
      render(<App />)

      const restart = await screen.findByTestId('sidebar-daemon-update')
      expect(restart).toHaveAttribute('data-state', 'stale')
      expect(screen.queryByTestId('sidebar-app-update')).not.toBeInTheDocument()

      await user.click(restart)

      expect(await screen.findByRole('button', { name: 'Updating 17%' })).toBeDisabled()
      expect(fakeBridge.upgradeCalls()).toBe(1)
    })
  })

  describe('errors', () => {
    it('puts a failed hand-off on the error line, ends no terminal, and stays for another try', async () => {
      const user = userEvent.setup()
      seed()
      fakeBridge.setDaemon(STALE)
      fakeBridge.refuseUpgrade(REFUSED)
      render(<App />)

      await user.click(await screen.findByRole('button', { name: 'Restart' }))

      expect(await screen.findByRole('alert')).toHaveTextContent(REFUSED)
      // Back to Restart once the answer is in.
      expect(await screen.findByRole('button', { name: 'Restart' })).toBeEnabled()
      expect(await aliveFlags()).toEqual([true, true, true])
      expect(fakeBridge.upgradeCalls()).toBe(1)
    })

    it('tries again on the next click, and the error line clears when the service restarts', async () => {
      const user = userEvent.setup()
      seed()
      fakeBridge.setDaemon(STALE)
      fakeBridge.refuseUpgrade(
        'The handoff failed: the running service is too old to update in place'
      )
      render(<App />)
      await user.click(await screen.findByRole('button', { name: 'Restart' }))
      await screen.findByRole('alert')

      await user.click(await screen.findByRole('button', { name: 'Restart' }))

      await waitFor(() => {
        expect(screen.queryByTestId('sidebar-daemon-update')).not.toBeInTheDocument()
      })
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(fakeBridge.upgradeCalls()).toBe(2)
    })

    it('goes back to Update when a download fails, says why on the error line, and tries again on the click', async () => {
      const user = userEvent.setup()
      seed()
      fakeBridge.setUpdateStatus({ update: RELEASE })
      render(<App />)
      await user.click(await screen.findByRole('button', { name: 'Update' }))
      await screen.findByRole('button', { name: 'Updating 0%' })

      fakeBridge.setUpdateStatus({ install: { phase: 'failed', message: DOWNLOAD_FAILED } })

      expect(await screen.findByRole('alert')).toHaveTextContent(DOWNLOAD_FAILED)
      const update = screen.getByRole('button', { name: 'Update' })
      expect(update).toBeEnabled()

      await user.click(update)

      expect(await screen.findByRole('button', { name: 'Updating 0%' })).toBeInTheDocument()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(fakeBridge.installUpdateCalls()).toBe(2)
    })

    it('says so and takes the chip away when the release is gone by the time of the click', async () => {
      const user = userEvent.setup()
      seed()
      fakeBridge.setUpdateStatus({ update: RELEASE })
      render(<App />)
      await user.click(await screen.findByRole('button', { name: 'Update' }))
      await screen.findByRole('button', { name: 'Updating 0%' })

      fakeBridge.setUpdateStatus({
        update: null,
        install: { phase: 'failed', message: NOTHING_TO_DOWNLOAD }
      })

      expect(await screen.findByRole('alert')).toHaveTextContent(NOTHING_TO_DOWNLOAD)
      expect(screen.queryByTestId('sidebar-app-update')).not.toBeInTheDocument()
    })

    it('does not bring a dismissed failure back when a later check reports the same one', async () => {
      const user = userEvent.setup()
      seed()
      fakeBridge.setUpdateStatus({ update: RELEASE })
      render(<App />)
      await screen.findByRole('button', { name: 'Update' })
      fakeBridge.setUpdateStatus({ install: { phase: 'failed', message: DOWNLOAD_FAILED } })
      await screen.findByRole('alert')

      await user.click(screen.getByRole('button', { name: 'Dismiss' }))
      fakeBridge.setUpdateStatus({ checkedAt: new Date(2026, 10, 3, 15, 0).getTime() })

      await waitFor(() => {
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      })
    })

    it('puts a failed hand-off at launch on the error line, and the stale Restart tries again', async () => {
      const user = userEvent.setup()
      seed()
      fakeBridge.setDaemon(STALE)
      fakeBridge.setUpdateStatus({ handoffError: REFUSED })
      render(<App />)

      expect(await screen.findByRole('alert')).toHaveTextContent(REFUSED)
      const restart = await screen.findByRole('button', { name: 'Restart' })
      expect(restart).toHaveAttribute('data-testid', 'sidebar-daemon-update')
      expect(await aliveFlags()).toEqual([true, true, true])

      await user.click(restart)

      await waitFor(() => {
        expect(screen.queryByTestId('sidebar-daemon-update')).not.toBeInTheDocument()
      })
      expect(fakeBridge.upgradeCalls()).toBe(1)
    })
  })

  describe('empty state', () => {
    it('shows nothing, and never restarts the service, while it runs this build and no newer release is out', async () => {
      seed()
      render(<App />)

      await screen.findByTestId('sidebar-settings')
      await waitFor(() => {
        expect(fakeBridge.daemonStateCalls()).toBeGreaterThan(0)
      })
      expect(screen.queryByTestId('sidebar-daemon-update')).not.toBeInTheDocument()
      expect(screen.queryByTestId('sidebar-app-update')).not.toBeInTheDocument()
      expect(fakeBridge.upgradeCalls()).toBe(0)
      expect(fakeBridge.installUpdateCalls()).toBe(0)
    })
  })
})
