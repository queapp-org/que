import { describe, expect, it } from 'vitest'
import type { HookEvent } from '@shared/protocol'
import { makeHookEvent } from '../testing/fixtures'
import { decodeArtifactCall } from './artifacts.decode'

const PAGE = 'https://claude.ai/artifact/Bo2pUji8XumREbCYMXcoMe'
const CODE_PAGE = 'https://claude.ai/code/artifact/5768b884-1a29-46c3-8310-2ec1eb4d163d'
const TITLE = 'que Artifacts Pane'

/** A real publish's response, as a live hook event reported it. */
const PUBLISH_RESPONSE = {
  url: PAGE,
  path: '/tmp/x/page.html',
  artifact_id: '5768b884-1a29-46c3-8310-2ec1eb4d163d',
  title: TITLE,
  updated: true,
  owned: true,
  audience: 'owner',
  seq: 10,
  version: '1793839146-44fa'
}

/** A real delete's response. */
const DELETE_RESPONSE = { artifact_delete: { url: PAGE, deleted: true } }

/** An Artifact PostToolUse as Claude Code reports it. */
const call = (
  input: Record<string, unknown>,
  response: unknown,
  extra: Partial<HookEvent> = {}
): HookEvent =>
  makeHookEvent('PostToolUse', {
    tool_name: 'Artifact',
    tool_input: input,
    tool_response: response,
    ...extra
  })

describe('decodeArtifactCall', () => {
  describe('published', () => {
    it.each<[string, HookEvent, string, string]>([
      ['the captured publish', call({ file_path: 'page.html' }, PUBLISH_RESPONSE), PAGE, TITLE],
      [
        'an update of a known URL',
        call({ file_path: 'page.html', url: PAGE }, { ...PUBLISH_RESPONSE, updated: true }),
        PAGE,
        TITLE
      ],
      [
        'one created from a type',
        call(
          { type_url: 'https://claude.ai/artifact/type', title: TITLE },
          { created_from_type: true, url: PAGE, version: '1', owned: true, title: TITLE }
        ),
        PAGE,
        TITLE
      ],
      [
        'a /code/artifact/ URL',
        call({ file_path: 'page.html' }, { ...PUBLISH_RESPONSE, url: CODE_PAGE }),
        CODE_PAGE,
        TITLE
      ],
      [
        "action: 'publish'",
        call({ action: 'publish', file_path: 'page.html' }, PUBLISH_RESPONSE),
        PAGE,
        TITLE
      ],
      [
        'one from a subagent',
        call({ file_path: 'page.html' }, PUBLISH_RESPONSE, {
          agent_id: 'a3f9c2e1',
          agent_type: 'general-purpose'
        }),
        PAGE,
        TITLE
      ],
      [
        'a title with space around it',
        call({ file_path: 'page.html' }, { ...PUBLISH_RESPONSE, title: `  ${TITLE}\n` }),
        PAGE,
        TITLE
      ],
      [
        'a title over 200 characters',
        call({ file_path: 'page.html' }, { ...PUBLISH_RESPONSE, title: 'x'.repeat(201) }),
        PAGE,
        'x'.repeat(200)
      ]
    ])('reads %s', (_name, event, url, title) => {
      expect(decodeArtifactCall(event)).toEqual({ kind: 'published', url, title })
    })
  })

  describe('deleted', () => {
    it('reads the captured delete', () => {
      expect(decodeArtifactCall(call({ action: 'delete', url: PAGE }, DELETE_RESPONSE))).toEqual({
        kind: 'deleted',
        url: PAGE
      })
    })
  })

  describe('nothing to record', () => {
    const readLike = { ...PUBLISH_RESPONSE }

    it.each<[string, HookEvent]>([
      [
        'a delete of one asset (path)',
        call({ action: 'delete', url: PAGE, path: 'a1b2c3' }, DELETE_RESPONSE)
      ],
      [
        'a delete that did not happen',
        call({ action: 'delete', url: PAGE }, { artifact_delete: { url: PAGE, deleted: false } })
      ],
      ['a delete with no artifact_delete', call({ action: 'delete', url: PAGE }, readLike)],
      [
        'a delete of a URL that fails the rule',
        call(
          { action: 'delete', url: PAGE },
          { artifact_delete: { url: 'https://evil.example/artifact/x', deleted: true } }
        )
      ],
      ['read', call({ action: 'read', url: PAGE }, readLike)],
      ['list', call({ action: 'list' }, readLike)],
      ['open', call({ action: 'open', url: PAGE }, readLike)],
      ['pin', call({ action: 'pin', url: PAGE }, readLike)],
      ['unpin', call({ action: 'unpin', url: PAGE }, readLike)],
      ['quickstart', call({ action: 'quickstart', intent: 'other' }, readLike)],
      ['an asset upload', call({ url: PAGE, file_path: 'a.png', asset: true }, readLike)],
      [
        'PreToolUse',
        makeHookEvent('PreToolUse', {
          tool_name: 'Artifact',
          tool_input: { file_path: 'page.html' },
          tool_response: PUBLISH_RESPONSE
        })
      ],
      [
        'PostToolUseFailure',
        makeHookEvent('PostToolUseFailure', {
          tool_name: 'Artifact',
          tool_input: { file_path: 'page.html' },
          tool_response: PUBLISH_RESPONSE
        })
      ],
      ['another tool', call({ file_path: 'page.html' }, PUBLISH_RESPONSE, { tool_name: 'Write' })],
      ['a string response', call({ file_path: 'page.html' }, `Published ${PAGE}`)],
      ['no response', call({ file_path: 'page.html' }, undefined)],
      [
        'a missing title',
        call({ file_path: 'page.html' }, { ...PUBLISH_RESPONSE, title: undefined })
      ],
      ['a blank title', call({ file_path: 'page.html' }, { ...PUBLISH_RESPONSE, title: ' \n ' })],
      [
        'a URL that fails the rule',
        call({ file_path: 'page.html' }, { ...PUBLISH_RESPONSE, url: 'javascript:alert(1)' })
      ]
    ])('ignores %s', (_name, event) => {
      expect(decodeArtifactCall(event)).toBeNull()
    })
  })
})
