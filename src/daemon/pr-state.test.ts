import { describe, expect, it } from 'vitest'
import type { PrThreadEntry } from '../shared/types'
import {
  checkRunsOf,
  commentCounts,
  currentPullRequest,
  keepsStoredChecks,
  parsePullRequest,
  pullRequestList,
  samePullRequest,
  samePullRequests
} from './pr-state'
import { decodeCheckRollup, decodePullRequest } from './pr-state.decode'

const AT = '2026-10-14T03:00:00.000Z'
const base = { number: 7, url: 'https://github.com/rquellh/que/pull/7', title: 'Add retry logic' }

// Each case goes in as `gh` prints it, through the decoder, then the mapping under test.
const parse = (extra: Record<string, unknown>) => {
  const raw = decodePullRequest({ ...base, ...extra })

  return raw && parsePullRequest(raw, AT)
}

const runsOf = (rollup: unknown) => checkRunsOf(decodeCheckRollup(rollup))

describe('parsePullRequest', () => {
  it('maps a plain open pull request', () => {
    expect(parse({ state: 'OPEN', isDraft: false })).toEqual({
      ...base,
      state: 'open',
      checks: 'none',
      review: null,
      checkRuns: [],
      updatedAt: null,
      additions: null,
      deletions: null,
      base: '',
      head: '',
      checkedAt: AT,
      comments: null,
      commentedAt: null
    })
  })

  it('keeps the branches it merges into and from', () => {
    expect(
      parse({ state: 'OPEN', baseRefName: 'APP-1432-retry-logic', headRefName: 'APP-1433-backoff' })
    ).toMatchObject({ base: 'APP-1432-retry-logic', head: 'APP-1433-backoff' })
  })

  it('keeps the line counts gh printed', () => {
    expect(parse({ state: 'OPEN', additions: 212, deletions: 48 })).toMatchObject({
      additions: 212,
      deletions: 48
    })
  })

  it.each([
    [{ state: 'OPEN', isDraft: true }, 'draft'],
    [{ state: 'OPEN', isDraft: false }, 'open'],
    [{ state: 'CLOSED', isDraft: false }, 'closed'],
    [{ state: 'MERGED' }, 'merged'],
    [{ state: 'CLOSED', mergedAt: '2026-10-14T01:00:00Z' }, 'merged'],
    [{ state: 'CLOSED', isDraft: true }, 'closed']
  ])('state from %j is %s', (extra, state) => {
    expect(parse(extra)?.state).toBe(state)
  })

  it.each([
    [undefined, 'none'],
    [[], 'none'],
    [[{ status: 'COMPLETED', conclusion: 'SUCCESS' }], 'passing'],
    [[{ status: 'COMPLETED', conclusion: 'SKIPPED' }, { state: 'SUCCESS' }], 'passing'],
    [[{ status: 'COMPLETED', conclusion: 'FAILURE' }], 'failing'],
    [[{ status: 'COMPLETED', conclusion: 'CANCELLED' }], 'failing'],
    [[{ status: 'COMPLETED', conclusion: 'TIMED_OUT' }], 'failing'],
    [[{ status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' }], 'failing'],
    [[{ status: 'COMPLETED', conclusion: 'STARTUP_FAILURE' }], 'failing'],
    [[{ state: 'FAILURE' }], 'failing'],
    [[{ state: 'ERROR' }], 'failing'],
    [[{ status: 'IN_PROGRESS', conclusion: '' }], 'pending'],
    [[{ status: 'QUEUED' }], 'pending'],
    [[{ state: 'PENDING' }], 'pending'],
    [[{ state: 'EXPECTED' }], 'pending'],
    [[{ status: 'IN_PROGRESS' }, { status: 'COMPLETED', conclusion: 'FAILURE' }], 'failing']
  ])('checks from %j is %s', (statusCheckRollup, checks) => {
    expect(parse({ state: 'OPEN', statusCheckRollup })?.checks).toBe(checks)
  })

  it.each([
    ['APPROVED', 'approved'],
    ['CHANGES_REQUESTED', 'changes_requested'],
    ['REVIEW_REQUIRED', 'review_required'],
    ['', null],
    [null, null],
    ['SOMETHING_NEW', null]
  ])('review from %j is %s', (reviewDecision, review) => {
    expect(parse({ state: 'OPEN', reviewDecision })?.review).toBe(review)
  })
})

describe('checkRunsOf', () => {
  const run = (extra: Record<string, unknown>) => ({
    __typename: 'CheckRun',
    name: 'build',
    status: 'COMPLETED',
    conclusion: 'SUCCESS',
    ...extra
  })

  const ctx = (extra: Record<string, unknown>) => ({
    __typename: 'StatusContext',
    context: 'deploy/preview',
    state: 'SUCCESS',
    ...extra
  })

  it('maps a check run with its workflow, url, and times', () => {
    expect(
      runsOf([
        run({
          name: 'unit tests',
          workflowName: 'CI',
          detailsUrl: 'https://github.com/rquellh/que/actions/runs/11',
          startedAt: '2026-10-14T02:58:00Z',
          completedAt: '2026-10-14T02:59:21Z'
        })
      ])
    ).toEqual([
      {
        name: 'unit tests',
        source: 'CI',
        state: 'passing',
        url: 'https://github.com/rquellh/que/actions/runs/11',
        startedAt: '2026-10-14T02:58:00Z',
        completedAt: '2026-10-14T02:59:21Z'
      }
    ])
  })

  it('maps a settled commit status, its createdAt as the completion time', () => {
    expect(
      runsOf([
        ctx({ targetUrl: 'https://preview.example.com/7', createdAt: '2026-10-14T03:01:00Z' })
      ])
    ).toEqual([
      {
        name: 'deploy/preview',
        source: null,
        state: 'passing',
        url: 'https://preview.example.com/7',
        startedAt: null,
        completedAt: '2026-10-14T03:01:00Z'
      }
    ])
  })

  it('leaves a pending commit status without a completion time, and missing fields null', () => {
    expect(runsOf([ctx({ state: 'PENDING', createdAt: '2026-10-14T03:01:00Z' })])).toEqual([
      {
        name: 'deploy/preview',
        source: null,
        state: 'pending',
        url: null,
        startedAt: null,
        completedAt: null
      }
    ])
  })

  it.each([
    ['QUEUED', null, 'pending'],
    ['IN_PROGRESS', null, 'pending'],
    ['WAITING', null, 'pending'],
    ['COMPLETED', 'SUCCESS', 'passing'],
    ['COMPLETED', 'FAILURE', 'failing'],
    ['COMPLETED', 'CANCELLED', 'failing'],
    ['COMPLETED', 'TIMED_OUT', 'failing'],
    ['COMPLETED', 'ACTION_REQUIRED', 'failing'],
    ['COMPLETED', 'STARTUP_FAILURE', 'failing'],
    ['COMPLETED', 'SKIPPED', 'skipped'],
    ['COMPLETED', 'NEUTRAL', 'skipped'],
    ['COMPLETED', 'STALE', 'skipped'],
    ['COMPLETED', null, 'skipped']
  ])('a check run %s / %s is %s', (status, conclusion, state) => {
    expect(runsOf([run({ status, conclusion })])[0].state).toBe(state)
  })

  it.each([
    ['SUCCESS', 'passing'],
    ['FAILURE', 'failing'],
    ['ERROR', 'failing'],
    ['PENDING', 'pending'],
    ['EXPECTED', 'pending']
  ])('a commit status %s is %s', (state, expected) => {
    expect(runsOf([ctx({ state })])[0].state).toBe(expected)
  })

  it('recognises both shapes without __typename', () => {
    expect(
      runsOf([
        { name: 'lint', status: 'IN_PROGRESS', conclusion: null },
        { context: 'ci/legacy', state: 'ERROR' }
      ]).map((c) => [c.name, c.state])
    ).toEqual([
      ['ci/legacy', 'failing'],
      ['lint', 'pending']
    ])
  })

  it('orders failing, pending, passing, skipped, and by name within each', () => {
    const runs = runsOf([
      run({ name: 'typecheck', conclusion: 'SKIPPED' }),
      run({ name: 'unit tests' }),
      ctx({ context: 'deploy/preview', state: 'PENDING' }),
      run({ name: 'lint', conclusion: 'FAILURE' }),
      run({ name: 'e2e', status: 'IN_PROGRESS', conclusion: null }),
      run({ name: 'build' }),
      ctx({ context: 'coverage', state: 'FAILURE' })
    ])

    expect(runs.map((c) => [c.state, c.name])).toEqual([
      ['failing', 'coverage'],
      ['failing', 'lint'],
      ['pending', 'deploy/preview'],
      ['pending', 'e2e'],
      ['passing', 'build'],
      ['passing', 'unit tests'],
      ['skipped', 'typecheck']
    ])
  })

  it('feeds parsePullRequest, whose summary follows the runs', () => {
    const pr = parse({
      state: 'OPEN',
      statusCheckRollup: [run({ name: 'build' }), ctx({ state: 'PENDING' })]
    })

    expect(pr?.checks).toBe('pending')
    expect(pr?.checkRuns.map((c) => c.name)).toEqual(['deploy/preview', 'build'])
  })

  describe('a check that ran again', () => {
    const names = ['build', 'unit', 'e2e']

    const cancelled = names.map((name) =>
      run({ name, workflowName: 'CI', conclusion: 'CANCELLED', startedAt: '2026-10-14T15:14:17Z' })
    )

    const rerun = names.map((name) =>
      run({ name, workflowName: 'CI', conclusion: 'SUCCESS', startedAt: '2026-10-14T15:20:00Z' })
    )

    it('keeps only the newest run, so a cancelled run no longer reads failing', () => {
      const runs = runsOf([...cancelled, ...rerun])

      expect(runs).toHaveLength(3)
      expect(runs.map((c) => [c.state, c.startedAt])).toEqual(
        names.map(() => ['passing', '2026-10-14T15:20:00Z'])
      )
    })

    it('keeps the newest run wherever it sits in the rollup', () => {
      expect(runsOf([...rerun, ...cancelled]).map((c) => c.state)).toEqual(
        names.map(() => 'passing')
      )
    })

    it('reads failing when the re-run failed after an earlier success', () => {
      const pr = parse({
        statusCheckRollup: [
          run({ name: 'build', conclusion: 'SUCCESS', startedAt: '2026-10-14T15:14:17Z' }),
          run({ name: 'build', conclusion: 'FAILURE', startedAt: '2026-10-14T15:20:00Z' })
        ]
      })

      expect(pr?.checks).toBe('failing')
      expect(pr?.checkRuns).toHaveLength(1)
    })

    it('keeps the same job name under two workflows as two checks', () => {
      const runs = runsOf([
        run({ name: 'test', workflowName: 'CI', startedAt: '2026-10-14T15:14:17Z' }),
        run({ name: 'test', workflowName: 'E2E', startedAt: '2026-10-14T15:20:00Z' }),
        run({ name: 'test', workflowName: null, startedAt: '2026-10-14T15:21:00Z' })
      ])

      expect(runs.map((c) => c.source).sort()).toEqual(['CI', 'E2E', null])
    })

    it('keeps the newest of commit statuses with the same context', () => {
      const runs = runsOf([
        ctx({ state: 'SUCCESS', createdAt: '2026-10-14T15:20:00Z' }),
        ctx({ state: 'FAILURE', createdAt: '2026-10-14T15:14:00Z' })
      ])

      expect(runs.map((c) => [c.state, c.completedAt])).toEqual([
        ['passing', '2026-10-14T15:20:00Z']
      ])
    })

    it('never mixes a commit status with a check run of the same name', () => {
      const runs = runsOf([
        run({ name: 'deploy/preview', startedAt: '2026-10-14T15:20:00Z' }),
        ctx({ createdAt: '2026-10-14T15:14:00Z' })
      ])

      expect(runs).toHaveLength(2)
    })

    it('falls back to the completion time when a run has no start', () => {
      const runs = runsOf([
        run({ conclusion: 'SUCCESS', completedAt: '2026-10-14T15:20:00Z' }),
        run({ conclusion: 'FAILURE', completedAt: '2026-10-14T15:14:00Z' })
      ])

      expect(runs.map((c) => c.state)).toEqual(['passing'])
    })

    it('lets the later entry win a tie, equal or both missing', () => {
      const at = '2026-10-14T15:20:00Z'

      expect(
        runsOf([
          run({ conclusion: 'FAILURE', startedAt: at }),
          run({ conclusion: 'SUCCESS', startedAt: at })
        ]).map((c) => c.state)
      ).toEqual(['passing'])
      expect(
        runsOf([run({ conclusion: 'SUCCESS' }), run({ conclusion: 'FAILURE' })]).map((c) => c.state)
      ).toEqual(['failing'])
    })

    it('lets an entry with a time beat one without, in either order', () => {
      const timed = run({ conclusion: 'SUCCESS', startedAt: '2026-10-14T15:20:00Z' })
      const untimed = run({ conclusion: 'FAILURE' })

      expect(runsOf([timed, untimed]).map((c) => c.state)).toEqual(['passing'])
      expect(runsOf([untimed, timed]).map((c) => c.state)).toEqual(['passing'])
    })

    it('feeds parsePullRequest a summary and runs of the newest only', () => {
      const pr = parse({ state: 'OPEN', statusCheckRollup: [...cancelled, ...rerun] })

      expect(pr?.checks).toBe('passing')
      expect(pr?.checkRuns).toHaveLength(3)
      expect(pr?.checkRuns.every((c) => c.state === 'passing')).toBe(true)
    })
  })

  it('summarises skipped-only runs as passing', () => {
    expect(parse({ statusCheckRollup: [run({ conclusion: 'SKIPPED' })] })?.checks).toBe('passing')
  })
})

describe('samePullRequest', () => {
  const a = parse({ state: 'OPEN' })

  it('ignores checkedAt only', () => {
    expect(samePullRequest(a, a && { ...a, checkedAt: 'later' })).toBe(true)
    expect(samePullRequest(a, parse({ state: 'OPEN', isDraft: true }))).toBe(false)
    expect(samePullRequest(a, parse({ state: 'OPEN', reviewDecision: 'APPROVED' }))).toBe(false)
    expect(samePullRequest(a, parse({ state: 'OPEN', title: 'New title' }))).toBe(false)
    expect(samePullRequest(a, parse({ state: 'OPEN', additions: 3, deletions: 0 }))).toBe(false)
  })

  it('tells pull requests apart by their comment counts', () => {
    const counted = a && { ...a, comments: 3, commentedAt: '2026-10-14T03:20:00Z' }

    expect(samePullRequest(a, counted)).toBe(false)
    expect(samePullRequest(counted, counted && { ...counted, commentedAt: 'later' })).toBe(false)
  })

  it('tells pull requests apart by their check runs', () => {
    const pending = parse({
      state: 'OPEN',
      statusCheckRollup: [{ name: 'build', status: 'IN_PROGRESS', conclusion: null }]
    })

    const passing = parse({
      state: 'OPEN',
      statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }]
    })

    const otherUrl = parse({
      state: 'OPEN',
      statusCheckRollup: [
        { name: 'build', status: 'IN_PROGRESS', conclusion: null, detailsUrl: 'https://x/2' }
      ]
    })

    expect(samePullRequest(pending, pending && { ...pending, checkedAt: 'later' })).toBe(true)
    expect(samePullRequest(pending, passing)).toBe(false)
    expect(samePullRequest(pending, otherUrl)).toBe(false)
  })

  it('treats null and a value as different, two nulls as the same', () => {
    expect(samePullRequest(null, null)).toBe(true)
    expect(samePullRequest(null, a)).toBe(false)
    expect(samePullRequest(a, null)).toBe(false)
  })
})

describe('commentCounts', () => {
  const entry = (id: string, at: string): PrThreadEntry => ({
    id,
    kind: 'comment',
    author: 'mara',
    body: 'Can we cap the retries?',
    at,
    url: null,
    state: null,
    path: null,
    line: null,
    hunk: null
  })

  const thread = (entries: PrThreadEntry[]) => ({
    workspaceId: 'ws_01hzx3k9c2qf',
    number: 7,
    entries,
    fetchedAt: AT
  })

  it('counts the entries and keeps the newest time, whatever their order', () => {
    expect(
      commentCounts(
        thread([
          entry('c1', '2026-10-14T03:00:00Z'),
          entry('c3', '2026-10-14T03:20:00Z'),
          entry('c2', '2026-10-14T03:10:00Z')
        ])
      )
    ).toEqual({ comments: 3, commentedAt: '2026-10-14T03:20:00Z' })
  })

  it('is zero with no time for an empty conversation', () => {
    expect(commentCounts(thread([]))).toEqual({ comments: 0, commentedAt: null })
  })
})

// A pull request numbered `number` on the branch, as parse() builds it.
const pr = (number: number, extra: Record<string, unknown>) => {
  const p = parse({ ...extra, number, url: `https://github.com/rquellh/que/pull/${number}` })

  if (!p) throw new Error('fixture did not decode')

  return p
}

describe('currentPullRequest', () => {
  it('picks the open one over a newer merged one', () => {
    const merged = pr(52, { state: 'MERGED', updatedAt: '2026-10-14T05:00:00Z' })
    const open = pr(51, { state: 'OPEN', updatedAt: '2026-10-14T02:00:00Z' })

    expect(currentPullRequest([merged, open])?.number).toBe(51)
  })

  it('counts a draft as open', () => {
    const closed = pr(52, { state: 'CLOSED', updatedAt: '2026-10-14T05:00:00Z' })
    const draft = pr(50, { state: 'OPEN', isDraft: true, updatedAt: '2026-10-13T20:00:00Z' })

    expect(currentPullRequest([closed, draft])?.number).toBe(50)
  })

  it('picks the most recently updated when none is open', () => {
    const closedLater = pr(48, { state: 'CLOSED', updatedAt: '2026-10-14T04:00:00Z' })
    const merged = pr(49, { state: 'MERGED', updatedAt: '2026-10-14T03:00:00Z' })

    expect(currentPullRequest([merged, closedLater])?.number).toBe(48)
  })

  it('falls back to the higher number when updatedAt is unknown', () => {
    expect(
      currentPullRequest([pr(47, { state: 'MERGED' }), pr(49, { state: 'MERGED' })])?.number
    ).toBe(49)
  })

  it('is null without pull requests', () => {
    expect(currentPullRequest([])).toBeNull()
  })
})

describe('pullRequestList', () => {
  it('orders newest first by number, one entry per number', () => {
    const list = pullRequestList([
      pr(12, { state: 'MERGED' }),
      pr(30, { state: 'OPEN', title: 'From the branch' }),
      pr(30, { state: 'OPEN', title: 'From the task' }),
      pr(21, { state: 'CLOSED' })
    ])

    expect(list.map((p) => [p.number, p.title])).toEqual([
      [30, 'From the branch'],
      [21, 'Add retry logic'],
      [12, 'Add retry logic']
    ])
  })

  it('keeps the newest twenty, stored ones counted', () => {
    const fresh = Array.from({ length: 15 }, (_, i) => pr(i + 11, { state: 'CLOSED' }))
    const stored = Array.from({ length: 10 }, (_, i) => pr(i + 1, { state: 'MERGED' }))

    expect(pullRequestList(fresh, stored).map((p) => p.number)).toEqual(
      Array.from({ length: 20 }, (_, i) => 25 - i)
    )
  })

  it('keeps a stored pull request missing from the fresh ones, and takes the fresh copy of the rest', () => {
    const stored = [
      pr(41, { state: 'OPEN', title: 'On the branch it left' }),
      pr(44, { state: 'OPEN', title: 'Before review' })
    ]

    const list = pullRequestList([pr(44, { state: 'MERGED', title: 'After review' })], stored)

    expect(list.map((p) => [p.number, p.state, p.title])).toEqual([
      [44, 'merged', 'After review'],
      [41, 'open', 'On the branch it left']
    ])
  })

  it('leaves its input untouched', () => {
    const input = [pr(3, { state: 'OPEN' }), pr(9, { state: 'MERGED' })]
    const stored = [pr(2, { state: 'CLOSED' })]
    const before = structuredClone([input, stored])

    const list = pullRequestList(input, stored)

    expect([input, stored]).toEqual(before)
    expect(list).not.toBe(input)
  })
})

describe('samePullRequests', () => {
  const merged = pr(41, { state: 'MERGED' })
  const open = pr(42, { state: 'OPEN' })

  it('is the same when every entry matches but checkedAt', () => {
    expect(samePullRequests([open, merged], [{ ...open, checkedAt: 'later' }, merged])).toBe(true)
    expect(samePullRequests([], [])).toBe(true)
  })

  it('differs when any entry changes, one is added, or the order moves', () => {
    expect(samePullRequests([open, merged], [{ ...open, state: 'closed' }, merged])).toBe(false)
    expect(samePullRequests([merged], [open, merged])).toBe(false)
    expect(samePullRequests([open, merged], [merged, open])).toBe(false)
  })
})

// A `gh pr list` item numbered `number` as the project listing prints it: without the rollup.
const listed = (number: number, extra: Record<string, unknown>) => {
  const raw = decodePullRequest({
    ...extra,
    number,
    url: `https://github.com/rquellh/que/pull/${number}`
  })

  if (!raw) throw new Error('fixture did not decode')

  return raw
}

const failing = [{ name: 'unit tests', status: 'COMPLETED', conclusion: 'FAILURE' }]
const passing = [{ name: 'unit tests', status: 'COMPLETED', conclusion: 'SUCCESS' }]
const running = [{ name: 'unit tests', status: 'IN_PROGRESS' }]

describe('a pull request listed without its rollup', () => {
  describe('parsePullRequest', () => {
    it('keeps the checks of its stored copy and takes the rest fresh', () => {
      const stored = pr(41, {
        state: 'MERGED',
        title: 'Add retry logic',
        statusCheckRollup: failing
      })

      expect(
        parsePullRequest(listed(41, { state: 'MERGED', title: 'Retry the uploader' }), AT, [stored])
      ).toMatchObject({
        title: 'Retry the uploader',
        checks: 'failing',
        checkRuns: stored.checkRuns
      })
    })

    it('has no checks when nothing stored has its number', () => {
      const other = pr(40, { state: 'MERGED', statusCheckRollup: failing })

      expect(parsePullRequest(listed(41, { state: 'MERGED' }), AT, [other])).toMatchObject({
        checks: 'none',
        checkRuns: []
      })
    })

    it('takes a printed rollup over the stored checks, even an empty one', () => {
      const stored = pr(41, { state: 'OPEN', statusCheckRollup: failing })

      expect(
        parsePullRequest(listed(41, { state: 'OPEN', statusCheckRollup: [] }), AT, [stored])
      ).toMatchObject({ checks: 'none', checkRuns: [] })
    })
  })

  describe('keepsStoredChecks', () => {
    it.each([
      { name: 'merged, stored merged', now: 'MERGED', before: passing, due: false, keeps: true },
      {
        name: 'closed, stored closed, on a fifth tick',
        now: 'CLOSED',
        before: failing,
        due: true,
        keeps: true
      },
      {
        name: 'merged, stored merged while its checks ran',
        now: 'MERGED',
        before: running,
        due: false,
        keeps: true
      },
      {
        name: 'merged, stored merged while its checks ran, on a fifth tick',
        now: 'MERGED',
        before: running,
        due: true,
        keeps: false
      }
    ])('keeps the checks of one $name: $keeps', ({ now, before, due, keeps }) => {
      const stored = pr(41, { state: now, statusCheckRollup: before })

      expect(keepsStoredChecks(listed(41, { state: now }), [stored], due)).toBe(keeps)
    })

    it.each([
      ['open', { state: 'OPEN' }, { state: 'OPEN' }],
      ['a draft', { state: 'OPEN', isDraft: true }, { state: 'OPEN', isDraft: true }],
      ['merged since it was stored open', { state: 'MERGED' }, { state: 'OPEN' }],
      ['reopened', { state: 'OPEN' }, { state: 'CLOSED' }]
    ])('asks for the checks of one %s', (_name, now, before) => {
      const stored = pr(41, { ...before, statusCheckRollup: passing })

      expect(keepsStoredChecks(listed(41, now), [stored], false)).toBe(false)
    })

    it('asks for the checks of one it has not stored', () => {
      const other = pr(40, { state: 'MERGED', statusCheckRollup: passing })

      expect(keepsStoredChecks(listed(41, { state: 'MERGED' }), [other], false)).toBe(false)
    })
  })
})
