// User config (~/.config/que/config.toml or $QUE_CONFIG) and the per-repo
// que.toml. Parsing is pure; loadConfig()/loadRepoConfig() only add file I/O.
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import {
  type ConfigPatch,
  HHMM,
  type JiraConfig,
  WEEKDAYS,
  type DayWindow,
  type NotificationsConfig,
  type PermissionMode,
  type QuietHoursConfig,
  type QuietWindow,
  type TerminalConfig,
  type UserConfig,
  type Weekday
} from './types'
import {
  configDefaults,
  defaultJira,
  defaultNotifications,
  defaultQuietHours,
  defaultTerminal
} from './config-defaults'
import { errorCode, errorMessage } from './errors.decode'

export {
  configDefaults,
  DEFAULT_JQL,
  DEFAULT_START_PROMPT,
  defaultJira,
  defaultNotifications,
  defaultQuietHours,
  defaultTerminal
} from './config-defaults'

import { patchPathOf } from './config-keys.decode'
import { mergeConfigPatch } from './config-patch.decode'

export { patchToToml } from './config-keys.decode'

export { mergeConfigPatch } from './config-patch.decode'

export type { PermissionMode, RepoEntry, UserConfig } from './types'

/** Claude Code permission modes que may pass with --permission-mode. */
export const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'dontAsk',
  'auto'
] as const satisfies readonly PermissionMode[]

/** The permission mode a session uses, and why it differs from what was asked, if it does. */
export interface PermissionChoice {
  mode: PermissionMode
  warning: string | null
}

/**
 * The permission mode for a workspace session: que.toml, else the user's
 * default, else acceptEdits. bypassPermissions needs both the repo and the
 * user to opt in.
 */
export function resolvePermissionMode(
  repo: { permissionMode?: PermissionMode },
  config: Pick<UserConfig, 'defaultPermissionMode' | 'allowBypassPermissions'>
): PermissionChoice {
  const wanted = repo.permissionMode ?? config.defaultPermissionMode ?? 'acceptEdits'

  if (wanted !== 'bypassPermissions') return { mode: wanted, warning: null }

  if (repo.permissionMode === 'bypassPermissions' && config.allowBypassPermissions) {
    return { mode: wanted, warning: null }
  }

  return {
    mode: 'acceptEdits',
    warning:
      'bypassPermissions needs permission_mode in que.toml and allow_bypass_permissions = true in the que config; running with acceptEdits'
  }
}

export interface ConfigError {
  /** Dotted key path, or '' for a syntax error. */
  key: string
  message: string
}

export type ConfigResult<T> = { ok: true; config: T } | { ok: false; errors: ConfigError[] }

export interface ConfigEnv {
  /** The resolved QUE_HOME. */
  queHome: string
}

export function defaultConfig(env: ConfigEnv): UserConfig {
  return configDefaults(join(env.queHome, 'worktrees'))
}

function parseTable(text: string): ConfigResult<Record<string, unknown>> {
  try {
    return { ok: true, config: parseToml(text) as Record<string, unknown> }
  } catch (err) {
    return { ok: false, errors: [{ key: '', message: errorMessage(err).split('\n')[0] }] }
  }
}

type Table = Record<string, unknown>

/**
 * The value at `key` when `ok` accepts it. An absent key is undefined; a value
 * `ok` rejects is undefined too, with `message` reported under the key.
 */
function field<T>(
  t: Table,
  key: string,
  errors: ConfigError[],
  ok: (v: unknown) => v is T,
  message: string
): T | undefined {
  const v = t[key]

  if (v === undefined) return undefined

  if (!ok(v)) {
    errors.push({ key, message })

    return undefined
  }

  return v
}

