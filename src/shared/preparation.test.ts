import { describe, expect, it } from 'vitest'
import {
  preparationFailure,
  preparationStep,
  preparationStopped,
  preparationUnfinished
} from './preparation'
import type { Preparation } from './types'

const preparation = (done: Preparation['done']): Preparation => ({
  plan: ['fetch', 'worktree', 'setup', 'claude'],
  since: '2026-11-03T09:00:00.000Z',
  done
})

const fetched = { step: 'fetch', ms: 900 } as const
const added = { step: 'worktree', ms: 200 } as const

describe('preparationStep', () => {
  it('is the first planned step before any has run, then the one after the last done', () => {
    expect(preparationStep(preparation([]))).toBe('fetch')
    expect(preparationStep(preparation([fetched, added]))).toBe('setup')
  })

  it('goes on past a failed setup, since Claude starts anyway', () => {
    const failed = { step: 'setup', ms: 1_400, error: 'exited with code 3' } as const

    expect(preparationStep(preparation([fetched, added, failed]))).toBe('claude')
    expect(preparationStopped(preparation([fetched, added, failed]))).toBeNull()
    expect(preparationFailure(preparation([fetched, added, failed]))).toEqual(failed)
  })

  it('is null once a step has stopped it, and that step is the failure', () => {
    const failed = { step: 'worktree', ms: 40, error: 'unknown base ref v9' } as const
    const stopped = preparation([fetched, failed])

    expect(preparationStep(stopped)).toBeNull()
    expect(preparationStopped(stopped)).toEqual(failed)
    expect(preparationFailure(stopped)).toEqual(failed)
  })

  it('is null once every step has run', () => {
    expect(
      preparationStep(
        preparation([fetched, added, { step: 'setup', ms: 1 }, { step: 'claude', ms: 1 }])
      )
    ).toBeNull()
  })
})

describe('preparationUnfinished', () => {
  it('holds while steps remain and after a step stopped it, not without one or past the last', () => {
    const lastDone = preparation([
      fetched,
      added,
      { step: 'setup', ms: 1, error: 'exited with code 1' },
      { step: 'claude', ms: 1 }
    ])

    expect(preparationUnfinished({})).toBe(false)
    expect(preparationUnfinished({ preparation: preparation([fetched]) })).toBe(true)
    expect(
      preparationUnfinished({
        preparation: preparation([{ step: 'fetch', ms: 1, error: 'its project is gone' }])
      })
    ).toBe(true)
    expect(preparationUnfinished({ preparation: lastDone })).toBe(false)
  })
})
