import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import { pidAlive } from './process'
import { loginShellPath, mergePath } from './login-path'

describe('mergePath', () => {
  it('keeps the current PATH when there is no login PATH', () => {
    expect(mergePath('/usr/bin:/bin', null)).toBe('/usr/bin:/bin')
    expect(mergePath('/usr/bin', '')).toBe('/usr/bin')
    expect(mergePath(undefined, null)).toBe('')
  })

  it('puts the login entries first, then the current-only extras', () => {
    expect(mergePath('/usr/bin:/extra', '/opt/homebrew/bin:/usr/bin')).toBe(
      '/opt/homebrew/bin:/usr/bin:/extra'
    )
  })

  it('drops duplicates and empty entries', () => {
    expect(mergePath('/a::/b', '/b::/c:/b')).toBe('/b:/c:/a')
  })

  it('uses the login PATH alone when there is no current one', () => {
    expect(mergePath(undefined, '/x:/y')).toBe('/x:/y')
  })
})

describe('loginShellPath', () => {
  let home: string
  beforeEach(() => {
    home = fs.mkdtempSync(join(os.tmpdir(), 'que-login-'))
  })
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('reads the PATH a login shell builds from its profile', async () => {
    fs.writeFileSync(join(home, '.profile'), 'PATH="/opt/que-test/bin:$PATH"\n')

    const path = await loginShellPath({
      shell: '/bin/sh',
      env: { HOME: home, PATH: '/usr/bin:/bin' }
    })

    expect(path?.startsWith('/opt/que-test/bin:')).toBe(true)
  })

  it('resolves null when the shell cannot run', async () => {
    expect(await loginShellPath({ shell: join(home, 'no-such-shell') })).toBeNull()
  })
})

