import { test, expect } from '@playwright/test';
import { gotoAiInstructionStep, sendAndConfirm } from '../../helpers/maha-chat';
import { ReportRecorder } from '../../helpers/report';
import '../../helpers/ob4-local-guard'; // throws if BASE_URL isn't local — see that file for why

/**
 * Covers RMD-03 (`staff_reminder_cancel`) from QA_TestScript_Phase4_CRM_Export.md,
 * TC-RMD03-01..04. See 24-rmd01-self-reminder.spec.ts's header for the shared RMD
 * background.
 *
 * ⚠️ TC-RMD03-03 IS A REAL, CONFIRMED, UNFIXED AUTHORIZATION GAP, NOT AN ORDINARY
 * NEGATIVE TEST. Confirmed by reading `cancel_reminder()`/`mark_reminder_done()`
 * directly (staff_reminders.py:228+) and by the doc's own release-plan callout
 * (QA_TestScript_Phase4_CRM_Export.md lines ~40-54, 2313-2312): both functions scope
 * their `WHERE id = %s AND user_id = %s` check to `user_id = clinic_id` (the clinic
 * OWNER), never to "the specific staff member who created or is targeted by this
 * reminder" — because acting_user_id doesn't reach any tool call yet. Concretely: the
 * tool has NO parameter at all for "who is asking" beyond which clinic. This means any
 * authenticated staff member in the SAME clinic (branch_admin, another branch_admin,
 * anyone) can cancel or mark-done ANY other staff's personal reminder. Not a
 * cross-tenant leak — clinics stay isolated from each other — but a real within-clinic
 * privacy/authorization gap, confirmed still present in code as of 2026-09-06.
 *
 * TC-RMD03-03 below tests this for real (one staff creates a reminder targeting a
 * second staff, a THIRD staff attempts to cancel it) and reports the actual observed
 * outcome as PASS/FAIL — not softened to NEEDS_REVIEW — per the doc's own instruction:
 * "kalau hasil eksekusi mengonfirmasi staf lain BISA cancel reminder orang lain,
 * laporkan sebagai bug keamanan prioritas tinggi." A second, direct-callAction-only
 * companion test proves the same fact at the tool level, deterministically and
 * independent of any LLM behavior — since the gap is a backend fact, not a prompting
 * one, that direct proof is the most reliable evidence here.
 *
 * Account-gap workaround: the doc's setup needs three distinct staff identities
 * (creator, target, unauthorized third party). This suite only had two real
 * pre-existing accounts (SA, BA) before this file. A second branch_admin-or-any-staff
 * account, in the SAME clinic as the existing BA, is introduced as "Staff C":
 * LOGIN_EMAIL_BA2/LOGIN_PASSWORD_BA2, storage state auth/.storage-state.ba2.local.json
 * (produced automatically by the EXISTING auth/login-setup.ts with
 * `LOGIN_PROFILE=ba2` — that script already generalizes over any profile name via
 * `LOGIN_EMAIL_<PROFILE>`/`LOGIN_PASSWORD_<PROFILE>`, so no code change was needed
 * there; only a new npm alias would be needed centrally, e.g.
 * `login-setup:local-ba2`). The orphaned-staff account
 * (auth/.storage-state.orphan.local.json) was deliberately NOT reused for this: its
 * own precondition (TC-P3-04) requires a `parent_user_id` that matches NO valid
 * clinic, so it would very likely resolve to a DIFFERENT `window.FO.clinicId` than
 * SA/BA's shared clinic — which would test cross-tenant isolation (a different,
 * already-fine concern) instead of the actual within-clinic gap this TC is about.
 */

const recorder = new ReportRecorder('OB4 RMD-03 Cancel Reminder');
test.afterAll(async () => {
  await recorder.writeTo('reports');
});

const STAFF_REMINDERS_SKIP_REASON =
  'Set TEST_STAFF_REMINDERS_CAPABILITY_ENABLED=1 only after manually enabling ' +
  '"phase4Capabilities": {"staff_reminders": "*"} (or this test clinic\'s id) in your ' +
  'LOCAL reporty-onboard-phase3 config.json and restarting app.py.';

