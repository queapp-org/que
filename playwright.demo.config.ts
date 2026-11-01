// The quiet-mode demo recording (`npm run demo:gif`), apart from the e2e suite: its own directory
// and file pattern, so `npm run e2e` and CI never run it.
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/demo',
  testMatch: '*.demo.ts',
  timeout: 240_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results/demo-artifacts'
})
