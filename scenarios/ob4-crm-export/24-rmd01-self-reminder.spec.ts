import { test, expect } from '@playwright/test';
import { gotoAiInstructionStep, sendAndConfirm } from '../../helpers/maha-chat';
import { ReportRecorder } from '../../helpers/report';
import '../../helpers/ob4-local-guard'; // throws if BASE_URL isn't local — see that file for why

/**
 * Covers RMD-01 (`staff_reminder_create`) from QA_TestScript_Phase4_CRM_Export.md
 * (reporty-web-backup), TC-RMD01-01..05. Part 2b's own header note (2026-09-05) says
 * `inapp_agent/tools/staff_reminders.py` is real, registered, and unit-tested — but
 * still UNCOMMITTED on branch `feature/ob4`, and confirms three deviations from the
 * doc's original assumptions (all read directly from source, not re-derived):
 *
 * 1. WhatsApp delivery ALWAYS fails (`whatsapp_delivery_not_yet_available`) — no
 *    per-staff WhatsApp infra exists at all. TC-RMD01-05 is negative now, unconditionally
 *    (not "depends on opt-in" as the doc's original version assumed).
 * 2. Recurrence is ALWAYS rejected (`recurring_reminders_not_yet_available`) the moment
 *    `recurrence` is truthy — checked BEFORE target resolution, so it fires even for an
 *    unresolvable/fictional target. TC-RMD01-02 is negative now (doc already flags this).
 *    IMPORTANT further finding (2026-09-06, reading create_reminder() directly): there is
 *    only ONE recurrence error path — TC-RMD01-03's doc-expected `recurrence_needs_stop_condition`
 *    does not exist anywhere in the code. A recurring request with no stop condition gets
 *    the exact same `recurring_reminders_not_yet_available` as one WITH a stop condition.
 *    Tests below assert the real error, not the doc's original (stale) one.
 * 3. `target_type` is `self`/`person` only, no `team` — and "self" always resolves to
 *    `clinic_id` (= the clinic owner), never the acting staff member, because
 *    acting_user_id doesn't reach individual tool calls yet (same gap already documented
 *    for CRM-04/06's author_id). A BA creating a "self" reminder actually creates one
 *    for the OWNER, not themselves — same class of gap 05-crm05-add-note.spec.ts
 *    flagged for contact-name resolution. Worked around here by using explicit
 *    `target_id`s (env var TEST_BA_USER_ID) instead of "self" wherever the test needs a
 *    specific, real staff identity — see that file's own header for the precedent.
 *
 * Verification pattern: for the two "must be honestly rejected" cases (recurrence,
 * WhatsApp) each test pairs (a) a realistic Arabic chat trigger through the real UI
 * (checks Maha doesn't fabricate a success reply) with (b) a direct callAction() proof
 * of the underlying tool's actual, deterministic behavior — this mirrors 05-crm05's own
 * split between "did the reply look honest" (semantic, NEEDS_REVIEW) and "did the row
 * actually change" (mechanical, PASS/FAIL), and removes any dependency on whether Maha's
 * tool-calling happens to reach the exact same code path the chat message implies.
 */

