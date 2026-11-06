// The real `que` CLI as a subprocess against the in-process daemon.
import fs from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TermInfo } from '@shared/protocol'
import type { Workspace } from '@shared/types'
import { LAUNCHD_LABEL } from '../../src/cli/launchd'
import type { StatusJson } from '../../src/cli/workspaces'
import { runCli, runCliJson, runCliWith } from '../../src/testing/cli'
import {
  startTestDaemon,
  type TestDaemon,
  waitForStatus,
  withQuietOff
} from '../../src/testing/daemon-harness'
import { FAKES_BIN, readFakeLog, setFakePullRequest } from '../../src/testing/fakes'
import { makeHookEvent } from '../../src/testing/fixtures'
import { addBareOrigin, gitIn, makeTempRepo } from '../../src/testing/temp-repo'

let daemon: TestDaemon

beforeEach(async () => {
  daemon = await startTestDaemon()
})

afterEach(async () => {
  await daemon.close()
})

describe('que term list', () => {
  it('prints every terminal as JSON with --json and exits 0', async () => {
    const { id } = await daemon.client.request('term.create', {
      file: '/bin/cat',
      name: 'uploader-shell',
      cwd: daemon.home,
      cols: 80,
      rows: 24
    })

    // The daemon learns the foreground program a moment after the terminal starts. The timeout
    // covers its slowest path: the next one-second poll, then two `ps` calls of up to 5 s each.
    await expect
      .poll(async () => (await daemon.client.request('term.list'))[0]?.process, { timeout: 15_000 })
      .toBe('cat')

    const terms = await runCliJson<TermInfo[]>('term', 'list', '--json')
    expect(terms).toHaveLength(1)
    expect(terms[0]).toEqual({
      id,
      name: 'uploader-shell',
      cwd: daemon.home,
      cols: 80,
      rows: 24,
      pid: expect.any(Number),
      alive: true,
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      process: 'cat'
    })
    expect(terms[0]).not.toHaveProperty('workspaceId')
  }, 30_000)

  it('says so when there are no terminals', async () => {
    const r = await runCli('term', 'list')

    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe('no terminals')
  }, 30_000)

  it('fails with a message when the daemon is not running', async () => {
    await daemon.server.close()

    const r = await runCli('term', 'list', '--json')

    expect(r.code).toBe(1)
    expect(r.stderr).toContain('que: daemon is not running')
  }, 30_000)
})

describe('que daemon status', () => {
  it('prints the running daemon as JSON with --json, and running: false with exit 3 once it is gone', async () => {
    const ping = await daemon.client.request('daemon.ping')

    expect(await runCliJson('daemon', 'status', '--json')).toEqual({
      running: true,
      pid: ping.pid,
      version: ping.version,
      // The in-process daemon has no bundle of its own, so its build is unknown.
      buildId: '',
      expectedBuildId: expect.any(String),
      stale: false,
      nodeVersion: ping.nodeVersion,
      startedAt: ping.startedAt,
      socket: daemon.socket,
      terminals: { alive: 0, total: 0 }
    })

    await daemon.server.close()
    const gone = await runCli('daemon', 'status', '--json')
    expect(gone.code).toBe(3)
    expect(JSON.parse(gone.stdout)).toEqual({ running: false, socket: daemon.socket })
  }, 30_000)
})

