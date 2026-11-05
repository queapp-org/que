// A workspace as the daemon sent it, read as this build's Workspace. The background service
// outlives an app update until Restart, so a newer app often talks to the previous build, which
// does not send the fields added since. Every workspace enters the store through
// withDefaults(): each list and nullable field of a workspace and of its pull requests that a
// build may leave out is filled here, so the rest of the renderer reads complete values.
import type { PullRequest, Workspace } from '../../preload/index.d'

/** The pull request fields a build may leave out: those added after its first build, and the nullable ones. */
type LeftOutPrField =
  | 'review'
  | 'checkRuns'
  | 'updatedAt'
  | 'additions'
  | 'deletions'
  | 'base'
  | 'head'
  | 'comments'
  | 'commentedAt'

/** A pull request as any build of the daemon sends it. */
export type SentPullRequest = Omit<PullRequest, LeftOutPrField> &
  Partial<Pick<PullRequest, LeftOutPrField>>

/** The workspace fields a build may leave out: its lists and its nullable fields, most added after its first build. */
type LeftOutField =
  | 'branches'
  | 'prUrls'
  | 'prs'
  | 'pr'
  | 'statusReason'
  | 'lastActivityAt'
  | 'sessionId'
  | 'archivedAt'
  | 'finishedAt'
  | 'seenAt'
  | 'artifacts'
  | 'backgroundTasks'

/** A workspace as any build of the daemon sends it. */
export type SentWorkspace = Omit<Workspace, LeftOutField> &
  Partial<Pick<Workspace, Exclude<LeftOutField, 'pr' | 'prs'>>> & {
    pr?: SentPullRequest | null
    prs?: SentPullRequest[]
  }

/** The pull request with what a previous build left out: no review or check runs, its counts and times unknown, its branches empty. */
function prWithDefaults(pr: SentPullRequest): PullRequest {
  return {
    ...pr,
    review: pr.review ?? null,
    checkRuns: pr.checkRuns ?? [],
    updatedAt: pr.updatedAt ?? null,
    additions: pr.additions ?? null,
    deletions: pr.deletions ?? null,
    base: pr.base ?? '',
    head: pr.head ?? '',
    comments: pr.comments ?? null,
    commentedAt: pr.commentedAt ?? null
  }
}

/**
 * The workspace with what a previous build left out: no pull requests or background tasks,
 * nothing seen or finished, and its one branch among its branches.
 */
export function withDefaults(ws: SentWorkspace): Workspace {
  return {
    ...ws,
    branches: ws.branches ?? [ws.branch],
    prUrls: ws.prUrls ?? [],
    pr: ws.pr ? prWithDefaults(ws.pr) : null,
    prs: (ws.prs ?? []).map(prWithDefaults),
    statusReason: ws.statusReason ?? null,
    lastActivityAt: ws.lastActivityAt ?? null,
    sessionId: ws.sessionId ?? null,
    archivedAt: ws.archivedAt ?? null,
    finishedAt: ws.finishedAt ?? null,
    seenAt: ws.seenAt ?? null,
    artifacts: ws.artifacts ?? [],
    backgroundTasks: ws.backgroundTasks ?? []
  }
}