/** Any non-array object; a TOML table, or a date where one should be. */
function isObject(v: unknown): v is Table {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** `v` as a table, or undefined with `message` reported under `key`. */
function table(
  v: unknown,
  key: string,
  errors: ConfigError[],
  message = 'must be a table'
): Table | undefined {
  if (isObject(v)) return v
  errors.push({ key, message })

  return undefined
}

/** Reports each of `sub` under `prefix` (the section's dotted key and a dot). */
function prefixed(sub: ConfigError[], prefix: string, errors: ConfigError[]): void {
  for (const e of sub) errors.push({ key: `${prefix}${e.key}`, message: e.message })
}

const isPositive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0

const isAtLeastOne = (v: unknown): v is number => isPositive(v) && v >= 1

const isString = (v: unknown): v is string => typeof v === 'string'

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0

const isBool = (v: unknown): v is boolean => typeof v === 'boolean'

const isStringList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string')

const isPermissionMode = (v: unknown): v is PermissionMode =>
  typeof v === 'string' && (PERMISSION_MODES as readonly string[]).includes(v)

function positive(t: Table, key: string, errors: ConfigError[]): number | undefined {
  return field(t, key, errors, isPositive, 'must be a positive number')
}

function optionalString(t: Table, key: string, errors: ConfigError[]): string | undefined {
  return field(t, key, errors, isNonEmptyString, 'must be a non-empty string')
}

function optionalBool(t: Table, key: string, errors: ConfigError[]): boolean | undefined {
  return field(t, key, errors, isBool, 'must be true or false')
}

function stringList(t: Table, key: string, errors: ConfigError[]): string[] | undefined {
  return field(t, key, errors, isStringList, 'must be a list of strings')
}

function permissionMode(t: Table, key: string, errors: ConfigError[]): PermissionMode | undefined {
  return field(t, key, errors, isPermissionMode, `must be one of ${PERMISSION_MODES.join(', ')}`)
}

/** `["19:00", "07:00"]` → a window; reports bad times and start == end. */
function quietWindow(v: unknown, key: string, errors: ConfigError[]): QuietWindow | undefined {
  if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => typeof x === 'string')) {
    errors.push({ key, message: 'must be ["HH:MM", "HH:MM"] (start, end)' })

    return undefined
  }

  const [start, end] = v as string[]
  const bad = [start, end].filter((t) => !HHMM.test(t))

  if (bad.length > 0) {
    errors.push({ key, message: `${bad.join(', ')} is not a 24-hour HH:MM time` })

    return undefined
  }

  if (start === end) {
    errors.push({ key, message: 'start and end must differ' })

    return undefined
  }

  return { start, end }
}

const QUIET_KEYS = new Set<string>(['enabled', 'default', 'unlock_minutes', ...WEEKDAYS])

function parseQuietHours(v: unknown, errors: ConfigError[]): QuietHoursConfig {
  const q = defaultQuietHours()

  if (v === undefined) return q
  const t = table(v, 'quiet_hours', errors)

  if (!t) return q
  const sub: ConfigError[] = []

  for (const k of Object.keys(t)) {
    if (!QUIET_KEYS.has(k)) sub.push({ key: k, message: 'is not a quiet_hours key' })
  }

  q.enabled = optionalBool(t, 'enabled', sub) ?? q.enabled

  if (t.default !== undefined) q.default = quietWindow(t.default, 'default', sub) ?? q.default
  q.unlockMinutes = positive(t, 'unlock_minutes', sub) ?? q.unlockMinutes

  for (const day of WEEKDAYS) {
    const d = t[day]

    if (d === undefined) continue

    if (d === 'none') q.days[day] = 'none'
    else {
      const w = quietWindow(d, day, sub)

      if (w) q.days[day] = w
    }
  }

  prefixed(sub, 'quiet_hours.', errors)

  return q
}

const isNonBlankString = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

// Unlike positive(), an infinite poll interval passes.
const isAboveZero = (v: unknown): v is number => typeof v === 'number' && v > 0

