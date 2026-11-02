// que daemon: owns every PTY so terminals survive app restarts. Runs under the
// Electron binary as plain Node (ELECTRON_RUN_AS_NODE=1). With `--handoff
// --snapshot <file>` it is the successor of a running daemon and takes over
// its terminals (see handoff.ts).
import fs from 'node:fs'
import net from 'node:net'
import { errorMessage } from '../shared/errors.decode'
import { buildIdOf } from '../shared/build-id'
import { ensureDirs, quePaths } from '../shared/paths'
import { HandoffSender, receiveHandoff } from './handoff'
import { PtyHost } from './pty-host'
import { DaemonServer } from './server'

// Under the Electron binary Node's fs treats a .asar file as a directory, so deleting a removed
// worktree that holds one fails. The daemon reads nothing inside an archive.
process.noAsar = true

declare const __QUE_VERSION__: string

// oxlint-disable-next-line anti-slop/no-runtime-typeof -- build-time define, absent when run unbundled
const VERSION = typeof __QUE_VERSION__ === 'string' ? __QUE_VERSION__ : '0.0.0-dev'

// The bundle is CommonJS, so __filename is this bundle's own file
// (out/daemon/index.js, or Resources/daemon/index.js in the app).
const BUILD_ID = buildIdOf(__filename)

const paths = ensureDirs(quePaths())
const logStream = fs.createWriteStream(paths.daemonLog, { flags: 'a' })

function log(msg: string): void {
  logStream.write(`${new Date().toISOString()} [${process.pid}] ${msg}\n`)
}

/** True if something is accepting connections on the socket. */
function socketAlive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(path)
    s.once('connect', () => {
      s.destroy()
      resolve(true)
    })
    s.once('error', () => resolve(false))
  })
}

/** The snapshot file of a handoff, when this process is a successor. */
function handoffSnapshot(argv: string[]): string | null {
  if (!argv.includes('--handoff')) return null
  const at = argv.indexOf('--snapshot')

  if (at < 0 || !argv[at + 1]) throw new Error('--handoff needs --snapshot <file>')

  return argv[at + 1]
}

function exitWith(code: number): void {
  logStream.end(() => process.exit(code))
  setTimeout(() => process.exit(code), 1000).unref()
}

async function main(): Promise<void> {
  if (paths.socketFallback) log(`socket path too long; using ${paths.socket}`)
  const snapshotPath = handoffSnapshot(process.argv.slice(2))

  if (snapshotPath === null && fs.existsSync(paths.socket)) {
    if (await socketAlive(paths.socket)) {
      // Not a failure: under launchd (KeepAlive on unsuccessful exit) this
      // must not be restarted in a loop.
      log('another daemon is already listening; exiting')
      process.exitCode = 0
      logStream.end()

      return
    }

    fs.rmSync(paths.socket, { force: true })
    log('removed stale socket')
  }

  const host = new PtyHost()
  let server: DaemonServer | null = null
  let shuttingDown = false

  const sender = new HandoffSender({
    host,
    paths,
    log,
    // A handoff that failed after this daemon let go of the socket: serve
    // again with fresh services (the released ones are closed for good).
    relisten: async () => {
      await serve()
    }
  })

  const shutdown = (reason: string): void => {
    if (shuttingDown) return
    shuttingDown = true

    if (sender.handedOver) {
      // The terminals, the socket and the pid file belong to the successor now.
      log(`exiting after the handoff (${reason}); terminals left running`)
      exitWith(0)

      return
    }

    log(`shutting down (${reason})`)
    host.killAll()
    const closing = server?.close() ?? Promise.resolve()
    void closing.finally(() => {
      fs.rmSync(paths.socket, { force: true })

      try {
        if (fs.readFileSync(paths.pid, 'utf8').trim() === String(process.pid)) fs.rmSync(paths.pid)
      } catch {
        // Pid file already gone.
      }

      exitWith(0)
    })
  }

  /** A fresh server over the host, bound to the socket, with the pid file written. */
  const serve = async (): Promise<void> => {
    const next = new DaemonServer({
      host,
      version: VERSION,
      buildId: BUILD_ID,
      log,
      onShutdown: () => shutdown('daemon.shutdown'),
      handoff: (p, release) => sender.run(p, release),
      onHandedOff: () => shutdown('handed off')
    })

    await next.listen(paths.socket)
    server = next
    fs.writeFileSync(paths.pid, `${process.pid}\n`)
  }

  if (snapshotPath === null) {
    await serve()
    log(
      `listening on ${paths.socket} (version ${VERSION}, build ${BUILD_ID}, node ${process.version})`
    )
  } else {
    try {
      const n = await receiveHandoff({
        host,
        snapshotPath,
        log,
        serve: async () => {
          // Normally gone already; left behind if the predecessor died before removing it.
          if (fs.existsSync(paths.socket) && !(await socketAlive(paths.socket))) {
            fs.rmSync(paths.socket, { force: true })
          }

          await serve()
        }
      })

      log(
        `listening on ${paths.socket} (version ${VERSION}, build ${BUILD_ID}, node ${process.version}), ` +
          `took over ${n} terminal(s)`
      )
    } catch (err) {
      // The predecessor still holds every terminal and serves again; this
      // process leaves without signalling any of them.
      log(`handoff failed: ${errorMessage(err)}`)
      exitWith(1)

      return
    }
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
  // Detached from any terminal; ignore hangups from a parent session.
  process.on('SIGHUP', () => log('ignoring SIGHUP'))
  process.on('uncaughtException', (err) => log(`uncaught: ${err.stack ?? err.message}`))
  process.on('unhandledRejection', (err) => log(`unhandled rejection: ${String(err)}`))
}

main().catch((err) => {
  log(`fatal: ${(err as Error).stack ?? String(err)}`)
  logStream.end(() => process.exit(1))
})
