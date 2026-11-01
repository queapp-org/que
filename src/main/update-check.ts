// The app's update check: at most once a day, ask GitHub for the latest
// release and say whether it is newer than the running version. Every input
// that varies (clock, network, state file) is injected; failures of any kind
// (offline, 403/404 while the repository is private, bad JSON) are silent.
import fs from 'node:fs'
import { dirname } from 'node:path'
import type { UpdateInfo } from '../shared/types'
import {
  decodeRelease,
  decodeUpdateCheckState,
  type GhRelease,
  type UpdateCheckState
} from './update-check.decode'

export type { UpdateCheckState, UpdateInfo }

export const LATEST_RELEASE_URL = 'https://api.github.com/repos/queapp-org/que/releases/latest'
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

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

/** The once-a-day gate: no state, or the last attempt is a day old (or in the future). */
export function shouldCheck(state: UpdateCheckState | null, now: number): boolean {
  if (!state) return true
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
    // Not worth failing over; the next launch simply checks again.
  }
}

export interface UpdateCheckOptions {
  currentVersion: string
  statePath: string
  now?: () => number
  fetch?: typeof fetch
  url?: string
  timeoutMs?: number
}

/** The decoded release, if it is a usable one. */
function releaseOf(release: GhRelease | null): UpdateInfo | null {
  if (!release || !release.htmlUrl.startsWith('https://github.com/')) return null

  if (!parseVersion(release.tagName)) return null

  return { version: release.tagName.replace(/^v/, ''), url: release.htmlUrl }
}

/**
 * Asks for the latest release unless one was asked for within the last day,
 * and resolves to it when it is newer than `currentVersion`, else null. Never
 * rejects.
 */
export async function checkForUpdate(opts: UpdateCheckOptions): Promise<UpdateInfo | null> {
  const now = opts.now ?? Date.now
  const prev = readState(opts.statePath)

  const newer = (s: UpdateCheckState | null): UpdateInfo | null =>
    s?.latest && isNewer(s.latest.version, opts.currentVersion) ? s.latest : null

  if (!shouldCheck(prev, now())) return newer(prev)

  const state: UpdateCheckState = { checkedAt: now(), latest: null }

  try {
    const res = await (opts.fetch ?? fetch)(opts.url ?? LATEST_RELEASE_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `que/${opts.currentVersion}`
      },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000)
    })

    if (res.ok) state.latest = releaseOf(decodeRelease(await res.json()))
  } catch {
    // Offline, timed out, or not JSON: say nothing.
  }

  writeState(opts.statePath, state)

  return newer(state)
}