function parseJira(v: unknown, errors: ConfigError[]): JiraConfig {
  const j = defaultJira()

  if (v === undefined) return j
  const t = table(v, 'jira', errors)

  if (!t) return j
  const sub: ConfigError[] = []
  const text = (key: string) => field(t, key, sub, isNonBlankString, 'must be a non-empty string')

  j.jql = text('jql') ?? j.jql
  j.startPrompt = text('start_prompt') ?? j.startPrompt
  const site = text('site')

  if (site !== undefined) {
    const host = site
      .trim()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')

    if (host) j.site = host
    else sub.push({ key: 'site', message: 'must be a host like team.example.net' })
  }

  j.pollMinutes =
    field(t, 'poll_minutes', sub, isAboveZero, 'must be a positive number') ?? j.pollMinutes

  if (t.projects !== undefined) {
    const projects = table(
      t.projects,
      'projects',
      sub,
      'must be a table of tracker key = que project'
    )

    for (const [k, name] of Object.entries(projects ?? {})) {
      if (isNonBlankString(name)) j.projects[k] = name
      else sub.push({ key: `projects.${k}`, message: 'must be a que project name' })
    }
  }

  prefixed(sub, 'jira.', errors)

  return j
}

function parseNotifications(v: unknown, errors: ConfigError[]): NotificationsConfig {
  const n = defaultNotifications()

  if (v === undefined) return n
  const t = table(v, 'notifications', errors)

  if (!t) return n
  const sub: ConfigError[] = []
  n.chimeOnComplete = optionalBool(t, 'chime_on_complete', sub) ?? n.chimeOnComplete
  n.chimeOnNeedsInput = optionalBool(t, 'chime_on_needs_input', sub) ?? n.chimeOnNeedsInput
  n.chimeInManualQuiet = optionalBool(t, 'chime_in_manual_quiet', sub) ?? n.chimeInManualQuiet
  n.morningSummary = optionalBool(t, 'morning_summary', sub) ?? n.morningSummary

  prefixed(sub, 'notifications.', errors)

  return n
}

function parseTerminal(v: unknown, errors: ConfigError[]): TerminalConfig {
  const c = defaultTerminal()

  if (v === undefined) return c
  const t = table(v, 'terminal', errors)

  if (!t) return c
  const sub: ConfigError[] = []
  c.optionAsMeta = optionalBool(t, 'option_as_meta', sub) ?? c.optionAsMeta

  prefixed(sub, 'terminal.', errors)

  return c
}

/**
 * `editor_app`: an application bundle by its absolute path, a trailing `/` dropped. Empty means
 * unset, so `que config set editor_app=` clears it.
 */
function editorApp(t: Table, errors: ConfigError[]): string | undefined {
  const message = 'must be an absolute path to an application (.app)'
  const text = field(t, 'editor_app', errors, isString, message)?.trim()

  if (!text) return undefined
  const app = text.replace(/\/+$/, '')

  if (app.startsWith('/') && /\.app$/i.test(app)) return app
  errors.push({ key: 'editor_app', message })

  return undefined
}

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? join(os.homedir(), p.slice(1)) : p
}

