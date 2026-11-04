import { describe, expect, it } from 'vitest'
import { decoders, ParamsError } from './methods.decode'
import { METHODS, RENDERER_METHODS } from './protocol'

describe('decoders', () => {
  it('reads required and optional fields, treating null as absent', () => {
    expect(
      decoders['term.create']({ cols: 120, rows: 40, name: 'api-shell', cwd: null, args: ['-l'] })
    ).toEqual({
      cwd: undefined,
      cols: 120,
      rows: 40,
      name: 'api-shell',
      file: undefined,
      args: ['-l']
    })
  })

  it('names the field and the type it wanted', () => {
    expect(() => decoders['term.kill']({ id: 7 })).toThrow(new ParamsError('id must be a string'))
    expect(() => decoders['term.resize']({ id: 'term_01', cols: 0, rows: 24 })).toThrow(
      'cols must be a positive number'
    )
    expect(() => decoders['term.create']({ cols: 80, rows: 24, args: [1] })).toThrow(
      'args must be an array of strings'
    )
    expect(() => decoders['project.remove']({ id: 'proj_01', force: 'yes' })).toThrow(
      'force must be a boolean'
    )
    expect(() => decoders['quiet.unlock']({ minutes: Infinity })).toThrow(
      'minutes must be a number'
    )
  })

  it('accepts missing params where every field is optional', () => {
    expect(decoders['daemon.ping'](undefined)).toBeUndefined()
    expect(decoders['quiet.unlock'](undefined)).toEqual({ minutes: undefined, why: undefined })
    expect(decoders['report.get']({})).toEqual({ since: undefined })
  })

  it('rejects missing params where a field is required', () => {
    expect(() => decoders['workspace.get'](undefined)).toThrow('id must be a string')
  })

  it('hands a config patch through as an object and refuses anything else', () => {
    const patch = { notifications: { sound: false } }

    expect(decoders['config.set']({ patch, applyTonight: true })).toEqual({
      patch,
      applyTonight: true
    })
    expect(() => decoders['config.set']({ patch: [] })).toThrow('patch must be an object')
    expect(() => decoders['config.set']({})).toThrow('patch must be an object')
  })

  it('refuses a hook event payload that is not a hook event', () => {
    expect(() => decoders['hook.event']({ workspaceId: 'ws_01', payload: 'Stop' })).toThrow(
      'payload must be a hook event'
    )
  })

  it("takes a loose terminal's hook by its terminal alone, and refuses one from neither", () => {
    const payload = {
      hook_event_name: 'SessionStart',
      session_id: '3c9e7b21-8d4a-4f6e-b2c1-9a7d5e3f1b08',
      cwd: '/Users/dev/notes',
      transcript_path: '/Users/dev/.claude/projects/-Users-dev-notes/3c9e7b21.jsonl'
    }

    expect(decoders['hook.event']({ terminalId: 'term_01', payload })).toEqual({
      terminalId: 'term_01',
      payload
    })
    expect(() => decoders['hook.event']({ payload })).toThrow(
      'workspaceId or terminalId is required'
    )
  })
})

describe('method table', () => {
  it('keeps the daemon-only calls away from the window', () => {
    const hidden = Object.keys(METHODS).filter((m) => !RENDERER_METHODS.has(m as never))

    expect(hidden).toEqual([
      'daemon.ping',
      'daemon.shutdown',
      'daemon.handoff',
      'workspace.create',
      'workspace.start',
      'hook.event',
      'usage.report'
    ])
  })
})
