import { preparationStopped } from '../../../shared/preparation'
import { useQueSelector, useStore } from '../store'
import PreparationSteps, { SetupLogButton } from './PreparationSteps'

/**
 * What the main pane shows until a new workspace has its first terminal: `[ PREPARING ]` and the
 * steps with their clocks, or which step stopped it and why, with the way to remove it.
 */
export default function PreparingPane({ termKey }: { termKey: string }): React.JSX.Element | null {
  const store = useStore()
  const connected = useQueSelector((s) => s.connected)
  const ws = useQueSelector((s) => s.workspaces[termKey])
  const preparation = ws?.preparation

  if (!preparation) return null
  const id = `preparing-${ws.id}`

  return (
    <div className="preparing" data-testid={id}>
      <div className="preparing-card">
        <h2 className="label">Preparing</h2>
        <PreparationSteps preparation={preparation} brief={ws.brief} testId={`${id}-step`} />
        <div className="preparing-actions">
          <SetupLogButton ws={ws} testId={`${id}-setup-log`} />
          {preparationStopped(preparation) && (
            <button
              type="button"
              className="ghost step-action"
              data-testid={`${id}-remove`}
              disabled={!connected}
              onClick={() => store.openDialog({ kind: 'remove-workspace', workspaceId: ws.id })}
            >
              Remove…
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
