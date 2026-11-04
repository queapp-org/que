// Reading a workspace's preparation, shared by the daemon and the renderer. No Node imports.
import type { Preparation, PreparationResult, PreparationStep, Workspace } from './types'

/** A failed step: its result with the reason. */
export type PreparationFailure = PreparationResult & { error: string }

const failed = (r: PreparationResult): r is PreparationFailure => r.error !== undefined

/** The step that failed, a setup included; null when none has. */
export function preparationFailure(p: Preparation): PreparationFailure | null {
  return p.done.find(failed) ?? null
}

/** The step that stopped the preparation; null while none has. Claude starts after a failed setup, so setup never stops it. */
export function preparationStopped(p: Preparation): PreparationFailure | null {
  const failure = preparationFailure(p)

  return failure?.step === 'setup' ? null : failure
}

/** The step running now; null once every step has run, or one has stopped it. */
export function preparationStep(p: Preparation): PreparationStep | null {
  return preparationStopped(p) ? null : (p.plan[p.done.length] ?? null)
}

/** Still being prepared, or stopped by a failed step: it has no terminals to open yet. */
export function preparationUnfinished(ws: Pick<Workspace, 'preparation'>): boolean {
  const p = ws.preparation

  return p !== undefined && (preparationStep(p) !== null || preparationStopped(p) !== null)
}
