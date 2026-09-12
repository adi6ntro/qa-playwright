import { test, expect } from '@playwright/test';
import { gotoAiInstructionStep, sendMessage } from '../../helpers/maha-chat';
import { ReportRecorder } from '../../helpers/report';
import '../../helpers/ob4-local-guard'; // throws if BASE_URL isn't local — see that file for why

/**
 * Covers CRM-03 `crm_update_contact` from QA_TestScript_Phase4_CRM_Export.md
 * (reporty-web-backup): TC-CRM03-01..05 (lines 851-937).
 *
 * Read directly against the live source (2026-09-06, inapp_agent/tools/crm.py:428-
 * 523 + registrations.py:813-818) to confirm: `field` is one of name/phone/
 * language/tags_add/tags_remove/note; always returns the STORED value on success
 * (`{success: true, stored_value, written_at}`); `causing_message` is required
 * (checked FIRST, before contact_id is even resolved — same pattern
 * 05-crm05-add-note.spec.ts's TC-CRM05-04 already exercised for crm_add_note).
 * `crm_sync_authority` is always `reporty_owned` (no HubSpot integration exists
 * anywhere in this codebase) — the docstring itself says AC#3's
 * one_way_synced_from_hubspot error "is not implemented since there's nothing
 * for it to reject" (crm.py:437-439), so TC-CRM03-03 is an UNABLE_TO_TEST stub,
 * same reasoning as 07-crm02-get-contact.spec.ts's TC-CRM02-02. Duplicate-phone
 * behavior (crm.py:462-474) is confirmed report+stop, no auto-merge-offer — the
 * doc's own 2026-09-05 note already corrected the original spec's assumption.
 *
 * Envelope contract (registry.invoke(), core/registry.py:217-411): `data` is
 * ALWAYS the tool's own raw return dict (success or handled-failure alike);
 * `error` is separately hoisted to the top level. So a failure's extra fields
 * (e.g. duplicate_phone's merge_target_id) live under `.data`, while the error
 * CODE itself is read off the top-level `.error` — same convention
 * 05-crm05-add-note.spec.ts's TC-CRM05-04 established for crm_add_note's
 * sibling causing_message_required path.
 *
 * TC-CRM03-01/02 both mutate the SHARED fixture contact (patients.id=896,
 * "adi careplan new test") that 05-crm05-add-note.spec.ts and
 * 07-crm02-get-contact.spec.ts also read/reference — both wrap their mutation
 * in try/finally and restore the original name/tag state afterward, same
 * "clean up after yourself against a shared, real test clinic" discipline as
 * 01-part3-runtime-context.spec.ts's TC-P3-01.
 */

const recorder = new ReportRecorder('OB4 CRM-03 Update Contact');
test.afterAll(async () => {
  await recorder.writeTo('reports');
});

const CRM_CAPABILITY_SKIP_REASON =
  'Set TEST_CRM_CAPABILITY_ENABLED=1 only after manually enabling "phase4Capabilities": {"crm": "*"} ' +
  '(or this test clinic\'s id) in your LOCAL reporty-onboard-phase3 config.json and restarting app.py.';

const TEST_CONTACT_ID = process.env.TEST_CONTACT_ID || '';

/** Same direct-call helper as 05-crm05-add-note.spec.ts / 06-/07- in this directory. */
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
      session_id: `qa-crm03-${action}-${Math.floor(Math.random() * 1e9)}`,
      branch_id: opts.branchId,
    },
  });
  return resp.json();
}

/**
 * Skip guard, added 2026-09-11: TEST_CONTACT_ID (the shared fixture nearly every
 * test in this suite reuses) turned out to already share its phone number with 5
 * other patients rows (15, 16, 111, 112, 170, 372 — old QA marker names, the
 * patients:backfill duplicate-contact bug, still open). Any chat-driven WRITE
 * needs branch-scoped access (chat always carries a real branch_id from session
 * context — see _inv() in maha_inapp_agent.py), which crm.py's
 * ambiguous_duplicate_phone fail-safe (found+fixed 2026-09-11, same session)
 * correctly refuses for an ambiguous contact. Rather than hard-fail every test
 * that happens to need a chat WRITE against this fixture, probe first and skip
 * cleanly with a reason — resolving the duplicate (a merge decision, not this
 * suite's call — see this session's own findings on why merging casually would
 * break TC-CRM02-03's fixture) will make these resume running on their own,
 * with no code change needed here.
 */
