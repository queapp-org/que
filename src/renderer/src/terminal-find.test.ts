import { describe, expect, it } from 'vitest'
import { findCountText, findDecorations } from './terminal-find'

describe('findCountText', () => {
  it('reads nothing before a search', () => {
    expect(findCountText(null)).toBe('')
  })

  it('reads the current match, counted from one, and the total', () => {
    expect(findCountText({ resultIndex: 1, resultCount: 12 })).toBe('2/12')
  })

  it('reads 0/0 with no match', () => {
    expect(findCountText({ resultIndex: -1, resultCount: 0 })).toBe('0/0')
  })

  it('marks the total as a lower bound at the limit, with or without a current match', () => {
    expect(findCountText({ resultIndex: 4, resultCount: 1000 }, 1000)).toBe('5/1000+')
    expect(findCountText({ resultIndex: -1, resultCount: 1000 }, 1000)).toBe('1000+')
  })
})

describe('findDecorations', () => {
  it('takes every colour from a token, the accent only for the current match', () => {
    const colours = findDecorations((name) => `token(${name})`)

    expect(colours).toEqual({
      matchBackground: 'token(--tone-muted)',
      matchBorder: 'token(--fg-faint)',
      matchOverviewRuler: 'token(--border-strong)',
      activeMatchBackground: 'token(--accent-fill)',
      activeMatchBorder: 'token(--accent)',
      activeMatchColorOverviewRuler: 'token(--accent)'
    })
  })
})
