// Contract test against the REAL Claude Code CLI: after a reply in an
// interactive session, the status line command from --settings gets
// `rate_limits` on stdin in the shape `que statusline` decodes (the fake's
// `/statusline` imitates it). Accounts without plan limits (an API key) never
// send `rate_limits`; the test then skips. Opt-in: `npm run test:contract`.
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import * as pty from 'node-pty'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { decodeStatusLineUsage } from '../../src/shared/usage.decode'
import { FAKES_BIN } from '../../src/testing/fakes'
import { answerTrustPrompt, jsonLines, recordCommand } from './interactive'

const CONTRACT = process.env.QUE_CONTRACT === '1'

describe.skipIf(!CONTRACT)('claude status line contract', () => {
  let dir: string
  let record: (log: string) => string

  beforeAll(() => {
    // The real binary, never the fake: drop tests/fakes/bin from PATH.
    const path = (process.env.PATH ?? '').split(':').filter((p) => p !== FAKES_BIN)
    vi.stubEnv('PATH', path.join(':'))
    dir = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'que-contract-statusline-')))
    record = recordCommand(dir)
  })

  afterAll(() => {
    vi.unstubAllEnvs()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('passes rate_limits to the status line after a reply on a plan account', async (ctx) => {
    const statusLog = join(dir, 'statusline.jsonl')
    const stopLog = join(dir, 'stop.jsonl')

    const settings = {
      statusLine: { type: 'command', command: record(statusLog) },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: record(stopLog) }] }] }
    }

    const term = pty.spawn(
      'claude',
      ['--settings', JSON.stringify(settings), 'Reply with exactly the word OK and nothing else.'],
      { cwd: dir, cols: 120, rows: 40, env: process.env as Record<string, string> }
    )

    answerTrustPrompt(term)

    try {
      await expect.poll(() => jsonLines(stopLog).length, { timeout: 150_000 }).toBeGreaterThan(0)
      // The status line reruns after the reply (debounced); wait for one that ran after it.
      const after = Date.now()
      await expect
        .poll(
          () => jsonLines(statusLog).some((p) => 'rate_limits' in p) || Date.now() - after > 15_000,
          { timeout: 20_000 }
        )
        .toBe(true)

      const payloads = jsonLines(statusLog)
      expect(payloads.length).toBeGreaterThan(0)
      const withLimits = payloads.findLast((p) => 'rate_limits' in p)

      if (!withLimits) {
        ctx.skip('no rate_limits in the status line: this account has no plan limits')

        return
      }

      const limits = withLimits.rate_limits as Record<string, Record<string, unknown>>
      const windows = Object.values(limits)
      expect(windows.length).toBeGreaterThan(0)

      for (const w of windows) {
        expect(w).toMatchObject({
          used_percentage: expect.any(Number),
          resets_at: expect.any(Number)
        })
        // Unix seconds, not milliseconds: within the next 8 days.
        const resetsAt = w.resets_at as number
        expect(resetsAt).toBeGreaterThan(Date.now() / 1000 - 60)
        expect(resetsAt).toBeLessThan(Date.now() / 1000 + 8 * 86_400)
      }

      const decoded = decodeStatusLineUsage(withLimits)
      // Each window Claude Code sent is one que keeps.
      expect(decoded.fiveHour !== undefined).toBe('five_hour' in limits)
      expect(decoded.sevenDay !== undefined).toBe('seven_day' in limits)
      expect(decoded.fiveHour ?? decoded.sevenDay).toBeDefined()
    } finally {
      term.kill()
    }
  }, 200_000)
})
