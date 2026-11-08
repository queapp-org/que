import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeBackgroundTask, makeWorkspace } from '../testing/fixtures'
import { MIGRATIONS, Store } from './store'

let store: Store

beforeEach(() => {
  store = new Store(':memory:')
  store.insertProject({
    id: 'prj_01hzw7q2m4nb',
    name: 'uploader',
    path: '/Users/dev/src/uploader',
    defaultBranch: 'main',
    createdAt: '2026-10-13T21:00:00.000Z'
  })
})

afterEach(() => {
  store.close()
})

describe('migrations', () => {
  it('drops the retired tasks table from a database the previous release wrote, keeping its workspaces', () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'que-store-'))
    const path = join(dir, 'que.db')
    const previous = new DatabaseSync(path)
    previous.exec('CREATE TABLE migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')

    const dropTasks = MIGRATIONS.findIndex((sql) => sql.includes('DROP TABLE IF EXISTS tasks'))

    MIGRATIONS.slice(0, dropTasks).forEach((sql, i) => {
      previous.exec(sql)
      previous
        .prepare('INSERT INTO migrations (version, applied_at) VALUES (?, ?)')
        .run(i + 1, '2026-10-19T21:00:00.000Z')
    })

    previous.exec(`
      INSERT INTO projects (id, name, path, default_branch, created_at)
        VALUES ('prj_01hzw7q2m4nb', 'uploader', '/Users/dev/src/uploader', 'main', '2026-10-13T21:00:00.000Z');
      INSERT INTO workspaces (id, project_id, name, branch, path, base_ref, status, status_at, created_at)
        VALUES ('ws_01hzx3k9c2qf', 'prj_01hzw7q2m4nb', 'APP-1432-retry-logic', 'APP-1432-retry-logic',
          '/Users/dev/.que/worktrees/uploader/APP-1432-retry-logic', 'main', 'idle',
          '2026-10-13T21:05:00.000Z', '2026-10-13T21:05:00.000Z');
      INSERT INTO tasks (id, project_id, workspace_id, title, brief, source, state, max_turns,
          max_budget_usd, pr_url, created_at, updated_at)
        VALUES ('task-01hzy8m3p5rd', 'prj_01hzw7q2m4nb', 'ws_01hzx3k9c2qf', 'Retry uploads on 503',
          'Retry uploads on 503 with backoff', 'prompt', 'done', 40, 5,
          'https://github.com/rquellh/uploader/pull/12', '2026-10-13T21:10:00.000Z',
          '2026-10-14T03:00:00.000Z');
      INSERT INTO kv (key, value) VALUES
        ('queue.open', '1'),
        ('queue.opened_at', '2026-10-13T22:00:00.000Z'),
        ('concurrency', '3'),
        ('tickets.last_sync_at', '2026-10-14T08:00:00.000Z');
    `)

    previous.close()

    const reopened = new Store(path)

    const tasksTable = reopened.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tasks'`)
      .get()

    const kept = {
      workspace: reopened.getWorkspace('ws_01hzx3k9c2qf')?.name,
      queueOpen: reopened.getKv('queue.open'),
      queueOpenedAt: reopened.getKv('queue.opened_at'),
      concurrency: reopened.getKv('concurrency'),
      lastSync: reopened.getKv('tickets.last_sync_at')
    }

    reopened.close()
    fs.rmSync(dir, { recursive: true, force: true })

    expect(tasksTable).toBeUndefined()
    expect(kept).toEqual({
      workspace: 'APP-1432-retry-logic',
      queueOpen: undefined,
      queueOpenedAt: undefined,
      concurrency: undefined,
      lastSync: '2026-10-14T08:00:00.000Z'
    })
  })
})

