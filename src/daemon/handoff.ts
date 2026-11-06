// Handing every live terminal to a new daemon process, so an upgrade of the
// daemon ends no terminal. A PTY is a file descriptor: the successor inherits
// each terminal's master fd through its stdio array and owns the shell without
// the shell noticing. The sequence (see docs/architecture.md):
//
//   old: hold reading on every terminal, snapshot them to a file, spawn the
//        successor with --handoff --snapshot <file> and the fds from index 4
//   new: adopt every fd, rebuild the mirrors              → { type: 'adopted' }
//   old: stop serving, remove the socket                  → { type: 'bind' }
//   new: bind the socket, write the pid file, start the services, read
//        the terminals                                     → { type: 'ready' }
//   old: answer the caller, exit without ending anything
import { spawn, type ChildProcess, type Serializable } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { daemonEnv } from '../shared/client'
import { errorMessage } from '../shared/errors.decode'
import { daemonScriptFrom } from '../shared/packaged'
import type { QuePaths } from '../shared/paths'
import { ErrorCodes, type HandoffParams, type HandoffResult } from '../shared/protocol'
import type { AdoptedTerminal } from './adopted-terminal'
import { RpcError } from './errors'
import {
  decodePredecessorMessage,
  decodeSnapshot,
  decodeSuccessorMessage,
  encodeSnapshot,
  SNAPSHOT_VERSION,
  type SuccessorMessage
} from './handoff.decode'
import {
  initialHandoff,
  stepHandoff,
  type HandoffEffect,
  type HandoffInput,
  type HandoffState
} from './handoff-machine'
import type { PtyHost } from './pty-host'

/** The error code of a handoff that did not happen; this daemon still serves. */
export const HANDOFF_FAILED = 'handoff_failed'

/** The first inherited fd in the successor: 0-2 are stdio, 3 is the IPC channel. */
const FIRST_FD = 4

/** How long each wait on the successor may take. */
const STEP_TIMEOUT_MS = 15_000

export interface HandoffSenderOptions {
  host: PtyHost
  paths: QuePaths
  log: (msg: string) => void
  /** Serves the socket again, with fresh services. */
  relisten: () => Promise<void>
  /** Each wait on the successor. Default 15 s. */
  stepTimeoutMs?: number
}

/** The running daemon's side: one handoff at a time. */
export class HandoffSender {
  private busy = false
  /** Set once a successor serves: from then on the terminals, socket and pid file are its. */
  handedOver = false

  constructor(private readonly o: HandoffSenderOptions) {}

  /**
   * Hands over to `params.script`; `release` stops serving everyone but the
   * caller (the socket file may remain). Resolves once the successor serves;
   * rejects, with this daemon serving again, when it does not.
   */
  async run(params: HandoffParams, release: () => Promise<void>): Promise<HandoffResult> {
    if (this.busy) throw new RpcError(ErrorCodes.Conflict, 'a handoff is already under way')
    const script = params.script ?? daemonScriptFrom(__dirname)
    const runtime = params.runtime ?? process.execPath

    if (!fs.existsSync(script)) {
      throw new RpcError(ErrorCodes.BadRequest, `no daemon bundle at ${script}`)
    }

    if (!fs.existsSync(runtime))
      throw new RpcError(ErrorCodes.BadRequest, `no runtime at ${runtime}`)
    this.busy = true

    try {
      return await this.handOver(script, runtime, release)
    } finally {
      this.busy = false
    }
  }

