import { describe, expect, it } from 'vitest'
import type { HookEvent } from '@shared/protocol'
import { makeHookEvent } from '../testing/fixtures'
import {
  createdPullRequests,
  githubRepo,
  prCreateCall,
  printedPullRequests,
  printsPullRequest,
  type Repo,
  runsPrCreate
} from './pr-created'
import { decodeRepoView } from './pr-created.decode'

const QUE: Repo = { owner: 'rquellh', name: 'que' }
const URL_88 = 'https://github.com/rquellh/que/pull/88'

/** A Bash PostToolUse as Claude Code reports it: the command, and what it printed. */
const bash = (command: string, response: unknown, extra: Partial<HookEvent> = {}): HookEvent =>
  makeHookEvent('PostToolUse', {
    tool_name: 'Bash',
    tool_input: { command, description: 'Open the pull request' },
    tool_response: response,
    ...extra
  })

/** What a hook event shows created on `repo`; none when it is not a `gh pr create` call. */
const created = (event: HookEvent, repo: Repo = QUE): string[] => {
  const call = prCreateCall(event)

  return call ? createdPullRequests(call, repo) : []
}

describe('runsPrCreate', () => {
  it.each([
    'gh pr create --title "Retry uploads" --body "Adds backoff"',
    'gh pr create --draft --fill',
    'gh pr create --base APP-1432-retry-logic --head APP-1433-backoff --fill',
    'gh pr create --repo rquellh/que --fill',
    'git push -u origin HEAD && gh pr create --fill',
    'git push -u origin HEAD; gh  pr  create --fill',
    'cd /Users/dev/src/que && /opt/homebrew/bin/gh pr create --fill',
    '(gh pr create --fill)'
  ])('sees %s', (command) => {
    expect(runsPrCreate(command)).toBe(true)
  })

  it.each([
    'gh pr view 88 --json url',
    'gh pr list --head APP-1432-retry-logic',
    'gh pr created-at',
    'echo "remember to run fakegh pr create later"',
    'my-gh pr create --fill'
  ])('ignores %s', (command) => {
    expect(runsPrCreate(command)).toBe(false)
  })
})

describe('githubRepo', () => {
  it.each([
    ['https://github.com/rquellh/que.git', 'rquellh', 'que'],
    ['https://github.com/rquellh/que', 'rquellh', 'que'],
    ['https://x-access-token@github.com/rquellh/que.git', 'rquellh', 'que'],
    ['git@github.com:rquellh/que.git', 'rquellh', 'que'],
    ['ssh://git@github.com/rquellh/que.git', 'rquellh', 'que'],
    ['git@github.com:rquellh/que.js.git', 'rquellh', 'que.js']
  ])('reads %s', (remote, owner, name) => {
    expect(githubRepo(remote)).toEqual({ owner, name })
  })

  it.each(['/Users/dev/src/uploader.git', 'https://gitlab.com/rquellh/que.git', ''])(
    'is null for %j',
    (remote) => {
      expect(githubRepo(remote)).toBeNull()
    }
  )
})

describe('decodeRepoView', () => {
  it('reads the repository gh names', () => {
    expect(decodeRepoView({ nameWithOwner: 'queapp-org/que' })).toEqual({
      owner: 'queapp-org',
      name: 'que'
    })
  })

  it.each([
    [{}],
    [{ nameWithOwner: 7 }],
    [{ nameWithOwner: 'que' }],
    [{ nameWithOwner: 'queapp-org/que/extra' }],
    [null],
    [[]]
  ])('is null for %j', (view) => {
    expect(decodeRepoView(view)).toBeNull()
  })
})

describe('printedPullRequests', () => {
  it('lists the URLs on any repository across the output, in order, each once', () => {
    const uploader = 'https://github.com/rquellh/uploader/pull/12'

    expect(
      printedPullRequests({
        command: 'gh pr create --fill',
        output: [`${uploader}\n${URL_88}\n`, `Created ${URL_88}`]
      })
    ).toEqual([uploader, URL_88])
  })
})

describe('createdPullRequests', () => {
  it('finds the URL gh printed to stdout', () => {
    const event = bash('gh pr create --fill', {
      stdout: `${URL_88}\n`,
      stderr: '',
      interrupted: false
    })

    expect(created(event)).toEqual([URL_88])
  })

  it('finds it on stderr, or in a response that is a plain string', () => {
    const onStderr = bash('gh pr create --draft --fill', {
      stdout: '',
      stderr: `\nCreating draft pull request for APP-1433-backoff into main in rquellh/que\n\n${URL_88}\n`
    })

    expect(created(onStderr)).toEqual([URL_88])
    expect(created(bash('gh pr create --fill', `${URL_88}\n`))).toEqual([URL_88])
  })

  it('finds it after a chain, with --repo, and from a subagent', () => {
    const event = bash(
      'git push -u origin HEAD && gh pr create --repo rquellh/que --base APP-1432-retry-logic --fill',
      { stdout: `branch 'APP-1433-backoff' set up to track 'origin/APP-1433-backoff'.\n${URL_88}` },
      { agent_id: 'a3f9c2e1', agent_type: 'general-purpose' }
    )

    expect(created(event)).toEqual([URL_88])
  })

  it("matches the origin's owner and name in any case, and lists each URL once", () => {
    const upper = 'https://github.com/RQuellh/Que/pull/88'
    const event = bash('gh pr create --fill', { stdout: `${upper}\n${upper}\n` })

    expect(created(event)).toEqual([upper])
  })

  it("ignores another repository's pull request", () => {
    const event = bash('gh pr create --repo rquellh/uploader --fill', {
      stdout: 'https://github.com/rquellh/uploader/pull/12\n'
    })

    expect(created(event)).toEqual([])
  })

  it('ignores a command that did not create one, another tool, and another event', () => {
    expect(created(bash('gh pr view 88 --json url', { stdout: URL_88 }))).toEqual([])
    expect(
      created(
        makeHookEvent('PostToolUse', {
          tool_name: 'Read',
          tool_input: { file_path: '/Users/dev/notes.md' },
          tool_response: URL_88
        })
      )
    ).toEqual([])
    expect(
      created(
        makeHookEvent('PreToolUse', {
          tool_name: 'Bash',
          tool_input: { command: 'gh pr create --fill' }
        })
      )
    ).toEqual([])
  })
})

describe('printsPullRequest', () => {
  it('is true for a pull request URL on any repository, false for output without one', () => {
    expect(
      printsPullRequest({
        command: 'gh pr create --repo rquellh/uploader --fill',
        output: ['', 'https://github.com/rquellh/uploader/pull/12\n']
      })
    ).toBe(true)
    expect(
      printsPullRequest({
        command: 'gh pr create --fill',
        output: ['pull request create failed: no commits between main and APP-1433-backoff']
      })
    ).toBe(false)
  })
})
