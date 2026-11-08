import os from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  combineConfigPatches,
  defaultJira,
  mergeConfigPatch,
  parseConfig,
  parseConfigAssignment,
  parseRepoConfig,
  patchToToml,
  parseWorktreeInclude,
  resolvePermissionMode,
  stringifyConfig
} from './config'

const env = { queHome: '/Users/dev/.que' }

describe('parseConfig', () => {
  it('falls back to the defaults for an empty file', () => {
    expect(parseConfig('', env)).toEqual({
      ok: true,
      config: {
        worktreeRoot: '/Users/dev/.que/worktrees',
        stallTimeoutMinutes: 5,
        teardownTimeoutSeconds: 60,
        statusPollSeconds: 10,
        prPollSeconds: 60,
        repos: {},
        defaultPermissionMode: undefined,
        allowBypassPermissions: false,
        protectedBranches: ['main', 'master', 'release'],
        quietHours: {
          enabled: true,
          default: { start: '19:00', end: '07:00' },
          days: {},
          unlockMinutes: 20
        },
        notifications: {
          chimeOnComplete: true,
          chimeOnNeedsInput: false,
          chimeInManualQuiet: false,
          morningSummary: false
        },
        terminal: { optionAsMeta: true },
        jira: defaultJira(),
        startPrompt: ''
      }
    })
  })

  it('reads every field, the repo registry, and ignores unknown keys', () => {
    const r = parseConfig(
      `worktree_root = "/Volumes/work/trees"
stall_timeout_minutes = 0.5
teardown_timeout_seconds = 5
status_poll_seconds = 30
theme = "dark"
default_permission_mode = "plan"
allow_bypass_permissions = true
protected_branches = ["main", "production"]
start_prompt = "Read .que/brief.md and ask before editing."
# A key from an older release: read without an error.
summaries = false

[terminal]
option_as_meta = false

[repos.uploader]
path = "/Users/dev/code/uploader"
default_branch = "develop"

[repos.api]
path = "/Users/dev/code/api"
`,
      env
    )

    expect(r).toEqual({
      ok: true,
      config: {
        worktreeRoot: '/Volumes/work/trees',
        stallTimeoutMinutes: 0.5,
        teardownTimeoutSeconds: 5,
        statusPollSeconds: 30,
        prPollSeconds: 60,
        repos: {
          uploader: { path: '/Users/dev/code/uploader', defaultBranch: 'develop' },
          api: { path: '/Users/dev/code/api', defaultBranch: undefined }
        },
        defaultPermissionMode: 'plan',
        allowBypassPermissions: true,
        protectedBranches: ['main', 'production'],
        quietHours: expect.objectContaining({ enabled: true }),
        notifications: expect.objectContaining({ chimeOnComplete: true }),
        terminal: { optionAsMeta: false },
        jira: defaultJira(),
        startPrompt: 'Read .que/brief.md and ask before editing.'
      }
    })
  })

  it('reads a file that still sets the retired queue keys, without an error or those fields', () => {
    const r = parseConfig(
      `concurrency = 3
max_turns = 80
max_budget_usd = 12.5
stall_timeout_minutes = 8
`,
      env
    )

    expect(r).toMatchObject({ ok: true, config: { stallTimeoutMinutes: 8 } })
    expect(r.ok && r.config).not.toHaveProperty('concurrency')
    expect(r.ok && r.config).not.toHaveProperty('maxTurns')
    expect(r.ok && r.config).not.toHaveProperty('maxBudgetUsd')
  })

  describe('quiet hours and notifications', () => {
    it('reads the window, per-weekday overrides, fractional unlock minutes and the toggles', () => {
      const r = parseConfig(
        `[quiet_hours]
enabled = true
default = ["20:30", "06:45"]
monday = ["21:00", "06:30"]
saturday = "none"
unlock_minutes = 0.05

[notifications]
chime_on_complete = false
chime_on_needs_input = true
chime_in_manual_quiet = true
morning_summary = true
`,
        env
      )

      expect(r.ok && r.config.quietHours).toEqual({
        enabled: true,
        default: { start: '20:30', end: '06:45' },
        days: { monday: { start: '21:00', end: '06:30' }, saturday: 'none' },
        unlockMinutes: 0.05
      })
      expect(r.ok && r.config.notifications).toEqual({
        chimeOnComplete: false,
        chimeOnNeedsInput: true,
        chimeInManualQuiet: true,
        morningSummary: true
      })
    })

    it('reports bad times, an empty window, unknown days and bad toggles by key', () => {
      const r = parseConfig(
        `[quiet_hours]
default = ["7pm", "07:00"]
tuesday = ["22:00", "22:00"]
wednesday = ["25:00", "06:00"]
thursday = "off"
caturday = "none"
unlock_minutes = 0

[notifications]
chime_on_complete = "yes"

[terminal]
option_as_meta = "no"
`,
        env
      )

      expect(r).toEqual({
        ok: false,
        errors: [
          { key: 'quiet_hours.caturday', message: 'is not a quiet_hours key' },
          { key: 'quiet_hours.default', message: '7pm is not a 24-hour HH:MM time' },
          { key: 'quiet_hours.unlock_minutes', message: 'must be a positive number' },
          { key: 'quiet_hours.tuesday', message: 'start and end must differ' },
          { key: 'quiet_hours.wednesday', message: '25:00 is not a 24-hour HH:MM time' },
          { key: 'quiet_hours.thursday', message: 'must be ["HH:MM", "HH:MM"] (start, end)' },
          { key: 'notifications.chime_on_complete', message: 'must be true or false' },
          { key: 'terminal.option_as_meta', message: 'must be true or false' }
        ]
      })
    })
  })

  it('reports each invalid value by key', () => {
    const r = parseConfig(
      `stall_timeout_minutes = -1
teardown_timeout_seconds = 0.5
status_poll_seconds = "often"
[repos.uploader]
default_branch = "main"
`,
      env
    )

    expect(r).toEqual({
      ok: false,
      errors: [
        { key: 'stall_timeout_minutes', message: 'must be a positive number' },
        { key: 'teardown_timeout_seconds', message: 'must be a number of at least 1' },
        { key: 'status_poll_seconds', message: 'must be a positive number' },
        { key: 'repos.uploader.path', message: 'is required' }
      ]
    })
  })

  it('reports bad permission, branch and prompt settings by key', () => {
    const r = parseConfig(
      `default_permission_mode = "yolo"
allow_bypass_permissions = "yes"
protected_branches = "main"
start_prompt = 3
`,
      env
    )

    expect(r).toEqual({
      ok: false,
      errors: [
        {
          key: 'default_permission_mode',
          message: 'must be one of default, acceptEdits, plan, bypassPermissions, dontAsk, auto'
        },
        { key: 'allow_bypass_permissions', message: 'must be true or false' },
        { key: 'protected_branches', message: 'must be a list of strings' },
        { key: 'start_prompt', message: 'must be a string' }
      ]
    })
  })

  describe('instructions_file', () => {
    it('reads an absolute path as is', () => {
      const r = parseConfig('instructions_file = "/Users/dev/notes/delegation.md"', env)
      expect(r).toMatchObject({
        ok: true,
        config: { instructionsFile: '/Users/dev/notes/delegation.md' }
      })
    })

    it('expands a leading ~ to the home directory', () => {
      const r = parseConfig('instructions_file = "~/.config/que/instructions.md"', env)
      expect(r).toMatchObject({
        ok: true,
        config: { instructionsFile: join(os.homedir(), '.config/que/instructions.md') }
      })
    })

    it('treats an empty string as unset', () => {
      const r = parseConfig('instructions_file = ""', env)
      expect(r.ok).toBe(true)
      expect(r.ok && r.config.instructionsFile).toBeUndefined()
    })

    it('reports a value that is not a string by key', () => {
      expect(parseConfig('instructions_file = 3', env)).toEqual({
        ok: false,
        errors: [{ key: 'instructions_file', message: 'must be a path' }]
      })
    })

    it('round-trips through a `que config set` patch', () => {
      const patch = parseConfigAssignment('instructions_file=~/notes/delegation.md')
      expect(patch).toEqual({ instructionsFile: '~/notes/delegation.md' })

      const merged = mergeConfigPatch({ stall_timeout_minutes: 3 }, patchToToml(patch))
      expect(parseConfig(stringifyConfig(merged), env)).toMatchObject({
        ok: true,
        config: {
          stallTimeoutMinutes: 3,
          instructionsFile: join(os.homedir(), 'notes/delegation.md')
        }
      })

      const removed = mergeConfigPatch(
        merged,
        patchToToml(parseConfigAssignment('instructions_file=null'))
      )

      expect(removed).toEqual({ stall_timeout_minutes: 3 })
    })
  })

  describe('editor_app', () => {
    it('reads an application by its absolute path, dropping a trailing slash', () => {
      expect(parseConfig('editor_app = "/Applications/Editor.app"', env)).toMatchObject({
        ok: true,
        config: { editorApp: '/Applications/Editor.app' }
      })
      expect(
        parseConfig('editor_app = " /Users/dev/Applications/Editor.app/ "', env)
      ).toMatchObject({ ok: true, config: { editorApp: '/Users/dev/Applications/Editor.app' } })
    })

    it('treats an empty string as unset', () => {
      const r = parseConfig('editor_app = ""', env)

      expect(r.ok).toBe(true)
      expect(r.ok && r.config.editorApp).toBeUndefined()
    })

    it('reports a relative path, a path that is not an application, or a non-string by key', () => {
      for (const value of ['"Applications/Editor.app"', '"/usr/local/bin/editor"', '3']) {
        expect(parseConfig(`editor_app = ${value}`, env)).toEqual({
          ok: false,
          errors: [
            { key: 'editor_app', message: 'must be an absolute path to an application (.app)' }
          ]
        })
      }
    })

    it('round-trips through `que config set`, and null removes it', () => {
      const patch = parseConfigAssignment('editor_app=/Applications/Editor.app')
      expect(patch).toEqual({ editorApp: '/Applications/Editor.app' })

      const merged = mergeConfigPatch({}, patchToToml(patch))
      expect(merged).toEqual({ editor_app: '/Applications/Editor.app' })
      expect(parseConfig(stringifyConfig(merged), env)).toMatchObject({
        ok: true,
        config: { editorApp: '/Applications/Editor.app' }
      })
      expect(
        mergeConfigPatch(merged, patchToToml(parseConfigAssignment('editor_app=null')))
      ).toEqual({})
    })
  })

  it('reads an empty or blank start_prompt as off, and round-trips it', () => {
    for (const text of ['start_prompt = ""\n', 'start_prompt = "  "\n']) {
      const r = parseConfig(text, env)
      expect(r.ok && r.config.startPrompt).toBe('')
    }

    const set = parseConfig('start_prompt = "Read .que/brief.md first."\n', env)
    expect(set.ok && set.config.startPrompt).toBe('Read .que/brief.md first.')
    const again = parseConfig(stringifyConfig({ start_prompt: '' }), env)
    expect(again.ok && again.config.startPrompt).toBe('')
  })

  it('reports a TOML syntax error without a key', () => {
    const r = parseConfig('stall_timeout_minutes = = 3', env)

    expect(r.ok).toBe(false)
    expect(!r.ok && r.errors[0].key).toBe('')
  })
})

