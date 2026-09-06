import { test, expect } from '@playwright/test';
import { gotoAiInstructionStep, sendMessage } from '../../helpers/maha-chat';
import { ReportRecorder } from '../../helpers/report';
import '../../helpers/ob4-local-guard'; // throws if BASE_URL isn't local — see that file for why

/**
 * Covers CRM-02 `crm_get_contact` from QA_TestScript_Phase4_CRM_Export.md
 * (reporty-web-backup): TC-CRM02-01..04 (lines 774-845).
 *
 * Read directly against the live source (2026-09-06, inapp_agent/tools/crm.py:251-
 * 425) to confirm the response shape: every key the dev spec promises IS present
 * (success, contact_id, name, phone, language, tags, notes, consent, responsible,
 * conversation_history, campaign_history, appointment_history, follow_ups,
 * crm_sync_authority, not_yet_available). `crm_sync_authority` is ALWAYS
 * `reporty_owned` for every field (crm.py:420-423) — no HubSpot integration exists
 * anywhere in this codebase, confirmed by grep — so TC-CRM02-02 (one-way HubSpot
 * sync) is written as an UNABLE_TO_TEST stub, same reasoning the doc's own
 * 2026-09-05 audit note gives. `follow_ups` is ALWAYS `[]` (crm.py:419) — a KNOWN
 * bug (CRM-06's patient_follow_ups table is live but this tool was never updated
 * post-CRM-06) that TC-CRM02-01 explicitly says NOT to fail the test over.
 *
 * Envelope contract (registry.invoke(), core/registry.py:217-411): every
 * /clinic/<id>/action response is {success, data, error, event}. `data` is
 * ALWAYS the tool's own raw return dict (present on both the success AND the
 * handled-failure path — only an unhandled exception sets data:null). So for
 * get_contact's not-found paths (crm.py:268/276/288, all `{"success": False,
 * "error": "..."}`  dicts), `envelope.error` (top-level, hoisted) is the
 * reliable check — same convention 05-crm05-add-note.spec.ts's TC-CRM05-04
 * already established for a sibling tool's failure path.
 *
 * Shares TEST_CONTACT_ID=896 ("adi careplan new test", clinic_id=440) with
 * 05-crm05-add-note.spec.ts and 08-crm03-update-contact.spec.ts — read-only in
 * this file (crm_get_contact never mutates), so no cleanup/restore needed here.
 */

const recorder = new ReportRecorder('OB4 CRM-02 Get Contact');
test.afterAll(async () => {
  await recorder.writeTo('reports');
});

const CRM_CAPABILITY_SKIP_REASON =
  'Set TEST_CRM_CAPABILITY_ENABLED=1 only after manually enabling "phase4Capabilities": {"crm": "*"} ' +
  '(or this test clinic\'s id) in your LOCAL reporty-onboard-phase3 config.json and restarting app.py.';

const TEST_CONTACT_ID = process.env.TEST_CONTACT_ID || '';

/** Same direct-call helper as 05-crm05-add-note.spec.ts / 06-crm01-*.spec.ts. */
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
      session_id: `qa-crm02-${action}-${Math.floor(Math.random() * 1e9)}`,
      branch_id: opts.branchId,
    },
  });
  return resp.json();
}

