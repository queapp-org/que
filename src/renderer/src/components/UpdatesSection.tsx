import { useState } from 'react'
import type { UpdateStatus } from '../../../preload/index.d'
import { hhmm } from '../../../shared/format'
import { useQueSelector, useStore } from '../store'

const ANSWER = 'settings-updates-answer'

/** The last answer, the first that holds of: a local build, a newer release, a failure, up to date. */
function Answer({ status }: { status: UpdateStatus }): React.JSX.Element | null {
  const { releaseBuild, update, failed, checkedAt } = status
  const at = checkedAt === null ? null : hhmm(checkedAt)

  if (!releaseBuild) {
    return (
      <p className="hint" data-testid={ANSWER}>
        Local build: que doesn&apos;t check for releases.
      </p>
    )
  }

  if (update) {
    return (
      <p className="updates-news" data-testid={ANSWER}>
        que {update.version} is available.
      </p>
    )
  }

  if (failed) {
    return (
      <p className="form-error" role="alert" data-testid={ANSWER}>
        Couldn&apos;t check: no answer from GitHub.{at && ` Tried at ${at}.`}
      </p>
    )
  }

  if (at) {
    return (
      <p className="hint" data-testid={ANSWER}>
        Up to date. Checked at {at}.
      </p>
    )
  }

  return null
}

/**
 * Settings' last section: the running version, the update check's last answer, and asking
 * again by hand. It is never disabled with the daemon gone, since the check runs in the main
 * process. The chip in the Quiet row reads the same status, so the two never disagree.
 */
export default function UpdatesSection(): React.JSX.Element | null {
  const store = useStore()
  const status = useQueSelector((s) => s.updateStatus)
  const [checking, setChecking] = useState(false)

  if (!status) return null

  const check = (): void => {
    setChecking(true)
    void store
      .checkForUpdate()
      .catch(() => {})
      .finally(() => setChecking(false))
  }

  return (
    <fieldset data-testid="settings-updates">
      <legend>Updates</legend>
      <div className="updates-row">
        <span className="updates-version" data-testid="settings-updates-version">
          que {status.version}
        </span>
        <Answer status={status} />
        {status.releaseBuild && (
          <span className="updates-actions">
            <button
              type="button"
              data-testid="settings-check-updates"
              disabled={checking}
              onClick={check}
            >
              {checking ? 'Checking…' : 'Check for updates'}
            </button>
            {status.update && (
              <button
                type="button"
                data-testid="settings-download-update"
                onClick={() => store.openUpdate()}
              >
                Download
              </button>
            )}
          </span>
        )}
      </div>
    </fieldset>
  )
}
