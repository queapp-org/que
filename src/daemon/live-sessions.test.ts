import { describe, expect, it } from 'vitest'
import { decodeLiveSessions } from './live-sessions.decode'
import {
  type LiveInput,
  type LiveSession,
  LiveSessions,
  planRestore,
  trackLive
} from './live-sessions'
import { makeHookEvent, makeWorkspace } from '../testing/fixtures'
import type { Workspace } from '../shared/types'

const WS = 'ws_01hzx3k9c2qf'
const TERM = '5f0c2a7e-4b1d-4c9e-9a3f-2d8e6b1c7a40'
const OTHER_TERM = '9b3e1d6c-2a4f-4e8b-8c1d-7f2a5e9b3c61'
const SESSION = '3c9e7b21-8d4a-4f6e-b2c1-9a7d5e3f1b08'

/** A loose terminal (the sidebar's Sessions), in no workspace. */
const LOOSE_TERM = 'c2e8a4f1-7d3b-4a6e-b9c5-1f8d3e7a2b46'

/** Where a loose session started: the user cd'd here after the terminal opened in ~. */
const NOTES = '/Users/dev/notes/meeting-prep'

/** A SessionStart from `terminalId`, or from no terminal when it is null. */
function start(sessionId = SESSION, terminalId: string | null = TERM): LiveInput {
  return {
    kind: 'hook',
    workspaceId: WS,
    terminalId: terminalId ?? undefined,
    payload: makeHookEvent('SessionStart', { session_id: sessionId, source: 'startup' })
  }
}

function end(sessionId = SESSION, terminalId = TERM): LiveInput {
  return {
    kind: 'hook',
    workspaceId: WS,
    terminalId,
    payload: makeHookEvent('SessionEnd', { session_id: sessionId })
  }
}

/** A hook from a session in the loose terminal, which names no workspace. */
function loose(name: 'SessionStart' | 'SessionEnd', sessionId = SESSION, cwd = NOTES): LiveInput {
  return {
    kind: 'hook',
    terminalId: LOOSE_TERM,
    payload: makeHookEvent(name, { session_id: sessionId, cwd })
  }
}

const run = (inputs: LiveInput[]): readonly LiveSession[] =>
  inputs.reduce<readonly LiveSession[]>(trackLive, [])

describe('trackLive', () => {
  describe('candidates', () => {
    it('records a session started in a workspace terminal', () => {
      expect(run([start()])).toEqual([{ workspaceId: WS, terminalId: TERM, sessionId: SESSION }])
    })

    it('keeps the session through its turns and tool calls', () => {
      const prompt: LiveInput = {
        kind: 'hook',
        workspaceId: WS,
        terminalId: TERM,
        payload: makeHookEvent('UserPromptSubmit', { session_id: SESSION, prompt: 'Add retries' })
      }

      expect(run([start(), prompt])).toEqual([
        { workspaceId: WS, terminalId: TERM, sessionId: SESSION }
      ])
    })

    it('replaces a terminal’s session with the next one started there', () => {
      const next = 'a1d4c7e2-6b9f-4e3a-8d5c-1f7b2e9a4c63'

      expect(run([start(), end(), start(next)])).toEqual([
        { workspaceId: WS, terminalId: TERM, sessionId: next }
      ])
      expect(run([start(), start(next)])).toEqual([
        { workspaceId: WS, terminalId: TERM, sessionId: next }
      ])
    })

    it('records a loose terminal’s session in the folder its start reports, beside a workspace’s', () => {
      expect(run([start(), loose('SessionStart')])).toEqual([
        { workspaceId: WS, terminalId: TERM, sessionId: SESSION },
        { terminalId: LOOSE_TERM, sessionId: SESSION, cwd: NOTES }
      ])
    })

    it('moves a loose terminal’s entry to the folder of the next session started there', () => {
      const next = 'a1d4c7e2-6b9f-4e3a-8d5c-1f7b2e9a4c63'

      expect(
        run([loose('SessionStart'), loose('SessionStart', next, '/Users/dev/src/uploader')])
      ).toEqual([{ terminalId: LOOSE_TERM, sessionId: next, cwd: '/Users/dev/src/uploader' }])
    })
  })

  describe('not candidates', () => {
    it('drops a loose session Claude ended, or whose terminal went away', () => {
      expect(run([loose('SessionStart'), loose('SessionEnd')])).toEqual([])
      expect(
        run([loose('SessionStart'), { kind: 'terminal_gone', terminalId: LOOSE_TERM }])
      ).toEqual([])
    })

    it('never records a loose session that reports no folder to resume in', () => {
      expect(run([loose('SessionStart', SESSION, '')])).toEqual([])
    })

    it('drops a session Claude ended', () => {
      expect(run([start(), end()])).toEqual([])
    })

    it('drops the session when its terminal exits or is killed', () => {
      const other = start('b7e2f9a1-3c5d-4a8e-9f1b-6d2c4e8a7b35', OTHER_TERM)

      expect(run([start(), other, { kind: 'terminal_gone', terminalId: TERM }])).toEqual([
        {
          workspaceId: WS,
          terminalId: OTHER_TERM,
          sessionId: 'b7e2f9a1-3c5d-4a8e-9f1b-6d2c4e8a7b35'
        }
      ])
    })

    it('never records a session that reports from no terminal, or a subagent', () => {
      const subagent: LiveInput = {
        kind: 'hook',
        workspaceId: WS,
        terminalId: TERM,
        payload: makeHookEvent('SessionStart', { session_id: SESSION, agent_id: 'agent_7f3c' })
      }

      expect(run([start(SESSION, null), subagent])).toEqual([])
    })

    it('ignores the end of a session the terminal no longer runs', () => {
      const next = 'a1d4c7e2-6b9f-4e3a-8d5c-1f7b2e9a4c63'

      expect(run([start(), start(next), end(SESSION)])).toEqual([
        { workspaceId: WS, terminalId: TERM, sessionId: next }
      ])
    })
  })

  describe('purity', () => {
    it('returns a new record without touching the old one, and the same one when nothing changed', () => {
      const live = run([start()])
      const before = structuredClone(live)

      expect(trackLive(live, end())).not.toBe(live)
      expect(live).toEqual(before)
      expect(trackLive(live, start())).toBe(live)
      expect(trackLive(live, { kind: 'terminal_gone', terminalId: OTHER_TERM })).toBe(live)
    })
  })
})

