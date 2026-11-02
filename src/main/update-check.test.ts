import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CHECK_INTERVAL_MS,
  checkForUpdate,
  isNewer,
  isReleaseBuild,
  LATEST_RELEASE_URL,
  readLocalBuild,
  readState,
  shouldCheck
} from './update-check'

const T0 = new Date(2026, 9, 14, 9, 0).getTime()
const HOUR = 60 * 60 * 1000

/** A fetch that records its calls and answers with `respond`. */
function fakeFetch(
  respond: () => Response | Promise<Response>
): typeof fetch & { calls: string[] } {
  const calls: string[] = []

  const f = (async (url: string | URL | Request) => {
    calls.push(String(url))

    return respond()
  }) as typeof fetch & { calls: string[] }

  f.calls = calls

  return f
}

const release = (tag: string, url = `https://github.com/rquellh/que/releases/tag/${tag}`) =>
  new Response(JSON.stringify({ tag_name: tag, html_url: url }), { status: 200 })

describe('isNewer', () => {
  it.each([
    ['v0.2.0', '0.1.0', true],
    ['0.1.1', '0.1.0', true],
    ['1.0.0', '0.9.9', true],
    ['v0.10.0', '0.9.0', true],
    ['0.1.0', '0.1.0', false],
    ['v0.1.0', '0.1.0', false],
    ['0.0.9', '0.1.0', false],
    ['0.2.0-beta.1', '0.1.0', true],
    ['0.2.0-beta.1', '0.2.0', false],
    ['0.2.0', '0.2.0-beta.1', true],
    ['0.2.0-beta.2', '0.2.0-beta.1', true],
    ['0.2.0-beta.10', '0.2.0-beta.9', true],
    ['0.2.0-rc.1', '0.2.0-beta.3', true],
    ['nightly', '0.1.0', false],
    ['0.2', '0.1.0', false]
  ])('%s is newer than %s: %s', (latest, current, expected) => {
    expect(isNewer(latest, current)).toBe(expected)
  })
})

describe('shouldCheck', () => {
  it('checks with no record, and again once a full day has passed', () => {
    expect(shouldCheck(null, T0)).toBe(true)
    expect(shouldCheck({ checkedAt: T0, latest: null }, T0 + CHECK_INTERVAL_MS - 1)).toBe(false)
    expect(shouldCheck({ checkedAt: T0, latest: null }, T0 + CHECK_INTERVAL_MS)).toBe(true)
  })

  it('checks when the record is from the future (the clock was moved back)', () => {
    expect(shouldCheck({ checkedAt: T0 + HOUR, latest: null }, T0)).toBe(true)
  })
})

describe('isReleaseBuild', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'que-app-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /** The app's folder with `pkg` as its package.json, as the bundle carries it. */
  function appWith(pkg: Record<string, unknown>): string {
    fs.writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg))

    return dir
  }

  const pkg = { name: 'que', version: '0.2.0', main: './out/main/index.js' }

  it('checks from a packaged build without the local-build mark', () => {
    expect(isReleaseBuild(true, readLocalBuild(appWith(pkg)))).toBe(true)
  })

  it('never checks from a build that is not packaged', () => {
    expect(isReleaseBuild(false, readLocalBuild(appWith(pkg)))).toBe(false)
  })

  it('never checks from a packaged build marked queLocalBuild, even an all-digit sha', () => {
    expect(
      isReleaseBuild(true, readLocalBuild(appWith({ ...pkg, queLocalBuild: 'ab2d083' })))
    ).toBe(false)
    // electron-builder's command line turns -c.extraMetadata.queLocalBuild=3205441 into a number.
    expect(isReleaseBuild(true, readLocalBuild(appWith({ ...pkg, queLocalBuild: 3205441 })))).toBe(
      false
    )
  })
})

describe('checkForUpdate', () => {
  let dir: string
  let statePath: string

  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'que-update-'))
    statePath = join(dir, 'state', 'update-check.json')
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('reports a newer release and remembers when it asked', async () => {
    const fetch = fakeFetch(() => release('v0.2.0'))

    const info = await checkForUpdate({ currentVersion: '0.1.0', statePath, now: () => T0, fetch })

    expect(info).toEqual({
      version: '0.2.0',
      url: 'https://github.com/rquellh/que/releases/tag/v0.2.0'
    })
    expect(fetch.calls).toEqual([LATEST_RELEASE_URL])
    expect(readState(statePath)).toEqual({ checkedAt: T0, latest: info })
  })

  it('asks at most once a day, answering from the record in between', async () => {
    const fetch = fakeFetch(() => release('v0.2.0'))
    const opts = { currentVersion: '0.1.0', statePath, fetch }

    await checkForUpdate({ ...opts, now: () => T0 })
    const later = await checkForUpdate({ ...opts, now: () => T0 + 23 * HOUR })
    expect(fetch.calls).toHaveLength(1)
    expect(later?.version).toBe('0.2.0')

    await checkForUpdate({ ...opts, now: () => T0 + 24 * HOUR })
    expect(fetch.calls).toHaveLength(2)
  })

  it('says nothing when the latest release is the running version', async () => {
    const fetch = fakeFetch(() => release('v0.1.0'))

    expect(
      await checkForUpdate({ currentVersion: '0.1.0', statePath, now: () => T0, fetch })
    ).toBeNull()
  })

  it('stays silent on 404 and 403 (a private repository) and does not ask again that day', async () => {
    for (const status of [404, 403]) {
      fs.rmSync(statePath, { force: true })
      const fetch = fakeFetch(() => new Response('{"message":"Not Found"}', { status }))
      const opts = { currentVersion: '0.1.0', statePath, fetch }

      expect(await checkForUpdate({ ...opts, now: () => T0 })).toBeNull()
      expect(await checkForUpdate({ ...opts, now: () => T0 + HOUR })).toBeNull()
      expect(fetch.calls).toHaveLength(1)
    }
  })

  it('never rejects on a network error or a malformed answer', async () => {
    const offline = fakeFetch(() => Promise.reject(new TypeError('fetch failed')))
    expect(
      await checkForUpdate({ currentVersion: '0.1.0', statePath, now: () => T0, fetch: offline })
    ).toBeNull()

    fs.rmSync(statePath, { force: true })
    const garbage = fakeFetch(() => new Response('<html>', { status: 200 }))
    expect(
      await checkForUpdate({ currentVersion: '0.1.0', statePath, now: () => T0, fetch: garbage })
    ).toBeNull()
  })

  it('ignores a release whose page is not on github.com', async () => {
    const fetch = fakeFetch(() => release('v9.9.9', 'https://example.invalid/que'))

    expect(
      await checkForUpdate({ currentVersion: '0.1.0', statePath, now: () => T0, fetch })
    ).toBeNull()
  })
})
