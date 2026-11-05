import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gitIn, makeTempRepo } from './temp-repo'
import { decide, decideFromGit } from '../../scripts/mac-jobs.mjs'

const script = resolve(__dirname, '../../scripts/mac-jobs.mjs')

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(join(os.tmpdir(), 'que-mac-jobs-'))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** Writes `files` (path → contents) and commits them; none at all makes an empty commit. */
function commit(repo: string, files: Record<string, string> = {}): void {
  for (const [path, contents] of Object.entries(files)) {
    fs.mkdirSync(dirname(join(repo, path)), { recursive: true })
    fs.writeFileSync(join(repo, path), contents)
  }

  gitIn(repo, 'add', '--all')
  gitIn(repo, 'commit', '--allow-empty', '-m', 'Change')
}

/** HEAD is `change`, made on a branch, merged into main the way GitHub merges and test-merges. */
function mergedRepo(change: (repo: string) => void, opts: { mainMoved?: boolean } = {}): string {
  const repo = makeTempRepo(tmp)

  gitIn(repo, 'switch', '-c', 'APP-1432-retry-logic')
  change(repo)
  gitIn(repo, 'switch', 'main')

  if (opts.mainMoved) commit(repo, { 'src/moved-on-main.ts': 'export const moved = true\n' })

  gitIn(repo, 'merge', '--no-ff', '--no-edit', 'APP-1432-retry-logic')

  return repo
}

/** A repo merging a branch that changes exactly these paths, with the same contents in each. */
function repoChanging(...paths: string[]): string {
  return mergedRepo((repo) => {
    commit(repo, Object.fromEntries(paths.map((path) => [path, 'export const retries = 3\n'])))
  })
}

const pkg = (fields: { version: string; dependencies?: Record<string, string> }): string =>
  `${JSON.stringify({ name: 'que', ...fields })}\n`

/** A repo with package.json at 0.5.0 on main, merging a release branch that writes `files`. */
function releaseRepo(files: Record<string, string>): string {
  const repo = makeTempRepo(tmp)

  commit(repo, { 'package.json': pkg({ version: '0.5.0' }) })
  gitIn(repo, 'switch', '-c', 'release/0.6.0')
  commit(repo, files)
  gitIn(repo, 'switch', 'main')
  gitIn(repo, 'merge', '--no-ff', '--no-edit', 'release/0.6.0')

  return repo
}

function shallowClone(repo: string, depth: number): string {
  const clone = join(tmp, `depth-${depth}`)

  gitIn(tmp, 'clone', '--quiet', '--depth', String(depth), `file://${repo}`, clone)

  return clone
}

const SKIP_TREE = { run: false, reason: expect.stringMatching(/is the one the pull request/) }
const SKIP_DOCS = { run: false, reason: expect.stringMatching(/only docs/) }
const SKIP_RELEASE = { run: false, reason: expect.stringMatching(/release pull request/) }
const RUN_CODE = { run: true, reason: expect.stringMatching(/more than docs or release files/) }
const RUN_NO_VERSION = { run: true, reason: expect.stringMatching(/no new version/) }
const RUN_LOOKUP_FAILED = { run: true, reason: expect.stringMatching(/lookup failed/) }

describe('decide', () => {
  describe('docs paths', () => {
    it.each([
      'README.md',
      'CONTRIBUTING.md',
      'DEVELOPING.md',
      'CODE_OF_CONDUCT.md',
      'SECURITY.md',
      'CLAUDE.md',
      'CHANGELOG.md',
      'docs/design.md',
      'docs/images/day.gif'
    ])('skips a pull request changing only %s', (path) => {
      expect(decide({ event: 'pull_request', changedFiles: [path] })).toEqual(SKIP_DOCS)
    })

    it.each(['readme.md', 'src/README.md', 'docs.md', 'docsite/index.md', 'LICENSE'])(
      'does not count %s as docs',
      (path) => {
        expect(decide({ event: 'pull_request', changedFiles: [path] })).toEqual(RUN_CODE)
      }
    )
  })

  describe('release pull requests', () => {
    it('skips on every release file', () => {
      expect(
        decide({
          event: 'pull_request',
          headRef: 'release/0.6.0',
          versionChanged: true,
          changedFiles: [
            'package.json',
            'package-lock.json',
            'CHANGELOG.md',
            'docs/cli.md',
            'docs/configuration.md'
          ]
        })
      ).toEqual(SKIP_RELEASE)
    })

    it('runs when nobody could read the version', () => {
      expect(
        decide({ event: 'pull_request', headRef: 'release/0.6.0', changedFiles: ['package.json'] })
      ).toEqual(RUN_NO_VERSION)
    })

    it.each(['releases/0.6.0', 'prerelease/0.6.0', 'release'])(
      'does not take the branch "%s" for a release',
      (headRef) => {
        expect(
          decide({
            event: 'pull_request',
            headRef,
            versionChanged: true,
            changedFiles: ['package.json']
          })
        ).toEqual(RUN_CODE)
      }
    )
  })
})

