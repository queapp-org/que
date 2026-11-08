// Paths to the subprocess fakes and readers for their call logs.
import fs from 'node:fs'
import { resolve } from 'node:path'

export const REPO_ROOT = resolve(__dirname, '../..')
export const FAKES_BIN = resolve(REPO_ROOT, 'tests/fakes/bin')

/** Another tool's claude wrapper (tests/fakes/wrappers/claude), for PATH ahead of the fakes. */
export const FAKE_WRAPPERS = resolve(REPO_ROOT, 'tests/fakes/wrappers')

/** One recorded invocation of a fake `claude`, `gh`, or `open`. */
export interface FakeCall {
  argv: string[]
  cwd: string
  /** Recorded by the fake `claude`. */
  pid?: number
  /** Recorded by the fake `claude`: the CLAUDE*, TERM* and QUE_* variable names it saw. */
  env?: string[]
  ts: string
}

/** Reads QUE_FAKE_CLAUDE_LOG / QUE_FAKE_GH_LOG / QUE_FAKE_OPEN_LOG back; [] if nothing ran. */
export function readFakeLog(path: string): FakeCall[] {
  if (!fs.existsSync(path)) return []

  return fs
    .readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FakeCall)
}

/** One run of tests/fakes/wrappers/claude: its pid and the arguments it passed on. */
export interface WrapperRun {
  pid: number
  args: string
}

/** Reads QUE_FAKE_WRAPPER_LOG back; [] if the wrapper never ran. */
export function readWrapperLog(path: string): WrapperRun[] {
  if (!fs.existsSync(path)) return []

  return fs
    .readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [pid, args = ''] = line.split('\t')

      return { pid: Number(pid), args }
    })
}

/** One entry of the fake gh's pull request file ($QUE_FAKE_GH_PRS), as `gh pr list` reports it. */
export interface FakePr {
  number: number
  url: string
  title: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  isDraft: boolean
  baseRefName?: string
  headRefName?: string
  reviewDecision: string
  statusCheckRollup: Array<Record<string, unknown>>
  mergedAt: string | null
  /** When the pull request last changed (ISO); `pr create` stores the current time. */
  updatedAt?: string
  /** Lines added and removed; gh prints them only when the entry has them. */
  additions?: number
  deletions?: number
  /** Issue comments, in the GitHub CLI's `pr view --json comments,reviews` shapes. */
  comments?: unknown[]
  /** Reviews, in the GitHub CLI's `pr view --json comments,reviews` shapes. */
  reviews?: unknown[]
  /** Line comments, in the REST `pulls/{n}/comments` shape. */
  lineComments?: unknown[]
}

/** Reads the fake gh's pull requests: a list per head branch; {} when there are none. */
export function readFakePullRequests(file: string): Record<string, FakePr[]> {
  if (!fs.existsSync(file)) return {}

  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, FakePr[]>
}

const fakePrDefaults = (branch: string, number: number): FakePr => ({
  number,
  url: `https://github.com/rquellh/que/pull/${number}`,
  title: 'Add retry logic',
  state: 'OPEN',
  isDraft: true,
  baseRefName: 'main',
  headRefName: branch,
  reviewDecision: '',
  statusCheckRollup: [],
  mergedAt: null
})

/**
 * Merges `patch` into one of the branch's fake pull requests: the one whose number is
 * `patch.number`, else the newest. A branch with none gets one, with defaults first.
 */
export function setFakePullRequest(file: string, branch: string, patch: Partial<FakePr>): void {
  const all = readFakePullRequests(file)
  const list = all[branch] ?? []

  if (list.length === 0) {
    all[branch] = [{ ...fakePrDefaults(branch, 1), ...patch }]
  } else {
    const newest = list.reduce((a, b) => (b.number > a.number ? b : a))
    const target = list.find((pr) => pr.number === patch.number) ?? newest
    all[branch] = list.map((pr) => (pr === target ? { ...pr, ...patch } : pr))
  }

  fs.writeFileSync(file, JSON.stringify(all, null, 2))
}

