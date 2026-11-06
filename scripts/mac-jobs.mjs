// `node scripts/mac-jobs.mjs`: whether the macOS checks (Unit tests, E2E tests, Packaged app) can
// tell us anything new about this commit. Each workflow's `decide` job runs it, and the real job
// reads the `run` it appends to $GITHUB_OUTPUT. When a decision can't be made the tests run, so
// every decision exits 0 and only an explicit `run=false` skips.
//
// It runs on the runner's own Node, before any `npm ci`: only builtin imports, nothing newer than
// Node 20.
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Anything under docs/ counts too. A file the build or the tests read does not belong here.
const DOCS_FILES = new Set([
  'README.md',
  'CONTRIBUTING.md',
  'DEVELOPING.md',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
  'CLAUDE.md',
  'CHANGELOG.md'
])

// What `npm run release` changes: the version, the changelog, and what its after:bump hook
// (`npm run docs`) regenerates. A file missing here only makes a release pull request run the tests.
const RELEASE_FILES = new Set([
  'package.json',
  'package-lock.json',
  'CHANGELOG.md',
  'docs/cli.md',
  'docs/configuration.md'
])

const isDocs = (path) => DOCS_FILES.has(path) || path.startsWith('docs/')
const isReleaseFile = (path) => RELEASE_FILES.has(path)
const isReleaseBranch = (ref = '') => ref.startsWith('release/')
const runBecause = (reason) => ({ run: true, reason })
const skipBecause = (reason) => ({ run: false, reason })

function decidePush(tree, secondParentTree) {
  if (secondParentTree === undefined) {
    return runBecause('no second parent to compare with: a squash, a rebase or a shallow fetch')
  }

  return tree === secondParentTree
    ? skipBecause('the merged tree is the one the pull request tested')
    : runBecause('the merged tree differs from the one the pull request tested')
}

function decidePullRequest({ headRef, changedFiles = [], versionChanged = false }) {
  if (changedFiles.length === 0) return runBecause('the diff is empty')

  if (changedFiles.every(isDocs)) return skipBecause('only docs changed')

  if (isReleaseBranch(headRef) && changedFiles.every(isReleaseFile)) {
    // Skipping is safe only because the Release job runs next, and it runs only for a new version.
    return versionChanged
      ? skipBecause('a release pull request: the Release job is the full run')
      : runBecause('a release branch with no new version: the Release job would not run')
  }

  return runBecause('the pull request changes more than docs or release files')
}

/**
 * Whether the Mac jobs run, given what git said: `tree` and `secondParentTree` on a push,
 * `headRef`, `changedFiles` and `versionChanged` on a pull request. A fact left undefined is one
 * nobody could read.
 */
export function decide(facts) {
  if (facts.event === 'workflow_dispatch') return runBecause('a manual run always runs')

  if (facts.event === 'push') return decidePush(facts.tree, facts.secondParentTree)

  if (facts.event === 'pull_request') return decidePullRequest(facts)

  return runBecause(`unknown event "${facts.event}"`)
}

/** `decide`, with the facts the event needs read from git in `cwd`. A failed lookup means run. */
export function decideFromGit({ event, headRef, cwd }) {
  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  try {
    if (event === 'push') {
      return decide({
        event,
        tree: git('rev-parse', '--verify', 'HEAD^{tree}').trim(),
        secondParentTree: readSecondParentTree(git)
      })
    }

    if (event === 'pull_request') {
      // The checkout is GitHub's test merge commit, so its first parent is the base. Without
      // --no-renames, moving src/foo.ts to docs/foo.md would list only the docs path.
      const diff = git('diff', '--no-renames', '--name-only', '-z', 'HEAD^1', 'HEAD')
      const version = (commit) => JSON.parse(git('show', `${commit}:package.json`)).version

      return decide({
        event,
        headRef,
        changedFiles: diff.split('\0').filter(Boolean),
        versionChanged: isReleaseBranch(headRef) && version('HEAD^1') !== version('HEAD')
      })
    }

    return decide({ event })
  } catch (err) {
    return runBecause(`a lookup failed: ${err.message.trim()}`)
  }
}

function readSecondParentTree(git) {
  // Fails when HEAD has no second parent and when the fetch left it out. Either way there is
  // nothing to compare with, and decide runs the tests.
  try {
    return git('rev-parse', '--verify', '--quiet', 'HEAD^2^{tree}').trim()
  } catch {
    return undefined
  }
}

function main() {
  const { run, reason } = decideFromGit({
    event: process.env.GITHUB_EVENT_NAME,
    headRef: process.env.GITHUB_HEAD_REF,
    cwd: process.cwd()
  })

  // By hand there is no output file, and the line below is the answer.
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run=${run}\n`)

  console.log(`run=${run}: ${reason}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
