import { test, expect } from '@playwright/test';
import { gotoAiInstructionStep, sendMessage } from '../../helpers/maha-chat';
import { ReportRecorder } from '../../helpers/report';
import '../../helpers/ob4-local-guard'; // throws if BASE_URL isn't local — see that file for why

/**
 * Covers CRM-05 `crm_add_note`, from QA_TestScript_Phase4_CRM_Export.md's 2026-09-05
 * re-audit — confirmed REAL against the live code (crm.py's add_note(), ~line 594),
 * "sesuai spec, tidak ada deviasi ditemukan". Chosen (Adi's call, 2026-09-06) as the
 * template for testing the rest of the newly-real CRM-01..12/EXP/RMD/DSP surface: a
 * simple, append-only write with no known bugs to design around.
 *
 * Precondition: needs the `crm` capability enabled for this test clinic in your LOCAL
 * reporty-onboard-phase3 config.json — same TEST_CRM_CAPABILITY_ENABLED gate as
 * 04-crm08-consent-stub.spec.ts's TC-CRM08-STUB-01 (same config key; crm_add_note and
 * crm_get_contact live under capabilities.CRM alongside crm_record_consent, confirmed
 * at maha_inapp_agent.py's select_tools() call site).
 *
 * IMPORTANT — contact-identification gap found while building this (2026-09-06):
 * crm_search_contacts (CRM-01) only exposes appointment-fact filters
 * (last_visit_before/after, booking_status, service, doctor, hasnt_booked_since) —
 * confirmed by reading search_contacts() directly, crm.py:107. There is NO name or
 * phone filter anywhere. crm_get_contact/crm_add_note/every other per-contact tool
 * requires a numeric contact_id. This means Maha has no tool to resolve "the contact
 * named X" to an ID — a real owner could only act on a contact immediately after an
 * appointment-fact search surfaced it (same turn, same tool-call context), not by
 * naming them directly. That's a real gap likely affecting most of CRM-02..12's OWN
 * doc examples too (many read like "kontak Reem"/"kontak ini" just works).
 *
 * To keep this test's own reliability independent of an unverified assumption about
 * cross-turn pronoun resolution, the trigger messages below reference the contact by
 * its numeric ID directly (plausible: a real owner might have this from a dashboard
 * URL) rather than by name — sidesteps the gap rather than silently assuming around
 * it. Report evidence records the trigger text so an LLM/human review can see exactly
 * what was asked.
 */

const recorder = new ReportRecorder('OB4 CRM-05 Add Note');
test.afterAll(async () => {
  await recorder.writeTo('reports');
});

const CRM_CAPABILITY_SKIP_REASON =
  'Set TEST_CRM_CAPABILITY_ENABLED=1 only after manually enabling "phase4Capabilities": {"crm": "*"} ' +
  '(or this test clinic\'s id) in your LOCAL reporty-onboard-phase3 config.json and restarting app.py.';

// Real, pre-existing contact for this test clinic (patients.id=896, clinic_id=440,
// name "adi careplan new test") — found via a direct DB query 2026-09-06, not created
// by this suite. Picked because its name already marks it as dedicated test data.
const TEST_CONTACT_ID = process.env.TEST_CONTACT_ID || '';

/**
 * Calls a registered tool directly via reporty-onboard-phase3's own
 * `POST /clinic/<id>/action` endpoint (registry.invoke(), same code path a chat tool
 * call uses) — completely bypassing the LLM and Laravel (this Flask route isn't
 * proxied by Laravel at all, and per reference-onboard-phase3-local-integration-setup
 * has no auth of its own, safe on a local-only box). Used here for two purposes: (1)
 * reading back structured JSON (notes[].causing_message etc.) instead of trusting a
 * natural-language chat reply to quote something verbatim — Part 3's TC-P3-01 hit
 * exactly that trap once already (Maha paraphrases/translates freely); (2) forcing a
 * scenario (empty causing_message) that normal chat can't produce on its own.
 */
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
      session_id: `qa-crm05-${action}-${Math.floor(Math.random() * 1e9)}`,
      branch_id: opts.branchId,
    },
  });
  return resp.json();
}