describe('decideFromGit', () => {
  describe('a push to main', () => {
    it('skips when the merged tree is the tree of the branch', () => {
      const repo = repoChanging('src/retry.ts')

      expect(decideFromGit({ event: 'push', cwd: repo })).toEqual(SKIP_TREE)
    })

    it('runs when main moved after the branch, so the merged tree is new', () => {
      const repo = mergedRepo((r) => commit(r, { 'src/retry.ts': 'export const retries = 3\n' }), {
        mainMoved: true
      })

      expect(decideFromGit({ event: 'push', cwd: repo })).toEqual({
        run: true,
        reason: expect.stringMatching(/differs/)
      })
    })

    it('runs a squash or rebase, which has no second parent', () => {
      const repo = makeTempRepo(tmp)

      commit(repo, { 'src/retry.ts': 'export const retries = 3\n' })

      expect(decideFromGit({ event: 'push', cwd: repo })).toEqual({
        run: true,
        reason: expect.stringMatching(/no second parent/)
      })
    })
  })

  describe('a pull request', () => {
    it('skips when every changed file is docs, whatever its name looks like', () => {
      const repo = repoChanging('README.md', 'docs/guide/café notes.md')

      expect(decideFromGit({ event: 'pull_request', cwd: repo })).toEqual(SKIP_DOCS)
    })

    it('runs when docs change along with code', () => {
      const repo = repoChanging('README.md', 'src/retry.ts')

      expect(decideFromGit({ event: 'pull_request', cwd: repo })).toEqual(RUN_CODE)
    })

    it('runs when a file moves from code into docs', () => {
      const repo = makeTempRepo(tmp)

      commit(repo, { 'src/retry.ts': 'export const retries = 3\n' })
      gitIn(repo, 'switch', '-c', 'APP-1432-retry-logic')
      fs.mkdirSync(join(repo, 'docs'))
      gitIn(repo, 'mv', 'src/retry.ts', 'docs/retry.md')
      commit(repo)
      gitIn(repo, 'switch', 'main')
      gitIn(repo, 'merge', '--no-ff', '--no-edit', 'APP-1432-retry-logic')

      expect(decideFromGit({ event: 'pull_request', cwd: repo })).toEqual(RUN_CODE)
    })

    it('runs when the diff is empty', () => {
      const repo = mergedRepo((r) => commit(r))

      expect(decideFromGit({ event: 'pull_request', cwd: repo })).toEqual({
        run: true,
        reason: expect.stringMatching(/empty/)
      })
    })

    it('skips a release branch that bumps the version and changes only release files', () => {
      const repo = releaseRepo({
        'package.json': pkg({ version: '0.6.0' }),
        'package-lock.json': '{}\n',
        'CHANGELOG.md': '## [0.6.0]\n',
        'docs/cli.md': '# CLI\n'
      })

      expect(decideFromGit({ event: 'pull_request', headRef: 'release/0.6.0', cwd: repo })).toEqual(
        SKIP_RELEASE
      )
    })

    it('runs a release branch that changes a dependency and not the version', () => {
      const repo = releaseRepo({
        'package.json': pkg({ version: '0.5.0', dependencies: { 'node-pty': '1.1.0' } })
      })

      expect(decideFromGit({ event: 'pull_request', headRef: 'release/0.6.0', cwd: repo })).toEqual(
        RUN_NO_VERSION
      )
    })

    it('runs a release branch that also changes code', () => {
      const repo = releaseRepo({
        'package.json': pkg({ version: '0.6.0' }),
        'src/retry.ts': 'export const retries = 3\n'
      })

      expect(decideFromGit({ event: 'pull_request', headRef: 'release/0.6.0', cwd: repo })).toEqual(
        RUN_CODE
      )
    })

    it('runs a release branch whose package.json does not parse', () => {
      const repo = releaseRepo({ 'package.json': '{ "version": ' })

      expect(decideFromGit({ event: 'pull_request', headRef: 'release/0.6.0', cwd: repo })).toEqual(
        RUN_LOOKUP_FAILED
      )
    })

    it('runs any other branch changing only package.json', () => {
      const repo = repoChanging('package.json')

      expect(
        decideFromGit({ event: 'pull_request', headRef: 'APP-1432-retry-logic', cwd: repo })
      ).toEqual(RUN_CODE)
    })
  })

  describe('other events', () => {
    // Outside a repo: neither looks anything up, so neither can fail a lookup.
    it('always runs workflow_dispatch', () => {
      expect(decideFromGit({ event: 'workflow_dispatch', cwd: tmp })).toEqual({
        run: true,
        reason: expect.stringMatching(/manual run/)
      })
    })

    it('runs an event it does not know', () => {
      expect(decideFromGit({ event: 'merge_group', cwd: tmp })).toEqual({
        run: true,
        reason: expect.stringMatching(/unknown event "merge_group"/)
      })
    })
  })

  describe('the checkout the workflows make', () => {
    it('has both parents of the merge commit at depth 2', () => {
      const clone = shallowClone(releaseRepo({ 'package.json': pkg({ version: '0.6.0' }) }), 2)

      expect(decideFromGit({ event: 'push', cwd: clone })).toEqual(SKIP_TREE)
      expect(
        decideFromGit({ event: 'pull_request', headRef: 'release/0.6.0', cwd: clone })
      ).toEqual(SKIP_RELEASE)
    })
  })

  describe('failed lookups', () => {
    it('runs outside a repo', () => {
      expect(decideFromGit({ event: 'push', cwd: tmp })).toEqual(RUN_LOOKUP_FAILED)
      expect(decideFromGit({ event: 'pull_request', cwd: tmp })).toEqual(RUN_LOOKUP_FAILED)
    })

    it('runs a depth-1 clone, where the parents are missing', () => {
      const clone = shallowClone(repoChanging('docs/guide.md'), 1)

      expect(decideFromGit({ event: 'push', cwd: clone }).run).toBe(true)
      expect(decideFromGit({ event: 'pull_request', cwd: clone })).toEqual(RUN_LOOKUP_FAILED)
    })
  })
})

