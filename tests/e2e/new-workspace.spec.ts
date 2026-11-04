// One click to a Claude session through the real app and daemon: the character on a project head
// makes a workspace with a generated name, its row and steps show while the daemon prepares it, and
// Claude's terminal takes their place with the keyboard, running a bare claude with que's hooks.
// The project menu's dialog is one step of it: the brief is optional there.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Project, Workspace } from '../../src/shared/types'
import { makeTempRepo } from '../../src/testing/temp-repo'
import { AppShellPage } from './pages/AppShellPage'
import { PreparingPage } from './pages/PreparingPage'
import { SidebarPage } from './pages/SidebarPage'
import { TerminalPage } from './pages/TerminalPage'
import { type LaunchedApp, launchApp, newQueHome, retryPointer, tempDir } from './utils/app'
import { queJson } from './utils/que'

let launched: LaunchedApp

test.afterEach(async () => {
  await launched?.close() // quits the app AND stops the test daemon
})

test('the character on a project head makes a workspace, shows its steps, and lands in a focused terminal running claude', async () => {
  // Setup waits for the spec, so the preparing state stays on screen as long as it needs.
  const gate = join(tempDir('que-e2e-gate-'), 'setup-gate')

  const repo = makeTempRepo(tempDir('que-e2e-repo-'), {
    queToml: `setup = "until [ -f '${gate}' ]; do sleep 0.05; done"\n`
  })

  const queHome = newQueHome()
  let project: Project
  let workspace: Workspace
  let sidebar: SidebarPage
  let terminal: TerminalPage
  let preparing: PreparingPage
  let shell: AppShellPage

  await test.step('Register the project with the CLI and launch the app', async () => {
    project = queJson<Project>(queHome, 'project', 'add', repo, '--json')
    launched = await launchApp({ queHome })
    sidebar = new SidebarPage(launched.window)
    terminal = new TerminalPage(launched.window)
    preparing = new PreparingPage(launched.window)
    shell = new AppShellPage(launched.window)
    await sidebar.waitForLoad()
    await expect(sidebar.project(project.id)).toBeVisible()
  })

  await test.step('The project menu opens the dialog, where the brief is optional', async () => {
    await sidebar.projectMenu(project.id).click()
    await sidebar.projectMenuNewWorkspace(project.id).click()
    await expect(sidebar.newWorkspaceDialog).toBeVisible()
    await expect(sidebar.newWorkspaceBrief).toHaveValue('')
    await expect(sidebar.newWorkspaceStart).toBeChecked()
    await expect(sidebar.newWorkspaceSubmit).toBeEnabled()
    await launched.window.screenshot({ path: 'test-results/new-workspace-dialog.png' })
    await launched.window.keyboard.press('Escape')
    await expect(sidebar.newWorkspaceDialog).toHaveCount(0)
  })

  await test.step('Under the pointer the head shows the plus', async () => {
    await retryPointer(async () => {
      await sidebar.projectToggle(project.id).hover()
      await expect(sidebar.projectActions(project.id)).toHaveCSS('opacity', '1', { timeout: 1_000 })
    })
    await expect(sidebar.projectStart(project.id)).toHaveAttribute(
      'title',
      'New workspace running Claude Code'
    )
    await launched.window.screenshot({ path: 'test-results/new-workspace-button.png' })
  })

  await test.step('One click: the row is there, under a generated name, with no dialog', async () => {
    await sidebar.projectStart(project.id).click()
    await expect(sidebar.newWorkspaceDialog).toHaveCount(0)
    await expect
      .poll(() => queJson<Workspace[]>(queHome, 'ws', 'list', '--json').length, {
        message: 'the workspace never appeared'
      })
      .toBe(1)
    ;[workspace] = queJson<Workspace[]>(queHome, 'ws', 'list', '--json')
    expect(workspace.name).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/)
    await expect(sidebar.workspaceOpen(workspace.id)).toHaveAttribute('aria-current', 'page')
  })

  await test.step('While setup runs: the neutral mark and the step on the row, the steps in the pane, no tab', async () => {
    await expect(sidebar.workspaceStep(workspace.id)).toHaveText(/^running setup \d+s$/, {
      timeout: 30_000
    })
    await expect(sidebar.workspaceStatus(workspace.id)).toHaveAttribute('data-status', 'preparing')
    await expect(sidebar.workspaceStatus(workspace.id)).toHaveClass(/\bworking-mark\b.*\bneutral\b/)
    await expect(preparing.step(workspace.id, 'fetch')).toHaveAttribute('data-state', 'done')
    await expect(preparing.step(workspace.id, 'worktree')).toHaveAttribute('data-state', 'done')
    await expect(preparing.step(workspace.id, 'setup')).toHaveAttribute('data-state', 'current')
    await expect(preparing.step(workspace.id, 'claude')).toHaveAttribute('data-state', 'pending')
    await expect(terminal.pane(0).tabbar.getByRole('tab')).toHaveCount(0)
    expect(launched.claudeCalls()).toEqual([])
    await launched.window.screenshot({ path: 'test-results/new-workspace-preparing.png' })
  })

  await test.step('The setup log opens through the app', async () => {
    await preparing.setupLog(workspace.id).click()
    await expect(shell.error).toHaveCount(0)
  })

  await test.step("Setup ends: Claude's terminal takes the place of the steps, selected and focused", async () => {
    writeFileSync(gate, '')
    const termId = await terminal.waitForActiveTerminal(30_000)
    await expect(preparing.pane(workspace.id)).toHaveCount(0)
    await expect(terminal.tabSelect(termId)).toHaveAttribute('aria-selected', 'true')
    await expect(terminal.input).toBeFocused()
  })

  await test.step('It runs a bare claude, with que hooks and no prompt', async () => {
    await expect
      .poll(() => launched.claudeCalls().length, {
        message: 'claude never started',
        timeout: 30_000
      })
      .toBe(1)
    expect(launched.claudeCalls()[0]).toEqual(['--settings', join(queHome, 'hooks.json')])
    await sidebar.waitForWorkspaceStatus(workspace.id, 'idle')
    await expect(sidebar.workspaceStep(workspace.id)).toHaveCount(0)
  })

  await test.step('The keyboard is in Claude: what is typed next is its first prompt', async () => {
    await launched.window.keyboard.type('Add retry logic to the uploader')
    await launched.window.keyboard.press('Enter')
    await terminal.expectScreenToContain('● Fake reply to: Add retry logic to the uploader', 30_000)
    await launched.window.screenshot({ path: 'test-results/new-workspace-ready.png' })
  })
})