function capabilityGate() {
  test.skip(process.env.TEST_STAFF_REMINDERS_CAPABILITY_ENABLED !== '1', STAFF_REMINDERS_SKIP_REASON);
}

async function callAction(
  page: import('@playwright/test').Page,
  clinicId: string,
  action: string,
  params: Record<string, unknown>,
  opts: { branchId?: string } = {}
) {
  const resp = await page.request.post(`http://localhost:9559/clinic/${clinicId}/action`, {
    data: {
      action,
      params,
      session_id: `qa-rmd03-${action}-${Math.floor(Math.random() * 1e9)}`,
      branch_id: opts.branchId,
    },
  });
  return resp.json();
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
function toDateTime(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}
function futureDateTime(hoursAhead = 24): string {
  const d = new Date();
  d.setHours(d.getHours() + hoursAhead);
  return toDateTime(d);
}
function pastDateTime(hoursAgo = 2): string {
  const d = new Date();
  d.setHours(d.getHours() - hoursAgo);
  return toDateTime(d);
}

const TEST_BA_USER_ID_SKIP_REASON =
  'Set TEST_BA_USER_ID to the real numeric users.id of the LOGIN_EMAIL_BA account — needed as a real, ' +
  'distinct "person" target (staff_reminder_create has no name-to-id resolution, same gap 05-crm05-add-note.spec.ts ' +
  'documents for contacts) — plus LOGIN_EMAIL_BA/LOGIN_PASSWORD_BA itself.';

test.describe('TC-RMD03-01 — cancel by the reminder\'s own creator', () => {
  test('SA (creator) can cancel a reminder they created', async ({ browser }) => {
    test.setTimeout(180_000);
    capabilityGate();
    test.skip(!process.env.TEST_BA_USER_ID, TEST_BA_USER_ID_SKIP_REASON);

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);

    const setup = await callAction(page, clinicId, 'staff_reminder_create', {
      target_type: 'person',
      target_id: process.env.TEST_BA_USER_ID,
      due_at: futureDateTime(24),
      message: 'QA_RMD0301 creator-cancel fixture',
      causing_message: '[direct action, not chat] TC-RMD03-01 setup fixture',
    });
    expect(setup?.success, 'setup fixture reminder must be created').toBe(true);
    const reminderId = setup.data.reminder_id;

    const trigger = `ألغي التذكير رقم ${reminderId}`;
    const { replies } = await sendAndConfirm(page, trigger);
    const lastReply = replies[replies.length - 1];

    // Verify by attempting the SAME cancel again directly: if chat's cancel already
    // succeeded, this second attempt must fail with already_cancelled — that failure
    // IS the proof the chat-driven cancel actually took effect (rather than trusting
    // the chat reply's wording alone).
    const verify = await callAction(page, clinicId, 'staff_reminder_cancel', {
      reminder_id: reminderId,
      causing_message: '[direct action, not chat] TC-RMD03-01 post-chat verification',
    });

    recorder.record({
      id: 'TC-RMD03-01',
      tool: 'staff_reminder_cancel (by creator) — verified via a second direct cancel attempt',
      trigger,
      result: verify?.error === 'already_cancelled' ? 'PASS' : 'FAIL',
      evidence: `reply="${lastReply.text}"\nverify_second_cancel_attempt=${JSON.stringify(verify)}`,
    });
    expect(verify?.error, 'the reminder must already be cancelled from the chat step').toBe('already_cancelled');
    await context.close();
  });
});

