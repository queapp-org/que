import { spawn } from 'node:child_process'
import os from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron'
import { summaryNotification } from '../daemon/report'
import { buildIdOf, daemonIsStale } from '../shared/build-id'
import { DaemonClient, resolveDaemonScript } from '../shared/client'
import { loginShellPath, mergePath } from '../shared/login-path'
import { queHome, quePaths } from '../shared/paths'
import { delay, waitForExit } from '../shared/process'
import {
  RENDERER_EVENTS,
  RENDERER_METHODS,
  type MethodName,
  type ParamsOf,
  type Report
} from '../shared/protocol'
import type { DaemonState, QuietKind, QuietState, UpdateInfo } from '../shared/types'
import { handOffDaemon, handOffFailedText } from '../shared/upgrade'
import { createBoardWindow } from './board'
import { decodeAbsolutePath } from './ipc.decode'
import { installMenu } from './menu'
import { createTray, type QueTray, quietTitle } from './tray'
import { checkForUpdate, isReleaseBuild, readLocalBuild } from './update-check'
import { errorCode, errorMessage } from '../shared/errors.decode'

// The daemon owns every terminal and workspace. This process only proxies the
// allowed calls and their events between the renderer and the daemon;
// quitting leaves terminals alive.

let mainWindow: BrowserWindow | null = null

/** The quiet board, while quiet hours are locked. */
let boardWindow: BrowserWindow | null = null
let quiet: QuietState | null = null
let client: DaemonClient | null = null
let connecting: Promise<DaemonClient> | null = null
let tray: QueTray | null = null
const e2e = process.env.QUE_E2E === '1'

/** Quiet hours are on and no unlock is running; false until the state arrives. */
function locked(): boolean {
  return quiet?.locked ?? false
}

// Everything que keeps lives under QUE_HOME, the app's own data (window
// storage, caches) included, so a test QUE_HOME isolates all of it.
app.setPath('userData', join(queHome(), 'app'))

/** A newer release, once the update check has found one. */
let update: UpdateInfo | null = null

/** The daemon as last seen after a connect (see refreshDaemon). */
let daemon: DaemonState | null = null
let daemonPid: number | null = null

/** The pid of a daemon whose connection just closed: reconnecting waits for it to exit first. */
let exitingPid: number | null = null

/** A connection was made before, so the next one is a reconnect. */
let everConnected = false

/** An update in place from the window in flight; state() waits for it. */
let upgrading: Promise<DaemonState> | null = null

/** Asks the daemon which build it runs and compares it with the bundle this app would start. */
async function refreshDaemon(c: DaemonClient): Promise<DaemonState> {
  const ping = await c.request('daemon.ping')
  daemonPid = ping.pid
  // A daemon from before build ids answers without one: unknown, like ''.
  const buildId = ping.buildId ?? ''
  const expectedBuildId = buildIdOf(resolveDaemonScript())
  daemon = {
    version: ping.version,
    buildId,
    expectedBuildId,
    stale: daemonIsStale(buildId, expectedBuildId)
  }

  return daemon
}

function getClient(): Promise<DaemonClient> {
  if (client?.connected) return Promise.resolve(client)

  connecting ??= connect().finally(() => {
    connecting = null
  })

  return connecting
}

async function connect(): Promise<DaemonClient> {
  // A daemon that is shutting down still owns the socket for a moment and
  // removes it on its way out; starting the next one before it is gone
  // would race that removal.
  const leaving = exitingPid
  exitingPid = null

  if (leaving !== null) await waitForExit(leaving, 5_000)

  const c = await DaemonClient.connectOrStart({ log: (m) => console.log(`[daemon] ${m}`) })
  client = c

  for (const ev of RENDERER_EVENTS) {
    c.on(ev, (data) => sendToRenderer('que:event', ev, data))
  }

  c.on('workspace.created', (w) => tray?.putWorkspace(w))
  c.on('workspace.updated', (w) => tray?.putWorkspace(w))
  c.on('workspace.removed', ({ id }) => tray?.dropWorkspace(id))
  tray?.seed(c)
  c.on('quiet.changed', (q) => applyQuiet(q))
  c.on('quiet.morningSummary', morningSummary)
  void c.request('quiet.state').then(applyQuiet, () => {})
  c.onClose(() => {
    if (client === c) client = null
    exitingPid = daemonPid
    sendToRenderer('que:event', 'daemon.disconnected', {})
  })

  try {
    await refreshDaemon(c)
  } catch (err) {
    console.error('daemon.ping failed after connecting:', err)
  }

  if (everConnected && daemon) sendToRenderer('que:event', 'daemon.reconnected', daemon)
  everConnected = true

  return c
}

