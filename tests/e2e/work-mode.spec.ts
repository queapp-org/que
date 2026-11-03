// Work mode end to end: a project registered with the CLI, a workspace made
// from the sidebar dialog, its terminal opened automatically, a claude session
// in it finishing a turn with one chime (recorded, never played, under e2e) and
// reaching needs input on the sidebar's dot (and in `que status` and the tray title), a turn finishing
// while another row is selected reading as unseen until the workspace is selected, Open
// in editor (in the review pane's Changes) launching the editor on the worktree, the project removed from
// its context menu with the workspace and its worktree, and Settings naming the running build.
import fs from 'node:fs'
import { expect, test } from '@playwright/test'
import { version } from '../../package.json'
import type { StatusJson } from '../../src/cli/workspaces'
import type { TermInfo } from '../../src/shared/protocol'
import type { Project, Workspace } from '../../src/shared/types'
import { makeTempRepo } from '../../src/testing/temp-repo'
import { AppShellPage } from './pages/AppShellPage'
import { ChangesPage } from './pages/ChangesPage'
import { ReviewPage } from './pages/ReviewPage'
import { SettingsPage } from './pages/SettingsPage'
import { SidebarPage } from './pages/SidebarPage'
import { TerminalPage } from './pages/TerminalPage'
import { type LaunchedApp, launchApp, newQueHome, tempDir } from './utils/app'
import { queJson } from './utils/que'

let launched: LaunchedApp

test.afterEach(async () => {
  await launched?.close() // quits the app AND stops the test daemon
})

