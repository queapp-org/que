// Contract test against the REAL Claude Code CLI: a real publish's PostToolUse is what
// decodeArtifactCall reads (the fake's `/artifact` imitates it). The tool exists only in an
// interactive session, not under `-p`. Each run really publishes, so beyond QUE_CONTRACT=1 it needs
// QUE_CONTRACT_ARTIFACT_URL, the one page it may update:
// QUE_CONTRACT=1 QUE_CONTRACT_ARTIFACT_URL=<url> npx vitest run --project node tests/contract/artifact.contract.test.ts
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import * as pty from 'node-pty'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { decodeArtifactCall } from '../../src/daemon/artifacts.decode'
import { decodeHookEvent } from '../../src/shared/hook.decode'
import { FAKES_BIN } from '../../src/testing/fakes'
import { answerTrustPrompt, jsonLines, plainText, recordCommand } from './interactive'

const PAGE_URL = process.env.QUE_CONTRACT_ARTIFACT_URL
const CONTRACT = process.env.QUE_CONTRACT === '1' && Boolean(PAGE_URL)
const PAGE_HTML = '<!doctype html><title>que contract page</title><p>que contract test page</p>\n'

describe.skipIf(!CONTRACT)('claude Artifact contract', () => {
  let dir: string

  beforeAll(() => {
    // The real binary, never the fake: drop tests/fakes/bin from PATH.
    const path = (process.env.PATH ?? '').split(':').filter((p) => p !== FAKES_BIN)
    vi.stubEnv('PATH', path.join(':'))
    dir = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'que-contract-artifact-')))
  })

  afterAll(() => {
    vi.unstubAllEnvs()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('reports a publish in the shape the decoder reads', async () => {
    const page = join(dir, 'page.html')
    const log = join(dir, 'hooks.jsonl')
    fs.writeFileSync(page, PAGE_HTML)
    const hook = { hooks: [{ type: 'command', command: recordCommand(dir)(log) }] }

    const prompt = [
      `The file ${page} is a tiny test page this test wrote. Its whole content is: ${PAGE_HTML}`,
      `Use the Artifact tool to update the existing artifact at ${PAGE_URL} with that file:`,
      `file_path ${page}, url ${PAGE_URL}. Read that artifact first if the tool asks you to.`,
      'Load no skill and do not change the file. Publish to no other URL.',
      'Then reply with exactly the word OK.'
    ].join(' ')

    const term = pty.spawn(
      'claude',
      [
        '--settings',
        JSON.stringify({ hooks: { PostToolUse: [hook], Stop: [hook] } }),
        prompt,
        // Last: it takes every argument after it as a tool.
        '--allowedTools',
        'Artifact'
      ],
      { cwd: dir, cols: 120, rows: 40, env: process.env as Record<string, string> }
    )

    let output = ''
    term.onData((data) => {
      output = (output + plainText(data)).slice(-2000)
    })
    answerTrustPrompt(term)

    const events = () => jsonLines(log).flatMap((line) => decodeHookEvent(line) ?? [])

    try {
      // Until the turn ends, or long enough to report a session stuck on a prompt.
      const deadline = Date.now() + 150_000
      await expect
        .poll(() => events().some((e) => e.hook_event_name === 'Stop') || Date.now() > deadline, {
          timeout: 160_000
        })
        .toBe(true)

      const calls = events().flatMap((event) => decodeArtifactCall(event) ?? [])
      const tools = events().map((e) => e.tool_name ?? e.hook_event_name)

      // The tool may refuse a first attempt, and the model may publish again: each one that went
      // through is that one page.
      expect(
        calls.length,
        `tools: ${tools.join(', ')}\nresponses: ${JSON.stringify(
          events()
            .filter((e) => e.tool_name === 'Artifact')
            .map((e) => e.tool_response)
        ).slice(0, 1500)}\nscreen: ${output}`
      ).toBeGreaterThan(0)

      for (const call of calls) {
        expect(call).toEqual({
          kind: 'published',
          url: PAGE_URL,
          title: expect.stringMatching(/\S/)
        })
      }
    } finally {
      term.kill()
    }
  }, 180_000)
})
