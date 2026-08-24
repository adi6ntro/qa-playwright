import { test, expect } from '@playwright/test';
import { gotoAiInstructionStep, getInstructionPanelState } from '../../helpers/maha-chat';
import { deleteMarkerUntilGone } from '../../helpers/bug005-probe';

/**
 * Standalone utility — NOT part of the BUG-005 probe itself. Run this by hand
 * whenever `BUG005-baseline` fails with "environment not clean": deletes any
 * `[BUG005_TEST_*]` marker rows still in the panel (leftovers from a run
 * whose own in-test cleanup didn't stick — itself a BUG-005 symptom, since
 * delete is a write) so the next real run can start from a clean baseline.
 * Should rarely be needed now that T10/T11/T12's own cleanup in
 * section-bug005-false-success.spec.ts retries via the same
 * deleteMarkerUntilGone helper — kept as a manual escape hatch.
 *
 * `npm run cleanup:bug005`
 */
test('delete leftover BUG005_TEST_* markers so BUG005-baseline can pass', async ({ page }) => {
  test.setTimeout(300_000);
  await gotoAiInstructionStep(page);

  const before = await getInstructionPanelState(page);
  const leftovers = before.rows.filter((r) => /\[BUG005_TEST_[A-Z0-9]+/i.test(r.text));

  if (leftovers.length === 0) {
    console.log('No leftover BUG005_TEST_* markers found — panel is already clean.');
    return;
  }

  console.log(`Found ${leftovers.length} leftover marker(s): ${leftovers.map((r) => r.text).join(' | ')}`);

  const stillThere: string[] = [];
  for (const row of leftovers) {
    const marker = row.text.match(/\[BUG005_TEST_[A-Z0-9]+\]/i)?.[0] ?? row.text;
    const outcome = await deleteMarkerUntilGone(page, marker);
    if (!outcome.success) stillThere.push(row.text);
  }

  console.log(
    stillThere.length === 0
      ? 'All leftover markers deleted and confirmed gone after refresh.'
      : `Still present after retries (re-run this script, or delete by hand): ${stillThere.join(' | ')}`
  );

  expect(stillThere, 'leftover markers must be gone after refresh').toHaveLength(0);
});
