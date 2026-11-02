// The Settings view: its Updates section, the running version and the update check's answer.
import type { Locator, Page } from '@playwright/test'

export class SettingsPage {
  page: Page
  updatesVersion: Locator
  updatesAnswer: Locator

  constructor(page: Page) {
    this.page = page
    this.updatesVersion = page.getByTestId('settings-updates-version')
    this.updatesAnswer = page.getByTestId('settings-updates-answer')
  }
}
