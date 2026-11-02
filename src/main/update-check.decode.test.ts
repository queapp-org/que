import { describe, expect, it } from 'vitest'
import { decodeRelease, decodeUpdateCheckState } from './update-check.decode'

// Trimmed from GitHub's `GET /repos/{owner}/{repo}/releases/latest` answer.
const LATEST = {
  url: 'https://api.github.com/repos/rquellh/que/releases/251130',
  html_url: 'https://github.com/rquellh/que/releases/tag/v0.2.0',
  id: 251130,
  tag_name: 'v0.2.0',
  target_commitish: 'main',
  name: 'v0.2.0',
  draft: false,
  prerelease: false,
  created_at: '2026-10-14T08:40:00Z',
  published_at: '2026-10-14T08:45:00Z',
  assets: [],
  body: 'Quiet mode fixes.'
}

describe('decodeRelease', () => {
  it('reads the tag and the page of the latest release', () => {
    expect(decodeRelease(LATEST)).toEqual({
      tagName: 'v0.2.0',
      htmlUrl: 'https://github.com/rquellh/que/releases/tag/v0.2.0'
    })
  })

  it.each([
    [null],
    ['<html>'],
    [[LATEST]],
    [{ message: 'Not Found', documentation_url: 'https://docs.github.com/rest' }],
    [{ ...LATEST, tag_name: 2 }],
    [{ ...LATEST, html_url: null }]
  ])('drops %j', (body) => {
    expect(decodeRelease(body)).toBeNull()
  })
})

describe('decodeUpdateCheckState', () => {
  const info = { version: '0.2.0', url: 'https://github.com/rquellh/que/releases/tag/v0.2.0' }
  const T0 = new Date(2026, 9, 14, 9, 0).getTime()

  it('reads back what the check wrote', () => {
    expect(
      decodeUpdateCheckState(
        JSON.parse(JSON.stringify({ checkedAt: T0, latest: info, failed: false }))
      )
    ).toEqual({ checkedAt: T0, latest: info, failed: false })
    expect(decodeUpdateCheckState({ checkedAt: T0, latest: info, failed: true })).toEqual({
      checkedAt: T0,
      latest: info,
      failed: true
    })
  })

  it('reads a file from a build before failed as not failed', () => {
    expect(decodeUpdateCheckState({ checkedAt: T0, latest: null })).toEqual({
      checkedAt: T0,
      latest: null,
      failed: false
    })
  })

  it('reads a malformed latest release as none', () => {
    expect(decodeUpdateCheckState({ checkedAt: T0, latest: { version: 2 } })).toEqual({
      checkedAt: T0,
      latest: null,
      failed: false
    })
  })

  it.each([[null], ['text'], [{}], [{ checkedAt: '2026-10-14' }], [[T0]]])('drops %j', (raw) => {
    expect(decodeUpdateCheckState(raw)).toBeNull()
  })
})