describe('planRestore', () => {
  const entry = (workspaceId: string, sessionId: string): LiveSession => ({
    workspaceId,
    terminalId: TERM,
    sessionId
  })

  it('resumes sessions of live workspaces, once each, and skips the rest with a reason', () => {
    const kept = makeWorkspace()
    const archived = makeWorkspace({ archivedAt: '2026-10-14T08:00:00.000Z' })
    const removing = makeWorkspace({ status: 'removing' })

    const books = new Map<string, Workspace>([
      [kept.id, kept],
      [archived.id, archived],
      [removing.id, removing]
    ])

    const plan = planRestore(
      [
        entry(kept.id, SESSION),
        entry(kept.id, SESSION),
        entry(archived.id, 'c4b8e1f7-2d6a-4c9e-a3b5-8e1f7d2c6a94'),
        entry(removing.id, 'f1a6d3b9-5c2e-4f7a-8b1d-9e4c6a2f7d58'),
        entry('ws_01hzxgone0000', 'd9a2f6c3-7e1b-4d8a-b5c2-3f9e6a1d8b47'),
        entry(kept.id, 'e2c7a9f4-1b8d-4e6c-9a3f-5d2b8e7c1a69')
      ],
      { workspace: (id) => books.get(id), folderExists: () => true },
      new Set(['e2c7a9f4-1b8d-4e6c-9a3f-5d2b8e7c1a69'])
    )

    expect(plan.resume).toEqual([entry(kept.id, SESSION)])
    expect(plan.skip.map((s) => s.why)).toEqual([
      'the session is already live',
      'the workspace is archived',
      'the workspace is being removed',
      'the workspace is gone',
      'the session is already live'
    ])
  })

  it('resumes loose sessions whose folder is still there, once per session across loose and workspace entries', () => {
    const kept = makeWorkspace()
    const gone = '/Users/dev/scratch/deleted-spike'

    const looseEntry = (sessionId: string, cwd = NOTES): LiveSession => ({
      terminalId: LOOSE_TERM,
      sessionId,
      cwd
    })

    const plan = planRestore(
      [
        looseEntry(SESSION),
        // The same session resumed in a workspace terminal too: it comes back once.
        entry(kept.id, SESSION),
        looseEntry('b8f3c6a2-9e1d-4b7f-a5c3-2d6e9f1a8b74', gone),
        entry(kept.id, 'c7a2e5d9-3f8b-4c1e-b6a4-9d2f5e8c1a37'),
        // Live again in this daemon (a terminal that came over with a handoff).
        looseEntry('e2c7a9f4-1b8d-4e6c-9a3f-5d2b8e7c1a69')
      ],
      { workspace: (id) => (id === kept.id ? kept : undefined), folderExists: (p) => p !== gone },
      new Set(['e2c7a9f4-1b8d-4e6c-9a3f-5d2b8e7c1a69'])
    )

    expect(plan.resume).toEqual([
      looseEntry(SESSION),
      entry(kept.id, 'c7a2e5d9-3f8b-4c1e-b6a4-9d2f5e8c1a37')
    ])
    expect(plan.skip).toEqual([
      { entry: entry(kept.id, SESSION), why: 'the session is already live' },
      {
        entry: looseEntry('b8f3c6a2-9e1d-4b7f-a5c3-2d6e9f1a8b74', gone),
        why: 'the folder is gone'
      },
      {
        entry: looseEntry('e2c7a9f4-1b8d-4e6c-9a3f-5d2b8e7c1a69'),
        why: 'the session is already live'
      }
    ])
  })
})