async function skipIfContactAmbiguous(
  page: import('@playwright/test').Page,
  clinicId: string,
  contactId: string,
  testTitle: string
) {
  const probe = await page.request.post(`http://localhost:9559/clinic/${clinicId}/action`, {
    data: {
      action: 'crm_get_contact',
      params: { contact_id: contactId },
      session_id: `qa-crm03-ambig-probe-${Math.floor(Math.random() * 1e9)}`,
      branch_id: '1',
    },
  }).then((r) => r.json());
  test.skip(
    probe?.error === 'ambiguous_duplicate_phone',
    `${testTitle}: contact_id=${contactId}'s phone number is already shared with another patients row ` +
      '(patients:backfill duplicate bug, still open as of 2026-09-11) — a branch-scoped write to this contact ' +
      'is correctly refused until the duplicate is resolved. Not a regression in this tool; see the 2026-09-11 ' +
      'session notes for why resolving it (a merge) is deferred, not this suite\'s call to make.'
  );
}

test.describe('TC-CRM03-01 — fix a misspelled name, verified + restored', () => {
  test('crm_update_contact(field=name) actually changes the stored name; original name restored afterward', async ({ browser }) => {
    test.setTimeout(180_000);
    test.skip(process.env.TEST_CRM_CAPABILITY_ENABLED !== '1', CRM_CAPABILITY_SKIP_REASON);
    test.skip(!process.env.TEST_CONTACT_ID, 'Set TEST_CONTACT_ID to a real contact id under LOGIN_EMAIL_OB4SA\'s clinic.');

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);
    expect(clinicId, 'window.FO.clinicId must be present on the AI Instruction step').toBeTruthy();

    const before = await callAction(page, clinicId, 'crm_get_contact', { contact_id: TEST_CONTACT_ID });
    const originalName = before?.data?.name;
    expect(originalName, 'must be able to read the original name before mutating it').toBeTruthy();

    const newName = 'QA_CRM03_MARK Fatima Al-Zahrani';
    const trigger = `اسم جهة الاتصال رقم ${TEST_CONTACT_ID} مكتوب غلط، صححيه إلى '${newName}'`;

    try {
      const reply = await sendMessage(page, trigger);

      const after = await callAction(page, clinicId, 'crm_get_contact', { contact_id: TEST_CONTACT_ID });
      const storedName = after?.data?.name;
      const nameChanged = storedName === newName;

      recorder.record({
        id: 'TC-CRM03-01',
        tool: 'crm_update_contact(field=name) — stored_value verification, crm.py:431/457-460',
        trigger,
        result: nameChanged ? 'PASS' : 'FAIL',
        evidence:
          `chat_reply="${reply.text}"\n\noriginal_name="${originalName}" stored_name_after="${storedName}" ` +
          `expected="${newName}"\n\n[Manual cross-check still needed] confirm the chat reply itself quotes ` +
          `the new stored value (not just a generic "berhasil diubah") per the doc's expected result.`,
      });
      expect(nameChanged, "the contact's stored name must actually change to the corrected value").toBe(true);
    } finally {
      // Restore the shared fixture contact's name regardless of pass/fail — this
      // contact (patients.id=896) is reused by 05-crm05-add-note.spec.ts and
      // 07-crm02-get-contact.spec.ts by its marker name "adi careplan new test";
      // leaving it renamed would break those.
      const restoreResult = await callAction(page, clinicId, 'crm_update_contact', {
        contact_id: TEST_CONTACT_ID,
        field: 'name',
        value: originalName,
        causing_message: 'QA cleanup: restore original name after TC-CRM03-01',
      });
      if (restoreResult?.success !== true) {
        console.warn(
          `[TC-CRM03-01] WARNING: failed to restore original name "${originalName}" on contact ` +
            `${TEST_CONTACT_ID} — manual DB fix needed. restoreResult=${JSON.stringify(restoreResult)}`
        );
      }
    }
    await context.close();
  });
});

