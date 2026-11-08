// Quiet hours and config: `que unlock`, `que lock`, `que quiet status|start|end`,
// `que config get|set`.
import type { Command } from 'commander'
import { formatCountdown, hhmm } from '../shared/format'
import { combineConfigPatches, describeQuietHours, parseConfigAssignment } from '../shared/config'
import { editorName } from '../shared/editor-name'
import type { ConfigPatch, QuietState } from '../shared/types'
import { CliError, printJson, withClient } from './common'
import { errorMessage } from '../shared/errors.decode'

/** One line about quiet hours, for `que quiet status` and `que status`. */
export function describeQuietState(q: QuietState, now = Date.now()): string {
  // The window first: a manual quiet holds with quiet hours off.
  if (q.inQuietHours) {
    const until = q.windowEnd ? hhmm(Date.parse(q.windowEnd)) : '?'
    const head = `${q.kind === 'manual' ? 'quiet' : 'quiet hours'} until ${until}`

    if (q.unlockedUntil) {
      return `${head} · unlocked, ${formatCountdown(Date.parse(q.unlockedUntil) - now)} left`
    }

    return head
  }

  if (!q.enabled) return 'quiet hours off'

  return q.nextBoundary
    ? `work hours · quiet hours start ${hhmm(Date.parse(q.nextBoundary))}`
    : 'work hours'
}

function positiveMinutes(value: string): number {
  const n = Number(value)

  if (!Number.isFinite(n) || n <= 0) throw new CliError('minutes must be a positive number')

  return n
}

export function registerQuietCommands(program: Command): void {
  program
    .command('unlock [minutes]')
    .description(
      'unlock detail during quiet hours for a while (default: quiet_hours.unlock_minutes)'
    )
    .option('--why <text>', 'why, for the unlock log')
    .option('--json', 'print the quiet state as JSON')
    .action((minutes: string | undefined, opts: { why?: string; json?: boolean }) =>
      withClient(async (c) => {
        const q = await c.request('quiet.unlock', {
          minutes: minutes === undefined ? undefined : positiveMinutes(minutes),
          why: opts.why || undefined
        })

        if (opts.json) printJson(q)
        else if (!q.inQuietHours) console.log('not in quiet hours; nothing to unlock')
        else console.log(describeQuietState(q))
      })
    )

  program
    .command('lock')
    .description('end an unlock early')
    .option('--json', 'print the quiet state as JSON')
    .action((opts: { json?: boolean }) =>
      withClient(async (c) => {
        const q = await c.request('quiet.lock')

        if (opts.json) printJson(q)
        else console.log(describeQuietState(q))
      })
    )

  const quiet = program.command('quiet').description('quiet hours')
  quiet
    .command('status')
    .description('whether quiet hours are on, until when, and any unlock')
    .option('--json', 'print JSON')
    .action((opts: { json?: boolean }) =>
      withClient(async (c) => {
        const q = await c.request('quiet.state')

        if (opts.json) printJson(q)
        else console.log(describeQuietState(q))
      })
    )
  quiet
    .command('start [minutes]')
    .description('go quiet now, as in quiet hours, for a while (default 60 minutes, at most 720)')
    .option('--json', 'print the quiet state as JSON')
    .action((minutes: string | undefined, opts: { json?: boolean }) =>
      withClient(async (c) => {
        const q = await c.request('quiet.start', {
          minutes: minutes === undefined ? undefined : positiveMinutes(minutes)
        })

        if (opts.json) printJson(q)
        else if (q.kind === 'scheduled') console.log('already in quiet hours')
        else console.log(describeQuietState(q))
      })
    )
  quiet
    .command('end')
    .description('end a manual quiet early')
    .option('--json', 'print the quiet state as JSON')
    .action((opts: { json?: boolean }) =>
      withClient(async (c) => {
        const before = await c.request('quiet.state')
        const q = await c.request('quiet.end')

        if (opts.json) printJson(q)
        else if (before.kind !== 'manual') console.log('not in a manual quiet; nothing to end')
        else console.log(describeQuietState(q))
      })
    )

  const config = program.command('config').description('the user config')
  config
    .command('get')
    .description('print the config file path and the parsed config')
    .option('--json', 'print JSON')
    .action((opts: { json?: boolean }) =>
      withClient(async (c) => {
        const r = await c.request('config.get')

        if (opts.json) return printJson(r)
        const cfg = r.config
        console.log(`config ${r.path}`)
        console.log(`quiet hours     ${describeQuietHours(cfg.quietHours)}`)
        console.log(
          `notifications   chime on complete ${cfg.notifications.chimeOnComplete} · chime on needs input ${cfg.notifications.chimeOnNeedsInput} · chime in manual quiet ${cfg.notifications.chimeInManualQuiet} · morning summary ${cfg.notifications.morningSummary}`
        )
        console.log(`protected       ${cfg.protectedBranches.join(', ')}`)
        console.log(`instructions    ${cfg.instructionsFile ?? 'none'}`)
        console.log(`editor          ${cfg.editorApp ? editorName(cfg.editorApp) : 'none'}`)
      })
    )
  config
    .command('set <assignments...>')
    .description('set keys (dotted, e.g. quiet_hours.default=19:00,07:00) and reload the daemon')
    .option('--apply-tonight', "let a change that shortens tonight's quiet hours apply now")
    .option('--json', 'print the result as JSON')
    .action((assignments: string[], opts: { applyTonight?: boolean; json?: boolean }) =>
      withClient(async (c) => {
        let patch: ConfigPatch = {}

        for (const a of assignments) {
          try {
            patch = combineConfigPatches(patch, parseConfigAssignment(a))
          } catch (err) {
            throw new CliError(errorMessage(err))
          }
        }

        const r = await c.request('config.set', { patch, applyTonight: opts.applyTonight === true })

        if (opts.json) printJson(r)
        else console.log(`updated ${r.path}`)
      })
    )
}