/**
 * Adds another pull request to the branch, with defaults first; its number is one past
 * the highest in the file unless `patch` says.
 */
export function addFakePullRequest(file: string, branch: string, patch: Partial<FakePr>): void {
  const all = readFakePullRequests(file)
  const numbers = Object.values(all).flatMap((list) => list.map((pr) => pr.number))
  const number = patch.number ?? Math.max(0, ...numbers) + 1

  all[branch] = [...(all[branch] ?? []), { ...fakePrDefaults(branch, number), ...patch }]
  fs.writeFileSync(file, JSON.stringify(all, null, 2))
}

// Builders for the fake gh's pull request data, in GitHub's own field names,
// so tests and specs never re-type them. Each id counts up from 1001.
let fakeGhId = 1000
const nextFakeGhId = (): number => ++fakeGhId
const FAKE_AT = '2026-10-14T03:00:00Z'

/** One `statusCheckRollup` CheckRun; a completed success unless told otherwise. */
export function fakeCheckRun(p: {
  name: string
  conclusion?: string | null
  status?: string
  workflowName?: string
  detailsUrl?: string
  startedAt?: string
  completedAt?: string
}): Record<string, unknown> {
  const status = p.status ?? 'COMPLETED'
  const completed = status === 'COMPLETED'

  return {
    __typename: 'CheckRun',
    name: p.name,
    status,
    conclusion: p.conclusion === undefined ? (completed ? 'SUCCESS' : null) : p.conclusion,
    workflowName: p.workflowName ?? 'CI',
    detailsUrl: p.detailsUrl ?? `https://github.com/rquellh/que/actions/runs/${nextFakeGhId()}`,
    startedAt: p.startedAt ?? '2026-10-14T02:58:00Z',
    completedAt: completed ? (p.completedAt ?? '2026-10-14T02:59:21Z') : null
  }
}

/** One `statusCheckRollup` StatusContext (a commit status). */
export function fakeStatusContext(p: {
  context: string
  state: 'EXPECTED' | 'ERROR' | 'FAILURE' | 'PENDING' | 'SUCCESS'
  targetUrl?: string
}): Record<string, unknown> {
  return {
    __typename: 'StatusContext',
    context: p.context,
    state: p.state,
    targetUrl: p.targetUrl ?? null,
    createdAt: FAKE_AT
  }
}

/** One issue comment, as `gh pr view --json comments` prints it. */
export function fakeComment(p: {
  author: string
  body: string
  createdAt?: string
  url?: string
}): Record<string, unknown> {
  const id = nextFakeGhId()

  return {
    id: `IC_${id}`,
    author: { login: p.author },
    body: p.body,
    createdAt: p.createdAt ?? FAKE_AT,
    url: p.url ?? `https://github.com/rquellh/que/pull/1#issuecomment-${id}`
  }
}

/** One review, as `gh pr view --json reviews` prints it. */
export function fakeReview(p: {
  author: string
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING'
  body?: string
  submittedAt?: string
}): Record<string, unknown> {
  const id = nextFakeGhId()

  return {
    id: `PRR_${id}`,
    author: { login: p.author },
    body: p.body ?? '',
    state: p.state,
    submittedAt: p.submittedAt ?? FAKE_AT,
    url: `https://github.com/rquellh/que/pull/1#pullrequestreview-${id}`
  }
}

/** One review comment on a line, as the REST `pulls/{n}/comments` list returns it. */
export function fakeLineComment(p: {
  author: string
  body: string
  path: string
  line: number
  hunk?: string
  createdAt?: string
}): Record<string, unknown> {
  const id = nextFakeGhId()

  return {
    id,
    user: { login: p.author },
    body: p.body,
    created_at: p.createdAt ?? FAKE_AT,
    html_url: `https://github.com/rquellh/que/pull/1#discussion_r${id}`,
    path: p.path,
    line: p.line,
    original_line: p.line,
    diff_hunk: p.hunk ?? `@@ -1,3 +1,4 @@\n context\n+${p.body.split('\n')[0]}`
  }
}

