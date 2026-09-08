import { test, expect } from '@playwright/test';
import { gotoAiInstructionStep, sendAndConfirm } from '../../helpers/maha-chat';
import { ReportRecorder } from '../../helpers/report';
import '../../helpers/ob4-local-guard'; // throws if BASE_URL isn't local — see that file for why

/**
 * Covers RMD-04 (`staff_reminder_mark_done`) from QA_TestScript_Phase4_CRM_Export.md,
 * TC-RMD04-01..03. See 24-rmd01-self-reminder.spec.ts's header for the shared RMD
 * background.
 *
 * TC-RMD04-02 is skipped per the doc's own execution checklist ("SKIP — fitur
 * di-drop"): target is self/person only, there is no team target at all (Q3,
 * 2026-09-04 — same precedent as CRM-04/06/11, see staff_reminders.py's module
 * docstring), so "one team member marks done, whole team clears" has no tool to
 * exercise. Recorded UNABLE_TO_TEST, same posture as 01-part3-runtime-context.spec.ts's
 * TC-P3-06.
 *
 * Note: TC-RMD04-01/03 target the BA account specifically (not "self"), because
 * "self" always resolves to clinic_id (the clinic OWNER), never the acting staff
 * member — see 24-rmd01-self-reminder.spec.ts's header, deviation #3. A reminder
 * meant to target "the account that will log in and mark it done" (BA) must use
 * target_type=person + an explicit target_id (env var TEST_BA_USER_ID).
 */

const recorder = new ReportRecorder('OB4 RMD-04 Mark Done');
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
      session_id: `qa-rmd04-${action}-${Math.floor(Math.random() * 1e9)}`,
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
function pastDateTime(hoursAgo = 2): string {
  const d = new Date();
  d.setHours(d.getHours() - hoursAgo);
  return toDateTime(d);
}

const TEST_BA_USER_ID_SKIP_REASON =
  'Set TEST_BA_USER_ID to the real numeric users.id of the LOGIN_EMAIL_BA account (needed as a real, ' +
  'distinct "person" target) plus LOGIN_EMAIL_BA/LOGIN_PASSWORD_BA itself, and run `npm run login-setup:local-ba`.';

/**
 * ⚠️ REAL FINDING (2026-09-07), left as FAIL on purpose, same family as
 * 26-rmd03-cancel-reminder.spec.ts's TC-RMD03-02: Maha replied "أحتاج رقم التذكير أو
 * اسمه بالضبط" (I need the exact reminder number or name) EVEN THOUGH the trigger gave
 * the exact real reminder_id explicitly. This is the SECOND independent tool
 * (cancel AND mark_done) showing the identical symptom for a person-targeted reminder
 * viewed by its target rather than its creator — strengthens the case this is a real,
 * systemic gap in how Maha resolves "reminder #<id>" (likely silently scoping its own
 * lookup to target_type=self reminders only), not a one-off. `list_reminders()` itself
 * has no such restriction (staff_reminders.py:159+, no acting-identity filter at all).
 */
test.describe('TC-RMD04-01 — mark done, individual reminder', () => {
  test('BA (the reminder\'s target) marks a fired reminder done', async ({ browser }) => {
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
      due_at: pastDateTime(2), // already fired, so "mark done" is a meaningful action
      message: 'QA_RMD0401 mark-done fixture',
      causing_message: '[direct action, not chat] TC-RMD04-01 setup fixture (SA creates, targets BA)',
    });
    expect(setup?.success).toBe(true);
    const reminderId = setup.data.reminder_id;
    await saContext.close();

    const baContext = await browser.newContext({ storageState: 'auth/.storage-state.ba.local.json' });
    const baPage = await baContext.newPage();
    await gotoAiInstructionStep(baPage);

    const trigger = `تم، تم الإنجاز، علّمي التذكير رقم ${reminderId} كمكتمل`;
    const { replies } = await sendAndConfirm(baPage, trigger);
    const lastReply = replies[replies.length - 1];

    // list_reminders() excludes done/cancelled rows unconditionally (see its own SQL:
    // "cancelled_at IS NULL AND done_at IS NULL") — so the row's disappearance from an
    // include_fired=true list IS the proof done_at got set.
    const after = await callAction(baPage, clinicId, 'staff_reminder_list', {
      target_type: 'person',
      target_id: process.env.TEST_BA_USER_ID,
      include_fired: true,
      limit: 50,
    });
    const stillActive = (after?.data?.rows || []).some((r: any) => r.reminder_id === reminderId);

    recorder.record({
      id: 'TC-RMD04-01',
      tool: 'staff_reminder_mark_done — verified via list_reminders (done rows are excluded)',
      trigger,
      result: !stillActive ? 'PASS' : 'FAIL',
      evidence: `reply="${lastReply.text}"\nstill_appears_in_active_list=${stillActive}`,
    });
    expect(stillActive, 'the reminder must no longer appear as active once marked done').toBe(false);
    await baContext.close();
  });
});

