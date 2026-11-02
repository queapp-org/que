import { useEffect, useState } from 'react'
import type { UpdateInfo } from '../../../preload/index.d'
import { useQueSelector, useStore } from '../store'

const RESTART_TITLE =
  'que was updated. The background service still runs the previous build. Restart it on this build; every terminal keeps running.'

/**
 * A small control at the Quiet row's right end (after `lock now` during an unlock), in one
 * of two states, and absent with neither:
 * - Restart, while the background service runs an older build than this app. Its click
 *   hands every terminal to this build in place (see QueStore.upgradeDaemon), and on
 *   success it goes away with the stale state.
 * - Update, while the service runs this build and the release check found a newer
 *   release. Its click opens that release's download page; an unsigned build cannot
 *   install itself.
 * Restart wins when both hold, since it can be done now; Update follows once it is.
 */
export default function UpdateChip(): React.JSX.Element | null {
  const store = useStore()
  const stale = useQueSelector((s) => s.daemon?.stale ?? false)
  const [busy, setBusy] = useState(false)
  const [release, setRelease] = useState<UpdateInfo | null>(null)

  useEffect(() => {
    let live = true
    store.fetchUpdate().then(
      (found) => {
        if (live && found) setRelease(found)
      },
      () => {}
    )
    const off = store.onUpdate((found) => setRelease(found))

    return () => {
      live = false
      off()
    }
  }, [store])

  if (stale) {
    const restart = (): void => {
      setBusy(true)
      void store.upgradeDaemon().finally(() => setBusy(false))
    }

    return (
      <button
        type="button"
        className="update-chip"
        data-testid="sidebar-daemon-update"
        title={RESTART_TITLE}
        disabled={busy}
        onClick={restart}
      >
        <span className="status-dot" aria-hidden="true" />
        {busy ? 'Restarting…' : 'Restart'}
      </button>
    )
  }

  if (!release) return null

  return (
    <button
      type="button"
      className="update-chip"
      data-testid="sidebar-app-update"
      title={`que ${release.version} has been released. Opens its download page.`}
      onClick={() => store.openUpdate()}
    >
      <span className="status-dot" aria-hidden="true" />
      Update
    </button>
  )
}