describe('migrations to the session pull requests', () => {
  it('carries the pull request a workspace recorded into its list, and leaves its branches to be seeded', () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'que-store-'))
    const path = join(dir, 'que.db')
    const previous = new DatabaseSync(path)
    previous.exec('CREATE TABLE migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')

    const prUrls = MIGRATIONS.findIndex((sql) => sql.includes('pr_urls_json'))

    MIGRATIONS.slice(0, prUrls).forEach((sql, i) => {
      previous.exec(sql)
      previous
        .prepare('INSERT INTO migrations (version, applied_at) VALUES (?, ?)')
        .run(i + 1, '2026-10-26T21:00:00.000Z')
    })

    previous.exec(`
      INSERT INTO projects (id, name, path, default_branch, created_at)
        VALUES ('prj_01hzw7q2m4nb', 'uploader', '/Users/dev/src/uploader', 'main', '2026-10-13T21:00:00.000Z');
      INSERT INTO workspaces (id, project_id, name, branch, path, base_ref, status, status_at, created_at, pr_url)
        VALUES ('ws_01hzx3k9c2qf', 'prj_01hzw7q2m4nb', 'APP-1432-retry-logic', 'APP-1432-retry-logic',
          '/Users/dev/.que/worktrees/uploader/APP-1432-retry-logic', 'main', 'idle',
          '2026-10-13T21:05:00.000Z', '2026-10-13T21:05:00.000Z', 'https://github.com/rquellh/uploader/pull/12'),
        ('ws_01hzx4m1p8rt', 'prj_01hzw7q2m4nb', 'APP-1440-quiet-board', 'APP-1440-quiet-board',
          '/Users/dev/.que/worktrees/uploader/APP-1440-quiet-board', 'main', 'idle',
          '2026-10-13T21:06:00.000Z', '2026-10-13T21:06:00.000Z', NULL);
    `)

    previous.close()

    const reopened = new Store(path)

    const read = (id: string) => {
      const ws = reopened.getWorkspace(id)

      return { prUrls: ws?.prUrls, branches: ws?.branches }
    }

    const kept = [read('ws_01hzx3k9c2qf'), read('ws_01hzx4m1p8rt')]
    reopened.close()
    fs.rmSync(dir, { recursive: true, force: true })

    expect(kept).toEqual([
      { prUrls: ['https://github.com/rquellh/uploader/pull/12'], branches: [] },
      { prUrls: [], branches: [] }
    ])
  })
})

describe('created pull requests', () => {
  it('appends each new one once, oldest first', () => {
    const ws = makeWorkspace({ id: 'ws_01hzx3k9c2qf' })
    store.insertWorkspace(ws)

    expect(store.addWorkspacePrUrls(ws.id, ['https://github.com/rquellh/uploader/pull/12'])).toBe(
      true
    )
    expect(
      store.addWorkspacePrUrls(ws.id, [
        'https://github.com/rquellh/uploader/pull/12',
        'https://github.com/rquellh/uploader/pull/15',
        'https://github.com/rquellh/uploader/pull/15'
      ])
    ).toBe(true)
    expect(store.addWorkspacePrUrls(ws.id, ['https://github.com/rquellh/uploader/pull/15'])).toBe(
      false
    )
    expect(store.getWorkspace(ws.id)?.prUrls).toEqual([
      'https://github.com/rquellh/uploader/pull/12',
      'https://github.com/rquellh/uploader/pull/15'
    ])
  })
})

describe('migration to published pages', () => {
  it('reads a workspace stored before the list as having none', () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'que-store-'))
    const path = join(dir, 'que.db')
    const previous = new DatabaseSync(path)
    previous.exec('CREATE TABLE migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')

    const artifacts = MIGRATIONS.findIndex((sql) => sql.includes('artifacts_json'))

    MIGRATIONS.slice(0, artifacts).forEach((sql, i) => {
      previous.exec(sql)
      previous
        .prepare('INSERT INTO migrations (version, applied_at) VALUES (?, ?)')
        .run(i + 1, '2026-11-03T21:00:00.000Z')
    })

    previous.exec(`
      INSERT INTO projects (id, name, path, default_branch, created_at)
        VALUES ('prj_01hzw7q2m4nb', 'uploader', '/Users/dev/src/uploader', 'main', '2026-10-13T21:00:00.000Z');
      INSERT INTO workspaces (id, project_id, name, branch, path, base_ref, status, status_at, created_at)
        VALUES ('ws_01hzx3k9c2qf', 'prj_01hzw7q2m4nb', 'APP-1432-retry-logic', 'APP-1432-retry-logic',
          '/Users/dev/.que/worktrees/uploader/APP-1432-retry-logic', 'main', 'idle',
          '2026-10-13T21:05:00.000Z', '2026-10-13T21:05:00.000Z');
    `)

    previous.close()

    const reopened = new Store(path)
    const kept = reopened.getWorkspace('ws_01hzx3k9c2qf')?.artifacts
    reopened.close()
    fs.rmSync(dir, { recursive: true, force: true })

    expect(kept).toEqual([])
  })
})

