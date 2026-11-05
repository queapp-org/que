// Decodes each method's params from the JSON a client sent. The daemon runs
// these before a handler sees anything, so a handler works with typed values.
// Free of node modules so the renderer can import it too.
import { decodeHookEvent } from './hook.decode'
import { isObj } from './json.decode'
import { decodeUsage } from './usage.decode'
import type { MethodName, ParamsOf } from './protocol'
import type { ConfigPatch } from './types'

/** Thrown for params that are missing or have the wrong type; the daemon answers `bad_request`. */
export class ParamsError extends Error {}

type Params = Record<string, unknown> | undefined

/** Reads `key` and checks it with `test`; otherwise throws `<key> must be <what>`. */
function field<T>(p: Params, key: string, test: (v: unknown) => v is T, what: string): T {
  const v = p?.[key]

  if (!test(v)) throw new ParamsError(`${key} must be ${what}`)

  return v
}

/** A reader that also takes an absent (undefined or null) parameter as undefined. */
function opt<T>(p: Params, key: string, read: (p: Params, key: string) => T): T | undefined {
  return p?.[key] === undefined || p[key] === null ? undefined : read(p, key)
}

const isString = (v: unknown): v is string => typeof v === 'string'

const isBool = (v: unknown): v is boolean => typeof v === 'boolean'

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
/** A size or count: a finite number of at least 1. */

const isPositive = (v: unknown): v is number => isNumber(v) && v >= 1

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString)

const str = (p: Params, key: string): string => field(p, key, isString, 'a string')

const num = (p: Params, key: string): number => field(p, key, isPositive, 'a positive number')

const optString = (p: Params, key: string): string | undefined => opt(p, key, str)

const bool = (p: Params, key: string): boolean => field(p, key, isBool, 'a boolean')

const optBool = (p: Params, key: string): boolean | undefined => opt(p, key, bool)

const optNumber = (p: Params, key: string): number | undefined =>
  opt(p, key, (q, k) => field(q, k, isNumber, 'a number'))

const optStringArray = (p: Params, key: string): string[] | undefined =>
  opt(p, key, (q, k) => field(q, k, isStringArray, 'an array of strings'))

const none = (): undefined => undefined

const idOnly = (p: Params): { id: string } => ({ id: str(p, 'id') })

