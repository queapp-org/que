// Runs before every file of the `node` project (vitest.config.ts). A test run
// started from a que terminal inherits that terminal's variables: its
// workspace, the live daemon's socket and home, the session's instructions
// file. None of them belong to a test, so they go, and the run sees what CI
// sees (#140). Deleted rather than stubbed: vi.unstubAllEnvs() in a test's
// teardown would bring a stubbed variable back.
import { QUE_TERMINAL_MARKERS } from '@shared/env'

for (const name of [...QUE_TERMINAL_MARKERS, 'QUE_TERMINAL', 'QUE_HOME']) delete process.env[name]
