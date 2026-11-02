// que CLI. Runs under the system `node`; must not load native modules.
import fs from 'node:fs'
import { Command } from 'commander'
import { buildIdOf, daemonIsStale, staleDaemonHint } from '../shared/build-id'
import { DaemonClient, DaemonError, resolveDaemonScript } from '../shared/client'
import { plural } from '../shared/format'
import { describeSocket, quePaths } from '../shared/paths'
import { delay, waitForExit } from '../shared/process'
import type { TermInfo } from '../shared/protocol'
import { attach } from './attach'
import { CliError, printJson, printTable, withClient } from './common'
import { runDoctor } from './doctor'
import { runHook } from './hook'
import { registerLaunchdCommands } from './launchd'
import { registerQuietCommands } from './quiet'
import { registerReportCommand } from './report'
import { runStatusLine } from './statusline'
import { registerTicketCommands } from './tickets'
import { registerUpgradeCommand } from './upgrade'
import { registerUsageCommand } from './usage'
import { registerWorkspaceCommands } from './workspaces'
import { errorMessage } from '../shared/errors.decode'

declare const __QUE_VERSION__: string

// oxlint-disable-next-line anti-slop/no-runtime-typeof -- a build-time define, absent when run unbundled
const VERSION = typeof __QUE_VERSION__ === 'string' ? __QUE_VERSION__ : '0.0.0-dev'

function printTerms(terms: TermInfo[]): void {
  if (terms.length === 0) {
    console.log('no terminals')

    return
  }

  printTable(
    ['ID', 'STATE', 'PID', 'SIZE', 'NAME', 'CWD'],
    terms.map((t) => [
      t.id,
      t.alive ? 'alive' : 'exited',
      String(t.pid),
      `${t.cols}x${t.rows}`,
      t.name,
      t.cwd
    ])
  )
}

/** Asks the daemon to shut down, waits for it to exit, and returns its pid. */
async function stopDaemon(c: DaemonClient): Promise<number> {
  const { pid } = await c.request('daemon.ping')
  const closed = new Promise<void>((r) => c.onClose(r))
  await c.request('daemon.shutdown')
  await Promise.race([closed, delay(2000)])
  c.close()

  // Wait (briefly) for the process to actually exit.
  await waitForExit(pid, 3_000)

  return pid
}

