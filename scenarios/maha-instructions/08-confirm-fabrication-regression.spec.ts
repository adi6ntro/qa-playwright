import { test, expect } from '@playwright/test';
import { gotoAiInstructionStep, sendMessage, getInstructionPanelState, refreshAndReturnToStep } from '../../helpers/maha-chat';
import { ReportRecorder } from '../../helpers/report';

/**
 * Regression test for the confirm-fabrication bug live-reproduced twice on
 * 2026-09-08 (report: REPORT_ob3_clinic79_confirm_fabrication_bug_2026-09-08.md
 * in reporty-web-backup) and fixed in reporty-onboard-phase3's
 * `inapp_agent/orchestrators/maha_inapp_agent.py`, branch `hotfix/instructions`
 * (uncommitted at the time this test was written — run it locally to verify
 * before committing/deploying, per Adi's explicit "jangan deploy ke dev" call).
 *
 * The trigger, identical in both live incidents: the owner sends a compound
 * instruction, Maha proposes save_instruction and asks for confirmation, and
 * the owner's NEXT message is NOT an affirmation ("ya") — they resend the
 * exact same original message instead (a real, observed user behavior, not a
 * contrived edge case).
 *   - Clinic 79 (prod): the resulting fabricated "technical issue" reply let
 *     the retry loop escape to a REAL open_support_widget call instead of
 *     retrying save_instruction — a spurious support ticket opened and the
 *     instruction was never saved via chat at all. Fixed by Fix #1
 *     (escape-hatch throttle: open_support_widget withheld from the forced
 *     retry's candidate tools on non-final attempts when a real pending
 *     action is available).
 *   - Clinic 611 (prod reproduction, same day): the retry loop stayed on
 *     save_instruction (no support ticket), but produced a soft "received
 *     your instruction, will follow it" reply without actually saving
 *     anything — undetected because the existing _reply_announces_
 *     unexecuted_write gate only fired when NO tool was called at all,
 *     and here save_instruction WAS called (repeatedly, always
 *     confirmation_required). Fixed by Fix #2 (gate broadened to also cover
 *     `proposal_only_tool is not None` — a tool that was called but only
 *     ever armed/re-armed a proposal, never executed).
 *
 * This spec can't see server-side retry-loop internals or which classifier
 * fired — it verifies the two things a browser CAN prove reliably:
 *   1. No `.fo-widget-card` ("Need Help?" support card, see
 *      ai-instruction.js's `open_support` event handler /
 *      _foAiAppendSupportCard) ever appears from this exchange — proves
 *      Fix #1 held.
 *   2. The instruction actually ends up saved AND survives a page refresh —
 *      proves the turn didn't dead-end into a fabricated claim (Fix #2) and
 *      that recovery (a real "ya", possibly more than one round — mirroring
 *      what clinic 611's owner actually had to do) reliably completes.
 *
 * MUST run against a local stack — see the guard right below. Needs BOTH:
 *   - reporty-web-backup: `php artisan serve --port=8000`
 *   - reporty-onboard-phase3: `.venv/bin/python app.py` (port 9559), run from
 *     the branch with Fix #1 + Fix #2 applied (hotfix/instructions as of
 *     2026-09-08) — Flask's debug reloader picks up source edits
 *     automatically, no restart needed after further edits, but the process
 *     must already be running SOME version of the fix before this test can
 *     pass.
 */
const baseURL = process.env.BASE_URL || '';
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/i.test(baseURL)) {
  throw new Error(
    'This spec verifies an uncommitted local fix in reporty-onboard-phase3 (branch hotfix/instructions) — ' +
    'it must run against a LOCAL stack, not dev/prod. Run with BASE_URL=http://localhost:8000, e.g.:\n' +
    '  npm run test:ob3-confirm-regression\n' +
    'after starting both `php artisan serve --port=8000` (reporty-web-backup) and ' +
    '`.venv/bin/python app.py` (reporty-onboard-phase3, port 9559, from the fixed branch).'
  );
}

