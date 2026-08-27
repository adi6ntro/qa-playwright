import { test, expect } from '@playwright/test';
import { gotoAiInstructionStep, getInstructionPanelState } from '../../helpers/maha-chat';
import { deleteMarkerUntilGone } from '../../helpers/bug005-probe';

/**
 * Standalone utility, same shape as 01-cleanup-leftover-markers.spec.ts but for
 * the ETM suite's own marker. Run it whenever `ETM-0` reports a leftover
 * `ETM_TEST_*` rule from an interrupted run. A leftover matters for two reasons:
 * ETM-0 will MERGE its new rule into the near-identical leftover instead of
 * creating its own (observed live: panel_count 6->6, Maha answering
 * "أصبحت مكررة"), and ETM-1 then compares against the wrong baseline.
 *
 * `npm run cleanup:maha-etm`
 */
/**
 * Prefix, not a fixed marker: the ETM suite mints a unique `ETM_TEST_<base36>`
 * per run, so a sweep has to match the family rather than one literal string.
 */
const MARKER = 'ETM_TEST';

test(`delete leftover ${MARKER} rules so the ETM suite can start from a clean baseline`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  await gotoAiInstructionStep(page);

  const before = await getInstructionPanelState(page);
  const leftovers = before.rows.filter((r) => r.text.includes(MARKER));

  if (leftovers.length === 0) {
    console.log(`No leftover ${MARKER} rules found — panel is already clean.`);
    return;
  }

  console.log(`Found ${leftovers.length} leftover ${MARKER} rule(s).`);
  const outcome = await deleteMarkerUntilGone(page, MARKER);

  const after = await getInstructionPanelState(page);
  const stillThere = after.rows.filter((r) => r.text.includes(MARKER));

  console.log(
    stillThere.length === 0
      ? `Deleted after ${outcome.attempts} attempt(s) and confirmed gone.`
      : `Still present after ${outcome.attempts} attempts — re-run this, or delete by hand.`
  );

  expect(stillThere, `${MARKER} rules must be gone`).toHaveLength(0);
});
