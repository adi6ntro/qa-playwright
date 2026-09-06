import { test, expect } from '@playwright/test';
import { gotoAiInstructionStep, sendMessage } from '../../helpers/maha-chat';
import { ReportRecorder } from '../../helpers/report';
import '../../helpers/ob4-local-guard'; // throws if BASE_URL isn't local — see that file for why

/**
 * Covers CRM-04 `crm_set_responsible`, from QA_TestScript_Phase4_CRM_Export.md's
 * 2026-09-05 re-audit — confirmed REAL against the live code (crm.py's
 * set_responsible(), ~line 526), simplified vs the dev spec: person-only
 * assignment, not the spec's `{type: "person"|"team", id}` — Q3 (Adi,
 * 2026-09-04) dropped team assignment for Phase 4 entirely (no assignee_type
 * column exists at all). The assignment-notification row genuinely lands in
 * Laravel's `notifications` table, but nothing reads it yet — "notified"
 * technically true, invisible to anyone in the dashboard/WhatsApp in practice.
 * Per the doc's own callout, that gap is NOT a test failure.
 *
 * TC-CRM04-02/03 (team / mixed-team assignment) are SKIP stubs below — there is
 * no team concept anywhere in crm_set_responsible, so "empty_team" can never
 * fire and there is nothing to execute.
 *
 * Same contact-identification gap already found and documented in
 * 05-crm05-add-note.spec.ts: crm_search_contacts has no name/phone filter, and
 * no CRM tool can resolve "the contact named X" to a numeric id on its own — so
 * every trigger below references the target contact by its numeric id, not by
 * name, exactly like 05-crm05's own triggers.
 */

const recorder = new ReportRecorder('OB4 CRM-04 Set Responsible');
test.afterAll(async () => {
  await recorder.writeTo('reports');
});

const CRM_CAPABILITY_SKIP_REASON =
  'Set TEST_CRM_CAPABILITY_ENABLED=1 only after manually enabling "phase4Capabilities": {"crm": "*"} ' +
  '(or this test clinic\'s id) in your LOCAL reporty-onboard-phase3 config.json and restarting app.py.';

// Same pre-existing contact as 05-crm05-add-note.spec.ts (patients.id=896,
// clinic_id=440, name "adi careplan new test") — not created by this suite.
const TEST_CONTACT_ID = process.env.TEST_CONTACT_ID || '';

