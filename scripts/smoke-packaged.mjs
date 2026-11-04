// Packaged-app smoke check (`npm run smoke:packaged`): builds que.app with
// electron-builder (`npm run package`; pass --no-build to reuse release/),
// launches it through Playwright with a fresh QUE_HOME, QUE_E2E=1 and the fakes
// first on PATH, and checks that:
//   - the microphone prompt has que's text, and a signed build has the
//     audio-input entitlement (an unsigned build carries no entitlements);
//   - the updater library loads from inside app.asar, and a release bundle has
//     Contents/Resources/app-update.yml (`npm run dist` writes it; `npm run package`
//     does not, and a build it marks never updates);
//   - the daemon the app starts runs from inside que.app/Contents/Resources,
//     under the app's own binary;
//   - a terminal opens and runs a command (read through window.__que);
//   - the tray title is readable;
//   - Contents/Resources/cli/que --version prints the package version;
//   - launched again the way Finder does (PATH=/usr/bin:/bin:/usr/sbin:/sbin, no
//     TERM, no QUE_E2E), the daemon's PATH is the login shell's, not launchd's;
// then quits the app, stops the daemon, and checks no process is left.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from '@playwright/test'
import { fakeEnv, QUIET_OFF, writeGitconfig } from '../tests/fakes/env.cjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const log = (msg) => console.log(`smoke:packaged: ${msg}`)

if (!process.argv.includes('--no-build')) {
  const r = spawnSync('npm', ['run', 'package'], { cwd: root, stdio: 'inherit' })

  if (r.status !== 0) {
    log('npm run package failed')
    process.exit(1)
  }
}

const releaseDir = join(root, 'release')

const appPath = existsSync(releaseDir)
  ? readdirSync(releaseDir)
      .filter((d) => d.startsWith('mac'))
      .map((d) => join(releaseDir, d, 'que.app'))
      .find((p) => existsSync(p))
  : undefined

if (!appPath) {
  log('no release/mac*/que.app; run npm run package')
  process.exit(1)
}

const executablePath = join(appPath, 'Contents', 'MacOS', 'que')
const resources = join(appPath, 'Contents', 'Resources')
const cliLauncher = join(resources, 'cli', 'que')

log(`app ${appPath}`)

// The same isolation as the e2e specs: a fresh home, quiet hours off, the
// fakes first on PATH, never the user's config or git identity.
const queHome = mkdtempSync(join(os.tmpdir(), 'que-pkg-'))

writeFileSync(join(queHome, 'config.toml'), QUIET_OFF)

writeGitconfig(queHome, 'smoke')

const env = {}

for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v

delete env.ELECTRON_RUN_AS_NODE

delete env.ELECTRON_RENDERER_URL

Object.assign(env, fakeEnv(queHome), { QUE_E2E: '1', QUE_UPDATE_CHECK: '0' })

const que = (...args) => execFileSync(cliLauncher, args, { env, encoding: 'utf8' }).trim()

async function poll(what, fn, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let last

  while (Date.now() < deadline) {
    try {
      last = await fn()

      if (last) return last
    } catch (err) {
      last = err
    }

    await new Promise((r) => setTimeout(r, 200))
  }

  throw new Error(`timed out waiting for ${what} (last: ${String(last)})`)
}

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0)

    return true
  } catch {
    return false
  }
}

const leftovers = () => spawnSync('pgrep', ['-fl', appPath], { encoding: 'utf8' }).stdout.trim()

let app = null
let daemonPid = null
let failed = false