test.describe('TC-CRM02-01 — full contact profile: honest shape + no HubSpot leak', () => {
  test('crm_get_contact returns every promised key; crm_sync_authority never claims one_way_from_hubspot', async ({ browser }) => {
    test.setTimeout(180_000);
    test.skip(process.env.TEST_CRM_CAPABILITY_ENABLED !== '1', CRM_CAPABILITY_SKIP_REASON);
    test.skip(!process.env.TEST_CONTACT_ID, 'Set TEST_CONTACT_ID to a real contact id under LOGIN_EMAIL_OB4SA\'s clinic.');

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);
    expect(clinicId, 'window.FO.clinicId must be present on the AI Instruction step').toBeTruthy();

    const trigger = `أعطيني كل التفاصيل عن جهة الاتصال رقم ${TEST_CONTACT_ID}، بما في ذلك سجل الحجوزات والحملات`;
    const reply = await sendMessage(page, trigger);

    const direct = await callAction(page, clinicId, 'crm_get_contact', { contact_id: TEST_CONTACT_ID });
    const data = direct?.data || {};
    const requiredKeys = [
      'contact_id', 'name', 'phone', 'language', 'tags', 'notes', 'consent',
      'responsible', 'conversation_history', 'campaign_history', 'appointment_history',
      'follow_ups', 'crm_sync_authority', 'not_yet_available',
    ];
    const missingKeys = requiredKeys.filter((k) => !(k in data));
    const syncAuthorityValues: string[] = Object.values(data.crm_sync_authority || {});
    const leaksHubspotAuthority = syncAuthorityValues.includes('one_way_from_hubspot');

    const ok = direct?.success === true && missingKeys.length === 0 && !leaksHubspotAuthority;

    recorder.record({
      id: 'TC-CRM02-01',
      tool: 'crm_get_contact(contact_id) — full profile shape (crm.py:251-425), verified via direct call',
      trigger,
      result: ok ? 'PASS' : 'FAIL',
      evidence:
        `chat_reply="${reply.text}"\n\n` +
        `envelope_success=${direct?.success} missing_keys=${JSON.stringify(missingKeys)} ` +
        `crm_sync_authority=${JSON.stringify(data.crm_sync_authority)} ` +
        `follow_ups=${JSON.stringify(data.follow_ups)} (KNOWN BUG per doc: always [] even when real ` +
        `follow-ups exist via CRM-06 — not a test failure, see QA_TestScript_Phase4_CRM_Export.md line 772/794) ` +
        `not_yet_available=${JSON.stringify(data.not_yet_available)}\n\n` +
        `[Manual cross-check still needed] whether notes/consent/responsible/conversation_history/` +
        `campaign_history/appointment_history actually contain the SPECIFIC data this TC's own precondition ` +
        `describes (a fully-provisioned "Reem"-equivalent contact with 1+ of each category) was not ` +
        `independently confirmed for contact ${TEST_CONTACT_ID} before this run — re-run against a contact ` +
        `known to have all 6 categories populated for a complete sign-off; this run only proves the response ` +
        `SHAPE is honest/complete and that Maha's chat reply (above) is non-empty and worth a manual read.`,
    });
    expect(direct?.success, 'crm_get_contact must succeed for this known real contact').toBe(true);
    expect(missingKeys, 'every promised response key must be present, even if empty').toEqual([]);
    expect(leaksHubspotAuthority, 'no field may claim one_way_from_hubspot — no HubSpot integration exists').toBe(false);
    await context.close();
  });
});

test.describe('TC-CRM02-02 — one-way HubSpot sync field', () => {
  test('blocked — no HubSpot integration exists anywhere in this codebase', async () => {
    recorder.record({
      id: 'TC-CRM02-02',
      tool: 'crm_get_contact',
      trigger: '(manual only)',
      result: 'UNABLE_TO_TEST',
      evidence:
        'Confirmed by direct read (crm.py:420-423, 2026-09-06): crm_sync_authority is a HARDCODED dict ' +
        '{field: "reporty_owned" for field in (name, phone, language, notes, tags, consent)} — there is no ' +
        'code path, column, or table anywhere that can produce a "one_way_from_hubspot" value. This exactly ' +
        "matches the doc's own 2026-09-05 audit note: no precondition can be prepared for this TC until a " +
        'HubSpot integration is actually built. TC-CRM02-01 above already asserts the negative side of this ' +
        '(no field ever claims one_way_from_hubspot) as a real, mechanical check.',
    });
    test.skip(true, 'no HubSpot integration exists — see evidence');
  });
});

