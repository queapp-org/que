// The subprocess fakes are test infrastructure the daemon tests lean on;
// this pins their behavior to what tests/fakes/README.md promises.
import { type ChildProcess, execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FAKES_BIN, readFakeLog } from './fakes'

const CLAUDE = join(FAKES_BIN, 'claude')

const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'StopFailure',
  'SessionEnd'
]

let dir: string
let hookLog: string
let settings: string
const children: ChildProcess[] = []

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'que-fakes-')))
  hookLog = join(dir, 'hooks.jsonl')
  const recorder = join(dir, 'record-hook.cjs')
  fs.writeFileSync(
    recorder,
    "let s='';process.stdin.on('data',(c)=>(s+=c));process.stdin.on('end',()=>require('node:fs').appendFileSync(process.argv[2],JSON.stringify({marker:process.env.QUE_TEST_MARKER,payload:JSON.parse(s)})+'\\n'))\n"
  )
  const command = `'${process.execPath}' '${recorder}' '${hookLog}'`
  settings = JSON.stringify({
    hooks: Object.fromEntries(
      HOOK_EVENTS.map((e) => [e, [{ matcher: '', hooks: [{ type: 'command', command }] }]])
    )
  })
})

afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill('SIGKILL')
  fs.rmSync(dir, { recursive: true, force: true })
})

interface Run {
  code: number | null
  stdout: string
  stderr: string
}

function run(bin: string, args: string[], env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        cwd: dir,
        env: { ...process.env, QUE_FAKE_CLAUDE_TRANSCRIPT_DIR: join(dir, 'tr'), ...env },
        encoding: 'utf8'
      },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : null) : 0,
          stdout,
          stderr
        })
      }
    ).stdin?.end()
  })
}

/** Starts a fake claude that is expected to block, collecting its stdout. */
function start(args: string[], env: Record<string, string>): { proc: ChildProcess; out: string[] } {
  const proc = spawn(CLAUDE, args, {
    cwd: dir,
    env: { ...process.env, QUE_FAKE_CLAUDE_TRANSCRIPT_DIR: join(dir, 'tr'), ...env }
  })

  children.push(proc)
  const out: string[] = []
  proc.stdout?.on('data', (c: Buffer) => out.push(c.toString('utf8')))

  return { proc, out }
}

function exitCode(proc: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => proc.once('exit', (code) => resolve(code)))
}

function hooks(): { marker?: string; payload: Record<string, unknown> }[] {
  if (!fs.existsSync(hookLog)) return []

  return fs
    .readFileSync(hookLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

const hookNames = () => hooks().map((h) => h.payload.hook_event_name)

describe('fake claude', () => {
  describe('interactive', () => {
    it('answers each line with hooks and exits on /exit', async () => {
      const { proc, out } = start(['--settings', settings], {})
      await expect.poll(() => out.join(''), { timeout: 10_000 }).toContain('> ')

      proc.stdin?.write('Explain the uploader\n')
      await expect.poll(hookNames, { timeout: 10_000 }).toContain('Stop')
      proc.stdin?.write('/exit\n')

      expect(await exitCode(proc)).toBe(0)
      expect(out.join('')).toContain('Fake reply to: Explain the uploader')
      expect(hookNames()).toEqual([
        'SessionStart',
        'UserPromptSubmit',
        'PreToolUse',
        'PostToolUse',
        'Stop',
        'SessionEnd'
      ])
    }, 20_000)

    it('with QUE_FAKE_CLAUDE_STREAM, keeps a turn working until SIGUSR2 asks and SIGUSR1 ends one', async () => {
      const { proc, out } = start(['--settings', settings], { QUE_FAKE_CLAUDE_STREAM: '50' })
      await expect.poll(() => out.join(''), { timeout: 10_000 }).toContain('> ')

      proc.stdin?.write('Add retry with backoff\n')
      await expect
        .poll(() => hookNames().filter((n) => n === 'PostToolUse').length, { timeout: 10_000 })
        .toBeGreaterThanOrEqual(3)
      expect(hookNames()).not.toContain('Stop')
      expect(out.join('')).toMatch(/● (Read|Grep|Edit|Bash)\(/)

      proc.kill('SIGUSR2')
      await expect.poll(hookNames, { timeout: 10_000 }).toContain('Notification')
      await expect.poll(() => out.join(''), { timeout: 10_000 }).toContain('Allow? (y/n)')
      expect(hookNames()).not.toContain('Stop')
      proc.stdin?.write('y\n')
      await expect.poll(hookNames, { timeout: 10_000 }).toContain('Stop')

      proc.stdin?.write('Document config keys\n')
      await expect
        .poll(() => hookNames().filter((n) => n === 'UserPromptSubmit').length, { timeout: 10_000 })
        .toBe(2)
      proc.kill('SIGUSR1')
      await expect
        .poll(() => hookNames().filter((n) => n === 'Stop').length, { timeout: 10_000 })
        .toBe(2)
      expect(out.join('')).toContain('● Done. The change is in and the tests pass.')
    }, 20_000)
  })

  describe('cli surface', () => {
    it('prints a version and an empty agent list', async () => {
      expect((await run(CLAUDE, ['--version'])).stdout).toMatch(/^\d+\.\d+\.\d+ \(Claude Code\)/)
      expect(JSON.parse((await run(CLAUDE, ['agents', '--json'])).stdout)).toEqual([])
    }, 20_000)

    it('logs a call but not the status poll, which runs on its own clock', async () => {
      const log = join(dir, 'claude.log')

      await run(CLAUDE, ['--version'], { QUE_FAKE_CLAUDE_LOG: log })
      await run(CLAUDE, ['agents', '--json'], { QUE_FAKE_CLAUDE_LOG: log })

      expect(readFakeLog(log).map((c) => c.argv)).toEqual([['--version']])
    }, 20_000)
  })
})

describe('fake gh and code', () => {
  it('logs every call and numbers the PRs it opens', async () => {
    const ghLog = join(dir, 'gh.log')
    const codeLog = join(dir, 'code.log')
    const env = { QUE_FAKE_GH_LOG: ghLog, QUE_FAKE_CODE_LOG: codeLog }

    expect((await run(join(FAKES_BIN, 'gh'), ['auth', 'status'], env)).code).toBe(0)
    const first = await run(join(FAKES_BIN, 'gh'), ['pr', 'create', '--draft', '--fill'], env)
    const second = await run(join(FAKES_BIN, 'gh'), ['pr', 'create', '--draft', '--fill'], env)
    await run(join(FAKES_BIN, 'code'), ['--new-window', dir], env)

    expect(first.stdout.trim()).toBe('https://github.com/rquellh/que/pull/1')
    expect(second.stdout.trim()).toBe('https://github.com/rquellh/que/pull/2')
    expect(readFakeLog(ghLog).map((c) => c.argv)).toEqual([
      ['auth', 'status'],
      ['pr', 'create', '--draft', '--fill'],
      ['pr', 'create', '--draft', '--fill']
    ])
    expect(readFakeLog(codeLog)).toEqual([
      { argv: ['--new-window', dir], cwd: dir, ts: expect.any(String) }
    ])
  }, 20_000)
})
