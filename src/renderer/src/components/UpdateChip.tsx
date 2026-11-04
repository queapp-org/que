import { useUpdateAction } from '../useUpdateAction'

/**
 * A small control at the Quiet row's right end (after `lock now` during an unlock), absent
 * with nothing to do; useUpdateAction says what it reads and does. Restarting the background
 * service for a stale build keeps its own test id from the app's own update.
 */
export default function UpdateChip(): React.JSX.Element | null {
  const action = useUpdateAction()

  if (!action) return null

  const service = action.state === 'stale' || action.state === 'restarting'

  return (
    <button
      type="button"
      className="update-chip"
      data-testid={service ? 'sidebar-daemon-update' : 'sidebar-app-update'}
      data-state={action.state}
      title={action.title}
      disabled={action.disabled}
      onClick={action.run}
    >
      <span className="status-dot" aria-hidden="true" />
      {action.label}
    </button>
  )
}
