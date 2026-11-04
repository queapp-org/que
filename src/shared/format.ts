// Pure text formatters shared by the daemon, the CLI and the renderer: money,
// lengths of time, ages, and wall-clock times. No Node imports.
import type { PreparationStep, RemovalStep } from './types'

/** `$0.42`; whole cents, never `$0.4200001`. */
export function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`
}

export interface DurationStyle {
  /** Zero-pad the second unit: `3m 05s`, `2h 07m` (the default) or `3m 5s`, `2h 7m`. */
  pad?: boolean
  /** Show seconds past the first minute: `3m 05s` (the default) or `3m`. */
  seconds?: boolean
  /** Truncate to whole seconds instead of rounding. */
  floor?: boolean
}

/**
 * A length of time in ms: `42s`, `3m 05s`, `2h 07m` by default. Without
 * `seconds` the minutes are whole minutes (`12m`), and seconds show only under one.
 */
export function formatDuration(ms: number, style: DurationStyle = {}): string {
  const { pad = true, seconds = true, floor = false } = style
  const s = Math.max(0, (floor ? Math.floor : Math.round)(ms / 1000))
  const m = seconds ? Math.floor(s / 60) : Math.floor(Math.max(0, ms) / 60_000)
  const two = (n: number): string => (pad ? String(n).padStart(2, '0') : String(n))

  if (m === 0) return `${s}s`

  if (m < 60) return seconds ? `${m}m ${two(s % 60)}s` : `${m}m`

  return `${Math.floor(m / 60)}h ${two(m % 60)}m`
}

/** The ms between two ISO timestamps; null when either is missing or unparsable. */
export function spanMs(from: string | null, to: string | null): number | null {
  const start = from ? Date.parse(from) : Number.NaN
  const end = to ? Date.parse(to) : Number.NaN

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null

  return end - start
}

/**
 * The span between two ISO timestamps (a check's start and finish) as
 * `formatDuration` writes it; empty when either is unknown.
 */
export function formatSpan(from: string | null, to: string | null, style?: DurationStyle): string {
  const ms = spanMs(from, to)

  return ms === null ? '' : formatDuration(ms, style)
}

/** `42s`, `5m`, `3h`, `2d` (each followed by `suffix`, such as ` ago`); `-` without a timestamp. */
export function formatAge(iso: string | null, now: number, suffix = ''): string {
  if (!iso) return '-'
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000))

  if (s < 60) return `${s}s${suffix}`

  if (s < 3600) return `${Math.floor(s / 60)}m${suffix}`

  if (s < 86_400) return `${Math.floor(s / 3600)}h${suffix}`

  return `${Math.floor(s / 86_400)}d${suffix}`
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** `HH:MM` in local time. */
export function hhmm(t: number): string {
  const d = new Date(t)

  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** `14:32` (minutes:seconds) for a countdown; `1:02:03` past an hour. */
export function formatCountdown(msLeft: number): string {
  const s = Math.max(0, Math.ceil(msLeft / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = pad2(s % 60)

  return h > 0 ? `${h}:${pad2(m)}:${sec}` : `${m}:${sec}`
}

/** `05:03`: a countdown as zero-padded minutes and seconds, minutes uncapped (`75:00`). */
export function formatMinSec(msLeft: number): string {
  const s = Math.max(0, Math.ceil(msLeft / 1000))

  return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`
}

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday'
] as const

/** `Mon 09:00`: the short weekday and the clock, local time. */
export function formatWeekdayClock(t: number): string {
  return `${WEEKDAY_NAMES[new Date(t).getDay()].slice(0, 3)} ${hhmm(t)}`
}

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
] as const

/** Local midnight of the day `t` falls on. */
function dayStart(t: number): number {
  const d = new Date(t)

  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/**
 * When a window began, read from `now`: `since 19:00` the same day, `since
 * 19:00 yesterday`, `since 19:00 Tuesday` within the last six days, else
 * `since 19:00 on 3 Oct`. English names from fixed tables, never the locale.
 */
export function formatSince(sinceMs: number, nowMs: number): string {
  const clock = `since ${hhmm(sinceMs)}`
  // Rounded, so a day with a daylight-saving shift still counts as one.
  const days = Math.round((dayStart(nowMs) - dayStart(sinceMs)) / 86_400_000)

  if (days <= 0) return clock

  if (days === 1) return `${clock} yesterday`

  const d = new Date(sinceMs)

  if (days <= 6) return `${clock} ${WEEKDAY_NAMES[d.getDay()]}`

  return `${clock} on ${d.getDate()} ${MONTH_NAMES[d.getMonth()]}`
}

/** A count with its noun, an s added past one: "3 terminals", "1 terminal". */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

const REMOVAL_STEP_LABELS: Record<RemovalStep, string> = {
  terminals: 'killing terminals',
  teardown: 'running teardown',
  worktree: 'removing worktree',
  branch: 'deleting branch'
}

/** What a removal step is doing, as the app and the CLI say it: `running teardown`. */
export function removalStepLabel(step: RemovalStep): string {
  return REMOVAL_STEP_LABELS[step]
}

const PREPARATION_STEP_LABELS: Record<PreparationStep, string> = {
  fetch: 'fetching origin',
  worktree: 'creating worktree',
  setup: 'running setup',
  claude: 'starting Claude'
}

/** What a preparation step is doing, as the app says it: `running setup`. */
export function preparationStepLabel(step: PreparationStep): string {
  return PREPARATION_STEP_LABELS[step]
}

/** How long a finished removal step took: tenths under ten seconds (`0.1s`, `2.4s`), else `12s`, `1m 05s`. */
export function formatStepDuration(ms: number): string {
  const tenths = Math.round(Math.max(0, ms) / 100)

  return tenths < 100 ? `${(tenths / 10).toFixed(1)}s` : formatDuration(ms)
}
