import { describe, expect, it } from 'vitest'
import { pasteablePath, pasteablePaths, shQuote } from './sh-quote'

describe('shQuote', () => {
  it('single-quotes, and spells a single quote out', () => {
    expect(shQuote('/tmp/a b')).toBe(`'/tmp/a b'`)
    expect(shQuote(`it's`)).toBe(`'it'\\''s'`)
  })
})

describe('pasteablePaths', () => {
  it('separates the words with one space and adds no newline', () => {
    expect(pasteablePaths(['/tmp/a b.png', '/tmp/c.txt'])).toBe(`'/tmp/a b.png' '/tmp/c.txt'`)
  })

  it('is empty for no paths', () => {
    expect(pasteablePaths([])).toBe('')
  })
})

describe('pasteablePath', () => {
  it('uses plain single quotes for a path with no control character', () => {
    expect(pasteablePath(`/tmp/it's $HOME \`here\`.png`)).toBe(`'/tmp/it'\\''s $HOME \`here\`.png'`)
  })

  it('never lets a newline or an escape through raw', () => {
    const word = pasteablePath('/tmp/a\nb\r\x1b[201~c.png')

    expect(word).toBe(`$'/tmp/a\\x0ab\\x0d\\x1b[201~c.png'`)
    // oxlint-disable-next-line no-control-regex -- the assertion is about control characters
    expect(word).not.toMatch(/[\x00-\x1f\x7f]/)
  })
})
