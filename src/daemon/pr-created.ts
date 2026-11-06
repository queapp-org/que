// Spots the pull requests a session creates itself: a PostToolUse hook for a
// Bash call that ran `gh pr create`, whose output names the new pull request.
// Only a pull request on the project's own origin repository counts.
import type { HookEvent } from '../shared/protocol'
import { type BashCall, decodeBashCall } from './pr-created.decode'

/** `gh pr create` as a command of its own: at the start, after a separator, or by path. */
const PR_CREATE = /(?:^|[\s;&|(/])gh\s+pr\s+create\b/

const PR_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\b/

export interface Repo {
  owner: string
  name: string
}

/** True when a shell command runs `gh pr create`, alone or in a chain. */
export function runsPrCreate(command: string): boolean {
  return PR_CREATE.test(command)
}

/** The Bash call a hook event reports when it ran `gh pr create`; null for any other. */
export function prCreateCall(event: HookEvent): BashCall | null {
  const call = decodeBashCall(event)

  return call && runsPrCreate(call.command) ? call : null
}

/** The owner and name of a GitHub remote (https, ssh or scp form); null for any other. */
export function githubRepo(remote: string): Repo | null {
  const m =
    /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|[^@/\s]+@)github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(
      remote.trim()
    )

  return m?.[1] && m[2] ? { owner: m[1], name: m[2] } : null
}

const sameRepo = (a: Repo, b: Repo): boolean =>
  a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase()

/** True when the call printed a pull request URL on any repository. */
export function printsPullRequest(call: BashCall): boolean {
  return printedPullRequests(call).length > 0
}

/** The pull request URLs a call printed on any repository, in the order they appear, each once. */
export function printedPullRequests(call: BashCall): string[] {
  return [...new Set(call.output.flatMap((text) => text.match(new RegExp(PR_URL, 'g')) ?? []))]
}

/**
 * The pull requests a `gh pr create` call shows the session creating on `repo` (its origin), in
 * the order they appear, each once, with the URL found anywhere in its response (stdout, stderr,
 * or a plain string).
 */
export function createdPullRequests(call: BashCall, repo: Repo): string[] {
  return printedPullRequests(call).filter((url) => {
    const [, owner = '', name = ''] = PR_URL.exec(url) ?? []

    return sameRepo({ owner, name }, repo)
  })
}