/**
 * Updates the daemon in place: it hands every terminal to a daemon started
 * from this app's bundle, which then serves the socket. Terminal ids and shells
 * stay the same, and nothing is killed. The connection to the old daemon closes
 * as it exits; the next one reaches the successor, and `daemon.reconnected`
 * fires as after a restart. A failed hand-off rejects with what it means (the
 * old daemon still serves). Only ever the user's click.
 */
function upgradeDaemon(): Promise<DaemonState> {
  upgrading ??= (async () => {
    const c = await getClient()
    const closed = new Promise<void>((r) => c.onClose(r))
    const paths = quePaths()
    const outcome = await handOffDaemon(c, paths)

    if (!outcome.ok) throw new Error(sentence(handOffFailedText(outcome, paths)))
    // The old daemon exits once it has answered; its connection goes with it. It
    // leaves the socket to its successor, so there is no exit to wait for.
    await Promise.race([closed, delay(2_000)])
    c.close()
    exitingPid = null
    const next = await getClient()

    return daemon && daemonPid === outcome.pid ? daemon : await refreshDaemon(next)
  })().finally(() => {
    upgrading = null
  })

  return upgrading
}

/** A lower-case clause as the error line's sentence. */
function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

async function daemonState(): Promise<DaemonState> {
  // Whatever the update's outcome, a daemon serves afterwards; ask it.
  if (upgrading) await upgrading.catch(() => {})

  const c = await getClient()

  return daemon ?? (await refreshDaemon(c))
}

/** A main-side call as data, so its error keeps its code across ipc. */
async function reply<T>(
  fn: () => Promise<T>
): Promise<{ ok: true; result: T } | { ok: false; error: { code: string; message: string } }> {
  try {
    return { ok: true, result: await fn() }
  } catch (err) {
    return { ok: false, error: { code: errorCode(err) ?? 'error', message: errorMessage(err) } }
  }
}

function showBoard(): void {
  // Set on every show: a manual quiet and quiet hours title the board differently.
  const title = quietTitle(quiet) ?? 'que · quiet hours'

  if (!boardWindow || boardWindow.isDestroyed()) {
    boardWindow = createBoardWindow({ e2e })
    boardWindow.on('closed', () => {
      boardWindow = null
    })
    const win = boardWindow
    win.once('ready-to-show', () => {
      if (win.isDestroyed() || !locked()) return

      if (e2e) win.showInactive()
      else win.show()
    })
  } else if (e2e) boardWindow.showInactive()
  else boardWindow.show()

  boardWindow.setTitle(title)
}

function closeBoard(): void {
  const win = boardWindow
  boardWindow = null

  if (win && !win.isDestroyed()) win.close()
}

/**
 * Locked: the main window hides (its terminals stay running in the daemon)
 * and the board shows. Unlocked or work hours: the reverse, with no prompt.
 */
function applyQuiet(q: QuietState): void {
  const wasLocked = locked()
  quiet = q
  tray?.setQuiet(q)

  if (locked()) {
    mainWindow?.hide()
    showBoard()
  } else {
    closeBoard()

    if (wasLocked) showWindow()
  }
}

