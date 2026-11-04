// The workspace journey end to end: the CLI creates a project and a workspace
// in the launched app's daemon, the workspace terminal shows up as a tab, and
// a Claude Code session typed into it (the fake, through que's hooks wrapper)
// reports needs input back to `que status`, and the report lists the workspace
// as waiting. And a workspace made from a brief in the dialog: under a random
// three-word name, claude started on the brief itself in its only terminal, and
// titled in the sidebar by the name the session gives itself in its terminal title. And the card a workspace row
// opens under a resting pointer: its branch and its pull requests from the fake gh.
import { expect, test } from '@playwright/test'
import type { StatusJson } from '../../src/cli/workspaces'
import { join } from 'node:path'
import type { TermInfo } from '../../src/shared/protocol'
import type { Project, Workspace } from '../../src/shared/types'
import { addFakePullRequest } from '../../src/testing/fakes'
import { makeTempRepo } from '../../src/testing/temp-repo'
import { AppShellPage } from './pages/AppShellPage'
import { ReportPage } from './pages/ReportPage'
import { SidebarPage } from './pages/SidebarPage'
import { TerminalPage } from './pages/TerminalPage'
import { type LaunchedApp, launchApp, newQueHome, retryPointer, tempDir } from './utils/app'
import { que, queJson } from './utils/que'

let launched: LaunchedApp

test.afterEach(async () => {
  await launched?.close() // quits the app AND stops the test daemon
})

test('a claude session in a workspace terminal reports needs input to que status', async () => {
  const repo = makeTempRepo(tempDir('que-e2e-repo-'))
  let workspace: Workspace
  let termId = ''
  let terminal: TerminalPage
  let sidebar: SidebarPage

  const statusOf = () =>
    queJson<StatusJson>(launched.queHome, 'status', '--json').workspaces.find(
      (w) => w.id === workspace.id
    )

  await test.step('Launch the app on a fresh QUE_HOME', async () => {
    launched = await launchApp()
    await new AppShellPage(launched.window).waitForLoad()
    terminal = new TerminalPage(launched.window)
    sidebar = new SidebarPage(launched.window)
    await terminal.waitForActiveTerminal()
  })

  await test.step('Add the project and create a workspace with the CLI', async () => {
    const project = queJson<Project>(launched.queHome, 'project', 'add', repo, '--json')
    expect(project).toMatchObject({
      path: expect.stringContaining('que-e2e-repo-'),
      defaultBranch: 'main'
    })
    workspace = queJson<Workspace>(
      launched.queHome,
      'work',
      '--name',
      'APP-1432 retry logic',
      '-r',
      repo,
      '--json'
    )
    expect(workspace).toMatchObject({
      projectId: project.id,
      name: 'app-1432-retry-logic',
      branch: 'app-1432-retry-logic',
      status: 'idle'
    })
  })

  await test.step("Open the workspace's terminal; it appears as a tab under the workspace", async () => {
    termId = que(launched.queHome, 'ws', 'terminal', workspace.id).trim()
    await expect(sidebar.workspace(workspace.id)).toBeVisible()
    await sidebar.workspaceOpen(workspace.id).click()
    await expect(terminal.tab(termId)).toBeVisible()
    await terminal.tabSelect(termId).click()
    await expect.poll(() => terminal.activeTermId()).toBe(termId)
  })

  await test.step('Start claude in it; the session reports in', async () => {
    await terminal.input.focus()
    await launched.window.keyboard.type('claude')
    await launched.window.keyboard.press('Enter')
    await expect
      .poll(() => statusOf()?.sessionId ?? null, {
        message: 'no session reported',
        timeout: 30_000
      })
      .toMatch(/^[0-9a-f-]{36}$/)
  })

  await test.step('Ask for something that needs permission; que status says needs input', async () => {
    await launched.window.keyboard.type('/needs-input')
    await launched.window.keyboard.press('Enter')
    await expect.poll(() => statusOf()?.status, { timeout: 30_000 }).toBe('needs_input')
    await sidebar.waitForWorkspaceStatus(workspace.id, 'needs_input')
    await terminal.expectScreenToContain('Claude needs your permission to use Bash. Allow? (y/n)')
    await launched.window.screenshot({ path: 'test-results/workspace-needs-input.png' })
  })

  await test.step('The report lists the workspace as waiting for input', async () => {
    const report = new ReportPage(launched.window)
    await sidebar.reportButton.click()
    await report.waitForLoad()
    await expect(report.workspace(workspace.id)).toBeVisible()
    await expect(report.workspaceFacts(workspace.id)).toContainText('asked for input 1×')
    await expect(report.workspaceState(workspace.id)).toHaveAttribute('data-status', 'needs_input')
    await expect(report.workspaceState(workspace.id)).toContainText('needs input · since')
    await expect(report.totals).toContainText('1 needs input')
  })
})

