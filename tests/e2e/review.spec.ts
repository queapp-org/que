// The review journey end to end: a workspace made from the CLI with a file
// edited in its worktree; the top bar's toggle opens the review pane on Changes,
// a full-height column at the window's right edge beside the terminals, which
// stay as they are; clicking the file opens its diff as a tab beside the terminal
// tab (once, however often it is clicked); with the edit and a second file
// committed, the commits menu narrows the list to one commit and back, and the
// base menu compares against another branch; the Files view shows the worktree as
// a tree with an untracked file under a folded directory, opens an unchanged file
// as a read-only tab and a changed one as its diff (a source file numbered, its
// keywords in their syntax colour), collapses a directory, Refresh
// drops a deleted file, and its filter narrows the tree and opens a match; the pane
// drags wider; the pull requests view shows none, then the worktree checks out a
// second branch and each branch gets a pull request (through the fake GitHub CLI),
// the second stacked on the first: Refresh on the list checks them with GitHub and
// both rows show, the first opens in place with its checks and conversation, Refresh
// picks up a new comment, and the second's file opens as a middle tab beside the
// session tab, against the first; a failing check passes on GitHub and Refresh on
// the list shows it, with the tracker's poll an hour away; the app quits and
// relaunches on the same home and the pane, its view, its width, the chosen base,
// the diff tab and the file tab come back; ⌘W closes the diff tab and the file tab,
// the pane closes and opens again on the view it was left on, and Refresh follows a
// pull request to merged; last, a file of comments alone lists under `comments
// only` after the others and its diff opens with its lines dimmed.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Project, Workspace } from '../../src/shared/types'
import {
  fakeCheckRun,
  fakeComment,
  fakeLineComment,
  fakeReview,
  addFakePullRequest,
  setFakePullRequest
} from '../../src/testing/fakes'
import { addBareOrigin, gitIn, makeTempRepo } from '../../src/testing/temp-repo'
import { AppShellPage } from './pages/AppShellPage'
import { ChangesPage } from './pages/ChangesPage'
import { DiffPage } from './pages/DiffPage'
import { FilesPage } from './pages/FilesPage'
import { FileViewPage } from './pages/FileViewPage'
import { PullRequestPage } from './pages/PullRequestPage'
import { ReviewPage } from './pages/ReviewPage'
import { SidebarPage } from './pages/SidebarPage'
import { TerminalPage } from './pages/TerminalPage'
import { type LaunchedApp, launchApp, newQueHome, retryPointer, tempDir } from './utils/app'
import { queJson } from './utils/que'

let launched: LaunchedApp

test.afterEach(async () => {
  await launched?.close() // quits the app AND stops the test daemon
})

