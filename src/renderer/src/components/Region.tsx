import { Component, type ReactNode } from 'react'
import { errorMessage } from '../../../shared/errors.decode'

interface RegionProps {
  /** The region as its error line names it: `The projects`. */
  what: string
  /** The error line's data-testid. */
  testId: string
  /**
   * When it changes, a region that could not be drawn tries again: the store's load count (a
   * Restart's reconnect loads again), with the view it shows where the region follows one.
   */
  reset: string | number
  /** The class of the box the error line sits in, so it keeps the region's place; none: the line alone. */
  className?: string
  children: ReactNode
}

interface RegionState {
  /** Why it could not be drawn; null while it draws. */
  error: string | null
  /** The reset value it last drew under. */
  reset: string | number
}

/**
 * A region of the window (the sidebar's lists, the main area, the review pane) that, when
 * something in it throws while drawing, shows the error line in its place and leaves the rest
 * of the window up, the sidebar's foot with the Quiet row and Restart above all. It draws again
 * when `reset` changes, so the load after a Restart brings it back without a relaunch.
 */
export default class Region extends Component<RegionProps, RegionState> {
  constructor(props: RegionProps) {
    super(props)
    this.state = { error: null, reset: props.reset }
  }

  static getDerivedStateFromError(error: Error): Partial<RegionState> {
    return { error: errorMessage(error) }
  }

  static getDerivedStateFromProps(props: RegionProps, state: RegionState): RegionState | null {
    return props.reset === state.reset ? null : { error: null, reset: props.reset }
  }

  render(): ReactNode {
    const { what, testId, className, children } = this.props
    const { error } = this.state

    if (error === null) return children

    const line = (
      <div className="error" role="alert" data-testid={testId}>
        <span>
          {what} could not be drawn: {error}
        </span>
      </div>
    )

    return className ? <div className={className}>{line}</div> : line
  }
}
