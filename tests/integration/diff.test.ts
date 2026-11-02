// workspace.diff and `que ws diff` against real worktrees on a temp repo with a
// bare origin: committed and uncommitted changes against the merge base.
// Quiet-hours refusal of workspace.diff is covered by the safety table.
import fs from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkspaceDiff } from '@shared/protocol'
import type { Workspace } from '@shared/types'
import { runCli, runCliJson } from '../../src/testing/cli'
import { startTestDaemon, type TestDaemon } from '../../src/testing/daemon-harness'
import { addBareOrigin, gitIn, makeTempRepo } from '../../src/testing/temp-repo'

let daemon: TestDaemon
let ws: Workspace
let repo: string

beforeEach(async () => {
  daemon = await startTestDaemon()
  repo = makeTempRepo(daemon.home)
  addBareOrigin(repo)
  const project = await daemon.client.request('project.add', { path: repo })

  const created = await daemon.client.request('workspace.create', {
    projectId: project.id,
    name: 'app-1500-diff-view'
  })

  await expect
    .poll(async () => (await daemon.client.request('workspace.get', { id: created.id })).status, {
      timeout: 10_000
    })
    .not.toBe('preparing')
  ws = await daemon.client.request('workspace.get', { id: created.id })
}, 30_000)

afterEach(async () => {
  await daemon.close()
})

const diff = (): Promise<WorkspaceDiff> => daemon.client.request('workspace.diff', { id: ws.id })
const file = (d: WorkspaceDiff, path: string) => d.files.find((f) => f.path === path)

function commitAll(message: string): void {
  gitIn(ws.path, 'add', '.')
  gitIn(ws.path, 'commit', '-m', message)
}

describe('workspace.diff', () => {
  it('is empty against origin/main when nothing changed', async () => {
    const d = await diff()

    expect(d).toMatchObject({ base: 'origin/main', head: ws.branch, commitsAhead: 0, files: [] })
  })

  it('leaves the index alone, so a read holds no lock against a git add in the worktree', async () => {
    fs.appendFileSync(join(ws.path, 'README.md'), 'a second line\n')
    commitAll('Change readme')
    // A new stat and the same content as the index: git status refreshes the index for this,
    // under its lock, unless told not to. A rewritten index is the trace it leaves.
    const later = new Date(Date.now() + 60_000)
    fs.utimesSync(join(ws.path, 'README.md'), later, later)
    const index = join(gitIn(ws.path, 'rev-parse', '--absolute-git-dir'), 'index')
    const before = fs.readFileSync(index)

    expect(file(await diff(), 'README.md')).toMatchObject({ status: 'modified', dirty: false })

    expect(fs.readFileSync(index).equals(before)).toBe(true)
  })

  it('shows committed, then uncommitted and untracked changes against the base', async () => {
    fs.appendFileSync(join(ws.path, 'README.md'), 'a second line\n')
    fs.writeFileSync(join(ws.path, 'notes.txt'), 'one\ntwo\nthree\n')
    commitAll('Change readme, add notes')

    const committed = await diff()

    expect(committed.commitsAhead).toBe(1)
    expect(
      committed.files.map((f) => [f.path, f.status, f.additions, f.deletions, f.dirty])
    ).toEqual([
      ['README.md', 'modified', 1, 0, false],
      ['notes.txt', 'added', 3, 0, false]
    ])
    expect(file(committed, 'README.md')?.patch).toContain('+a second line')

    fs.appendFileSync(join(ws.path, 'README.md'), 'a third line\n')
    fs.writeFileSync(join(ws.path, 'scratch.txt'), 'x\ny\n')

    const dirty = await diff()

    expect(file(dirty, 'README.md')).toMatchObject({ dirty: true, additions: 2, deletions: 0 })
    expect(file(dirty, 'README.md')?.patch).toContain('+a third line')
    expect(file(dirty, 'notes.txt')?.dirty).toBe(false)
    expect(file(dirty, 'scratch.txt')).toMatchObject({
      status: 'untracked',
      additions: 2,
      deletions: 0,
      dirty: true
    })
    expect(file(dirty, 'scratch.txt')?.patch).toContain('--- /dev/null')
    expect(file(dirty, 'scratch.txt')?.patch).toContain('+x')
  })

  it('reports a committed rename with its source', async () => {
    gitIn(ws.path, 'mv', 'README.md', 'GUIDE.md')
    commitAll('Rename readme')

    const d = await diff()

    expect(d.files).toHaveLength(1)
    expect(d.files[0]).toMatchObject({
      path: 'GUIDE.md',
      from: 'README.md',
      status: 'renamed',
      dirty: false
    })
  })

  it('gives a committed binary file no patch and no counts', async () => {
    fs.writeFileSync(join(ws.path, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255]))
    commitAll('Add a binary')

    expect(file(await diff(), 'blob.bin')).toMatchObject({
      status: 'added',
      additions: 0,
      deletions: 0,
      patch: null
    })
  })

  it('gives an untracked binary file no patch', async () => {
    fs.writeFileSync(join(ws.path, 'raw.bin'), Buffer.from([0, 9, 0]))

    expect(file(await diff(), 'raw.bin')).toMatchObject({ status: 'untracked', patch: null })
  })

  it('answers not_found for an unknown workspace', async () => {
    await expect(
      daemon.client.request('workspace.diff', { id: 'ws_missing' })
    ).rejects.toMatchObject({ code: 'not_found' })
  })
})

