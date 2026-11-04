import { describe, expect, it } from 'vitest'
import { makeBackgroundTask, makeHookEvent } from '../testing/fixtures'
import {
  AGENTS_JSON_MIN_AGE_MS,
  initialState,
  quietTrayTitle,
  reduce,
  type StatusState,
  summarize,
  trayTitle
} from './status-engine'

// Local wall-clock instants on 14 Oct 2026; the engine only ever sees `now`.
const T0 = new Date(2026, 9, 14, 10, 0).getTime()
const STALL = { stallTimeoutMs: 300_000 }

const idle: StatusState = { ...initialState(T0, 'idle') }

const working: StatusState = {
  ...initialState(T0, 'working'),
  lastActivityAt: T0,
  hookAt: T0,
  sessionId: 'b3c1d2e4-0000-4000-8000-1a2b3c4d5e6f'
}

const running = (id: string, type: string) => ({ id, type, status: 'running' })

const shellTask = makeBackgroundTask({ since: new Date(T0).toISOString() })

function hook(state: StatusState, ...args: Parameters<typeof makeHookEvent>) {
  const payload = makeHookEvent(...args)

  return reduce(state, { kind: 'hook', event: payload.hook_event_name, payload }, T0 + 1_000)
}

describe('reduce', () => {
  describe('transitions', () => {
    it('goes idle on SessionStart and records the session id', () => {
      const next = hook(initialState(T0), 'SessionStart', {
        session_id: '0f9e8d7c-0000-4000-8000-6b5a4c3d2e1f',
        source: 'startup'
      })

      expect(next).toMatchObject({
        status: 'idle',
        sessionId: '0f9e8d7c-0000-4000-8000-6b5a4c3d2e1f',
        statusAt: T0 + 1_000,
        hookAt: T0 + 1_000
      })
    })

    it.each([
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'PreCompact'
    ] as const)('goes working on %s and refreshes the activity time', (event) => {
      const next = hook(idle, event, { tool_name: 'Bash' })

      expect(next).toMatchObject({ status: 'working', reason: null, lastActivityAt: T0 + 1_000 })
    })

    it.each(['permission_prompt', 'elicitation_dialog', 'agent_needs_input'])(
      'needs input on a %s notification',
      (notification_type) => {
        const next = hook(working, 'Notification', {
          notification_type,
          message: 'Claude needs your permission to use Bash'
        })

        expect(next.status).toBe('needs_input')
      }
    )

    it('needs input on PermissionRequest', () => {
      expect(hook(working, 'PermissionRequest', { tool_name: 'Bash' }).status).toBe('needs_input')
    })

    it('goes idle on an idle_prompt notification and on Stop', () => {
      const asked = { ...working, status: 'needs_input' as const }

      expect(
        hook(asked, 'Notification', {
          notification_type: 'idle_prompt',
          message: 'Claude is waiting for your input'
        }).status
      ).toBe('idle')
      expect(hook(working, 'Stop', { last_assistant_message: 'Done.' }).status).toBe('idle')
    })

    it('leaves the status alone for other notifications', () => {
      const next = hook(working, 'Notification', { notification_type: 'auth_success' })

      expect(next.status).toBe('working')
      expect(next.statusAt).toBe(working.statusAt)
    })

    it('is stuck with the error kind on StopFailure', () => {
      const next = hook(working, 'StopFailure', {
        error: 'rate_limit',
        error_details: 'API Error: 429'
      })

      expect(next).toMatchObject({ status: 'stuck', reason: 'error:rate_limit' })
    })

    it('has exited on SessionEnd and when the last terminal exits', () => {
      expect(hook(idle, 'SessionEnd', { reason: 'prompt_input_exit' }).status).toBe('exited')
      expect(reduce(working, { kind: 'terminal_exit' }, T0 + 1_000).status).toBe('exited')
    })

    it('goes idle on SessionStart with no background tasks left over', () => {
      const busy = { ...working, backgroundTasks: [shellTask] }

      expect(hook(busy, 'SessionStart', { source: 'startup' }).backgroundTasks).toEqual([])
    })
  })

  describe('subagent hooks', () => {
    const subagent = { agent_id: 'a7c21f09e4b3', agent_type: 'Explore' }

    it.each([
      ['working', working],
      ['idle', idle]
    ])('leaves a %s session as it is on a subagent PreToolUse', (_label, state) => {
      expect(hook(state, 'PreToolUse', { ...subagent, tool_name: 'Grep' })).toBe(state)
    })

    it.each([
      ['still listing the agent', [running('a7c21f09e4b3', 'subagent')]],
      ['with an empty list', []]
    ])('never moves the status on SubagentStop %s', (_label, background_tasks) => {
      for (const state of [working, idle]) {
        const next = hook(state, 'SubagentStop', { ...subagent, background_tasks })

        expect(next.status).toBe(state.status)
        expect(next.statusAt).toBe(state.statusAt)
        expect(next.hookAt).toBe(state.hookAt)
      }
    })

    it('updates only the background tasks on a SubagentStop with a changed list', () => {
      const busy = { ...working, backgroundTasks: [shellTask] }
      const next = hook(busy, 'SubagentStop', { ...subagent, background_tasks: [] })

      expect(next).toEqual({ ...busy, backgroundTasks: [] })
    })
  })

  describe('background tasks at Stop', () => {
    it('stays working while a subagent runs, and lists it since now', () => {
      const next = hook(working, 'Stop', {
        background_tasks: [
          {
            id: 'a7c21f09e4b3',
            type: 'subagent',
            status: 'running',
            description: 'Explore the repo',
            agent_type: 'Explore'
          }
        ]
      })

      expect(next).toMatchObject({ status: 'working', lastActivityAt: T0 + 1_000 })
      expect(next.backgroundTasks).toEqual([
        {
          id: 'a7c21f09e4b3',
          kind: 'subagent',
          description: 'Explore the repo',
          since: new Date(T0 + 1_000).toISOString()
        }
      ])
    })

    it.each(['workflow', 'teammate'])('stays working while a %s runs', (type) => {
      expect(hook(working, 'Stop', { background_tasks: [running('w1', type)] }).status).toBe(
        'working'
      )
    })

    it('goes idle with only a shell and a monitor running, and keeps both listed', () => {
      const next = hook(working, 'Stop', {
        background_tasks: [
          { id: 'b1', type: 'shell', status: 'running', command: 'npm run dev' },
          { id: 'm1', type: 'monitor', status: 'running', description: 'checks on #141' }
        ]
      })

      expect(next.status).toBe('idle')
      expect(next.backgroundTasks.map((t) => [t.kind, t.description])).toEqual([
        ['shell', 'npm run dev'],
        ['monitor', 'checks on #141']
      ])
    })

    it.each([
      ['an empty list', { background_tasks: [] }],
      ['no list', {}],
      [
        'only entries no longer running',
        { background_tasks: [{ id: 'a1', type: 'subagent', status: 'completed' }] }
      ]
    ])('goes idle with no tasks on a Stop with %s', (_label, overrides) => {
      const busy = { ...working, backgroundTasks: [shellTask] }

      expect(hook(busy, 'Stop', overrides)).toMatchObject({ status: 'idle', backgroundTasks: [] })
    })

    it('keeps a task first seen time across Stops and drops one that finished', () => {
      const first = hook(working, 'Stop', {
        background_tasks: [running('a1', 'subagent'), running('b1', 'shell')]
      })

      const second = reduce(
        first,
        {
          kind: 'hook',
          event: 'Stop',
          payload: makeHookEvent('Stop', { background_tasks: [running('b1', 'shell')] })
        },
        T0 + 60_000
      )

      expect(second.status).toBe('idle')
      expect(second.backgroundTasks).toEqual([
        { id: 'b1', kind: 'shell', description: 'shell', since: new Date(T0 + 1_000).toISOString() }
      ])
    })

    it('keeps the same task list when a Stop reports the same tasks again', () => {
      const first = hook(working, 'Stop', { background_tasks: [running('b1', 'shell')] })

      const again = reduce(
        first,
        {
          kind: 'hook',
          event: 'Stop',
          payload: makeHookEvent('Stop', { background_tasks: [running('b1', 'shell')] })
        },
        T0 + 60_000
      )

      expect(again.backgroundTasks).toBe(first.backgroundTasks)
    })
  })

  describe('clock', () => {
    it('marks a working session stuck once nothing happened for the stall timeout', () => {
      expect(reduce(working, { kind: 'tick' }, T0 + 300_000, STALL).status).toBe('working')

      const stalled = reduce(working, { kind: 'tick' }, T0 + 300_001, STALL)

      expect(stalled).toMatchObject({
        status: 'stuck',
        reason: 'no_heartbeat',
        statusAt: T0 + 300_001
      })
    })

    it('never stalls a session that is idle or waiting for input', () => {
      const waiting = { ...working, status: 'needs_input' as const }

      expect(reduce(idle, { kind: 'tick' }, T0 + 3_600_000, STALL).status).toBe('idle')
      expect(reduce(waiting, { kind: 'tick' }, T0 + 3_600_000, STALL).status).toBe('needs_input')
    })

    it('clears a stall on the next hook event', () => {
      const stalled = reduce(working, { kind: 'tick' }, T0 + 400_000, STALL)

      const next = reduce(
        stalled,
        { kind: 'hook', event: 'PostToolUse', payload: makeHookEvent('PostToolUse') },
        T0 + 401_000
      )

      expect(next).toMatchObject({ status: 'working', reason: null })
    })
  })

  describe('claude agents --json cross-check', () => {
    const entry = (status: string) => ({
      kind: 'agents_json' as const,
      entry: { cwd: '/Users/dev/.que/worktrees/uploader/app-1432-retry-logic', status }
    })

    const old = T0 + AGENTS_JSON_MIN_AGE_MS + 1

    it('is ignored while the hook-derived state is fresh', () => {
      expect(reduce(working, entry('waiting_for_input'), T0 + AGENTS_JSON_MIN_AGE_MS).status).toBe(
        'working'
      )
    })

    it.each([
      ['waiting_for_input', 'needs_input'],
      ['blocked', 'needs_input'],
      ['idle', 'idle'],
      ['running', 'working'],
      ['busy', 'working']
    ] as const)('maps %s to %s once the hook state is older than 30 s', (status, expected) => {
      const from = {
        ...working,
        status: expected === 'working' ? ('idle' as const) : working.status
      }

      expect(reduce(from, entry(status), old).status).toBe(expected)
    })

    it.each([
      ['subagent', 'working'],
      ['shell', 'idle']
    ] as const)(
      'leaves a session with a %s running %s when the registry says idle',
      (kind, expected) => {
        const paused = { ...working, backgroundTasks: [makeBackgroundTask({ kind })] }

        expect(reduce(paused, entry('idle'), old).status).toBe(expected)
      }
    )

    it('applies to a workspace no hook has reported from yet', () => {
      expect(reduce(idle, entry('waiting'), T0 + 1).status).toBe('needs_input')
    })
  })

  describe('workspace setup', () => {
    const preparing = initialState(T0)

    const at = (state: StatusState, kind: 'setup_done' | 'setup_failed') =>
      reduce(state, { kind }, T0 + 1_000)

    it('moves a preparing workspace to idle when setup succeeds', () => {
      expect(at(preparing, 'setup_done')).toMatchObject({
        status: 'idle',
        reason: null,
        statusAt: T0 + 1_000
      })
    })

    it('leaves a workspace whose session already reported alone when setup succeeds', () => {
      expect(at(working, 'setup_done')).toEqual(working)
    })

    it('marks a preparing workspace stuck with preparation_failed when a step stops it', () => {
      expect(reduce(preparing, { kind: 'preparation_failed' }, T0 + 1_000)).toMatchObject({
        status: 'stuck',
        reason: 'preparation_failed',
        statusAt: T0 + 1_000
      })
    })

    it('marks the workspace stuck with setup_failed whatever it was doing', () => {
      for (const state of [preparing, working]) {
        expect(at(state, 'setup_failed')).toMatchObject({
          status: 'stuck',
          reason: 'setup_failed',
          statusAt: T0 + 1_000
        })
      }
    })
  })

  describe('removal', () => {
    it('moves any workspace to removing and drops its background tasks', () => {
      const busy: StatusState = { ...working, backgroundTasks: [shellTask] }

      expect(reduce(busy, { kind: 'remove' }, T0 + 1_000)).toMatchObject({
        status: 'removing',
        reason: null,
        statusAt: T0 + 1_000,
        backgroundTasks: []
      })
    })

    it('ignores every input once the workspace is removing', () => {
      const removing = reduce(working, { kind: 'remove' }, T0 + 1_000)
      const stop = makeHookEvent('SessionEnd')

      const inputs = [
        { kind: 'terminal_exit' },
        { kind: 'hook', event: stop.hook_event_name, payload: stop },
        { kind: 'tick' },
        { kind: 'agents_json', entry: { status: 'waiting' } },
        { kind: 'setup_failed' }
      ] as const

      for (const input of inputs) {
        expect(reduce(removing, input, T0 + 900_000, STALL)).toEqual(removing)
      }
    })
  })

  describe('purity', () => {
    it('returns a new state and never mutates its input', () => {
      const before = structuredClone(working)

      const next = reduce(working, { kind: 'tick' }, T0 + 900_000, STALL)

      expect(next).not.toBe(working)
      expect(working).toEqual(before)
    })
  })
})