describe('parseRepoConfig', () => {
  it('reads setup, teardown, default branch, and worktree_include merged with .worktreeinclude', () => {
    const r = parseRepoConfig(
      `setup = "npm ci"
teardown = "docker compose down"
default_branch = "trunk"
worktree_include = [".env", "config/local"]
permission_mode = "bypassPermissions"
`,
      '# local secrets\n.env\n\n.npmrc\n'
    )

    expect(r).toEqual({
      ok: true,
      config: {
        setup: 'npm ci',
        teardown: 'docker compose down',
        defaultBranch: 'trunk',
        worktreeInclude: ['.env', 'config/local', '.npmrc'],
        permissionMode: 'bypassPermissions'
      }
    })
  })

  it('reads a que.toml that still sets the retired task keys, without an error or those fields', () => {
    const r = parseRepoConfig(
      `setup = "npm ci"
instructions = "Follow docs/STYLE.md."
test = "npm test"
allowed_tools = ["Bash(npm test)", "Edit"]
`
    )

    expect(r).toEqual({ ok: true, config: { setup: 'npm ci', worktreeInclude: [] } })
  })

  it('rejects a worktree_include that is not a list of strings', () => {
    expect(parseRepoConfig('worktree_include = ".env"')).toEqual({
      ok: false,
      errors: [{ key: 'worktree_include', message: 'must be a list of strings' }]
    })
  })
})