/**
 * A `release` branch at main's first commit, and two commits on the workspace:
 * the older adds uploader.ts, the newer retry.ts. Returns their shas.
 */
function branchTwoAhead(): { older: string; newer: string } {
  gitIn(repo, 'branch', 'release', 'main~1')
  fs.writeFileSync(join(ws.path, 'uploader.ts'), 'export const upload = 1\n')
  commitAll('Add the uploader')
  const older = gitIn(ws.path, 'rev-parse', 'HEAD')
  fs.writeFileSync(
    join(ws.path, 'retry.ts'),
    'export const retries = 3\nexport const backoff = 2\n'
  )
  commitAll('Retry uploads: back off (2x) & give up after 3')
  const newer = gitIn(ws.path, 'rev-parse', 'HEAD')

  return { older, newer }
}

describe('workspace.diff commits, bases and narrowing', () => {
  it('lists the commits newest first and the refs worth comparing against', async () => {
    const { older, newer } = branchTwoAhead()

    const d = await diff()

    expect(d.commit).toBeNull()
    expect(d.commitsAhead).toBe(2)
    expect(d.commits).toEqual([
      {
        sha: newer,
        shortSha: newer.slice(0, 7),
        subject: 'Retry uploads: back off (2x) & give up after 3',
        author: 'que test',
        at: expect.stringMatching(/^2026-10-01T09:00:00(Z|[+-]\d\d:\d\d)$/)
      },
      {
        sha: older,
        shortSha: older.slice(0, 7),
        subject: 'Add the uploader',
        author: 'que test',
        at: expect.stringMatching(/^2026-10-01T09:00:00/)
      }
    ])
    expect(d.bases.slice(0, 2)).toEqual(['origin/main', 'main'])
    expect(d.bases).toContain('release')
    // Never the workspace's own branch, nor the remote's HEAD pointer in any spelling.
    expect(d.bases).not.toContain(ws.branch)
    expect(d.bases).not.toContain('origin/HEAD')
    expect(d.bases).not.toContain('origin')
  })

  it('compares against another base when asked', async () => {
    branchTwoAhead()

    const d = await daemon.client.request('workspace.diff', { id: ws.id, base: 'release' })

    expect(d.base).toBe('release')
    expect(d.bases[0]).toBe('release')
    expect(d.commitsAhead).toBe(3)
    expect(d.commits.map((c) => c.subject)).toEqual([
      'Retry uploads: back off (2x) & give up after 3',
      'Add the uploader',
      'Add que.toml'
    ])
    expect(d.files.map((f) => [f.path, f.status])).toEqual([
      ['que.toml', 'added'],
      ['retry.ts', 'added'],
      ['uploader.ts', 'added']
    ])
  })

  it("narrows the files to one commit's own changes, leaving out the working tree", async () => {
    const { older, newer } = branchTwoAhead()
    fs.appendFileSync(join(ws.path, 'README.md'), 'not committed yet\n')
    fs.writeFileSync(join(ws.path, 'scratch.txt'), 'loose\n')

    const first = await daemon.client.request('workspace.diff', { id: ws.id, commit: older })

    const second = await daemon.client.request('workspace.diff', {
      id: ws.id,
      commit: newer.slice(0, 7)
    })

    expect(first.commit).toBe(older)
    expect(first.commitsAhead).toBe(2)
    expect(first.commits).toHaveLength(2)
    expect(first.files.map((f) => [f.path, f.status, f.additions, f.dirty])).toEqual([
      ['uploader.ts', 'added', 1, false]
    ])
    expect(file(first, 'uploader.ts')?.patch).toContain('+export const upload = 1')
    expect(second.commit).toBe(newer)
    expect(second.files.map((f) => [f.path, f.additions, f.dirty])).toEqual([
      ['retry.ts', 2, false]
    ])
  })

  it('falls back to the default comparison when the base is not a commit', async () => {
    branchTwoAhead()

    const plain = await diff()

    const d = await daemon.client.request('workspace.diff', {
      id: ws.id,
      base: 'no-such-branch'
    })

    expect(d.rejectedBase).toBe('no-such-branch')
    expect(d.base).toBe('origin/main')
    expect(d.files).toEqual(plain.files)
    expect(d.commitsAhead).toBe(plain.commitsAhead)
    expect(plain.rejectedBase).toBeNull()
  })

  it('reports a base that looks like an option instead of passing it on', async () => {
    const d = await daemon.client.request('workspace.diff', { id: ws.id, base: '--output=x' })

    expect(d.rejectedBase).toBe('--output=x')
    expect(d.base).toBe('origin/main')
  })

  it("lists only another branch's own commits and files against its base, with no working tree", async () => {
    branchTwoAhead()
    gitIn(ws.path, 'checkout', '--quiet', '-b', 'APP-1433-jitter')
    fs.writeFileSync(join(ws.path, 'jitter.ts'), 'export const jitterMs = 250\n')
    commitAll('Add jitter to the backoff')
    // The worktree's own state never shows in another branch's files.
    fs.appendFileSync(join(ws.path, 'retry.ts'), 'export const loose = true\n')
    fs.writeFileSync(join(ws.path, 'scratch.txt'), 'loose\n')

    const d = await daemon.client.request('workspace.diff', {
      id: ws.id,
      base: ws.branch,
      head: 'APP-1433-jitter'
    })

    expect(d).toMatchObject({ base: ws.branch, head: 'APP-1433-jitter', commitsAhead: 1 })
    expect(d.commits.map((c) => c.subject)).toEqual(['Add jitter to the backoff'])
    expect(d.files.map((f) => [f.path, f.status, f.additions, f.dirty])).toEqual([
      ['jitter.ts', 'added', 1, false]
    ])
    expect(d.bases).not.toContain('APP-1433-jitter')
  })

  it("finds a branch only origin has, takes origin's base first, and refuses one that is nowhere", async () => {
    gitIn(repo, 'checkout', '--quiet', '-b', 'APP-1434-remote-only')
    fs.writeFileSync(join(repo, 'remote.ts'), 'export const remote = true\n')
    gitIn(repo, 'add', '.')
    gitIn(repo, 'commit', '-m', 'Add the remote flag')
    gitIn(repo, 'push', '--quiet', 'origin', 'APP-1434-remote-only')
    gitIn(repo, 'checkout', '--quiet', 'main')
    gitIn(repo, 'branch', '--quiet', '-D', 'APP-1434-remote-only')

    const d = await daemon.client.request('workspace.diff', {
      id: ws.id,
      base: 'main',
      head: 'APP-1434-remote-only'
    })

    // The base is origin's copy first: a local default branch is often behind.
    expect(d).toMatchObject({ base: 'origin/main', head: 'APP-1434-remote-only', commitsAhead: 1 })
    expect(d.files.map((f) => f.path)).toEqual(['remote.ts'])
    await expect(
      daemon.client.request('workspace.diff', { id: ws.id, head: 'APP-1499-nowhere' })
    ).rejects.toMatchObject({ code: 'bad_request', message: expect.stringContaining('nowhere') })
  })

  it('rejects a commit that is not on the branch past the base', async () => {
    const onMain = gitIn(repo, 'rev-parse', 'main')

    await expect(
      daemon.client.request('workspace.diff', { id: ws.id, commit: onMain })
    ).rejects.toMatchObject({ code: 'bad_request', message: expect.stringContaining(onMain) })
    await expect(
      daemon.client.request('workspace.diff', { id: ws.id, commit: 'deadbeef' })
    ).rejects.toMatchObject({ code: 'bad_request' })
  })
})