/** One issue as `acli jira workitem search/view --json` prints it. */
export interface FakeIssue {
  key: string
  id: string
  self: string
  fields: {
    summary: string
    status: { name: string; statusCategory: { key: string } }
    priority: { name: string } | null
    issuetype: { name: string; hierarchyLevel?: number; subtask?: boolean }
    assignee: { displayName: string } | null
    /** The parent, as `view --fields parent` returns it. */
    parent?: {
      key: string
      id: string
      self: string
      fields: {
        summary: string
        status: { name: string; statusCategory: { key: string } }
        priority: { name: string } | null
        issuetype: { name: string; hierarchyLevel?: number; subtask?: boolean }
      }
    }
    project: { key: string; name: string }
    labels: string[]
    updated: string
    description: unknown
  }
}

/** An issue in acli's shape; `overrides` replace top-level keys and merge into `fields`. */
export function makeFakeIssue(
  overrides: Partial<Omit<FakeIssue, 'fields'>> & { fields?: Partial<FakeIssue['fields']> } = {}
): FakeIssue {
  const { fields, ...top } = overrides
  const key = top.key ?? 'APP-1432'

  return {
    key,
    id: '10432',
    self: 'https://example.atlassian.net/rest/api/3/issue/10432',
    ...top,
    fields: {
      summary: 'Add retry logic to the uploader',
      status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
      priority: { name: 'Medium' },
      issuetype: { name: 'Story', hierarchyLevel: 0, subtask: false },
      assignee: { displayName: 'Test User' },
      project: { key: 'APP', name: 'Uploader' },
      labels: [],
      updated: '2026-10-13T09:30:00.000+0000',
      description: {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Uploads fail on flaky networks and are never retried.' }
            ]
          },
          { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Acceptance' }] },
          {
            type: 'bulletList',
            content: [
              {
                type: 'listItem',
                content: [
                  { type: 'paragraph', content: [{ type: 'text', text: 'Retry three times' }] }
                ]
              },
              {
                type: 'listItem',
                content: [
                  { type: 'paragraph', content: [{ type: 'text', text: 'Back off between tries' }] }
                ]
              }
            ]
          },
          {
            type: 'codeBlock',
            attrs: { language: 'ts' },
            content: [{ type: 'text', text: 'await retry(() => upload(file))' }]
          }
        ]
      },
      ...fields
    }
  }
}

/** Writes the fake acli's issue file ($QUE_FAKE_ACLI_TICKETS). */
export function writeFakeTickets(file: string, issues: FakeIssue[]): void {
  fs.writeFileSync(file, JSON.stringify(issues, null, 2))
}

/** An epic in acli's shape: the overview its children work towards. */
export function makeFakeEpic(
  overrides: Partial<Omit<FakeIssue, 'fields'>> & { fields?: Partial<FakeIssue['fields']> } = {}
): FakeIssue {
  return makeFakeIssue({
    key: 'APP-1400',
    id: '10400',
    self: 'https://example.atlassian.net/rest/api/3/issue/10400',
    ...overrides,
    fields: {
      summary: 'Uploader reliability',
      issuetype: { name: 'Epic', hierarchyLevel: 1, subtask: false },
      description: {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Make uploads survive flaky networks end to end.' }]
          }
        ]
      },
      ...overrides.fields
    }
  })
}

/** The `parent` field a child carries, pointing at `issue`. */
export function fakeParentOf(issue: FakeIssue): NonNullable<FakeIssue['fields']['parent']> {
  const { summary, status, priority, issuetype } = issue.fields

  return {
    key: issue.key,
    id: issue.id,
    self: issue.self,
    fields: { summary, status, priority, issuetype }
  }
}