/** One decoder per method; the mapped type makes a missing or extra one a compile error. */
export const decoders: { [M in MethodName]: (p: Params) => ParamsOf<M> } = {
  'daemon.ping': none,
  'daemon.shutdown': none,
  'daemon.handoff': (p) => ({ script: optString(p, 'script'), runtime: optString(p, 'runtime') }),
  'term.create': (p) => ({
    cwd: optString(p, 'cwd'),
    cols: num(p, 'cols'),
    rows: num(p, 'rows'),
    name: optString(p, 'name'),
    file: optString(p, 'file'),
    args: optStringArray(p, 'args')
  }),
  'term.list': (p) => ({ workspaceId: optString(p, 'workspaceId') }),
  'term.attach': (p) => ({ id: str(p, 'id'), cols: num(p, 'cols'), rows: num(p, 'rows') }),
  'term.detach': idOnly,
  'term.write': (p) => ({ id: str(p, 'id'), data: str(p, 'data') }),
  'term.resize': (p) => ({ id: str(p, 'id'), cols: num(p, 'cols'), rows: num(p, 'rows') }),
  'term.kill': idOnly,
  'term.snapshot': idOnly,
  'project.add': (p) => ({
    path: optString(p, 'path'),
    repo: optString(p, 'repo'),
    cwd: optString(p, 'cwd'),
    name: optString(p, 'name')
  }),
  'project.list': none,
  'project.remove': (p) => ({ id: str(p, 'id'), force: optBool(p, 'force') }),
  'workspace.create': (p) => ({
    projectId: str(p, 'projectId'),
    name: optString(p, 'name'),
    title: optString(p, 'title'),
    brief: optString(p, 'brief'),
    baseRef: optString(p, 'baseRef'),
    branch: optString(p, 'branch')
  }),
  'workspace.prepare': (p) => ({
    projectId: str(p, 'projectId'),
    name: optString(p, 'name'),
    title: optString(p, 'title'),
    brief: optString(p, 'brief'),
    baseRef: optString(p, 'baseRef'),
    branch: optString(p, 'branch'),
    start: optBool(p, 'start')
  }),
  'workspace.list': (p) => ({ projectId: optString(p, 'projectId') }),
  'workspace.get': idOnly,
  'workspace.remove': (p) => ({ id: str(p, 'id'), deleteBranch: bool(p, 'deleteBranch') }),
  'workspace.openTerminal': (p) => ({
    id: str(p, 'id'),
    cols: num(p, 'cols'),
    rows: num(p, 'rows')
  }),
  'workspace.start': (p) => ({
    id: str(p, 'id'),
    cols: optNumber(p, 'cols'),
    rows: optNumber(p, 'rows')
  }),
  'workspace.rename': (p) => ({
    id: str(p, 'id'),
    title: str(p, 'title'),
    branch: optString(p, 'branch')
  }),
  'workspace.canRenameBranch': idOnly,
  'workspace.seen': idOnly,
  'workspace.artifactOpened': (p) => ({ id: str(p, 'id'), url: str(p, 'url') }),
  'workspace.diff': (p) => ({
    id: str(p, 'id'),
    base: optString(p, 'base'),
    head: optString(p, 'head'),
    commit: optString(p, 'commit')
  }),
  'workspace.diffFile': (p) => {
    const asked = optString(p, 'whitespace')
    const whitespace = asked === 'show' || asked === 'ignore' ? asked : undefined

    if (asked !== undefined && whitespace === undefined) {
      throw new ParamsError("whitespace must be 'show' or 'ignore'")
    }

    return {
      id: str(p, 'id'),
      path: str(p, 'path'),
      base: optString(p, 'base'),
      head: optString(p, 'head'),
      commit: optString(p, 'commit'),
      whitespace
    }
  },
  'workspace.prThread': (p) => ({
    id: str(p, 'id'),
    number: num(p, 'number'),
    refresh: optBool(p, 'refresh')
  }),
  'workspace.checkPrs': idOnly,
  'workspace.files': idOnly,
  'workspace.readFile': (p) => ({ id: str(p, 'id'), path: str(p, 'path') }),
  'workspace.watch': idOnly,
  'workspace.unwatch': idOnly,
  'hook.event': (p) => {
    const workspaceId = optString(p, 'workspaceId')
    const terminalId = optString(p, 'terminalId')
    const payload = decodeHookEvent(p?.payload)

    if (!payload) throw new ParamsError('payload must be a hook event')

    if (workspaceId !== undefined) return { workspaceId, terminalId, payload }

    // A loose terminal's hook names its terminal instead.
    if (terminalId === undefined) throw new ParamsError('workspaceId or terminalId is required')

    return { terminalId, payload }
  },
  'report.get': (p) => ({ since: optString(p, 'since') }),
  'quiet.state': none,
  'quiet.unlock': (p) => ({ minutes: optNumber(p, 'minutes'), why: optString(p, 'why') }),
  'quiet.lock': none,
  'quiet.start': (p) => ({ minutes: optNumber(p, 'minutes') }),
  'quiet.end': none,
  'quiet.log': (p) => ({ since: optString(p, 'since') }),
  'usage.report': (p) => {
    const usage = decodeUsage(p)

    if (!usage) throw new ParamsError('at must be a number')

    return usage
  },
  'usage.get': none,
  'config.get': none,
  'config.set': (p) => {
    // The shape of the patch is checked where it is merged into the file.
    const patch = field(p, 'patch', isObj, 'an object')

    return { patch: patch as ConfigPatch, applyTonight: optBool(p, 'applyTonight') }
  },
  'instructions.get': none,
  'instructions.set': (p) => ({ content: str(p, 'content') }),
  'tickets.list': none,
  'tickets.sync': none,
  'tickets.start': (p) => ({
    key: str(p, 'key'),
    projectId: optString(p, 'projectId'),
    session: optBool(p, 'session')
  }),
  'tickets.projectFor': (p) => ({ key: str(p, 'key') })
}
