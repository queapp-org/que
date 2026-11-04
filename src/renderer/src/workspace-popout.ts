// What the workspace popout says, as pure rules: the path with `~` for the home
// directory, a pull request's first failing check (its state in words is `prBadge`), and
// the lines of a removal or a preparation under way. WorkspacePopout.tsx and PreparingPane.tsx
// draw them. docs/design.md "Sidebar".
import type { PullRequest } from '../../preload/index.d'
import { preparationStepLabel } from '../../shared/format'
import { preparationStopped } from '../../shared/preparation'
import type {
  Preparation,
  PreparationStep,
  Removal,
  RemovalStep,
  StepRun
} from '../../shared/types'

/** `~/…` when the path is under the home directory; the path as it is otherwise. */
export function tildePath(path: string, home: string | null): string {
  if (!home) return path
  const root = home.replace(/\/+$/, '')

  if (path === root) return '~'

  return path.startsWith(`${root}/`) ? `~${path.slice(root.length)}` : path
}

/** The name of the first failing check run, while the checks are failing; else null. */
export function firstFailingCheck(pr: PullRequest): string | null {
  if (pr.checks !== 'failing') return null

  return pr.checkRuns.find((c) => c.state === 'failing')?.name ?? null
}

/** Where one step of a removal or a preparation stands, as its list of steps draws it. */
export type StepLine<S> =
  | { step: S; state: 'done'; ms: number }
  | { step: S; state: 'failed'; error: string }
  | { step: S; state: 'current' }
  | { step: S; state: 'pending' }

/**
 * One line per step in the plan, in order: a finished step is done (or failed, with its
 * reason), the one running now is current, and the rest are pending; all of them once `stopped`.
 */
function stepLines<S>(run: StepRun<S>, stopped: boolean): StepLine<S>[] {
  return run.plan.map((step, i): StepLine<S> => {
    const result = run.done[i]

    if (result) {
      return result.error === undefined
        ? { step, state: 'done', ms: result.ms }
        : { step, state: 'failed', error: result.error }
    }

    return i === run.done.length && !stopped
      ? { step, state: 'current' }
      : { step, state: 'pending' }
  })
}

/** A removal's lines: a failed step does not stop the rest. */
export function removalLines(removal: Removal): StepLine<RemovalStep>[] {
  return stepLines(removal, false)
}

/** A preparation's lines: a step that stopped it leaves the rest pending, none current. */
export function preparationLines(preparation: Preparation): StepLine<PreparationStep>[] {
  return stepLines(preparation, preparationStopped(preparation) !== null)
}

/** How a list of a preparation's steps words them: what Claude starts on is said there. */
export function preparationLabel(brief: string | undefined): (step: PreparationStep) => string {
  return (step) =>
    step === 'claude' && brief ? 'starting Claude with your brief' : preparationStepLabel(step)
}