/** One notification with the window's count line, when a quiet window ends. */
function morningSummary({ kind, report }: { kind: QuietKind; report: Report }): void {
  if (e2e || !Notification.isSupported()) return

  // The same words as the report page's count line; none after an empty manual quiet.
  const note = summaryNotification(kind, report, Date.now())

  if (note) new Notification(note).show()
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    // Under e2e the window must not steal OS focus, or stray keystrokes from
    // the desktop land in the terminal under test. During quiet hours it
    // starts hidden behind the board.
    show: !e2e && !locked(),
    backgroundColor: '#181818',
    title: 'que',
    // No native title bar: the app's chrome runs to the top, the traffic
    // lights sit over the sidebar's top strip, which drags the window.
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 13, y: 13 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Read by the preload to decide whether to expose the e2e test hook.
      additionalArguments: e2e ? ['--que-e2e'] : []
    }
  })

  if (e2e && !locked()) mainWindow.showInactive()

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Links (pull requests) open in the browser, never inside the app window.
  const external = (url: string): void => {
    if (!e2e && /^https?:\/\//.test(url)) void shell.openExternal(url)
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    external(url)

    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (ev, url) => {
    if (url === mainWindow?.webContents.getURL()) return
    ev.preventDefault()
    external(url)
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** Brings que forward: the board while locked, else the main window. */
function showApp(): void {
  if (locked()) showBoard()
  else showWindow()
}

function showWindow(): void {
  if (!mainWindow) createWindow()
  else if (e2e) mainWindow.showInactive()
  else {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }

  if (!e2e) app.focus({ steal: true })
}

/**
 * Once per launch (and at most once a day, see update-check.ts): is there a newer release?
 * Only a release build asks; one run from source or built by `npm run package` (and so install:local) never does.
 */
function startUpdateCheck(): void {
  if (e2e || process.env.QUE_UPDATE_CHECK === '0') return

  if (!isReleaseBuild(app.isPackaged, readLocalBuild(app.getAppPath()))) return
  void checkForUpdate({
    currentVersion: app.getVersion(),
    statePath: join(queHome(), 'state', 'update-check.json')
  }).then((info) => {
    update = info

    if (info) sendToRenderer('que:update', info)
  })
}

function sendToRenderer(channel: string, ...args: unknown[]): void {
  for (const win of [mainWindow, boardWindow]) {
    if (!win || win.isDestroyed()) continue
    const wc = win.webContents

    if (wc.isDestroyed() || wc.isCrashed()) continue

    try {
      wc.send(channel, ...args)
    } catch {
      // The frame can be torn down mid-send during shutdown or reload.
    }
  }
}

function registerIpc(): void {
  ipcMain.handle('app:homedir', () => os.homedir())

  ipcMain.handle('dialog:openFolder', async () => {
    const opts: Electron.OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] }

    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, opts)
      : await dialog.showOpenDialog(opts)

    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  // Fire-and-forget: the editor is found on PATH and outlives nothing here.
  ipcMain.handle('app:openInEditor', (_e, arg) => {
    const path = decodeAbsolutePath(arg)

    if (path === null) throw new Error('path must be absolute')
    const child = spawn('code', ['-n', path], { detached: true, stdio: 'ignore' })
    child.on('error', (err) => console.error(`code -n ${path} failed: ${err.message}`))
    child.unref()

    return { ok: true }
  })

  ipcMain.handle('app:update', () => update)

  // Opens only the release page the check found; the renderer cannot pass a URL.
  ipcMain.handle('app:openUpdate', () => {
    if (update) void shell.openExternal(update.url)

    return { ok: true }
  })

  ipcMain.handle('daemon:state', () => reply(daemonState))
  ipcMain.handle('daemon:upgrade', () => reply(upgradeDaemon))

  ipcMain.handle('app:trayTitle', () => {
    if (!e2e) throw new Error('app.trayTitle is only available under QUE_E2E=1')

    return tray?.title() ?? ''
  })

  // The params pass through untouched; the daemon validates them.
  ipcMain.handle(
    'que:request',
    async <M extends MethodName>(
      _e: Electron.IpcMainInvokeEvent,
      method: M,
      params: ParamsOf<M>
    ) => {
      if (!RENDERER_METHODS.has(method)) throw new Error(`method not allowed: ${method}`)
      const c = await getClient()

      // Errors thrown across ipc lose their fields; return them as data.
      return reply(() => c.request(method, params))
    }
  )

  // Fire-and-forget path for keystrokes, avoiding a round trip per key.
  ipcMain.on('que:write', (_e, id: string, data: string) => {
    void getClient()
      .then((c) => c.request('term.write', { id, data }))
      .catch(() => {})
  })
}

app.whenReady().then(async () => {
  // A Finder launch has launchd's PATH; the daemon and editors inherit ours,
  // so resolve the login shell's once, before the first daemon start.
  if (!e2e) {
    const login = await loginShellPath()
    process.env.PATH = mergePath(process.env.PATH, login)
    console.log(login ? 'PATH: merged the login shell PATH' : 'PATH: login shell PATH unavailable')
  }

  registerIpc()
  installMenu()

  const quietCall = (
    method: 'quiet.unlock' | 'quiet.lock' | 'quiet.start' | 'quiet.end',
    params?: { minutes: number }
  ): void => {
    void getClient()
      .then((c) => c.request(method, params))
      .catch((err) => console.error(`${method} failed:`, err))
  }

  tray = createTray({
    show: showApp,
    quit: () => app.quit(),
    unlock: () => quietCall('quiet.unlock'),
    lock: () => quietCall('quiet.lock'),
    start: (minutes) => quietCall('quiet.start', { minutes }),
    end: () => quietCall('quiet.end')
  })

  try {
    const c = await getClient()
    applyQuiet(await c.request('quiet.state'))
  } catch (err) {
    console.error('failed to reach que daemon:', err)
  }

  if (!mainWindow) createWindow()
  startUpdateCheck()
  app.on('activate', () => {
    if (!mainWindow) createWindow()
    showApp()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  tray?.destroy()
  tray = null
  // Only the connection goes away; the daemon and its terminals keep running.
  client?.close()
})
