// The menu-bar item: the q and one status mark as a template image, the unlock countdown beside
// it while one runs, and either click pops a menu of the counts and the quiet controls. trayView
// says what to show, from rows the daemon's events keep current; tray-icon draws the pixels.
// docs/design.md "Menu bar".
import { Menu, nativeImage, systemPreferences, Tray } from 'electron'
import type { DaemonClient } from '../shared/client'
import type { QuietState, TrayView, Workspace } from '../shared/types'
import {
  FRAME_INTERVAL_MS,
  ICON_HEIGHT,
  ICON_SCALE,
  ICON_WIDTH,
  qBitmap,
  qWithDotBitmap,
  stillWorkingBitmap,
  workingBitmaps
} from './tray-icon'
import { type TrayActions, trayMenu, trayView } from './tray-view'

/** The tray tooltip and board window title in a quiet window, else null. */
export function quietTitle(q: QuietState | null): string | null {
  if (!q?.inQuietHours) return null

  return q.kind === 'manual' ? 'que · quiet' : 'que · quiet hours'
}

function templateImage(bitmap: Buffer): Electron.NativeImage {
  const image = nativeImage.createFromBitmap(bitmap, {
    width: ICON_WIDTH,
    height: ICON_HEIGHT,
    scaleFactor: ICON_SCALE
  })

  image.setTemplateImage(true)

  return image
}

export interface QueTray {
  view(): TrayView
  /** Lists the daemon's rows afresh (on connect and reconnect); events that arrive meanwhile apply on top. */
  seed(client: DaemonClient): void
  /** A workspace was created or updated. */
  putWorkspace(w: Workspace): void
  /** A workspace was removed. */
  dropWorkspace(id: string): void
  /** The daemon's quiet state changed. */
  setQuiet(q: QuietState | null): void
  destroy(): void
}

export function createTray(opts: TrayActions): QueTray {
  const qImage = templateImage(qBitmap())
  const dotImage = templateImage(qWithDotBitmap())
  const frameImages = workingBitmaps().map((bitmap) => templateImage(bitmap))
  const stillImage = templateImage(stillWorkingBitmap())
  const tray = new Tray(qImage)
  let quiet: QuietState | null = null
  let countdown: NodeJS.Timeout | null = null
  let frameTimer: NodeJS.Timeout | null = null
  let view = trayView([], quiet, Date.now())
  const workspaces = new Map<string, Workspace>()
  // Changes that arrive while the list is in flight, replayed on top of them.
  let held: Array<() => void> | null = null

  const stopFrames = (): void => {
    if (frameTimer) clearInterval(frameTimer)
    frameTimer = null
  }

  const startFrames = (): void => {
    if (systemPreferences.getAnimationSettings().prefersReducedMotion) {
      tray.setImage(stillImage)

      return
    }

    let frame = 0

    tray.setImage(frameImages[frame])
    frameTimer = setInterval(() => {
      frame = (frame + 1) % frameImages.length
      tray.setImage(frameImages[frame])
    }, FRAME_INTERVAL_MS)
    frameTimer.unref()
  }

  // Frames run only while the mark is `working`.
  const showMark = (mark: TrayView['mark']): void => {
    stopFrames()

    if (mark === 'working') startFrames()
    else tray.setImage(mark === 'attention' ? dotImage : qImage)
  }

  // Only what changed reaches the bar, since workspace events come in bursts.
  const render = (): void => {
    const shown = view

    view = trayView([...workspaces.values()], quiet, Date.now())

    if (tray.isDestroyed()) return

    if (view.title !== shown.title) tray.setTitle(view.title, { fontType: 'monospacedDigit' })

    if (view.mark !== shown.mark) showMark(view.mark)
  }

  // Either click pops the menu, built fresh so it reads what is true now.
  const popUp = (): void =>
    tray.popUpContextMenu(Menu.buildFromTemplate(trayMenu(view, quiet, opts)))

  tray.on('click', popUp)
  tray.on('right-click', popUp)
  tray.setToolTip('que')

  const seed = (client: DaemonClient): void => {
    const mine: Array<() => void> = []
    held = mine
    void client
      .request('workspace.list')
      .then((wsList) => {
        if (held !== mine) return
        held = null
        workspaces.clear()

        for (const w of wsList) workspaces.set(w.id, w)

        for (const replay of mine) replay()

        render()
      })
      .catch(() => {
        // The daemon went away; the next connect seeds again.
        if (held === mine) held = null
      })
  }

  // Applies a change now, or holds it for the seed to replay while the list is in flight.
  const change = (fn: () => void): void => {
    if (held) {
      held.push(fn)

      return
    }

    fn()
    render()
  }

  const setQuiet = (q: QuietState | null): void => {
    quiet = q
    const ticking = Boolean(q?.inQuietHours && q.unlockedUntil)

    if (ticking && !countdown) {
      countdown = setInterval(render, 1000)
      countdown.unref()
    } else if (!ticking && countdown) {
      clearInterval(countdown)
      countdown = null
    }

    if (!tray.isDestroyed()) tray.setToolTip(quietTitle(q) ?? 'que')
    render()
  }

  return {
    view: () => view,
    seed,
    putWorkspace: (w) => change(() => workspaces.set(w.id, w)),
    dropWorkspace: (id) => change(() => workspaces.delete(id)),
    setQuiet,
    destroy: () => {
      if (countdown) clearInterval(countdown)
      stopFrames()
      tray.destroy()
    }
  }
}