const recorder = new ReportRecorder('OB4 RMD-01 Self Reminder');
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
      session_id: `qa-rmd01-${action}-${Math.floor(Math.random() * 1e9)}`,
      branch_id: opts.branchId,
    },
  });
  return resp.json();
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
function fmt(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}
function tomorrowAt(hour: number): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return fmt(d);
}
function tomorrowDateOnly(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

test.describe('TC-RMD01-01 — self-reminder, absolute time', () => {
  test('a self reminder is created, dashboard-only, due tomorrow', async ({ browser }) => {
    test.setTimeout(180_000);
    capabilityGate();

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);
    expect(clinicId, 'window.FO.clinicId must be present').toBeTruthy();

    const marker = 'QA_RMD0101_MARKER';
    const trigger = `أذكّرني غدًا الساعة 9 صباحًا بمتابعة ${marker} لمخزون مادة الحشو`;
    const { replies } = await sendAndConfirm(page, trigger);
    const lastReply = replies[replies.length - 1];

    const listResult = await callAction(page, clinicId, 'staff_reminder_list', {
      target_type: 'self',
      include_fired: true,
      limit: 50,
    });
    const rows: Array<{ reminder_id: number; message?: string; due_at: string; delivery_channel: string; status: string }> =
      listResult?.data?.rows || [];
    const created = rows.find((r) => typeof r.message === 'string' && r.message.includes(marker));

    const dueDateMatches = !!created && created.due_at.startsWith(tomorrowDateOnly());
    const isDashboard = created?.delivery_channel === 'dashboard';
    const notTerminal = created ? !['cancelled', 'done'].includes(created.status) : false;

    recorder.record({
      id: 'TC-RMD01-01',
      tool: 'staff_reminder_create(target_type=self) — verified via staff_reminder_list direct read',
      trigger,
      result: created && dueDateMatches && isDashboard && notTerminal ? 'PASS' : 'FAIL',
      evidence:
        `reply="${lastReply.text}"\ncreated=${!!created} due_date_matches_tomorrow=${dueDateMatches} ` +
        `delivery_channel=${created?.delivery_channel} status=${created?.status}\n\n` +
        `[Manual cross-check still needed] confirm due_at's HOUR (not just date) is 09:00 in the ` +
        `facility's own configured timezone — this check only verifies the date component, since the ` +
        `test runner's local clock and the facility timezone aren't guaranteed to match.\n` +
        JSON.stringify(rows.slice(0, 5)).slice(0, 500),
    });
    expect(created, 'a self reminder containing the marker must exist').toBeTruthy();
    expect(isDashboard, 'delivery_channel_used must be dashboard, not whatsapp').toBe(true);
    await context.close();
  });
});

test.describe('TC-RMD01-02 — recurrence with a stop condition is still rejected outright', () => {
  test('chat: Maha does not fabricate a recurring-reminder success', async ({ browser }) => {
    test.setTimeout(180_000);
    capabilityGate();

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);

    const marker = 'QA_RMD0102_MARKER';
    const trigger = `ذكّري د. أحمد كل يوم إثنين الساعة 8 صباحًا لفحص ${marker} المخزون، حتى نهاية هذا الشهر`;
    const { replies } = await sendAndConfirm(page, trigger);
    const lastReply = replies[replies.length - 1];

    const claimsRecurringSuccess = /(تم إنشاء.*متكرر|تم جدولة.*متكرر|✅.*متكرر|كل\s*(يوم|أسبوع).{0,20}(تم|✅))/.test(
      lastReply.text
    );

    recorder.record({
      id: 'TC-RMD01-02',
      tool: 'staff_reminder_create (chat honesty check — recurrence)',
      trigger,
      result: claimsRecurringSuccess ? 'FAIL' : 'NEEDS_REVIEW',
      evidence: `claims_recurring_success=${claimsRecurringSuccess}\n\n${lastReply.text}`,
    });
    expect(claimsRecurringSuccess, 'reply must not claim a recurring reminder was actually created').toBe(false);
    await context.close();
  });

  test('backend proof: recurrence is rejected regardless of target resolvability', async ({ browser }) => {
    test.setTimeout(60_000);
    capabilityGate();

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page); // only to resolve clinicId — no chat sent
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);

    const result = await callAction(page, clinicId, 'staff_reminder_create', {
      target_type: 'self',
      due_at: tomorrowAt(8),
      message: 'QA_RMD0102_BACKEND recurring stock check',
      causing_message: '[direct action, not chat] TC-RMD01-02 backend proof',
      recurrence: { freq: 'weekly', day: 'monday', until: tomorrowDateOnly() },
    });

    recorder.record({
      id: 'TC-RMD01-02-BACKEND',
      tool: 'staff_reminder_create(recurrence={...}) — direct call, bypasses the LLM entirely',
      trigger: '[direct action, not chat] staff_reminder_create with a recurrence dict that DOES include a stop condition',
      result: result?.error === 'recurring_reminders_not_yet_available' ? 'PASS' : 'FAIL',
      evidence: JSON.stringify(result),
    });
    expect(result?.error, 'must reject with recurring_reminders_not_yet_available').toBe(
      'recurring_reminders_not_yet_available'
    );
    await context.close();
  });
});

