// The status engine's rules, as pure functions: hook events, terminal exits,
// clock ticks, and `claude agents --json` entries in; a workspace status out.
// Time is always passed in (`now`, epoch ms); nothing here reads the clock.
// A Stop that reports agent-like background tasks (subagents, workflows,
// teammates) still running keeps the workspace working, since they wake the
// session when they finish; shells and monitors are listed but do not count.
import { formatMinSec } from '../shared/format'
import type { HookBackgroundTask } from '../shared/protocol'
import type { BackgroundTask, StatusSummary, WorkspaceStatus } from '../shared/types'

export interface StatusState {
  status: WorkspaceStatus
  /** Set only while stuck: `no_heartbeat`, `setup_failed`, `preparation_failed`, `error:<kind>`. */
  reason: string | null
  /** When status or reason last changed. */
  statusAt: number
  /** Last sign of work (a working hook, or transcript growth or subagent hooks seen by the caller). */
  lastActivityAt: number | null
  sessionId: string | null
  /** When a main-session hook event last arrived; null if none ever did. */
  hookAt: number | null
  /** What the last main Stop (or SubagentStop) reported still running. */
  backgroundTasks: BackgroundTask[]
}

/** The subset of a hook payload the rules read. */
export interface HookPayload {
  session_id?: string
  agent_id?: string
  notification_type?: string
  error?: string
  background_tasks?: HookBackgroundTask[]
}

/** One entry of `claude agents --json`. */
export interface AgentEntry {
  cwd?: string
  status?: string
}

export type StatusInput =
  | { kind: 'hook'; event: string; payload: HookPayload }
  | { kind: 'terminal_exit' }
  | { kind: 'tick' }
  | { kind: 'agents_json'; entry: AgentEntry }
  | { kind: 'setup_done' }
  | { kind: 'setup_failed' }
  | { kind: 'preparation_failed' }
  | { kind: 'remove' }

export interface ReduceOptions {
  stallTimeoutMs: number
}

export const DEFAULT_STALL_TIMEOUT_MS = 5 * 60_000

/** `claude agents --json` may only override hook-derived state older than this. */
export const AGENTS_JSON_MIN_AGE_MS = 30_000

const WORKING_EVENTS = new Set([
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PreCompact'
])

// These wake the session when they finish, so a turn that ended while they run is not over;
// `shell` and `monitor` run for the life of a session and do not count.
const AGENT_LIKE_KINDS = new Set(['subagent', 'workflow', 'teammate'])

const NEEDS_INPUT_NOTIFICATIONS = new Set([
  'permission_prompt',
  'elicitation_dialog',
  'agent_needs_input'
])

export function initialState(now: number, status: WorkspaceStatus = 'preparing'): StatusState {
  return {
    status,
    reason: null,
    statusAt: now,
    lastActivityAt: null,
    sessionId: null,
    hookAt: null,
    backgroundTasks: []
  }
}

/**
 * The running entries of a reported `background_tasks` list, in reported order;
 * a task already known keeps its `since`. Nothing reported means nothing runs.
 * Returns `prev` itself when the list is unchanged, so callers compare by reference.
 */
export function mergeTasks(
  prev: BackgroundTask[],
  reported: HookBackgroundTask[] | undefined,
  now: number
): BackgroundTask[] {
  const known = new Map(prev.map((t) => [t.id, t.since]))

  const next = (reported ?? [])
    .filter((t) => t.status === 'running')
    .map((t) => ({
      id: t.id,
      kind: t.type,
      description: t.description ?? t.command ?? t.agent_type ?? t.type,
      since: known.get(t.id) ?? new Date(now).toISOString()
    }))

  return sameTasks(prev, next) ? prev : next
}

function sameTasks(a: BackgroundTask[], b: BackgroundTask[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (t, i) =>
        t.id === b[i].id &&
        t.kind === b[i].kind &&
        t.description === b[i].description &&
        t.since === b[i].since
    )
  )
}

function hasAgentLike(tasks: BackgroundTask[]): boolean {
  return tasks.some((t) => AGENT_LIKE_KINDS.has(t.kind))
}

function transition(
  state: StatusState,
  status: WorkspaceStatus,
  reason: string | null,
  now: number,
  extra: Partial<StatusState> = {}
): StatusState {
  const changed = state.status !== status || state.reason !== reason

  // An exited session runs nothing in the background.
  const backgroundTasks =
    extra.backgroundTasks ?? (status === 'exited' ? [] : state.backgroundTasks)

  return {
    ...state,
    ...extra,
    status,
    reason,
    statusAt: changed ? now : state.statusAt,
    backgroundTasks
  }
}