describe('published pages', () => {
  const ID = 'ws_01hzx3k9c2qf'
  const PAGE = 'https://claude.ai/artifact/Bo2pUji8XumREbCYMXcoMe'
  const OTHER = 'https://claude.ai/code/artifact/5TzMcQgtfF2RmJrrpX3D7m'
  const T1 = '2026-10-13T21:05:00.000Z'
  const T2 = '2026-10-13T21:06:00.000Z'
  const T3 = '2026-10-13T21:07:00.000Z'

  const artifacts = () => store.getWorkspace(ID)?.artifacts

  beforeEach(() => {
    store.insertWorkspace(makeWorkspace({ id: ID }))
  })

  it('adds a new page at the front, unopened', () => {
    expect(store.publishWorkspaceArtifact(ID, PAGE, 'Upload retries', T1)).toBe(true)
    expect(store.publishWorkspaceArtifact(ID, OTHER, 'Backoff notes', T2)).toBe(true)

    expect(artifacts()).toEqual([
      { url: OTHER, title: 'Backoff notes', updatedAt: T2, openedAt: null },
      { url: PAGE, title: 'Upload retries', updatedAt: T1, openedAt: null }
    ])
  })

  it('updates a known page in place: new title and time, at the front, unopened again', () => {
    store.publishWorkspaceArtifact(ID, PAGE, 'Upload retries', T1)
    store.publishWorkspaceArtifact(ID, OTHER, 'Backoff notes', T1)
    store.markWorkspaceArtifactOpened(ID, PAGE, T2)

    expect(store.publishWorkspaceArtifact(ID, PAGE, 'Upload retries, second draft', T3)).toBe(true)

    expect(artifacts()).toEqual([
      { url: PAGE, title: 'Upload retries, second draft', updatedAt: T3, openedAt: null },
      { url: OTHER, title: 'Backoff notes', updatedAt: T1, openedAt: null }
    ])
  })

  it('removes a page by URL, true only when it was listed', () => {
    store.publishWorkspaceArtifact(ID, PAGE, 'Upload retries', T1)
    store.publishWorkspaceArtifact(ID, OTHER, 'Backoff notes', T2)

    expect(store.removeWorkspaceArtifact(ID, PAGE)).toBe(true)
    expect(store.removeWorkspaceArtifact(ID, PAGE)).toBe(false)

    expect(artifacts()).toEqual([
      { url: OTHER, title: 'Backoff notes', updatedAt: T2, openedAt: null }
    ])
  })

  it('marks a page opened by URL, and an unknown URL changes nothing', () => {
    store.publishWorkspaceArtifact(ID, PAGE, 'Upload retries', T1)
    store.publishWorkspaceArtifact(ID, OTHER, 'Backoff notes', T1)

    expect(store.markWorkspaceArtifactOpened(ID, PAGE, T2)).toBe(true)
    expect(store.markWorkspaceArtifactOpened(ID, 'https://claude.ai/artifact/gone', T3)).toBe(false)

    expect(artifacts()).toEqual([
      { url: OTHER, title: 'Backoff notes', updatedAt: T1, openedAt: null },
      { url: PAGE, title: 'Upload retries', updatedAt: T1, openedAt: T2 }
    ])
  })

  it('keeps the newest 50', () => {
    for (let i = 0; i < 52; i++) {
      store.publishWorkspaceArtifact(ID, `https://claude.ai/artifact/page${i}`, `Page ${i}`, T1)
    }

    const urls = artifacts()?.map((a) => a.url)
    expect(urls).toHaveLength(50)
    expect(urls?.[0]).toBe('https://claude.ai/artifact/page51')
    expect(urls?.at(-1)).toBe('https://claude.ai/artifact/page2')
  })

  it('drops a malformed or bad-URL stored entry when reading', () => {
    const good = { url: PAGE, title: 'Upload retries', updatedAt: T1, openedAt: null }
    const opened = { url: OTHER, title: 'Backoff notes', updatedAt: T1, openedAt: T2 }

    store.db
      .prepare('UPDATE workspaces SET artifacts_json = ? WHERE id = ?')
      .run(
        JSON.stringify([
          good,
          'https://claude.ai/artifact/just-a-string',
          { ...good, url: 'javascript:alert(1)' },
          { ...good, url: 7 },
          { ...good, title: '' },
          { ...good, updatedAt: undefined },
          { ...good, openedAt: 1793839146 },
          opened
        ]),
        ID
      )

    expect(artifacts()).toEqual([good, opened])
  })

  it('reads a stored value that is not a list as none', () => {
    store.db.prepare('UPDATE workspaces SET artifacts_json = ? WHERE id = ?').run('{not json', ID)

    expect(artifacts()).toEqual([])
  })

  it('changes nothing for a workspace it does not have', () => {
    expect(store.publishWorkspaceArtifact('ws_01hzxnope000', PAGE, 'Upload retries', T1)).toBe(
      false
    )
  })
})