test.describe('TC-RMD01-03 — recurrence with NO stop condition (doc-expected error does not exist in code)', () => {
  test('chat: Maha does not fabricate a recurring-reminder success', async ({ browser }) => {
    test.setTimeout(180_000);
    capabilityGate();

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);

    const marker = 'QA_RMD0103_MARKER';
    const trigger = `ذكّرني كل يوم لفحص ${marker} المخزون`; // deliberately no stop condition
    const { replies } = await sendAndConfirm(page, trigger);
    const lastReply = replies[replies.length - 1];
    const claimsRecurringSuccess = /(تم إنشاء.*متكرر|تم جدولة.*متكرر|✅.*متكرر)/.test(lastReply.text);

    recorder.record({
      id: 'TC-RMD01-03',
      tool: 'staff_reminder_create (chat honesty check — recurrence, no stop condition)',
      trigger,
      result: claimsRecurringSuccess ? 'FAIL' : 'NEEDS_REVIEW',
      evidence: `claims_recurring_success=${claimsRecurringSuccess}\n\n${lastReply.text}`,
    });
    expect(claimsRecurringSuccess).toBe(false);
    await context.close();
  });

  test('backend proof: same recurring_reminders_not_yet_available, NOT a distinct stop-condition error', async ({
    browser,
  }) => {
    test.setTimeout(60_000);
    capabilityGate();

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);

    const result = await callAction(page, clinicId, 'staff_reminder_create', {
      target_type: 'self',
      due_at: tomorrowAt(9),
      message: 'QA_RMD0103_BACKEND daily stock check, no stop condition',
      causing_message: '[direct action, not chat] TC-RMD01-03 backend proof',
      recurrence: { freq: 'daily' }, // no "until"/stop condition at all
    });

    recorder.record({
      id: 'TC-RMD01-03-BACKEND',
      tool: 'staff_reminder_create(recurrence={freq:daily}, no stop condition) — direct call',
      trigger: '[direct action, not chat] staff_reminder_create with a recurrence dict WITHOUT a stop condition',
      result: result?.error === 'recurring_reminders_not_yet_available' ? 'PASS' : 'FAIL',
      evidence:
        `DEVIATION FROM DOC: the original spec expected a distinct "recurrence_needs_stop_condition" error ` +
        `here. Reading create_reminder() directly (staff_reminders.py) confirms no such error path exists — ` +
        `ANY truthy recurrence dict, with or without a stop condition, hits the exact same ` +
        `recurring_reminders_not_yet_available check. Recorded PASS/FAIL against the REAL behavior.\n\n` +
        JSON.stringify(result),
    });
    expect(result?.error).toBe('recurring_reminders_not_yet_available');
    await context.close();
  });
});

