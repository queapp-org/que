import { describe, expect, it } from 'vitest'
import { makeWorkspace } from '../testing/fixtures'
import { finishedUnseen } from './finished'

describe('finishedUnseen', () => {
  it('is false for a workspace that never finished, seen or not', () => {
    expect(finishedUnseen(makeWorkspace({ finishedAt: null, seenAt: null }))).toBe(false)
    expect(
      finishedUnseen(makeWorkspace({ finishedAt: null, seenAt: '2026-10-17T21:10:00.000Z' }))
    ).toBe(false)
  })

  it('is true for a workspace that finished and was never seen', () => {
    expect(
      finishedUnseen(makeWorkspace({ finishedAt: '2026-10-17T21:12:00.000Z', seenAt: null }))
    ).toBe(true)
  })

  it('is false once seen after it finished', () => {
    expect(
      finishedUnseen(
        makeWorkspace({
          finishedAt: '2026-10-17T21:12:00.000Z',
          seenAt: '2026-10-17T21:15:30.000Z'
        })
      )
    ).toBe(false)
  })

  it('is true again when it finishes again after it was seen', () => {
    expect(
      finishedUnseen(
        makeWorkspace({
          finishedAt: '2026-10-17T21:40:00.000Z',
          seenAt: '2026-10-17T21:15:30.000Z'
        })
      )
    ).toBe(true)
  })

  it('is false when it was seen at the moment it finished (selected while it finished)', () => {
    expect(
      finishedUnseen(
        makeWorkspace({
          finishedAt: '2026-10-17T21:40:00.000Z',
          seenAt: '2026-10-17T21:40:00.000Z'
        })
      )
    ).toBe(false)
  })

  const unseen = { finishedAt: '2026-10-17T21:40:00.000Z', seenAt: '2026-10-17T21:15:30.000Z' }

  it.each(['idle', 'exited'] as const)('is true for an unseen finish on an %s row', (status) => {
    expect(finishedUnseen(makeWorkspace({ ...unseen, status }))).toBe(true)
  })

  it.each(['working', 'needs_input', 'stuck'] as const)(
    'is false on a %s row, which already means now',
    (status) => {
      expect(finishedUnseen(makeWorkspace({ ...unseen, status }))).toBe(false)
    }
  )

  it('is false on a row being removed', () => {
    expect(finishedUnseen(makeWorkspace({ ...unseen, status: 'removing' }))).toBe(false)
  })

  it('is false once the finish has been seen', () => {
    expect(
      finishedUnseen(
        makeWorkspace({
          status: 'idle',
          finishedAt: '2026-10-17T21:12:00.000Z',
          seenAt: '2026-10-17T21:15:30.000Z'
        })
      )
    ).toBe(false)
  })
})
