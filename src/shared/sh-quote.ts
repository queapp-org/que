// Quoting for a POSIX shell. No Node imports, so the renderer can use it too.

/** Single-quotes a string for POSIX sh. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

// oxlint-disable-next-line no-control-regex -- finding control characters is the point
const CONTROL = /[\x00-\x1f\x7f]/g

/**
 * A path as one shell word that is safe to send to a terminal as typed input. Single quotes keep
 * a shell from reading it, but a control character inside them still reaches the terminal raw: a
 * newline presses Enter, and an escape can end a bracketed paste. A path holding one is written in
 * `$'…'` (bash and zsh) with each control character spelled out.
 */
export function pasteablePath(path: string): string {
  if (path.search(CONTROL) === -1) return shQuote(path)

  const body = path
    .replace(/[\\']/g, '\\$&')
    .replace(CONTROL, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)

  return `$'${body}'`
}

/** Paths as shell words, separated by spaces. */
export function pasteablePaths(paths: readonly string[]): string {
  return paths.map(pasteablePath).join(' ')
}
