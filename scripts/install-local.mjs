// Local install (`npm run install:local`): builds que.app from this checkout
// (`npm run package`), replaces /Applications/que.app with it, links the `que`
// command, and reopens the app, so the installed app follows `main` with one
// command. The background service is never touched: no terminal ends. Like
// every bundle `npm run package` makes, it carries `queLocalBuild` (the
// checkout's short sha) in its package.json, so it never checks for releases.
//
//   --no-build        install the newest release/mac*/que.app as it is
//   --from <que.app>  install this bundle instead of the one in release/
//   --dest <que.app>  install here (default /Applications/que.app)
//   --no-link         leave the `que` command alone
//   --no-launch       do not quit a running app and do not open the new one
//
// QUE_INSTALL_SYSTEM_BIN and QUE_INSTALL_HOME move the directories the link
// may go in (tests use them; by default /usr/local/bin, else ~/.local/bin).
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeCliInstall, installCli } from '../src/main/install-cli.ts'

export const BUNDLE_ID = 'dev.que.app'
export const DEFAULT_DEST = '/Applications/que.app'

/** The newest release/mac*\/que.app under `releaseDir`, or undefined. */
export function locateBundle(releaseDir) {
  if (!fs.existsSync(releaseDir)) return undefined

  return fs
    .readdirSync(releaseDir)
    .filter((d) => d.startsWith('mac'))
    .map((d) => join(releaseDir, d, 'que.app'))
    .filter((p) => fs.existsSync(p))
    .map((p) => ({ p, mtime: fs.statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0]?.p
}

export function parseArgs(argv) {
  const opts = { build: true, link: true, launch: true, from: undefined, dest: DEFAULT_DEST }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]

    if (a === '--no-build') opts.build = false
    else if (a === '--no-link') opts.link = false
    else if (a === '--no-launch') opts.launch = false
    else if (a === '--from' || a === '--dest') {
      const value = argv[++i]

      if (!value) throw new Error(`${a} needs a path`)
      opts[a.slice(2)] = resolve(value)
    } else throw new Error(`unknown option ${a}`)
  }

  return opts
}

/** CFBundleShortVersionString from the bundle's Info.plist, or undefined. */
export function bundleVersion(app) {
  try {
    const plist = fs.readFileSync(join(app, 'Contents', 'Info.plist'), 'utf8')

    return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1]
  } catch {
    return undefined
  }
}

/**
 * Replaces `dest` with a copy of `src` without a moment where it is half
 * there: copy beside it, move the old one aside, move the new one in, drop
 * the old one. A `.new`/`.old` left by an interrupted run is removed first.
 */
export function swapBundle(src, dest, copy = dittoCopy) {
  const next = `${dest}.new`
  const old = `${dest}.old`

  fs.rmSync(next, { recursive: true, force: true })
  fs.rmSync(old, { recursive: true, force: true })
  fs.mkdirSync(dirname(dest), { recursive: true })
  copy(src, next)

  if (fs.existsSync(dest)) fs.renameSync(dest, old)

  try {
    fs.renameSync(next, dest)
  } catch (err) {
    if (fs.existsSync(old)) fs.renameSync(old, dest)
    throw err
  }

  fs.rmSync(old, { recursive: true, force: true })
}

function dittoCopy(src, to) {
  execFileSync('ditto', [src, to])
}

function osa(script) {
  const r = spawnSync('osascript', ['-e', script], { encoding: 'utf8' })

  return r.status === 0 ? r.stdout.trim() : ''
}

const isRunning = () => osa(`application id "${BUNDLE_ID}" is running`) === 'true'

/** Asks a running app to quit and waits until it has; throws after `timeoutMs`. */
export async function quitRunningApp(timeoutMs = 30_000) {
  if (!isRunning()) return false
  osa(`tell application id "${BUNDLE_ID}" to quit`)
  const deadline = Date.now() + timeoutMs

  while (isRunning()) {
    if (Date.now() > deadline)
      throw new Error(
        `que is still running ${timeoutMs / 1000}s after asking it to quit; quit it yourself and run this again`
      )

    await new Promise((r) => setTimeout(r, 250))
  }

  return true
}

export async function main(argv) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const opts = parseArgs(argv)

  if (opts.build && !opts.from) {
    const r = spawnSync('npm', ['run', 'package'], { cwd: root, stdio: 'inherit' })

    if (r.status !== 0) throw new Error('npm run package failed')
  }

  const src = opts.from ?? locateBundle(join(root, 'release'))

  if (!src || !fs.existsSync(join(src, 'Contents'))) {
    throw new Error(
      `no que.app to install${src ? ` at ${src}` : ''}; run npm run package, or pass --from <que.app>`
    )
  }

  if (opts.launch && (await quitRunningApp())) console.log('Quit the running app.')

  swapBundle(src, opts.dest)

  const version =
    bundleVersion(opts.dest) ??
    JSON.parse(fs.readFileSync(join(root, 'package.json'), 'utf8')).version

  console.log(`Installed que ${version} at ${opts.dest}`)

  if (opts.link) {
    const launcher = join(opts.dest, 'Contents', 'Resources', 'cli', 'que')
    const home = process.env.QUE_INSTALL_HOME ?? os.homedir()
    const plan = installCli(launcher, home, process.env.QUE_INSTALL_SYSTEM_BIN || undefined)
    const { message, detail } = describeCliInstall(plan)

    console.log(plan.action === 'refuse' ? `Warning: ${message}. ${detail}` : message)

    if (plan.action !== 'refuse' && plan.pathHint) console.log(detail)
  }

  if (opts.launch) execFileSync('open', [opts.dest])

  console.log(
    'The background service was not touched, so every terminal keeps running; the app shows Restart while the service runs the previous build.'
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`install:local: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
