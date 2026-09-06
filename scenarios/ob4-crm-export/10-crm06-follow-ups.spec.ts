import { test, expect } from '@playwright/test';
import { gotoAiInstructionStep, sendMessage } from '../../helpers/maha-chat';
import { ReportRecorder } from '../../helpers/report';
import '../../helpers/ob4-local-guard'; // throws if BASE_URL isn't local — see that file for why

/**
 * Covers CRM-06 follow-ups (create/clear/list), from QA_TestScript_Phase4_CRM_Export.md's
 * 2026-09-05 implementation note — `patient_follow_ups` is genuinely live, and
 * crm_create_follow_up/crm_clear_follow_up/crm_list_follow_ups actually work
 * (crm.py:826-1000). Same person-only precedent as CRM-04: TC-CRM06-02 (clearing
 * a TEAM follow-up) is a SKIP stub below — no team concept exists here either.
 *
 * IMPORTANT — a second contact-identification/verification gap found while
 * building this (2026-09-06), same spirit as 05-crm05-add-note.spec.ts's own
 * finding:
 *   1. crm_get_contact's own `follow_ups` field is hard-coded to `[]` (crm.py:419)
 *      — it never actually queries patient_follow_ups at all. The ONLY way to
 *      read a follow-up back is crm_list_follow_ups.
 *   2. crm_list_follow_ups' own SELECT (crm.py:971-979) never selects
 *      causing_message — it isn't in the returned row shape at all. So the doc's
 *      own TC-CRM06-01 Expected Result ("causing_message tersimpan sesuai pesan
 *      chat yang memicu") is NOT mechanically re-verifiable from any tool this
 *      suite can call — recorded NEEDS_REVIEW below with this limitation stated
 *      explicitly, never silently assumed true.
 *
 * Same contact-identification gap as 05-crm05/09-crm04: crm_search_contacts has
 * no name/phone filter and no tool resolves a name to an id, so contacts are
 * referenced by numeric id below, not by name ("Reem" in the doc's own examples).
 *
 * Assignee: TEST_CRM_ASSIGNEE_ID/_NAME are the SAME shared real-staff-member env
 * vars as 09-crm04-set-responsible.spec.ts's TC-CRM04-01 — crm_create_follow_up's
 * assignee_id has the identical "must be a real users row for this clinic"
 * constraint as crm_set_responsible's assignee_id (both check
 * `id = %s AND (id = %s OR parent_user_id = %s)`).
 */

const recorder = new ReportRecorder('OB4 CRM-06 Follow Ups');
test.afterAll(async () => {
  await recorder.writeTo('reports');
});

const CRM_CAPABILITY_SKIP_REASON =
  'Set TEST_CRM_CAPABILITY_ENABLED=1 only after manually enabling "phase4Capabilities": {"crm": "*"} ' +
  '(or this test clinic\'s id) in your LOCAL reporty-onboard-phase3 config.json and restarting app.py.';

const ASSIGNEE_SKIP_REASON =
  'Set TEST_CRM_ASSIGNEE_ID/TEST_CRM_ASSIGNEE_NAME to a real staff member of this test clinic (a users row with ' +
  'id=440 or parent_user_id=440 — check clinic 440\'s Staff/My Doctor module). Same shared requirement as ' +
  '09-crm04-set-responsible.spec.ts\'s TC-CRM04-01. See QA_TestScript_Phase4_CRM_Export.md TC-CRM06-01 setup step 2.';

// Same pre-existing contact as 05-crm05-add-note.spec.ts / 09-crm04-set-responsible.spec.ts
// (patients.id=896, clinic_id=440, name "adi careplan new test").
const TEST_CONTACT_ID = process.env.TEST_CONTACT_ID || '';

/** See 09-crm04-set-responsible.spec.ts's callAction() for the full envelope explanation. */
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
      session_id: `qa-crm06-${action}-${Math.floor(Math.random() * 1e9)}`,
      branch_id: opts.branchId,
    },
  });
  return resp.json();
}

/** due_date is expected as an absolute "YYYY-MM-DD" string (crm.py's own contract). */
function isAbsoluteDate(dateStr: unknown): dateStr is string {
  return typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
}

function isSunday(dateStr: string): boolean {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay() === 0;
}

function isInFuture(dateStr: string): boolean {
  return new Date(`${dateStr}T00:00:00Z`).getTime() > Date.now();
}

