import { describe, expect, it } from 'vitest'
import { makeBackgroundTask, makePullRequest, makeWorkspace } from '@renderer/testing/fixtures'
import { minutesAgo } from '@renderer/testing/helpers'
import type { PreparationStep, RemovalStep } from '@shared/types'
import {
  hoverWord,
  preparationFailedText,
  preparationWord,
  removalWord,
  rowTone,
  unseenDone
} from './sidebar-row'

const NOW = new Date(2026, 9, 17, 21, 30).getTime()

const idle = makeWorkspace({ id: 'ws_01hzx3k9c2qf', name: 'app-1432-retry-logic' })
const fresh = { ...idle, finishedAt: minutesAgo(NOW, 12), seenAt: minutesAgo(NOW, 40) }

const devServer = makeBackgroundTask({ since: minutesAgo(NOW, 31) })

const logTail = makeBackgroundTask({
  kind: 'monitor',
  description: 'tail -f logs/api.log',
  since: minutesAgo(NOW, 18)
})

const explorer = makeBackgroundTask({
  kind: 'subagent',
  description: 'Explore the repo',
  since: minutesAgo(NOW, 2)
})

describe('rowTone', () => {
  describe('the workspace status', () => {
    it('reads an idle workspace looked at as a grey dot and a faint name', () => {
      expect(
        rowTone({ ...idle, finishedAt: minutesAgo(NOW, 40), seenAt: minutesAgo(NOW, 12) })
      ).toEqual({
        status: 'idle',
        tone: 'neutral',
        working: false,
        removing: false,
        preparing: false,
        failed: null,
        unseen: false,
        weight: 'faint',
        background: []
      })
    })

    it('gives a working workspace the working mark and the secondary weight', () => {
      expect(rowTone({ ...idle, status: 'working' })).toMatchObject({
        status: 'working',
        working: true,
        weight: 'secondary'
      })
    })

    it('puts needs input and stuck at full strength, each in its tone', () => {
      expect(rowTone({ ...idle, status: 'needs_input' })).toMatchObject({
        tone: 'attention',
        weight: 'fg'
      })
      expect(rowTone({ ...idle, status: 'stuck' })).toMatchObject({ tone: 'bad', weight: 'fg' })
    })

    it('reads an exited workspace faint, told apart by its muted dot', () => {
      expect(rowTone({ ...idle, status: 'exited' })).toMatchObject({
        tone: 'muted',
        weight: 'faint'
      })
    })
  })

  describe('finished, not looked at', () => {
    it('is green with a full-strength name', () => {
      expect(rowTone(fresh)).toEqual({
        status: 'idle',
        tone: 'good',
        working: false,
        removing: false,
        preparing: false,
        failed: null,
        unseen: true,
        weight: 'fg',
        background: []
      })
    })

    it('is looked at while selected: its own tone, at full strength', () => {
      expect(rowTone(fresh, true)).toMatchObject({
        tone: 'neutral',
        unseen: false,
        weight: 'fg'
      })
    })

    it('leaves working, needs input and stuck to their own tones', () => {
      expect(rowTone({ ...fresh, status: 'working' })).toMatchObject({ unseen: false })
      expect(rowTone({ ...fresh, status: 'needs_input' })).toMatchObject({
        tone: 'attention',
        unseen: false
      })
      expect(rowTone({ ...fresh, status: 'stuck' })).toMatchObject({ tone: 'bad', unseen: false })
    })
  })

  describe('removing', () => {
    const removing = makeWorkspace({
      ...fresh,
      status: 'removing',
      backgroundTasks: [devServer],
      removal: {
        plan: ['terminals', 'teardown', 'worktree'],
        since: new Date(NOW - 12_000).toISOString(),
        done: [{ step: 'terminals', ms: 40 }]
      }
    })

    it('reads faint with a muted mark, never unseen, with no background mark', () => {
      expect(rowTone(removing)).toEqual({
        status: 'removing',
        tone: 'muted',
        working: false,
        removing: true,
        preparing: false,
        failed: null,
        unseen: false,
        weight: 'faint',
        background: []
      })
    })

    it('stays faint while selected', () => {
      expect(rowTone(removing, true).weight).toBe('faint')
    })
  })

  describe('background tasks', () => {
    it('marks an idle row with a background shell', () => {
      expect(rowTone({ ...idle, backgroundTasks: [devServer] })).toMatchObject({
        status: 'idle',
        working: false,
        background: ['shell']
      })
      expect(rowTone(idle).background).toEqual([])
    })

    it('marks an unseen finish too, beside its green dot', () => {
      expect(rowTone({ ...fresh, backgroundTasks: [devServer] })).toMatchObject({
        tone: 'good',
        unseen: true,
        background: ['shell']
      })
    })

    it('leaves the mark off while working or needing input', () => {
      expect(
        rowTone({ ...idle, status: 'working', backgroundTasks: [explorer, devServer] }).background
      ).toEqual([])
      expect(
        rowTone({ ...idle, status: 'needs_input', backgroundTasks: [devServer] }).background
      ).toEqual([])
    })
  })
})

