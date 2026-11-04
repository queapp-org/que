// Control characters in text on its way to a terminal. xterm's paste leaves them in, and an escape
// can end a bracketed paste early, so that whatever follows it runs. Tabs and line ends stay.

// C0 except tab, LF and CR, then DEL and C1.
// oxlint-disable-next-line no-control-regex -- control characters are what this exists to find
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g

export function hasControlCharacters(text: string): boolean {
  return text.search(CONTROL) !== -1
}

/** Pasted text with its control characters taken out, ready for term.paste. */
export function sanitizePaste(text: string): string {
  return text.replace(CONTROL, '')
}
