// Interactive Claude sessions that come back after a daemon restart. While the
// daemon runs it keeps a record of every terminal in which a session is live,
// as the hooks report it: written on SessionStart, cleared on SessionEnd, when
// the terminal exits, and when it is killed. A workspace terminal's entry names
// the workspace; a loose terminal's names the folder the session started in,
// since `claude --resume` finds a session by its project folder. The record is
// persisted as it changes, so a crash leaves it as current as a clean stop.
// The next daemon takes the record at start: each entry is consumed once and,
// unless its workspace (or folder) is gone, reopened as a terminal in the
// workspace (or a loose one in the folder) that types `claude --resume
// <session>`. While quiet hours are locked nothing is opened; the entries wait
// for the unlock (or the next start).
import type { HookEvent } from '../shared/protocol'
import type { Workspace } from '../shared/types'
import { errorMessage } from '../shared/errors.decode'
import { decodeLiveSessions } from './live-sessions.decode'
import type { Store } from './store'

/**
 * A terminal in which a Claude session is live: a workspace's, or a loose
 * terminal's, which keeps the folder the session started in instead.
 */
export type LiveSession =
  | { workspaceId: string; terminalId: string; sessionId: string; cwd?: undefined }
  | { workspaceId?: undefined; terminalId: string; sessionId: string; cwd: string }

/** What changes the record: a hook from a session, or a terminal that ended or was killed. */
export type LiveInput =
  | {
      kind: 'hook'
      /** The workspace the hook fired in; none for a loose terminal. */
      workspaceId?: string
      /** The terminal the hook fired in (QUE_TERMINAL_ID), when it fired in one. */
      terminalId?: string
      payload: HookEvent
    }
  | { kind: 'terminal_gone'; terminalId: string }

/**
 * The record after one input. Only a main session's start in a daemon terminal
 * adds an entry (replacing the terminal's earlier one): a workspace's, or a
 * loose one in the folder the start reports. Its end, or the terminal going
 * away, removes it. Never mutates `live`; returns it unchanged when nothing
 * changed.
 */
export function trackLive(live: readonly LiveSession[], input: LiveInput): readonly LiveSession[] {
  if (input.kind === 'terminal_gone') {
    return without(live, (e) => e.terminalId === input.terminalId)
  }

  const { payload, terminalId, workspaceId } = input

  if (payload.agent_id || !terminalId) return live

  switch (payload.hook_event_name) {
    case 'SessionStart': {
      const sessionId = payload.session_id

      // A loose session without a folder could not be resumed anywhere.
      if (workspaceId === undefined && !payload.cwd) return live

      const entry: LiveSession =
        workspaceId !== undefined
          ? { workspaceId, terminalId, sessionId }
          : { terminalId, sessionId, cwd: payload.cwd }

      const same = live.find((e) => e.terminalId === terminalId)

      if (
        same &&
        same.sessionId === sessionId &&
        same.workspaceId === entry.workspaceId &&
        same.cwd === entry.cwd
      ) {
        return live
      }

      return [...live.filter((e) => e.terminalId !== terminalId), entry]
    }

    case 'SessionEnd':
      return without(live, (e) => e.terminalId === terminalId && e.sessionId === payload.session_id)

    default:
      return live
  }
}

function without(
  live: readonly LiveSession[],
  drop: (e: LiveSession) => boolean
): readonly LiveSession[] {
  return live.some(drop) ? live.filter((e) => !drop(e)) : live
}

/** What a restore looks up: the workspaces, and whether a loose session's folder is still there. */
export interface RestoreLookup {
  workspace: (id: string) => Workspace | undefined
  folderExists: (path: string) => boolean
}

export interface RestorePlan {
  resume: LiveSession[]
  skip: Array<{ entry: LiveSession; why: string }>
}

/**
 * Which of a previous daemon's sessions to resume: one per session id, workspace
 * and loose entries alike, not already live again, and each where it can still
 * run: a workspace that exists and is not archived or being removed, or a loose
 * session's folder that is still there.
 */
export function planRestore(
  pending: readonly LiveSession[],
  lookup: RestoreLookup,
  liveSessionIds: ReadonlySet<string>
): RestorePlan {
  const plan: RestorePlan = { resume: [], skip: [] }
  const taken = new Set(liveSessionIds)

  for (const entry of pending) {
    const why =
      whyNot(entry, lookup) ?? (taken.has(entry.sessionId) ? 'the session is already live' : null)

    if (why) {
      plan.skip.push({ entry, why })
      continue
    }

    taken.add(entry.sessionId)
    plan.resume.push(entry)
  }

  return plan
}

/** Why the entry has nowhere to resume; null when it has. */
function whyNot(entry: LiveSession, lookup: RestoreLookup): string | null {
  if (entry.workspaceId === undefined) {
    return lookup.folderExists(entry.cwd) ? null : 'the folder is gone'
  }

  const ws = lookup.workspace(entry.workspaceId)

  if (!ws) return 'the workspace is gone'

  if (ws.archivedAt) return 'the workspace is archived'

  if (ws.status === 'removing') return 'the workspace is being removed'

  return null
}

