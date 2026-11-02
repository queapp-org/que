// Launches the built app for one test: a fresh QUE_HOME (so a fresh daemon),
// QUE_E2E=1 (the renderer's window.__que hook), and the fakes first on PATH.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page
} from '@playwright/test'
import { QUE_TERMINAL_MARKERS } from '../../../src/shared/env'
import { pidAlive } from '../../../src/shared/process'
import { readFakeLog, REPO_ROOT } from '../../../src/testing/fakes'
import { fakeEnv, QUIET_OFF, writeGitconfig } from '../../fakes/env.cjs'
import { que } from './que'

export interface LaunchedApp {
  app: ElectronApplication
  window: Page
  queHome: string
  /** argv of every fake `gh` call, in order. */
  ghCalls(): string[][]
  /** argv of every fake claude invocation, in order. */
  claudeCalls(): string[][]
  /** argv of every fake `code` call, in order. */
  codeCalls(): string[][]
  /** Quits the app, stops the test daemon, and checks its process is gone. */
  close(): Promise<void>
}

/** The env every process in a test shares (app, daemon, CLI, fakes): fakeEnv plus QUE_E2E. */
export function testEnv(
  queHome: string,
  extra: Record<string, string> = {}
): Record<string, string> {
  const env: Record<string, string> = {}

  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL

  // A spec run from a que terminal is not in that terminal (#140); fakeEnv sets QUE_HOME.
  for (const name of [...QUE_TERMINAL_MARKERS, 'QUE_TERMINAL']) delete env[name]

  return {
    ...env,
    ...fakeEnv(queHome),
    QUE_E2E: '1',
    ...extra
  }
}

/** A fresh directory under the system temp dir. */
export function tempDir(prefix: string): string {
  return mkdtempSync(join(os.tmpdir(), prefix))
}

const argvOf = (path: string): string[][] => readFakeLog(path).map((call) => call.argv)

/**
 * A fresh QUE_HOME, for specs that seed state with the CLI before launching.
 * Its config.toml turns quiet hours off (they default to on in the evening)
 * unless the spec passes its own config.
 */
export function newQueHome(config = QUIET_OFF): string {
  const queHome = tempDir('que-e2e-')
  writeGitconfig(queHome, 'e2e')
  writeFileSync(join(queHome, 'config.toml'), config)

  return queHome
}

export async function launchApp(
  opts: { queHome?: string; env?: Record<string, string> } = {}
): Promise<LaunchedApp> {
  const queHome = opts.queHome ?? newQueHome()

  const app = await electron.launch({
    args: ['.'],
    cwd: REPO_ROOT,
    env: testEnv(queHome, opts.env)
  })

  const window = await app.firstWindow()
  // One window size everywhere: hosted runners have a 1024px-wide display, which clamps the
  // app's default 1100x720, so the specs see the same (narrow) layout on a laptop as in CI.
  const browserWindow = await app.browserWindow(window)
  await browserWindow.evaluate((w) => {
    w.setSize(1024, 680)
    w.center()
  })

  return {
    app,
    window,
    queHome,
    ghCalls: () => argvOf(join(queHome, 'fake-gh.log')),
    claudeCalls: () => argvOf(join(queHome, 'fake-claude.log')),
    codeCalls: () => argvOf(join(queHome, 'fake-code.log')),
    close: async () => {
      // The app first, so it cannot reconnect and respawn a daemon.
      await app.close().catch(() => {})
      const pidFile = join(queHome, 'daemon.pid')
      const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8').trim()) : null

      try {
        que(queHome, 'daemon', 'stop')
      } catch {
        // Already stopped.
      }

      if (pid !== null) {
        await expect
          .poll(() => pidAlive(pid), { message: `daemon pid ${pid} still alive`, timeout: 10_000 })
          .toBe(false)
      }
    }
  }
}

/** Every app window as the main process sees it: its URL and whether it is shown. */
export async function windowStates(
  app: ElectronApplication
): Promise<Array<{ board: boolean; visible: boolean }>> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => ({
      board: w.webContents.getURL().endsWith('#board'),
      visible: w.isVisible()
    }))
  )
}

/** The open window that is (or is not) the quiet board, found by its URL hash. */
export async function findWindow(app: ElectronApplication, board: boolean): Promise<Page> {
  let found: Page | undefined
  await expect
    .poll(
      () => {
        found = app.windows().find((w) => !w.isClosed() && w.url().endsWith('#board') === board)

        return found !== undefined
      },
      { message: `no ${board ? 'quiet board' : 'main'} window` }
    )
    .toBe(true)

  return found as Page
}
