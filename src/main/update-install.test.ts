import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateInstall } from '../shared/types'
import {
  RESTART_MARKER_MAX_AGE_MS,
  restartMarkerPath,
  shouldHandOffAtLaunch,
  takeRestartMarker,
  UpdateInstaller,
  type Updater,
  writeRestartMarker
} from './update-install'

type Found = Awaited<ReturnType<Updater['checkForUpdates']>>

const FOUND: Found = { isUpdateAvailable: true, updateInfo: { version: '0.5.0' } }

/** Stands in for the updater library; each step does what the test says, then answers. */
class FakeUpdater extends EventEmitter implements Updater {
  autoDownload = true
  autoInstallOnAppQuit = true
  allowPrerelease = true
  allowDowngrade = true
  checks = 0
  downloads = 0
  installs = 0
  /** The settings as they were when the first check ran. */
  settingsAtCheck: Record<string, boolean> | null = null

  constructor(
    private readonly steps: {
      check?: (u: FakeUpdater) => Found
      download?: (u: FakeUpdater) => void
      install?: (u: FakeUpdater) => void
    } = {}
  ) {
    super()
  }

  async checkForUpdates(): Promise<Found> {
    this.checks++
    this.settingsAtCheck ??= {
      autoDownload: this.autoDownload,
      autoInstallOnAppQuit: this.autoInstallOnAppQuit,
      allowPrerelease: this.allowPrerelease,
      allowDowngrade: this.allowDowngrade
    }

    return this.steps.check ? this.steps.check(this) : FOUND
  }

  async downloadUpdate(): Promise<string[]> {
    this.downloads++
    this.steps.download?.(this)

    return []
  }

  quitAndInstall(): void {
    this.installs++
    this.steps.install?.(this)
  }
}

let home: string
let markerPath: string

