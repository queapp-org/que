// What the contract tests share that drive a real interactive session in a pty.
import fs from 'node:fs'
import { join } from 'node:path'
import type { IPty } from 'node-pty'

/** Parses newline-delimited JSON, skipping blank lines. */
export function jsonLines(path: string): Record<string, unknown>[] {
  if (!fs.existsSync(path)) return []

  return fs
    .readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** Writes a recorder into `dir`, and returns the command that appends what it reads on stdin to a log. */
export function recordCommand(dir: string): (log: string) => string {
  const recorder = join(dir, 'record.cjs')
  fs.writeFileSync(
    recorder,
    [
      "const fs = require('node:fs')",
      "let input = ''",
      "process.stdin.on('data', (c) => (input += c))",
      "process.stdin.on('end', () => fs.appendFileSync(process.argv[2], input.trim() + '\\n'))",
      ''
    ].join('\n')
  )

  return (log) => `'${process.execPath}' '${recorder}' '${log}'`
}

/** Terminal output without its escape sequences: cursor moves sit between the words of a redraw. */
export const plainText = (data: string): string => data.replace(/\x1b\[[0-9;?<>]*[ -/]*[@-~]/g, '') // oxlint-disable-line no-control-regex

/**
 * A fresh directory asks whether to trust it, with "No, exit" highlighted. Each key waits for the
 * screen to settle: a key sent while the prompt is still drawing is lost when it redraws. Down to
 * "Yes", then Enter.
 */
export function answerTrustPrompt(term: IPty): void {
  let trust: 'waiting' | 'asked' | 'moved' | 'answered' = 'waiting'
  let screen = ''
  let settle: NodeJS.Timeout | undefined
  term.onData((data) => {
    if (trust === 'answered') return
    screen += plainText(data)

    if (trust === 'waiting' && /trust/i.test(screen)) trust = 'asked'

    if (trust === 'waiting') return
    clearTimeout(settle)
    settle = setTimeout(() => {
      if (trust === 'asked') {
        trust = 'moved'
        screen = ''
        term.write('\x1b[B')
      } else if (trust === 'moved' && /❯\s*Yes/.test(screen)) {
        trust = 'answered'
        term.write('\r')
      }
    }, 300)
  })
}