async function main(): Promise<void> {
  // Set when the app binary runs the CLI as Node; it has done its job and must
  // not reach programs started from here (an editor would start as plain Node).
  delete process.env.ELECTRON_RUN_AS_NODE

  // `que hook` runs inside Claude Code for every hook event: answer before
  // loading the rest of the CLI, and never fail.
  if (process.argv[2] === 'hook') {
    await runHook().catch(() => {})
    process.exit(0)
  }

  // `que statusline` runs inside Claude Code after each reply: the same fast
  // path. Exit once the user's own status line's output has been written out.
  if (process.argv[2] === 'statusline') {
    const code = await runStatusLine().catch(() => 0)
    process.stdout.write('', () => process.exit(code))

    return
  }

  const program = new Command()
  program.name('que').description('que command-line interface').version(VERSION)

  const daemon = program.command('daemon').description('manage the background daemon')
  daemon
    .command('start')
    .description('start the daemon if it is not running')
    .action(() =>
      withClient(async (c) => {
        const info = await c.request('daemon.ping')
        console.log(`daemon running pid=${info.pid} version=${info.version}`)
      })
    )
  daemon
    .command('stop')
    .description('kill all terminals and stop the daemon')
    .action(async () => {
      const c = await DaemonClient.tryConnect()

      if (!c) {
        console.log('daemon not running')

        return
      }

      const pid = await stopDaemon(c)
      console.log(`daemon stopped (pid ${pid})`)
    })
  daemon
    .command('restart')
    .description('stop the daemon, ending every terminal, and start it from this build')
    .action(async () => {
      const old = await DaemonClient.tryConnect()

      if (old) {
        const alive = (await old.request('term.list')).filter((t) => t.alive).length
        const pid = await stopDaemon(old)
        console.log(`daemon stopped (pid ${pid}), ended ${plural(alive, 'terminal')}`)
      }

      const c = await DaemonClient.connectOrStart()

      try {
        const info = await c.request('daemon.ping')
        console.log(`daemon running pid=${info.pid} version=${info.version} build=${info.buildId}`)
      } finally {
        c.close()
      }
    })
  daemon
    .command('status')
    .description('show whether the daemon is running')
    .option('--json', 'print JSON')
    .action(async (opts: { json?: boolean }) => {
      const paths = quePaths()
      const c = await DaemonClient.tryConnect(paths)

      if (!c) {
        if (opts.json) console.log(JSON.stringify({ running: false, socket: paths.socket }))
        else console.log(`daemon not running (socket ${describeSocket(paths)})`)
        process.exitCode = 3

        return
      }

      try {
        const info = await c.request('daemon.ping')
        const terms = await c.request('term.list')
        const alive = terms.filter((t) => t.alive).length
        const expectedBuildId = buildIdOf(resolveDaemonScript())
        const stale = daemonIsStale(info.buildId, expectedBuildId)

        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                running: true,
                pid: info.pid,
                version: info.version,
                buildId: info.buildId,
                expectedBuildId,
                stale,
                nodeVersion: info.nodeVersion,
                startedAt: info.startedAt,
                socket: paths.socket,
                terminals: { alive, total: terms.length }
              },
              null,
              2
            )
          )

          return
        }

        console.log(
          `daemon running pid=${info.pid} version=${info.version} node=${info.nodeVersion}`
        )
        console.log(`build ${info.buildId || 'unknown'}`)

        if (stale) console.log(staleDaemonHint(info.buildId, expectedBuildId))
        console.log(`started ${info.startedAt}`)
        console.log(`socket ${describeSocket(paths)}`)
        console.log(`terminals ${alive} alive / ${terms.length} total`)
      } finally {
        c.close()
      }
    })

  registerUpgradeCommand(daemon)
  registerLaunchdCommands(daemon)

  const term = program.command('term').description('manage terminals')
  term
    .command('list')
    .description('list terminals')
    .option('--json', 'print JSON')
    .action((opts: { json?: boolean }) =>
      withClient(async (c) => {
        const terms = await c.request('term.list')

        if (opts.json) printJson(terms)
        else printTerms(terms)
      }, false)
    )
  term
    .command('new')
    .description('create a terminal running a login shell')
    .option('--cwd <dir>', 'working directory (default: the current directory)')
    .option('--name <name>', 'display name')
    .action((opts: { cwd?: string; name?: string }) =>
      withClient(async (c) => {
        const cwd = opts.cwd ?? process.cwd()

        if (!fs.existsSync(cwd)) throw new Error(`no such directory: ${cwd}`)
        const cols = process.stdout.columns || 80
        const rows = process.stdout.rows || 24

        const { id } = await c.request('term.create', {
          cwd,
          name: opts.name,
          cols,
          rows
        })

        console.log(id)
      })
    )
  term
    .command('snapshot <id>')
    .description('print the terminal screen and scrollback')
    .option('--serialized', 'print the escape-sequence serialization instead of plain text')
    .action((id: string, opts: { serialized?: boolean }) =>
      withClient(async (c) => {
        const snap = await c.request('term.snapshot', { id })
        process.stdout.write(`${opts.serialized ? snap.serialized : snap.text}\n`)
      }, false)
    )
  term
    .command('kill <id>')
    .description('kill a terminal')
    .action((id: string) =>
      withClient(async (c) => {
        await c.request('term.kill', { id })
        console.log(`killed ${id}`)
      }, false)
    )
  term
    .command('attach <id>')
    .description('attach this TTY to a terminal (Ctrl-] detaches)')
    .action((id: string) => attach(id))

  registerWorkspaceCommands(program)
  registerTicketCommands(program)
  registerQuietCommands(program)
  registerReportCommand(program)
  registerUsageCommand(program)

  program
    .command('hook')
    .description('report a Claude Code hook event (stdin JSON) to the daemon; used by hooks.json')
    .action(() => {
      // Handled before parsing; listed here for --help.
    })

  program
    .command('statusline')
    .description(
      'report Claude plan usage (status line JSON on stdin) to the daemon, then run your own status line; used by hooks.json'
    )
    .action(() => {
      // Handled before parsing; listed here for --help.
    })

  program
    .command('doctor')
    .description('check the daemon, claude, gh, git, node, config, and the hooks wrapper')
    .action(async () => {
      process.exitCode = await runDoctor()
    })

  await program.parseAsync(process.argv)
}

main().catch((err) => {
  // Quiet hours: the daemon's one-line refusal, and a distinct exit code.
  if (err instanceof DaemonError && err.code === 'quiet_hours') {
    console.error(err.message)
    process.exit(3)
  }

  const msg =
    err instanceof DaemonError
      ? `${err.message} (${err.code})`
      : err instanceof CliError
        ? err.message
        : errorMessage(err)

  console.error(`que: ${msg}`)
  process.exit(1)
})