describe('loginShellPath with a real zsh', () => {
  const ZSH = '/bin/zsh'
  /** Long enough for a loaded machine to start zsh, short enough to wait out. */
  const TIMEOUT_MS = 3000
  /** The most a loaded machine may add to the deadline before the answer is seen. */
  const SLACK_MS = 2000
  const ZSHRC_DIR = '/opt/que-test/zshrc-only'
  const PROFILE_DIR = '/opt/que-test/zprofile'

  let home: string

  beforeEach(() => {
    expect(fs.existsSync(ZSH), `these tests run a real zsh at ${ZSH}`).toBe(true)
    home = fs.mkdtempSync(join(os.tmpdir(), 'que-zsh-'))
    fs.writeFileSync(join(home, '.zprofile'), `PATH="${PROFILE_DIR}:$PATH"\n`)
    execFileSync('mkfifo', [join(home, 'never')])
  })
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
  })

  /** HOME and ZDOTDIR are the temp dir, so the startup files read are these, never the real ones. */
  const zshPath = (timeoutMs?: number, extraEnv: NodeJS.ProcessEnv = {}): Promise<string | null> =>
    loginShellPath({
      shell: ZSH,
      env: { HOME: home, ZDOTDIR: home, PATH: '/usr/bin:/bin', ...extraEnv },
      timeoutMs
    })

  const entries = (path: string | null): string[] => (path ?? '').split(':')

  const pidsIn = (file: string): number[] =>
    fs
      .readFileSync(join(home, file), 'utf8')
      .trim()
      .split('\n')
      .map((line) => Number(line))

  it('finds a directory added only in .zshrc, as a terminal does', async () => {
    fs.writeFileSync(join(home, '.zshrc'), `PATH="${ZSHRC_DIR}:$PATH"\n`)

    expect(entries(await zshPath())).toContain(ZSHRC_DIR)
  })

  it('takes only the value when startup files print to stdout, and trims nothing from it', async () => {
    const value = `${ZSHRC_DIR}:/usr/bin:/bin:/opt/que test/trailing space `
    fs.writeFileSync(
      join(home, '.zshrc'),
      `print 'Welcome back, /tmp is 42% full'\nprint -r -- "$ZSH_EXECUTION_STRING"\nprintf 'no newline'\nPATH='${value}'\n`
    )
    fs.writeFileSync(join(home, '.zlogout'), `print 'Goodbye from /tmp'\n`)

    expect(await zshPath()).toBe(value)
  })

  it('falls back to the login shell within the timeout when .zshrc blocks forever', async () => {
    // The shell waits on a foreground child, which waits on a fifo nobody writes.
    fs.writeFileSync(
      join(home, '.zshrc'),
      `print $$ > "$ZDOTDIR/hung.pid"\n/bin/sh -c 'echo $$ >> "$ZDOTDIR/hung.pid"; exec /bin/cat "$ZDOTDIR/never"'\n`
    )
    const started = Date.now()

    const path = await zshPath(TIMEOUT_MS)

    expect(Date.now() - started).toBeLessThan(TIMEOUT_MS + SLACK_MS)
    expect(entries(path)).toContain(PROFILE_DIR)
    const [shell, child] = pidsIn('hung.pid')
    await expect.poll(() => [pidAlive(shell), pidAlive(child)]).toEqual([false, false])
  })

  it('falls back to the login shell when .zshrc exits before the value is printed', async () => {
    fs.writeFileSync(join(home, '.zshrc'), `PATH="${ZSHRC_DIR}:$PATH"\nexit 0\n`)

    const path = entries(await zshPath())

    expect(path).toContain(PROFILE_DIR)
    expect(path).not.toContain(ZSHRC_DIR)
  })

  it('falls back to the login shell when .zshrc floods stdout', async () => {
    fs.writeFileSync(join(home, '.zshrc'), `PATH="${ZSHRC_DIR}:$PATH"\n/usr/bin/yes\n`)
    const started = Date.now()

    const path = entries(await zshPath(TIMEOUT_MS))

    expect(Date.now() - started).toBeLessThan(TIMEOUT_MS)
    expect(path).toContain(PROFILE_DIR)
    expect(path).not.toContain(ZSHRC_DIR)
  })

  it('uses the value when the shell then exits non-zero', async () => {
    fs.writeFileSync(join(home, '.zshrc'), `PATH="${ZSHRC_DIR}:$PATH"\n`)
    fs.writeFileSync(join(home, '.zlogout'), 'exit 3\n')

    expect(entries(await zshPath())).toContain(ZSHRC_DIR)
  })

  it('uses the value at once when the shell then hangs, and kills the shell at the timeout', async () => {
    fs.writeFileSync(join(home, '.zshrc'), `PATH="${ZSHRC_DIR}:$PATH"\n`)
    fs.writeFileSync(
      join(home, '.zlogout'),
      `print $$ >> "$ZDOTDIR/hung.pid"\nread line < "$ZDOTDIR/never"\n`
    )
    const started = Date.now()

    const path = await zshPath(TIMEOUT_MS)

    expect(Date.now() - started).toBeLessThan(TIMEOUT_MS)
    expect(entries(path)).toContain(ZSHRC_DIR)
    await expect
      .poll(() => pidsIn('hung.pid').filter(pidAlive), { timeout: TIMEOUT_MS + SLACK_MS })
      .toEqual([])
  })

  it('does not wait for a background process that keeps stdout open', async () => {
    fs.writeFileSync(
      join(home, '.zshrc'),
      `PATH="${ZSHRC_DIR}:$PATH"\n/bin/cat "$ZDOTDIR/never" &\nprint $! > "$ZDOTDIR/holder.pid"\n`
    )
    const started = Date.now()

    const path = await zshPath(TIMEOUT_MS)

    const elapsed = Date.now() - started
    const [holder] = pidsIn('holder.pid')
    onTestFinished(() => {
      process.kill(holder, 'SIGKILL')
    })
    expect(elapsed).toBeLessThan(TIMEOUT_MS)
    expect(entries(path)).toContain(ZSHRC_DIR)
  })

  it('gives a startup file that reads stdin an immediate end of input', async () => {
    fs.writeFileSync(join(home, '.zshrc'), `/bin/cat\nPATH="${ZSHRC_DIR}:$PATH"\n`)

    expect(entries(await zshPath())).toContain(ZSHRC_DIR)
  })

  it('starts the shell without the markers of the terminal the app came from', async () => {
    fs.writeFileSync(
      join(home, '.zshrc'),
      'PATH="/opt/que-test/term-${QUE_TERMINAL_ID:-none}:$PATH"\n'
    )

    const path = await zshPath(undefined, { QUE_TERMINAL_ID: 'term_01hzx3k9c2qf' })

    expect(entries(path)).toContain('/opt/que-test/term-none')
  })
})
