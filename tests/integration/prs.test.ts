// Pull request tracking over the real socket: the daemon polls the fake gh
// (PR state file, QUE_FAKE_GH_FAIL) for every branch each workspace has had,
// and looks up by number the pull requests the session created (`gh pr create`
// seen in a hook). Which one is current, the order and the cap
// are pr-state.test.ts's; what a hook counts as a creation is pr-created.test.ts's.
import fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DaemonClient } from '@shared/client'
import type { HookEvent } from '@shared/protocol'
import { recordEvents, startTestDaemon, type TestDaemon } from '../../src/testing/daemon-harness'
import {
  addFakePullRequest,
  fakeCheckRun,
  type FakeCall,
  readFakeLog,
  readFakePullRequests,
  setFakePullRequest
} from '../../src/testing/fakes'
import { makeHookEvent } from '../../src/testing/fixtures'
import { addBareOrigin, gitIn, makeTempRepo } from '../../src/testing/temp-repo'

let daemon: TestDaemon
let client: DaemonClient

beforeEach(async () => {
  daemon = await startTestDaemon({ config: 'pr_poll_seconds = 0.2\n' })
  client = daemon.client
})

afterEach(async () => {
  await daemon.close()
})

async function project() {
  const repo = makeTempRepo(daemon.home)
  addBareOrigin(repo)

  return (await client.request('project.add', { path: repo })).id
}

async function workspace(branch?: string, projectId?: string) {
  return client.request('workspace.create', {
    projectId: projectId ?? (await project()),
    name: branch ?? 'APP-1432 retry logic',
    branch: branch || undefined
  })
}

const prOf = async (id: string) => (await client.request('workspace.get', { id })).pr

const prNumbersOf = async (id: string) =>
  (await client.request('workspace.get', { id })).prs.map((p) => p.number)

// Lookups by number, not the background fetches of a conversation (`--json comments,reviews`).
const prViews = () =>
  readFakeLog(daemon.ghLog).filter(
    (c) => c.argv[1] === 'view' && !c.argv.includes('comments,reviews')
  )

/** The listings of a whole project: `gh pr list` without `--head`. */
const projectListings = () =>
  readFakeLog(daemon.ghLog).filter((c) => c.argv[1] === 'list' && !c.argv.includes('--head'))

/** The listings of one head branch: `gh pr list --head <branch>`. */
const branchListings = (branch: string) =>
  readFakeLog(daemon.ghLog).filter(
    (c) => c.argv[1] === 'list' && c.argv[c.argv.indexOf('--head') + 1] === branch
  )

/** The fields a recorded call asked for with `--json`. */
const fieldsOf = (call: FakeCall) => (call.argv[call.argv.indexOf('--json') + 1] ?? '').split(',')

const opts = { timeout: 10_000 }

