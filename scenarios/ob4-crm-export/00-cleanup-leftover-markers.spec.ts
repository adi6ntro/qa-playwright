import { test, expect } from '@playwright/test';
import { gotoAiInstructionStep, getInstructionPanelState } from '../../helpers/maha-chat';
import { deleteMarkerUntilGone } from '../../helpers/bug005-probe';
import '../../helpers/ob4-local-guard'; // throws if BASE_URL isn't local — see that file for why

/**
 * Standalone utility — NOT run automatically as part of the suite. Deletes any
 * leftover `TC_P3_01_TEST_RULE` marker rows from 01-part3-runtime-context.spec.ts's
 * TC-P3-01, which deliberately does NOT clean up after itself inline (matching
 * scenarios/maha-instructions/03-section-b-instructions.spec.ts's B11 convention —
 * see that test's own comment for why: an inline delete+confirm cycle on top of
 * the add+confirm cycle it already needs pushed a first version of this test past
 * even a 180s per-test timeout, live-reproduced 2026-09-05).
 *
 * Run this occasionally, or whenever you've been re-running TC-P3-01 repeatedly
 * during development and want the test clinic's instruction list back to clean.
 *
 * `npm run cleanup:ob4`
 */
test.use({ storageState: 'auth/.storage-state.local.json' }); // NOT the project default (dev.reporty.sa session) — this suite is local-only

test('delete leftover TC_P3_01_TEST_RULE markers', async ({ page }) => {
  test.setTimeout(300_000);
  await gotoAiInstructionStep(page);

  const before = await getInstructionPanelState(page);
  const leftovers = before.rows.filter((r) => r.text.includes('TC_P3_01_TEST_RULE'));

  if (leftovers.length === 0) {
    console.log('No leftover TC_P3_01_TEST_RULE markers found — panel is already clean.');
    return;
  }

  console.log(`Found ${leftovers.length} leftover marker(s): ${leftovers.map((r) => r.text).join(' | ')}`);

  const stillThere: string[] = [];
  for (const row of leftovers) {
    const outcome = await deleteMarkerUntilGone(page, 'TC_P3_01_TEST_RULE');
    if (!outcome.success) stillThere.push(row.text);
  }

  console.log(
    stillThere.length === 0
      ? 'All leftover markers deleted and confirmed gone after refresh.'
      : `Still present after retries (re-run this script, or delete by hand): ${stillThere.join(' | ')}`
  );

  expect(stillThere, 'leftover markers must be gone after refresh').toHaveLength(0);
});
