import { useState } from 'react'
import type { UpdateStatus } from '../../../preload/index.d'
import { hhmm } from '../../../shared/format'
import { useQueSelector, useStore } from '../store'
import { useUpdateAction } from '../useUpdateAction'

interface Answer {
  className: string
  text: string
  role?: 'alert'
}

/**
 * The last answer, the first that holds of: a local build, an install under way or ready, a
 * failed install with the release still there (the error line has already announced it, so no
 * alert), a newer release, a failed check, up to date.
 */
function answerOf({
  releaseBuild,
  update,
  failed,
  checkedAt,
  install
}: UpdateStatus): Answer | null {
  const at = checkedAt === null ? null : hhmm(checkedAt)

  if (!releaseBuild) {
    return { className: 'hint', text: "Local build: que doesn't check for releases." }
  }

  if (install.phase === 'installing') {
    return { className: 'updates-news', text: `Installing que ${install.version}.` }
  }

  if (install.phase === 'ready') {
    return { className: 'updates-news', text: `que ${install.version} is ready to install.` }
  }

  if (update && install.phase === 'failed') {
    return { className: 'form-error', text: install.message }
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
 * Settings' last section: the running version, the update check's last answer, asking again
 * by hand, the same update action as the chip in the Quiet row, and the release page for
 * installing by hand. It is never disabled with the daemon gone, since the check and the
 * install run in the main process.
 */
export default function UpdatesSection(): React.JSX.Element | null {
  const store = useStore()
  const status = useQueSelector((s) => s.updateStatus)
  const action = useUpdateAction()
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
            {action && (
              <button
                type="button"
                className="updates-install"
                data-testid="settings-install-update"
                data-state={action.state}
                title={action.title}
                disabled={action.disabled}
                onClick={action.run}
              >
                {action.label}
              </button>
            )}
            {status.update && (
              <button
                type="button"
                data-testid="settings-download-update"
                onClick={() => store.openUpdate()}
              >
                Release page
              </button>
            )}
          </span>
        )}
      </div>
    </fieldset>
  )
}