function onHook(state: StatusState, event: string, p: HookPayload, now: number): StatusState {
  // A subagent's hooks never move the workspace (the caller counts them as activity for the
  // stall tick); a SubagentStop's list is the parent's, so it refreshes the tasks.
  if (p.agent_id) {
    if (event !== 'SubagentStop' || !p.background_tasks) return state
    const tasks = mergeTasks(state.backgroundTasks, p.background_tasks, now)

    return tasks === state.backgroundTasks ? state : { ...state, backgroundTasks: tasks }
  }

  const seen: Partial<StatusState> = { hookAt: now, sessionId: p.session_id ?? state.sessionId }

  if (WORKING_EVENTS.has(event)) {
    return transition(state, 'working', null, now, { ...seen, lastActivityAt: now })
  }

  switch (event) {
    case 'SessionStart':
      // A session boundary that lands on idle: nothing from the last session still runs.
      return transition(state, 'idle', null, now, { ...seen, backgroundTasks: [] })
    case 'Stop': {
      const tasks = mergeTasks(state.backgroundTasks, p.background_tasks, now)

      return hasAgentLike(tasks)
        ? transition(state, 'working', null, now, {
            ...seen,
            lastActivityAt: now,
            backgroundTasks: tasks
          })
        : transition(state, 'idle', null, now, { ...seen, backgroundTasks: tasks })
    }

    case 'PermissionRequest':
      return transition(state, 'needs_input', null, now, seen)
    case 'Notification':
      if (p.notification_type && NEEDS_INPUT_NOTIFICATIONS.has(p.notification_type)) {
        return transition(state, 'needs_input', null, now, seen)
      }

      if (p.notification_type === 'idle_prompt') return transition(state, 'idle', null, now, seen)

      return { ...state, ...seen }
    case 'StopFailure':
      return transition(state, 'stuck', `error:${p.error || 'unknown'}`, now, seen)
    case 'SessionEnd':
      return transition(state, 'exited', null, now, seen)
    default:
      return { ...state, ...seen }
  }
}

function onAgentsEntry(state: StatusState, entry: AgentEntry, now: number): StatusState {
  if (state.hookAt !== null && now - state.hookAt <= AGENTS_JSON_MIN_AGE_MS) return { ...state }
  const s = (entry.status ?? '').toLowerCase()

  if (s.includes('wait') || s.includes('blocked') || s.includes('input')) {
    return transition(state, 'needs_input', null, now)
  }

  if (s === 'idle') {
    // The registry may report a main thread paused on its agents as idle.
    if (hasAgentLike(state.backgroundTasks)) return { ...state }

    return transition(state, 'idle', null, now)
  }

  if (s.includes('working') || s.includes('running') || s === 'busy') {
    return transition(state, 'working', null, now, { lastActivityAt: now })
  }

  return { ...state }
}

/** The next status of one workspace. Never mutates `state`. */
export function reduce(
  state: StatusState,
  input: StatusInput,
  now: number,
  opts: ReduceOptions = { stallTimeoutMs: DEFAULT_STALL_TIMEOUT_MS }
): StatusState {
  // A workspace being removed stays removing: its killed terminals and dying session report nothing.
  if (state.status === 'removing') return { ...state }

  switch (input.kind) {
    case 'hook':
      return onHook(state, input.event, input.payload, now)
    case 'terminal_exit':
      return transition(state, 'exited', null, now)
    case 'tick': {
      if (state.status !== 'working') return { ...state }
      const last = state.lastActivityAt ?? state.statusAt

      if (now - last > opts.stallTimeoutMs) return transition(state, 'stuck', 'no_heartbeat', now)

      return { ...state }
    }

    case 'agents_json':
      return onAgentsEntry(state, input.entry, now)
    case 'setup_done':
      // A session that started reporting during setup already moved the workspace on; leave it.
      if (state.status !== 'preparing') return { ...state }

      return transition(state, 'idle', null, now)
    case 'setup_failed':
      return transition(state, 'stuck', 'setup_failed', now)
    case 'preparation_failed':
      return transition(state, 'stuck', 'preparation_failed', now)
    case 'remove':
      // Its terminals are killed first, so nothing runs in the background any more.
      return transition(state, 'removing', null, now, { backgroundTasks: [] })
  }
}

const STATUSES: WorkspaceStatus[] = [
  'working',
  'idle',
  'needs_input',
  'stuck',
  'exited',
  'preparing',
  'removing'
]

/** Workspace counts per status. */
export function summarize(workspaces: ReadonlyArray<{ status: WorkspaceStatus }>): StatusSummary {
  const s = Object.fromEntries(STATUSES.map((k) => [k, 0])) as StatusSummary

  for (const w of workspaces) s[w.status] += 1

  return s
}

/** The menu-bar title: working, needing input, stuck. */
export function trayTitle(s: StatusSummary): string {
  return `● ${s.working} ▸ ${s.needs_input} ✕ ${s.stuck}`
}

/**
 * The menu-bar title with quiet hours folded in: while an unlock runs it
 * leads with the countdown (`🔓 14:32 · ● 3 ▸ 1 ✕ 0`); while quiet hours are
 * locked it drops the needs-input count (`● 3 ✕ 0`), since needs input is not
 * a night state; otherwise it is the plain counts.
 */
export function quietTrayTitle(
  s: StatusSummary,
  quiet: { inQuietHours: boolean; unlockedUntil: string | null } | null,
  now: number
): string {
  if (!quiet?.inQuietHours) return trayTitle(s)

  if (!quiet.unlockedUntil) return `● ${s.working} ✕ ${s.stuck}`

  return `🔓 ${formatMinSec(Date.parse(quiet.unlockedUntil) - now)} · ${trayTitle(s)}`
}
