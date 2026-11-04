// OSC 52: a program sets the clipboard through its output, even over ssh. Anything that can print to
// the terminal can use it, so this reads as little as it can: only a write to the clipboard
// selection, only well-formed text, only so much of it. A program never reads the clipboard.

import { hasControlCharacters } from './terminal-paste'

/** The largest text a program may set, decoded. */
export const OSC52_MAX_BYTES = 1024 * 1024

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * The text an OSC 52 payload (`<selection>;<base64>`) sets the clipboard to, or null to ignore it:
 * a selection other than `c` or none, a query (`?`), an empty payload (a request to clear), base64
 * that is not strict and canonical, text that is not UTF-8 or holds control characters, or more
 * than the limit.
 */
export function decodeOsc52(payload: string): string | null {
  const separator = payload.indexOf(';')

  if (separator === -1) return null
  const selection = payload.slice(0, separator)
  const encoded = payload.slice(separator + 1)

  if (selection !== '' && selection !== 'c') return null

  if (encoded.length % 4 !== 0 || !BASE64.test(encoded)) return null

  // Counted from the length, so an oversized payload is never decoded.
  const padding = encoded.length - encoded.replace(/=+$/, '').length

  if ((encoded.length / 4) * 3 - padding > OSC52_MAX_BYTES) return null
  const binary = atob(encoded)

  // Stray bits after the last byte decode without complaint; only canonical base64 round-trips.
  if (btoa(binary) !== encoded) return null

  try {
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))

    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)

    // Rejected, not cleaned: the text can be pasted anywhere, not only into a terminal of ours, so
    // printing a hostile file must not arm the next paste.
    return hasControlCharacters(text) ? null : text
  } catch {
    return null
  }
}