try {
  // The microphone, from the bundle before it runs. Programs in que's terminals
  // need the entitlement, or a signed build denies them the mic with no prompt. An
  // unsigned build carries no entitlements, so codesign prints nothing for it.
  const micText = execFileSync(
    'plutil',
    ['-extract', 'NSMicrophoneUsageDescription', 'raw', join(appPath, 'Contents', 'Info.plist')],
    { encoding: 'utf8' }
  ).trim()

  log(`microphone prompt "${micText}"`)

  if (micText === 'This app needs access to the microphone')
    throw new Error("the microphone prompt is still Electron's default")

  const entitlements = spawnSync('codesign', ['-d', '--entitlements', '-', '--xml', appPath], {
    encoding: 'utf8'
  }).stdout

  if (entitlements && !entitlements.includes('com.apple.security.device.audio-input'))
    throw new Error('a signed build without the audio-input entitlement')

  log(entitlements ? 'has the audio-input entitlement' : 'unsigned: no entitlements to check')

  app = await electron.launch({ executablePath, args: [], env })
  const window = await app.firstWindow()
  log(`launched; window ${await window.title()}`)

  // The updater. `files` leaves node_modules out of the asar, so it has to be bundled into
  // out/main; loading it the way a click does proves that, and asks no feed anything.
  const updater = await app.evaluate(({ app }) => {
    const fs = process.getBuiltinModule('node:fs')
    const main = `${app.getAppPath()}/out/main`
    const load = process.getBuiltinModule('node:module').createRequire(`${main}/index.js`)
    const entry = fs.readFileSync(`${main}/index.js`, 'utf8')

    const chunk = fs
      .readdirSync(main)
      .filter((f) => f.endsWith('.js') && f !== 'index.js')
      .find((f) => fs.readFileSync(`${main}/${f}`, 'utf8').includes('MacUpdater'))

    return {
      external: entry.includes('require("electron-updater")'),
      loaded: chunk ? load(`./${chunk}`).default.autoUpdater.constructor.name : null,
      localBuild: JSON.parse(fs.readFileSync(`${app.getAppPath()}/package.json`, 'utf8'))
        .queLocalBuild
    }
  })

  if (updater.external) throw new Error('electron-updater is external to the main bundle')

  if (updater.loaded !== 'MacUpdater') throw new Error('no updater loads from app.asar')

  log(`${updater.loaded} loads from app.asar`)
  const updateConfig = existsSync(join(resources, 'app-update.yml'))

  if (!updateConfig && !updater.localBuild)
    throw new Error('a release build without Contents/Resources/app-update.yml')

  log(updateConfig ? 'has app-update.yml' : 'local build: no app-update.yml to check')

  // 1. The daemon runs from inside the bundle, under the app binary.
  const status = await poll('the daemon', () => {
    const s = JSON.parse(que('daemon', 'status', '--json'))

    return s.running ? s : null
  })

  daemonPid = status.pid

  const command = execFileSync('ps', ['-o', 'command=', '-p', String(daemonPid)], {
    encoding: 'utf8'
  }).trim()

  log(`daemon pid=${daemonPid} version=${status.version}: ${command}`)
  const expected = `${executablePath} ${join(resources, 'daemon', 'index.js')}`

  if (command !== expected) throw new Error(`daemon command is ${command}, expected ${expected}`)

  if (status.version !== pkg.version) throw new Error(`daemon version ${status.version}`)

  // 2. A terminal opens and runs a command.
  await window.waitForFunction(() => window.__que !== undefined, null, { timeout: 20_000 })
  const termId = await poll('a terminal', () => window.evaluate(() => window.__que.activeTermId()))
  await window.evaluate(
    (id) => window.que.term.write({ id, data: 'echo QUE_PKG_$((6*7))\r' }),
    termId
  )
  await poll('the marker on screen', () =>
    window.evaluate(() =>
      window.__que
        .screenText()
        .split('\n')
        .some((l) => l.trim() === 'QUE_PKG_42')
    )
  )
  log(`terminal ${termId} printed QUE_PKG_42`)

  // 3. The tray title.
  const tray = await poll('the tray title', () => window.evaluate(() => window.__que.trayTitle()))
  log(`tray title "${tray}"`)

  if (!/^● \d+ ▸ \d+ ✕ \d+$/.test(tray)) throw new Error(`unexpected tray title "${tray}"`)

  // 4. The shipped CLI launcher.
  const version = que('--version')
  log(`Contents/Resources/cli/que --version → ${version}`)

  if (version !== pkg.version) throw new Error(`cli/que --version printed ${version}`)

  // 5. A Finder-like launch: the daemon must still find the login shell's PATH.
  await app.close()
  app = null
  que('daemon', 'stop')
  await poll('the daemon to exit', () => !pidAlive(daemonPid), 10_000)
  daemonPid = null
  const finderPath = '/usr/bin:/bin:/usr/sbin:/sbin'
  const finderEnv = { ...env, PATH: finderPath }
  delete finderEnv.QUE_E2E
  delete finderEnv.TERM
  app = await electron.launch({ executablePath, args: [], env: finderEnv })
  await app.firstWindow()
  const { DaemonClient } = createRequire(import.meta.url)(join(resources, 'client', 'index.js'))
  process.env.QUE_HOME = queHome
  const client = await poll('the daemon (Finder-like launch)', () => DaemonClient.tryConnect())

  try {
    const ping = await client.request('daemon.ping')
    daemonPid = ping.pid
    log(`Finder-like daemon PATH ${ping.path}`)

    if (!ping.path.split(':').includes('/usr/local/bin'))
      throw new Error(`daemon PATH lacks /usr/local/bin: ${ping.path}`)

    if (ping.path.length <= finderPath.length)
      throw new Error(`daemon PATH is no longer than the launch PATH: ${ping.path}`)
  } finally {
    client.close()
  }
} catch (err) {
  failed = true
  log(`FAILED: ${err instanceof Error ? err.message : String(err)}`)
} finally {
  // The app first, so it cannot reconnect and start another daemon.
  await app?.close().catch(() => {})

  try {
    que('daemon', 'stop')
  } catch {
    // Already stopped.
  }

  if (daemonPid !== null) {
    await poll('the daemon to exit', () => !pidAlive(daemonPid), 10_000).catch((e) => {
      failed = true
      log(e.message)
    })
  }

  await poll('no processes from the app', () => leftovers() === '', 10_000).catch(() => {
    failed = true
    log(`processes left behind:\n${leftovers()}`)
  })
  rmSync(queHome, { recursive: true, force: true })
}

log(failed ? 'FAILED' : 'ok')

process.exit(failed ? 1 : 0)
