import { describe, expect, it, vi } from 'vitest'
import { makeBackgroundTask, makeQuietState, makeWorkspace } from '../testing/fixtures'
import { type TrayActions, trayMenu, trayView } from './tray-view'

const NOW = new Date(2026, 10, 4, 2, 0).getTime()

const WORK_HOURS = makeQuietState()
const LOCKED = makeQuietState({ inQuietHours: true })

const UNLOCKED = makeQuietState({
  inQuietHours: true,
  unlockedUntil: new Date(NOW + 14 * 60_000 + 32_000).toISOString()
})

const working = makeWorkspace({ status: 'working' })
const needsInput = makeWorkspace({ status: 'needs_input' })
const stuck = makeWorkspace({ status: 'stuck', statusReason: 'no_heartbeat' })
const quietRow = makeWorkspace({ status: 'idle' })

const finished = makeWorkspace({
  status: 'idle',
  finishedAt: '2026-11-04T01:40:00.000Z',
  seenAt: '2026-11-04T01:15:30.000Z'
})

describe('trayView', () => {
  describe('mark', () => {
    it('is none with no workspaces and with nothing to report', () => {
      expect(trayView([], WORK_HOURS, NOW).mark).toBe('none')
      expect(trayView([quietRow], WORK_HOURS, NOW).mark).toBe('none')
      expect(trayView([], null, NOW).mark).toBe('none')
    })

    it('is working while a workspace works', () => {
      expect(trayView([working, quietRow], WORK_HOURS, NOW).mark).toBe('working')
    })

    it.each([
      ['needs input', needsInput],
      ['stuck', stuck],
      ['finished unseen', finished]
    ])('is attention for a row that is %s', (_word, row) => {
      expect(trayView([row, quietRow], WORK_HOURS, NOW).mark).toBe('attention')
    })

    it('stops being attention once a finish has been seen', () => {
      const seen = { ...finished, seenAt: '2026-11-04T01:50:00.000Z' }

      expect(trayView([seen], WORK_HOURS, NOW)).toEqual({ mark: 'none', title: '', counts: [] })
    })

    it('lets working win over needs input, stuck and finished', () => {
      expect(trayView([needsInput, stuck, finished, working], WORK_HOURS, NOW).mark).toBe('working')
    })

    it.each(['preparing', 'removing'] as const)('does not count %s as working', (status) => {
      const view = trayView([makeWorkspace({ status })], WORK_HOURS, NOW)

      expect(view).toEqual({ mark: 'none', title: '', counts: [] })
    })

    it('does not count an idle row with background tasks as working', () => {
      const background = makeWorkspace({
        status: 'idle',
        backgroundTasks: [makeBackgroundTask()]
      })

      expect(trayView([background], WORK_HOURS, NOW)).toEqual({
        mark: 'none',
        title: '',
        counts: []
      })
    })

    it('never counts a removing row as finished', () => {
      const removing = { ...finished, status: 'removing' as const }

      expect(trayView([removing], WORK_HOURS, NOW)).toEqual({
        mark: 'none',
        title: '',
        counts: []
      })
    })
  })

  describe('work hours', () => {
    it('lists the counts in order: working, needs input, stuck, finished', () => {
      const rows = [finished, stuck, needsInput, needsInput, working, working, working]

      expect(trayView(rows, WORK_HOURS, NOW).counts).toEqual([
        '3 working',
        '2 needs input',
        '1 stuck',
        '1 finished'
      ])
    })

    it('leaves zero counts out', () => {
      expect(trayView([needsInput], WORK_HOURS, NOW).counts).toEqual(['1 needs input'])
      expect(trayView([quietRow], WORK_HOURS, NOW).counts).toEqual([])
    })

    it('treats no quiet state yet as work hours', () => {
      expect(trayView([needsInput], null, NOW)).toEqual({
        mark: 'attention',
        title: '',
        counts: ['1 needs input']
      })
    })

    it('does not count a finish under a row that already means now', () => {
      const asking = { ...finished, status: 'needs_input' as const }

      expect(trayView([asking], WORK_HOURS, NOW).counts).toEqual(['1 needs input'])
    })
  })

  describe('locked quiet', () => {
    it('ignores needs input and finished', () => {
      expect(trayView([needsInput, finished], LOCKED, NOW)).toEqual({
        mark: 'none',
        title: '',
        counts: []
      })
    })

    it('shows stuck', () => {
      expect(trayView([stuck, needsInput], LOCKED, NOW)).toEqual({
        mark: 'attention',
        title: '',
        counts: ['1 stuck']
      })
    })

    it('says the night words, in order, and working still wins', () => {
      expect(trayView([stuck, working, working], LOCKED, NOW)).toEqual({
        mark: 'working',
        title: '',
        counts: ['2 running', '1 stuck']
      })
    })
  })

  describe('an unlock running', () => {
    it('behaves as work hours, needs input and finished included', () => {
      expect(trayView([needsInput], UNLOCKED, NOW).mark).toBe('attention')
      expect(trayView([finished], UNLOCKED, NOW).mark).toBe('attention')
      expect(trayView([working, needsInput, stuck, finished], UNLOCKED, NOW).counts).toEqual([
        '1 working',
        '1 needs input',
        '1 stuck',
        '1 finished'
      ])
    })
  })

  describe('title', () => {
    it('is the countdown alone while an unlock runs, ticking with the clock', () => {
      expect(trayView([], UNLOCKED, NOW).title).toBe('14:32')
      expect(trayView([], UNLOCKED, NOW + 14 * 60_000 + 31_000).title).toBe('00:01')
    })

    it('is empty in work hours and while locked', () => {
      expect(trayView([working], WORK_HOURS, NOW).title).toBe('')
      expect(trayView([working], LOCKED, NOW).title).toBe('')
      expect(trayView([working], null, NOW).title).toBe('')
    })

    it('is empty for an unlock left over outside a quiet window', () => {
      const leftOver = makeQuietState({ unlockedUntil: UNLOCKED.unlockedUntil })

      expect(trayView([], leftOver, NOW).title).toBe('')
    })
  })
})

