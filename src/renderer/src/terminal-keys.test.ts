import { describe, expect, it } from 'vitest'
import { lineEditSequence, optionAsMeta } from './terminal-keys'
import { makeUserConfig } from './testing/fixtures'

const cmd = (key: string, more: Partial<KeyboardEvent> = {}) => ({
  key,
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...more
})

describe('lineEditSequence', () => {
  it('sends Ctrl+U for Cmd+Backspace, Ctrl+A for Cmd+Left and Ctrl+E for Cmd+Right', () => {
    expect(lineEditSequence(cmd('Backspace'))).toBe('\x15')
    expect(lineEditSequence(cmd('ArrowLeft'))).toBe('\x01')
    expect(lineEditSequence(cmd('ArrowRight'))).toBe('\x05')
  })

  it('leaves the other Cmd keys alone', () => {
    expect(lineEditSequence(cmd('ArrowUp'))).toBeNull()
    expect(lineEditSequence(cmd('c'))).toBeNull()
  })

  it('leaves the keys alone without Cmd', () => {
    expect(lineEditSequence(cmd('Backspace', { metaKey: false }))).toBeNull()
    expect(lineEditSequence(cmd('ArrowLeft', { metaKey: false }))).toBeNull()
  })

  it('leaves a shortcut with another modifier to its owner: Cmd+Option+arrows move between panes', () => {
    expect(lineEditSequence(cmd('ArrowLeft', { altKey: true }))).toBeNull()
    expect(lineEditSequence(cmd('ArrowRight', { altKey: true }))).toBeNull()
    expect(lineEditSequence(cmd('ArrowLeft', { shiftKey: true }))).toBeNull()
    expect(lineEditSequence(cmd('Backspace', { ctrlKey: true }))).toBeNull()
  })
})

describe('optionAsMeta', () => {
  it('reads the setting', () => {
    expect(optionAsMeta(makeUserConfig({ terminal: { optionAsMeta: false } }))).toBe(false)
  })

  it('is on before the config loads, and when a daemon from before the setting leaves it out', () => {
    const { terminal: _left, ...older } = makeUserConfig()

    expect(optionAsMeta(undefined)).toBe(true)
    expect(optionAsMeta(older)).toBe(true)
  })
})
