// The PATH a terminal's shell would have. An app launched from Finder gets
// launchd's `/usr/bin:/bin:/usr/sbin:/sbin`, which has neither Homebrew nor
// `~/.local/bin`; the daemon inherits it, so it must be fixed before the
// daemon starts.
import { spawn } from 'node:child_process'
import { cleanSpawnEnv } from './env'

/**
 * Around the value in a shell's output, since startup files can print there too. The command
 * spells it in octal, so a startup file that prints the command does not look like an answer.
 */
const MARK = '\x1eque-path\x1e'
const PRINT_PATH = `printf '\\036que-path\\036%s\\036que-path\\036' "$PATH"`

/** A shell that has printed this much without the value is given up on. */
const MAX_OUTPUT = 64 * 1024

/** The user's login shell, `$SHELL`, or zsh when it is unset: what every terminal starts. */
export function loginShell(): string {
  return process.env.SHELL || '/bin/zsh'
}

/** Login entries first (deduplicated, empties dropped), then the rest of `current`. */
export function mergePath(current: string | undefined, login: string | null): string {
  if (!login) return current ?? ''
  const seen = new Set<string>()
  const out: string[] = []

  for (const entry of [...login.split(':'), ...(current ?? '').split(':')]) {
    if (!entry || seen.has(entry)) continue
    seen.add(entry)
    out.push(entry)
  }

  return out.join(':')
}

/**
 * `$PATH` as `<shell> <flags>` prints it, from the moment it does: a shell that then exits
 * non-zero or lingers has still answered. Null when it gives no usable value within `timeoutMs`,
 * and a shell still running by then is killed.
 *
 * Not execFile: its timeout sends SIGTERM, which an interactive zsh ignores, so a startup file
 * that hangs would never call back. It also waits for stdout to close, which a background process
 * from a startup file can hold open.
 */
function shellPath(
  shell: string,
  flags: string,
  env: Record<string, string>,
  timeoutMs: number
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    // Its own session: no controlling terminal for an interactive shell to take over or prompt
    // on, and a process group that takes along whatever a startup file is waiting for.
    const child = spawn(shell, [flags, PRINT_PATH], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env
    })

    const answer = (path: string | null): void => {
      resolve(path)
      child.stdout?.destroy()
    }

    const deadline = setTimeout(() => {
      answer(null)

      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return

      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // Exited just now.
      }
    }, timeoutMs)

    const finished = (): void => {
      clearTimeout(deadline)
      answer(null)
    }

    let out = ''

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      out += chunk
      const [, value, after] = out.split(MARK)

      if (after !== undefined) answer(value.includes('/') ? value : null)
      else if (out.length > MAX_OUTPUT) answer(null)
    })
    child.on('error', finished)
    child.on('close', finished)
  }).catch(() => null)
}

/**
 * What `$PATH` is in the user's shell, or null when it cannot be read. Never rejects.
 *
 * An interactive login shell, because a terminal's shell is one, and only that reads `~/.zshrc`.
 * When it gives no answer (startup files hang, fail or take too long), the plain login shell's
 * is used. Both start at once, so `timeoutMs` is the longest this takes.
 */
export async function loginShellPath(
  opts: { shell?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}
): Promise<string | null> {
  const shell = opts.shell ?? loginShell()
  const env = cleanSpawnEnv(opts.env ?? process.env)
  const timeoutMs = opts.timeoutMs ?? 5000
  const login = shellPath(shell, '-lc', env, timeoutMs)
  const interactive = await shellPath(shell, '-ilc', env, timeoutMs)

  return interactive ?? login
}