test('The review pane lists the changes beside the terminals, opens diffs as tabs, and survives a relaunch', async () => {
  const repo = makeTempRepo(tempDir('que-e2e-repo-'))
  addBareOrigin(repo)
  // The tracker's poll is an hour away here: what the list learns from GitHub, it learns
  // from its Refresh.
  const queHome = newQueHome('pr_poll_seconds = 3600\n[quiet_hours]\nenabled = false\n')
  const prsFile = join(queHome, 'fake-gh-prs.json')
  let project: Project
  let workspace: Workspace
  let shell: AppShellPage
  let sidebar: SidebarPage
  let terminal: TerminalPage
  let review: ReviewPage
  let changes: ChangesPage
  let diff: DiffPage
  let files: FilesPage
  let fileView: FileViewPage
  let pr: PullRequestPage
  let termId = ''
  let capBranch = ''
  let widened = 0
  let sha1 = ''
  let sha2 = ''

  const pages = (): void => {
    shell = new AppShellPage(launched.window)
    sidebar = new SidebarPage(launched.window)
    terminal = new TerminalPage(launched.window)
    review = new ReviewPage(launched.window)
    changes = new ChangesPage(launched.window)
    diff = new DiffPage(launched.window)
    files = new FilesPage(launched.window)
    fileView = new FileViewPage(launched.window)
    pr = new PullRequestPage(launched.window)
  }

  await test.step('A project and a workspace from the CLI', async () => {
    project = queJson<Project>(queHome, 'project', 'add', repo, '--json')
    workspace = queJson<Workspace>(
      queHome,
      'work',
      '--name',
      'APP-1432 retry logic',
      '-r',
      repo,
      '--json'
    )
    expect(workspace.projectId).toBe(project.id)
    capBranch = `${workspace.branch}-cap`
  })

  await test.step('Launch the app and open the workspace', async () => {
    launched = await launchApp({ queHome })
    pages()
    await sidebar.waitForLoad()
    await sidebar.waitForWorkspaceStatus(workspace.id, 'idle')
    await sidebar.workspaceOpen(workspace.id).click()
    termId = await terminal.waitForActiveTerminal()
  })

  await test.step("Edit a file; the rail's Changes icon opens the review pane on Changes beside the terminal", async () => {
    writeFileSync(join(workspace.path, 'README.md'), '# uploader\n\nRetries with backoff.\n')
    await expect(review.root).toHaveCount(0)
    await expect(review.rail).toBeVisible()
    await review.railChanges.click()
    await expect(review.root).toBeVisible()
    await expect(review.root).toHaveAttribute('data-view', 'changes')
    await expect(review.viewChanges).toHaveAttribute('aria-selected', 'true')
    await expect(review.rail).toHaveCount(0)
    expect(await review.state()).toMatchObject({ open: true, view: 'changes', pr: null })
    await expect(terminal.tab(termId)).toBeVisible()
    await expect(terminal.viewport).toBeVisible()
    await expect.poll(async () => (await terminal.panes())[0]?.activeTab).toBe(termId)
    await expect(changes.summary).toHaveText('commits 0 ▾ · vs origin/main ▾ · 1 uncommitted')
    await expect(changes.commits).toHaveText('0')
    await expect(changes.base).toHaveText('origin/main')
    await expect(changes.totals).toContainText('· 1 file')
    await expect(review.changesCount).toHaveText('1')
    await expect(changes.file(0)).toContainText('README.md')
    await expect(changes.fileDirty(0)).toBeVisible()
    await expect(changes.file(0)).toContainText('+2')
    await expect(changes.file(0)).toHaveAttribute('data-path', 'README.md')
  })

  await test.step('The pane runs the full height of the window, like the sidebar', async () => {
    const shellBox = await shell.root.boundingBox()
    const paneBox = await review.root.boundingBox()
    const sidebarBox = await sidebar.root.boundingBox()
    expect(shellBox).not.toBeNull()
    expect(paneBox).not.toBeNull()
    expect(sidebarBox).not.toBeNull()
    expect(paneBox?.y).toBe(0)
    expect(paneBox?.height).toBe(shellBox?.height)
    expect(sidebarBox?.y).toBe(0)
    expect(sidebarBox?.height).toBe(shellBox?.height)
    // The pane sits at the window's right edge; the tab row ends where it begins.
    expect((paneBox?.x ?? 0) + (paneBox?.width ?? 0)).toBe(
      (shellBox?.x ?? 0) + (shellBox?.width ?? 0)
    )
    const rowBox = await terminal.pane(0).tabbar.boundingBox()
    expect((rowBox?.x ?? 0) + (rowBox?.width ?? 0)).toBeLessThanOrEqual(paneBox?.x ?? 0)
  })

  await test.step('The tab row is the first row: 40px, in line with the review bar, controls at its end', async () => {
    const rowBox = await terminal.pane(0).tabbar.boundingBox()
    const barBox = await review.bar.boundingBox()
    const controlsBox = await terminal.pane(0).controls.boundingBox()
    expect(rowBox?.y).toBe(0)
    expect(rowBox?.height).toBe(40)
    expect(barBox?.y).toBe(rowBox?.y)
    expect(barBox?.height).toBe(rowBox?.height)
    // The split buttons sit at the row's right end, the main column's top-right corner; the
    // review pane's hide chevron ends its own strip.
    await expect(terminal.pane(0).controls).toBeVisible()
    await expect(review.hide).toBeVisible()
    expect((controlsBox?.x ?? 0) + (controlsBox?.width ?? 0)).toBeGreaterThan(
      (rowBox?.x ?? 0) + (rowBox?.width ?? 0) - 16
    )
    await launched.window.screenshot({ path: 'test-results/main-row.png' })
  })

  await test.step('Clicking the file opens its diff as a tab beside the terminal tab', async () => {
    await changes.file(0).click()
    await expect(diff.tab('README.md')).toHaveAttribute('data-active', 'true')
    await expect(terminal.pane(0).diffTabs).toHaveCount(1)
    await expect(terminal.tab(termId)).toBeVisible()
    await expect(diff.root).toHaveAttribute('data-path', 'README.md')
    await expect(diff.header).toContainText('README.md')
    await expect(diff.additions).toHaveText('+2')
    await expect(diff.deletions).toHaveText('−0')
    // The whole file, numbered: the old first line, then the two added under it.
    await expect(diff.lineNumbers).toHaveText(['1', '2', '3'])
    await expect(diff.patch).toContainText('+Retries with backoff.')
    await expect(changes.file(0)).toHaveAttribute('data-active', 'true')
    await expect
      .poll(async () => (await terminal.panes())[0]?.activeTab)
      .toBe('view:diff:README.md')
    await launched.window.screenshot({ path: 'test-results/review-changes.png' })
  })

  await test.step('Back on the terminal, the file again focuses the same diff tab', async () => {
    await terminal.tabSelect(termId).click()
    await expect(terminal.viewport).toBeVisible()
    await expect(changes.file(0)).toHaveAttribute('data-active', 'false')
    await changes.file(0).click()
    await expect(diff.tabs).toHaveCount(1)
    await expect(diff.tab('README.md')).toHaveAttribute('data-active', 'true')
    await expect(diff.patch).toContainText('+Retries with backoff.')
  })

  await test.step('Two commits: the summary counts them and the list shows both files', async () => {
    gitIn(workspace.path, 'add', 'README.md')
    gitIn(workspace.path, 'commit', '--quiet', '-m', 'Document retries')
    writeFileSync(join(workspace.path, 'NOTES.md'), '# notes\n\nBackoff caps at 30s.\n')
    gitIn(workspace.path, 'add', 'NOTES.md')
    gitIn(workspace.path, 'commit', '--quiet', '-m', 'Add notes')
    sha2 = gitIn(workspace.path, 'rev-parse', 'HEAD')
    sha1 = gitIn(workspace.path, 'rev-parse', 'HEAD~1')
    // No Refresh: the daemon watches the worktree, and the commits reach Changes on their own.
    await expect(changes.summary).toHaveText('commits 2 ▾ · vs origin/main ▾')
    await expect(changes.totals).toContainText('· 2 files')
    await expect(changes.fileDirty(0)).toHaveCount(0)
    await expect(changes.file(0)).toHaveAttribute('data-path', 'NOTES.md')
    await expect(changes.file(1)).toHaveAttribute('data-path', 'README.md')
    await expect(changes.file(2)).toHaveCount(0)
  })

  await test.step('The Commits menu narrows the list to one commit, and All commits restores it', async () => {
    await changes.commitsMenu.click()
    await expect(changes.commitItems).toHaveCount(3)
    await expect(changes.commitItems.nth(0)).toHaveAttribute('data-testid', 'changes-commit-all')
    await expect(changes.commitAll).toHaveAttribute('aria-checked', 'true')
    await expect(changes.commitItems.nth(1)).toHaveAttribute(
      'data-testid',
      `changes-commit-${sha2}`
    )
    await expect(changes.commitItems.nth(2)).toHaveAttribute(
      'data-testid',
      `changes-commit-${sha1}`
    )
    await expect(changes.commit(sha2)).toContainText(`${sha2.slice(0, 7)} Add notes`)
    await expect(changes.commit(sha1)).toContainText(`${sha1.slice(0, 7)} Document retries`)
    await expect(changes.commit(sha1)).toHaveAttribute('aria-checked', 'false')
    await changes.commit(sha1).click()
    await expect(changes.commitItems).toHaveCount(0)
    await expect(changes.summary).toHaveText(`commit ${sha1.slice(0, 7)} ▾ · vs origin/main ▾`)
    await expect(changes.commits).toHaveText(sha1.slice(0, 7))
    await expect(changes.file(0)).toHaveAttribute('data-path', 'README.md')
    await expect(changes.file(1)).toHaveCount(0)
    await expect(diff.tab('README.md')).toHaveAttribute('data-active', 'true')
    await expect(diff.patch).toContainText('+Retries with backoff.')
    await changes.commitsMenu.click()
    await expect(changes.commit(sha1)).toHaveAttribute('aria-checked', 'true')
    await changes.commitAll.click()
    await expect(changes.summary).toHaveText('commits 2 ▾ · vs origin/main ▾')
    await expect(changes.file(0)).toHaveAttribute('data-path', 'NOTES.md')
    await expect(changes.file(1)).toHaveAttribute('data-path', 'README.md')
  })

  await test.step('The base menu compares against another branch', async () => {
    gitIn(repo, 'branch', 'release', sha1)
    await changes.refresh.click()
    await changes.baseMenu.click()
    await expect(changes.baseOption(0)).toHaveAttribute('data-ref', 'origin/main')
    await expect(changes.baseOption(0)).toHaveAttribute('aria-checked', 'true')
    await expect(changes.baseRef('main')).toHaveAttribute('aria-checked', 'false')
    await expect(changes.baseRef('release')).toHaveAttribute('aria-checked', 'false')
    await launched.window.screenshot({ path: 'test-results/changes-menus.png' })
    await changes.baseRef('release').click()
    await expect(changes.baseOptions).toHaveCount(0)
    await expect(changes.summary).toHaveText('commits 1 ▾ · vs release ▾')
    await expect(changes.base).toHaveText('release')
    await expect(changes.file(0)).toHaveAttribute('data-path', 'NOTES.md')
    await expect(changes.file(1)).toHaveCount(0)
  })

  await test.step('An untracked file: the Files view shows the tree, changed files marked', async () => {
    mkdirSync(join(workspace.path, 'src/upload'), { recursive: true })
    writeFileSync(join(workspace.path, 'src/upload/retry.ts'), 'export const retries = 3\n')
    // No Refresh: the write reaches Changes through the watcher, so the tree opens knowing it.
    await expect(changes.file(1)).toHaveAttribute('data-path', 'src/upload/retry.ts')
    await review.viewFiles.click()
    await expect(review.root).toHaveAttribute('data-view', 'files')
    await expect(review.viewFiles).toHaveAttribute('aria-selected', 'true')
    await expect(review.viewChanges).toHaveAttribute('aria-selected', 'false')
    expect(await review.state()).toMatchObject({ open: true, view: 'files' })
    await expect(files.summary).toHaveText('4 · 2 changed')
    await expect(files.count).toHaveText('4')
    await expect(files.rows).toHaveCount(5)
    // Directories first, the one-entry chain folded into one row, open because it holds a change.
    await expect(files.row(0)).toHaveAttribute('data-path', 'src/upload')
    await expect(files.row(0)).toHaveAttribute('data-kind', 'dir')
    await expect(files.row(0)).toHaveAttribute('aria-expanded', 'true')
    await expect(files.row(0)).toHaveAttribute('aria-level', '1')
    await expect(files.row(0)).toContainText('src/upload')
    await expect(files.rowCount(0)).toHaveText('1')
    await expect(files.row(1)).toHaveAttribute('data-path', 'src/upload/retry.ts')
    await expect(files.row(1)).toHaveAttribute('data-kind', 'file')
    await expect(files.row(1)).toHaveAttribute('aria-level', '2')
    await expect(files.row(1)).toContainText('retry.ts?')
    // Then the root files, case-insensitively: README.md after que.toml.
    await expect(files.row(2)).toHaveAttribute('data-path', 'NOTES.md')
    await expect(files.row(2)).toHaveAttribute('aria-level', '1')
    await expect(files.row(2)).toContainText('NOTES.mdA')
    await expect(files.row(3)).toHaveAttribute('data-path', 'que.toml')
    await expect(files.row(3)).toHaveText('que.toml')
    await expect(files.row(4)).toHaveAttribute('data-path', 'README.md')
    await expect(files.row(4)).toHaveText('README.md')
    await expect(terminal.tab(termId)).toBeVisible()
  })

  await test.step('An unchanged file opens as a read-only tab; a changed one opens its diff', async () => {
    await files.rowByPath('que.toml').click()
    await expect(fileView.tab('que.toml')).toHaveAttribute('data-active', 'true')
    await expect(fileView.tabs).toHaveCount(1)
    await expect(terminal.tab(termId)).toBeVisible()
    await expect.poll(async () => (await terminal.panes())[0]?.activeTab).toBe('view:file:que.toml')
    await expect(fileView.root('que.toml')).toBeVisible()
    await expect(fileView.header).toHaveText('que.toml')
    // The line number, then the line.
    await expect(fileView.text).toHaveText('1setup = "true"')
    await expect(files.rowByPath('que.toml')).toHaveAttribute('data-active', 'true')
    await files.rowByPath('que.toml').click()
    await expect(fileView.tabs).toHaveCount(1)
    await files.rowByPath('NOTES.md').click()
    await expect(diff.tab('NOTES.md')).toHaveAttribute('data-active', 'true')
    await expect(diff.patch).toContainText('+Backoff caps at 30s.')
    await expect(fileView.tab('NOTES.md')).toHaveCount(0)
    await expect(files.rowByPath('NOTES.md')).toHaveAttribute('data-active', 'true')
    await expect(files.rowByPath('que.toml')).toHaveAttribute('data-active', 'false')
    // Closing the diff tab selects its neighbour, the file tab.
    await diff.tabClose('NOTES.md').click()
    await expect(diff.tabs).toHaveCount(1)
    await expect(fileView.tab('que.toml')).toHaveAttribute('data-active', 'true')
    await expect(fileView.text).toHaveText('1setup = "true"')
    await launched.window.screenshot({ path: 'test-results/files-tab.png' })
  })

  await test.step('A changed source file opens numbered, its keywords in their syntax colour', async () => {
    await files.rowByPath('src/upload/retry.ts').click()
    await expect(diff.tab('src/upload/retry.ts')).toHaveAttribute('data-active', 'true')
    await expect(diff.lineNumbers).toHaveText(['1'])
    // `const` is a declaration: --syn-decl, #569cd6.
    await expect(diff.token('const')).toHaveCSS('color', 'rgb(86, 156, 214)')
    await expect(diff.token('3')).toHaveCSS('color', 'rgb(181, 206, 168)')
    await launched.window.screenshot({ path: 'test-results/diff-syntax.png' })
    await diff.tabClose('src/upload/retry.ts').click()
    await expect(diff.tabs).toHaveCount(1)
    await expect(fileView.tab('que.toml')).toHaveAttribute('data-active', 'true')
  })

  await test.step('A directory row collapses and opens again', async () => {
    await files.rowByPath('src/upload').click()
    await expect(files.rowByPath('src/upload')).toHaveAttribute('aria-expanded', 'false')
    await expect(files.rowByPath('src/upload/retry.ts')).toHaveCount(0)
    await expect(files.rows).toHaveCount(4)
    await files.rowByPath('src/upload').click()
    await expect(files.rowByPath('src/upload')).toHaveAttribute('aria-expanded', 'true')
    await expect(files.row(1)).toHaveAttribute('data-path', 'src/upload/retry.ts')
  })

  await test.step('Refresh drops a deleted file and its directory', async () => {
    rmSync(join(workspace.path, 'src'), { recursive: true })
    await files.refresh.click()
    await expect(files.rowByPath('src/upload')).toHaveCount(0)
    await expect(files.count).toHaveText('3')
    await expect(files.summary).toHaveText('3 · 1 changed')
    await expect(files.row(0)).toHaveAttribute('data-path', 'NOTES.md')
    await expect(fileView.tab('que.toml')).toHaveAttribute('data-active', 'true')
    await expect(fileView.text).toHaveText('1setup = "true"')
  })

  await test.step('The filter narrows the tree to the matches, Enter opens the first, Escape clears it', async () => {
    await files.filter.fill('notes')
    await expect(files.rows).toHaveCount(1)
    await expect(files.row(0)).toHaveAttribute('data-path', 'NOTES.md')
    await expect(files.filterHint).toHaveText('1 match · ⏎ opens')
    await files.filter.press('Enter')
    await expect(diff.tab('NOTES.md')).toHaveAttribute('data-active', 'true')
    await expect(diff.patch).toContainText('+Backoff caps at 30s.')
    await expect(terminal.tab(termId)).toBeVisible()
    await launched.window.screenshot({ path: 'test-results/files-filter.png' })
    await files.filter.press('Escape')
    await expect(files.filter).toHaveValue('')
    await expect(files.rows).toHaveCount(3)
    await expect(files.filterHint).toHaveCount(0)
    await diff.tabClose('NOTES.md').click()
    await expect(diff.tabs).toHaveCount(1)
  })

  await test.step('Dragging the resizer 80px left widens the pane by about 80px', async () => {
    expect((await review.state()).width).toBe(320)
    await retryPointer(async () => {
      // A drag cut short leaves the pane part way, so each attempt answers for its own 80px.
      const before = (await review.state()).width
      const box = await review.resizer.boundingBox()
      expect(box).not.toBeNull()
      const { x, y, width, height } = box as { x: number; y: number; width: number; height: number }
      await launched.window.mouse.move(x + width / 2, y + height / 2)
      await launched.window.mouse.down()
      await launched.window.mouse.move(x + width / 2 - 80, y + height / 2, { steps: 6 })
      await launched.window.mouse.up()
      await expect
        .poll(async () => (await review.state()).width)
        .toBeGreaterThanOrEqual(before + 76)
      widened = (await review.state()).width
      expect(widened).toBeLessThanOrEqual(before + 84)
      await expect(review.resizer).toHaveAttribute('aria-valuenow', String(widened))
    })
    await launched.window.screenshot({ path: 'test-results/review-pane.png' })
  })

  await test.step('The pull requests view: none from this session yet', async () => {
    await review.viewPrs.click()
    await expect(review.root).toHaveAttribute('data-view', 'prs')
    await expect(review.viewPrs).toHaveAttribute('aria-selected', 'true')
    await expect(review.viewFiles).toHaveAttribute('aria-selected', 'false')
    await expect(review.hide).toBeVisible()
    await expect(pr.empty).toHaveText('No pull requests from this session yet.')
    await expect(review.prsCount).toHaveText('0')
    expect(await review.state()).toMatchObject({ open: true, view: 'prs', pr: null })
    await expect(diff.tab('README.md')).toBeVisible()
  })

  await test.step('The worktree checks out a second branch; a pull request on each: Refresh on the list shows both rows', async () => {
    // A second branch with its own commit, checked out long enough for the daemon to keep it.
    gitIn(workspace.path, 'checkout', '--quiet', '-b', capBranch)
    writeFileSync(join(workspace.path, 'CAP.md'), '# cap\n\nThirty seconds at most.\n')
    gitIn(workspace.path, 'add', 'CAP.md')
    gitIn(workspace.path, 'commit', '--quiet', '-m', 'Cap the backoff')
    await expect
      .poll(
        () =>
          queJson<Workspace[]>(queHome, 'ws', 'list', '--json').find((w) => w.id === workspace.id)
            ?.branches,
        { timeout: 15_000 }
      )
      .toContain(capBranch)
    gitIn(workspace.path, 'checkout', '--quiet', workspace.branch)
    setFakePullRequest(prsFile, workspace.branch, {
      number: 7,
      url: 'https://github.com/rquellh/que/pull/7',
      title: 'Add retry logic',
      isDraft: false,
      baseRefName: 'main',
      headRefName: workspace.branch,
      reviewDecision: 'CHANGES_REQUESTED',
      updatedAt: '2026-10-14T03:05:00Z',
      additions: 4,
      deletions: 0,
      statusCheckRollup: [
        fakeCheckRun({ name: 'build' }),
        fakeCheckRun({
          name: 'lint',
          conclusion: 'FAILURE',
          detailsUrl: 'https://github.com/rquellh/que/actions/runs/42'
        })
      ],
      comments: [
        fakeComment({
          author: 'reviewer',
          body: 'Looks close. One nit below.',
          createdAt: '2026-10-14T03:00:00Z'
        })
      ],
      reviews: [
        fakeReview({
          author: 'reviewer',
          state: 'CHANGES_REQUESTED',
          body: 'Please add a test for the retry cap.',
          submittedAt: '2026-10-14T03:02:00Z'
        })
      ],
      lineComments: [
        fakeLineComment({
          author: 'reviewer',
          body: 'Backoff should be capped.',
          path: 'README.md',
          line: 3,
          createdAt: '2026-10-14T03:01:00Z'
        })
      ]
    })
    addFakePullRequest(prsFile, capBranch, {
      number: 8,
      url: 'https://github.com/rquellh/que/pull/8',
      title: 'Cap the backoff',
      isDraft: false,
      baseRefName: workspace.branch,
      headRefName: capBranch,
      updatedAt: '2026-10-14T03:06:00Z',
      additions: 3,
      deletions: 0,
      statusCheckRollup: [fakeCheckRun({ name: 'build' })]
    })
    await expect(pr.empty).toBeVisible()
    await pr.refresh.click()
    await expect(pr.activeRows).toHaveCount(2, { timeout: 15_000 })
    // Newest first, aligned; the second is stacked on the first.
    await expect(pr.activeRows.nth(0)).toHaveAttribute('data-testid', 'pr-row-8')
    await expect(pr.activeRows.nth(1)).toHaveAttribute('data-testid', 'pr-row-7')
    await expect(pr.row(8)).toContainText('#8Cap the backoff')
    await expect(pr.rowMeta(8)).toHaveText('into #7✓ 1/1+3 −0')
    await expect(pr.row(7)).toContainText('#7Add retry logic')
    await expect(pr.rowMeta(7)).toHaveText('into main✗ lint · 1/2+4 −0')
    await expect(pr.listSummary).toHaveText('2 open · 1 failing')
    await expect(review.prsCount).toHaveText('2')
    await expect(pr.rowComments(7)).toContainText('3')
    await expect(pr.rowComments(7)).toHaveAttribute('data-new', 'true')
    await launched.window.screenshot({ path: 'test-results/review-pull-requests.png' })
  })

  await test.step('#7 opens in place: its files, checks and conversation; the strip is its back link', async () => {
    await pr.row(7).click()
    await expect(review.root).toHaveAttribute('data-pr', '7')
    await expect(review.back).toHaveText('‹ #7')
    await expect(review.viewPrs).toHaveCount(0)
    expect(await review.state()).toMatchObject({ open: true, view: 'prs', pr: 7 })
    await expect(pr.title).toHaveText('Add retry logic')
    await expect(pr.meta).toHaveText('open#7 ↗into main')
    await expect(pr.headerLink).toHaveAttribute('href', 'https://github.com/rquellh/que/pull/7')
    await expect(pr.filesSummary).toContainText('· 2 · vs main')
    await expect(pr.file(0)).toHaveAttribute('data-path', 'NOTES.md')
    await expect(pr.file(1)).toHaveAttribute('data-path', 'README.md')
    await expect(pr.checksSummary).toHaveText('1 failing · 1 passing')
    await expect(pr.check(0)).toHaveAttribute('data-state', 'failing')
    await expect(pr.check(0)).toContainText('lint')
    await expect(pr.checkLink(0)).toHaveAttribute(
      'href',
      'https://github.com/rquellh/que/actions/runs/42'
    )
    await expect(pr.checksPassing).toHaveText('1 passing · build')
    await pr.checksPassing.click()
    await expect(pr.checksPassing).toHaveText('1 passing')
    await expect(pr.check(1)).toHaveAttribute('data-state', 'passing')
    await expect(pr.check(1)).toContainText('build')
    await expect(pr.commentsCount).toHaveText('3 · changes requested')
    // Oldest first: the comment, the line comment, then the review.
    await expect(pr.comment(0)).toHaveAttribute('data-kind', 'comment')
    await expect(pr.comment(0)).toContainText('Looks close. One nit below.')
    await expect(pr.comment(1)).toHaveAttribute('data-kind', 'line')
    await expect(pr.commentPath(1)).toHaveText('README.md:3 →')
    await expect(pr.comment(1)).toContainText('Backoff should be capped.')
    await expect(pr.comment(2)).toHaveAttribute('data-kind', 'review')
    await expect(pr.comment(2)).toContainText('changes requested')
    await expect(pr.comment(2)).toContainText('Please add a test for the retry cap.')
    await launched.window.screenshot({ path: 'test-results/review-pull-request-filled.png' })
  })

  await test.step('Refresh fetches the conversation again and shows a new comment', async () => {
    setFakePullRequest(prsFile, workspace.branch, {
      number: 7,
      comments: [
        fakeComment({
          author: 'reviewer',
          body: 'Looks close. One nit below.',
          createdAt: '2026-10-14T03:00:00Z'
        }),
        fakeComment({
          author: 'author',
          body: 'Capped it; test added.',
          createdAt: '2026-10-14T03:10:00Z'
        })
      ]
    })
    await pr.refresh.click()
    await expect(pr.comment(3)).toContainText('Capped it; test added.')
    await expect(pr.comment(3)).toHaveAttribute('data-kind', 'comment')
  })

  await test.step("Back to the list; #8's file opens as a middle tab beside the session tab, against #7", async () => {
    await review.back.click()
    await expect(review.root).not.toHaveAttribute('data-pr')
    await expect(pr.rowComments(7)).toHaveAttribute('data-new', 'false')
    await pr.row(8).click()
    await expect(review.back).toHaveText('‹ #8')
    await expect(pr.filesSummary).toHaveText('+3 −0 · 1 · vs #7')
    await expect(pr.file(0)).toHaveAttribute('data-path', 'CAP.md')
    await pr.file(0).click()
    await expect(diff.prTab(8, 'CAP.md')).toHaveAttribute('data-active', 'true')
    await expect
      .poll(async () => (await terminal.panes())[0]?.activeTab)
      .toBe(`view:diff:${capBranch}\0${workspace.branch}\0CAP.md`)
    await expect(terminal.tab(termId)).toBeVisible()
    await expect(diff.tab('README.md')).toBeVisible()
    await expect(diff.against).toHaveText('#8 vs #7')
    await expect(diff.header).toContainText('CAP.md')
    await expect(diff.additions).toHaveText('+3')
    await expect(diff.patch).toContainText('+Thirty seconds at most.')
    await expect(pr.file(0)).toHaveAttribute('data-active', 'true')
    await launched.window.screenshot({ path: 'test-results/review-pr-diff.png' })
    await diff.prTabClose(8, 'CAP.md').click()
    await expect(diff.tabs).toHaveCount(1)
    await review.back.click()
    await expect(pr.list).toBeVisible()
  })

  await test.step("#7's lint passes on a rerun; Refresh on the list checks GitHub and the row shows it", async () => {
    await expect(pr.rowMeta(7)).toHaveText('into main✗ lint · 1/2+4 −0')
    setFakePullRequest(prsFile, workspace.branch, {
      number: 7,
      statusCheckRollup: [fakeCheckRun({ name: 'build' }), fakeCheckRun({ name: 'lint' })]
    })
    await pr.refresh.click()
    await expect(pr.rowMeta(7)).toHaveText('into main✓ 2/2+4 −0')
    await expect(pr.listSummary).toHaveText('2 open')
    await expect(pr.refresh).toHaveAttribute('aria-busy', 'false')
    await expect(pr.checkError).toHaveCount(0)
    await launched.window.screenshot({ path: 'test-results/review-prs-refreshed.png' })
  })

  await test.step('Back on the Files view with the diff tab selected, before the quit', async () => {
    await review.viewFiles.click()
    await expect(review.root).toHaveAttribute('data-view', 'files')
    await diff.tabSelect('README.md').click()
    await expect(diff.tab('README.md')).toHaveAttribute('data-active', 'true')
    await expect(fileView.tab('que.toml')).toHaveAttribute('data-active', 'false')
  })

  await test.step('Quit the app; relaunch on the same home: the pane, the diff tab and the file tab come back', async () => {
    await launched.app.close() // the app only, NOT launched.close(), which also stops the daemon
    launched = await launchApp({ queHome: launched.queHome })
    pages()
    await sidebar.waitForLoad()
    await sidebar.workspaceOpen(workspace.id).click()
    await expect(review.root).toHaveAttribute('data-view', 'files')
    expect(await review.state()).toEqual({ open: true, view: 'files', pr: null, width: widened })
    await expect(files.summary).toHaveText('3 · 1 changed')
    await expect(fileView.tab('que.toml')).toHaveAttribute('data-active', 'false')
    await expect(terminal.pane(0).diffTabs).toHaveCount(1)
    await expect(diff.tab('README.md')).toHaveAttribute('data-active', 'true')
    await review.viewPrs.click()
    await expect(review.root).toHaveAttribute('data-view', 'prs')
    expect(await review.state()).toEqual({ open: true, view: 'prs', pr: null, width: widened })
    await expect(pr.activeRows).toHaveCount(2)
    // The base chosen before the quit is remembered: README.md is unchanged against it.
    await review.viewChanges.click()
    await expect(changes.base).toHaveText('release')
    await expect(changes.summary).toHaveText('commits 1 ▾ · vs release ▾')
    await expect(diff.empty).toHaveText('No changes in README.md')
    await changes.baseMenu.click()
    await expect(changes.baseRef('release')).toHaveAttribute('aria-checked', 'true')
    await changes.baseRef('origin/main').click()
    await expect(changes.summary).toHaveText('commits 2 ▾ · vs origin/main ▾')
    await expect(diff.patch).toContainText('+Retries with backoff.')
    await expect(terminal.tab(termId)).toBeVisible()
    await review.viewPrs.click()
    await expect(review.root).toHaveAttribute('data-view', 'prs')
    // The file tab came back too and still shows the file.
    await fileView.tabSelect('que.toml').click()
    await expect(fileView.tab('que.toml')).toHaveAttribute('data-active', 'true')
    await expect(fileView.text).toHaveText('1setup = "true"')
  })

  await test.step('⌘W closes the selected diff tab; the terminal tab is active again', async () => {
    await diff.tabSelect('README.md').click()
    await launched.window.keyboard.press('Meta+w')
    await expect(diff.tabs).toHaveCount(0)
    await expect(diff.root).toHaveCount(0)
    await expect.poll(async () => (await terminal.panes())[0]?.activeTab).toBe(termId)
    await expect(terminal.viewport).toBeVisible()
    await expect(terminal.tab(termId)).toBeVisible()
    await expect(fileView.tab('que.toml')).toBeVisible()
  })

  await test.step('⌘W closes the selected file tab too', async () => {
    await fileView.tabSelect('que.toml').click()
    await expect(fileView.root('que.toml')).toBeVisible()
    await launched.window.keyboard.press('Meta+w')
    await expect(fileView.tabs).toHaveCount(0)
    await expect(fileView.root('que.toml')).toHaveCount(0)
    await expect.poll(async () => (await terminal.panes())[0]?.activeTab).toBe(termId)
    await expect(terminal.viewport).toBeVisible()
  })

  await test.step('The hide chevron folds the pane to a full-height 40px rail; show opens it again on the view it was left on', async () => {
    await review.hide.click()
    await expect(review.root).toHaveCount(0)
    await expect(review.resizer).toHaveCount(0)
    await expect(review.rail).toBeVisible()
    const shellBox = await shell.root.boundingBox()
    const railBox = await review.rail.boundingBox()
    const showBox = await review.show.boundingBox()
    expect(railBox?.y).toBe(0)
    expect(railBox?.width).toBe(40)
    expect(railBox?.height).toBe(shellBox?.height)
    expect((railBox?.x ?? 0) + (railBox?.width ?? 0)).toBe(
      (shellBox?.x ?? 0) + (shellBox?.width ?? 0)
    )
    // The show chevron sits in the strip row, in line with the tab row.
    expect(showBox?.y ?? 40).toBeLessThan(40)
    await launched.window.screenshot({ path: 'test-results/review-rail.png' })
    await review.show.click()
    await expect(review.root).toHaveAttribute('data-view', 'prs')
    await expect(review.rail).toHaveCount(0)
  })

  await test.step('⌘B folds the pane to the rail; the show chevron opens it again, then Changes', async () => {
    await launched.window.keyboard.press('Meta+b')
    await expect(review.root).toHaveCount(0)
    expect((await review.state()).open).toBe(false)
    await expect(review.rail).toBeVisible()
    await review.show.click()
    await review.viewChanges.click()
    await expect(review.root).toHaveAttribute('data-view', 'changes')
    await expect(changes.file(1)).toContainText('README.md')
    expect(await review.state()).toEqual({ open: true, view: 'changes', pr: null, width: widened })
  })

  await test.step('Refresh follows #7 to merged, under the rule', async () => {
    await review.viewPrs.click()
    await expect(pr.activeRows).toHaveCount(2)
    setFakePullRequest(prsFile, workspace.branch, {
      number: 7,
      state: 'MERGED',
      mergedAt: '2026-10-14T03:30:00Z',
      updatedAt: '2026-10-14T03:30:00Z'
    })
    await pr.refresh.click()
    await expect(pr.row(7)).toHaveAttribute('data-state', 'merged', { timeout: 15_000 })
    await expect(pr.settledLabel).toHaveText('[ merged · closed ]')
    await expect(pr.settledRows).toHaveCount(1)
    await expect(pr.activeRows).toHaveCount(1)
    await expect(pr.listSummary).toHaveText('1 open')
  })

  await test.step('A file of comments alone lists last under comments only, and its diff opens dimmed', async () => {
    writeFileSync(
      join(workspace.path, 'backoff.ts'),
      '// Backoff doubles from 250ms.\n// It caps at thirty seconds.\n'
    )
    await review.viewChanges.click()
    // The daemon lists the file as code first, then again once it has read its comments.
    await expect(changes.commentOnly).toHaveText('comments only · 1 file · +2 −0')
    await expect(changes.commentOnly.locator('+ [data-testid^="changes-file-"]')).toHaveAttribute(
      'data-path',
      'backoff.ts'
    )
    await changes.fileByPath('backoff.ts').click()
    await expect(diff.tab('backoff.ts')).toHaveAttribute('data-active', 'true')
    await expect(diff.commentsButton).toHaveText('Comments dimmed ▾')
    await expect(diff.commentCounts).toHaveText(/^\+2\s*comments$/)
    await expect(diff.additions).toHaveCount(0)
    await expect(diff.commentLines).toHaveCount(2)
    await launched.window.screenshot({ path: 'test-results/diff-comments-dimmed.png' })
  })
})