describe('resolvePermissionMode', () => {
  const user = { defaultPermissionMode: undefined, allowBypassPermissions: false }

  it('prefers que.toml, then the user default, then acceptEdits', () => {
    expect(
      resolvePermissionMode(
        { permissionMode: 'plan' },
        { ...user, defaultPermissionMode: 'default' }
      ).mode
    ).toBe('plan')
    expect(resolvePermissionMode({}, { ...user, defaultPermissionMode: 'default' }).mode).toBe(
      'default'
    )
    expect(resolvePermissionMode({}, user)).toEqual({ mode: 'acceptEdits', warning: null })
  })

  it('honours bypassPermissions only when the repo sets it and the user allows it', () => {
    expect(
      resolvePermissionMode(
        { permissionMode: 'bypassPermissions' },
        { ...user, allowBypassPermissions: true }
      )
    ).toEqual({ mode: 'bypassPermissions', warning: null })
  })

  it.each([
    [
      'the repo asks but the user has not allowed it',
      { permissionMode: 'bypassPermissions' as const },
      user
    ],
    [
      'only the user default asks for it',
      {},
      { defaultPermissionMode: 'bypassPermissions' as const, allowBypassPermissions: true }
    ]
  ])('downgrades to acceptEdits with a warning when %s', (_, repo, config) => {
    const r = resolvePermissionMode(repo, config)

    expect(r.mode).toBe('acceptEdits')
    expect(r.warning).toContain('allow_bypass_permissions')
  })
})