describe('que work and que ws', () => {
  it('creates a workspace from a repo path, waits for setup, and prints its path', async () => {
    const repo = makeTempRepo(daemon.home, { queToml: 'setup = "printf ok > .setup-done"\n' })

    const r = await runCli(
      'work',
      'APP-1432 retry logic',
      '--name',
      'APP-1432 retry logic',
      '-r',
      repo
    )

    expect(r.code).toBe(0)
    const path = join(daemon.home, 'worktrees', 'uploader', 'app-1432-retry-logic')
    expect(r.stdout.trim()).toBe(path)
    expect(fs.readFileSync(join(path, '.setup-done'), 'utf8')).toBe('ok')
    expect(gitIn(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('app-1432-retry-logic')
    const listed = await runCliJson<Workspace[]>('ws', 'list', '--json')
    expect(listed).toEqual([
      expect.objectContaining({ path, status: 'idle', title: 'APP-1432 retry logic' })
    ])
  }, 30_000)

  it('takes a multi-line brief, or a --name, and refuses neither', async () => {
    const repo = makeTempRepo(daemon.home)
    const brief = 'Raise the upload timeout\n\nThe upload test times out on slow runners.'

    const fromBrief = await runCliJson<Workspace>('work', brief, '-r', repo, '--json')

    const named = await runCliJson<Workspace>(
      'work',
      brief,
      '--name',
      'APP-1490 timeout',
      '-r',
      repo,
      '--json'
    )

    const neither = await runCli('work', '-r', repo)

    expect(fromBrief).toMatchObject({
      name: expect.stringMatching(/^[a-z]+-[a-z]+-[a-z]+$/),
      title: 'Raise the upload timeout',
      brief
    })
    expect(named).toMatchObject({
      name: 'app-1490-timeout',
      title: 'Raise the upload timeout'
    })
    expect(neither.code).toBe(2)
    expect(neither.stderr).toContain('give a brief (what you are doing) or --name')
    const table = (await runCli('ws', 'list')).stdout
    expect(table).toContain('Raise the upload timeout')
  }, 30_000)

  it('resolves -r through the config registry and fails when setup fails', async () => {
    const repo = makeTempRepo(daemon.home, { queToml: 'setup = "exit 4"\n' })
    fs.writeFileSync(daemon.configPath, withQuietOff(`[repos.uploader-api]\npath = "${repo}"\n`))

    const r = await runCli('work', '--name', 'app-1433-broken-setup', '-r', 'uploader-api')

    expect(r.code).toBe(1)
    expect(r.stderr).toContain('setup failed for app-1433-broken-setup')
    const [project] = await daemon.client.request('project.list')
    expect(project).toMatchObject({ name: 'uploader-api', path: repo })
  }, 30_000)

  it('removes a workspace by name, printing each step, and deletes its branch', async () => {
    const repo = makeTempRepo(daemon.home)
    await runCli('work', '--name', 'app-1470-cleanup', '-r', repo)

    const r = await runCli('ws', 'remove', 'app-1470-cleanup')

    expect(r.code).toBe(0)
    expect(r.stdout.trim().split('\n')).toEqual([
      expect.stringMatching(/^killing terminals \d+\.\ds$/),
      expect.stringMatching(/^removing worktree \d+\.\ds$/),
      expect.stringMatching(/^deleting branch \d+\.\ds$/),
      expect.stringMatching(/^removed ws_[a-z2-7]{12} \(app-1470-cleanup\)$/)
    ])
    expect(await daemon.client.request('workspace.list')).toEqual([])
    expect(gitIn(repo, 'branch', '--list', 'app-1470-cleanup')).toBe('')
  }, 30_000)

  it('keeps the branch with --keep-branch', async () => {
    const repo = makeTempRepo(daemon.home)
    await runCli('work', '--name', 'app-1471-keep', '-r', repo)

    const r = await runCli('ws', 'remove', 'app-1471-keep', '--keep-branch')

    expect(r.code).toBe(0)
    expect(r.stdout).not.toContain('deleting branch')
    expect(await daemon.client.request('workspace.list')).toEqual([])
    expect(gitIn(repo, 'branch', '--list', 'app-1471-keep')).toBe('app-1471-keep')
  }, 30_000)

  it('prints a failed step to stderr and exits 1, still removing the workspace', async () => {
    const repo = makeTempRepo(daemon.home, { queToml: 'setup = "true"\nteardown = "exit 3"\n' })
    await runCli('work', '--name', 'app-1472-bad-teardown', '-r', repo)

    const r = await runCli('ws', 'remove', 'app-1472-bad-teardown')

    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/^que: running teardown \d+\.\ds: exited with code 3$/m)
    expect(r.stdout).toMatch(/^removed ws_[a-z2-7]{12} \(app-1472-bad-teardown\)$/m)
    expect(await daemon.client.request('workspace.list')).toEqual([])
  }, 30_000)

  it('opens a workspace with code -n', async () => {
    const repo = makeTempRepo(daemon.home)
    const path = (await runCli('work', '--name', 'app-1480-editor', '-r', repo)).stdout.trim()

    const r = await runCli('open', 'app-1480-editor')

    expect(r.code).toBe(0)
    expect(readFakeLog(daemon.codeLog).map((c) => c.argv)).toEqual([['-n', path]])
  }, 30_000)
})

describe('que status', () => {
  it('reports the summary and each workspace as JSON', async () => {
    const project = await daemon.client.request('project.add', {
      path: makeTempRepo(daemon.home)
    })

    const ws = await daemon.client.request('workspace.create', {
      projectId: project.id,
      name: 'app-1432-retry-logic'
    })

    await waitForStatus(daemon, ws.id, 'idle')
    await daemon.client.request('hook.event', {
      workspaceId: ws.id,
      payload: makeHookEvent('Notification', {
        session_id: '7d0c5b2a-0000-4000-8000-3e4f5a6b7c8d',
        notification_type: 'permission_prompt',
        message: 'Claude needs your permission to use Bash'
      })
    })

    const status = await runCliJson<StatusJson>('status', '--json')
    expect(status.summary).toEqual({
      working: 0,
      idle: 0,
      needs_input: 1,
      stuck: 0,
      exited: 0,
      preparing: 0,
      removing: 0
    })
    expect((await runCli('status')).stdout).toMatch(/^working 0 · needs input 1 · stuck 0 · /m)
    expect(status.workspaces).toEqual([
      {
        id: ws.id,
        name: 'app-1432-retry-logic',
        project: 'uploader',
        projectId: project.id,
        branch: 'app-1432-retry-logic',
        path: ws.path,
        status: 'needs_input',
        reason: null,
        lastActivityAt: null,
        sessionId: '7d0c5b2a-0000-4000-8000-3e4f5a6b7c8d',
        pr: null
      }
    ])
  }, 30_000)

  it('shows the workspace pull request in the table and as JSON', async () => {
    await daemon.close()
    daemon = await startTestDaemon({ config: 'pr_poll_seconds = 0.2\n' })
    const repo = makeTempRepo(daemon.home)
    addBareOrigin(repo)
    const project = await daemon.client.request('project.add', { path: repo })

    const ws = await daemon.client.request('workspace.create', {
      projectId: project.id,
      name: 'app-1432-retry-logic'
    })

    setFakePullRequest(daemon.ghPrs, ws.branch, {
      number: 12,
      isDraft: false,
      statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }]
    })
    await expect
      .poll(async () => (await daemon.client.request('workspace.get', { id: ws.id })).pr?.checks, {
        timeout: 10_000
      })
      .toBe('failing')

    const json = await runCliJson<StatusJson>('status', '--json')
    const table = (await runCli('status')).stdout

    expect(json.workspaces[0].pr).toMatchObject({ number: 12, state: 'open', checks: 'failing' })
    expect(table).toContain('#12 open·checks failing')
  }, 30_000)
})

