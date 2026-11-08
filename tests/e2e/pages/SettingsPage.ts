// The Settings view: its Editor section (the app's name, with the full path as its title, and
// Choose or Change, and Clear) and its Updates section, the running version and the update
// check's answer.
import type { Locator, Page } from '@playwright/test'

export class SettingsPage {
  page: Page
  editorApp: Locator
  editorAppChoose: Locator
  editorAppClear: Locator
  updatesVersion: Locator
  updatesAnswer: Locator

  constructor(page: Page) {
    this.page = page
    this.editorApp = page.getByTestId('settings-editor-app')
    this.editorAppChoose = page.getByTestId('settings-editor-app-choose')
    this.editorAppClear = page.getByTestId('settings-editor-app-clear')
    this.updatesVersion = page.getByTestId('settings-updates-version')
    this.updatesAnswer = page.getByTestId('settings-updates-answer')
  }
}
