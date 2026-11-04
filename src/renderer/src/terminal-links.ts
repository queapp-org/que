// What a click on a link in a terminal does. Plain URLs (the web links addon) and OSC 8 hyperlinks
// (xterm's linkHandler) both land here, so neither reaches xterm's default handler and its confirm
// dialog.

const BROWSER_SCHEMES = ['http:', 'https:']

/**
 * The address to hand to the browser, or null for anything but http and https. The main process
 * filters again, and that is deliberate defence in depth: a link comes from whatever a program
 * printed, so it is checked here too, where it enters the app.
 */
export function browserUrl(uri: string): string | null {
  try {
    const url = new URL(uri)

    return BROWSER_SCHEMES.includes(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

/**
 * Cmd+click opens the link in the browser; a plain click stays a click, so selecting text across a
 * link never opens it. window.open goes to the main process's setWindowOpenHandler, which denies
 * the window and opens the browser.
 */
export function openTerminalLink(event: MouseEvent, uri: string): void {
  if (!event.metaKey) return
  const url = browserUrl(uri)

  if (url) window.open(url)
}
