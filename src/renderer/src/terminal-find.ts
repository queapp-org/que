// The find control's words and colours, apart from the component so they stay plain functions.
import type { ISearchDecorationOptions, ISearchResultChangeEvent } from '@xterm/addon-search'

/** At most this many matches are highlighted and counted. */
export const FIND_LIMIT = 1000

/**
 * What the count reads: `2/12`, `0/0` with no match, and nothing before a search. Past the limit
 * the addon stops counting, so the total is only a lower bound, and it may not know the current one.
 */
export function findCountText(
  results: ISearchResultChangeEvent | null,
  limit = FIND_LIMIT
): string {
  if (!results) return ''
  const { resultIndex, resultCount } = results

  if (resultCount < limit) return `${resultIndex + 1}/${resultCount}`

  return resultIndex < 0 ? `${limit}+` : `${resultIndex + 1}/${limit}+`
}

/**
 * How matches are drawn, from the app's tokens: every match on the active fill behind a faint
 * hairline, and the current one lit by the accent's edge, since the accent means "this is the thing".
 */
export function findDecorations(token: (name: string) => string): ISearchDecorationOptions {
  return {
    matchBackground: token('--bg-active'),
    matchBorder: token('--fg-faint'),
    matchOverviewRuler: token('--border-strong'),
    activeMatchBackground: token('--bg-active'),
    activeMatchBorder: token('--accent'),
    activeMatchColorOverviewRuler: token('--accent')
  }
}