test.describe('TC-RMD04-02 — SKIP (feature dropped) — team mark-done by one member', () => {
  test('no team target exists — not exercised', async () => {
    recorder.record({
      id: 'TC-RMD04-02',
      tool: 'staff_reminder_mark_done (team target)',
      trigger: '(not applicable)',
      result: 'UNABLE_TO_TEST',
      evidence:
        'staff_reminders.py\'s module docstring confirms target_type is self/person ONLY — team targets were ' +
        'dropped entirely (Q3, 2026-09-04, same precedent as CRM-04/06/11). There is no tool surface for "one ' +
        'team member marks done, whole team clears" to exercise. Matches the doc\'s own execution checklist: ' +
        '"SKIP (fitur di-drop)".',
    });
    test.skip(true, 'feature intentionally dropped — no team target exists, see evidence');
  });
});

test.describe('TC-RMD04-03 — un-mark a reminder that is already done (done is terminal)', () => {
  test('an un-mark request never actually reverts a done reminder', async ({ browser }) => {
    test.setTimeout(180_000);
    capabilityGate();

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);

    const setup = await callAction(page, clinicId, 'staff_reminder_create', {
      target_type: 'self',
      due_at: pastDateTime(3),
      message: 'QA_RMD0403 un-mark rejection fixture',
      causing_message: '[direct action, not chat] TC-RMD04-03 setup fixture',
    });
    expect(setup?.success).toBe(true);
    const reminderId = setup.data.reminder_id;

    const markDone = await callAction(page, clinicId, 'staff_reminder_mark_done', {
      reminder_id: reminderId,
      causing_message: '[direct action, not chat] TC-RMD04-03 setup — mark done first',
    });
    expect(markDone?.success, 'setup: reminder must be marked done before testing un-mark').toBe(true);

    const trigger = `الغي علامة الإنجاز عن التذكير رقم ${reminderId}، لم أنفّذه بعد`;
    const { replies } = await sendAndConfirm(page, trigger);
    const lastReply = replies[replies.length - 1];
    const claimsUnmarkSuccess = /(تم إلغاء.*(إنجاز|مكتمل)|أعدته.*(نشط|قيد)|تراجع)/i.test(lastReply.text);

    // No "unmark" tool exists at all — the only way to observe the DB-level truth is
    // to reuse the two tools that DO check terminal state. Attempting either against
    // this reminder must still report already_done: proof the status never reverted,
    // regardless of what the chat step above did or didn't do.
    const verifyMarkDone = await callAction(page, clinicId, 'staff_reminder_mark_done', {
      reminder_id: reminderId,
      causing_message: '[direct action, not chat] TC-RMD04-03 post-chat verification (mark_done)',
    });
    const verifyCancel = await callAction(page, clinicId, 'staff_reminder_cancel', {
      reminder_id: reminderId,
      causing_message: '[direct action, not chat] TC-RMD04-03 post-chat verification (cancel)',
    });
    const stillDone = verifyMarkDone?.error === 'already_done' && verifyCancel?.error === 'already_done';

    recorder.record({
      id: 'TC-RMD04-03',
      tool: 'staff_reminder_mark_done/cancel — no unmark tool exists; verified via already_done on both',
      trigger,
      result: stillDone && !claimsUnmarkSuccess ? 'PASS' : 'FAIL',
      evidence:
        `reply="${lastReply.text}"\nclaims_unmark_success=${claimsUnmarkSuccess} ` +
        `verify_mark_done=${JSON.stringify(verifyMarkDone)} verify_cancel=${JSON.stringify(verifyCancel)}`,
    });
    expect(stillDone, 'the reminder must remain done — there is no un-mark path').toBe(true);
    expect(claimsUnmarkSuccess, 'reply must not falsely claim the done status was reverted').toBe(false);
    await context.close();
  });
});