describe('hoverWord', () => {
  it('names the background kinds of an idle row, each once, in the daemon order', () => {
    const shell = { ...idle, backgroundTasks: [devServer] }

    const both = {
      ...idle,
      backgroundTasks: [devServer, logTail, makeBackgroundTask()]
    }

    expect(hoverWord(shell, rowTone(shell), NOW)).toEqual({
      word: 'idle · shell',
      tone: null
    })
    expect(hoverWord(both, rowTone(both), NOW).word).toBe('idle · shell · monitor')
  })

  it('keeps the unseen finish word over the background kinds', () => {
    const ws = { ...fresh, backgroundTasks: [devServer] }

    expect(hoverWord(ws, rowTone(ws), NOW).word).toBe('done · 12m ago')
  })

  it('says the status, toned only for needs input and stuck', () => {
    const working = { ...idle, status: 'working' as const }
    const asking = { ...idle, status: 'needs_input' as const }
    const stuck = { ...idle, status: 'stuck' as const }

    expect(hoverWord(working, rowTone(working), NOW)).toEqual({
      word: 'working',
      tone: null
    })
    expect(hoverWord(asking, rowTone(asking), NOW)).toEqual({
      word: 'needs input',
      tone: 'attention'
    })
    expect(hoverWord(stuck, rowTone(stuck), NOW)).toEqual({ word: 'stuck', tone: 'bad' })
  })

  it('says how long ago an unseen finish was', () => {
    expect(hoverWord(fresh, rowTone(fresh), NOW)).toEqual({
      word: 'done · 12m ago',
      tone: null
    })
  })

  it('says the age of a fresh finish, never its pull request', () => {
    const open = { ...fresh, pr: makePullRequest({ number: 12, state: 'open' }) }

    expect(hoverWord(open, rowTone(open), NOW).word).toBe('done · 12m ago')
  })
})

describe('removalWord', () => {
  const plan: RemovalStep[] = ['terminals', 'teardown', 'worktree', 'branch']

  // Running `step` (every step done when null): the steps before it are done.
  const at = (step: RemovalStep | null, secondsAgo: number) =>
    makeWorkspace({
      status: 'removing',
      removal: {
        plan,
        since: new Date(NOW - secondsAgo * 1000).toISOString(),
        done: (step ? plan.slice(0, plan.indexOf(step)) : plan).map((s) => ({ step: s, ms: 40 }))
      }
    })

  it('names the step with its verb and the time since it started', () => {
    expect(removalWord(at('teardown', 12), NOW)).toBe('running teardown 12s')
    expect(removalWord(at('worktree', 0), NOW)).toBe('removing worktree 0s')
    expect(removalWord(at('branch', 185), NOW)).toBe('deleting branch 3m')
  })

  it('says removing once every step has run, or before the daemon names one', () => {
    expect(removalWord(at(null, 3), NOW)).toBe('removing')
    expect(removalWord(makeWorkspace({ status: 'removing' }), NOW)).toBe('removing')
  })

  it('is the hover word too, untoned', () => {
    const ws = at('terminals', 2)

    expect(hoverWord(ws, rowTone(ws), NOW)).toEqual({ word: 'killing terminals 2s', tone: null })
  })
})

