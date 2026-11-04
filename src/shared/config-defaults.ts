// The config defaults, apart from config.ts so the renderer (its test
// fixtures and fake bridge) can use them: no Node imports.
import type {
  JiraConfig,
  NotificationsConfig,
  QuietHoursConfig,
  TerminalConfig,
  UserConfig
} from './types'

/** Every default, with worktrees under `worktreeRoot` (config.ts's defaultConfig puts it in QUE_HOME). */
export function configDefaults(worktreeRoot: string): UserConfig {
  return {
    worktreeRoot,
    stallTimeoutMinutes: 5,
    teardownTimeoutSeconds: 60,
    statusPollSeconds: 10,
    prPollSeconds: 60,
    repos: {},
    allowBypassPermissions: false,
    protectedBranches: ['main', 'master', 'release'],
    quietHours: defaultQuietHours(),
    notifications: defaultNotifications(),
    terminal: defaultTerminal(),
    jira: defaultJira(),
    // Empty: claude starts on the brief itself.
    startPrompt: ''
  }
}

export function defaultQuietHours(): QuietHoursConfig {
  return { enabled: true, default: { start: '19:00', end: '07:00' }, days: {}, unlockMinutes: 20 }
}

export const DEFAULT_JQL =
  'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC'

export const DEFAULT_START_PROMPT =
  'Read .que/ticket.md, the ticket this workspace is for. Restate the goal in a sentence, look at the code it touches, and propose a plan before changing anything.'

export function defaultJira(): JiraConfig {
  return {
    jql: DEFAULT_JQL,
    pollMinutes: 5,
    site: null,
    startPrompt: DEFAULT_START_PROMPT,
    projects: {}
  }
}

export function defaultTerminal(): TerminalConfig {
  return { optionAsMeta: true }
}

export function defaultNotifications(): NotificationsConfig {
  return {
    chimeOnComplete: true,
    chimeOnNeedsInput: false,
    chimeInManualQuiet: false,
    morningSummary: false
  }
}
