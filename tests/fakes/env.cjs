// The isolated environment every test process shares: the daemon harness,
// the e2e app and CLI, and the packaged-smoke script. A temp
// QUE_HOME and QUE_CONFIG, the fakes first on PATH with their logs in the
// home, and a git identity from <home>/gitconfig, never the machine's.
// Plain CommonJS so the .mjs scripts and the Playwright transform both load it
// without a build; env.d.cts types it.
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')

const FAKES_BIN = join(__dirname, 'bin')

/**
 * Quiet hours default to on (19:00-07:00), which would refuse terminal detail
 * whenever a run lands in the evening; test configs turn them off.
 */
exports.QUIET_OFF = '[quiet_hours]\nenabled = false\n'

/** The variables that isolate one test home; `pathPrefix` goes ahead of the fakes. */
exports.fakeEnv = function fakeEnv(home, pathPrefix = []) {
  return {
    QUE_HOME: home,
    QUE_CONFIG: join(home, 'config.toml'),
    PATH: [...pathPrefix, FAKES_BIN, process.env.PATH].join(':'),
    QUE_FAKE_CLAUDE_LOG: join(home, 'fake-claude.log'),
    QUE_FAKE_CLAUDE_TRANSCRIPT_DIR: join(home, 'transcripts'),
    QUE_FAKE_GH_LOG: join(home, 'fake-gh.log'),
    QUE_FAKE_GH_PRS: join(home, 'fake-gh-prs.json'),
    QUE_FAKE_ACLI_LOG: join(home, 'fake-acli.log'),
    QUE_FAKE_ACLI_TICKETS: join(home, 'fake-acli-tickets.json'),
    QUE_FAKE_OPEN_LOG: join(home, 'fake-open.log'),
    QUE_FAKE_WRAPPER_LOG: join(home, 'fake-wrapper.log'),
    GIT_CONFIG_GLOBAL: join(home, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1'
  }
}

/** Writes <home>/gitconfig: the identity `que <name>`, unsigned commits, main as the default branch. */
exports.writeGitconfig = function writeGitconfig(home, name) {
  writeFileSync(
    join(home, 'gitconfig'),
    `[user]\n\tname = que ${name}\n\temail = ${name}@que.invalid\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n`
  )
}