describe('que ws diff', () => {
  it('compares against --base and lists the commits with their age', async () => {
    branchTwoAhead()

    const text = await runCli('ws', 'diff', ws.name, '--base', 'release')

    const json = await runCliJson<WorkspaceDiff>(
      'ws',
      'diff',
      ws.name,
      '--base',
      'release',
      '--json'
    )

    expect(text.code).toBe(0)
    const lines = text.stdout.trim().split('\n')
    expect(lines[0]).toBe(`${ws.branch} vs release · 3 commits ahead`)
    expect(lines.slice(1, 4)).toEqual([
      expect.stringMatching(
        /^ {2}[0-9a-f]{7} Retry uploads: back off \(2x\) & give up after 3 · \d+[smhd]$/
      ),
      expect.stringMatching(/^ {2}[0-9a-f]{7} Add the uploader · \d+[smhd]$/),
      expect.stringMatching(/^ {2}[0-9a-f]{7} Add que\.toml · \d+[smhd]$/)
    ])
    expect(lines.slice(4)).toEqual([
      'A que.toml  +1 -0',
      'A retry.ts  +2 -0',
      'A uploader.ts  +1 -0'
    ])
    expect(json).toMatchObject({
      base: 'release',
      commitsAhead: 3,
      commit: null
    })
  }, 30_000)

  it("prints one commit's own changes with --commit", async () => {
    const { older } = branchTwoAhead()

    const text = await runCli('ws', 'diff', ws.name, '--commit', older)
    const json = await runCliJson<WorkspaceDiff>('ws', 'diff', ws.name, '--commit', older, '--json')

    expect(text.code).toBe(0)
    const lines = text.stdout.trim().split('\n')
    expect(lines.slice(0, 2)).toEqual([
      `${ws.branch} vs origin/main · 2 commits ahead`,
      `commit ${older.slice(0, 7)} Add the uploader`
    ])
    expect(lines.at(-1)).toBe('A uploader.ts  +1 -0')
    expect(lines).toHaveLength(5)
    expect(json).toMatchObject({
      commit: older,
      files: [{ path: 'uploader.ts', dirty: false }]
    })
  }, 30_000)

  it('fails with the reason when --base is not a commit', async () => {
    const r = await runCli('ws', 'diff', ws.name, '--base', 'no-such-branch')

    expect(r.code).toBe(1)
    expect(r.stderr).toContain('base no-such-branch is not a commit')
    expect(r.stdout).toBe('')
  }, 30_000)

  it('fails with the reason when --commit is not on the branch', async () => {
    const r = await runCli('ws', 'diff', ws.name, '--commit', 'deadbeef')

    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('deadbeef')
  }, 30_000)

  it('prints the header, one line per file, and * for dirty ones', async () => {
    fs.appendFileSync(join(ws.path, 'README.md'), 'more\n')
    fs.writeFileSync(join(ws.path, 'new.txt'), 'a\nb\n')
    commitAll('Change readme, add new')
    fs.writeFileSync(join(ws.path, 'loose.txt'), 'z\n')

    const r = await runCli('ws', 'diff', ws.name)

    expect(r.code).toBe(0)
    expect(r.stdout.trim().split('\n')).toEqual([
      `${ws.branch} vs origin/main · 1 commits ahead`,
      expect.stringMatching(/^ {2}[0-9a-f]{7} Change readme, add new · \d+[smhd]$/),
      'M README.md  +1 -0',
      '? loose.txt  +1 -0 *',
      'A new.txt  +2 -0'
    ])
  }, 30_000)

  it('says no changes, and prints the WorkspaceDiff with --json', async () => {
    const text = await runCli('ws', 'diff', ws.name)
    const json = await runCliJson<WorkspaceDiff>('ws', 'diff', ws.name, '--json')

    expect(text.stdout.trim().split('\n')[1]).toBe('no changes')
    expect(json).toMatchObject({
      workspaceId: ws.id,
      base: 'origin/main',
      commitsAhead: 0,
      files: []
    })
  }, 30_000)
})
