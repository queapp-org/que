// Contract test against the REAL Claude Code CLI: a real publish's PostToolUse is what
// decodeArtifactCall reads (the fake's `/artifact` imitates it). Each run really publishes, so
// beyond QUE_CONTRACT=1 it needs QUE_CONTRACT_ARTIFACT_URL, the one page it may update:
// QUE_CONTRACT=1 QUE_CONTRACT_ARTIFACT_URL=<url> npx vitest run tests/contract/artifact.contract.test.ts
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { decodeArtifactCall } from '../../src/daemon/artifacts.decode'
import { decodeHookEvent } from '../../src/shared/hook.decode'
import { FAKES_BIN } from '../../src/testing/fakes'

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
    const recorder = join(dir, 'record.cjs')
    fs.writeFileSync(page, PAGE_HTML)
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
    const command = `'${process.execPath}' '${recorder}' '${log}'`

    const { code, stderr } = await new Promise<{ code: number; stderr: string }>((resolve) => {
      execFile(
        'claude',
        [
          '-p',
          [
            `The file ${page} is a tiny test page this test wrote. Its whole content is: ${PAGE_HTML}`,
            `Use the Artifact tool to update the existing artifact at ${PAGE_URL} with that file:`,
            `file_path ${page}, url ${PAGE_URL}. Read that artifact first if the tool asks you to.`,
            'Publish to no other URL. Then reply with exactly the word OK.'
          ].join('\n'),
          '--max-turns',
          '8',
          '--allowedTools',
          'Artifact',
          '--permission-prompts',
          'none',
          '--settings',
          JSON.stringify({
            hooks: { PostToolUse: [{ hooks: [{ type: 'command', command }] }] }
          })
        ],
        { cwd: dir, encoding: 'utf8', timeout: 170_000, maxBuffer: 32 * 1024 * 1024 },
        (err, _stdout, stderr) => {
          resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stderr })
        }
      ).stdin?.end()
    })

    expect(code, stderr).toBe(0)

    const calls = fs
      .readFileSync(log, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => decodeHookEvent(JSON.parse(line)) ?? [])
      .flatMap((event) => decodeArtifactCall(event) ?? [])

    // The tool may refuse a first attempt, and the model may publish again: each one that went
    // through is that one page.
    expect(calls.length).toBeGreaterThan(0)

    for (const call of calls) {
      expect(call).toEqual({ kind: 'published', url: PAGE_URL, title: expect.stringMatching(/\S/) })
    }
  }, 180_000)
})
