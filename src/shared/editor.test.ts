// openWithEditor against the fake `open` first on PATH: what it runs, and the
// sentences it rejects with.
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FAKES_BIN, readFakeLog } from '../testing/fakes'
import { openWithEditor } from './editor'

let dir: string
let app: string
let openLog: string
const workspace = '/Users/dev/.que/worktrees/uploader/app-1432-retry-logic'

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'que-editor-')))
  app = join(dir, 'Editor.app')
  fs.mkdirSync(app)
  openLog = join(dir, 'open.log')
  vi.stubEnv('PATH', `${FAKES_BIN}:${process.env.PATH}`)
  vi.stubEnv('QUE_FAKE_OPEN_LOG', openLog)
})

afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('openWithEditor', () => {
  it('opens the folder in the app with open -a', async () => {
    await openWithEditor(app, workspace)

    expect(readFakeLog(openLog).map((c) => c.argv)).toEqual([['-a', app, workspace]])
  })

  it('names the app and points to Settings when it is no longer there, running nothing', async () => {
    fs.rmSync(app, { recursive: true })

    await expect(openWithEditor(app, workspace)).rejects.toThrow(
      `Editor is no longer at ${app}. Choose another editor in que's Settings.`
    )
    expect(readFakeLog(openLog)).toEqual([])
  })

  it('says why open failed, from its first line of stderr', async () => {
    vi.stubEnv('QUE_FAKE_OPEN_FAIL', 'Unable to find application named Editor')

    await expect(openWithEditor(app, workspace)).rejects.toThrow(
      `Could not open ${workspace} in Editor: Unable to find application named Editor`
    )
  })
})