test.describe('TC-CRM03-02 — tag a contact as VIP, verified + restored', () => {
  test('crm_update_contact(field=tags_add) actually adds the VIP tag; tag state restored afterward', async ({ browser }) => {
    test.setTimeout(180_000);
    test.skip(process.env.TEST_CRM_CAPABILITY_ENABLED !== '1', CRM_CAPABILITY_SKIP_REASON);
    test.skip(!process.env.TEST_CONTACT_ID, 'Set TEST_CONTACT_ID to a real contact id under LOGIN_EMAIL_OB4SA\'s clinic.');

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);
    expect(clinicId, 'window.FO.clinicId must be present on the AI Instruction step').toBeTruthy();
    await skipIfContactAmbiguous(page, clinicId, TEST_CONTACT_ID, 'TC-CRM03-02');

    const before = await callAction(page, clinicId, 'crm_get_contact', { contact_id: TEST_CONTACT_ID });
    const tagsBefore: string[] = before?.data?.tags || [];
    const hadVipAlready = tagsBefore.includes('VIP');

    const trigger = `أضيفي وسم VIP على جهة الاتصال رقم ${TEST_CONTACT_ID}`;

    try {
      const reply = await sendMessage(page, trigger);

      const after = await callAction(page, clinicId, 'crm_get_contact', { contact_id: TEST_CONTACT_ID });
      const tagsAfter: string[] = after?.data?.tags || [];
      const vipPresent = tagsAfter.includes('VIP');

      recorder.record({
        id: 'TC-CRM03-02',
        tool: 'crm_update_contact(field=tags_add) — stored tags verification, crm.py:484-498',
        trigger,
        result: vipPresent ? 'PASS' : 'FAIL',
        evidence:
          `chat_reply="${reply.text}"\n\ntags_before=${JSON.stringify(tagsBefore)} tags_after=${JSON.stringify(tagsAfter)} ` +
          `had_vip_already=${hadVipAlready} (if true, this run only proves VIP is present, not that THIS ` +
          `request is what added it)\n\n[Manual cross-check still needed] confirm the chat reply quotes the ` +
          `updated tag array as the stored_value, per the doc's expected result.`,
      });
      expect(vipPresent, 'VIP tag must be present on the contact after the request').toBe(true);
    } finally {
      // Only remove it if THIS test run is the one that added it — never strip a
      // pre-existing VIP tag that had nothing to do with this run.
      if (!hadVipAlready) {
        const restoreResult = await callAction(page, clinicId, 'crm_update_contact', {
          contact_id: TEST_CONTACT_ID,
          field: 'tags_remove',
          value: 'VIP',
          causing_message: 'QA cleanup: remove VIP tag added by TC-CRM03-02',
        });
        if (restoreResult?.success !== true) {
          console.warn(
            `[TC-CRM03-02] WARNING: failed to remove VIP tag from contact ${TEST_CONTACT_ID} — manual DB ` +
              `fix needed. restoreResult=${JSON.stringify(restoreResult)}`
          );
        }
      }
    }
    await context.close();
  });
});

test.describe('TC-CRM03-03 — update a one-way-sync field', () => {
  test('blocked — no HubSpot integration exists, same reasoning as TC-CRM02-02', async () => {
    recorder.record({
      id: 'TC-CRM03-03',
      tool: 'crm_update_contact',
      trigger: '(manual only)',
      result: 'UNABLE_TO_TEST',
      evidence:
        "Confirmed by direct read (crm.py:437-439): the function's own docstring states \"crm_sync_authority " +
        'is always reporty_owned (Q2 — no HubSpot integration exists), so AC#3\'s one_way_synced_from_hubspot ' +
        'error never fires; not implemented since there\'s nothing for it to reject." No precondition can be ' +
        'prepared for this TC (no field/UI/DB mechanism to mark a field as one-way-synced) until a HubSpot ' +
        'integration is actually built — same reasoning and same blocker as 07-crm02-get-contact.spec.ts\'s ' +
        'TC-CRM02-02.',
    });
    test.skip(true, 'no HubSpot integration exists — see evidence');
  });
});

