// Decodes the live interactive sessions kept in the kv table, as an earlier
// daemon (perhaps an older version) wrote them. An unreadable value is none.
import { objects, str } from '../shared/json.decode'
import type { LiveSession } from './live-sessions'

export function decodeLiveSessions(text: string | undefined): LiveSession[] {
  if (!text) return []
  let value: unknown

  try {
    value = JSON.parse(text)
  } catch {
    return []
  }

  return objects(value).flatMap((e): LiveSession[] => {
    const workspaceId = str(e.workspaceId)
    const terminalId = str(e.terminalId)
    const sessionId = str(e.sessionId)
    const cwd = str(e.cwd)

    if (!terminalId || !sessionId) return []

    if (workspaceId) return [{ workspaceId, terminalId, sessionId }]

    // A loose terminal's session, in the folder it started in.
    return cwd ? [{ terminalId, sessionId, cwd }] : []
  })
}