describe('pull request tracking', () => {
  it('follows a pull request from draft through failing checks to merged', async () => {
    const ws = await workspace()
    const updates = recordEvents(client, 'workspace.updated')
    expect(ws.pr).toBeNull()

    setFakePullRequest(daemon.ghPrs, ws.branch, { isDraft: true })
    await expect.poll(async () => (await prOf(ws.id))?.state, opts).toBe('draft')
    expect(updates.some((w) => w.id === ws.id && w.pr?.state === 'draft')).toBe(true)

    setFakePullRequest(daemon.ghPrs, ws.branch, {
      isDraft: false,
      statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }]
    })
    await expect
      .poll(async () => await prOf(ws.id), opts)
      .toMatchObject({
        state: 'open',
        checks: 'failing'
      })

    setFakePullRequest(daemon.ghPrs, ws.branch, {
      state: 'MERGED',
      mergedAt: '2026-10-14T03:00:00Z'
    })
    await expect.poll(async () => (await prOf(ws.id))?.state, opts).toBe('merged')
  }, 30_000)

  it('never asks about a protected branch', async () => {
    const projectId = await project()
    const ws = await workspace('release', projectId)
    const feature = await workspace('feature-x', projectId)
    setFakePullRequest(daemon.ghPrs, 'release', {})
    setFakePullRequest(daemon.ghPrs, 'feature-x', {})
    await expect.poll(async () => (await prOf(feature.id))?.state, opts).toBe('draft')

    const listCalls = () => readFakeLog(daemon.ghLog).filter((c) => c.argv[1] === 'list').length
    const before = listCalls()
    // A few more polls of the feature workspace, so a release call would have shown.
    await expect.poll(listCalls, opts).toBeGreaterThan(before + 2)

    const lists = readFakeLog(daemon.ghLog).filter((c) => c.argv[1] === 'list')
    expect(lists.some((c) => c.argv.includes('release'))).toBe(false)
    expect((await prOf(ws.id)) ?? null).toBeNull()
  }, 30_000)

  it('keeps the stored pull request and keeps running when gh fails', async () => {
    const ws = await workspace()
    setFakePullRequest(daemon.ghPrs, ws.branch, { isDraft: true })
    await expect.poll(async () => (await prOf(ws.id))?.state, opts).toBe('draft')

    vi.stubEnv('QUE_FAKE_GH_FAIL', '1')
    const failedAt = readFakeLog(daemon.ghLog).length
    setFakePullRequest(daemon.ghPrs, ws.branch, {
      state: 'MERGED',
      mergedAt: '2026-10-14T03:00:00Z'
    })
    await expect.poll(() => readFakeLog(daemon.ghLog).length, opts).toBeGreaterThan(failedAt + 1)
    expect((await prOf(ws.id))?.state).toBe('draft')
    expect(await client.request('workspace.get', { id: ws.id })).toMatchObject({ id: ws.id })

    vi.stubEnv('QUE_FAKE_GH_FAIL', '')
    await expect.poll(async () => (await prOf(ws.id))?.state, opts).toBe('merged')
  }, 30_000)

  it('lists every pull request on the branch and follows the open one', async () => {
    const ws = await workspace()
    const updates = recordEvents(client, 'workspace.updated')
    setFakePullRequest(daemon.ghPrs, ws.branch, {
      number: 41,
      url: 'https://github.com/rquellh/que/pull/41',
      state: 'MERGED',
      isDraft: false,
      mergedAt: '2026-10-14T01:00:00Z',
      updatedAt: '2026-10-14T05:00:00Z'
    })
    addFakePullRequest(daemon.ghPrs, ws.branch, {
      number: 42,
      title: 'Retry the uploader on 503',
      isDraft: false,
      updatedAt: '2026-10-14T02:00:00Z',
      additions: 9,
      deletions: 1
    })

    await expect.poll(() => prNumbersOf(ws.id), opts).toEqual([42, 41])
    expect(await prOf(ws.id)).toMatchObject({
      number: 42,
      state: 'open',
      additions: 9,
      deletions: 1
    })

    setFakePullRequest(daemon.ghPrs, ws.branch, {
      number: 42,
      state: 'CLOSED',
      updatedAt: '2026-10-14T03:00:00Z'
    })
    await expect.poll(async () => (await prOf(ws.id))?.number, opts).toBe(41)
    expect(await prNumbersOf(ws.id)).toEqual([42, 41])
    expect(
      updates.some((w) => w.id === ws.id && w.pr?.number === 41 && w.prs[0]?.state === 'closed')
    ).toBe(true)
  }, 30_000)

  describe('checks', () => {
    it('lists the project without checks and reads them from the branch of an open pull request', async () => {
      const ws = await workspace()
      setFakePullRequest(daemon.ghPrs, ws.branch, {
        isDraft: false,
        statusCheckRollup: [
          fakeCheckRun({ name: 'unit tests', conclusion: 'FAILURE' }),
          fakeCheckRun({ name: 'lint' })
        ]
      })

      await expect
        .poll(async () => (await prOf(ws.id))?.checkRuns.map((c) => [c.name, c.state]), opts)
        .toEqual([
          ['unit tests', 'failing'],
          ['lint', 'passing']
        ])
      expect((await prOf(ws.id))?.checks).toBe('failing')

      expect(projectListings().length).toBeGreaterThan(0)
      expect(projectListings().filter((c) => fieldsOf(c).includes('statusCheckRollup'))).toEqual([])
      expect(fieldsOf(branchListings(ws.branch)[0])).toContain('statusCheckRollup')
    }, 30_000)

    it('keeps the checks of a merged pull request without asking for them again', async () => {
      const ws = await workspace()
      setFakePullRequest(daemon.ghPrs, ws.branch, {
        isDraft: false,
        statusCheckRollup: [fakeCheckRun({ name: 'unit tests' })]
      })
      await expect.poll(async () => (await prOf(ws.id))?.checks, opts).toBe('passing')

      setFakePullRequest(daemon.ghPrs, ws.branch, {
        state: 'MERGED',
        mergedAt: '2026-10-14T03:00:00Z'
      })
      await expect.poll(async () => (await prOf(ws.id))?.state, opts).toBe('merged')
      const asked = branchListings(ws.branch).length
      const listed = projectListings().length

      // The only workspace holds a settled pull request now, so each listing is a fifth tick's,
      // the one that re-checks it.
      await expect.poll(() => projectListings().length, opts).toBeGreaterThan(listed + 1)

      expect(branchListings(ws.branch)).toHaveLength(asked)
      expect(await prOf(ws.id)).toMatchObject({ state: 'merged', checks: 'passing' })
    }, 30_000)

    it('asks each branch on its own when the project listing fails', async () => {
      vi.stubEnv(
        'QUE_FAKE_GH_REPO_LIST_FAIL',
        'HTTP 504: 504 Gateway Timeout (https://api.github.com/graphql)'
      )
      const projectId = await project()
      const retry = await workspace('APP-1432-retry-logic', projectId)
      const backoff = await workspace('APP-1433-backoff', projectId)
      setFakePullRequest(daemon.ghPrs, retry.branch, { isDraft: true })
      addFakePullRequest(daemon.ghPrs, backoff.branch, {
        isDraft: false,
        statusCheckRollup: [fakeCheckRun({ name: 'unit tests', conclusion: 'FAILURE' })]
      })

      await expect.poll(async () => (await prOf(retry.id))?.state, opts).toBe('draft')
      await expect
        .poll(async () => await prOf(backoff.id), opts)
        .toMatchObject({ number: 2, state: 'open', checks: 'failing' })
      expect(projectListings().length).toBeGreaterThan(0)
    }, 30_000)
  })

  describe('pull requests the session creates itself', () => {
    /** A Bash PostToolUse for `command`, as Claude Code reports it to `que hook`. */
    const ranBash = (command: string, response: unknown, extra: Partial<HookEvent> = {}) =>
      makeHookEvent('PostToolUse', {
        tool_name: 'Bash',
        tool_input: { command },
        tool_response: response,
        ...extra
      })

    /** A workspace whose project's origin is the repository the fake gh's URLs name. */
    async function githubWorkspace() {
      const ws = await workspace()
      const [project] = await client.request('project.list')
      // Only the hook reads the URL: nothing in these tests fetches or pushes.
      gitIn(project.path, 'remote', 'set-url', 'origin', 'https://github.com/rquellh/que.git')

      return ws
    }

    it('adds the ones a hook shows the session and a subagent creating on other branches', async () => {
      const ws = await githubWorkspace()
      addFakePullRequest(daemon.ghPrs, 'APP-1433-backoff', {
        number: 71,
        url: 'https://github.com/rquellh/que/pull/71',
        baseRefName: ws.branch
      })
      addFakePullRequest(daemon.ghPrs, 'APP-1434-jitter', {
        number: 72,
        url: 'https://github.com/rquellh/que/pull/72'
      })
      const updates = recordEvents(client, 'workspace.updated')

      await client.request('hook.event', {
        workspaceId: ws.id,
        payload: ranBash(
          'git push -u origin APP-1433-backoff && gh pr create --base APP-1432 --head APP-1433-backoff --fill',
          { stdout: 'https://github.com/rquellh/que/pull/71\n', stderr: '' }
        )
      })
      await client.request('hook.event', {
        workspaceId: ws.id,
        payload: ranBash(
          'gh pr create --draft --head APP-1434-jitter --fill',
          'https://github.com/rquellh/que/pull/72\nhttps://github.com/rquellh/uploader/pull/5\n',
          { agent_id: 'a3f9c2e1', agent_type: 'general-purpose' }
        )
      })

      await expect.poll(() => prNumbersOf(ws.id), opts).toEqual([72, 71])
      expect((await client.request('workspace.get', { id: ws.id })).prUrls).toEqual([
        'https://github.com/rquellh/que/pull/71',
        'https://github.com/rquellh/que/pull/72'
      ])
      expect(updates.some((w) => w.id === ws.id && w.prUrls.length === 2)).toBe(true)
      expect(prViews().map((c) => c.argv[2])).not.toContain('5')
    }, 30_000)

    it('ignores a pull request on another repository and a command that created none', async () => {
      const ws = await githubWorkspace()
      setFakePullRequest(daemon.ghPrs, ws.branch, { number: 3, isDraft: true })
      await expect.poll(async () => (await prOf(ws.id))?.state, opts).toBe('draft')

      await client.request('hook.event', {
        workspaceId: ws.id,
        payload: ranBash('gh pr create --repo rquellh/uploader --fill', {
          stdout: 'https://github.com/rquellh/uploader/pull/5\n'
        })
      })
      await client.request('hook.event', {
        workspaceId: ws.id,
        payload: ranBash('gh pr view 9 --json url', {
          stdout: 'https://github.com/rquellh/que/pull/9'
        })
      })
      const listed = readFakeLog(daemon.ghLog).length
      // Another tick, so a recorded URL would have been looked up by now.
      await expect.poll(() => readFakeLog(daemon.ghLog).length, opts).toBeGreaterThan(listed + 1)

      expect((await client.request('workspace.get', { id: ws.id })).prUrls).toEqual([])
      expect(prViews()).toEqual([])
    }, 30_000)

    it('adds the one it created on its branch once it leaves the branch, never twice', async () => {
      const ws = await githubWorkspace()
      const wsId = ws.id
      const branch = ws.branch
      const url = 'https://github.com/rquellh/que/pull/1'
      setFakePullRequest(daemon.ghPrs, branch, { number: 1, url })

      await client.request('hook.event', {
        workspaceId: wsId,
        payload: ranBash('gh pr create --draft --fill', { stdout: `${url}\n`, stderr: '' })
      })

      // On the branch, the recorded pull request is listed once and never looked up on its own.
      await expect.poll(() => prNumbersOf(wsId), opts).toEqual([1])
      expect((await client.request('workspace.get', { id: wsId })).prUrls).toEqual([url])
      expect(prViews()).toEqual([])

      // It is merged from another head, and a new one is opened from the branch.
      const all = readFakePullRequests(daemon.ghPrs)
      all['APP-1432-old-head'] = all[branch].map((pr) => ({
        ...pr,
        headRefName: 'APP-1432-old-head',
        state: 'MERGED' as const,
        mergedAt: '2026-10-14T03:00:00Z'
      }))
      delete all[branch]
      fs.writeFileSync(daemon.ghPrs, JSON.stringify(all))
      addFakePullRequest(daemon.ghPrs, branch, { number: 2, isDraft: false })

      await expect.poll(() => prNumbersOf(wsId), opts).toEqual([2, 1])
      expect(await prOf(wsId)).toMatchObject({ number: 2, state: 'open' })
      expect(prViews().some((c) => c.argv[2] === '1')).toBe(true)
      expect(prViews().some((c) => c.argv[2] === '2')).toBe(false)
    }, 60_000)
  })

  describe('a branch checked out in the worktree', () => {
    it('becomes the workspace branch and finds the pull request opened from it', async () => {
      const ws = await workspace()
      const updates = recordEvents(client, 'workspace.updated')
      gitIn(ws.path, 'checkout', '--quiet', '-b', 'fix/upload-timeout')
      setFakePullRequest(daemon.ghPrs, 'fix/upload-timeout', {
        number: 57,
        url: 'https://github.com/rquellh/que/pull/57',
        isDraft: false
      })

      await expect
        .poll(async () => await prOf(ws.id), opts)
        .toMatchObject({ number: 57, state: 'open' })
      expect(updates.some((w) => w.id === ws.id && w.branch === 'fix/upload-timeout')).toBe(true)
    }, 30_000)

    it('keeps the pull requests of every branch the worktree has had checked out', async () => {
      const ws = await workspace()
      const branchesOf = async () => (await client.request('workspace.get', { id: ws.id })).branches
      gitIn(ws.path, 'checkout', '--quiet', '-b', 'APP-1433-backoff')
      await expect.poll(branchesOf, opts).toEqual([ws.branch, 'APP-1433-backoff'])
      gitIn(ws.path, 'checkout', '--quiet', '-b', 'APP-1434-jitter')
      await expect
        .poll(branchesOf, opts)
        .toEqual([ws.branch, 'APP-1433-backoff', 'APP-1434-jitter'])

      // Both pull requests are opened after the worktree has moved on from their branches.
      setFakePullRequest(daemon.ghPrs, ws.branch, {
        number: 61,
        url: 'https://github.com/rquellh/que/pull/61',
        state: 'MERGED',
        mergedAt: '2026-10-14T01:00:00Z'
      })
      addFakePullRequest(daemon.ghPrs, 'APP-1433-backoff', {
        number: 62,
        baseRefName: ws.branch,
        isDraft: false
      })

      await expect.poll(() => prNumbersOf(ws.id), opts).toEqual([62, 61])
      expect((await client.request('workspace.get', { id: ws.id })).prs[0]).toMatchObject({
        number: 62,
        base: ws.branch,
        head: 'APP-1433-backoff'
      })
    }, 30_000)

    it('keeps the recorded branch while the worktree is on a detached HEAD', async () => {
      const ws = await workspace()
      gitIn(ws.path, 'checkout', '--quiet', '--detach')
      setFakePullRequest(daemon.ghPrs, ws.branch, { isDraft: true })

      // The draft's arrival shows a check ran after the detach.
      await expect.poll(async () => (await prOf(ws.id))?.state, opts).toBe('draft')
      expect((await client.request('workspace.get', { id: ws.id })).branch).toBe(ws.branch)
    }, 30_000)
  })
})

