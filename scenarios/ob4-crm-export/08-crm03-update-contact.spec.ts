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

    const trigger = `غيّري رقم هاتف جهة الاتصال رقم ${TEST_CONTACT_ID} إلى ${secondaryPhone}`;
    const reply = await sendMessage(page, trigger);

    // Direct-call cross-check, bypassing whatever phone format the LLM chose to
    // pass through — proves the tool layer itself rejects the exact duplicate.
    // Never mutates contact A's phone regardless of outcome: the DB-level
    // duplicate check (crm.py:464-474) rejects deterministically either way, so
    // no cleanup is needed here.
    const direct = await callAction(page, clinicId, 'crm_update_contact', {
      contact_id: TEST_CONTACT_ID,
      field: 'phone',
      value: secondaryPhone,
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
        `chat_reply="${reply.text}"\n\ndirect_call_result=${JSON.stringify(direct).slice(0, 300)}\n\n` +
        `[Manual cross-check still needed] confirm the CHAT reply reports the error and stops — does NOT ` +
        `auto-offer/start a merge flow (this is the current real, correct behavior per the doc's own note, ` +
        `not a bug to fail on).`,
    });
    expect(rejected, 'must reject with error=duplicate_phone').toBe(true);
    expect(mergeTargetCorrect, 'merge_target_id must point at the contact that already owns this phone number').toBe(true);
    await context.close();
  });
});

test.describe('TC-CRM03-05 — causing_message is a required field', () => {
  test('crm_update_contact rejects a call with no causing_message — direct call, no chat/LLM involved', async ({ browser }) => {
    test.setTimeout(60_000);
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
