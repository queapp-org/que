// Small helpers for specs that are neither process setup nor a page object.
import type { Page } from '@playwright/test'

declare global {
  interface Window {
    /** What the page wrote to the stubbed clipboard. */
    clipboardWrites?: string[]
  }
}

/**
 * Replaces the window's clipboard with an in-memory one: the real pasteboard belongs to whoever
 * is using the Mac. Returns a reader for what the page has written so far, oldest first.
 */
export async function stubClipboard(page: Page, pasted = ''): Promise<() => Promise<string[]>> {
  await page.evaluate((text) => {
    const writes: string[] = []
    window.clipboardWrites = writes
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (t: string) => {
          writes.push(t)
        },
        readText: async () => text
      }
    })
  }, pasted)

  return () => page.evaluate(() => window.clipboardWrites ?? [])
}