test.describe('TC-CRM03-04 — duplicate phone number is rejected, not merged', () => {
  test('crm_update_contact(field=phone) rejects with duplicate_phone + merge_target_id; no duplicate row created', async ({ browser }) => {
    test.setTimeout(180_000);
    test.skip(process.env.TEST_CRM_CAPABILITY_ENABLED !== '1', CRM_CAPABILITY_SKIP_REASON);
    test.skip(!process.env.TEST_CONTACT_ID, 'Set TEST_CONTACT_ID to a real contact id under LOGIN_EMAIL_OB4SA\'s clinic.');
    const secondaryContactId = process.env.TEST_CONTACT_ID_SECONDARY;
    test.skip(
      !secondaryContactId,
      'Set TEST_CONTACT_ID_SECONDARY to a real, different contact_id for this same clinic (any second contact ' +
        'with its own distinct phone number) to exercise the duplicate-phone check. No second contact_id is ' +
        "confirmed to exist yet in this suite's fixture data — rather than invent one, this test skips until a " +
        'real one is provided. NEW env var, not yet in .env.example — see this file\'s header / the task ' +
        'report for what to add.'
    );

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);
    expect(clinicId, 'window.FO.clinicId must be present on the AI Instruction step').toBeTruthy();

    const secondaryContact = await callAction(page, clinicId, 'crm_get_contact', { contact_id: secondaryContactId });
    const secondaryPhone = secondaryContact?.data?.phone;
    expect(secondaryPhone, `TEST_CONTACT_ID_SECONDARY=${secondaryContactId} must resolve to a real contact with a phone number`).toBeTruthy();

    // 2026-09-11: a genuine phone change now asks a clarifying question first
    // (phone_change_mode — see TC-CRM03-08), so the chat reply here is expected
    // to be THAT question, not a duplicate-phone rejection in one turn — chat is
    // exercised for realism/manual review only, the actual assertions below are
    // all against the direct call.
    const trigger = `غيّري رقم هاتف جهة الاتصال رقم ${TEST_CONTACT_ID} إلى ${secondaryPhone}`;
    const reply = await sendMessage(page, trigger);

    // Direct-call cross-check, bypassing whatever phone format the LLM chose to
    // pass through — proves the tool layer itself rejects the exact duplicate.
    // phone_change_mode='replace' is required as of 2026-09-11 (a genuinely
    // different number always needs it) — it's irrelevant to this outcome since
    // the duplicate_phone check runs before either mode's branch, but omitting it
    // would surface phone_change_mode_required instead and prove nothing about
    // the duplicate check itself. Never mutates contact A's phone regardless of
    // outcome: the DB-level duplicate check rejects deterministically either way,
    // so no cleanup is needed here.
    const direct = await callAction(page, clinicId, 'crm_update_contact', {
      contact_id: TEST_CONTACT_ID,
      field: 'phone',
      value: secondaryPhone,
      phone_change_mode: 'replace',
      causing_message: '[direct action, not chat] TC-CRM03-04 duplicate-phone check',
    });

    const rejected = direct?.error === 'duplicate_phone';
    const mergeTargetCorrect = String(direct?.data?.merge_target_id) === String(secondaryContactId);

    recorder.record({
      id: 'TC-CRM03-04',
      tool: 'crm_update_contact(field=phone) — duplicate_phone rejection, crm.py:462-474 (report+stop, no ' +
        'auto-merge-offer — confirmed real behavior, doc corrected 2026-09-05)',
      trigger,
      result: rejected && mergeTargetCorrect ? 'PASS' : 'FAIL',
      evidence:
        `chat_reply="${reply.text}" (expected to be the phone_change_mode clarifying question as of ` +
        `2026-09-11, not a duplicate-phone rejection — see TC-CRM03-08)\n\n` +
        `direct_call_result=${JSON.stringify(direct).slice(0, 300)}\n\n` +
        `[Manual cross-check still needed] confirm the CHAT reply asks the clarifying question rather than ` +
        `fabricating a result or auto-offering a merge flow (no merge tool exists via chat yet).`,
    });
    expect(rejected, 'must reject with error=duplicate_phone').toBe(true);
    expect(mergeTargetCorrect, 'merge_target_id must point at the contact that already owns this phone number').toBe(true);
    await context.close();
  });
});