describe('trayMenu', () => {
  const actions = (): TrayActions => ({
    show: vi.fn<() => void>(),
    quit: vi.fn<() => void>(),
    unlock: vi.fn<() => void>(),
    lock: vi.fn<() => void>(),
    start: vi.fn<(minutes: number) => void>(),
    end: vi.fn<() => void>()
  })

  const VIEW = { mark: 'working' as const, title: '', counts: ['2 working', '1 stuck'] }
  const NO_COUNTS = { mark: 'none' as const, title: '', counts: [] }

  const labels = (rows: ReturnType<typeof trayMenu>): Array<string | undefined> =>
    rows.map((row) => (row.type === 'separator' ? '—' : row.label))

  it('lists the counts disabled, then Open que, Go quiet and Quit que, and no sessions', () => {
    const rows = trayMenu(VIEW, null, actions())

    expect(labels(rows)).toEqual([
      '2 working',
      '1 stuck',
      '—',
      'Open que',
      'Go quiet',
      '—',
      'Quit que'
    ])
    expect(rows.slice(0, 2).every((row) => row.enabled === false)).toBe(true)
  })

  it('drops the counts and their separator when there are none', () => {
    expect(labels(trayMenu(NO_COUNTS, null, actions()))).toEqual([
      'Open que',
      'Go quiet',
      '—',
      'Quit que'
    ])
  })

  it('goes quiet for the length picked from the submenu', () => {
    const acts = actions()
    const goQuiet = trayMenu(NO_COUNTS, null, acts).find((row) => row.label === 'Go quiet')
    const lengths = goQuiet?.submenu as Electron.MenuItemConstructorOptions[]

    expect(lengths.map((row) => row.label)).toEqual(['30 min', '1 hour', '2 hours'])

    for (const row of lengths) (row.click as () => void)()
    expect(vi.mocked(acts.start).mock.calls).toEqual([[30], [60], [120]])
  })

  it('offers Unlock in a locked window, at its configured length', () => {
    const rows = trayMenu(
      NO_COUNTS,
      makeQuietState({ inQuietHours: true, unlockMinutes: 15 }),
      actions()
    )

    expect(labels(rows)).toEqual(['Open que', 'Unlock 15 min', '—', 'Quit que'])
  })

  it('offers Lock now while an unlock runs', () => {
    expect(labels(trayMenu(NO_COUNTS, UNLOCKED, actions()))).toEqual([
      'Open que',
      'Lock now',
      '—',
      'Quit que'
    ])
  })

  it('offers End quiet over Unlock in a manual window only', () => {
    const manual = makeQuietState({ inQuietHours: true, kind: 'manual' })

    expect(labels(trayMenu(NO_COUNTS, manual, actions()))).toEqual([
      'Open que',
      'End quiet',
      'Unlock 20 min',
      '—',
      'Quit que'
    ])
  })
})
