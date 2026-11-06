// Fixture factories for node-side tests (logic and daemon integration).
// Realistic values, opaque ids, typed against the real shared types.
import type { HookEvent, HookEventName } from '@shared/protocol'
import { defaultConfig, defaultQuietHours } from '@shared/config'
import type { QuietHoursConfig, UserConfig } from '@shared/types'

export {
  makeBackgroundTask,
  makePrCheck,
  makePrThreadEntry,
  makeQuietState,
  makeTicket,
  makeWorkspace
} from './entities'

let sessionCounter = 0

/** A realistic Claude Code hook payload. Per-event fields go in overrides. */
export function makeHookEvent(name: HookEventName, overrides: Partial<HookEvent> = {}): HookEvent {
  sessionCounter += 1
  const sessionId = overrides.session_id ?? `sess_${sessionCounter.toString(16).padStart(6, '0')}`

  return {
    hook_event_name: name,
    session_id: sessionId,
    cwd: '/Users/dev/.que/worktrees/que/APP-1432-retry-logic',
    transcript_path: `/Users/dev/.claude/projects/-Users-dev--que-worktrees-que-APP-1432-retry-logic/${sessionId}.jsonl`,
    permission_mode: 'default',
    ...overrides
  }
}

/** A fully-defaulted user config (quiet hours 19:00-07:00, caps, a five-minute stall timeout). */
export function makeConfig(overrides: Partial<UserConfig> = {}): UserConfig {
  return { ...defaultConfig({ queHome: '/Users/dev/.que' }), ...overrides }
}

/** Quiet hours as configured: the defaults with overrides. */
export function makeQuietHours(overrides: Partial<QuietHoursConfig> = {}): QuietHoursConfig {
  return { ...defaultQuietHours(), ...overrides }
}
