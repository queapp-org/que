import { describe, expect, it, vi } from 'vitest'
import { browserUrl, openTerminalLink } from './terminal-links'

const click = (metaKey: boolean): MouseEvent => new MouseEvent('click', { metaKey })

/** Runs a click and returns what reached window.open, which the main process receives. */
function opened(event: MouseEvent, uri: string): unknown[] {
  const open = vi.spyOn(window, 'open').mockReturnValue(null)
  openTerminalLink(event, uri)
  const calls = open.mock.calls.map(([url]) => url)
  open.mockRestore()

  return calls
}

describe('openTerminalLink', () => {
  it('opens an http or https link on Cmd+click', () => {
    expect(opened(click(true), 'https://example.com/a?b=c#d')).toEqual([
      'https://example.com/a?b=c#d'
    ])
    expect(opened(click(true), 'http://localhost:5173/')).toEqual(['http://localhost:5173/'])
  })

  it('does nothing on a plain click', () => {
    expect(opened(click(false), 'https://example.com/a')).toEqual([])
  })

  it.each([
    'file:///etc/hosts',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'ssh://example.com/etc/hosts',
    'not a url',
    ''
  ])('never opens %s', (uri) => {
    expect(opened(click(true), uri)).toEqual([])
  })
})

describe('browserUrl', () => {
  it("writes the scheme and host in the lower case the main process's filter expects", () => {
    expect(browserUrl('HTTPS://Example.COM/Path')).toBe('https://example.com/Path')
  })
})
