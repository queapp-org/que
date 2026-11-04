// Installing a newer release from inside the app. The check (update-check.ts) still says
// whether one exists; a click downloads it through the updater, and a click on Restart
// installs it and relaunches. Nothing installs by itself, not even on quit. The updater is
// injected and loaded on the first click, so tests drive a fake one and only a release build
// ever touches the real library. Nothing here throws to its caller: a failure becomes the
// failed state, in words for the error line, and this version keeps running.
//
// The marker is what makes that one Restart enough: written just before installing and taken
// at the next launch, it says the new app should hand the terminals to a new daemon by itself.
// An upgrade installed by hand leaves no marker, so it keeps its own Restart.
import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { errorMessage } from '../shared/errors.decode'
import type { UpdateInstall } from '../shared/types'
import { decodeRestartMarker, type RestartMarker } from './update-install.decode'

export type { RestartMarker }

/** How long a marker stands: an install takes a minute or two, not an afternoon. */
export const RESTART_MARKER_MAX_AGE_MS = 10 * 60 * 1000

/** The part of the updater library the install uses. */
export interface Updater {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  allowDowngrade: boolean
  on(event: 'download-progress', listener: (info: { percent: number }) => void): void
  on(event: 'error', listener: (err: Error) => void): void
  /** Null when the updater is inactive (an unpackaged app). */
  checkForUpdates(): Promise<{
    isUpdateAvailable: boolean
    updateInfo: { version: string }
  } | null>
  downloadUpdate(): Promise<string[]>
  quitAndInstall(): void
}

export interface UpdateInstallerOptions {
  /** The updater, on the first click. */
  load: () => Promise<Updater>
  markerPath: string
  /** Every change of state. */
  onChange: (install: UpdateInstall) => void
  /** The updater found nothing to download although the check knew of a release. */
  onNoUpdate?: () => void
  now?: () => number
}

/** Where a clicked Restart leaves its marker. */
export function restartMarkerPath(home: string): string {
  return join(home, 'state', 'update-restart.json')
}

/** Writes the marker. A failure is not worth stopping the install: the Restart chip remains. */
export function writeRestartMarker(path: string, marker: RestartMarker): void {
  try {
    fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    fs.writeFileSync(path, `${JSON.stringify(marker)}\n`)
  } catch (err) {
    console.error('could not write the restart marker:', err)
  }
}

function removeRestartMarker(path: string): void {
  try {
    fs.rmSync(path, { force: true })
  } catch (err) {
    console.error('could not remove the restart marker:', err)
  }
}

/** Reads the marker and removes it, whatever it says; null without a usable one. */
export function takeRestartMarker(path: string): RestartMarker | null {
  try {
    return decodeRestartMarker(JSON.parse(fs.readFileSync(path, 'utf8')))
  } catch {
    return null
  } finally {
    removeRestartMarker(path)
  }
}

/** Whether a launch hands the terminals over: a recent clicked Restart, and a daemon on an older build. */
export function shouldHandOffAtLaunch(
  marker: RestartMarker | null,
  now: number,
  stale: boolean
): boolean {
  if (!marker || !stale) return false
  const age = now - marker.at

  return age >= 0 && age <= RESTART_MARKER_MAX_AGE_MS
}

/** The updater's message as a clause: its first line (the rest is headers and stacks). */
function reasonOf(message: string): string {
  const line = message.split('\n', 1)[0].trim().replace(/\.$/, '')

  if (line.includes('net::ERR_')) return 'no connection to GitHub'

  return line || 'no reason given'
}

function failureText(doing: 'download' | 'install', message: string): string {
  return `Couldn't ${doing} the update: ${reasonOf(message)}. Settings > Updates links to the release page.`
}

const NOTHING_TO_DOWNLOAD = 'que found no newer release to download. It may have been withdrawn.'

export class UpdateInstaller {
  private current: UpdateInstall = { phase: 'idle' }
  private updater: Updater | null = null

  constructor(private readonly o: UpdateInstallerOptions) {}

  get state(): UpdateInstall {
    return this.current
  }

  /** From idle or failed: asks for the release and downloads it. Resolves when that is over. */
  async start(): Promise<void> {
    const { phase } = this.current

    if (phase !== 'idle' && phase !== 'failed') return
    this.set({ phase: 'downloading', percent: 0 })

    try {
      const updater = await this.loaded()
      const found = await updater.checkForUpdates()

      if (!this.stillDownloading()) return

      if (!found?.isUpdateAvailable) {
        this.set({ phase: 'failed', message: NOTHING_TO_DOWNLOAD })
        this.o.onNoUpdate?.()

        return
      }

      await updater.downloadUpdate()

      if (this.stillDownloading()) this.set({ phase: 'ready', version: found.updateInfo.version })
    } catch (err) {
      this.fail(errorMessage(err))
    }
  }

  /** The updater also reports a failure as an event, which comes before its promise rejects. */
  private stillDownloading(): boolean {
    return this.current.phase === 'downloading'
  }

  /** From ready: leaves the marker and installs. The app quits once the system has the update. */
  restart(): void {
    if (this.current.phase !== 'ready' || !this.updater) return
    this.set({ phase: 'installing', version: this.current.version })
    writeRestartMarker(this.o.markerPath, { at: (this.o.now ?? Date.now)() })

    try {
      this.updater.quitAndInstall()
    } catch (err) {
      this.fail(errorMessage(err))
    }
  }

  private async loaded(): Promise<Updater> {
    if (this.updater) return this.updater
    const updater = await this.o.load()
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    updater.allowPrerelease = false
    updater.allowDowngrade = false
    updater.on('download-progress', ({ percent }) => this.progress(percent))
    // Also what keeps the emitter from throwing: it must always have a listener.
    updater.on('error', (err) => this.fail(errorMessage(err)))
    this.updater = updater

    return updater
  }

  private progress(percent: number): void {
    if (this.current.phase !== 'downloading' || !Number.isFinite(percent)) return
    const whole = Math.min(100, Math.max(0, Math.floor(percent)))

    if (whole !== this.current.percent) this.set({ phase: 'downloading', percent: whole })
  }

  /** A failure means something only while a download or an install is under way. */
  private fail(reason: string): void {
    if (this.current.phase === 'downloading') {
      this.set({ phase: 'failed', message: failureText('download', reason) })
    } else if (this.current.phase === 'installing') {
      removeRestartMarker(this.o.markerPath)
      this.set({ phase: 'failed', message: failureText('install', reason) })
    }
  }

  private set(next: UpdateInstall): void {
    this.current = next
    this.o.onChange(next)
  }
}
