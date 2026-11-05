// Reads an Artifact PostToolUse hook payload into what it did to a published page, for
// WorkspaceManager.recordArtifact. The payload is untrusted: only these fields count, a URL must pass isArtifactUrl,
// and anything else (a read, a pin, an asset upload, a failed call) is nothing to record.
import { isArtifactUrl } from '../shared/artifact-url'
import { fieldsOf, type Obj, str } from '../shared/json.decode'
import type { HookEvent } from '../shared/protocol'

const TITLE_MAX = 200

export type ArtifactCall =
  | { kind: 'published'; url: string; title: string }
  | { kind: 'deleted'; url: string }

const artifactUrl = (v: unknown): string | null => {
  const url = str(v)

  return url !== undefined && isArtifactUrl(url) ? url : null
}

/** A page published: not an asset upload, and a response naming the URL and a title. */
function published(input: Obj, response: Obj): ArtifactCall | null {
  const url = artifactUrl(response.url)
  const title = str(response.title)?.trim().slice(0, TITLE_MAX)

  return input.asset !== true && url && title ? { kind: 'published', url, title } : null
}

/** A page deleted: not one asset of it (`path`), and a response saying the delete happened. */
function deleted(input: Obj, response: Obj): ArtifactCall | null {
  const outcome = fieldsOf(response.artifact_delete)
  const url = artifactUrl(outcome.url)

  return input.path === undefined && outcome.deleted === true && url
    ? { kind: 'deleted', url }
    : null
}

/** The page an Artifact PostToolUse published or deleted; null for any other event, tool or action. */
export function decodeArtifactCall(event: HookEvent): ArtifactCall | null {
  if (event.hook_event_name !== 'PostToolUse' || event.tool_name !== 'Artifact') return null
  const input = event.tool_input ?? {}
  const response = fieldsOf(event.tool_response)

  if (input.action === undefined || input.action === 'publish') return published(input, response)

  return input.action === 'delete' ? deleted(input, response) : null
}
