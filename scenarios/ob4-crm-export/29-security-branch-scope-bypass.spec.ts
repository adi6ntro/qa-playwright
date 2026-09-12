import { test, expect } from '@playwright/test';
import { gotoAiInstructionStep } from '../../helpers/maha-chat';
import { ReportRecorder } from '../../helpers/report';
import '../../helpers/ob4-local-guard'; // throws if BASE_URL isn't local — see that file for why

/**
 * Covers CRM-02's TC-CRM02-05 from QA_TestScript_Phase4_CRM_Export.md (reporty-web-backup)
 * — a security finding from the 2026-09-11 CRM-02 audit, NOT a CRM-02-specific gap.
 *
 * The fix lives in `MyClinicAiController::resolveBranchId()` (reporty-web-backup), which
 * every `fo/*` endpoint routes through (chat, instructions CRUD, preview/confirm) — so
 * this is a regression guard for OB3 (instructions) too, not just OB4 CRM.
 *
 * Root cause (found reading the code directly, 2026-09-11): `resolveBranchId()` only
 * validated that the client-supplied `branch_id` belonged to the CLINIC — never that it
 * belonged to the branch_admin actually logged in. Two live vectors:
 *   (a) BA sends another branch's id in the request body directly.
 *   (b) BA omits `branch_id` entirely — which `reporty-onboard-phase3/inapp_agent/
 *       tools/crm.py`'s `get_contact()` (and siblings) treat as "no branch filter at
 *       all", i.e. every branch in the facility, not just the caller's own.
 * Fixed: when `Session::get('branch_admin') == 1`, the request's `branch_id` is now
 * ignored unconditionally and replaced with `Session::get('branch_id')` (the same
 * session convention `MyDoctorController`/`MyScheduleController`/`CustomerController`
 * already use for this role).
 *
 * Deliberately different from 07-crm02-get-contact.spec.ts's TC-CRM02-03: that test
 * drives the real chat UI, which only ever sends the BA's OWN branch_id — it can never
 * exercise this bug. This test calls the real Laravel endpoint directly
 * (`page.request.post`, not the chat textbox) so `branch_id` in the body can be
 * deliberately spoofed or omitted, the same way a tampered request from a malicious
 * or compromised BA browser session would look. `customer/my-clinic/fo/*` is excluded
 * from CSRF (`VerifyCsrfToken::$except`), so no token juggling is needed — the
 * browser context's session cookie (from storageState) is all `page.request` needs.
 */

const recorder = new ReportRecorder('OB4 Security Branch Scope Bypass');
test.afterAll(async () => {
  await recorder.writeTo('reports');
});

const BA_SKIP_REASON =
  'Set LOGIN_EMAIL_BA/LOGIN_PASSWORD_BA in .env and run `npm run login-setup:local-ba` to enable this test.';
const BA2_SKIP_REASON =
  'Set LOGIN_EMAIL_BA2/LOGIN_PASSWORD_BA2 in .env and run `npm run login-setup:local-ba2` to enable this test.';

async function directGetContact(page: import('@playwright/test').Page, clinicId: string, contactId: string) {
  const resp = await page.request.post(`http://localhost:9559/clinic/${clinicId}/action`, {
    data: {
      action: 'crm_get_contact',
      params: { contact_id: contactId },
      session_id: `qa-sec-lookup-${Math.floor(Math.random() * 1e9)}`,
    },
  });
  return resp.json();
}

async function foChat(
  page: import('@playwright/test').Page,
  clinicId: string,
  message: string,
  branchId?: string
) {
  const body: Record<string, unknown> = {
    message,
    session_id: `qa-sec-chat-${Math.floor(Math.random() * 1e9)}`,
  };
  // Only set the key at all when a value is given — JSON.stringify(undefined-valued
  // key) drops it, which is exactly what "omitted branch_id" needs to look like on
  // the wire (not `branch_id: null`, an actually-absent field).
  if (branchId !== undefined) body.branch_id = branchId;

  const resp = await page.request.post(`/customer/my-clinic/fo/chat/${clinicId}`, { data: body });
  return resp.json();
}