test.describe('TC-CRM03-05 — causing_message is a required field', () => {
  test('crm_update_contact rejects a call with no causing_message — direct call, no chat/LLM involved', async ({ browser }) => {
    // Bumped from 60_000 — live-reproduced 2026-09-07: even a "cheap" navigation still
    // waits on gotoAiInstructionStep's full page load, which includes a real WA QR
    // Guzzle call (up to ~10s) plus OB4 instruction fetch — 60s isn't reliably enough
    // for the real ob4sa account's heavier clinic data, matching the same headroom
    // rationale already used everywhere else in this suite.
    test.setTimeout(180_000);
    test.skip(process.env.TEST_CRM_CAPABILITY_ENABLED !== '1', CRM_CAPABILITY_SKIP_REASON);
    test.skip(!process.env.TEST_CONTACT_ID, 'Set TEST_CONTACT_ID to a real contact id under LOGIN_EMAIL_OB4SA\'s clinic.');

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page); // only to resolve window.FO.clinicId cheaply — no chat message sent
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);

    const before = await callAction(page, clinicId, 'crm_get_contact', { contact_id: TEST_CONTACT_ID });
    const nameBefore = before?.data?.name;

    // update_contact()'s causing_message check is the literal first line of the
    // function (crm.py:441-442), before contact_id is ever resolved — same
    // pattern 05-crm05-add-note.spec.ts's TC-CRM05-04 already exercised for
    // add_note. field=name here is just a valid, harmless placeholder — the
    // call never gets far enough to touch it.
    const result = await callAction(page, clinicId, 'crm_update_contact', {
      contact_id: TEST_CONTACT_ID,
      field: 'name',
      value: 'should never be saved',
      causing_message: '',
    });

    const after = await callAction(page, clinicId, 'crm_get_contact', { contact_id: TEST_CONTACT_ID });
    const nameUnchanged = after?.data?.name === nameBefore;

    recorder.record({
      id: 'TC-CRM03-05',
      tool: 'crm_update_contact(causing_message="") — direct call, bypasses the LLM entirely, crm.py:441-442',
      trigger: '[direct action, not chat] crm_update_contact causing_message=""',
      result: result?.error === 'causing_message_required' && nameUnchanged ? 'PASS' : 'FAIL',
      evidence:
        `result=${JSON.stringify(result)}\n\nname_before="${nameBefore}" name_after="${after?.data?.name}" ` +
        `unchanged=${nameUnchanged}`,
    });
    expect(result?.error, 'must reject with causing_message_required').toBe('causing_message_required');
    expect(nameUnchanged, 'no write must have happened without a causing_message').toBe(true);
    await context.close();
  });
});

