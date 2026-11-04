// What a terminal does with the keys a Mac text field would edit with, and the Option setting.
import type { UserConfig } from '../../preload/index.d'

/**
 * The control character for Cmd+Backspace, Cmd+Left or Cmd+Right, or null for any other key:
 * Ctrl+U clears to the start of the line, Ctrl+A and Ctrl+E go to its start and end, in a shell's
 * line editor and in Claude Code alike. With another modifier held it is someone else's shortcut
 * (Cmd+Option+arrows move between panes).
 */
export function lineEditSequence(
  ev: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>
): string | null {
  if (!ev.metaKey || ev.ctrlKey || ev.altKey || ev.shiftKey) return null

  if (ev.key === 'Backspace') return '\x15'

  if (ev.key === 'ArrowLeft') return '\x01'

  if (ev.key === 'ArrowRight') return '\x05'

  return null
}

/** A config as any build of the daemon sends it: one from before this setting leaves it out. */
type SentConfig = Omit<UserConfig, 'terminal'> & Partial<Pick<UserConfig, 'terminal'>>

/** Whether Option acts as Meta: the setting, on until the config says otherwise. */
export function optionAsMeta(config: SentConfig | undefined): boolean {
  return config?.terminal?.optionAsMeta ?? true
}
