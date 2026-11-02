// Removing a workspace through the real app and daemon, in a repo whose teardown takes
// a few seconds: the dialog closes at once, the row stays with the neutral working mark and
// `running teardown` with its clock while the daemon works, then goes, `que ws list` no longer
// has it, and its folder leaves the trash. The worktree holds a real asar archive (#280), which
// only this layer can catch: Vitest's plain Node sees an ordinary file.
import { copyFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Project, Workspace } from '../../src/shared/types'
import { REPO_ROOT } from '../../src/testing/fakes'
import { makeTempRepo } from '../../src/testing/temp-repo'
import { SidebarPage } from './pages/SidebarPage'
import { type LaunchedApp, launchApp, newQueHome, tempDir } from './utils/app'
import { queJson } from './utils/que'

let launched: LaunchedApp

test.afterEach(async () => {
  await launched?.close() // quits the app AND stops the test daemon
})

test('a workspace removed from its row menu shows its steps on the row while the daemon removes it', async () => {
  // The slow hook under test: the teardown outlasts the dialog by seconds.
  const repo = makeTempRepo(tempDir('que-e2e-repo-'), {
    queToml: 'setup = "true"\nteardown = "sleep 4"\n'
  })

  const queHome = newQueHome()
  let workspace: Workspace
  let sidebar: SidebarPage

  await test.step('Register the project and make a workspace with the CLI', async () => {
    queJson<Project>(queHome, 'project', 'add', repo, '--json')
    workspace = queJson<Workspace>(
      queHome,
      'work',
      '--name',
      'APP-1470 drop the uploader',
      '-r',
      repo,
      '--json'
    )
  })

  await test.step('Put a real asar archive in its worktree', async () => {
    copyFileSync(
      join(
        REPO_ROOT,
        'node_modules/electron/dist/Electron.app/Contents/Resources/default_app.asar'
      ),
      join(workspace.path, 'default_app.asar')
    )
  })

  await test.step('Launch the app; the workspace is in the sidebar', async () => {
    launched = await launchApp({ queHome })
    sidebar = new SidebarPage(launched.window)
    await sidebar.waitForLoad()
    await expect(sidebar.workspace(workspace.id)).toBeVisible()
  })

  await test.step('Open Remove from the row menu; deleting the branch is the default', async () => {
    await sidebar.workspaceOpen(workspace.id).click({ button: 'right' })
    await sidebar.workspaceMenuRemove(workspace.id).click()
    await expect(sidebar.removeWorkspaceDialog).toBeVisible()
    await expect(sidebar.removeWorkspaceDeleteBranch).toBeChecked()
  })

  await test.step('Remove: the dialog closes at once, well inside the teardown', async () => {
    await sidebar.removeWorkspaceSubmit.click()
    await expect(sidebar.removeWorkspaceDialog).toHaveCount(0, { timeout: 1_000 })
  })

  await test.step('The row stays with the neutral moving mark and the teardown with its clock', async () => {
    await sidebar.waitForWorkspaceStatus(workspace.id, 'removing', 2_000)
    await expect(sidebar.workspaceStatus(workspace.id)).toHaveClass(/\bworking-mark\b.*\bneutral\b/)
    await expect(sidebar.workspaceStep(workspace.id)).toHaveText(/^running teardown \d+s$/)
    await launched.window.screenshot({ path: 'test-results/remove-workspace.png' })
  })

  await test.step('Once the daemon is done the row goes, and que ws list no longer has it', async () => {
    await expect(sidebar.workspace(workspace.id)).toHaveCount(0, { timeout: 20_000 })
    expect(
      queJson<Workspace[]>(queHome, 'ws', 'list', '--json').some((w) => w.id === workspace.id)
    ).toBe(false)
  })

  await test.step('Its folder is gone from the trash too, the archive in it included', async () => {
    const trash = join(queHome, 'worktrees', '.trash')
    await expect.poll(() => readdirSync(trash), { timeout: 20_000 }).toEqual([])
  })
})
