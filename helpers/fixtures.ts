import { test as base, type Page } from '@playwright/test';
import { gotoAiInstructionStep } from './maha-chat';

/**
 * Many runbook test cases explicitly depend on state left behind by an
 * earlier one in the same section (e.g. B12 "update_instruction" requires
 * TEST_RULE_2026 from B11 to still be saved). To match that, all tests in a
 * spec file share ONE browser page/session via this worker-scoped fixture,
 * instead of Playwright's default of a fresh context per test.
 *
 * This requires `workers: 1` in playwright.config.ts (already set) so every
 * test in a run actually lands on the same worker and reuses this fixture
 * instance, and `fullyParallel: false` + describe.serial in each spec file
 * so tests run in the written order, not shuffled.
 */
export const test = base.extend<{}, { sharedPage: Page }>({
  sharedPage: [
    async ({ browser }, use) => {
      const context = await browser.newContext({ storageState: 'auth/.storage-state.json' });
      const page = await context.newPage();
      await gotoAiInstructionStep(page);
      await use(page);
      await context.close();
    },
    // 2026-08-07: explicit override — this fixture's setup otherwise inherits
    // the global per-test 90_000ms timeout, but gotoAiInstructionStep's own
    // wait was just bumped to 60_000ms (see that function's comment), leaving
    // too little headroom for the navigation + click overhead around it.
    { scope: 'worker', timeout: 120_000 },
  ],
});

export { expect } from '@playwright/test';