test.describe('TC-CRM06-01 — create a follow-up with an absolute date', () => {
  test('due_date resolves to an absolute future Sunday; assignee and contact are stored correctly', async ({ browser }) => {
    test.setTimeout(180_000);
    test.skip(process.env.TEST_CRM_CAPABILITY_ENABLED !== '1', CRM_CAPABILITY_SKIP_REASON);
    test.skip(!process.env.TEST_CONTACT_ID, 'Set TEST_CONTACT_ID to a real contact id under LOGIN_EMAIL_OB4SA\'s clinic.');
    test.skip(!process.env.TEST_CRM_ASSIGNEE_ID || !process.env.TEST_CRM_ASSIGNEE_NAME, ASSIGNEE_SKIP_REASON);

    const assigneeId = process.env.TEST_CRM_ASSIGNEE_ID!;
    const assigneeName = process.env.TEST_CRM_ASSIGNEE_NAME!;

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);
    expect(clinicId, 'window.FO.clinicId must be present on the AI Instruction step').toBeTruthy();

    const trigger = `ذكّري ${assigneeName} يتصل بجهة الاتصال رقم ${TEST_CONTACT_ID} يوم الأحد القادم`;
    const reply = await sendMessage(page, trigger);

    recorder.record({
      id: 'TC-CRM06-01-reply',
      tool: 'crm_create_follow_up — chat trigger (causing_message exactness cannot be independently re-verified, see file header)',
      trigger,
      result: 'NEEDS_REVIEW',
      evidence: reply.text,
    });

    const listResult = await callAction(page, clinicId, 'crm_list_follow_ups', { assignee_id: assigneeId });
    const rows: Array<{
      follow_up_id?: number;
      contact_id?: number;
      due_date?: string;
      assignee_id?: number;
      assignee_name?: string;
      created_at?: string;
    }> = listResult?.data?.rows || [];

    const matching = rows.filter((r) => String(r.contact_id) === TEST_CONTACT_ID);
    const created = matching.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))[0];

    const dueDateAbsolute = isAbsoluteDate(created?.due_date);
    const dueDateIsSunday = dueDateAbsolute ? isSunday(created!.due_date!) : false;
    const dueDateInFuture = dueDateAbsolute ? isInFuture(created!.due_date!) : false;
    const assigneeMatches = String(created?.assignee_id) === String(assigneeId);
    const allPass = !!created && dueDateAbsolute && dueDateIsSunday && dueDateInFuture && assigneeMatches;

    recorder.record({
      id: 'TC-CRM06-01',
      tool: 'crm_list_follow_ups(assignee_id) — direct read, not chat',
      trigger: `[direct action, not chat] crm_list_follow_ups assignee_id=${assigneeId}`,
      result: allPass ? 'PASS' : 'FAIL',
      evidence:
        `follow_up_found=${!!created} due_date=${created?.due_date} is_absolute_format=${dueDateAbsolute} ` +
        `is_sunday=${dueDateIsSunday} is_future=${dueDateInFuture} assignee_matches=${assigneeMatches}\n` +
        JSON.stringify(created).slice(0, 400),
    });
    expect(created, 'a follow-up for this contact/assignee must actually exist').toBeTruthy();
    expect(dueDateAbsolute, 'due_date must be an absolute YYYY-MM-DD date, not a raw relative phrase').toBe(true);
    expect(dueDateIsSunday && dueDateInFuture, 'due_date must resolve to a future Sunday ("hari Minggu depan")').toBe(true);
    expect(assigneeMatches, 'assignee must be the staff member named in the trigger').toBe(true);
    await context.close();
  });
});

test.describe('TC-CRM06-02 — SKIP (fitur di-drop) — clear a team follow-up by one member', () => {
  test('not applicable — follow-up assignee is person-only, no team to clear on behalf of', () => {
    recorder.record({
      id: 'TC-CRM06-02',
      tool: 'crm_clear_follow_up — team-shared clearing',
      trigger: '(not applicable)',
      result: 'UNABLE_TO_TEST',
      evidence:
        'Feature dropped from product scope, same precedent as CRM-04 — patient_follow_ups.assignee_id is a ' +
        'single person, there is no team concept for "first team member to clear it clears for everyone" to ' +
        'exercise.',
    });
    test.skip(
      true,
      'feature dropped from product scope — follow-up assignee is person-only, no team assignee support; see ' +
        'QA_TestScript_Phase4_CRM_Export.md CRM-06 callout'
    );
  });
});

