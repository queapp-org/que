// The app's update check: once the last attempt is six hours old, or failed, ask
// GitHub for the latest release and say whether it is newer than the running version.
// Every input that varies (clock, network, state file) is injected. Nothing here throws:
// an attempt with no usable answer (offline, a 403 or 404, bad JSON, a release page off
// github.com) is reported and recorded as failed, keeping the release it already knew of.
import fs from 'node:fs'
import { dirname, join } from 'node:path'
import type { UpdateInfo, UpdateStatus } from '../shared/types'
import {
  decodeLocalBuild,
  decodeRelease,
  decodeUpdateCheckState,
  type GhRelease,
  type UpdateCheckState
} from './update-check.decode'

export type { UpdateCheckState, UpdateInfo }

export const LATEST_RELEASE_URL = 'https://api.github.com/repos/queapp-org/que/releases/latest'
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * How often an open app looks at the interval. Shorter than the interval so a Mac waking
 * from sleep catches up within the hour, and a failed attempt retries on the next tick.
 */
export const CHECK_TICK_MS = 60 * 60 * 1000

/** What one check says: the part of UpdateStatus that changes between attempts. */
export type UpdateCheckResult = Pick<UpdateStatus, 'update' | 'checkedAt' | 'failed'>

type Semver = { core: [number, number, number]; pre: string[] }

/** `v1.2.3`, `1.2.3-beta.1` → parts; null for anything else. */
export function parseVersion(v: string): Semver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim())

  if (!m) return null

  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] }
}

/** Semver precedence: negative if a < b, 0 if equal, positive if a > b. */
function compare(a: Semver, b: Semver): number {
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i]

  // A release outranks any of its prereleases.
  if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length

  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i]
    const y = b.pre[i]

    if (x === undefined) return -1

    if (y === undefined) return 1
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)

    if (nx && ny && Number(x) !== Number(y)) return Number(x) - Number(y)

    if (nx !== ny) return nx ? -1 : 1

    if (x !== y) return x < y ? -1 : 1
  }

  return 0
}

/** True only when both parse and `latest` is strictly newer than `current`. */
export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest)
  const b = parseVersion(current)

  return a !== null && b !== null && compare(a, b) > 0
}

/**
 * Only a release asks for newer releases: a packaged build whose package.json carries no
 * local-build mark. `npm run dev` is not packaged, and `npm run package` (which install:local runs) marks its bundle;
 * releases build with `npm run dist`.
 */
export function isReleaseBuild(isPackaged: boolean, localBuild: string | null): boolean {
  return isPackaged && localBuild === null
}

/** The local-build mark in the package.json at `appPath`; null without one or when unreadable. */
export function readLocalBuild(appPath: string): string | null {
  try {
    return decodeLocalBuild(JSON.parse(fs.readFileSync(join(appPath, 'package.json'), 'utf8')))
  } catch {
    return null
  }
}

/** The interval's gate: no state, a failed last attempt, or one that is six hours old (or in the future). */
export function shouldCheck(state: UpdateCheckState | null, now: number): boolean {
  if (!state || state.failed) return true
  const age = now - state.checkedAt

  return age >= CHECK_INTERVAL_MS || age < 0
}

export function readState(path: string): UpdateCheckState | null {
  try {
    return decodeUpdateCheckState(JSON.parse(fs.readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}

function writeState(path: string, state: UpdateCheckState): void {
  try {
    fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    fs.writeFileSync(path, `${JSON.stringify(state)}\n`)
  } catch {
    // Not worth failing over; the next tick simply checks again.
  }
}

export interface UpdateCheckOptions {
  currentVersion: string
  statePath: string
  now?: () => number
  fetch?: typeof fetch
  url?: string
  timeoutMs?: number
  /** Ask whatever the interval says (a click on Check for updates). */
  force?: boolean
}

/** The decoded release, if it is a usable one. */
function releaseOf(release: GhRelease | null): UpdateInfo | null {
  if (!release || !release.htmlUrl.startsWith('https://github.com/')) return null

  if (!parseVersion(release.tagName)) return null

  return { version: release.tagName.replace(/^v/, ''), url: release.htmlUrl }
}

/** What a record says to the app: its release when newer than `currentVersion`, and how the attempt went. */
function resultOf(state: UpdateCheckState | null, currentVersion: string): UpdateCheckResult {
  const latest = state?.latest

  return {
    update: latest && isNewer(latest.version, currentVersion) ? latest : null,
    checkedAt: state?.checkedAt ?? null,
    failed: state?.failed ?? false
  }
}

/**
 * Asks for the latest release, unless the interval says the record still stands (`force`
 * skips that), and resolves to what the record now says. Never rejects.
 */
export async function checkForUpdate(opts: UpdateCheckOptions): Promise<UpdateCheckResult> {
  const now = opts.now ?? Date.now
  const prev = readState(opts.statePath)

  if (!opts.force && !shouldCheck(prev, now())) return resultOf(prev, opts.currentVersion)

  const state: UpdateCheckState = { checkedAt: now(), latest: prev?.latest ?? null, failed: true }

  try {
    const res = await (opts.fetch ?? fetch)(opts.url ?? LATEST_RELEASE_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `que/${opts.currentVersion}`
      },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000)
    })

    const release = res.ok ? releaseOf(decodeRelease(await res.json())) : null

    if (release) {
      state.latest = release
      state.failed = false
    }
  } catch {
    // Offline, timed out, or not JSON: the attempt stays failed.
  }

  writeState(opts.statePath, state)

  return resultOf(state, opts.currentVersion)
}