test("a workspace described in a brief gets a random name, claude started on it, and the session's own title", async () => {
  const repo = makeTempRepo(tempDir('que-e2e-repo-'))
  const queHome = newQueHome()
  const brief = 'Raise the upload timeout\n\nThe upload test times out on slow CI runners.'
  // A name given to the session from inside it, which it writes to its terminal title.
  const label = 'Slow runner upload timeout'
  let project: Project
  let workspace: Workspace
  let name = ''
  let sidebar: SidebarPage
  let terminal: TerminalPage

  await test.step('Register the project with the CLI and launch the app', async () => {
    project = queJson<Project>(queHome, 'project', 'add', repo, '--json')
    launched = await launchApp({ queHome })
    sidebar = new SidebarPage(launched.window)
    terminal = new TerminalPage(launched.window)
    await sidebar.waitForLoad()
    await expect(sidebar.project(project.id)).toBeVisible()
  })

  await test.step('Describe the work under a random name, drawing another once', async () => {
    await sidebar.projectMenu(project.id).click()
    await sidebar.projectMenuNewWorkspace(project.id).click()
    await sidebar.newWorkspaceBrief.fill(brief)
    await expect(sidebar.newWorkspaceName).toHaveValue(/^[a-z]+-[a-z]+-[a-z]+$/)
    await sidebar.newWorkspaceNewName.click()
    await expect(sidebar.newWorkspaceName).toHaveValue(/^[a-z]+-[a-z]+-[a-z]+$/)
    name = await sidebar.newWorkspaceName.inputValue()
    await expect(sidebar.newWorkspaceStart).toBeChecked()
    await sidebar.newWorkspaceSubmit.click()
    await expect(sidebar.newWorkspaceDialog).toHaveCount(0)

    const created = queJson<Workspace[]>(queHome, 'ws', 'list', '--json').find(
      (w) => w.name === name
    )

    expect(created).toMatchObject({ brief })
    workspace = created as Workspace
  })

  await test.step('Claude starts on the brief itself in the only terminal', async () => {
    await expect
      .poll(() => launched.claudeCalls().some((argv) => argv.at(-1) === brief), {
        message: 'claude never started on the brief',
        timeout: 30_000
      })
      .toBe(true)

    const terms = queJson<TermInfo[]>(queHome, 'term', 'list', '--json').filter(
      (t) => t.workspaceId === workspace.id
    )

    expect(terms).toHaveLength(1)
    await expect.poll(() => terminal.activeTermId()).toBe(terms[0].id)
  })

  await test.step('Renamed inside the session, the sidebar row takes the name', async () => {
    await terminal.expectScreenToContain('● Fake reply to: Raise the upload timeout', 30_000)
    await terminal.input.focus()
    await launched.window.keyboard.type(`/rename ${label}`)
    await launched.window.keyboard.press('Enter')
    await expect(sidebar.workspaceName(workspace.id)).toHaveText(label)
    await launched.window.screenshot({ path: 'test-results/workspace-from-brief.png' })
  })
})

test('a resting pointer on a workspace row opens its card with the branch and the pull requests', async () => {
  const repo = makeTempRepo(tempDir('que-e2e-repo-'))
  // The tracker polls every second here, so the seeded pull requests show up right away.
  const queHome = newQueHome('pr_poll_seconds = 1\n[quiet_hours]\nenabled = false\n')
  const prsFile = join(queHome, 'fake-gh-prs.json')
  const branch = 'app-1432-retry-logic'
  let workspace: Workspace
  let sidebar: SidebarPage

  await test.step('Seed two pull requests on the branch, then create the workspace with the CLI', async () => {
    addFakePullRequest(prsFile, branch, {
      number: 1,
      url: 'https://github.com/rquellh/que/pull/1',
      title: 'Fix the flaky upload test',
      state: 'MERGED',
      isDraft: false,
      mergedAt: '2026-10-14T03:00:00Z',
      additions: 12,
      deletions: 4
    })
    addFakePullRequest(prsFile, branch, {
      number: 3,
      url: 'https://github.com/rquellh/que/pull/3',
      title: 'Add retry logic to the uploader, with backoff and a cap on attempts',
      isDraft: false,
      additions: 214,
      deletions: 38
    })
    queJson<Project>(queHome, 'project', 'add', repo, '--json')
    workspace = queJson<Workspace>(
      queHome,
      'work',
      '--name',
      'APP-1432 retry logic',
      '-r',
      repo,
      '--json'
    )
    expect(workspace.branch).toBe(branch)
  })

  await test.step('Launch the app on that home; its first session settles the rows', async () => {
    launched = await launchApp({ queHome })
    sidebar = new SidebarPage(launched.window)
    await sidebar.waitForLoad()
    // The first session's row lands above the projects: wait for it, so the workspace row
    // stays put under the pointer.
    await new TerminalPage(launched.window).waitForActiveTerminal()
    await expect(sidebar.workspace(workspace.id)).toBeVisible()
  })

  await test.step('Rest the pointer on the row: the card opens beside it', async () => {
    await retryPointer(async () => {
      await sidebar.workspace(workspace.id).hover()
      await expect(sidebar.workspacePopout(workspace.id)).toBeVisible()
      await expect(sidebar.workspacePopoutBranch(workspace.id)).toHaveText(`branch ${branch}`)
      await expect(sidebar.workspacePopoutPath(workspace.id)).toContainText(workspace.name)
    })
  })

  await test.step('It lists both pull requests, newest first, with their state and counts', async () => {
    await retryPointer(async () => {
      await sidebar.workspace(workspace.id).hover()
      await expect(sidebar.workspacePopoutPrState(workspace.id, 3)).toHaveText('open', {
        timeout: 15_000
      })
      await expect(sidebar.workspacePopoutPrDiff(workspace.id, 3)).toHaveText('+214 −38')
      await expect(sidebar.workspacePopoutPrTitle(workspace.id, 3)).toHaveText(
        'Add retry logic to the uploader, with backoff and a cap on attempts'
      )
      await expect(sidebar.workspacePopoutPrLink(workspace.id, 3)).toHaveAttribute(
        'href',
        'https://github.com/rquellh/que/pull/3'
      )
      await expect(sidebar.workspacePopoutPrState(workspace.id, 1)).toHaveText('merged')
      await expect(sidebar.workspacePopoutPrDiff(workspace.id, 1)).toHaveText('+12 −4')
    })
    await launched.window.screenshot({ path: 'test-results/workspace-popout.png' })
  })

  await test.step('Moving the pointer off the row and the card closes it', async () => {
    await sidebar.reportButton.hover()
    await expect(sidebar.workspacePopout(workspace.id)).toHaveCount(0)
  })
})
