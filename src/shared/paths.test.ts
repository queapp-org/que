import { afterEach, describe, expect, it, vi } from 'vitest'

import { describeSocket, quePaths } from './paths'

const LONG = '/very/long/home/'.repeat(8)

function paths(home: string) {
  vi.stubEnv('QUE_HOME', home)

  return quePaths()
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('quePaths socket', () => {
  it('keeps the socket in a short home', () => {
    const p = paths('/tmp/q')

    expect(p.socket).toBe('/tmp/q/daemon.sock')
    expect(p.socketFallback).toBe(false)
  })

  it('gives different long homes different fallback sockets under the limit', () => {
    const a = paths(`${LONG}a`)
    const b = paths(`${LONG}b`)

    expect(a.socketFallback).toBe(true)
    expect(a.socket).not.toBe(b.socket)
    expect(a.socket).toMatch(/^\/tmp\/que-\d+\/[0-9a-f]{16}\.sock$/)
    expect(a.socket.length).toBeLessThan(104)
  })

  it('maps one long home to one socket however it is spelled', () => {
    const plain = paths(`${LONG}a`).socket

    expect(paths(`${LONG}a/`).socket).toBe(plain)
    expect(paths(`${LONG}x/../a`).socket).toBe(plain)
  })
})

describe('describeSocket', () => {
  it('says when the socket moved', () => {
    expect(describeSocket({ socket: '/tmp/q/daemon.sock', socketFallback: false })).toBe(
      '/tmp/q/daemon.sock'
    )
    expect(describeSocket({ socket: '/tmp/que-1/x.sock', socketFallback: true })).toBe(
      '/tmp/que-1/x.sock (moved to /tmp: the home path is too long)'
    )
  })
})
