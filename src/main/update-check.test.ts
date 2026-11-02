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
  const answered = { checkedAt: T0, latest: null, failed: false }

  it('checks with no record, and again once six hours have passed', () => {
    expect(CHECK_INTERVAL_MS).toBe(6 * HOUR)
    expect(shouldCheck(null, T0)).toBe(true)
    expect(shouldCheck(answered, T0 + CHECK_INTERVAL_MS - 1)).toBe(false)
    expect(shouldCheck(answered, T0 + CHECK_INTERVAL_MS)).toBe(true)
  })

  it('checks when the record is from the future (the clock was moved back)', () => {
    expect(shouldCheck({ ...answered, checkedAt: T0 + HOUR }, T0)).toBe(true)
  })

  it('checks right after a failed attempt', () => {
    expect(shouldCheck({ ...answered, failed: true }, T0 + 1)).toBe(true)
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

  const RELEASE_0_2_0 = {
    version: '0.2.0',
    url: 'https://github.com/rquellh/que/releases/tag/v0.2.0'
  }

  const offline = () => fakeFetch(() => Promise.reject(new TypeError('fetch failed')))

  it('reports a newer release and remembers when it asked', async () => {
    const fetch = fakeFetch(() => release('v0.2.0'))

    const result = await checkForUpdate({
      currentVersion: '0.1.0',
      statePath,
      now: () => T0,
      fetch
    })

    expect(result).toEqual({ update: RELEASE_0_2_0, checkedAt: T0, failed: false })
    expect(fetch.calls).toEqual([LATEST_RELEASE_URL])
    expect(readState(statePath)).toEqual({ checkedAt: T0, latest: RELEASE_0_2_0, failed: false })
  })

  it('asks at most once in six hours, answering from the record in between', async () => {
    const fetch = fakeFetch(() => release('v0.2.0'))
    const opts = { currentVersion: '0.1.0', statePath, fetch }

    await checkForUpdate({ ...opts, now: () => T0 })
    const later = await checkForUpdate({ ...opts, now: () => T0 + 5 * HOUR })
    expect(fetch.calls).toHaveLength(1)
    expect(later).toEqual({ update: RELEASE_0_2_0, checkedAt: T0, failed: false })

    await checkForUpdate({ ...opts, now: () => T0 + 6 * HOUR })
    expect(fetch.calls).toHaveLength(2)
  })

  it('asks inside the interval when forced', async () => {
    const fetch = fakeFetch(() => release('v0.2.0'))
    const opts = { currentVersion: '0.1.0', statePath, fetch }
    await checkForUpdate({ ...opts, now: () => T0 })

    const forced = await checkForUpdate({ ...opts, now: () => T0 + HOUR, force: true })

    expect(fetch.calls).toHaveLength(2)
    expect(forced.checkedAt).toBe(T0 + HOUR)
  })

  it('answers up to date when the latest release is the running version', async () => {
    const fetch = fakeFetch(() => release('v0.1.0'))

    expect(
      await checkForUpdate({ currentVersion: '0.1.0', statePath, now: () => T0, fetch })
    ).toEqual({ update: null, checkedAt: T0, failed: false })
  })

  it.each([
    ['a network error', () => Promise.reject(new TypeError('fetch failed'))],
    ['a 404', () => new Response('{"message":"Not Found"}', { status: 404 })],
    ['a 403', () => new Response('{"message":"rate limited"}', { status: 403 })],
    ['a body that is not JSON', () => new Response('<html>', { status: 200 })],
    ['JSON that is not a release', () => new Response('{"message":"hello"}', { status: 200 })],
    ['a tag that is not a version', () => release('nightly')],
    ['a release page off github.com', () => release('v9.9.9', 'https://example.invalid/que')]
  ])('counts %s as failed, without rejecting', async (_what, respond) => {
    const fetch = fakeFetch(respond)

    expect(
      await checkForUpdate({ currentVersion: '0.1.0', statePath, now: () => T0, fetch })
    ).toEqual({ update: null, checkedAt: T0, failed: true })
  })

  it('keeps the release it knew through a failed attempt, and records the failure', async () => {
    const opts = { currentVersion: '0.1.0', statePath }
    await checkForUpdate({ ...opts, now: () => T0, fetch: fakeFetch(() => release('v0.2.0')) })

    const result = await checkForUpdate({
      ...opts,
      now: () => T0 + 7 * HOUR,
      fetch: offline()
    })

    expect(result).toEqual({ update: RELEASE_0_2_0, checkedAt: T0 + 7 * HOUR, failed: true })
    expect(readState(statePath)).toEqual({
      checkedAt: T0 + 7 * HOUR,
      latest: RELEASE_0_2_0,
      failed: true
    })
  })

  it('does not count a failed attempt toward the interval: the next call asks again', async () => {
    const fetch = offline()
    const opts = { currentVersion: '0.1.0', statePath, fetch }

    await checkForUpdate({ ...opts, now: () => T0 })
    await checkForUpdate({ ...opts, now: () => T0 + HOUR })

    expect(fetch.calls).toHaveLength(2)
  })

  it('clears the failure on a later success, and the interval counts from it', async () => {
    const opts = { currentVersion: '0.1.0', statePath }
    await checkForUpdate({ ...opts, now: () => T0, fetch: offline() })
    const fetch = fakeFetch(() => release('v0.2.0'))

    const result = await checkForUpdate({ ...opts, now: () => T0 + HOUR, fetch })
    await checkForUpdate({ ...opts, now: () => T0 + 2 * HOUR, fetch })

    expect(result).toEqual({ update: RELEASE_0_2_0, checkedAt: T0 + HOUR, failed: false })
    expect(fetch.calls).toHaveLength(1)
  })
})
