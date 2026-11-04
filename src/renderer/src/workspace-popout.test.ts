import { describe, expect, it } from 'vitest'
import { makePrCheck, makePullRequest } from '@renderer/testing/fixtures'
import type { Preparation, Removal } from '../../shared/types'
import {
  firstFailingCheck,
  preparationLabel,
  preparationLines,
  removalLines,
  tildePath
} from './workspace-popout'

describe('tildePath', () => {
  it('writes ~ for the home directory and leaves other paths alone', () => {
    expect(tildePath('/Users/dev/w/uploader/app-1432-retry-logic', '/Users/dev')).toBe(
      '~/w/uploader/app-1432-retry-logic'
    )
    expect(tildePath('/Users/dev', '/Users/dev/')).toBe('~')
    expect(tildePath('/Users/devon/w/uploader', '/Users/dev')).toBe('/Users/devon/w/uploader')
    expect(tildePath('/Volumes/work/uploader', '/Users/dev')).toBe('/Volumes/work/uploader')
    expect(tildePath('/Users/dev/w/uploader', null)).toBe('/Users/dev/w/uploader')
  })
})

describe('firstFailingCheck', () => {
  it('names the first failing run while the checks fail, and nothing otherwise', () => {
    const runs = [
      makePrCheck({ name: 'lint', state: 'passing' }),
      makePrCheck({ name: 'e2e', state: 'failing' }),
      makePrCheck({ name: 'unit', state: 'failing' })
    ]

    expect(firstFailingCheck(makePullRequest({ checks: 'failing', checkRuns: runs }))).toBe('e2e')
    expect(firstFailingCheck(makePullRequest({ checks: 'passing', checkRuns: runs }))).toBeNull()
    expect(firstFailingCheck(makePullRequest({ checks: 'failing', checkRuns: [] }))).toBeNull()
  })
})

describe('removalLines', () => {
  const removal: Removal = {
    plan: ['terminals', 'teardown', 'worktree', 'branch'],
    since: '2026-10-17T16:00:00.000Z',
    done: [
      { step: 'terminals', ms: 100 },
      { step: 'teardown', ms: 60_000, error: 'timed out 60s' }
    ]
  }

  it('reads each planned step as done, failed, current or pending, in the plan’s order', () => {
    expect(removalLines(removal)).toEqual([
      { step: 'terminals', state: 'done', ms: 100 },
      { step: 'teardown', state: 'failed', error: 'timed out 60s' },
      { step: 'worktree', state: 'current' },
      { step: 'branch', state: 'pending' }
    ])
  })

  it('leaves out the steps the plan skips, and has no current step once every step has run', () => {
    expect(
      removalLines({
        plan: ['terminals', 'worktree'],
        since: removal.since,
        done: [
          { step: 'terminals', ms: 40 },
          { step: 'worktree', ms: 1_200 }
        ]
      }).map((l) => l.state)
    ).toEqual(['done', 'done'])
  })
})

describe('preparationLines', () => {
  const preparation: Preparation = {
    plan: ['fetch', 'worktree', 'setup', 'claude'],
    since: '2026-11-03T09:00:00.000Z',
    done: [{ step: 'fetch', ms: 900 }]
  }

  it('reads each planned step as done, current or pending', () => {
    expect(preparationLines(preparation)).toEqual([
      { step: 'fetch', state: 'done', ms: 900 },
      { step: 'worktree', state: 'current' },
      { step: 'setup', state: 'pending' },
      { step: 'claude', state: 'pending' }
    ])
  })

  it('has no current step once a failed one has stopped it', () => {
    const stopped = {
      ...preparation,
      done: [...preparation.done, { step: 'worktree' as const, ms: 40, error: 'unknown base ref' }]
    }

    expect(preparationLines(stopped).map((l) => l.state)).toEqual([
      'done',
      'failed',
      'pending',
      'pending'
    ])
  })

  it('goes on to the next step after a failed setup', () => {
    const failed = {
      ...preparation,
      done: [
        ...preparation.done,
        { step: 'worktree' as const, ms: 40 },
        { step: 'setup' as const, ms: 3, error: 'exited with code 3' }
      ]
    }

    expect(preparationLines(failed).map((l) => l.state)).toEqual([
      'done',
      'done',
      'failed',
      'current'
    ])
  })
})

describe('preparationLabel', () => {
  it('says the step, and that Claude starts on the brief when there is one', () => {
    expect(preparationLabel(undefined)('fetch')).toBe('fetching origin')
    expect(preparationLabel(undefined)('worktree')).toBe('creating worktree')
    expect(preparationLabel('Retry uploads')('setup')).toBe('running setup')
    expect(preparationLabel(undefined)('claude')).toBe('starting Claude')
    expect(preparationLabel('Retry uploads')('claude')).toBe('starting Claude with your brief')
  })
})
