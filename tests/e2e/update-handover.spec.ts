// The launch after an update: a real daemon on an older build, and the real app starting
// against it. Without a marker (an upgrade installed by hand) it offers Restart and leaves the
// daemon alone; with the marker a clicked Restart leaves, it hands the terminals over by
// itself. The installer that writes the marker can't run here; update-install.test.ts owns it.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { restartMarkerPath, writeRestartMarker } from '../../src/main/update-install'
import { resolveRuntime } from '../../src/shared/client'
import type { TermInfo } from '../../src/shared/protocol'
import { bundleEntry } from '../../src/testing/bundle'
import { AppShellPage } from './pages/AppShellPage'
import { SidebarPage } from './pages/SidebarPage'
import { type LaunchedApp, launchApp, newQueHome, testEnv } from './utils/app'
import { que, queJson, queResult } from './utils/que'

interface DaemonStatus {
  pid: number
  buildId: string
  stale: boolean
}

const statusOf = (queHome: string): DaemonStatus =>
  queJson<DaemonStatus>(queHome, 'daemon', 'status', '--json')

/** A daemon from another bundle than the app would start, as a previous build's is. */
function startStaleDaemon(queHome: string): void {
  spawn(resolveRuntime(), [bundleEntry('src/daemon/index.ts')], {
    detached: true,
    stdio: 'ignore',
    env: { ...testEnv(queHome), ELECTRON_RUN_AS_NODE: '1' }
  }).unref()
}

let launched: LaunchedApp

test.afterEach(async () => {
  await launched?.close() // quits the app AND stops the test daemon
})

test('the Restart that installed an update hands the terminals over at launch', async () => {
  const queHome = newQueHome()
  let termId = ''
  let stalePid = 0

  await test.step('A daemon on an older build, with a terminal', async () => {
    startStaleDaemon(queHome)
    await expect
      .poll(() => queResult(queHome, 'daemon', 'status', '--json').code, { timeout: 20_000 })
      .toBe(0)
    const status = statusOf(queHome)
    expect(status.stale).toBe(true)
    stalePid = status.pid
    termId = que(queHome, 'term', 'new', '--name', 'carried-over').trim()
  })

  await test.step('Installed by hand, no marker: the app offers Restart and hands nothing over', async () => {
    launched = await launchApp({ queHome })
    await new AppShellPage(launched.window).waitForLoad()
    await expect(new SidebarPage(launched.window).daemonUpdate).toBeVisible()
    expect(statusOf(queHome).pid).toBe(stalePid)
    await launched.app.close() // the app only: the daemon stays, as across an install
  })

  await test.step('With the marker a clicked Restart leaves: handed over, no second Restart', async () => {
    writeRestartMarker(restartMarkerPath(queHome))

    launched = await launchApp({ queHome })
    const appShell = new AppShellPage(launched.window)
    await appShell.waitForLoad()

    await expect.poll(() => statusOf(queHome).pid, { timeout: 20_000 }).not.toBe(stalePid)
    expect(statusOf(queHome).stale).toBe(false)
    await expect(new SidebarPage(launched.window).daemonUpdate).toHaveCount(0)
    await expect(appShell.reconnecting).toBeHidden()
    await expect(appShell.error).toHaveCount(0)
    expect(existsSync(restartMarkerPath(queHome))).toBe(false)
    const terms = queJson<TermInfo[]>(queHome, 'term', 'list', '--json')
    expect(terms.find((t) => t.id === termId)?.alive).toBe(true)
  })
})