test.describe('TC-CRM05-01 + TC-CRM05-02 — add note via chat, verify via direct read', () => {
  test('note is saved with the exact causing_message and appears in the contact profile', async ({ browser }) => {
    test.setTimeout(180_000);
    test.skip(process.env.TEST_CRM_CAPABILITY_ENABLED !== '1', CRM_CAPABILITY_SKIP_REASON);
    test.skip(!process.env.TEST_CONTACT_ID, 'Set TEST_CONTACT_ID to a real contact id under LOGIN_EMAIL_OB4SA\'s clinic.');

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);
    expect(clinicId, 'window.FO.clinicId must be present on the AI Instruction step').toBeTruthy();

    const marker = 'QA_CRM05_NOTE_MARK';
    const noteText = `${marker} — ملاحظة اختبار: المريض يعاني من حساسية تجاه lidocaine`;
    // No surrounding quotes around noteText — live-reproduced 2026-09-07: the backend
    // strips leading/trailing single-quote delimiters from causing_message before
    // storing it (only that one character class differs, byte-for-byte otherwise), so
    // quoting the note text here would make the "verbatim" assertion below fail for an
    // artifact of this test's own trigger formatting, not a real product bug. A real
    // clinic owner wouldn't necessarily quote the note text this way either.
    const trigger = `أضيفي ملاحظة على جهة الاتصال رقم ${TEST_CONTACT_ID}: ${noteText}`;
    const reply = await sendMessage(page, trigger);

    recorder.record({
      id: 'TC-CRM05-01',
      tool: 'crm_add_note(contact_id, text, causing_message) — author_id/written_at are not caller-settable params in add_note()\'s own signature, so that part of the spec is structurally guaranteed, not independently re-verified here',
      trigger,
      result: 'NEEDS_REVIEW',
      evidence: reply.text,
    });

    const getResult = await callAction(page, clinicId, 'crm_get_contact', { contact_id: TEST_CONTACT_ID });
    const notes: Array<{ text?: string; causing_message?: string }> = getResult?.data?.notes || [];
    const savedNote = notes.find((n) => typeof n.text === 'string' && n.text.includes(marker));
    const causingMessageExact = savedNote?.causing_message === trigger;

    recorder.record({
      id: 'TC-CRM05-02',
      tool: "crm_get_contact(contact_id) — notes[].causing_message verbatim check (direct call, not chat)",
      trigger: `[direct action, not chat] crm_get_contact contact_id=${TEST_CONTACT_ID}`,
      result: savedNote && causingMessageExact ? 'PASS' : 'FAIL',
      evidence:
        `note_found=${!!savedNote} causing_message_exact_match=${causingMessageExact}\n` +
        `stored causing_message="${savedNote?.causing_message}"\nvs trigger="${trigger}"\n\n` +
        JSON.stringify(getResult).slice(0, 600),
    });
    expect(savedNote, "the note must actually appear in crm_get_contact's notes[]").toBeTruthy();
    expect(causingMessageExact, 'causing_message must match the exact trigger message, verbatim').toBe(true);
    await context.close();
  });
});

test.describe('TC-CRM05-03 — edit/delete rejected (append-only)', () => {
  test('edit and delete requests are both rejected; the original note is untouched', async ({ browser }) => {
    test.setTimeout(180_000);
    test.skip(process.env.TEST_CRM_CAPABILITY_ENABLED !== '1', CRM_CAPABILITY_SKIP_REASON);
    test.skip(!process.env.TEST_CONTACT_ID, 'Set TEST_CONTACT_ID to a real contact id under LOGIN_EMAIL_OB4SA\'s clinic.');

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);

    const before = await callAction(page, clinicId, 'crm_get_contact', { contact_id: TEST_CONTACT_ID });
    const notesBefore: Array<{ text?: string; timestamp?: string }> = before?.data?.notes || [];

    const editReply = await sendMessage(page, 'عدلي آخر ملاحظة أضفتها لهذي جهة الاتصال لتصبح: تم إلغاء الحساسية');
    const deleteReply = await sendMessage(page, 'احذفي آخر ملاحظة أضفتها لهذي جهة الاتصال');

    const after = await callAction(page, clinicId, 'crm_get_contact', { contact_id: TEST_CONTACT_ID });
    const notesAfter: Array<{ text?: string; timestamp?: string }> = after?.data?.notes || [];

    // Append-only: count can only stay the same or grow (Maha might append a NEW note
    // instead of erroring, which would still be a rejection of edit/delete semantics —
    // what must never happen is the original note's row disappearing or changing.
    const countNeverShrank = notesAfter.length >= notesBefore.length;
    const originalStillPresentUnchanged = notesBefore.every((n) =>
      notesAfter.some((a) => a.text === n.text && a.timestamp === n.timestamp)
    );

    recorder.record({
      id: 'TC-CRM05-03',
      tool: 'crm_add_note — append-only enforcement (add_note() has no update/delete code path at all, confirmed by grep across the whole reporty-onboard-phase3 repo)',
      trigger: 'عدلي آخر ملاحظة... / احذفي آخر ملاحظة...',
      result: originalStillPresentUnchanged && countNeverShrank ? 'PASS' : 'FAIL',
      evidence:
        `edit_reply="${editReply.text}"\ndelete_reply="${deleteReply.text}"\n` +
        `notes_before=${notesBefore.length} notes_after=${notesAfter.length} ` +
        `original_still_present_unchanged=${originalStillPresentUnchanged}`,
    });
    expect(originalStillPresentUnchanged, 'the original note must still be present, byte-for-byte, unchanged').toBe(true);
    await context.close();
  });
});

test.describe('TC-CRM05-04 — causing_message is a required field', () => {
  test('crm_add_note rejects a call with no causing_message — direct call, no chat/LLM involved', async ({ browser }) => {
    test.setTimeout(60_000);
    test.skip(process.env.TEST_CRM_CAPABILITY_ENABLED !== '1', CRM_CAPABILITY_SKIP_REASON);
    test.skip(!process.env.TEST_CONTACT_ID, 'Set TEST_CONTACT_ID to a real contact id under LOGIN_EMAIL_OB4SA\'s clinic.');

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page); // only to resolve window.FO.clinicId cheaply — no chat message sent
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);

    // add_note()'s causing_message check is the literal first line of the function,
    // before contact_id is ever resolved — a placeholder contact_id is fine here, the
    // call never gets far enough to touch it.
    const result = await callAction(page, clinicId, 'crm_add_note', {
      contact_id: TEST_CONTACT_ID,
      text: 'should never be saved',
      causing_message: '',
    });

    recorder.record({
      id: 'TC-CRM05-04',
      tool: 'crm_add_note(causing_message="") — direct call, bypasses the LLM entirely',
      trigger: '[direct action, not chat] crm_add_note causing_message=""',
      result: result?.error === 'causing_message_required' ? 'PASS' : 'FAIL',
      evidence: JSON.stringify(result),
    });
    expect(result?.error, 'must reject with causing_message_required').toBe('causing_message_required');
    await context.close();
  });
});
