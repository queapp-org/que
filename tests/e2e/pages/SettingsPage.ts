// The Settings view: its Updates section, the running version and the update check's answer.
import type { Locator, Page } from '@playwright/test'

export class SettingsPage {
  page: Page
  root: Locator
  updates: Locator
  updatesVersion: Locator
  updatesAnswer: Locator
  checkUpdates: Locator
  downloadUpdate: Locator

  constructor(page: Page) {
    this.page = page
    this.root = page.getByTestId('settings-view')
    this.updates = page.getByTestId('settings-updates')
    this.updatesVersion = page.getByTestId('settings-updates-version')
    this.updatesAnswer = page.getByTestId('settings-updates-answer')
    this.checkUpdates = page.getByTestId('settings-check-updates')
    this.downloadUpdate = page.getByTestId('settings-download-update')
  }
}