test.describe('TC-CRM02-05 — branch_admin cannot cross branches via request tampering', () => {
  test('spoofed AND omitted branch_id in fo/chat body both stay pinned to the BA\'s own branch', async ({ browser }) => {
    // 3 browser contexts (SA, BA, BA2) each through the full AI Instruction step
    // navigation + 2 real chat round-trips — needs more headroom than the 2-context
    // tests elsewhere in this suite (180_000 measured too tight live, 2026-09-11).
    test.setTimeout(360_000);
    test.skip(!process.env.LOGIN_EMAIL_BA, BA_SKIP_REASON);
    test.skip(!process.env.LOGIN_EMAIL_BA2, BA2_SKIP_REASON);
    const otherBranchContactId = process.env.TEST_CONTACT_ID_OTHER_BRANCH;
    test.skip(
      !otherBranchContactId,
      'Set TEST_CONTACT_ID_OTHER_BRANCH to a real contact_id known to belong to a branch LOGIN_EMAIL_BA2 does NOT manage.'
    );

    // Ground truth: the contact's real name, resolved via SA (no branch_id passed,
    // so branch scope isn't enforced on this lookup) — same technique TC-CRM02-03
    // already established, so this test doesn't need its own env var just to carry
    // the name around.
    const saContext = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const saPage = await saContext.newPage();
    await gotoAiInstructionStep(saPage);
    const saClinicId = await saPage.evaluate(() => (window as any).FO?.clinicId);
    const saLookup = await directGetContact(saPage, saClinicId, otherBranchContactId!);
    const realName: string | undefined = saLookup?.data?.name;
    await saContext.close();
    expect(realName, `TEST_CONTACT_ID_OTHER_BRANCH=${otherBranchContactId} must resolve to a real contact`).toBeTruthy();

    // The branch id we'll try to spoof BA2 into — BA's own real branch, read from
    // their own session rather than hardcoded, so this test stays valid if the
    // fixture accounts' branch assignments ever change.
    const baContext = await browser.newContext({ storageState: 'auth/.storage-state.ba.local.json' });
    const baPage = await baContext.newPage();
    await gotoAiInstructionStep(baPage);
    const baBranchId = await baPage.evaluate(() => (window as any).FO?.branchId);
    await baContext.close();
    expect(baBranchId, "BA's own branch id must resolve from window.FO.branchId").toBeTruthy();

    // The attacker: BA2, a real branch_admin pinned to a DIFFERENT branch than the
    // one holding otherBranchContactId.
    const context = await browser.newContext({ storageState: 'auth/.storage-state.ba2.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const ba2ClinicId = await page.evaluate(() => (window as any).FO?.clinicId);
    expect(ba2ClinicId).toBeTruthy();

    const message = `أعطيني بيانات جهة الاتصال رقم ${otherBranchContactId}`;

    // Case A: branch_id spoofed to BA's branch (not BA2's own).
    const spoofed = await foChat(page, ba2ClinicId, message, String(baBranchId));
    const spoofedReply: string = spoofed?.reply || '';
    const leaksViaSpoof = realName ? spoofedReply.includes(realName) : false;

    // Case B: branch_id omitted from the request body entirely.
    const omitted = await foChat(page, ba2ClinicId, message, undefined);
    const omittedReply: string = omitted?.reply || '';
    const leaksViaOmit = realName ? omittedReply.includes(realName) : false;

    const ok = !leaksViaSpoof && !leaksViaOmit;

    recorder.record({
      id: 'TC-CRM02-05',
      tool:
        'MyClinicAiController::resolveBranchId() — branch_admin is hard-pinned to Session::branch_id ' +
        'regardless of what the request sends (fixed 2026-09-11)',
      trigger: `[spoofed branch_id=${baBranchId}] "${message}" / [omitted branch_id] "${message}"`,
      result: ok ? 'PASS' : 'FAIL',
      evidence:
        `real_name="${realName}"\n` +
        `spoofed_branch_id_reply="${spoofedReply}" leaked=${leaksViaSpoof}\n\n` +
        `omitted_branch_id_reply="${omittedReply}" leaked=${leaksViaOmit}\n\n` +
        `[Manual cross-check still needed] confirm both replies actually state the contact is not found/not ` +
        `accessible for this BA, rather than merely omitting the name for an unrelated reason (e.g. a transient ` +
        `tool error) — the mechanical part this test DOES assert on is that the real name never leaks verbatim ` +
        `into either reply.`,
    });
    expect(leaksViaSpoof, "a spoofed branch_id naming another branch must never leak that branch's contact name").toBe(false);
    expect(leaksViaOmit, 'an omitted branch_id must never fall back to unscoped (all-branch) access').toBe(false);
    await context.close();
  });
});
