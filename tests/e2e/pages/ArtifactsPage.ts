// The pages a session published, in the review pane: the list, its head's count, and a row per
// page, keyed by the page's id, the last part of its URL. The pane's icon is ReviewPage.viewArtifacts.
import type { Locator, Page } from '@playwright/test'

export class ArtifactsPage {
  summary: Locator
  row: (id: string) => Locator
  rowLink: (id: string) => Locator
  rowCopy: (id: string) => Locator
  rowAge: (id: string) => Locator

  constructor(page: Page) {
    this.summary = page.getByTestId('artifact-list-summary')
    this.row = (id: string) => page.getByTestId(`artifact-${id}`)
    this.rowLink = (id: string) => page.getByTestId(`artifact-${id}-link`)
    this.rowCopy = (id: string) => page.getByTestId(`artifact-${id}-copy`)
    this.rowAge = (id: string) => page.getByTestId(`artifact-${id}-age`)
  }
}