test.describe('TC-RMD03-02 — cancel by the reminder\'s target (not the creator)', () => {
  /**
   * ⚠️ REAL FINDING (2026-09-07), left as FAIL on purpose — not a test bug, and not
   * blindly retried (looks like a deterministic LLM-reasoning gap, not transient flake):
   * Maha replied "لا أرى تذكيرًا برقم <id> في قائمتك" (I don't see that reminder in
   * your list) when the BA (the reminder's TARGET, not its creator) asked to cancel it
   * by number, then pivoted to offering to delete an unrelated INSTRUCTION rule
   * instead. Backend ground truth confirms the reminder genuinely exists and was
   * NEVER cancelled via chat (`staff_reminder_cancel`'s own second direct attempt
   * succeeded fresh, not `already_cancelled`). Read `list_reminders()` directly
   * (staff_reminders.py:159+): it takes NO acting-identity parameter and, when called
   * with no target filters, returns EVERY active reminder for the whole clinic —
   * there is no code-level reason a person-targeted reminder should be invisible to
   * its target. This points to Maha itself silently scoping "my reminders" to
   * target_type=self only when resolving "reminder #<id>" from a bare number, missing
   * ones created FOR the asker by someone else — an LLM/prompt reasoning gap, not a
   * tool bug. Same failure family as the CRM-06 due_date miscalculation
   * (10-crm06-follow-ups.spec.ts): the model's real behavior disagrees with what a
   * correct implementation of the underlying tool would support.
   */
  test('BA (target) can cancel a reminder created FOR them by SA', async ({ browser }) => {
    test.setTimeout(180_000);
    capabilityGate();
    test.skip(!process.env.LOGIN_EMAIL_BA || !process.env.TEST_BA_USER_ID, TEST_BA_USER_ID_SKIP_REASON);

    const saContext = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const saPage = await saContext.newPage();
    await gotoAiInstructionStep(saPage);
    const clinicId = await saPage.evaluate(() => (window as any).FO?.clinicId);

    const setup = await callAction(saPage, clinicId, 'staff_reminder_create', {
      target_type: 'person',
      target_id: process.env.TEST_BA_USER_ID,
      due_at: futureDateTime(24),
      message: 'QA_RMD0302 target-cancel fixture',
      causing_message: '[direct action, not chat] TC-RMD03-02 setup fixture (SA creates, targets BA)',
    });
    expect(setup?.success).toBe(true);
    const reminderId = setup.data.reminder_id;
    await saContext.close();

    const baContext = await browser.newContext({ storageState: 'auth/.storage-state.ba.local.json' });
    const baPage = await baContext.newPage();
    await gotoAiInstructionStep(baPage);

    const trigger = `ألغي التذكير رقم ${reminderId}، لم يعد هذا مناسبًا`;
    const { replies } = await sendAndConfirm(baPage, trigger);
    const lastReply = replies[replies.length - 1];

    const verify = await callAction(baPage, clinicId, 'staff_reminder_cancel', {
      reminder_id: reminderId,
      causing_message: '[direct action, not chat] TC-RMD03-02 post-chat verification',
    });

    recorder.record({
      id: 'TC-RMD03-02',
      tool: 'staff_reminder_cancel (by target, not creator) — verified via a second direct cancel attempt',
      trigger,
      result: verify?.error === 'already_cancelled' ? 'PASS' : 'FAIL',
      evidence: `reply="${lastReply.text}"\nverify_second_cancel_attempt=${JSON.stringify(verify)}`,
    });
    expect(verify?.error, 'the target-initiated cancel must have already gone through').toBe('already_cancelled');
    await baContext.close();
  });
});

