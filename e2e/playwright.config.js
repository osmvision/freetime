// End-to-end tests of the UI, run against the web version: the same UI as the desktop app,
// served by `freetime-web`. The browser keeps all the state, so each test starts as a new user.
//
//   cd e2e && npm ci && npx playwright install chromium && npm test
//
// The server is built and started for you (first run: a few minutes for cargo).

import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // English labels, whatever the machine's language: the tests look for them by name.
    locale: 'en-US',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm --prefix web run build && cargo run --locked -p freetime-web',
    cwd: '..',
    url: `http://127.0.0.1:${PORT}/`,
    env: { FREETIME_WEB_BIND: `127.0.0.1:${PORT}` },
    timeout: 15 * 60 * 1000,
    reuseExistingServer: !process.env.CI,
  },
});
