// The pages a session published, in the review pane: the list, its head's count, and a row per
// page, keyed by the page's id, the last part of its URL. The pane's icon is ReviewPage.viewArtifacts.
import type { Locator, Page } from '@playwright/test'

export class ArtifactsPage {
  page: Page
  list: Locator
  summary: Locator
  empty: Locator
  openEditor: Locator
  row: (id: string) => Locator
  rowLink: (id: string) => Locator
  rowCopy: (id: string) => Locator
  rowAge: (id: string) => Locator

  constructor(page: Page) {
    this.page = page
    this.list = page.getByTestId('artifact-list')
    this.summary = page.getByTestId('artifact-list-summary')
    this.empty = page.getByTestId('artifact-empty')
    this.openEditor = page.getByTestId('artifacts-open-editor')
    this.row = (id: string) => page.getByTestId(`artifact-${id}`)
    this.rowLink = (id: string) => page.getByTestId(`artifact-${id}-link`)
    this.rowCopy = (id: string) => page.getByTestId(`artifact-${id}-copy`)
    this.rowAge = (id: string) => page.getByTestId(`artifact-${id}-age`)
  }
}