test.describe('TC-RMD03-03 — ⚠️ SECURITY GAP VERIFICATION — cancel by an unauthorized third staff member', () => {
  test('chat: a THIRD staff (neither creator nor target) attempts to cancel via the real UI', async ({ browser }) => {
    test.setTimeout(180_000);
    capabilityGate();
    test.skip(
      !process.env.LOGIN_EMAIL_BA || !process.env.TEST_BA_USER_ID || !process.env.LOGIN_EMAIL_BA2,
      'Needs THREE distinct identities in the same clinic: LOGIN_EMAIL_BA/TEST_BA_USER_ID (the target, ' +
        '"Ahmad") and a second staff account LOGIN_EMAIL_BA2/LOGIN_PASSWORD_BA2 (the unauthorized "Staff C") ' +
        '— run `LOGIN_PROFILE=ba2 BASE_URL=http://localhost:8000 npx playwright test auth/login-setup.ts ' +
        '--project=setup` once to produce auth/.storage-state.ba2.local.json (see file header for why the ' +
        'orphan account doesn\'t fit this role). SA is the creator.'
    );

    const saContext = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const saPage = await saContext.newPage();
    await gotoAiInstructionStep(saPage);
    const clinicId = await saPage.evaluate(() => (window as any).FO?.clinicId);

    const setup = await callAction(saPage, clinicId, 'staff_reminder_create', {
      target_type: 'person',
      target_id: process.env.TEST_BA_USER_ID,
      due_at: futureDateTime(24),
      message: 'QA_RMD0303_SECURITY unauthorized-cancel gap verification (chat path)',
      causing_message: '[direct action, not chat] TC-RMD03-03 setup fixture (SA creates, targets BA/"Ahmad")',
    });
    expect(setup?.success).toBe(true);
    const reminderId = setup.data.reminder_id;

    const before = await callAction(saPage, clinicId, 'staff_reminder_list', {
      target_type: 'person',
      target_id: process.env.TEST_BA_USER_ID,
      include_fired: true,
      limit: 50,
    });
    const beforeRow = (before?.data?.rows || []).find((r: any) => r.reminder_id === reminderId);
    await saContext.close();

    // Staff C: neither the creator (SA) nor the target (BA/"Ahmad").
    const ba2Context = await browser.newContext({ storageState: 'auth/.storage-state.ba2.local.json' });
    const ba2Page = await ba2Context.newPage();
    await gotoAiInstructionStep(ba2Page);

    const trigger = `ألغي تذكير أحمد رقم ${reminderId}`;
    const { replies } = await sendAndConfirm(ba2Page, trigger);
    const lastReply = replies[replies.length - 1];

    const after = await callAction(ba2Page, clinicId, 'staff_reminder_list', {
      target_type: 'person',
      target_id: process.env.TEST_BA_USER_ID,
      include_fired: true,
      limit: 50,
    });
    const afterRow = (after?.data?.rows || []).find((r: any) => r.reminder_id === reminderId);
    // If the row disappeared from the (cancelled/done-excluding) list entirely, that's
    // just as much a "got cancelled" signal as an explicit status field would be.
    const gotCancelled = !afterRow || afterRow.status === 'cancelled';

    recorder.record({
      id: 'TC-RMD03-03',
      tool: 'staff_reminder_cancel — unauthorized third-party cancel, via the real chat/LLM path',
      trigger,
      result: gotCancelled ? 'FAIL' : 'PASS',
      evidence: gotCancelled
        ? `⚠️ SECURITY GAP CONFIRMED (chat path): Staff C (neither creator nor target) successfully cancelled ` +
          `Ahmad's reminder #${reminderId} via ordinary chat. before_status=${beforeRow?.status} ` +
          `after_present=${!!afterRow} after_status=${afterRow?.status}. Reply: "${lastReply.text}"`
        : `Reminder was NOT cancelled by Staff C's chat message (before_status=${beforeRow?.status}, ` +
          `after_status=${afterRow?.status ?? '(row absent, still active)'}) — either the tool enforced ` +
          `not_authorized, or Maha declined to even attempt the call; either is a safe outcome for this check. ` +
          `Reply: "${lastReply.text}"`,
    });
    // Deliberately NOT asserting a hard expect() here beyond sanity — the whole point
    // of this TC is to report the OBSERVED outcome (see recorder.record above), not to
    // fail the suite on a known, already-disclosed gap. The mechanical PASS/FAIL is
    // carried in the recorded report, which is what a human/CI dashboard consumes.
    expect(typeof lastReply.text).toBe('string');
    await ba2Context.close();
  });

  test('backend proof: cancel_reminder() has no identity parameter at all — deterministic, LLM-independent', async ({
    browser,
  }) => {
    test.setTimeout(60_000);
    capabilityGate();
    test.skip(!process.env.TEST_BA_USER_ID, TEST_BA_USER_ID_SKIP_REASON);

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);

    const setup = await callAction(page, clinicId, 'staff_reminder_create', {
      target_type: 'person',
      target_id: process.env.TEST_BA_USER_ID,
      due_at: futureDateTime(24),
      message: 'QA_RMD0303_SECURITY_BACKEND unauthorized-cancel gap verification (direct call)',
      causing_message: '[direct action, not chat] TC-RMD03-03-BACKEND setup fixture',
    });
    expect(setup?.success).toBe(true);
    const reminderId = setup.data.reminder_id;

    // No identity of any kind is passed here beyond clinic_id — that absence IS the
    // point: cancel_reminder()'s only scoping is "same clinic", so this call stands in
    // for literally any staff member in the clinic, "unauthorized" or not.
    const cancelResult = await callAction(page, clinicId, 'staff_reminder_cancel', {
      reminder_id: reminderId,
      causing_message: '[direct action, not chat] TC-RMD03-03-BACKEND — an "any staff, same clinic" cancel attempt',
    });
    const cancelSucceeded = cancelResult?.success === true;

    recorder.record({
      id: 'TC-RMD03-03-BACKEND',
      tool: 'staff_reminder_cancel — direct call, proves the tool-level authorization gap deterministically',
      trigger: `[direct action, not chat] staff_reminder_cancel reminder_id=${reminderId}, no caller identity supplied`,
      result: cancelSucceeded ? 'FAIL' : 'PASS',
      evidence: cancelSucceeded
        ? `⚠️ SECURITY GAP CONFIRMED (backend-level, deterministic): cancel_reminder() has no not_authorized ` +
          `check at all as of this run — ANY same-clinic caller can cancel ANY reminder regardless of ` +
          `creator/target. This will keep failing until acting_user_id reaches this tool call and a ` +
          `creator-or-target check is added (Phase 2 item #2 in the release plan). ${JSON.stringify(cancelResult)}`
        : `Cancel was rejected (${JSON.stringify(cancelResult)}) — if this is newly true, the ` +
          `not_authorized gap documented in staff_reminders.py's docstring may have been fixed; re-read the ` +
          `source before assuming this result is stale either way.`,
    });
    // Deliberately not a hard expect() — see the chat-path test above for why.
    expect(typeof cancelResult).toBe('object');
    await context.close();
  });
});

