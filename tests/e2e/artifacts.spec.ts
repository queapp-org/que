// A page a session publishes reaches the review pane: the fake claude reports an Artifact call
// through the real `que hook`, the Artifacts icon counts it, a click anywhere on the row goes to
// the browser through the main process's filter (under e2e it records the link instead), and the
// daemon's answer turns the row to opened. Only here does the row's layering meet a real hit test.
import { expect, test } from '@playwright/test'
import type { StatusJson } from '../../src/cli/workspaces'
import type { Workspace } from '../../src/shared/types'
import { makeTempRepo } from '../../src/testing/temp-repo'
import { ArtifactsPage } from './pages/ArtifactsPage'
import { ReviewPage } from './pages/ReviewPage'
import { SidebarPage } from './pages/SidebarPage'
import { TerminalPage } from './pages/TerminalPage'
import { type LaunchedApp, launchApp, newQueHome, retryPointer, tempDir } from './utils/app'
import { stubClipboard } from './utils/helpers'
import { queJson } from './utils/que'

const PAGE_ID = 'Bo2pUji8XumREbCYMXcoMe'
const PAGE_URL = `https://claude.ai/artifact/${PAGE_ID}`
const NEXT_ID = 'TwctxBY9BjGWgdjZVh2Zb2'
const NEXT_URL = `https://claude.ai/artifact/${NEXT_ID}`

// The --fg and --fg-secondary tokens, as the browser computes them.
const UNOPENED = 'rgb(238, 238, 238)'
const OPENED = 'rgb(201, 201, 201)'

let launched: LaunchedApp

test.afterEach(async () => {
  await launched?.close() // quits the app AND stops the test daemon
})

test('a published page is counted, listed, opened in the browser, and then reads as opened', async () => {
  const queHome = newQueHome()
  const repo = makeTempRepo(tempDir('que-e2e-repo-'))
  let workspace: Workspace
  let sidebar: SidebarPage
  let terminal: TerminalPage
  let review: ReviewPage
  let artifacts: ArtifactsPage
  let termId = ''
  let clipboardWrites: () => Promise<string[]>

  await test.step('A project and a workspace from the CLI; the app opens it', async () => {
    queJson(queHome, 'project', 'add', repo, '--json')
    workspace = queJson<Workspace>(
      queHome,
      'work',
      '--name',
      'APP-1432 retry',
      '-r',
      repo,
      '--json'
    )
    launched = await launchApp({ queHome })
    sidebar = new SidebarPage(launched.window)
    terminal = new TerminalPage(launched.window)
    review = new ReviewPage(launched.window)
    artifacts = new ArtifactsPage(launched.window)
    clipboardWrites = await stubClipboard(launched.window)
    await sidebar.waitForLoad()
    await sidebar.workspaceOpen(workspace.id).click()
    termId = await terminal.waitForActiveTerminal()
    await expect(review.railArtifactsCount).toHaveText('0')
  })

  await test.step('The session publishes a page; the Artifacts icon on the rail counts it', async () => {
    await terminal.writeTo(termId, 'claude\r')
    await expect
      .poll(
        () =>
          queJson<StatusJson>(queHome, 'status', '--json').workspaces.find(
            (w) => w.id === workspace.id
          )?.sessionId ?? null,
        { message: 'no session reported', timeout: 30_000 }
      )
      .toMatch(/^[0-9a-f-]{36}$/)
    await terminal.writeTo(termId, `/artifact ${PAGE_URL} Upload retries\r`)
    await expect(review.railArtifactsCount).toHaveText('1', { timeout: 15_000 })
  })

  await test.step('The icon opens the view: the head counts it and the row lists it, unopened', async () => {
    await review.railArtifacts.click()
    await expect(review.root).toHaveAttribute('data-view', 'artifacts')
    await expect(review.viewArtifacts).toHaveAttribute('aria-selected', 'true')
    await expect(review.artifactsCount).toHaveText('1')
    await expect(artifacts.summary).toHaveText('1 published')
    await expect(artifacts.rowLink(PAGE_ID)).toHaveText('Upload retries')
    await expect(artifacts.rowAge(PAGE_ID)).toHaveText(/^\d+[smhd]$/)
    await expect(artifacts.row(PAGE_ID)).toHaveAttribute('data-opened', 'false')
    await expect(artifacts.rowLink(PAGE_ID)).toHaveCSS('color', UNOPENED)
  })

  await test.step('Copy shows under the pointer, copies, and opens nothing', async () => {
    await expect(artifacts.rowCopy(PAGE_ID)).toHaveCSS('opacity', '0')
    await retryPointer(async () => {
      await artifacts.row(PAGE_ID).hover()
      await expect(artifacts.rowCopy(PAGE_ID)).toHaveCSS('opacity', '1', { timeout: 2_000 })
    })
    await artifacts.rowCopy(PAGE_ID).click()
    await expect.poll(clipboardWrites).toEqual([PAGE_URL])
    expect(await launched.externalOpens()).toEqual([])
    await expect(artifacts.row(PAGE_ID)).toHaveAttribute('data-opened', 'false')
  })

  await test.step('A click on the row, past the title, goes to the browser and marks it opened', async () => {
    await artifacts.row(PAGE_ID).click()
    await expect.poll(() => launched.externalOpens()).toEqual([PAGE_URL])
    await expect(artifacts.row(PAGE_ID)).toHaveAttribute('data-opened', 'true')
    await expect(artifacts.rowLink(PAGE_ID)).toHaveCSS('color', OPENED)
  })

  await test.step('A click at the far end of the row, over the age, opens it too', async () => {
    await artifacts.row(PAGE_ID).click({ position: { x: 280, y: 10 } })
    await expect.poll(() => launched.externalOpens()).toEqual([PAGE_URL, PAGE_URL])
  })

  await test.step('Another page arrives live, unopened, above the opened one', async () => {
    await terminal.writeTo(termId, `/artifact ${NEXT_URL} Sidebar background-task mocks\r`)
    await expect(artifacts.summary).toHaveText('2 published', { timeout: 15_000 })
    await expect(review.artifactsCount).toHaveText('2')
    await expect(artifacts.row(NEXT_ID)).toHaveAttribute('data-opened', 'false')
    await expect(artifacts.row(PAGE_ID)).toHaveAttribute('data-opened', 'true')
    await review.root.screenshot({ path: 'test-results/artifacts-pane.png' })
  })
})