test.describe('TC-CRM06-03 — ambiguous follow-up date is rejected, not guessed', () => {
  test('Maha asks for clarification instead of creating a follow-up with a guessed date', async ({ browser }) => {
    test.setTimeout(180_000);
    test.skip(process.env.TEST_CRM_CAPABILITY_ENABLED !== '1', CRM_CAPABILITY_SKIP_REASON);
    test.skip(!process.env.TEST_CONTACT_ID, 'Set TEST_CONTACT_ID to a real contact id under LOGIN_EMAIL_OB4SA\'s clinic.');
    test.skip(!process.env.TEST_CRM_ASSIGNEE_ID || !process.env.TEST_CRM_ASSIGNEE_NAME, ASSIGNEE_SKIP_REASON);

    const assigneeId = process.env.TEST_CRM_ASSIGNEE_ID!;
    const assigneeName = process.env.TEST_CRM_ASSIGNEE_NAME!;

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);

    const before = await callAction(page, clinicId, 'crm_list_follow_ups', { assignee_id: assigneeId });
    const countBefore = (before?.data?.rows || []).length;

    const trigger = `ذكّري ${assigneeName} يتابع مع جهة الاتصال رقم ${TEST_CONTACT_ID}، بس مش مستعجل، بعدين نحدد الوقت`;
    const reply = await sendMessage(page, trigger);

    const after = await callAction(page, clinicId, 'crm_list_follow_ups', { assignee_id: assigneeId });
    const countAfter = (after?.data?.rows || []).length;
    const noFollowUpCreated = countAfter === countBefore;

    recorder.record({
      id: 'TC-CRM06-03',
      tool: 'crm_create_follow_up — an ambiguous date must not produce a follow-up with a guessed due_date',
      trigger,
      result: noFollowUpCreated ? 'PASS' : 'FAIL',
      evidence: `reply="${reply.text}"\ncount_before=${countBefore} count_after=${countAfter} no_follow_up_created=${noFollowUpCreated}`,
    });
    expect(noFollowUpCreated, 'no new follow-up should be created off a guessed/ambiguous date').toBe(true);
    await context.close();
  });
});

test.describe('TC-CRM06-04 — a follow-up never messages the patient', () => {
  test("creating a follow-up leaves the contact's WhatsApp conversation history untouched", async ({ browser }) => {
    test.setTimeout(180_000);
    test.skip(process.env.TEST_CRM_CAPABILITY_ENABLED !== '1', CRM_CAPABILITY_SKIP_REASON);
    test.skip(!process.env.TEST_CONTACT_ID, 'Set TEST_CONTACT_ID to a real contact id under LOGIN_EMAIL_OB4SA\'s clinic.');
    test.skip(!process.env.TEST_CRM_ASSIGNEE_ID || !process.env.TEST_CRM_ASSIGNEE_NAME, ASSIGNEE_SKIP_REASON);

    const assigneeName = process.env.TEST_CRM_ASSIGNEE_NAME!;

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);

    const before = await callAction(page, clinicId, 'crm_get_contact', { contact_id: TEST_CONTACT_ID });
    const conversationsBefore: Array<{ conversation_id?: number; message_count?: number; last_message_at?: string }> =
      before?.data?.conversation_history || [];

    const trigger = `ذكّري ${assigneeName} يتصل بجهة الاتصال رقم ${TEST_CONTACT_ID} بعد أسبوعين من اليوم`;
    const reply = await sendMessage(page, trigger);

    const after = await callAction(page, clinicId, 'crm_get_contact', { contact_id: TEST_CONTACT_ID });
    const conversationsAfter: Array<{ conversation_id?: number; message_count?: number; last_message_at?: string }> =
      after?.data?.conversation_history || [];

    // Mechanical proxy for "the patient received no WhatsApp message because of
    // this": every pre-existing conversation's message_count/last_message_at is
    // unchanged, and no NEW conversation_id appeared. Not a direct read of
    // case_wa_log (no CRM tool exposes it), but crm_get_contact's own
    // conversation_history is sourced straight from cases_whatsapp (crm.py:339-346)
    // — a new inbound/outbound WA message would move updated_at/total_communication
    // on an existing row or create a brand new one, either of which this catches.
    const noNewConversation = conversationsAfter.length <= conversationsBefore.length;
    const noExistingConversationChanged = conversationsBefore.every((c) =>
      conversationsAfter.some(
        (a) =>
          a.conversation_id === c.conversation_id &&
          a.message_count === c.message_count &&
          a.last_message_at === c.last_message_at
      )
    );
    const patientUntouched = noNewConversation && noExistingConversationChanged;

    recorder.record({
      id: 'TC-CRM06-04',
      tool: 'crm_create_follow_up — must never message the patient (dashboard-only notification, staff only, no WA)',
      trigger,
      result: patientUntouched ? 'PASS' : 'FAIL',
      evidence:
        `reply="${reply.text}"\nconversations_before=${JSON.stringify(conversationsBefore)}\n` +
        `conversations_after=${JSON.stringify(conversationsAfter)}\npatient_untouched=${patientUntouched}`,
    });
    expect(
      patientUntouched,
      "the contact's WhatsApp conversation history must be unchanged after a follow-up is created"
    ).toBe(true);
    await context.close();
  });
});
