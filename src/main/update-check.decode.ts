// Decodes the payloads the update check reads: GitHub's latest-release JSON,
// the check state que persisted on an earlier launch, and the app's bundled
// package.json.
import type { UpdateInfo } from '../shared/types'
import { isObj } from '../shared/json.decode'

/** What is persisted between launches (QUE_HOME/state/update-check.json). */
export interface UpdateCheckState {
  /** Epoch ms of the last attempt, successful or not. */
  checkedAt: number
  /** The newest release seen by that attempt, if any. */
  latest: UpdateInfo | null
}

/** The fields of `GET /repos/{owner}/{repo}/releases/latest` the check uses. */
export interface GhRelease {
  tagName: string
  htmlUrl: string
}

/** The release; null without a tag and a page url (an error body, say). */
export function decodeRelease(v: unknown): GhRelease | null {
  if (!isObj(v) || typeof v.tag_name !== 'string' || typeof v.html_url !== 'string') return null

  return { tagName: v.tag_name, htmlUrl: v.html_url }
}

/** The persisted state; null without a numeric checkedAt. A malformed `latest` reads as none. */
export function decodeUpdateCheckState(v: unknown): UpdateCheckState | null {
  if (!isObj(v) || typeof v.checkedAt !== 'number') return null
  const l = v.latest

  const latest =
    isObj(l) && typeof l.version === 'string' && typeof l.url === 'string'
      ? { version: l.version, url: l.url }
      : null

  return { checkedAt: v.checkedAt, latest }
}

/**
 * The local-build mark in the app's bundled package.json (`queLocalBuild`, the git short
 * sha `npm run package` built from); null without one. electron-builder's command
 * line reads an all-digit sha as a number, so a number is a mark too.
 */
export function decodeLocalBuild(v: unknown): string | null {
  if (!isObj(v)) return null
  const mark = v.queLocalBuild

  if (typeof mark === 'string' && mark !== '') return mark

  if (typeof mark === 'number') return String(mark)

  return null
}
