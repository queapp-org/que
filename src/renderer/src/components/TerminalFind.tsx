import { useEffect, useMemo, useRef, useState } from 'react'
import type { ISearchResultChangeEvent, SearchAddon } from '@xterm/addon-search'
import { findCountText, findDecorations, token } from '../terminal-find'
import { ChevronDownIcon, ChevronUpIcon } from './icons'

/** Puts the keyboard in the field, with its text selected so typing replaces it. */
function focusField(field: HTMLInputElement | null): void {
  field?.focus()
  field?.select()
}

/**
 * The find control, floating at a terminal's top right: a field, the match count, previous and
 * next. Each change of `focusRequest` (another ⌘F) puts the keyboard back in the field with its
 * text selected. Closing it clears the highlights.
 */
export default function TerminalFind({
  id,
  search,
  focusRequest,
  onClose
}: {
  /** The terminal's id, for the test ids. */
  id: string
  search: SearchAddon
  focusRequest: number
  onClose: () => void
}): React.JSX.Element {
  const field = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ISearchResultChangeEvent | null>(null)
  const options = useMemo(() => ({ decorations: findDecorations(token) }), [])

  useEffect(() => focusField(field.current), [focusRequest])

  useEffect(() => {
    const subscription = search.onDidChangeResults(setResults)

    return () => {
      subscription.dispose()
      search.clearDecorations()
    }
  }, [search])

  const change = (text: string): void => {
    setQuery(text)
    // An empty search clears the highlights and the selection; the count then reads nothing.
    search.findNext(text, { ...options, incremental: true })

    if (text === '') setResults(null)
  }

  const step = (forward: boolean): void => {
    if (query === '') return

    if (forward) search.findNext(query, options)
    else search.findPrevious(query, options)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
      e.preventDefault()
      focusField(field.current)
    }
  }

  return (
    <div
      className="terminal-find"
      role="search"
      aria-label="Find in terminal"
      data-testid={`terminal-${id}-find`}
      onKeyDown={onKeyDown}
    >
      <input
        ref={field}
        aria-label="Find"
        data-testid={`terminal-${id}-find-input`}
        value={query}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => change(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          e.preventDefault()
          step(!e.shiftKey)
        }}
      />
      <span
        className="terminal-find-count"
        role="status"
        aria-label="Matches"
        data-testid={`terminal-${id}-find-count`}
      >
        {findCountText(results)}
      </span>
      <button
        type="button"
        className="ghost icon"
        aria-label="Previous match"
        title="Previous match (⇧⏎)"
        data-testid={`terminal-${id}-find-previous`}
        onClick={() => step(false)}
      >
        <ChevronUpIcon />
      </button>
      <button
        type="button"
        className="ghost icon"
        aria-label="Next match"
        title="Next match (⏎)"
        data-testid={`terminal-${id}-find-next`}
        onClick={() => step(true)}
      >
        <ChevronDownIcon />
      </button>
    </div>
  )
}