  private async handOver(
    script: string,
    runtime: string,
    release: () => Promise<void>
  ): Promise<HandoffResult> {
    const { host, paths, log } = this.o
    const live = host.list().filter((t) => t.alive)

    // From here on, output waits in the kernel for whichever daemon reads next;
    // the snapshot covers every byte read before it.
    for (const t of live) t.holdReading()

    const resume = (): void => {
      for (const t of live) if (host.get(t.id) === t && t.alive) t.resumeReading()
    }

    const file = join(paths.home, `handoff-${process.pid}.json`)
    let child: ChildProcess

    try {
      const serialized = await Promise.all(live.map((t) => t.serializeNow()))

      const terminals = live.map((t, i) => ({
        id: t.id,
        name: t.name,
        cwd: t.cwd,
        createdAt: t.createdAt,
        workspaceId: t.workspaceId,
        pid: t.pid,
        cols: t.cols,
        rows: t.rows,
        fd: FIRST_FD + i,
        serialized: serialized[i].serialized,
        title: t.title,
        process: t.process
      }))

      fs.writeFileSync(
        file,
        encodeSnapshot({ version: SNAPSHOT_VERSION, from: process.pid, terminals }),
        { mode: 0o600 }
      )
      child = this.spawnSuccessor(
        runtime,
        script,
        file,
        live.map((t) => t.masterFd)
      )
    } catch (err) {
      fs.rmSync(file, { force: true })
      resume()
      throw new RpcError(HANDOFF_FAILED, `could not start the new daemon: ${errorMessage(err)}`)
    }

    log(`handoff: started ${script} as pid ${child.pid ?? '?'} with ${live.length} terminal(s)`)

    return new Promise((resolve, reject) => {
      let state: HandoffState = initialHandoff
      let timer: NodeJS.Timeout | undefined
      // Effects run one after another: relisten finishes before the error is answered.
      let chain = Promise.resolve()

      const wait = (): void => {
        clearTimeout(timer)
        timer = setTimeout(() => feed({ type: 'timeout' }), this.o.stepTimeoutMs ?? STEP_TIMEOUT_MS)
      }

      const feed = (input: HandoffInput): void => {
        const step = stepHandoff(state, input)

        if (step.state !== state) log(`handoff: ${state.phase} -> ${step.state.phase}`)
        state = step.state

        for (const e of step.effects) {
          chain = chain
            .then(() => run(e))
            .catch((err: Error) => log(`handoff: ${e} failed: ${errorMessage(err)}`))
        }
      }

      const done = (): void => {
        clearTimeout(timer)
        child.removeAllListeners()
        fs.rmSync(file, { force: true })
      }

      const run = async (e: HandoffEffect): Promise<void> => {
        if (e === 'release') {
          clearTimeout(timer)

          try {
            await release()
            fs.rmSync(paths.socket, { force: true })
            feed({ type: 'released' })
          } catch (err) {
            feed({ type: 'failed', error: `releasing the socket: ${errorMessage(err)}` })
          }
        } else if (e === 'bind') {
          wait()
          child.send({ type: 'bind' })
        } else if (e === 'kill-successor') {
          done()

          // SIGKILL: the successor must not run a shutdown that would end the terminals.
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        } else if (e === 'relisten') {
          fs.rmSync(paths.socket, { force: true })
          await this.o.relisten()
          log('handoff: serving again')
        } else if (e === 'resume') {
          resume()
        } else if (e === 'reply-ok') {
          done()

          // The successor serves; nothing of it depends on this process any more.
          if (child.connected) child.disconnect()
          child.unref()
          this.handedOver = true
          resolve({ ok: true, pid: state.pid ?? child.pid ?? 0, terminals: live.length })
        } else {
          log(`handoff failed: ${state.error ?? ''}`)
          reject(new RpcError(HANDOFF_FAILED, state.error ?? 'handoff failed'))
        }
      }

      child.on('message', (m) => {
        const msg = decodeSuccessorMessage(m)

        if (msg) feed(msg)
      })
      child.on('exit', (code) => feed({ type: 'exited', code }))
      child.on('error', (err) => feed({ type: 'failed', error: err.message }))
      wait()
    })
  }

  /** Spawned as connectOrStart starts a daemon, plus the IPC channel and the master fds. */
  private spawnSuccessor(
    runtime: string,
    script: string,
    file: string,
    fds: number[]
  ): ChildProcess {
    const logFd = fs.openSync(this.o.paths.daemonLog, 'a')

    try {
      return spawn(runtime, [script, '--handoff', '--snapshot', file], {
        detached: true,
        stdio: ['ignore', logFd, logFd, 'ipc', ...fds],
        env: daemonEnv(this.o.paths),
        cwd: os.homedir()
      })
    } finally {
      fs.closeSync(logFd)
    }
  }
}

export interface HandoffReceiverOptions {
  host: PtyHost
  snapshotPath: string
  log: (msg: string) => void
  /** Binds the socket, writes the pid file and starts the services. */
  serve: () => Promise<void>
  /** How long to wait for the predecessor's bind. Default 60 s. */
  bindTimeoutMs?: number
}

/**
 * The successor's side: adopts the terminals in the snapshot, waits for its
 * predecessor to let go of the socket, serves, then reads the terminals.
 * Rejects (after telling the predecessor) on any failure; the caller exits
 * without ending any terminal, which the predecessor still holds.
 */
export async function receiveHandoff(o: HandoffReceiverOptions): Promise<number> {
  if (!process.send) throw new Error('--handoff needs the IPC channel of the daemon handing over')
  let adopted: AdoptedTerminal[]

  try {
    const text = fs.readFileSync(o.snapshotPath, 'utf8')
    fs.rmSync(o.snapshotPath, { force: true })
    const snapshot = decodeSnapshot(text)
    adopted = snapshot.terminals.map((t) => o.host.adopt(t))
    o.log(`handoff: adopted ${adopted.length} terminal(s) from pid ${snapshot.from}`)
  } catch (err) {
    await tell({ type: 'failed', error: errorMessage(err) })

    throw err
  }

  await tell({ type: 'adopted' })
  await bindSignal(o.bindTimeoutMs ?? 60_000)

  try {
    await o.serve()
  } catch (err) {
    await tell({ type: 'failed', error: errorMessage(err) })

    throw err
  }

  for (const t of adopted) t.resumeReading()
  await tell({ type: 'ready', pid: process.pid })

  // The predecessor's exit must not matter to this process.
  if (process.connected) process.disconnect()

  return adopted.length
}

function tell(msg: SuccessorMessage): Promise<void> {
  return new Promise((resolve) => {
    if (!process.send || !process.connected) {
      resolve()

      return
    }

    process.send(msg, undefined, {}, () => resolve())
  })
}

/**
 * Resolves on the predecessor's bind, or when its channel closes (it is gone,
 * so the terminals are this process's alone); rejects after `ms`.
 */
function bindSignal(ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (err?: Error): void => {
      clearTimeout(timer)
      process.off('message', onMessage)
      process.off('disconnect', onDisconnect)

      if (err) reject(err)
      else resolve()
    }

    const onMessage = (m: Serializable): void => {
      if (decodePredecessorMessage(m)) finish()
    }

    const onDisconnect = (): void => finish()
    const timer = setTimeout(() => finish(new Error(`no bind within ${ms} ms`)), ms)
    process.on('message', onMessage)
    process.on('disconnect', onDisconnect)

    if (!process.connected) finish()
  })
}