test('a workspace made in the sidebar runs claude, shows needs input, opens in the editor, and goes with its project', async () => {
  const repo = makeTempRepo(tempDir('que-e2e-repo-'))
  const queHome = newQueHome()
  let project: Project
  let workspace: Workspace
  let termId = ''
  let sidebar: SidebarPage
  let terminal: TerminalPage
  let review: ReviewPage
  let changes: ChangesPage
  let shell: AppShellPage

  const statusOf = () =>
    queJson<StatusJson>(queHome, 'status', '--json').workspaces.find((w) => w.id === workspace.id)

  await test.step('Register the project with the CLI', async () => {
    project = queJson<Project>(queHome, 'project', 'add', repo, '--json')
    expect(project.defaultBranch).toBe('main')
  })

  await test.step('Launch the app; the project is in the sidebar', async () => {
    launched = await launchApp({ queHome })
    sidebar = new SidebarPage(launched.window)
    terminal = new TerminalPage(launched.window)
    review = new ReviewPage(launched.window)
    changes = new ChangesPage(launched.window)
    shell = new AppShellPage(launched.window)
    await sidebar.waitForLoad()
    await expect(sidebar.project(project.id)).toBeVisible()
  })

  await test.step('Create a workspace from the dialog, starting claude by hand', async () => {
    await sidebar.projectMenu(project.id).click()
    await sidebar.projectMenuNewWorkspace(project.id).click()
    await sidebar.newWorkspaceBrief.fill('APP-1432 retry logic')
    await sidebar.newWorkspaceName.fill('APP-1432 retry logic')
    await expect(sidebar.newWorkspaceSlug).toHaveText('Becomes app-1432-retry-logic')
    await sidebar.newWorkspaceStart.uncheck()
    await sidebar.newWorkspaceSubmit.click()
    await expect(sidebar.newWorkspaceDialog).toHaveCount(0)

    const created = queJson<Workspace[]>(queHome, 'ws', 'list', '--json').find(
      (w) => w.name === 'app-1432-retry-logic'
    )

    expect(created).toBeDefined()
    workspace = created as Workspace
    await expect(sidebar.workspace(workspace.id)).toBeVisible()
    await expect(sidebar.workspaceOpen(workspace.id)).toHaveAttribute('aria-current', 'page')
  })

  await test.step('Its first terminal opens as a tab, in the worktree', async () => {
    await expect
      .poll(
        () =>
          queJson<TermInfo[]>(queHome, 'term', 'list', '--json').find(
            (t) => t.workspaceId === workspace.id && t.alive
          )?.id ?? null,
        { message: 'no workspace terminal' }
      )
      .not.toBeNull()
    termId = queJson<TermInfo[]>(queHome, 'term', 'list', '--json').find(
      (t) => t.workspaceId === workspace.id
    )?.id as string
    await expect(terminal.tab(termId)).toBeVisible()
    await expect.poll(() => terminal.activeTermId()).toBe(termId)
  })

  await test.step('⌘K from the terminal pops the search out; Escape folds it away', async () => {
    await expect(sidebar.search).toHaveCount(0)
    await launched.window.keyboard.press('Meta+k')
    await expect(sidebar.search).toBeFocused()
    await launched.window.keyboard.type('zzz-nothing')
    await expect(sidebar.project(project.id)).toHaveCount(0)
    await expect(sidebar.projectsNoMatch).toBeVisible()
    await launched.window.keyboard.press('Escape')
    await expect(sidebar.search).toHaveCount(0)
    await expect(sidebar.workspace(workspace.id)).toBeVisible()
    // The icon sits in the title strip, which is a window-drag region; it must still take clicks.
    await sidebar.searchToggle.click()
    await expect(sidebar.search).toBeFocused()
    await launched.window.screenshot({ path: 'test-results/sidebar-search.png' })
    await sidebar.searchToggle.click()
    await expect(sidebar.search).toHaveCount(0)
    await terminal.input.focus()
  })

  await test.step('Start claude; the session reports in', async () => {
    await terminal.input.focus()
    await launched.window.keyboard.type('claude')
    await launched.window.keyboard.press('Enter')
    await expect
      .poll(() => statusOf()?.sessionId ?? null, { message: 'no session', timeout: 30_000 })
      .toMatch(/^[0-9a-f-]{36}$/)
  })

  await test.step('Say hello; the session answers and the turn ends with one chime', async () => {
    await launched.window.keyboard.type('hello')
    await launched.window.keyboard.press('Enter')
    await terminal.expectScreenToContain('● Fake reply to: hello')
    await sidebar.waitForWorkspaceStatus(workspace.id, 'idle')
    await expect.poll(() => shell.chimes()).toEqual(['complete'])
  })

  await test.step('Ask for something that needs permission; the badge says needs input', async () => {
    await launched.window.keyboard.type('/needs-input')
    await launched.window.keyboard.press('Enter')
    await sidebar.waitForWorkspaceStatus(workspace.id, 'needs_input')
    // The word shows only under the pointer.
    await sidebar.workspace(workspace.id).hover()
    await expect(sidebar.workspaceReveal(workspace.id)).toHaveCSS('opacity', '1')
    await expect(sidebar.workspaceWord(workspace.id)).toHaveText('needs input')
    expect(statusOf()?.status).toBe('needs_input')
    await expect.poll(() => shell.trayTitle()).toBe('● 0 ▸ 1 ✕ 0')
    // The needs-input chime is off by default.
    expect(await shell.chimes()).toEqual(['complete'])
  })

  await test.step('A turn that ends while a session is selected reads unseen until the workspace is', async () => {
    await sidebar.sessionsAdd.click()
    await expect(sidebar.workspaceOpen(workspace.id)).not.toHaveAttribute('aria-current', 'page')
    await expect(sidebar.workspaceStatus(workspace.id)).toHaveAttribute('data-unseen', 'false')
    // Grant the permission in the workspace's terminal, now off screen: the turn ends.
    await terminal.writeTo(termId, 'y\r')
    await sidebar.waitForWorkspaceStatus(workspace.id, 'idle')
    await expect(sidebar.workspaceStatus(workspace.id)).toHaveAttribute('data-unseen', 'true')
    await sidebar.workspace(workspace.id).hover()
    await expect(sidebar.workspaceReveal(workspace.id)).toHaveCSS('opacity', '1')
    await expect(sidebar.workspaceWord(workspace.id)).toHaveText(/^done · \d+s ago$/)
    // At rest again (the pointer off the rows): the green dot and the full-strength name.
    await sidebar.root.hover({ position: { x: 120, y: 300 } })
    await expect(sidebar.workspaceReveal(workspace.id)).toHaveCSS('opacity', '0')
    await sidebar.root.screenshot({ path: 'test-results/sidebar.png' })
    await sidebar.workspaceOpen(workspace.id).click()
    await expect(sidebar.workspaceStatus(workspace.id)).toHaveAttribute('data-unseen', 'false')
    await expect(sidebar.workspaceStatus(workspace.id)).toHaveAttribute('data-status', 'idle')
  })

  await test.step('Drag the divider; the sidebar widens by the same amount', async () => {
    const box = await sidebar.resizer.boundingBox()
    expect(box).not.toBeNull()
    const x = (box as { x: number; width: number }).x + (box as { width: number }).width / 2
    const y = (box as { y: number; height: number }).y + 200
    await launched.window.mouse.move(x, y)
    await launched.window.mouse.down()
    await launched.window.mouse.move(x + 100, y, { steps: 5 })
    await launched.window.mouse.up()
    await expect(sidebar.resizer).toHaveAttribute('aria-valuenow', '356')
    expect((await sidebar.root.boundingBox())?.width).toBe(356)
  })

  await test.step("Open in editor, in the review pane's Changes, launches the editor on the worktree", async () => {
    await review.show.click()
    await changes.openEditor.click()
    await expect.poll(() => launched.codeCalls()).toContainEqual(['-n', workspace.path])
    await launched.window.screenshot({ path: 'test-results/wp4-work-mode.png' })
  })

  await test.step('Remove the project from its context menu; the workspace and its worktree go too', async () => {
    await sidebar.projectToggle(project.id).click({ button: 'right' })
    await sidebar.projectMenuRemove(project.id).click()
    await expect(sidebar.removeProjectDialog).toContainText('Its 1 workspace is removed too')
    await sidebar.removeProjectSubmit.click()
    await expect(sidebar.removeProjectDialog).toHaveCount(0)
    await expect(sidebar.emptyState).toBeVisible()
    expect(queJson<Project[]>(queHome, 'project', 'list', '--json')).toEqual([])
    await expect.poll(() => fs.existsSync(workspace.path)).toBe(false)
  })

  await test.step('Settings names the running version, and that a test build never checks for releases', async () => {
    const settings = new SettingsPage(launched.window)
    await sidebar.settingsButton.click()
    await expect(settings.updatesVersion).toHaveText(`que ${version}`)
    await expect(settings.updatesAnswer).toHaveText("Local build: que doesn't check for releases.")
  })
})
