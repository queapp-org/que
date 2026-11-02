import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import Region from './Region'

/** What a workspace list read from an older build used to throw while drawing. */
const MESSAGE = "Cannot read properties of undefined (reading 'map')"

/** A fixture child: a list that throws while drawing as long as it is `broken`. */
function Rows({ broken }: { broken: boolean }): React.JSX.Element {
  if (broken) throw new Error(MESSAGE)

  return (
    <ul data-testid="rows">
      <li>app-1432-retry-logic</li>
    </ul>
  )
}

describe('Region', () => {
  describe('errors', () => {
    it('shows the error line in place of a child that throws, and leaves what is outside it drawn', () => {
      render(
        <>
          <Region what="The projects" testId="sidebar-projects-failed" reset={1}>
            <Rows broken />
          </Region>
          <button type="button">Restart</button>
        </>
      )

      const line = screen.getByRole('alert')
      expect(line).toHaveAttribute('data-testid', 'sidebar-projects-failed')
      expect(line.textContent).toBe(`The projects could not be drawn: ${MESSAGE}`)
      expect(screen.queryByTestId('rows')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Restart' })).toBeInTheDocument()
    })

    it('puts the line in a box with the given class, so it keeps the region in its place', () => {
      render(
        <Region what="The review pane" testId="review-failed" reset={1} className="review">
          <Rows broken />
        </Region>
      )

      expect(screen.getByTestId('review-failed').parentElement).toHaveClass('review')
    })
  })

  describe('reset', () => {
    it('stays failed under the same reset, and draws the child again under a new one', () => {
      const { rerender } = render(
        <Region what="The projects" testId="sidebar-projects-failed" reset={1}>
          <Rows broken />
        </Region>
      )

      rerender(
        <Region what="The projects" testId="sidebar-projects-failed" reset={1}>
          <Rows broken={false} />
        </Region>
      )

      expect(screen.getByTestId('sidebar-projects-failed')).toBeInTheDocument()
      expect(screen.queryByTestId('rows')).not.toBeInTheDocument()

      rerender(
        <Region what="The projects" testId="sidebar-projects-failed" reset={2}>
          <Rows broken={false} />
        </Region>
      )

      expect(screen.getByTestId('rows')).toBeInTheDocument()
      expect(screen.queryByTestId('sidebar-projects-failed')).not.toBeInTheDocument()
    })
  })
})
