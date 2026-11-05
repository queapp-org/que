// Keeps Workspace.artifacts from hook events: a page the session or a subagent publishes is
// recorded and one it deletes is dropped, as prs.ts records `gh pr create`. Nothing polls.
import type { HookEvent } from '../shared/protocol'
import { decodeArtifactCall } from './artifacts.decode'
import type { EventBus } from './bus'
import type { Store } from './store'
import type { WorkspaceManager } from './workspaces'

export interface ArtifactDeps {
  store: Store
  workspaces: WorkspaceManager
  bus: EventBus
  log(message: string): void
}

/** Applies the Artifact call a hook event shows, if any, and announces a list that changed. */
export function recordArtifact(deps: ArtifactDeps, id: string, event: HookEvent): void {
  const call = decodeArtifactCall(event)

  if (!call) return

  const changed =
    call.kind === 'published'
      ? deps.store.publishWorkspaceArtifact(id, call.url, call.title, new Date().toISOString())
      : deps.store.removeWorkspaceArtifact(id, call.url)

  if (!changed) return
  deps.log(`workspace ${id} ${call.kind} ${call.url}`)
  deps.bus.emit('workspace.updated', deps.workspaces.get(id))
}
