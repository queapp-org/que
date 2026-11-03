// The main pane before a new workspace's first terminal: its steps, keyed by workspace id, each
// with `data-state` (done, failed, current, pending), and the setup log button.
import type { Locator, Page } from '@playwright/test'

export class PreparingPage {
  page: Page
  pane: (id: string) => Locator
  step: (id: string, step: string) => Locator
  setupLog: (id: string) => Locator

  constructor(page: Page) {
    this.page = page
    this.pane = (id: string) => page.getByTestId(`preparing-${id}`)
    this.step = (id: string, step: string) => page.getByTestId(`preparing-${id}-step-${step}`)
    this.setupLog = (id: string) => page.getByTestId(`preparing-${id}-setup-log`)
  }
}