/** Parses config.toml text; unknown keys are ignored, bad values reported per key. */
export function parseConfig(text: string, env: ConfigEnv): ConfigResult<UserConfig> {
  const parsed = parseTable(text)

  if (!parsed.ok) return parsed
  const t = parsed.config
  const errors: ConfigError[] = []
  const config = defaultConfig(env)

  const root = optionalString(t, 'worktree_root', errors)

  if (root) config.worktreeRoot = expandHome(root)
  config.stallTimeoutMinutes =
    positive(t, 'stall_timeout_minutes', errors) ?? config.stallTimeoutMinutes
  config.teardownTimeoutSeconds =
    field(t, 'teardown_timeout_seconds', errors, isAtLeastOne, 'must be a number of at least 1') ??
    config.teardownTimeoutSeconds
  config.statusPollSeconds = positive(t, 'status_poll_seconds', errors) ?? config.statusPollSeconds
  config.prPollSeconds = positive(t, 'pr_poll_seconds', errors) ?? config.prPollSeconds
  config.defaultPermissionMode = permissionMode(t, 'default_permission_mode', errors)
  config.allowBypassPermissions =
    optionalBool(t, 'allow_bypass_permissions', errors) ?? config.allowBypassPermissions
  config.protectedBranches = stringList(t, 'protected_branches', errors) ?? config.protectedBranches
  // Empty means unset, so `que config set instructions_file=` clears it.
  const instructions = field(t, 'instructions_file', errors, isString, 'must be a path')?.trim()

  if (instructions) config.instructionsFile = expandHome(instructions)

  const editor = editorApp(t, errors)

  if (editor) config.editorApp = editor

  config.quietHours = parseQuietHours(t.quiet_hours, errors)
  config.notifications = parseNotifications(t.notifications, errors)
  config.terminal = parseTerminal(t.terminal, errors)
  config.jira = parseJira(t.jira, errors)
  const startPrompt = t.start_prompt

  if (startPrompt !== undefined) {
    // A blank prompt is off, like an unset one.
    if (typeof startPrompt !== 'string') {
      errors.push({ key: 'start_prompt', message: 'must be a string' })
    } else config.startPrompt = startPrompt.trim() === '' ? '' : startPrompt
  }

  if (t.repos !== undefined) {
    const repos = table(t.repos, 'repos', errors)

    for (const [name, entry] of Object.entries(repos ?? {})) {
      const e = table(entry, `repos.${name}`, errors)

      if (!e) continue
      const sub: ConfigError[] = []
      const path = optionalString(e, 'path', sub)

      if (e.path === undefined) sub.push({ key: 'path', message: 'is required' })
      const defaultBranch = optionalString(e, 'default_branch', sub)

      prefixed(sub, `repos.${name}.`, errors)

      if (path) config.repos[name] = { path: expandHome(path), defaultBranch }
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, config }
}

export function configPath(): string {
  return process.env.QUE_CONFIG || join(os.homedir(), '.config', 'que', 'config.toml')
}

/** Reads and parses the user config; a missing file is the defaults. */
export function loadConfig(env: ConfigEnv, path: string = configPath()): ConfigResult<UserConfig> {
  let text: string

  try {
    text = fs.readFileSync(path, 'utf8')
  } catch (err) {
    if (errorCode(err) === 'ENOENT') {
      return { ok: true, config: defaultConfig(env) }
    }

    return { ok: false, errors: [{ key: '', message: errorMessage(err) }] }
  }

  return parseConfig(text, env)
}

export function formatConfigErrors(errors: ConfigError[]): string {
  return errors.map((e) => (e.key ? `${e.key}: ${e.message}` : e.message)).join('; ')
}

/** The config file as a plain TOML table; a missing file is an empty table. */
export function readRawConfig(path: string = configPath()): ConfigResult<Record<string, unknown>> {
  let text: string

  try {
    text = fs.readFileSync(path, 'utf8')
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return { ok: true, config: {} }

    return { ok: false, errors: [{ key: '', message: errorMessage(err) }] }
  }

  return parseTable(text)
}

/** TOML text for a table. Comments in the original file are not preserved. */
export function stringifyConfig(raw: Record<string, unknown>): string {
  return stringifyToml(raw)
}

/** Combines two patches (the later wins, sections combine key by key), keeping `null` (a clear) as a value. */
export function combineConfigPatches(a: ConfigPatch, b: ConfigPatch): ConfigPatch {
  return mergeConfigPatch(a, b, true) as ConfigPatch
}

/** Keys whose value is a list even when `que config set` is given one item. */
const LIST_KEYS = new Set(['protected_branches', 'quiet_hours.default'])

/**
 * `que config set key=value`: the key as the config file spells it (dotted, e.g.
 * `quiet_hours.unlock_minutes`) mapped to a typed patch, the value read as a
 * boolean, a number, `null` (clear), a comma list, or else a string. A quiet
 * hours window is written `start,end`; a weekday may also be `none`.
 */
export function parseConfigAssignment(arg: string): ConfigPatch {
  const eq = arg.indexOf('=')

  if (eq <= 0) throw new Error(`expected key=value, got ${JSON.stringify(arg)}`)
  const key = arg.slice(0, eq).trim()
  const text = arg.slice(eq + 1).trim()

  if (key.split('.').some((p) => p === '')) throw new Error(`invalid key ${JSON.stringify(key)}`)

  const scalar = (s: string): boolean | number | string => {
    if (s === 'true') return true

    if (s === 'false') return false

    if (s !== '' && Number.isFinite(Number(s))) return Number(s)

    return s
  }

  let value: unknown

  if (text === 'null') value = null
  else if (text.includes(',')) value = text.split(',').map((x) => x.trim())
  else if (LIST_KEYS.has(key)) value = [text]
  else value = scalar(text)
  const { path, window } = patchPathOf(key)

  // The CLI only turns `a,b` into a window; the daemon refuses a bad one when it reads the file.
  if (window && Array.isArray(value)) {
    if (value.length !== 2) throw new Error(`${key}: must be ["HH:MM", "HH:MM"] (start, end)`)
    value = { start: String(value[0]), end: String(value[1]) }
  }

  const patch: Record<string, unknown> = {}
  let at = patch

  for (const p of path.slice(0, -1)) {
    const next: Record<string, unknown> = {}
    at[p] = next
    at = next
  }

  at[path[path.length - 1]] = value

  return patch as ConfigPatch
}

/** A one-line summary of the quiet-hours config for `que doctor` and `que quiet status`. */
export function describeQuietHours(q: QuietHoursConfig): string {
  if (!q.enabled) return 'off'

  const days = (Object.entries(q.days) as Array<[Weekday, DayWindow]>).map(([d, w]) =>
    w === 'none' ? `${d} none` : `${d} ${w.start}-${w.end}`
  )

  return [
    `${q.default.start}-${q.default.end}`,
    ...(days.length > 0 ? [`overrides: ${days.join(', ')}`] : []),
    `unlock ${q.unlockMinutes} min`
  ].join(' · ')
}

// ---- que.toml ---------------------------------------------------------------

export interface RepoConfig {
  /** Shell command run inside a new worktree. */
  setup?: string
  /** Shell command run inside a worktree before it is removed. */
  teardown?: string
  defaultBranch?: string
  /** Gitignored paths copied from the main checkout into new worktrees. */
  worktreeInclude: string[]
  /** Permission mode for the repo's workspace sessions. */
  permissionMode?: PermissionMode
}

/** Parses a .worktreeinclude file: one path per line, `#` comments, blanks skipped. */
export function parseWorktreeInclude(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
}

export function parseRepoConfig(text: string, includeFile = ''): ConfigResult<RepoConfig> {
  const parsed = parseTable(text)

  if (!parsed.ok) return parsed
  const t = parsed.config
  const errors: ConfigError[] = []

  const config: RepoConfig = {
    setup: optionalString(t, 'setup', errors),
    teardown: optionalString(t, 'teardown', errors),
    defaultBranch: optionalString(t, 'default_branch', errors),
    worktreeInclude: [],
    permissionMode: permissionMode(t, 'permission_mode', errors)
  }

  config.worktreeInclude.push(...(stringList(t, 'worktree_include', errors) ?? []))

  for (const p of parseWorktreeInclude(includeFile)) {
    if (!config.worktreeInclude.includes(p)) config.worktreeInclude.push(p)
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, config }
}

function readOptional(path: string): string {
  try {
    return fs.readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** Reads `<repo>/que.toml` and `<repo>/.worktreeinclude`; both optional. */
export function loadRepoConfig(repo: string): ConfigResult<RepoConfig> {
  return parseRepoConfig(
    readOptional(join(repo, 'que.toml')),
    readOptional(join(repo, '.worktreeinclude'))
  )
}