/**
 * Calls a registered tool directly via reporty-onboard-phase3's own
 * `POST /clinic/<id>/action` endpoint (registry.invoke(), same code path a chat
 * tool call uses) — bypasses the LLM and Laravel entirely, same rationale as
 * 05-crm05-add-note.spec.ts's own callAction(): reads back structured JSON
 * instead of trusting a natural-language chat reply to quote something
 * verbatim. Envelope confirmed by reading app.py's Action.post() + registry.
 * invoke() directly: `{success, data, error, event}` where `data` is the raw
 * tool function's own return dict (which usually carries its own nested
 * `success`/`error` too).
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
      session_id: `qa-crm04-${action}-${Math.floor(Math.random() * 1e9)}`,
      branch_id: opts.branchId,
    },
  });
  return resp.json();
}

test.describe('TC-CRM04-01 — assign a contact to an individual staff member', () => {
  test('responsible is stored as {type:"person", id, display_name} matching the named staff member', async ({ browser }) => {
    test.setTimeout(180_000);
    test.skip(process.env.TEST_CRM_CAPABILITY_ENABLED !== '1', CRM_CAPABILITY_SKIP_REASON);
    test.skip(!process.env.TEST_CONTACT_ID, 'Set TEST_CONTACT_ID to a real contact id under LOGIN_EMAIL_OB4SA\'s clinic.');
    test.skip(
      !process.env.TEST_CRM_ASSIGNEE_ID || !process.env.TEST_CRM_ASSIGNEE_NAME,
      'Set TEST_CRM_ASSIGNEE_ID/TEST_CRM_ASSIGNEE_NAME to a real staff member of this test clinic ' +
        '(a users row with id=440 or parent_user_id=440 — check clinic 440\'s Staff/My Doctor module) so the ' +
        'chat trigger has a real name for Maha to resolve to a real assignee_id, and the direct-call check has ' +
        'a real id to match against. See QA_TestScript_Phase4_CRM_Export.md TC-CRM04-01 setup step 2. ' +
        '(Shared with 10-crm06-follow-ups.spec.ts\'s TC-CRM06-01 — same "real staff member of this clinic" ' +
        'requirement as crm_create_follow_up\'s assignee_id.)'
    );

    const assigneeId = process.env.TEST_CRM_ASSIGNEE_ID!;
    const assigneeName = process.env.TEST_CRM_ASSIGNEE_NAME!;

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);
    expect(clinicId, 'window.FO.clinicId must be present on the AI Instruction step').toBeTruthy();

    const trigger = `عيّني جهة الاتصال رقم ${TEST_CONTACT_ID} لمسؤولية ${assigneeName}`;
    const reply = await sendMessage(page, trigger);

    recorder.record({
      id: 'TC-CRM04-01-reply',
      tool: 'crm_set_responsible(contact_id, assignee_id, causing_message) — chat trigger, raw reply captured for review',
      trigger,
      result: 'NEEDS_REVIEW',
      evidence: reply.text,
    });

    const getResult = await callAction(page, clinicId, 'crm_get_contact', { contact_id: TEST_CONTACT_ID });
    const responsible: { type?: string; id?: number | string; display_name?: string } | null =
      getResult?.data?.responsible ?? null;
    const storedCorrectly = responsible?.type === 'person' && String(responsible?.id) === String(assigneeId);

    recorder.record({
      id: 'TC-CRM04-01',
      tool: 'crm_get_contact(contact_id).responsible — direct read, not chat',
      trigger: `[direct action, not chat] crm_get_contact contact_id=${TEST_CONTACT_ID}`,
      result: storedCorrectly ? 'PASS' : 'FAIL',
      evidence:
        `responsible=${JSON.stringify(responsible)} expected type="person" id=${assigneeId} (${assigneeName})\n\n` +
        `[Doc's Expected Result #2 — a "notifications" table row for the assignee — is a direct-DB-only check ` +
        `per the doc's own caveat: no dashboard/WhatsApp UI reads it, and no CRM tool exposes that table, so it ` +
        `is NOT independently re-verified here. crm_set_responsible()'s own success response having ` +
        `notification_channel_used="dashboard" (visible in the raw chat reply captured above) is the only ` +
        `visibility this suite has into that half of the spec.]`,
    });
    expect(storedCorrectly, `responsible must be {type:"person", id:${assigneeId}}, got ${JSON.stringify(responsible)}`).toBe(true);
    await context.close();
  });
});

test.describe('TC-CRM04-02 — SKIP (fitur di-drop) — assign to a mixed opt-in team', () => {
  test('not applicable — team assignment does not exist as a feature', () => {
    recorder.record({
      id: 'TC-CRM04-02',
      tool: 'crm_set_responsible — team assignment',
      trigger: '(not applicable)',
      result: 'UNABLE_TO_TEST',
      evidence:
        'Feature dropped from product scope (Q3, Adi, 2026-09-04) — crm_set_responsible is person-only, no ' +
        '{type:"team"} support exists anywhere in the code to test against. Kept for reference per the doc\'s ' +
        'own note ("disimpan untuk referensi bila fitur team ditambahkan nanti"), not executed.',
    });
    test.skip(
      true,
      'feature dropped from product scope — no team/polymorphic assignee support, person-only by design; see ' +
        'QA_TestScript_Phase4_CRM_Export.md CRM-04 callout'
    );
  });
});

test.describe('TC-CRM04-03 — SKIP (fitur di-drop) — assign to an empty team', () => {
  test('not applicable — empty_team can never trigger, no team concept exists', () => {
    recorder.record({
      id: 'TC-CRM04-03',
      tool: 'crm_set_responsible — empty_team error path',
      trigger: '(not applicable)',
      result: 'UNABLE_TO_TEST',
      evidence:
        'Same as TC-CRM04-02 — there is no concept of a "team" in crm_set_responsible at all, so an ' +
        'empty_team error path was never built and can never fire.',
    });
    test.skip(
      true,
      'feature dropped from product scope — no team concept in crm_set_responsible at all, so empty_team can ' +
        'never trigger; see QA_TestScript_Phase4_CRM_Export.md CRM-04 callout'
    );
  });
});

test.describe('TC-CRM04-04 — branch scope is checked for the ASSIGNEE, not just the contact', () => {
  test('a branch_admin cannot assign their own-branch contact to staff outside their managed branch', async ({ browser }) => {
    test.setTimeout(180_000);
    test.skip(process.env.TEST_CRM_CAPABILITY_ENABLED !== '1', CRM_CAPABILITY_SKIP_REASON);
    test.skip(!process.env.TEST_CONTACT_ID, 'Set TEST_CONTACT_ID to a real contact id under LOGIN_EMAIL_OB4SA\'s clinic.');
    test.skip(
      !process.env.LOGIN_EMAIL_BA,
      'Set LOGIN_EMAIL_BA/LOGIN_PASSWORD_BA in .env and run `npm run login-setup:local-ba` to enable this test.'
    );
    test.skip(
      !process.env.TEST_CRM04_BRANCH_CONTACT_ID ||
        !process.env.TEST_CRM04_OUT_OF_BRANCH_ASSIGNEE_ID ||
        !process.env.TEST_CRM04_OUT_OF_BRANCH_ASSIGNEE_NAME,
      'Need a contact known to belong to the BA\'s own managed branch (TEST_CRM04_BRANCH_CONTACT_ID) and a real ' +
        'staff member registered to a DIFFERENT branch, i.e. a user_infos row with a different branch_id ' +
        '(TEST_CRM04_OUT_OF_BRANCH_ASSIGNEE_ID/_NAME) to exercise the cross-branch rejection. See ' +
        'QA_TestScript_Phase4_CRM_Export.md TC-CRM04-04 setup steps 2-3 for how to set this up by hand.'
    );

    const contactId = process.env.TEST_CRM04_BRANCH_CONTACT_ID!;
    const outOfBranchAssigneeId = process.env.TEST_CRM04_OUT_OF_BRANCH_ASSIGNEE_ID!;
    const outOfBranchAssigneeName = process.env.TEST_CRM04_OUT_OF_BRANCH_ASSIGNEE_NAME!;

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ba.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);
    expect(clinicId, 'window.FO.clinicId must be present on the AI Instruction step').toBeTruthy();

    const before = await callAction(page, clinicId, 'crm_get_contact', { contact_id: contactId });
    const responsibleBefore = before?.data?.responsible ?? null;

    const trigger = `عيّني جهة الاتصال رقم ${contactId} لمسؤولية ${outOfBranchAssigneeName}`;
    const reply = await sendMessage(page, trigger);

    const after = await callAction(page, clinicId, 'crm_get_contact', { contact_id: contactId });
    const responsibleAfter = after?.data?.responsible ?? null;

    const notAssignedToOutOfBranchStaff = String(responsibleAfter?.id) !== String(outOfBranchAssigneeId);
    const unchanged = JSON.stringify(responsibleBefore) === JSON.stringify(responsibleAfter);

    recorder.record({
      id: 'TC-CRM04-04',
      tool: 'crm_set_responsible — branch scope must be checked for the assignee (dr. Y), not only for the contact',
      trigger,
      result: notAssignedToOutOfBranchStaff && unchanged ? 'PASS' : 'FAIL',
      evidence:
        `reply="${reply.text}"\nresponsible_before=${JSON.stringify(responsibleBefore)} ` +
        `responsible_after=${JSON.stringify(responsibleAfter)}\n` +
        `not_assigned_to_out_of_branch_staff=${notAssignedToOutOfBranchStaff} unchanged=${unchanged}`,
    });
    expect(notAssignedToOutOfBranchStaff, 'the out-of-branch staff member must never end up as responsible').toBe(true);
    expect(unchanged, 'the responsible field must be completely unchanged after a rejected cross-branch assignment').toBe(true);
    await context.close();
  });
});
