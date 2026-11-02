// `que doctor`: checks everything que depends on and says what is missing.
import fs from 'node:fs'
import { join } from 'node:path'
import { findOnPath } from '../daemon/wrapper'
import { buildIdOf, daemonIsStale, staleDaemonHint } from '../shared/build-id'
import { DaemonClient, resolveDaemonScript } from '../shared/client'
import { configPath, describeQuietHours, formatConfigErrors, loadConfig } from '../shared/config'
import { firstLine, run as exec } from '../shared/exec'
import { describeSocket, quePaths } from '../shared/paths'

interface Check {
  name: string
  ok: boolean
  required: boolean
  detail: string
}

async function run(file: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  const r = await exec(file, args, { timeoutMs: 10_000 })

  return { ok: r.ok, out: firstLine(`${r.stdout}${r.stderr}`) }
}

function executable(path: string): boolean {
  try {
    fs.accessSync(path, fs.constants.X_OK)

    return true
  } catch {
    return false
  }
}

export async function runDoctor(): Promise<number> {
  const paths = quePaths()
  const checks: Check[] = []

  let daemonPath: { ok: boolean; detail: string } | null = null
  let daemonBuild: { ok: boolean; detail: string } | null = null
  const client = await DaemonClient.tryConnect(paths)

  if (client) {
    try {
      const ping = await client.request('daemon.ping')
      const onPath = (name: string): string => findOnPath(name, ping.path, [paths.binDir]) ?? ''
      const [c, g] = [onPath('claude'), onPath('gh')]
      daemonPath = {
        ok: c !== '',
        detail: `${c ? `claude at ${c}` : "claude not on the daemon's PATH"}, ${g ? `gh at ${g}` : "gh not on the daemon's PATH"}`
      }
      const expected = buildIdOf(resolveDaemonScript())
      daemonBuild = daemonIsStale(ping.buildId, expected)
        ? { ok: false, detail: staleDaemonHint(ping.buildId, expected) }
        : {
            ok: true,
            detail: ping.buildId && expected ? `${ping.buildId} (matches this que)` : 'unknown'
          }
      checks.push({
        name: 'daemon',
        ok: true,
        required: true,
        detail: `running pid ${ping.pid}, version ${ping.version} (${describeSocket(paths)})`
      })
    } finally {
      client.close()
    }
  } else {
    checks.push({
      name: 'daemon',
      ok: false,
      required: true,
      detail: `not reachable at ${describeSocket(paths)} (start it with \`que daemon start\`)`
    })
  }

  checks.push({
    name: 'daemon build',
    ok: daemonBuild?.ok ?? false,
    required: false,
    detail: daemonBuild?.detail ?? 'skipped (the daemon is not running)'
  })

  checks.push({
    name: 'daemon PATH',
    ok: daemonPath?.ok ?? false,
    required: false,
    detail: daemonPath?.detail ?? 'skipped (the daemon is not running)'
  })

  const claude = findOnPath('claude', process.env.PATH, [paths.binDir])
  const claudeVersion = claude ? await run(claude, ['--version']) : null
  checks.push({
    name: 'claude',
    ok: claudeVersion?.ok === true,
    required: true,
    detail: claude
      ? `${claudeVersion?.out || 'no version output'} (${claude})`
      : `not found on PATH outside ${paths.binDir}`
  })

  const gh = await run('gh', ['auth', 'status'])
  checks.push({
    name: 'gh',
    ok: gh.ok,
    required: false,
    detail: gh.ok
      ? 'authenticated (reads pull requests, checks and comments)'
      : 'missing or not logged in (`gh auth login`); que cannot read pull requests, checks and comments'
  })

  const git = await run('git', ['--version'])
  checks.push({ name: 'git', ok: git.ok, required: true, detail: git.ok ? git.out : 'not found' })

  checks.push({
    name: 'node',
    ok: true,
    required: true,
    detail: `${process.version} (${process.execPath})`
  })

  const cfgPath = configPath()
  const cfg = loadConfig({ queHome: paths.home }, cfgPath)
  checks.push({
    name: 'config',
    ok: cfg.ok,
    required: true,
    detail: cfg.ok
      ? `${fs.existsSync(cfgPath) ? cfgPath : `${cfgPath} (not present; defaults)`}`
      : `${cfgPath}: ${formatConfigErrors(cfg.errors)}`
  })

  checks.push({
    name: 'quiet',
    ok: cfg.ok,
    required: false,
    detail: cfg.ok
      ? `quiet hours ${describeQuietHours(cfg.config.quietHours)}`
      : 'unknown (the config is invalid)'
  })

  const wrapper = [join(paths.binDir, 'claude'), join(paths.binDir, 'que')]

  const missing = [
    ...wrapper.filter((p) => !executable(p)),
    ...(fs.existsSync(paths.hooksJson) ? [] : [paths.hooksJson])
  ]

  checks.push({
    name: 'wrapper',
    ok: missing.length === 0,
    required: true,
    detail:
      missing.length === 0
        ? `${paths.binDir}/{claude,que}, ${paths.hooksJson}`
        : `missing ${missing.join(', ')} (written when the daemon starts)`
  })

  for (const c of checks) {
    const tag = c.ok ? 'ok  ' : c.required ? 'FAIL' : 'warn'
    console.log(`${tag}  ${c.name.padEnd(12)} ${c.detail}`)
  }

  return checks.some((c) => c.required && !c.ok) ? 1 : 0
}