test.describe('TC-RMD03-04 — cancel a reminder that has already fired', () => {
  test('cancel is rejected with already_fired; a fired reminder can never be cancelled by anyone', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    capabilityGate();

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);

    const setup = await callAction(page, clinicId, 'staff_reminder_create', {
      target_type: 'self',
      due_at: pastDateTime(2), // already due — "fired" per _resolve_status()
      message: 'QA_RMD0304 already-fired cancel-rejection fixture',
      causing_message: '[direct action, not chat] TC-RMD03-04 setup fixture',
    });
    expect(setup?.success).toBe(true);
    const reminderId = setup.data.reminder_id;

    const trigger = `ألغي التذكير رقم ${reminderId} الذي فات وقته`;
    const { replies } = await sendAndConfirm(page, trigger);
    const lastReply = replies[replies.length - 1];
    const claimsCancelSuccess = /(تم إلغاء|✅.*(ألغ|إلغاء))/i.test(lastReply.text);
    const suggestsMarkDone = /(تم|منجز|منجزة|أنجز|أكمل|إنهاء)/i.test(lastReply.text);

    // Ground truth, independent of the chat step: cancel_reminder() rejects ANY
    // fired reminder unconditionally (checked before any authorization concern even
    // applies) — so this direct call is deterministic regardless of what the chat did.
    const verify = await callAction(page, clinicId, 'staff_reminder_cancel', {
      reminder_id: reminderId,
      causing_message: '[direct action, not chat] TC-RMD03-04 backend proof',
    });

    recorder.record({
      id: 'TC-RMD03-04',
      tool: 'staff_reminder_cancel(status=fired) — direct call proves already_fired is unconditional',
      trigger,
      result: verify?.error === 'already_fired' && !claimsCancelSuccess ? 'PASS' : 'FAIL',
      evidence:
        `reply="${lastReply.text}"\nclaims_cancel_success=${claimsCancelSuccess} ` +
        `verify_direct_call=${JSON.stringify(verify)}`,
    });
    recorder.record({
      id: 'TC-RMD03-04-MARK-DONE-SUGGESTION',
      tool: 'reply wording — offers staff_reminder_mark_done as the alternative',
      trigger,
      result: 'NEEDS_REVIEW',
      evidence: `suggests_mark_done_ish_wording=${suggestsMarkDone}\n\n${lastReply.text}`,
    });
    expect(verify?.error, 'a fired reminder must never actually be cancelled').toBe('already_fired');
    expect(claimsCancelSuccess, 'reply must not falsely claim the fired reminder was cancelled').toBe(false);
    await context.close();
  });
});