beforeEach(() => {
  home = fs.mkdtempSync(join(os.tmpdir(), 'que-install-'))
  markerPath = restartMarkerPath(home)
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

function installerWith(
  updater: Updater,
  opts: { now?: () => number; markerPath?: string; onNoUpdate?: () => void } = {}
): { installer: UpdateInstaller; changes: UpdateInstall[] } {
  const changes: UpdateInstall[] = []

  const installer = new UpdateInstaller({
    load: async () => updater,
    markerPath,
    onChange: (install) => changes.push(install),
    ...opts
  })

  return { installer, changes }
}

/** An installer whose release is downloaded and waiting for Restart. */
async function readyInstaller(
  updater: FakeUpdater,
  opts: { now?: () => number; markerPath?: string } = {}
): Promise<{ installer: UpdateInstaller; changes: UpdateInstall[] }> {
  const made = installerWith(updater, opts)
  await made.installer.start()
  expect(made.installer.state).toEqual({ phase: 'ready', version: '0.5.0' })

  return made
}

describe('UpdateInstaller', () => {
  describe('downloading', () => {
    it('starts idle and leaves the library alone until asked', () => {
      const load = vi.fn<() => Promise<Updater>>(async () => new FakeUpdater())

      const installer = new UpdateInstaller({ load, markerPath, onChange: () => {} })

      expect(installer.state).toEqual({ phase: 'idle' })
      expect(load).not.toHaveBeenCalled()
    })

    it('downloads on its own terms: no auto download, no install on quit, no prereleases, no downgrades', async () => {
      const updater = new FakeUpdater()
      const { installer } = installerWith(updater)

      await installer.start()

      expect(updater.settingsAtCheck).toEqual({
        autoDownload: false,
        autoInstallOnAppQuit: false,
        allowPrerelease: false,
        allowDowngrade: false
      })
    })

    it('goes from idle through whole percents to ready with the version found', async () => {
      const updater = new FakeUpdater({
        download: (u) => {
          u.emit('download-progress', { percent: 41.7 })
          u.emit('download-progress', { percent: 41.9 })
          u.emit('download-progress', { percent: 100 })
        }
      })

      const { installer, changes } = installerWith(updater)

      await installer.start()

      expect(changes).toEqual([
        { phase: 'downloading', percent: 0 },
        { phase: 'downloading', percent: 41 },
        { phase: 'downloading', percent: 100 },
        { phase: 'ready', version: '0.5.0' }
      ])
    })

    it('ignores a percent that is no number, and keeps one in range', async () => {
      const updater = new FakeUpdater({
        download: (u) => {
          u.emit('download-progress', { percent: Number.NaN })
          u.emit('download-progress', { percent: 120 })
        }
      })

      const { installer, changes } = installerWith(updater)

      await installer.start()

      expect(changes).toEqual([
        { phase: 'downloading', percent: 0 },
        { phase: 'downloading', percent: 100 },
        { phase: 'ready', version: '0.5.0' }
      ])
    })

    it('takes no second start while downloading or once ready', async () => {
      const updater = new FakeUpdater()
      const { installer } = installerWith(updater)

      const first = installer.start()
      await installer.start()
      await first
      await installer.start()

      expect(updater.checks).toBe(1)
      expect(updater.downloads).toBe(1)
      expect(installer.state).toEqual({ phase: 'ready', version: '0.5.0' })
    })
  })

  describe('nothing to download', () => {
    it.each<[string, Found]>([
      [
        'a check that finds nothing newer',
        { isUpdateAvailable: false, updateInfo: FOUND!.updateInfo }
      ],
      ['an inactive updater', null]
    ])(
      '%s fails in words, not stuck on downloading, and asks for the check again',
      async (_, found) => {
        const onNoUpdate = vi.fn<() => void>()
        const updater = new FakeUpdater({ check: () => found })
        const { installer } = installerWith(updater, { onNoUpdate })

        await installer.start()

        expect(installer.state).toEqual({
          phase: 'failed',
          message: 'que found no newer release to download. It may have been withdrawn.'
        })
        expect(updater.downloads).toBe(0)
        expect(onNoUpdate).toHaveBeenCalledOnce()
      }
    )
  })

  describe('errors', () => {
    it('says why a check failed, reported as an event first and then as a rejection, once', async () => {
      const updater = new FakeUpdater({
        check: (u) => {
          const err = new Error('404 Not Found\nHeaders: {"server":"GitHub.com"}')
          u.emit('error', err)
          throw err
        }
      })

      const { installer, changes } = installerWith(updater)

      await expect(installer.start()).resolves.toBeUndefined()

      expect(changes).toEqual([
        { phase: 'downloading', percent: 0 },
        {
          phase: 'failed',
          message:
            "Couldn't download the update: 404 Not Found. Settings > Updates links to the release page."
        }
      ])
      expect(updater.downloads).toBe(0)
    })

    it('says plainly when there is no connection', async () => {
      const updater = new FakeUpdater({
        download: () => {
          throw new Error('net::ERR_INTERNET_DISCONNECTED')
        }
      })

      const { installer } = installerWith(updater)

      await installer.start()

      expect(installer.state).toEqual({
        phase: 'failed',
        message:
          "Couldn't download the update: no connection to GitHub. Settings > Updates links to the release page."
      })
    })

    it('fails in words when the library itself cannot load', async () => {
      const installer = new UpdateInstaller({
        load: async () => {
          throw new Error("Cannot find module 'electron-updater'")
        },
        markerPath,
        onChange: () => {}
      })

      await expect(installer.start()).resolves.toBeUndefined()

      expect(installer.state).toEqual({
        phase: 'failed',
        message:
          "Couldn't download the update: Cannot find module 'electron-updater'. Settings > Updates links to the release page."
      })
    })

    it('tries again from failed', async () => {
      let attempts = 0

      const updater = new FakeUpdater({
        download: () => {
          attempts++

          if (attempts === 1) throw new Error('sha512 checksum mismatch')
        }
      })

      const { installer } = installerWith(updater)
      await installer.start()
      expect(installer.state.phase).toBe('failed')

      await installer.start()

      expect(installer.state).toEqual({ phase: 'ready', version: '0.5.0' })
      expect(updater.downloads).toBe(2)
    })

    it('ignores a stray error with nothing under way', async () => {
      const updater = new FakeUpdater()
      const { installer } = await readyInstaller(updater)

      updater.emit('error', new Error('a late complaint'))

      expect(installer.state).toEqual({ phase: 'ready', version: '0.5.0' })
    })
  })

  describe('restart', () => {
    it('does nothing until ready: no marker, no install', async () => {
      const updater = new FakeUpdater()
      const { installer } = installerWith(updater)

      installer.restart()

      expect(installer.state).toEqual({ phase: 'idle' })
      expect(fs.existsSync(markerPath)).toBe(false)
      expect(updater.installs).toBe(0)
    })

    it('has the marker on disk by the time it installs', async () => {
      const at = new Date(2026, 10, 3, 14, 20).getTime()
      let markerAtInstall: unknown = null

      const updater = new FakeUpdater({
        install: () => {
          markerAtInstall = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
        }
      })

      const { installer } = await readyInstaller(updater, { now: () => at })

      installer.restart()

      expect(markerAtInstall).toEqual({ at })
      expect(updater.installs).toBe(1)
      expect(installer.state).toEqual({ phase: 'installing', version: '0.5.0' })
    })

    it('takes no second click while the install is under way', async () => {
      const updater = new FakeUpdater()
      const { installer } = await readyInstaller(updater)

      installer.restart()
      installer.restart()

      expect(updater.installs).toBe(1)
    })

    it('installs even when the marker cannot be written: Restart still appears after', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      fs.writeFileSync(join(home, 'state'), 'a file where the directory should be')
      const updater = new FakeUpdater()
      const { installer } = await readyInstaller(updater, { markerPath })

      installer.restart()

      expect(updater.installs).toBe(1)
      expect(error).toHaveBeenCalledOnce()
      error.mockRestore()
    })

    it.each<[string, (u: FakeUpdater) => void]>([
      [
        'an error event',
        (u) => {
          u.emit('error', new Error('Could not get code signature for running application'))
        }
      ],
      [
        'a throw',
        () => {
          throw new Error('Could not get code signature for running application')
        }
      ]
    ])('a failed install, by %s, fails in words and takes the marker back', async (_, install) => {
      const updater = new FakeUpdater({ install })
      const { installer } = await readyInstaller(updater)

      installer.restart()

      expect(installer.state).toEqual({
        phase: 'failed',
        message:
          "Couldn't install the update: Could not get code signature for running application. Settings > Updates links to the release page."
      })
      expect(fs.existsSync(markerPath)).toBe(false)
    })

    it('a failure the system reports later, after the click returned, does the same', async () => {
      const updater = new FakeUpdater()
      const { installer } = await readyInstaller(updater)
      installer.restart()
      expect(fs.existsSync(markerPath)).toBe(true)

      updater.emit('error', new Error('The update could not be verified'))

      expect(installer.state.phase).toBe('failed')
      expect(fs.existsSync(markerPath)).toBe(false)
    })
  })
})

describe('shouldHandOffAtLaunch', () => {
  const NOW = new Date(2026, 10, 3, 14, 20).getTime()

  it('hands off after a recent clicked Restart with the daemon on an older build', () => {
    expect(shouldHandOffAtLaunch({ at: NOW - 60_000 }, NOW, true)).toBe(true)
  })

  it('leaves an upgrade installed by hand to its own Restart: no marker', () => {
    expect(shouldHandOffAtLaunch(null, NOW, true)).toBe(false)
  })

  it('has nothing to do when the daemon already runs this build', () => {
    expect(shouldHandOffAtLaunch({ at: NOW - 60_000 }, NOW, false)).toBe(false)
  })

  it('stands for ten minutes and no longer', () => {
    expect(shouldHandOffAtLaunch({ at: NOW - RESTART_MARKER_MAX_AGE_MS }, NOW, true)).toBe(true)
    expect(shouldHandOffAtLaunch({ at: NOW - RESTART_MARKER_MAX_AGE_MS - 1 }, NOW, true)).toBe(
      false
    )
  })

  it('ignores a marker from the future: the clock moved, so the age means nothing', () => {
    expect(shouldHandOffAtLaunch({ at: NOW + 1 }, NOW, true)).toBe(false)
  })
})

describe('takeRestartMarker', () => {
  it('reads the marker and removes it', () => {
    writeRestartMarker(markerPath, { at: 1_700_000_000_000 })

    expect(takeRestartMarker(markerPath)).toEqual({ at: 1_700_000_000_000 })
    expect(fs.existsSync(markerPath)).toBe(false)
  })

  it('answers null without one', () => {
    expect(takeRestartMarker(markerPath)).toBeNull()
  })

  it.each([
    ['not JSON', 'nonsense'],
    ['no time', '{"version":"0.5.0"}']
  ])('removes a marker that is %s, and answers null', (_, content) => {
    fs.mkdirSync(join(home, 'state'))
    fs.writeFileSync(markerPath, content)

    expect(takeRestartMarker(markerPath)).toBeNull()
    expect(fs.existsSync(markerPath)).toBe(false)
  })
})