/** How the log names where a session ran. */
function where(e: LiveSession): string {
  return e.workspaceId !== undefined ? `of workspace ${e.workspaceId}` : `from ${e.cwd}`
}

export interface LiveSessionsOptions extends RestoreLookup {
  /** The record as the previous daemon left it. */
  load: () => LiveSession[]
  /** Persists the whole record (this daemon's live sessions and those still to restore). */
  save: (entries: LiveSession[]) => void
  /** Quiet hours are on and not unlocked: no terminal may be opened. */
  locked: () => boolean
  /**
   * The terminal is alive in this daemon and belongs to the workspace, or, with
   * no workspace, is a loose terminal.
   */
  ownsTerminal: (terminalId: string, workspaceId: string | undefined) => boolean
  /**
   * Opens a terminal that resumes the session, in the workspace or a loose one
   * in the session's folder; returns its id.
   */
  resume: (entry: LiveSession) => string
  /** A session went live in the terminal (its start hook landed). */
  onLive?: (terminalId: string) => void
  log: (msg: string) => void
}

/** The record of live sessions, and their restore at daemon start or at the next unlock. */
export class LiveSessions {
  /** This daemon's live sessions. */
  private live: readonly LiveSession[] = []
  /** The previous daemon's, not yet restored (kept while quiet hours are locked). */
  private pending: LiveSession[] = []
  private running = false

  constructor(private o: LiveSessionsOptions) {}

  /**
   * Takes the previous daemon's record. An entry whose terminal is alive in this
   * daemon came over with it (a handoff) and is still live; the rest are restored,
   * unless quiet hours are locked.
   */
  start(): void {
    this.running = true
    const stored = this.o.load()
    this.live = stored.filter((e) => this.o.ownsTerminal(e.terminalId, e.workspaceId))
    this.pending = stored.filter((e) => !this.live.includes(e))

    if (this.live.length > 0) {
      this.o.log(`live sessions: ${this.live.length} session(s) came over with their terminals`)
    }

    if (this.pending.length > 0 && this.o.locked()) {
      this.o.log(
        `live sessions: quiet hours are locked; ${this.pending.length} session(s) wait for the unlock`
      )

      return
    }

    this.restore()
  }

  /**
   * Freezes the record before the daemon tears its terminals down: what shutdown
   * ends is exactly what the next daemon restores.
   */
  stop(): void {
    this.running = false
  }

  /** Quiet hours are no longer locked: restores whatever was kept for the unlock. */
  unlocked(): void {
    if (this.running && !this.o.locked()) this.restore()
  }

  /**
   * A hook from `que hook`, from a workspace or (with none) a loose terminal; one
   * naming a terminal this daemon does not own there counts as from none.
   */
  hook(workspaceId: string | undefined, terminalId: string | undefined, payload: HookEvent): void {
    const term = terminalId && this.o.ownsTerminal(terminalId, workspaceId) ? terminalId : undefined

    this.apply({ kind: 'hook', workspaceId, terminalId: term, payload })
  }

  /** A main Claude session is live in the terminal. */
  isLive(terminalId: string): boolean {
    return this.live.some((e) => e.terminalId === terminalId)
  }

  /** The terminal exited or was killed. */
  terminalGone(terminalId: string): void {
    this.apply({ kind: 'terminal_gone', terminalId })
  }

  private apply(input: LiveInput): void {
    if (!this.running) return
    const next = trackLive(this.live, input)

    if (next === this.live) return
    const started = next.filter((e) => !this.live.includes(e))

    this.live = next
    this.persist()

    for (const e of started) this.o.onLive?.(e.terminalId)
  }

  private persist(): void {
    try {
      this.o.save([...this.pending, ...this.live])
    } catch (err) {
      this.o.log(`live sessions: saving the record failed: ${errorMessage(err)}`)
    }
  }

  /** Consumes every pending entry first (none is ever resumed twice), then resumes the plan. */
  private restore(): void {
    if (this.pending.length === 0) return
    const batch = this.pending
    this.pending = []
    this.persist()
    const plan = planRestore(batch, this.o, new Set(this.live.map((e) => e.sessionId)))

    for (const { entry, why } of plan.skip) {
      this.o.log(`live sessions: skipped session ${entry.sessionId} ${where(entry)}: ${why}`)
    }

    for (const entry of plan.resume) {
      try {
        const terminalId = this.o.resume(entry)
        this.o.log(
          `live sessions: resuming session ${entry.sessionId} ${where(entry)} in terminal ${terminalId}`
        )
      } catch (err) {
        this.o.log(
          `live sessions: could not resume session ${entry.sessionId} ${where(entry)}: ${errorMessage(err)}`
        )
      }
    }
  }
}

/** The kv key the record is kept under. */
const KV_KEY = 'live_sessions'

/** The record's persistence in the store's kv table. */
export function storedLiveSessions(store: Store): Pick<LiveSessionsOptions, 'load' | 'save'> {
  return {
    load: () => decodeLiveSessions(store.getKv(KV_KEY)),
    save: (entries) => store.setKv(KV_KEY, entries.length > 0 ? JSON.stringify(entries) : null)
  }
}
