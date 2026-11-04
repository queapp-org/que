// Decodes the marker a clicked Restart leaves for the next launch.
import { isObj } from '../shared/json.decode'

/** QUE_HOME/state/update-restart.json: a Restart was clicked, and when. */
export interface RestartMarker {
  /** Epoch ms of the click. */
  at: number
}

/** The marker; null without a numeric `at`. */
export function decodeRestartMarker(v: unknown): RestartMarker | null {
  if (!isObj(v) || typeof v.at !== 'number') return null

  return { at: v.at }
}