describe('parseWorktreeInclude', () => {
  it('keeps one path per line, skipping blanks and comments', () => {
    expect(parseWorktreeInclude('.env\n  # comment\n\n  .env.local  \n')).toEqual([
      '.env',
      '.env.local'
    ])
  })
})

describe('config patches', () => {
  it('deep-merges a patch into the file table, removing keys set to null, without mutating it', () => {
    const raw = {
      stall_timeout_minutes: 2,
      quiet_hours: { enabled: true, default: ['19:00', '07:00'], saturday: 'none' },
      repos: { uploader: { path: '/Users/dev/code/uploader' } }
    }

    const before = structuredClone(raw)

    const merged = mergeConfigPatch(raw, {
      stall_timeout_minutes: 4,
      quiet_hours: { default: ['20:00', '06:00'], saturday: null, monday: ['21:00', '06:30'] }
    })

    expect(merged).toEqual({
      stall_timeout_minutes: 4,
      quiet_hours: { enabled: true, default: ['20:00', '06:00'], monday: ['21:00', '06:30'] },
      repos: { uploader: { path: '/Users/dev/code/uploader' } }
    })
    expect(raw).toEqual(before)
    expect(parseConfig(stringifyConfig(merged), env)).toMatchObject({
      ok: true,
      config: {
        stallTimeoutMinutes: 4,
        quietHours: {
          default: { start: '20:00', end: '06:00' },
          days: { monday: expect.any(Object) }
        }
      }
    })
  })

  it('reads `que config set` assignments: dotted keys, booleans, numbers, lists and null', () => {
    expect(parseConfigAssignment('quiet_hours.default=19:30,07:15')).toEqual({
      quietHours: { default: { start: '19:30', end: '07:15' } }
    })
    expect(parseConfigAssignment('notifications.chime_on_complete=false')).toEqual({
      notifications: { chimeOnComplete: false }
    })
    expect(parseConfigAssignment('terminal.option_as_meta=false')).toEqual({
      terminal: { optionAsMeta: false }
    })
    expect(parseConfigAssignment('quiet_hours.unlock_minutes=0.5')).toEqual({
      quietHours: { unlockMinutes: 0.5 }
    })
    expect(parseConfigAssignment('protected_branches=production')).toEqual({
      protectedBranches: ['production']
    })
    expect(parseConfigAssignment('quiet_hours.saturday=none')).toEqual({
      quietHours: { days: { saturday: 'none' } }
    })
    expect(parseConfigAssignment('quiet_hours.saturday=null')).toEqual({
      quietHours: { days: { saturday: null } }
    })
    expect(parseConfigAssignment('quiet_hours.monday=21:00,06:30')).toEqual({
      quietHours: { days: { monday: { start: '21:00', end: '06:30' } } }
    })
    expect(parseConfigAssignment('jira.projects.APP=uploader')).toEqual({
      jira: { projects: { APP: 'uploader' } }
    })
    expect(parseConfigAssignment('repos.uploader.default_branch=develop')).toEqual({
      repos: { uploader: { defaultBranch: 'develop' } }
    })
    expect(() => parseConfigAssignment('stall_timeout_minutes')).toThrow('expected key=value')
  })

  it('refuses an assignment to a key the config does not have, or a window of the wrong shape', () => {
    expect(() => parseConfigAssignment('concurency=3')).toThrow('unknown config key "concurency"')
    expect(() => parseConfigAssignment('quiet_hours.nope=3')).toThrow(
      'unknown config key "quiet_hours.nope"'
    )
    expect(() => parseConfigAssignment('quiet_hours.default=19:00')).toThrow(
      'quiet_hours.default: must be ["HH:MM", "HH:MM"] (start, end)'
    )
  })

  it('refuses the retired queue keys as unknown', () => {
    expect(() => parseConfigAssignment('concurrency=3')).toThrow('unknown config key "concurrency"')
    expect(() => parseConfigAssignment('max_turns=80')).toThrow('unknown config key "max_turns"')
    expect(() => parseConfigAssignment('max_budget_usd=5')).toThrow(
      'unknown config key "max_budget_usd"'
    )
  })

  it('combines assignments, the later winning key by key', () => {
    const patch = [
      'quiet_hours.unlock_minutes=15',
      'quiet_hours.enabled=false',
      'quiet_hours.unlock_minutes=30'
    ]
      .map(parseConfigAssignment)
      .reduce(combineConfigPatches)

    expect(patch).toEqual({ quietHours: { unlockMinutes: 30, enabled: false } })
  })
})

