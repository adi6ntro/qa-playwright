import { defineConfig, devices } from '@playwright/test';
import 'dotenv/config';

/**
 * Shared config for both suites against dev.reporty.sa (each new suite gets
 * its own scenarios/<suite-name>/ folder — same pattern, add more freely):
 *  - scenarios/inbox-marketing/*  — Inbox + Marketing (WhatsApp Cloud API)
 *  - scenarios/maha-instructions/* — Maha "AI Instructions" (MyFacility wizard)
 * See docs/handover/QA_Checklist_Inbox_Marketing_WhatsApp.md (Inbox/Marketing)
 * and docs/handover/QA_Runbook_Reporty_In-App_Maha_Integration_Test.md (Maha),
 * both in reporty-web-backup, for the manual counterparts and known-gaps.
 *
 * Two projects:
 *  - "setup"    : runs auth/login-setup.ts once, headed, to establish a real
 *                 logged-in session (handles the invisible reCAPTCHA on
 *                 /login, which cannot be solved unattended). Saves
 *                 storageState to auth/.storage-state.json. Shared by both
 *                 suites — same login, same app, one captcha solve for both.
 *  - "chromium" : the actual scenario specs, reusing the saved storage state
 *                 so no login flow (and no captcha) has to run per test.
 */
export default defineConfig({
  testDir: '.',
  // 90s ceiling because Maha AI replies have been observed taking up to
  // ~45s; Inbox/Marketing tests finish well under this, so the higher
  // ceiling only costs time on an actual failure there, not on every run.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    ['json', { outputFile: 'reports/playwright-run.json' }],
  ],
  use: {
    baseURL: process.env.BASE_URL || 'https://dev.reporty.sa',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'setup',
      testMatch: /auth\/login-setup\.ts/,
      // channel: 'chrome' launches the system-installed Google Chrome instead
      // of downloading Playwright's own bundled Chromium — some networks
      // can't reach storage.googleapis.com for `playwright install`. Drop
      // the channel option if that's not a problem on your machine.
      use: { ...devices['Desktop Chrome'], channel: 'chrome', headless: false },
    },
    {
      // Deliberately NOT declared as depending on "setup" — login has an
      // invisible reCAPTCHA that may need a one-time manual solve (see
      // auth/login-setup.ts), so it's run explicitly via `npm run login-setup`,
      // not automatically before every test run. If auth/.storage-state.json
      // doesn't exist yet, run login-setup first.
      name: 'chromium',
      testMatch: /scenarios\/.*\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',
        storageState: 'auth/.storage-state.json',
      },
    },
  ],
});
