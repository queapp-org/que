// The one table of config key names: the camelCase names a UserConfig and a
// ConfigPatch use, against the snake_case keys of the config file, as a single
// schema tree. Both directions walk it (a patch to the file's table, a
// `que config set` key to a patch path). No Node imports, so the renderer's
// fake bridge can use it.
import { isTable } from './config-patch.decode'
import { type ConfigPatch, type JsonValue, WEEKDAYS, type Weekday } from './types'

/** A table of the config file, as the merge reads it. */
type TomlTable = Record<string, JsonValue>

interface Node {
  /** The key in the file's table. Unused on an `entries` node, which is named by its entry. */
  file: string
  /** A plain value, a quiet-hours window (`{ start, end }` in a patch, `[start, end]` in the file), or a table. */
  kind: 'value' | 'window' | 'table'
  /** Written into the parent's table instead of a table of its own (weekday overrides sit in `[quiet_hours]`). */
  inline?: true
  /** Fixed children, by patch name. */
  keys?: Record<string, Node>
  /** The child every other name gets (a repo, a ticket project key). */
  entries?: Node
}

const value = (file: string): Node => ({ file, kind: 'value' })
const window = (file: string): Node => ({ file, kind: 'window' })

/** A table whose fixed children are exactly the keys of the patch section `T`. */
const section = <T>(file: string, keys: Record<keyof T, Node>): Node => ({
  file,
  kind: 'table',
  keys: keys as Record<string, Node>
})

const SCHEMA: Node = section<ConfigPatch>('', {
  worktreeRoot: value('worktree_root'),
  stallTimeoutMinutes: value('stall_timeout_minutes'),
  teardownTimeoutSeconds: value('teardown_timeout_seconds'),
  statusPollSeconds: value('status_poll_seconds'),
  prPollSeconds: value('pr_poll_seconds'),
  defaultPermissionMode: value('default_permission_mode'),
  allowBypassPermissions: value('allow_bypass_permissions'),
  protectedBranches: value('protected_branches'),
  instructionsFile: value('instructions_file'),
  editorApp: value('editor_app'),
  startPrompt: value('start_prompt'),
  repos: {
    file: 'repos',
    kind: 'table',
    entries: section<NonNullable<NonNullable<ConfigPatch['repos']>[string]>>('', {
      path: value('path'),
      defaultBranch: value('default_branch')
    })
  },
  quietHours: section<NonNullable<ConfigPatch['quietHours']>>('quiet_hours', {
    enabled: value('enabled'),
    default: window('default'),
    unlockMinutes: value('unlock_minutes'),
    days: {
      file: '',
      kind: 'table',
      inline: true,
      keys: Object.fromEntries(WEEKDAYS.map((d) => [d, window(d)])) as Record<Weekday, Node>
    }
  }),
  notifications: section<NonNullable<ConfigPatch['notifications']>>('notifications', {
    chimeOnComplete: value('chime_on_complete'),
    chimeOnNeedsInput: value('chime_on_needs_input'),
    chimeInManualQuiet: value('chime_in_manual_quiet'),
    morningSummary: value('morning_summary')
  }),
  terminal: section<NonNullable<ConfigPatch['terminal']>>('terminal', {
    optionAsMeta: value('option_as_meta')
  }),
  jira: section<NonNullable<ConfigPatch['jira']>>('jira', {
    jql: value('jql'),
    pollMinutes: value('poll_minutes'),
    site: value('site'),
    startPrompt: value('start_prompt'),
    projects: { file: 'projects', kind: 'table', entries: value('') }
  })
})

function unknownKey(key: string): Error {
  return new Error(`unknown config key ${JSON.stringify(key)}`)
}

/** `{ start, end }` as the file's `["start", "end"]`; anything else is left for validation to refuse. */
function windowToToml(v: unknown): JsonValue {
  if (isTable(v) && typeof v.start === 'string' && typeof v.end === 'string') {
    return [v.start, v.end]
  }

  return v as JsonValue
}

function toToml(v: unknown, node: Node, path: string): JsonValue {
  if (node.kind === 'window') return windowToToml(v)

  // A value, or a table named as a whole (null, which the merge reads as a removal).
  if (node.kind === 'value' || !isTable(v)) return v as JsonValue
  const out: TomlTable = {}

  for (const [k, x] of Object.entries(v)) {
    if (x === undefined) continue
    const fixed = node.keys !== undefined && Object.hasOwn(node.keys, k)
    const child = fixed ? node.keys![k] : node.entries
    const at = path ? `${path}.${k}` : k

    if (!child) throw unknownKey(at)

    if (child.inline) {
      if (!isTable(x)) throw unknownKey(at)
      Object.assign(out, toToml(x, child, at) as TomlTable)
    } else out[fixed ? child.file : k] = toToml(x, child, at)
  }

  return out
}

/**
 * A typed patch as a patch of the config file's table (snake_case keys, windows
 * as `[start, end]`, weekday overrides inside `[quiet_hours]`), ready for
 * `mergeConfigPatch`. `null` stays `null`, which the merge reads as a removal.
 * Throws on a key a patch does not have.
 */
export function patchToToml(patch: ConfigPatch): TomlTable {
  return toToml(patch, SCHEMA, '') as TomlTable
}

/** Where a file key leads: the patch path it stands for, and the node there. */
interface Hit {
  path: string[]
  node: Node
}

/** Each table node's children by file key, inline children folded in. Built once. */
const BY_FILE = new Map<Node, Map<string, Hit>>()

function index(node: Node): void {
  const hits = new Map<string, Hit>()

  const add = (path: string[], child: Node): void => {
    if (child.inline) {
      for (const [name, c] of Object.entries(child.keys ?? {})) add([...path, name], c)
    } else hits.set(child.file, { path, node: child })
  }

  for (const [name, child] of Object.entries(node.keys ?? {})) add([name], child)
  BY_FILE.set(node, hits)

  for (const child of [...Object.values(node.keys ?? {}), node.entries]) {
    if (child) index(child)
  }
}

index(SCHEMA)

/**
 * The patch path (`['quietHours', 'unlockMinutes']`) of a dotted key as the file
 * spells it (`quiet_hours.unlock_minutes`), and whether it holds a quiet-hours
 * window. Throws on a key the config has no place for.
 */
export function patchPathOf(key: string): { path: string[]; window: boolean } {
  let node = SCHEMA
  const path: string[] = []
  let named = false

  for (const part of key.split('.')) {
    const hit = BY_FILE.get(node)?.get(part)

    if (hit) {
      path.push(...hit.path)
      node = hit.node
      named = false
    } else if (node.entries) {
      path.push(part)
      node = node.entries
      named = true
    } else throw unknownKey(key)
  }

  // A section as a whole has no key of its own; a named entry (a repo) does.
  if (node.kind === 'table' && !named) throw unknownKey(key)

  return { path, window: node.kind === 'window' }
}