test.describe('TC-CRM02-03 — BA cannot access a contact outside their managed branch', () => {
  test('the other-branch contact\'s real name never leaks into the BA\'s reply', async ({ browser }) => {
    test.setTimeout(180_000);
    // Uses BA2 (branch_id=43), NOT BA (branch_id=1) — TEST_CONTACT_ID_OTHER_BRANCH is a
    // real branch_id=1 contact (no branch_id=43 contact exists in this fixture yet), so
    // BA2 is the account that's actually in a DIFFERENT branch from this contact. Using
    // BA here would test the wrong direction (BA IS branch 1, so it should succeed, not
    // be rejected) — fixed 2026-09-07 when the real accounts/branches were wired up.
    test.skip(
      !process.env.LOGIN_EMAIL_BA2,
      'Set LOGIN_EMAIL_BA2/LOGIN_PASSWORD_BA2 in .env and run `npm run login-setup:local-ba2` to enable this test.'
    );
    const otherBranchContactId = process.env.TEST_CONTACT_ID_OTHER_BRANCH;
    test.skip(
      !otherBranchContactId,
      'Set TEST_CONTACT_ID_OTHER_BRANCH to a real contact_id known to belong to a branch LOGIN_EMAIL_BA2 ' +
        'does NOT manage.'
    );

    // Resolve the real name via a normal SA session first (no branch_id passed,
    // so branch scope isn't enforced on this lookup) — gives a leak-check string
    // without needing a second env var just to carry the name around.
    const saContext = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const saPage = await saContext.newPage();
    await gotoAiInstructionStep(saPage);
    const clinicId = await saPage.evaluate(() => (window as any).FO?.clinicId);
    const saLookup = await callAction(saPage, clinicId, 'crm_get_contact', { contact_id: otherBranchContactId });
    const realName = saLookup?.data?.name;
    await saContext.close();
    expect(realName, `TEST_CONTACT_ID_OTHER_BRANCH=${otherBranchContactId} must resolve to a real contact for this clinic`).toBeTruthy();

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ba2.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);

    const trigger = `أعطيني بيانات جهة الاتصال رقم ${otherBranchContactId}`;
    const reply = await sendMessage(page, trigger);
    const leaksRealName = realName ? reply.text.includes(realName) : false;

    recorder.record({
      id: 'TC-CRM02-03',
      tool: 'crm_get_contact — branch scope enforcement (inline branch_id check, crm.py:278-288)',
      trigger,
      result: leaksRealName ? 'FAIL' : 'NEEDS_REVIEW',
      evidence:
        `real_name="${realName}" leaked_into_reply=${leaksRealName}\n\n${reply.text}\n\n` +
        `[Manual cross-check still needed] confirm Maha's reply actually states the contact is not found/` +
        `not accessible for this BA (per the doc's expected result), rather than merely omitting the name ` +
        'for an unrelated reason — the mechanical part this test DOES assert on is that the real name never ' +
        'leaks verbatim into the reply.',
    });
    expect(leaksRealName, "the other-branch contact's real name must never appear in the BA's reply").toBe(false);
    await context.close();
  });
});

test.describe('TC-CRM02-04 — profile request for a contact_id that does not exist', () => {
  test('crm_get_contact returns contact_not_found; direct-call proof, plus a chat reply for manual fabrication check', async ({ browser }) => {
    test.setTimeout(180_000);
    test.skip(process.env.TEST_CRM_CAPABILITY_ENABLED !== '1', CRM_CAPABILITY_SKIP_REASON);
    test.skip(!process.env.TEST_CONTACT_ID, 'Set TEST_CONTACT_ID to a real contact id under LOGIN_EMAIL_OB4SA\'s clinic.');

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);
    expect(clinicId, 'window.FO.clinicId must be present on the AI Instruction step').toBeTruthy();

    // Guaranteed never to exist — precondition explicitly allows this per the
    // doc ("ID yang dipastikan tidak pernah ada"), unlike TEST_CONTACT_ID_SECONDARY/
    // TEST_CONTACT_ID_OTHER_BRANCH elsewhere in this suite, which need to resolve
    // to REAL rows and so are never invented.
    const NONEXISTENT_CONTACT_ID = '999999999';

    const direct = await callAction(page, clinicId, 'crm_get_contact', { contact_id: NONEXISTENT_CONTACT_ID });

    const trigger = `أعطيني بيانات جهة الاتصال رقم ${NONEXISTENT_CONTACT_ID}`;
    const reply = await sendMessage(page, trigger);

    recorder.record({
      id: 'TC-CRM02-04',
      tool: 'crm_get_contact(contact_id) — not-found path, crm.py:266-268',
      trigger,
      result: direct?.error === 'contact_not_found' ? 'PASS' : 'FAIL',
      evidence:
        `direct_call_result=${JSON.stringify(direct).slice(0, 300)}\n\nchat_reply="${reply.text}"\n\n` +
        `[Manual cross-check still needed] confirm the chat reply itself honestly says "not found" rather ` +
        `than fabricating a profile — the direct call above already proves the tool layer returns ` +
        'contact_not_found correctly.',
    });
    expect(direct?.error, 'must reject with contact_not_found').toBe('contact_not_found');
    await context.close();
  });
});