test.describe('TC-RMD01-04 — target outside BA branch scope (direct call, no chat/LLM involved)', () => {
  test('staff_reminder_create rejects a person target in a different branch than the acting BA', async ({
    browser,
  }) => {
    test.setTimeout(60_000);
    capabilityGate();
    test.skip(
      !process.env.LOGIN_EMAIL_BA || !process.env.TEST_STAFF_OUT_OF_SCOPE_ID,
      'Set LOGIN_EMAIL_BA/LOGIN_PASSWORD_BA (run `npm run login-setup:local-ba`) AND TEST_STAFF_OUT_OF_SCOPE_ID ' +
        '(a real users.id registered to a DIFFERENT branch than that BA account\'s own branch/facility — ' +
        'set up manually per TC-RMD01-04\'s precondition, same manual-DB-setup posture as TC-P3-04\'s orphan account).'
    );

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ba.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);
    const baBranchId = await page.evaluate(() => (window as any).FO?.branchId);
    expect(clinicId, 'window.FO.clinicId must resolve for the BA session too').toBeTruthy();

    // Deliberately no chat: this proves a specific tool-level invariant
    // (branch_id mismatch → rejection) precisely, same posture as 05-crm05's
    // TC-CRM05-04 causing_message check — a natural-language trigger would only add
    // dependence on Maha correctly relaying the BA's own branch_id, which isn't the
    // fact under test here.
    const result = await callAction(
      page,
      clinicId,
      'staff_reminder_create',
      {
        target_type: 'person',
        target_id: process.env.TEST_STAFF_OUT_OF_SCOPE_ID,
        due_at: tomorrowAt(10),
        message: 'QA_RMD0104_BACKEND out-of-scope target test',
        causing_message: '[direct action, not chat] TC-RMD01-04',
      },
      { branchId: String(baBranchId) }
    );

    recorder.record({
      id: 'TC-RMD01-04',
      tool: 'staff_reminder_create(target_type=person, branch_id=<BA\'s own branch>) — direct call',
      trigger: `[direct action, not chat] target_id=${process.env.TEST_STAFF_OUT_OF_SCOPE_ID} branch_id=${baBranchId}`,
      result: result?.error === 'target_out_of_branch_scope' ? 'PASS' : 'FAIL',
      evidence: JSON.stringify(result),
    });
    expect(result?.error).toBe('target_out_of_branch_scope');
    await context.close();
  });
});

test.describe('TC-RMD01-05 — explicit WhatsApp delivery always rejected', () => {
  test('chat: Maha does not fabricate a WhatsApp send, and does not leak the wrong error', async ({ browser }) => {
    test.setTimeout(180_000);
    capabilityGate();

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);

    const marker = 'QA_RMD0105_MARKER';
    const trigger = `ذكّرني عبر واتساب غدًا الساعة 9 صباحًا بمتابعة ${marker}`;
    const { replies } = await sendAndConfirm(page, trigger);
    const lastReply = replies[replies.length - 1];

    const claimsWhatsappSuccess = /(تم إرسال.*واتساب|✅.*واتساب|أرسلت.*واتساب)/.test(lastReply.text);
    const leaksWrongError = /target_not_opted_in_for_whatsapp/i.test(lastReply.text);
    const leaksRawError = /whatsapp_delivery_not_yet_available/i.test(lastReply.text);

    recorder.record({
      id: 'TC-RMD01-05',
      tool: 'staff_reminder_create (chat honesty check — WhatsApp delivery)',
      trigger,
      result: claimsWhatsappSuccess || leaksWrongError ? 'FAIL' : 'NEEDS_REVIEW',
      evidence:
        `claims_whatsapp_success=${claimsWhatsappSuccess} leaks_wrong_error(target_not_opted_in)=${leaksWrongError} ` +
        `leaks_raw_error_string=${leaksRawError}\n\n${lastReply.text}`,
    });
    expect(claimsWhatsappSuccess, 'reply must not claim the reminder was sent via WhatsApp').toBe(false);
    expect(leaksWrongError, 'reply must never mention target_not_opted_in_for_whatsapp — that error path does not exist').toBe(
      false
    );
    await context.close();
  });

  test('backend proof: explicit delivery_channel=whatsapp always errors, opt-in status is irrelevant', async ({
    browser,
  }) => {
    test.setTimeout(60_000);
    capabilityGate();

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);

    const result = await callAction(page, clinicId, 'staff_reminder_create', {
      target_type: 'self',
      due_at: tomorrowAt(9),
      message: 'QA_RMD0105_BACKEND explicit whatsapp request',
      causing_message: '[direct action, not chat] TC-RMD01-05 backend proof',
      delivery_channel: 'whatsapp',
    });

    recorder.record({
      id: 'TC-RMD01-05-BACKEND',
      tool: 'staff_reminder_create(delivery_channel=whatsapp) — direct call, bypasses the LLM entirely',
      trigger: '[direct action, not chat] staff_reminder_create delivery_channel=whatsapp',
      result: result?.error === 'whatsapp_delivery_not_yet_available' ? 'PASS' : 'FAIL',
      evidence: JSON.stringify(result),
    });
    expect(result?.error).toBe('whatsapp_delivery_not_yet_available');
    await context.close();
  });
});