test.describe('TC-CRM03-06 — a multi-tag chat request creates separate tags, never one comma-joined tag', () => {
  test('crm_update_contact(field=tags_add) via real chat never creates a tag literally containing a comma', async ({ browser }) => {
    test.setTimeout(180_000);
    test.skip(process.env.TEST_CRM_CAPABILITY_ENABLED !== '1', CRM_CAPABILITY_SKIP_REASON);
    test.skip(!process.env.TEST_CONTACT_ID, 'Set TEST_CONTACT_ID to a real contact id under LOGIN_EMAIL_OB4SA\'s clinic.');

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);
    expect(clinicId, 'window.FO.clinicId must be present on the AI Instruction step').toBeTruthy();
    await skipIfContactAmbiguous(page, clinicId, TEST_CONTACT_ID, 'TC-CRM03-06');

    const before = await callAction(page, clinicId, 'crm_get_contact', { contact_id: TEST_CONTACT_ID });
    const tagsBefore: string[] = before?.data?.tags || [];

    // Real chat, not a direct call — the bug this guards against lived in the
    // @function_tool wrapper (maha_inapp_agent.py), which only runs when Gemini
    // actually calls the tool. A direct callAction() bypasses that wrapper
    // entirely and would prove nothing about this specific fix.
    const TAG_A = 'QA_CRM03_MULTI_A';
    const TAG_B = 'QA_CRM03_MULTI_B';
    const trigger = `أضيفي الوسمين ${TAG_A} و ${TAG_B} على جهة الاتصال رقم ${TEST_CONTACT_ID}`;

    try {
      const reply = await sendMessage(page, trigger);

      const after = await callAction(page, clinicId, 'crm_get_contact', { contact_id: TEST_CONTACT_ID });
      const tagsAfter: string[] = after?.data?.tags || [];

      const bothPresent = tagsAfter.includes(TAG_A) && tagsAfter.includes(TAG_B);
      const noCommaJoinedTag = !tagsAfter.some((t) => t.includes(','));

      recorder.record({
        id: 'TC-CRM03-06',
        tool:
          'crm_update_contact(field=tags_add) — comma-split fix in the @function_tool wrapper ' +
          '(maha_inapp_agent.py), found+fixed 2026-09-11',
        trigger,
        result: bothPresent && noCommaJoinedTag ? 'PASS' : 'FAIL',
        evidence:
          `chat_reply="${reply.text}"\n\ntags_before=${JSON.stringify(tagsBefore)} tags_after=${JSON.stringify(tagsAfter)}\n\n` +
          `The bug this guards against (reproduced live 2026-09-11 before the fix): a multi-tag chat request ` +
          `created ONE tag literally named "${TAG_A},${TAG_B}" (comma and all) instead of two separate tags — ` +
          'crm.py\'s tag_names splitter has no comma-handling of its own, so it depended entirely on the wrapper ' +
          'splitting first.',
      });
      expect(bothPresent, 'both tags must exist as separate entries').toBe(true);
      expect(noCommaJoinedTag, 'no tag name may contain a literal comma').toBe(true);
    } finally {
      const cleanup = await callAction(page, clinicId, 'crm_update_contact', {
        contact_id: TEST_CONTACT_ID,
        field: 'tags_remove',
        value: [TAG_A, TAG_B],
        causing_message: 'QA cleanup: remove tags added by TC-CRM03-06',
      });
      if (cleanup?.success !== true) {
        console.warn(`[TC-CRM03-06] WARNING: failed to remove test tags from contact ${TEST_CONTACT_ID} — manual DB fix needed.`);
      }
    }
    await context.close();
  });
});

test.describe('TC-CRM03-07 — a name correction here reaches a linked Inbox conversation', () => {
  test('crm_update_contact(field=name) writes through to inbox_contacts.name for any row bridged to this patient_id', async ({ browser }) => {
    test.setTimeout(180_000);
    test.skip(process.env.TEST_CRM_CAPABILITY_ENABLED !== '1', CRM_CAPABILITY_SKIP_REASON);
    test.skip(!process.env.TEST_CONTACT_ID, 'Set TEST_CONTACT_ID to a real contact id under LOGIN_EMAIL_OB4SA\'s clinic.');

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);
    expect(clinicId, 'window.FO.clinicId must be present on the AI Instruction step').toBeTruthy();

    const before = await callAction(page, clinicId, 'crm_get_contact', { contact_id: TEST_CONTACT_ID });
    const originalName: string | undefined = before?.data?.name;
    const phone: string | undefined = before?.data?.phone;
    expect(originalName && phone, 'need a real name+phone on TEST_CONTACT_ID to run this test').toBeTruthy();

    // Bridges a fixed, QA-marked Inbox chat_id to this same patient — matched by
    // phone (InboxController::resolvePatientId(), 2026-09-11 two-way sync), not
    // a real WhatsApp conversation. Fixed chat_id (not randomized) so reruns
    // update the same row instead of accumulating garbage — same convention
    // 00-cleanup-leftover-markers.spec.ts already established for this suite.
    await page.goto('/customer/inbox');
    const csrf = await page.evaluate(() => (window as any).INBOX_CONFIG?.csrf);
    expect(csrf, 'window.INBOX_CONFIG.csrf must be present on the Inbox page').toBeTruthy();
    const CHAT_ID = 'qa-crm03-inbox-sync-fixture';

    async function saveInboxContact(name: string) {
      return page.request.post('/customer/inbox/contact/save', {
        headers: { 'X-CSRF-TOKEN': csrf },
        data: { chat_id: CHAT_ID, name, sender_number: phone, social_media_type: 'whatsapp' },
      });
    }

    await saveInboxContact(originalName!);

    const newName = 'QA_CRM03_INBOXSYNC ' + originalName;
    try {
      const direct = await callAction(page, clinicId, 'crm_update_contact', {
        contact_id: TEST_CONTACT_ID,
        field: 'name',
        value: newName,
        causing_message: 'TC-CRM03-07 inbox sync check',
      });
      expect(direct?.success, 'the name write itself must succeed').toBe(true);

      const inboxContacts = await page.request.get('/customer/inbox/contacts').then((r) => r.json());
      const linkedRow = (Array.isArray(inboxContacts) ? inboxContacts : []).find((c: any) => c.chat_id === CHAT_ID);

      recorder.record({
        id: 'TC-CRM03-07',
        tool: 'crm_update_contact(field=name) write-through into inbox_contacts (2026-09-11 two-way sync, crm.py)',
        trigger: '[direct action + direct Inbox API] name correction propagation check',
        result: linkedRow?.name === newName ? 'PASS' : 'FAIL',
        evidence:
          `inbox_contacts row after CRM write: ${JSON.stringify(linkedRow)}\n\n` +
          `[Manual cross-check still needed] this only proves the Laravel-side inbox_contacts.name column ` +
          `updated — the actual browser-rendered Inbox UI (public/js/inbox/inbox.js) was not opened/visually ` +
          'confirmed by this run.',
      });
      expect(linkedRow?.name, 'the linked inbox_contacts row must reflect the corrected name').toBe(newName);
    } finally {
      await callAction(page, clinicId, 'crm_update_contact', {
        contact_id: TEST_CONTACT_ID,
        field: 'name',
        value: originalName,
        causing_message: 'QA cleanup: restore original name after TC-CRM03-07',
      });
      // Restore the fixture inbox_contacts row's name too, so it's back to a
      // clean baseline for the next run rather than left renamed.
      await saveInboxContact(originalName!);
    }
    await context.close();
  });
});

