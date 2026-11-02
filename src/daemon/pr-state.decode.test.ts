import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addFakePullRequest,
  FAKES_BIN,
  fakeCheckRun,
  fakeStatusContext,
  setFakePullRequest
} from '../testing/fakes'
import { decodeCheckRollup, decodePullRequest, decodePullRequests, FIELDS } from './pr-state.decode'

describe('decodePullRequest', () => {
  let dir: string
  let prsFile: string

  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'que-pr-decode-'))
    prsFile = join(dir, 'prs.json')
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /** What the fake gh prints for `pr list --head <branch> --json ...`. */
  const ghPrList = (branch: string): string =>
    execFileSync(
      process.execPath,
      [join(FAKES_BIN, 'gh'), 'pr', 'list', '--head', branch, '--json', FIELDS],
      { encoding: 'utf8', env: { ...process.env, QUE_FAKE_GH_PRS: prsFile } }
    )

  it('decodes what gh pr list prints, check runs and commit statuses included', () => {
    setFakePullRequest(prsFile, 'APP-1432-retry-logic', {
      number: 42,
      url: 'https://github.com/rquellh/que/pull/42',
      title: 'Add retry logic',
      isDraft: false,
      reviewDecision: 'CHANGES_REQUESTED',
      updatedAt: '2026-10-14T03:30:00Z',
      additions: 128,
      deletions: 17,
      statusCheckRollup: [
        fakeCheckRun({
          name: 'unit tests',
          conclusion: 'FAILURE',
          detailsUrl: 'https://github.com/rquellh/que/actions/runs/11'
        }),
        fakeStatusContext({ context: 'deploy/preview', state: 'PENDING' })
      ]
    })

    const [item] = JSON.parse(ghPrList('APP-1432-retry-logic')) as unknown[]

    expect(decodePullRequest(item)).toEqual({
      number: 42,
      url: 'https://github.com/rquellh/que/pull/42',
      title: 'Add retry logic',
      state: 'OPEN',
      isDraft: false,
      mergedAt: null,
      reviewDecision: 'CHANGES_REQUESTED',
      updatedAt: '2026-10-14T03:30:00Z',
      additions: 128,
      deletions: 17,
      baseRefName: 'main',
      headRefName: 'APP-1432-retry-logic',
      checks: [
        {
          kind: 'run',
          name: 'unit tests',
          workflowName: 'CI',
          status: 'COMPLETED',
          conclusion: 'FAILURE',
          detailsUrl: 'https://github.com/rquellh/que/actions/runs/11',
          startedAt: '2026-10-14T02:58:00Z',
          completedAt: '2026-10-14T02:59:21Z'
        },
        {
          kind: 'status',
          name: 'deploy/preview',
          state: 'PENDING',
          targetUrl: null,
          createdAt: '2026-10-14T03:00:00Z'
        }
      ]
    })
  })

  it('reads missing optional fields as empty, and a missing rollup as not asked for', () => {
    expect(decodePullRequest({ number: 7, url: 'https://github.com/rquellh/que/pull/7' })).toEqual({
      number: 7,
      url: 'https://github.com/rquellh/que/pull/7',
      title: '',
      state: '',
      isDraft: false,
      mergedAt: null,
      reviewDecision: '',
      updatedAt: null,
      additions: null,
      deletions: null,
      baseRefName: '',
      headRefName: '',
      checks: null
    })
  })

  it('reads mistyped line counts as unknown', () => {
    const raw = decodePullRequest({
      number: 7,
      url: 'https://github.com/rquellh/que/pull/7',
      additions: '12',
      deletions: null
    })

    expect(raw).toMatchObject({ additions: null, deletions: null })
  })

  it.each([
    [null],
    ['text'],
    [[{ number: 7, url: 'https://github.com/rquellh/que/pull/7' }]],
    [{ url: 'https://github.com/rquellh/que/pull/7' }],
    [{ number: 1 }],
    [{ number: 1, url: '' }],
    [{ number: '1', url: 'https://github.com/rquellh/que/pull/1' }]
  ])('drops %j', (raw) => {
    expect(decodePullRequest(raw)).toBeNull()
  })
})

describe('decodePullRequests', () => {
  let dir: string
  let prsFile: string

  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'que-pr-decode-'))
    prsFile = join(dir, 'prs.json')
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('decodes every pull request gh prints for a branch that carries two', () => {
    setFakePullRequest(prsFile, 'APP-1432-retry-logic', {
      number: 41,
      url: 'https://github.com/rquellh/que/pull/41',
      state: 'MERGED',
      isDraft: false,
      mergedAt: '2026-10-13T22:10:00Z',
      additions: 40,
      deletions: 3
    })
    addFakePullRequest(prsFile, 'APP-1432-retry-logic', {
      title: 'Retry the uploader on 503',
      isDraft: false,
      additions: 9,
      deletions: 1
    })

    const printed = execFileSync(
      process.execPath,
      [join(FAKES_BIN, 'gh'), 'pr', 'list', '--head', 'APP-1432-retry-logic', '--json', FIELDS],
      { encoding: 'utf8', env: { ...process.env, QUE_FAKE_GH_PRS: prsFile } }
    )

    expect(decodePullRequests(JSON.parse(printed))).toMatchObject([
      {
        number: 42,
        url: 'https://github.com/rquellh/que/pull/42',
        title: 'Retry the uploader on 503',
        state: 'OPEN',
        additions: 9,
        deletions: 1
      },
      {
        number: 41,
        state: 'MERGED',
        mergedAt: '2026-10-13T22:10:00Z',
        additions: 40,
        deletions: 3
      }
    ])
  })

  it.each([[null], ['text'], [{ number: 7 }]])('reads %j as no pull requests', (raw) => {
    expect(decodePullRequests(raw)).toEqual([])
  })

  it('drops the items it cannot decode and keeps the rest', () => {
    expect(
      decodePullRequests([
        { number: 7 },
        { number: 8, url: 'https://github.com/rquellh/que/pull/8' }
      ])
    ).toMatchObject([{ number: 8 }])
  })
})

describe('decodeCheckRollup', () => {
  it('tells the two shapes apart without __typename', () => {
    expect(
      decodeCheckRollup([
        { name: 'lint', status: 'IN_PROGRESS', conclusion: null },
        { context: 'ci/legacy', state: 'ERROR' }
      ])
    ).toEqual([
      {
        kind: 'run',
        name: 'lint',
        workflowName: null,
        status: 'IN_PROGRESS',
        conclusion: '',
        detailsUrl: null,
        startedAt: null,
        completedAt: null
      },
      { kind: 'status', name: 'ci/legacy', state: 'ERROR', targetUrl: null, createdAt: null }
    ])
  })

  it.each([
    [undefined],
    [null],
    ['text'],
    [{ name: 'build' }],
    [[null, 'x', 3, [], { id: 1 }, { name: 'build' }]]
  ])('drops garbage %j', (rollup) => {
    expect(decodeCheckRollup(rollup)).toEqual([])
  })
})