describe('unseenDone', () => {
  it('is false for a workspace that never finished, seen or not', () => {
    expect(unseenDone(makeWorkspace({ finishedAt: null, seenAt: null }))).toBe(false)
    expect(
      unseenDone(makeWorkspace({ finishedAt: null, seenAt: '2026-10-17T21:10:00.000Z' }))
    ).toBe(false)
  })

  it('is true for a workspace that finished and was never seen', () => {
    expect(
      unseenDone(makeWorkspace({ finishedAt: '2026-10-17T21:12:00.000Z', seenAt: null }))
    ).toBe(true)
  })

  it('is false once seen after it finished', () => {
    expect(
      unseenDone(
        makeWorkspace({
          finishedAt: '2026-10-17T21:12:00.000Z',
          seenAt: '2026-10-17T21:15:30.000Z'
        })
      )
    ).toBe(false)
  })

  it('is true again when it finishes again after it was seen', () => {
    expect(
      unseenDone(
        makeWorkspace({
          finishedAt: '2026-10-17T21:40:00.000Z',
          seenAt: '2026-10-17T21:15:30.000Z'
        })
      )
    ).toBe(true)
  })

  it('is false when it was seen at the moment it finished (selected while it finished)', () => {
    expect(
      unseenDone(
        makeWorkspace({
          finishedAt: '2026-10-17T21:40:00.000Z',
          seenAt: '2026-10-17T21:40:00.000Z'
        })
      )
    ).toBe(false)
  })
})

describe('a workspace being prepared', () => {
  const since = new Date(NOW - 12_000).toISOString()

  const preparing = {
    ...idle,
    status: 'preparing' as const,
    preparation: {
      plan: ['fetch', 'worktree', 'setup', 'claude'] as const satisfies PreparationStep[],
      since,
      done: [
        { step: 'fetch' as const, ms: 900 },
        { step: 'worktree' as const, ms: 200 }
      ]
    }
  }

  const stopped = {
    ...idle,
    status: 'stuck' as const,
    statusReason: 'preparation_failed',
    preparation: {
      ...preparing.preparation,
      done: [
        { step: 'fetch' as const, ms: 900 },
        { step: 'worktree' as const, ms: 40, error: 'unknown base ref v9' }
      ]
    }
  }

  it('draws the neutral mark, with no failure, and a faint name until selected', () => {
    expect(rowTone(preparing)).toMatchObject({
      status: 'preparing',
      preparing: true,
      failed: null,
      working: false,
      removing: false,
      weight: 'faint'
    })
    expect(rowTone(preparing, true).weight).toBe('fg')
  })

  it('says the step and how long it has run, or just preparing with no steps to name', () => {
    expect(preparationWord(preparing, NOW)).toBe('running setup 12s')
    expect(preparationWord({}, NOW)).toBe('preparing')
    expect(hoverWord(preparing, rowTone(preparing), NOW)).toEqual({
      word: 'running setup 12s',
      tone: null
    })
  })

  it('reads a step that stopped it as stuck, in the bad tone, naming the step and why', () => {
    const look = rowTone(stopped)

    expect(look).toMatchObject({
      tone: 'bad',
      preparing: false,
      weight: 'fg',
      failed: { step: 'worktree', error: 'unknown base ref v9' }
    })
    expect(hoverWord(stopped, look, NOW)).toEqual({ word: 'creating worktree failed', tone: 'bad' })
    expect(look.failed && preparationFailedText(look.failed)).toBe(
      'creating worktree failed: unknown base ref v9'
    )
  })

  it('shows a failed setup only while the row is stuck on it, not once a session moved it on', () => {
    const failedSetup = {
      ...idle,
      status: 'stuck' as const,
      statusReason: 'setup_failed',
      preparation: {
        ...preparing.preparation,
        done: [
          ...preparing.preparation.done,
          { step: 'setup' as const, ms: 3_000, error: 'exited with code 3' },
          { step: 'claude' as const, ms: 2 }
        ]
      }
    }

    expect(rowTone(failedSetup).failed).toMatchObject({ step: 'setup' })
    expect(rowTone({ ...failedSetup, status: 'idle', statusReason: null }).failed).toBeNull()
    expect(rowTone({ ...failedSetup, statusReason: 'no_heartbeat' }).failed).toBeNull()
  })
})
