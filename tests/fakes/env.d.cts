// Types for env.cjs (the shared isolated test environment).
export interface FakeEnv {
  QUE_HOME: string
  QUE_CONFIG: string
  PATH: string
  QUE_FAKE_CLAUDE_LOG: string
  QUE_FAKE_CLAUDE_TRANSCRIPT_DIR: string
  QUE_FAKE_GH_LOG: string
  QUE_FAKE_GH_PRS: string
  QUE_FAKE_ACLI_LOG: string
  QUE_FAKE_ACLI_TICKETS: string
  QUE_FAKE_OPEN_LOG: string
  QUE_FAKE_WRAPPER_LOG: string
  GIT_CONFIG_GLOBAL: string
  GIT_CONFIG_NOSYSTEM: string
}

export const QUIET_OFF: string

export function fakeEnv(home: string, pathPrefix?: string[]): FakeEnv
export function writeGitconfig(home: string, name: string): void
