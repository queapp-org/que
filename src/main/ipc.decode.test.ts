import { describe, expect, it } from 'vitest'
import { makeWorkspace } from '../testing/fixtures'
import { decodeAbsolutePath, decodeWorkspaceId } from './ipc.decode'

describe('decodeAbsolutePath', () => {
  it("accepts the worktree path the renderer sends for a workspace's Open in editor", () => {
    const ws = makeWorkspace({ name: 'APP-1432-retry-logic' })

    expect(decodeAbsolutePath(ws.path)).toBe(ws.path)
  })

  it('drops relative paths and anything that is not a string', () => {
    expect(decodeAbsolutePath('worktrees/que/APP-1432-retry-logic')).toBeNull()
    expect(decodeAbsolutePath('')).toBeNull()
    expect(decodeAbsolutePath({ path: '/Users/dev/que' })).toBeNull()
    expect(decodeAbsolutePath(undefined)).toBeNull()
  })
})

describe('decodeWorkspaceId', () => {
  it('accepts a workspace id the daemon draws', () => {
    expect(decodeWorkspaceId('ws_abcdefg23456')).toBe('ws_abcdefg23456')
  })

  it('drops anything that could leave the logs folder, and anything else', () => {
    expect(decodeWorkspaceId('../../secrets')).toBeNull()
    expect(decodeWorkspaceId('ws_abc/../../secrets')).toBeNull()
    expect(decodeWorkspaceId('prj_abcdefg23456')).toBeNull()
    expect(decodeWorkspaceId(undefined)).toBeNull()
  })
})