describe('LiveSessions', () => {
  function setup(stored: LiveSession[], locked = false) {
    const ws = makeWorkspace({ id: WS })
    let saved: LiveSession[] = stored
    const resumed: LiveSession[] = []
    const state = { locked }

    const sessions = new LiveSessions({
      load: () => saved,
      save: (entries) => {
        saved = entries
      },
      locked: () => state.locked,
      workspace: (id) => (id === ws.id ? ws : undefined),
      folderExists: () => true,
      ownsTerminal: (terminalId, workspaceId) =>
        workspaceId === undefined
          ? terminalId === LOOSE_TERM
          : workspaceId === WS && [TERM, OTHER_TERM].includes(terminalId),
      resume: (e) => {
        resumed.push(e)

        return OTHER_TERM
      },
      log: () => {}
    })

    return { sessions, resumed, state, saved: () => saved }
  }

  const previous = { workspaceId: WS, terminalId: 'old-term', sessionId: SESSION }

  it('consumes the previous daemon’s record before resuming it, and never resumes twice', () => {
    const { sessions, resumed, saved } = setup([previous])

    sessions.start()
    sessions.unlocked()

    expect(resumed).toEqual([previous])
    expect(saved()).toEqual([])
  })

  it('keeps an entry whose terminal is alive in this daemon instead of resuming it', () => {
    // After a handoff the terminals came over with the record: the session in TERM
    // is still live, while the one in a terminal this daemon does not have is resumed.
    const carried = { workspaceId: WS, terminalId: TERM, sessionId: 'carried' }
    // A loose terminal comes over the same way, and so does its session.
    const carriedLoose = { terminalId: LOOSE_TERM, sessionId: 'carried-loose', cwd: NOTES }
    const previousLoose = { terminalId: 'old-loose-term', sessionId: 'restored-loose', cwd: NOTES }
    const { sessions, resumed, saved } = setup([carried, carriedLoose, previous, previousLoose])
    sessions.start()

    expect(resumed).toEqual([previous, previousLoose])
    expect(saved()).toEqual([carried, carriedLoose])

    sessions.hook(WS, TERM, makeHookEvent('SessionEnd', { session_id: 'carried' }))
    sessions.hook(
      undefined,
      LOOSE_TERM,
      makeHookEvent('SessionEnd', { session_id: 'carried-loose', cwd: NOTES })
    )
    expect(saved()).toEqual([])
  })

  it('keeps the record while quiet hours are locked and restores it at the unlock', () => {
    const { sessions, resumed, state, saved } = setup([previous], true)

    sessions.start()
    sessions.hook(WS, TERM, makeHookEvent('SessionStart', { session_id: 'live-now' }))
    expect(resumed).toEqual([])
    expect(saved()).toEqual([
      previous,
      { workspaceId: WS, terminalId: TERM, sessionId: 'live-now' }
    ])

    state.locked = false
    sessions.unlocked()
    sessions.unlocked()

    expect(resumed).toEqual([previous])
    expect(saved()).toEqual([{ workspaceId: WS, terminalId: TERM, sessionId: 'live-now' }])
  })

  it('records only hooks from a terminal the daemon owns in that workspace, or loose for none', () => {
    const { sessions, saved } = setup([])
    const startHook = makeHookEvent('SessionStart', { session_id: SESSION, cwd: NOTES })

    sessions.start()
    sessions.hook(WS, 'not-ours', startHook)
    // A workspace's terminal reporting no workspace, and a loose one reporting one.
    sessions.hook(undefined, TERM, startHook)
    sessions.hook(WS, LOOSE_TERM, startHook)
    expect(saved()).toEqual([])

    sessions.hook(undefined, LOOSE_TERM, startHook)
    expect(saved()).toEqual([{ terminalId: LOOSE_TERM, sessionId: SESSION, cwd: NOTES }])
  })

  it('freezes the record once stopped: what shutdown ends is what the next start restores', () => {
    const { sessions, saved } = setup([])

    sessions.start()
    sessions.hook(WS, TERM, makeHookEvent('SessionStart', { session_id: SESSION }))
    sessions.stop()
    sessions.terminalGone(TERM)
    sessions.hook(WS, TERM, makeHookEvent('SessionEnd', { session_id: SESSION }))

    expect(saved()).toEqual([{ workspaceId: WS, terminalId: TERM, sessionId: SESSION }])
  })
})

describe('decodeLiveSessions', () => {
  it('reads the stored record and drops what it cannot read', () => {
    const good = { workspaceId: WS, terminalId: TERM, sessionId: SESSION }
    const goodLoose = { terminalId: LOOSE_TERM, sessionId: SESSION, cwd: NOTES }
    // A loose entry needs its folder.
    const noFolder = { terminalId: LOOSE_TERM, sessionId: SESSION }

    expect(
      decodeLiveSessions(JSON.stringify([good, goodLoose, noFolder, { workspaceId: WS }, 'x']))
    ).toEqual([good, goodLoose])
    expect(decodeLiveSessions('not json')).toEqual([])
    expect(decodeLiveSessions(undefined)).toEqual([])
  })
})