describe('the mac-jobs CLI', () => {
  /** Runs the script in `cwd` as a runner would, with the output file already holding a line. */
  function runCli(cwd: string, event: string, headRef = '') {
    const outputFile = join(tmp, 'github-output')

    fs.writeFileSync(outputFile, 'earlier=kept\n')

    const result = spawnSync(process.execPath, [script], {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: event,
        GITHUB_HEAD_REF: headRef,
        GITHUB_OUTPUT: outputFile
      }
    })

    return {
      status: result.status,
      stdout: result.stdout,
      output: fs.readFileSync(outputFile, 'utf8')
    }
  }

  it('appends the decision for the event and head branch in the environment', () => {
    const repo = releaseRepo({ 'package.json': pkg({ version: '0.6.0' }) })

    expect(runCli(repo, 'pull_request', 'release/0.6.0').output).toBe('earlier=kept\nrun=false\n')
    expect(runCli(repo, 'pull_request', 'APP-1432-retry-logic').output).toBe(
      'earlier=kept\nrun=true\n'
    )
  })

  it('appends run=true and exits 0 when a lookup fails', () => {
    expect(runCli(tmp, 'pull_request')).toEqual({
      status: 0,
      stdout: expect.stringContaining('a lookup failed'),
      output: 'earlier=kept\nrun=true\n'
    })
  })
})
