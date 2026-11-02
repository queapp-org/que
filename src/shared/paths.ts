import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import { join, resolve } from 'node:path'

/** Unix socket paths are limited (~104 bytes on macOS); stay safely below. */
const MAX_SOCKET_PATH = 100

export interface QuePaths {
  home: string
  socket: string
  pid: string
  logsDir: string
  daemonLog: string
  /** Per-workspace setup/teardown logs. */
  workspaceLogsDir: string
  /** SQLite database. */
  db: string
  /** The wrappers that sit first on PATH in workspace terminals (claude, que). */
  binDir: string
  /** Hook settings passed to Claude Code with --settings. */
  hooksJson: string
  /** The newest Claude plan usage reading, kept across restarts. */
  usageJson: string
  /** Shell startup files for workspace terminals (zsh ZDOTDIR). */
  shellDir: string
  /** Set when the socket had to move to /tmp because the home path is too long. */
  socketFallback: boolean
}

export function queHome(): string {
  return process.env.QUE_HOME || join(os.homedir(), '.que')
}

/** Resolves (without creating) every path the daemon and clients share. */
export function quePaths(): QuePaths {
  const home = queHome()
  const logsDir = join(home, 'logs')
  let socket = join(home, 'daemon.sock')
  let socketFallback = false

  if (socket.length > MAX_SOCKET_PATH) {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- platform capability: process.getuid is absent on Windows
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0
    // One socket per home: homes that are all too long must not share a path.
    const key = createHash('sha256').update(resolve(home)).digest('hex').slice(0, 16)
    socket = join('/tmp', `que-${uid}`, `${key}.sock`)
    socketFallback = true
  }

  return {
    home,
    socket,
    pid: join(home, 'daemon.pid'),
    logsDir,
    daemonLog: join(logsDir, 'daemon.log'),
    workspaceLogsDir: join(logsDir, 'workspaces'),
    db: join(home, 'que.db'),
    binDir: join(home, 'bin'),
    hooksJson: join(home, 'hooks.json'),
    usageJson: join(home, 'usage.json'),
    shellDir: join(home, 'shell'),
    socketFallback
  }
}

/** The socket path for display, with a note when it moved out of the home. */
export function describeSocket(p: Pick<QuePaths, 'socket' | 'socketFallback'>): string {
  return p.socketFallback ? `${p.socket} (moved to /tmp: the home path is too long)` : p.socket
}

/** Creates the home, logs and socket directories (owner-only) if missing. */
export function ensureDirs(p: QuePaths = quePaths()): QuePaths {
  fs.mkdirSync(p.home, { recursive: true, mode: 0o700 })
  fs.mkdirSync(p.logsDir, { recursive: true, mode: 0o700 })
  fs.mkdirSync(join(p.socket, '..'), { recursive: true, mode: 0o700 })

  return p
}
