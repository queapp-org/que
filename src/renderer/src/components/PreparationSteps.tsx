import type { Workspace } from '../../../preload/index.d'
import { formatDuration } from '../../../shared/format'
import { preparationStep, preparationStopped } from '../../../shared/preparation'
import type { Preparation } from '../../../shared/types'
import { useQueSelector, useStore } from '../store'
import { preparationLabel, preparationLines } from '../workspace-popout'
import StepLines from './StepLines'

/** A preparation's steps, as the main pane and the workspace card both draw them. */
export default function PreparationSteps({
  preparation,
  brief,
  testId
}: {
  preparation: Preparation
  brief: string | undefined
  testId: string
}): React.JSX.Element {
  return (
    <StepLines
      testId={testId}
      lines={preparationLines(preparation)}
      label={preparationLabel(brief)}
      took={formatDuration}
      since={preparation.since}
    />
  )
}

/** The setup log, from when setup starts; absent when there is no setup, or it never got that far. */
export function SetupLogButton({
  ws,
  testId
}: {
  ws: Workspace
  testId: string
}): React.JSX.Element | null {
  const store = useStore()
  const connected = useQueSelector((s) => s.connected)
  const preparation = ws.preparation

  if (!preparation?.plan.includes('setup')) return null

  const started =
    preparation.done.some((r) => r.step === 'setup') || preparationStep(preparation) === 'setup'

  if (!started && preparationStopped(preparation)) return null

  return (
    <button
      type="button"
      className="ghost step-action"
      data-testid={testId}
      disabled={!started || !connected}
      onClick={() => void store.openSetupLog(ws.id)}
    >
      Open setup log
    </button>
  )
}