describe('patchToToml', () => {
  it('writes top-level settings under the file key names', () => {
    expect(
      patchToToml({
        stallTimeoutMinutes: 8,
        protectedBranches: ['main', 'hotfix'],
        instructionsFile: '~/notes/delegation.md',
        startPrompt: 'Plan first.',
        allowBypassPermissions: true
      })
    ).toEqual({
      stall_timeout_minutes: 8,
      protected_branches: ['main', 'hotfix'],
      instructions_file: '~/notes/delegation.md',
      start_prompt: 'Plan first.',
      allow_bypass_permissions: true
    })
  })

  it('writes quiet hours with windows as [start, end] and weekday overrides beside them', () => {
    expect(
      patchToToml({
        quietHours: {
          enabled: false,
          default: { start: '20:00', end: '06:00' },
          unlockMinutes: 30,
          days: { saturday: 'none', monday: { start: '21:00', end: '06:30' }, friday: null }
        }
      })
    ).toEqual({
      quiet_hours: {
        enabled: false,
        default: ['20:00', '06:00'],
        unlock_minutes: 30,
        saturday: 'none',
        monday: ['21:00', '06:30'],
        friday: null
      }
    })
  })

  it('writes notifications and the ticket settings', () => {
    expect(
      patchToToml({
        notifications: { chimeOnComplete: false, chimeOnNeedsInput: true, morningSummary: false },
        jira: {
          jql: 'assignee = currentUser()',
          pollMinutes: 10,
          site: null,
          startPrompt: 'Read .que/ticket.md',
          projects: { APP: 'uploader', OLD: null }
        }
      })
    ).toEqual({
      notifications: {
        chime_on_complete: false,
        chime_on_needs_input: true,
        morning_summary: false
      },
      jira: {
        jql: 'assignee = currentUser()',
        poll_minutes: 10,
        site: null,
        start_prompt: 'Read .que/ticket.md',
        projects: { APP: 'uploader', OLD: null }
      }
    })
  })

  it('writes a repo entry, and a removed entry as null', () => {
    expect(
      patchToToml({
        repos: {
          uploader: { path: '/Users/dev/code/uploader', defaultBranch: 'develop' },
          old: null
        }
      })
    ).toEqual({
      repos: {
        uploader: { path: '/Users/dev/code/uploader', default_branch: 'develop' },
        old: null
      }
    })
  })

  it('keeps null as a removal when merged into the file, and leaves other keys alone', () => {
    const file = {
      stall_timeout_minutes: 2,
      instructions_file: '/Users/dev/notes.md',
      quiet_hours: { enabled: true, saturday: 'none' },
      repos: { uploader: { path: '/Users/dev/code/uploader' }, old: { path: '/Users/dev/old' } }
    }

    const merged = mergeConfigPatch(
      file,
      patchToToml({
        instructionsFile: null,
        quietHours: { days: { saturday: null } },
        repos: { old: null }
      })
    )

    expect(merged).toEqual({
      stall_timeout_minutes: 2,
      quiet_hours: { enabled: true },
      repos: { uploader: { path: '/Users/dev/code/uploader' } }
    })
  })

  it('names a key a patch does not have', () => {
    expect(() => patchToToml({ concurency: 3 } as never)).toThrow('unknown config key "concurency"')
    expect(() => patchToToml({ jira: { jqll: 'x' } } as never)).toThrow(
      'unknown config key "jira.jqll"'
    )
    expect(() => patchToToml({ quietHours: { days: { someday: 'none' } } } as never)).toThrow(
      'unknown config key "quietHours.days.someday"'
    )
  })

  it('produces a file that reads back as the config the patch described', () => {
    const file = patchToToml({
      stallTimeoutMinutes: 4,
      quietHours: { default: { start: '20:00', end: '06:00' }, days: { monday: 'none' } },
      jira: { projects: { APP: 'uploader' } },
      repos: { uploader: { path: '/Users/dev/code/uploader', defaultBranch: 'develop' } }
    })

    expect(parseConfig(stringifyConfig(file), env)).toMatchObject({
      ok: true,
      config: {
        stallTimeoutMinutes: 4,
        quietHours: { default: { start: '20:00', end: '06:00' }, days: { monday: 'none' } },
        jira: { projects: { APP: 'uploader' } },
        repos: { uploader: { path: '/Users/dev/code/uploader', defaultBranch: 'develop' } }
      }
    })
  })
})
