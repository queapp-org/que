import { formatAge } from '../../../shared/format'
import { NOW_SECONDS_INTERVAL_MS, useNow } from '../useNow'
import type { StepLine } from '../workspace-popout'
import WorkingMark from './WorkingMark'

/** The clock of the step running now, ticking each second while it is mounted and only then. */
function StepClock({ since }: { since: string }): React.JSX.Element {
  return <>{formatAge(since, useNow(NOW_SECONDS_INTERVAL_MS))}</>
}

/**
 * A removal's or a preparation's steps, one line each: a dot (or the neutral working mark on the
 * step running now) in its column, the step's words, and at the right its duration, its failure,
 * or the clock since it started. A step still to come has a hollow dot and nothing at the right.
 */
export default function StepLines<S extends string>({
  testId,
  lines,
  label,
  took,
  since
}: {
  testId: string
  lines: ReadonlyArray<StepLine<S>>
  /** The words of a step. */
  label: (step: S) => string
  /** How long a finished step took, in words. */
  took: (ms: number) => string
  /** When the step running now started. */
  since: string
}): React.JSX.Element {
  return (
    <ul className="step-lines" data-testid={testId}>
      {lines.map((line) => (
        <li
          key={line.step}
          className={`step-line ${line.state}`}
          data-testid={`${testId}-${line.step}`}
          data-state={line.state}
        >
          <span className="step-line-mark" aria-hidden="true">
            {line.state === 'current' ? (
              <WorkingMark tone="neutral" />
            ) : (
              <span className="step-line-dot" />
            )}
          </span>
          <span className="step-line-words">{label(line.step)}</span>
          <span
            className="step-line-right"
            data-testid={`${testId}-${line.step}-right`}
            title={line.state === 'failed' ? line.error : undefined}
          >
            {line.state === 'done' && took(line.ms)}
            {line.state === 'failed' && line.error}
            {line.state === 'current' && <StepClock since={since} />}
          </span>
        </li>
      ))}
    </ul>
  )
}