describe('que doctor', () => {
  it('passes when the daemon, claude, gh, git, config, and wrapper are all there', async () => {
    const r = await runCli('doctor')

    expect(r.code).toBe(0)
    const lines = r.stdout.trim().split('\n')
    expect(lines.map((l) => l.split(/\s+/).slice(0, 2).join(' '))).toEqual([
      'ok daemon',
      'ok daemon', // the daemon build line
      'ok daemon', // the daemon PATH line
      'ok claude',
      'ok gh',
      'ok git',
      'ok node',
      'ok config',
      'ok quiet',
      'ok wrapper'
    ])
    expect(r.stdout).toContain('2.1.0 (Claude Code)')
    expect(r.stdout).toMatch(new RegExp(`daemon PATH\\s+claude at ${FAKES_BIN}/claude`))
    expect(r.stdout).not.toContain('keeps the PATH it started with')
  }, 30_000)

  describe('when the daemon misses what this shell finds', () => {
    const STARTED_WITH = `This shell finds ${FAKES_BIN}/claude and ${FAKES_BIN}/gh, but a daemon keeps the PATH it started with, even through \`que daemon upgrade\`.`

    /** `que doctor`'s daemon PATH line, with the daemon on a bare PATH and this shell on `shellPath`. */
    async function daemonPathLine(shellPath: string, launchAgents: string): Promise<string> {
      // The daemon runs in this process, so it reads this process's PATH.
      vi.stubEnv('PATH', '/usr/bin:/bin')

      const r = await runCliWith(
        { env: { PATH: shellPath, QUE_LAUNCH_AGENTS_DIR: launchAgents } },
        'doctor'
      )

      return r.stdout.split('\n').find((line) => line.includes('daemon PATH')) ?? ''
    }

    it('says where they are, why, and what to do', async () => {
      const line = await daemonPathLine(`${FAKES_BIN}:/usr/bin:/bin`, daemon.home)

      expect(line).toBe(
        `warn  daemon PATH  claude not on the daemon's PATH, gh not on the daemon's PATH. ${STARTED_WITH} \`que daemon restart\` gives it this shell's PATH and ends every terminal. The app reads PATH from your shell's startup files and gives up after 5 seconds, so if a daemon it starts has the same problem, set PATH in your login profile (~/.zprofile for zsh).`
      )
    }, 30_000)

    it('gives the steps for the launchd agent when one is installed', async () => {
      const agents = join(daemon.home, 'agents')
      fs.mkdirSync(agents)
      fs.writeFileSync(join(agents, `${LAUNCHD_LABEL}.plist`), '')

      const line = await daemonPathLine(`${FAKES_BIN}:/usr/bin:/bin`, agents)

      expect(line).toBe(
        `warn  daemon PATH  claude not on the daemon's PATH, gh not on the daemon's PATH. ${STARTED_WITH} The launchd agent's PATH was set when it was installed: \`que daemon stop\`, \`que daemon uninstall\`, then \`que daemon install\` give it this shell's PATH and end every terminal.`
      )
    }, 30_000)

    it('explains nothing when this shell does not find them either', async () => {
      const line = await daemonPathLine('/usr/bin:/bin', daemon.home)

      expect(line).toBe(
        "warn  daemon PATH  claude not on the daemon's PATH, gh not on the daemon's PATH"
      )
    }, 30_000)
  })

  it('fails on an invalid config file and names the key', async () => {
    fs.writeFileSync(daemon.configPath, 'stall_timeout_minutes = "soon"\n')

    const r = await runCli('doctor')

    expect(r.code).toBe(1)
    expect(r.stdout).toMatch(/FAIL\s+config\s+.*stall_timeout_minutes: must be a positive number/)
  }, 30_000)
})
