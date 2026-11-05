// Published pages over the real socket: the fake claude reports Artifact calls through the real
// `que hook`, in a real workspace terminal, and the daemon keeps Workspace.artifacts. What a hook
// counts as a publish or a delete is artifacts.decode.test.ts's; the list's rules are store.test.ts's.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DaemonClient } from '@shared/client'
import {
  recordEvents,
  runClaude,
  startTestDaemon,
  type TestDaemon,
  waitForStatus
} from '../../src/testing/daemon-harness'
import { makeTempRepo } from '../../src/testing/temp-repo'

const PAGE = 'https://claude.ai/artifact/Bo2pUji8XumREbCYMXcoMe'
const OTHER_PAGE = 'https://claude.ai/code/artifact/5TzMcQgtfF2RmJrrpX3D7m'
const opts = { timeout: 15_000 }

let daemon: TestDaemon
let client: DaemonClient

beforeEach(async () => {
  daemon = await startTestDaemon()
  client = daemon.client
})

afterEach(async () => {
  await daemon.close()
})

/** A workspace with the fake claude running in its terminal; `type` is a line typed into it. */
async function session() {
  const project = await client.request('project.add', { path: makeTempRepo(daemon.home) })

  const ws = await client.request('workspace.create', {
    projectId: project.id,
    name: 'app-1432-retry-logic'
  })

  await waitForStatus(daemon, ws.id, 'idle')
  const { term } = await runClaude(daemon, ws.id)

  return {
    id: ws.id,
    type: (line: string) => client.request('term.write', { id: term, data: `${line}\r` })
  }
}

const artifactsOf = async (id: string) => (await client.request('workspace.get', { id })).artifacts

/** What a workspace lists, as url and title. */
const listed = async (id: string) => (await artifactsOf(id)).map((a) => [a.url, a.title])

describe('published pages', () => {
  it('records a publish, announces it, and keeps one row per URL with the newest on top', async () => {
    const { id, type } = await session()
    const updates = recordEvents(client, 'workspace.updated')

    await type(`/artifact ${PAGE} Upload retries`)

    await expect.poll(() => listed(id), opts).toEqual([[PAGE, 'Upload retries']])
    const [first] = await artifactsOf(id)
    expect(first.openedAt).toBeNull()
    expect(updates.map((w) => w.artifacts)).toContainEqual([first])

    await type(`/artifact ${PAGE} Upload retries, second draft`)

    await expect.poll(() => listed(id), opts).toEqual([[PAGE, 'Upload retries, second draft']])
    expect((await artifactsOf(id))[0].updatedAt).not.toBe(first.updatedAt)

    await type(`/artifact ${OTHER_PAGE} Backoff notes`)

    await expect
      .poll(() => listed(id), opts)
      .toEqual([
        [OTHER_PAGE, 'Backoff notes'],
        [PAGE, 'Upload retries, second draft']
      ])
  }, 40_000)

  it('adds nothing for a read', async () => {
    const { id, type } = await session()

    // The fake runs its hooks in order, so the publish's row comes after the read was handled.
    await type(`/artifact read ${PAGE}`)
    await type(`/artifact ${OTHER_PAGE} Backoff notes`)

    await expect.poll(() => listed(id), opts).toEqual([[OTHER_PAGE, 'Backoff notes']])
  }, 40_000)

  it('drops a deleted page', async () => {
    const { id, type } = await session()
    await type(`/artifact ${PAGE} Upload retries`)
    await type(`/artifact ${OTHER_PAGE} Backoff notes`)
    await expect.poll(async () => (await listed(id)).length, opts).toBe(2)

    await type(`/artifact delete ${PAGE}`)

    await expect.poll(() => listed(id), opts).toEqual([[OTHER_PAGE, 'Backoff notes']])
  }, 40_000)

  it('keeps the list across a daemon restart', async () => {
    const { id, type } = await session()
    await type(`/artifact ${PAGE} Upload retries`)
    await expect.poll(() => listed(id), opts).toEqual([[PAGE, 'Upload retries']])
    const before = await artifactsOf(id)

    await daemon.close({ keepHome: true })
    daemon = await startTestDaemon({ home: daemon.home })
    client = daemon.client

    expect(await artifactsOf(id)).toEqual(before)
  }, 40_000)
})

describe('workspace.artifactOpened', () => {
  it('sets openedAt, announces it, and the next publish clears it', async () => {
    const { id, type } = await session()
    await type(`/artifact ${PAGE} Upload retries`)
    await expect.poll(() => listed(id), opts).toEqual([[PAGE, 'Upload retries']])
    const updates = recordEvents(client, 'workspace.updated')

    const opened = await client.request('workspace.artifactOpened', { id, url: PAGE })

    expect(opened.artifacts[0].openedAt).toMatch(/^\d{4}-\d\d-\d\dT/)
    expect(updates).toContainEqual(opened)
    expect(await artifactsOf(id)).toEqual(opened.artifacts)

    await type(`/artifact ${PAGE} Upload retries, second draft`)

    await expect
      .poll(() => artifactsOf(id), opts)
      .toEqual([expect.objectContaining({ title: 'Upload retries, second draft', openedAt: null })])
  }, 40_000)

  it('changes nothing for a URL the workspace does not list, and refuses an unknown workspace', async () => {
    const { id, type } = await session()
    await type(`/artifact ${PAGE} Upload retries`)
    await expect.poll(() => listed(id), opts).toEqual([[PAGE, 'Upload retries']])
    const before = await artifactsOf(id)

    const answered = await client.request('workspace.artifactOpened', { id, url: OTHER_PAGE })

    expect(answered.artifacts).toEqual(before)
    await expect(
      client.request('workspace.artifactOpened', { id: 'ws_01hzxnope000', url: PAGE })
    ).rejects.toMatchObject({ code: 'not_found' })
  }, 40_000)
})