describe('hook events', () => {
  it('keeps the newest 500 per workspace and leaves other workspaces alone', () => {
    for (let i = 0; i < 503; i++) {
      store.insertHookEvent(
        'ws_01hzx3k9c2qf',
        null,
        'PostToolUse',
        { i },
        '2026-10-13T21:05:00.000Z'
      )
    }

    store.insertHookEvent('ws_01hzx7m1p0aa', null, 'Stop', {}, '2026-10-13T21:05:00.000Z')

    const kept = store.listHookEvents('ws_01hzx3k9c2qf')

    expect(kept).toHaveLength(500)
    expect(JSON.parse(kept[0].payload)).toEqual({ i: 3 })
    expect(JSON.parse(kept[499].payload)).toEqual({ i: 502 })
    expect(store.listHookEvents('ws_01hzx7m1p0aa')).toHaveLength(1)
  })
})

describe('workspaces', () => {
  it('reads a title source a retired release wrote as unset', () => {
    const ws = makeWorkspace({ title: 'Retry logic for the uploader', titleSource: 'brief' })
    store.insertWorkspace(ws)
    store.db.exec(`UPDATE workspaces SET title_source = 'summary'`)

    const read = store.getWorkspace(ws.id)

    expect(read).toMatchObject({ title: 'Retry logic for the uploader' })
    expect(read?.titleSource).toBeUndefined()
  })

  it('lists the ids of unarchived workspaces with a stored status', () => {
    const working = makeWorkspace({ status: 'working' })
    const idle = makeWorkspace({ status: 'idle' })
    const archived = makeWorkspace({ status: 'working', archivedAt: '2026-10-13T22:00:00.000Z' })

    for (const w of [working, idle, archived]) store.insertWorkspace(w)

    expect(store.listWorkspaceIdsByStatus('working')).toEqual([working.id])
  })

  it('reads back the background tasks a status update wrote, and none after an empty one', () => {
    const ws = makeWorkspace({ status: 'working' })
    store.insertWorkspace(ws)

    const update = {
      status: 'working' as const,
      reason: null,
      at: '2026-10-20T14:02:00.000Z',
      lastActivityAt: '2026-10-20T14:02:00.000Z',
      sessionId: 'sess_9d41c7'
    }

    const tasks = [
      makeBackgroundTask({ kind: 'subagent', description: 'Explore the repo' }),
      makeBackgroundTask()
    ]

    expect(store.getWorkspace(ws.id)?.backgroundTasks).toEqual([])

    store.updateStatus(ws.id, { ...update, backgroundTasks: tasks })

    expect(store.getWorkspace(ws.id)?.backgroundTasks).toEqual(tasks)

    store.updateStatus(ws.id, { ...update, status: 'idle', backgroundTasks: [] })

    expect(store.getWorkspace(ws.id)?.backgroundTasks).toEqual([])
  })

  it.each([
    ['not JSON', '{oops'],
    ['not a list', '{"id":"b1"}'],
    ['a list of malformed entries', '[{"id":"b1"},"b2",null]']
  ])('reads a stored background list that is %s as none', (_label, json) => {
    const ws = makeWorkspace()
    store.insertWorkspace(ws)
    store.db.prepare('UPDATE workspaces SET background_json = ? WHERE id = ?').run(json, ws.id)

    expect(store.getWorkspace(ws.id)?.backgroundTasks).toEqual([])
  })
})