test.describe('TC-CRM03-08 — a genuine phone number change requires phone_change_mode', () => {
  test('crm_update_contact(field=phone) refuses without phone_change_mode; alias mode preserves the old number', async ({ browser }) => {
    test.setTimeout(180_000);
    test.skip(process.env.TEST_CRM_CAPABILITY_ENABLED !== '1', CRM_CAPABILITY_SKIP_REASON);
    test.skip(!process.env.TEST_CONTACT_ID, 'Set TEST_CONTACT_ID to a real contact id under LOGIN_EMAIL_OB4SA\'s clinic.');

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);
    expect(clinicId, 'window.FO.clinicId must be present on the AI Instruction step').toBeTruthy();

    const before = await callAction(page, clinicId, 'crm_get_contact', { contact_id: TEST_CONTACT_ID });
    const originalPhone: string | undefined = before?.data?.phone;
    expect(originalPhone, 'TEST_CONTACT_ID must have a real phone number').toBeTruthy();

    // Safety probe — added 2026-09-11 after this test corrupted the SHARED
    // TEST_CONTACT_ID fixture on its first run: restoring to originalPhone at the
    // end (below) uses phone_change_mode='replace', which still runs the
    // duplicate_phone check — and TEST_CONTACT_ID's real number turned out to
    // already be shared with 5 other patients rows (the patients:backfill
    // duplicate bug, still open), so the restore was rejected as duplicate_phone
    // and left the fixture stuck on a temp number for every other test to trip
    // over. A same-value call skips the phone_change_mode gate entirely (new
    // value == old value) and goes straight to that same duplicate check — a
    // safe, no-op way to learn the answer BEFORE ever mutating anything.
    const probe = await callAction(page, clinicId, 'crm_update_contact', {
      contact_id: TEST_CONTACT_ID,
      field: 'phone',
      value: originalPhone,
      causing_message: 'TC-CRM03-08 pre-check: is this number already ambiguous with another contact?',
    });
    test.skip(
      probe?.error === 'duplicate_phone',
      `TEST_CONTACT_ID=${TEST_CONTACT_ID}'s current phone is already shared with contact ` +
        `${probe?.data?.merge_target_id} (a real patients:backfill duplicate) — mutating it here could not be ` +
        'safely restored afterward. Point TEST_CONTACT_ID at a contact with a genuinely unique phone number, ' +
        'or resolve the duplicate via crm_merge_contacts first.'
    );

    const tempPhone = '9665501' + String(Math.floor(Math.random() * 100000)).padStart(5, '0');

    // Case A: no phone_change_mode at all — must refuse, nothing written.
    const noMode = await callAction(page, clinicId, 'crm_update_contact', {
      contact_id: TEST_CONTACT_ID,
      field: 'phone',
      value: tempPhone,
      causing_message: 'TC-CRM03-08 case A: no mode',
    });
    const afterNoMode = await callAction(page, clinicId, 'crm_get_contact', { contact_id: TEST_CONTACT_ID });
    const unchangedAfterNoMode = afterNoMode?.data?.phone === originalPhone;

    let aliasResult: any;
    let phoneAfterAlias: string | undefined;
    try {
      // Case B: alias mode — old number kept on record, new number becomes current.
      aliasResult = await callAction(page, clinicId, 'crm_update_contact', {
        contact_id: TEST_CONTACT_ID,
        field: 'phone',
        value: tempPhone,
        phone_change_mode: 'alias',
        causing_message: 'TC-CRM03-08 case B: alias mode',
      });
      const afterAlias = await callAction(page, clinicId, 'crm_get_contact', { contact_id: TEST_CONTACT_ID });
      phoneAfterAlias = afterAlias?.data?.phone;

      const ok =
        noMode?.error === 'phone_change_mode_required' &&
        unchangedAfterNoMode &&
        aliasResult?.success === true &&
        phoneAfterAlias === tempPhone;

      recorder.record({
        id: 'TC-CRM03-08',
        tool:
          'crm_update_contact(field=phone) — phone_change_mode gate ("replace" vs "alias"), found+fixed ' +
          '2026-09-11: a phone correction is ambiguous (data-entry mistake vs. the patient genuinely switched ' +
          "numbers) and the two readings have opposite-safety consequences for the old number's history.",
        trigger: '[direct action] phone change without phone_change_mode, then with phone_change_mode=alias',
        result: ok ? 'PASS' : 'FAIL',
        evidence:
          `no_mode_result=${JSON.stringify(noMode)} (stored phone unchanged: ${unchangedAfterNoMode})\n\n` +
          `alias_result=${JSON.stringify(aliasResult)}\n\nphone_after_alias="${phoneAfterAlias}" expected="${tempPhone}"\n\n` +
          `[Manual cross-check still needed] confirm patient_phone_aliases now holds the OLD number ` +
          `"${originalPhone}" for this contact — not independently checked here (no DB access from Playwright); ` +
          'live-verified via direct DB query in the 2026-09-11 build session.',
      });
      expect(noMode?.error, 'must refuse without phone_change_mode when the number actually differs').toBe('phone_change_mode_required');
      expect(unchangedAfterNoMode, 'the refused call must not have written anything').toBe(true);
      expect(aliasResult?.success, 'alias-mode call must succeed').toBe(true);
      expect(phoneAfterAlias, 'stored phone must be the new number after an alias-mode write').toBe(tempPhone);
    } finally {
      // Restore via replace mode — the temp number was never real, nothing about
      // it is worth preserving as history.
      const restore = await callAction(page, clinicId, 'crm_update_contact', {
        contact_id: TEST_CONTACT_ID,
        field: 'phone',
        value: originalPhone,
        phone_change_mode: 'replace',
        causing_message: 'QA cleanup: restore original phone after TC-CRM03-08',
      });
      // Hard-fail, not a console.warn — this is a SHARED fixture contact every
      // other test in this suite reads. A silent warning here is exactly what
      // let this test corrupt it undetected on its first run (2026-09-11): the
      // restore failed, nothing downstream noticed, and every later test that
      // touched TEST_CONTACT_ID inherited a wrong phone number until caught by
      // manual DB inspection.
      expect(
        restore?.success,
        `CRITICAL: failed to restore original phone "${originalPhone}" on SHARED fixture contact ` +
          `${TEST_CONTACT_ID} — every other test that reads this contact is now affected. Manual DB fix ` +
          `required immediately. restoreResult=${JSON.stringify(restore)}`
      ).toBe(true);
    }
    await context.close();
  });
});
