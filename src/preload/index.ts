import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { QueApi, UpdateStatus } from './index.d'

type Reply = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } }

async function call<T>(method: string, params?: unknown): Promise<T> {
  return unwrap<T>(ipcRenderer.invoke('que:request', method, params))
}

/** A main-process reply as a value, or an Error carrying its code. */
async function unwrap<T>(pending: Promise<unknown>): Promise<T> {
  const reply = (await pending) as Reply

  if (reply.ok) return reply.result as T
  const err = new Error(reply.error.message) as Error & { code?: string }
  err.code = reply.error.code
  throw err
}

/** The subscriptions per event name, fed by the one `que:event` listener below. */
const subscriptions = new Map<string, Set<(data: unknown) => void>>()

ipcRenderer.on('que:event', (_e: IpcRendererEvent, name: string, data: unknown) => {
  const subs = subscriptions.get(name)

  // A copy, so one unsubscribing (or subscribing) mid-dispatch changes only the next event's list.
  if (subs) for (const deliver of [...subs]) deliver(data)
})

function subscribe(event: string, cb: (data: unknown) => void): () => void {
  // A fresh entry per call, so the same callback subscribed twice is called twice.
  const deliver = (data: unknown): void => cb(data)
  let subs = subscriptions.get(event)

  if (!subs) {
    subs = new Set()
    subscriptions.set(event, subs)
  }

  subs.add(deliver)

  return () => {
    subs.delete(deliver)

    if (subs.size === 0 && subscriptions.get(event) === subs) subscriptions.delete(event)
  }
}

const api: QueApi = {
  term: {
    create: (p) => call('term.create', p),
    list: (p) => call('term.list', p),
    attach: (p) => call('term.attach', p),
    detach: (p) => call('term.detach', p),
    write: (p) => ipcRenderer.send('que:write', p.id, p.data),
    resize: (p) => call('term.resize', p),
    kill: (p) => call('term.kill', p),
    snapshot: (p) => call('term.snapshot', p),
    on: (event, cb) => subscribe(event, cb as (data: unknown) => void),
    onDisconnect: (cb) => subscribe('daemon.disconnected', cb)
  },
  project: {
    add: (p) => call('project.add', p),
    list: () => call('project.list'),
    remove: (p) => call('project.remove', p),
    on: (event, cb) => subscribe(event, cb as (data: unknown) => void)
  },
  quiet: {
    state: () => call('quiet.state'),
    unlock: (p) => call('quiet.unlock', p),
    lock: () => call('quiet.lock'),
    start: (p) => call('quiet.start', p),
    end: () => call('quiet.end'),
    log: (p) => call('quiet.log', p),
    on: (event, cb) => subscribe(event, cb as (data: unknown) => void)
  },
  usage: {
    get: () => call('usage.get'),
    on: (event, cb) => subscribe(event, cb as (data: unknown) => void)
  },
  config: {
    get: () => call('config.get'),
    set: (p) => call('config.set', p),
    on: (event, cb) => subscribe(event, cb as (data: unknown) => void)
  },
  instructions: {
    get: () => call('instructions.get'),
    set: (p) => call('instructions.set', p)
  },
  workspace: {
    prepare: (p) => call('workspace.prepare', p),
    list: (p) => call('workspace.list', p),
    get: (p) => call('workspace.get', p),
    remove: (p) => call('workspace.remove', p),
    openTerminal: (p) => call('workspace.openTerminal', p),
    rename: (p) => call('workspace.rename', p),
    canRenameBranch: (p) => call('workspace.canRenameBranch', p),
    seen: (p) => call('workspace.seen', p),
    diff: (p) => call('workspace.diff', p),
    diffFile: (p) => call('workspace.diffFile', p),
    prThread: (p) => call('workspace.prThread', p),
    checkPrs: (p) => call('workspace.checkPrs', p),
    files: (p) => call('workspace.files', p),
    readFile: (p) => call('workspace.readFile', p),
    watch: (p) => call('workspace.watch', p),
    unwatch: (p) => call('workspace.unwatch', p),
    on: (event, cb) => subscribe(event, cb as (data: unknown) => void)
  },
  report: {
    get: (p) => call('report.get', p)
  },
  tickets: {
    list: () => call('tickets.list'),
    sync: () => call('tickets.sync'),
    start: (p) => call('tickets.start', p),
    projectFor: (p) => call('tickets.projectFor', p),
    on: (event, cb) => subscribe(event, cb as (data: unknown) => void)
  },
  app: {
    homedir: () => ipcRenderer.invoke('app:homedir'),
    openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
    openInEditor: (p) => ipcRenderer.invoke('app:openInEditor', p.path),
    openSetupLog: (p) => unwrap(ipcRenderer.invoke('app:openSetupLog', p.id)),
    trayTitle: () => ipcRenderer.invoke('app:trayTitle'),
    updateStatus: () => ipcRenderer.invoke('app:updateStatus'),
    onUpdateStatus: (cb) => {
      const listener = (_e: IpcRendererEvent, status: UpdateStatus): void => cb(status)
      ipcRenderer.on('que:updateStatus', listener)

      return () => ipcRenderer.removeListener('que:updateStatus', listener)
    },
    checkForUpdate: () => ipcRenderer.invoke('app:checkForUpdate'),
    openUpdate: () => ipcRenderer.invoke('app:openUpdate'),
    e2e: process.argv.includes('--que-e2e')
  },
  daemon: {
    state: () => unwrap(ipcRenderer.invoke('daemon:state')),
    upgrade: () => unwrap(ipcRenderer.invoke('daemon:upgrade')),
    onReconnected: (cb) => subscribe('daemon.reconnected', cb as (data: unknown) => void)
  }
}

contextBridge.exposeInMainWorld('que', api)
