import { useState } from 'react'
import { useQueSelector, useStore } from './store'

const SERVICE_RESTART_TITLE =
  'que was updated. The background service still runs the previous build. Restart it on this build; every terminal keeps running.'

/** What the one update action is doing; the chip and Settings expose it as `data-state`. */
export type UpdateActionState =
  | 'ready'
  | 'installing'
  | 'stale'
  | 'restarting'
  | 'downloading'
  | 'update'

export interface UpdateAction {
  state: UpdateActionState
  label: string
  title: string
  disabled: boolean
  run: () => void
}

/**
 * The one thing to do about updates right now, for the chip in the Quiet row and Settings >
 * Updates alike, so the two never disagree; null with nothing to do. In order:
 * - Restart, with a release downloaded. Its click installs it and relaunches, and the new app
 *   hands the terminals over by itself, so it comes first: it takes care of the next one too.
 * - Restart, while the background service runs an older build than this app. Its click hands
 *   every terminal to this build in place (see QueStore.upgradeDaemon), and on success it
 *   goes away with the stale state.
 * - Updating N%, while a release downloads in the background. No click to take.
 * - Update, while the check knows of a newer release. Its click starts the download.
 */
export function useUpdateAction(): UpdateAction | null {
  const store = useStore()
  const stale = useQueSelector((s) => s.daemon?.stale ?? false)
  const status = useQueSelector((s) => s.updateStatus)
  const [restarting, setRestarting] = useState(false)
  const install = status?.install
  const release = status?.update ?? null

  if (install?.phase === 'ready') {
    return {
      state: 'ready',
      label: 'Restart',
      title: `que ${install.version} is downloaded. Restart to install it; every terminal keeps running.`,
      disabled: false,
      run: () => void store.restartToInstall()
    }
  }

  if (install?.phase === 'installing') {
    return {
      state: 'installing',
      label: 'Restarting…',
      title: `Installing que ${install.version}. que reopens by itself; every terminal keeps running.`,
      disabled: true,
      run: () => {}
    }
  }

  if (stale) {
    return {
      state: restarting ? 'restarting' : 'stale',
      label: restarting ? 'Restarting…' : 'Restart',
      title: SERVICE_RESTART_TITLE,
      disabled: restarting,
      run: () => {
        setRestarting(true)
        void store.upgradeDaemon().finally(() => setRestarting(false))
      }
    }
  }

  if (install?.phase === 'downloading') {
    return {
      state: 'downloading',
      label: `Updating ${install.percent}%`,
      title: `Downloading ${release ? `que ${release.version}` : 'the update'} in the background. Nothing installs until you click Restart.`,
      disabled: true,
      run: () => {}
    }
  }

  if (!release) return null

  return {
    state: 'update',
    label: 'Update',
    title: `que ${release.version} has been released. Downloads it in the background; nothing installs until you click Restart.`,
    disabled: false,
    run: () => void store.installUpdate()
  }
}