describe('summarize and trayTitle', () => {
  it('counts workspaces per status and formats the tray title', () => {
    const summary = summarize([
      { status: 'working' },
      { status: 'working' },
      { status: 'working' },
      { status: 'needs_input' },
      { status: 'idle' },
      { status: 'preparing' },
      { status: 'removing' }
    ])

    expect(summary).toEqual({
      working: 3,
      idle: 1,
      needs_input: 1,
      stuck: 0,
      exited: 0,
      preparing: 1,
      removing: 1
    })
    expect(trayTitle(summary)).toBe('● 3 ▸ 1 ✕ 0')
  })
})

describe('quietTrayTitle', () => {
  const summary = summarize([
    { status: 'working' },
    { status: 'working' },
    { status: 'working' },
    { status: 'needs_input' }
  ])

  const now = new Date(2026, 9, 14, 2, 0).getTime()

  const quiet = {
    inQuietHours: true,
    unlockedUntil: new Date(now + 14 * 60_000 + 32_000).toISOString()
  }

  it('leads with the unlock countdown while an unlock runs', () => {
    expect(quietTrayTitle(summary, quiet, now)).toBe('🔓 14:32 · ● 3 ▸ 1 ✕ 0')
    expect(quietTrayTitle(summary, quiet, now + 14 * 60_000 + 31_000)).toBe(
      '🔓 00:01 · ● 3 ▸ 1 ✕ 0'
    )
  })

  it('drops the needs-input count while quiet and locked', () => {
    expect(quietTrayTitle(summary, { inQuietHours: true, unlockedUntil: null }, now)).toBe(
      '● 3 ✕ 0'
    )
  })

  it('is the plain counts in work hours', () => {
    expect(quietTrayTitle(summary, { inQuietHours: false, unlockedUntil: null }, now)).toBe(
      '● 3 ▸ 1 ✕ 0'
    )
    expect(quietTrayTitle(summary, null, now)).toBe('● 3 ▸ 1 ✕ 0')
  })
})
