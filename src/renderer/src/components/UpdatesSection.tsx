import { useState } from 'react'
import type { UpdateStatus } from '../../../preload/index.d'
import { hhmm } from '../../../shared/format'
import { useQueSelector, useStore } from '../store'

interface Answer {
  className: string
  text: string
  role?: 'alert'
}

/** The last answer, the first that holds of: a local build, a newer release, a failure, up to date. */
function answerOf({ releaseBuild, update, failed, checkedAt }: UpdateStatus): Answer | null {
  const at = checkedAt === null ? null : hhmm(checkedAt)

  if (!releaseBuild) {
    return { className: 'hint', text: "Local build: que doesn't check for releases." }
  }

  if (update) return { className: 'updates-news', text: `que ${update.version} is available.` }

  if (failed) {
    const tried = at ? ` Tried at ${at}.` : ''

    return {
      className: 'form-error',
      role: 'alert',
      text: `Couldn't check: no answer from GitHub.${tried}`
    }
  }

  return at ? { className: 'hint', text: `Up to date. Checked at ${at}.` } : null
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

  const answer = answerOf(status)

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
        {answer && (
          <p className={answer.className} role={answer.role} data-testid="settings-updates-answer">
            {answer.text}
          </p>
        )}
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