describe('workspace.checkPrs', () => {
  // The poll is slowed to an hour, so only a check asked for can update a pull request.
  beforeEach(async () => {
    await daemon.close()
    daemon = await startTestDaemon({ config: 'pr_poll_seconds = 3600\n' })
    client = daemon.client
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('checks the pull requests with GitHub now and announces what changed', async () => {
    const ws = await workspace()
    const pending = [fakeCheckRun({ name: 'unit tests', status: 'IN_PROGRESS' })]
    setFakePullRequest(daemon.ghPrs, ws.branch, { isDraft: false, statusCheckRollup: pending })
    const first = await client.request('workspace.checkPrs', { id: ws.id })
    expect(first.prs[0]?.checks).toBe('pending')

    const updates = recordEvents(client, 'workspace.updated')
    setFakePullRequest(daemon.ghPrs, ws.branch, {
      statusCheckRollup: [fakeCheckRun({ name: 'unit tests', conclusion: 'SUCCESS' })]
    })
    const checked = await client.request('workspace.checkPrs', { id: ws.id })

    expect(checked.prs[0]?.checks).toBe('passing')
    await expect
      .poll(() => updates.some((w) => w.id === ws.id && w.prs[0]?.checks === 'passing'), opts)
      .toBe(true)
  }, 30_000)

  it('shares one check between callers asking at the same time', async () => {
    const headLists = () =>
      readFakeLog(daemon.ghLog).filter((c) => c.argv[1] === 'list' && c.argv.includes('--head'))
        .length

    const ws = await workspace()
    setFakePullRequest(daemon.ghPrs, ws.branch, { isDraft: false })
    await client.request('workspace.checkPrs', { id: ws.id })

    const before = headLists()

    const [a, b] = await Promise.all([
      client.request('workspace.checkPrs', { id: ws.id }),
      client.request('workspace.checkPrs', { id: ws.id })
    ])

    expect(a.prs[0]?.number).toBe(1)
    expect(b.prs[0]?.number).toBe(1)
    expect(headLists() - before).toBe(1)
  }, 30_000)

  describe('errors', () => {
    it('fails with the gh message and leaves the stored pull requests as they were', async () => {
      const ws = await workspace()
      setFakePullRequest(daemon.ghPrs, ws.branch, { isDraft: true })
      await client.request('workspace.checkPrs', { id: ws.id })
      expect(await prNumbersOf(ws.id)).toEqual([1])

      vi.stubEnv('QUE_FAKE_GH_FAIL', '1')
      setFakePullRequest(daemon.ghPrs, ws.branch, { state: 'MERGED' })

      await expect(client.request('workspace.checkPrs', { id: ws.id })).rejects.toMatchObject({
        code: 'gh_failed',
        message: 'gh: failed (fake)'
      })
      expect(await prNumbersOf(ws.id)).toEqual([1])
      expect((await prOf(ws.id))?.state).toBe('draft')
    }, 30_000)
  })
})