const recorder = new ReportRecorder('OB3 Confirm-Fabrication Regression (clinic 79 / 611)');
test.afterAll(async () => {
  await recorder.writeTo('reports');
});

// Exact trigger text from both live incidents — deliberately reused verbatim
// so this test reproduces the same shape the real owners hit, not a
// simplified stand-in. "alien" is an easy, unambiguous marker to search the
// instruction panel for afterward.
const ORIGINAL_MESSAGE = 'jangan bahas alien dan sampaikan kami tau alien tapi tidak bahas itu';
const MARKER = 'alien';
const MAX_CONFIRM_ROUNDS = 4;

test.describe('Resend-instead-of-confirm must not fabricate a support ticket or silently drop the write', () => {
  test('clinic 79/611 regression — Fix #1 (escape-hatch throttle) + Fix #2 (unexecuted-write detection)', async ({ browser }) => {
    // Local dev's real handle_message() round trip can take a while — same
    // reasoning as the ob4-crm-export specs' own timeout bump.
    test.setTimeout(180_000);

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);

    const before = await getInstructionPanelState(page);

    // Turn 1: propose. Expect a confirmation question, nothing saved yet.
    const reply1 = await sendMessage(page, ORIGINAL_MESSAGE);

    // Turn 2: resend the SAME message instead of confirming — the exact
    // trigger from both live incidents. Deliberately NOT "ya".
    const reply2 = await sendMessage(page, ORIGINAL_MESSAGE);

    // Fix #1 check: a fabricated "technical issue" excuse must never escape
    // into a REAL open_support_widget call. That event renders a
    // `.fo-widget-card` ("Need Help?") in the chat — see ai-instruction.js.
    const supportCardCount = await page.locator('.fo-widget-card').count();

    // Recovery: mirrors what clinic 611's owner actually had to do (a real
    // "ya", possibly more than once). The fix's job is to make this
    // reliably WORK — it does not promise turn 2 alone saves it.
    let lastReply = reply2;
    let confirmRounds = 0;
    while (confirmRounds < MAX_CONFIRM_ROUNDS) {
      const state = await getInstructionPanelState(page);
      if (state.rows.some((r) => r.text.toLowerCase().includes(MARKER))) break;
      lastReply = await sendMessage(page, 'ya');
      confirmRounds += 1;
    }

    const afterChat = await getInstructionPanelState(page);
    const savedInChat = afterChat.rows.some((r) => r.text.toLowerCase().includes(MARKER));

    const afterRefresh = await refreshAndReturnToStep(page);
    const persisted = afterRefresh.rows.some((r) => r.text.toLowerCase().includes(MARKER));

    recorder.record({
      id: 'OB3-REGR-01',
      tool: 'save_instruction — confirm-fabrication regression (clinic 79/611)',
      trigger: `"${ORIGINAL_MESSAGE}" then resent verbatim (not "ya")`,
      result: supportCardCount === 0 && savedInChat && persisted ? 'PASS' : 'FAIL',
      evidence:
        `reply1="${reply1.text}" | reply2="${reply2.text}" | support_card_count=${supportCardCount} | ` +
        `confirm_rounds_needed=${confirmRounds} | last_reply="${lastReply.text}" | ` +
        `before_count=${before.count} after_count=${afterChat.count} saved_in_chat=${savedInChat} persisted=${persisted}`,
      confirmRoundsNeeded: confirmRounds,
      persisted,
    });

    expect(
      supportCardCount,
      'a resend-instead-of-confirm turn must never escape to a fabricated open_support_widget call (Fix #1)'
    ).toBe(0);
    expect(
      savedInChat,
      'the instruction must actually reach save_instruction and succeed, not dead-end (Fix #1 / Fix #2)'
    ).toBe(true);
    expect(
      persisted,
      'the save must survive a page refresh, not just look successful in chat'
    ).toBe(true);

    // Cleanup — best-effort, so repeated local runs don't pile up junk rules.
    if (persisted) {
      await sendMessage(page, `hapus instruksi yang berhubungan dengan ${MARKER}`);
      await sendMessage(page, 'ya');
    }

    await context.close();
  });
});
