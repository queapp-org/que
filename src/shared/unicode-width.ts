// How wide a character is in a terminal. The daemon's mirror and the renderer's xterm both load
// this, so a snapshot restored from the mirror lays out the way the renderer draws live output.
import { Unicode11Addon } from '@xterm/addon-unicode11'

const UNICODE_VERSION = '11'

/**
 * Switches a terminal, browser or headless, to Unicode 11 widths, where ✅, 🚀 and 🧠 take two
 * cells as the programs printing them expect. Call it before anything is written: what is already
 * in the buffer keeps the widths it was laid out with.
 */
export function applyUnicodeWidths(term: {
  loadAddon(addon: Unicode11Addon): void
  unicode: { activeVersion: string }
}): void {
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = UNICODE_VERSION
}
