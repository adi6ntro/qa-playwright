import { test, expect } from '@playwright/test';
import { gotoAiInstructionStep, sendMessage } from '../../helpers/maha-chat';
import { ReportRecorder } from '../../helpers/report';
import '../../helpers/ob4-local-guard'; // throws if BASE_URL isn't local — see that file for why

/**
 * Covers RMD-02 (`staff_reminder_list`) from QA_TestScript_Phase4_CRM_Export.md,
 * TC-RMD02-01..03. See 24-rmd01-self-reminder.spec.ts's header for the shared RMD
 * background (uncommitted branch, no team target, "self" collapses to clinic_id).
 *
 * IMPORTANT deviation found while building this (2026-09-06, reading
 * inapp_agent/tools/staff_reminders.py's list_reminders() docstring directly): the
 * doc's TC-RMD02-01 expects a follow-up "export ke PDF" to succeed using the list's
 * set_ref. list_reminders() returns NO set_ref at all — its own docstring says so
 * explicitly ("export_result only supports crm_search_contacts-shaped set_refs
 * today... returning one that can't actually be exported would be a capability
 * lie"). So that part of the doc's expected result is stale; TC-RMD02-01 below tests
 * the corrected behavior instead (an export-from-reminders request must NOT succeed).
 *
 * Also worth flagging (not asserted here as a bug, since it needs live LLM-behavior
 * evidence this suite can't gather deterministically): `staff_reminder_list`'s
 * `branch_id` filter is caller-supplied, not server-enforced against the acting BA's
 * actual scope — same "acting_user_id doesn't reach the tool" gap as everywhere else
 * in RMD. TC-RMD02-02/03 below prove the SQL-level filter itself correctly excludes
 * another branch's rows when `branch_id` IS supplied; they do NOT prove Maha always
 * supplies the correct branch_id for a BA's own request — that's a separate,
 * unverified trust boundary worth a follow-up audit (same class of question the
 * RMD-03 cancel/mark_done gap already raised for write actions, potentially applying
 * to this read tool too).
 */

const recorder = new ReportRecorder('OB4 RMD-02 List Reminders');
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
      session_id: `qa-rmd02-${action}-${Math.floor(Math.random() * 1e9)}`,
      branch_id: opts.branchId,
    },
  });
  return resp.json();
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
function tomorrowAt(hour: number): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}

test.describe('TC-RMD02-01 — list own reminders; export-from-list corrected expectation', () => {
  test('own active reminders are listed, and the doc\'s stale export-follow-up claim does not hold', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    capabilityGate();

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);
    expect(clinicId).toBeTruthy();

    const marker = 'QA_RMD0201_MARKER';
    const setup = await callAction(page, clinicId, 'staff_reminder_create', {
      target_type: 'self',
      due_at: tomorrowAt(9),
      message: `${marker} follow up test fixture`,
      causing_message: '[direct action, not chat] TC-RMD02-01 setup fixture',
    });
    expect(setup?.success, 'setup fixture reminder must be created').toBe(true);

    const reply = await sendMessage(page, 'أظهري تذكيراتي لهذا الأسبوع');

    const listResult = await callAction(page, clinicId, 'staff_reminder_list', {
      target_type: 'self',
      include_fired: true,
      limit: 50,
    });
    const rows: Array<{ message?: string }> = listResult?.data?.rows || [];
    const found = rows.some((r) => typeof r.message === 'string' && r.message.includes(marker));

    recorder.record({
      id: 'TC-RMD02-01',
      tool: 'staff_reminder_list(target_type=self) — verified via direct read, chat reply captured as evidence',
      trigger: 'أظهري تذكيراتي لهذا الأسبوع',
      result: found ? 'PASS' : 'FAIL',
      evidence: `own_reminder_found=${found}\n\nchat reply: "${reply.text}"`,
    });
    expect(found, 'the fixture reminder must actually be listable').toBe(true);

    // Corrected export-follow-up check — see file header. No set_ref exists for a
    // reminders list, so a claimed successful PDF export from it would be fabricated.
    const exportReply = await sendMessage(page, 'صدّري هذه التذكيرات كملف PDF');
    const claimsExportSuccess = /(تم تصدير|✅.*(pdf|تصدير)|رابط التحميل|تم إنشاء الملف)/i.test(exportReply.text);

    recorder.record({
      id: 'TC-RMD02-01-EXPORT-DEVIATION',
      tool: 'export_result — corrected expectation, see file header deviation note',
      trigger: 'صدّري هذه التذكيرات كملف PDF',
      result: claimsExportSuccess ? 'FAIL' : 'NEEDS_REVIEW',
      evidence:
        `claims_export_success=${claimsExportSuccess} — list_reminders() returns no set_ref at all, so ` +
        `a genuine PDF export from a reminders list is not possible today; a claimed success here would be ` +
        `fabricated.\n\n${exportReply.text}`,
    });
    expect(claimsExportSuccess, 'must not falsely claim a PDF export succeeded from a reminders list').toBe(false);
    await context.close();
  });
});

test.describe('TC-RMD02-02 / TC-RMD02-03 — branch-scoped list, own branch vs another branch', () => {
  test('branch_id filter includes the BA\'s own branch and excludes another branch', async ({ browser }) => {
    test.setTimeout(180_000);
    capabilityGate();
    test.skip(
      !process.env.LOGIN_EMAIL_BA,
      'Set LOGIN_EMAIL_BA/LOGIN_PASSWORD_BA and run `npm run login-setup:local-ba` to enable this test.'
    );

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ba.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);
    const baBranchId = await page.evaluate(() => (window as any).FO?.branchId);
    expect(clinicId).toBeTruthy();
    expect(baBranchId, 'BA session must resolve a branch id — required for this test').toBeTruthy();

    const inBranchMarker = 'QA_RMD0202_INBRANCH';
    const otherBranchMarker = 'QA_RMD0202_OTHERBRANCH';
    // The "other branch" id doesn't need to correspond to a real branch row — the
    // list_reminders() filter is a plain equality check (branch_id = %s OR IS NULL),
    // no FK validated against a branches table anywhere in create_reminder() either.
    const otherBranchId = String(Number(baBranchId) + 900000);

    // ⚠️ REAL BACKEND BUG found here (2026-09-07), not a test issue: `branch_id` can
    // NEVER be supplied inside `params` — the registry ALWAYS auto-injects its own
    // `branch_id` keyword (from the session-level context) when calling the
    // underlying function, regardless of whether the session-level field is itself
    // set or null. Any `params.branch_id` on top of that crashes every time with
    // "got multiple values for keyword argument 'branch_id'" — confirmed via 3 direct
    // curl reproductions (with session branch_id set, with it unset, and finally
    // omitting params.branch_id entirely, which succeeded and correctly stored the
    // session-level value). Traced to registrations.py:955-960 (`fn=lambda clinic_id,
    // ..., branch_id=None, **_: create_reminder(..., branch_id=branch_id)`), invoked
    // as `fn(clinic_id=..., branch_id=<session value>, **params)` — this affects EVERY
    // tool registered with this exact lambda shape (any `branch_id` parameter), not
    // just staff_reminder_create. The only working way to set a reminder's branch is
    // the session-level field (callAction's 5th `{branchId}` arg) — params.branch_id
    // is structurally unusable and must never be passed.
    const setupIn = await callAction(
      page,
      clinicId,
      'staff_reminder_create',
      {
        target_type: 'self',
        due_at: tomorrowAt(9),
        message: `${inBranchMarker} in-branch fixture`,
        causing_message: '[direct action, not chat] TC-RMD02-02 setup fixture (own branch)',
      },
      { branchId: String(baBranchId) }
    );
    const setupOther = await callAction(
      page,
      clinicId,
      'staff_reminder_create',
      {
        target_type: 'self',
        due_at: tomorrowAt(9),
        message: `${otherBranchMarker} other-branch fixture`,
        causing_message: '[direct action, not chat] TC-RMD02-03 setup fixture (other branch)',
      },
      { branchId: otherBranchId }
    );
    expect(setupIn?.success).toBe(true);
    expect(setupOther?.success).toBe(true);

    // Realistic chat trigger, captured for the "does Maha actually scope by branch on
    // its own" question flagged in the file header — NEEDS_REVIEW, not asserted.
    const chatReply = await sendMessage(page, 'ما هي تذكيرات فريق العمل في الفرع الخاص بي؟');
    recorder.record({
      id: 'TC-RMD02-02-CHAT',
      tool: 'staff_reminder_list (chat — does Maha voluntarily scope to the BA\'s own branch?)',
      trigger: 'ما هي تذكيرات فريق العمل في الفرع الخاص بي؟',
      result: 'NEEDS_REVIEW',
      evidence:
        `${chatReply.text}\n\n[Manual cross-check needed] This only captures the reply — whether Maha ` +
        `actually passed branch_id=${baBranchId} to the tool (rather than omitting it and seeing every ` +
        `branch) isn't independently verifiable without a temporary tool-call log, same discipline as ` +
        `01-part3-runtime-context.spec.ts's TC-P3-02.`,
    });

    // Mechanical ground truth: the SQL-level filter itself, called directly.
    const listResult = await callAction(
      page,
      clinicId,
      'staff_reminder_list',
      { include_fired: true, limit: 50 },
      { branchId: String(baBranchId) }
    );
    const rows: Array<{ message?: string }> = listResult?.data?.rows || [];
    const inBranchFound = rows.some((r) => typeof r.message === 'string' && r.message.includes(inBranchMarker));
    const otherBranchLeaked = rows.some((r) => typeof r.message === 'string' && r.message.includes(otherBranchMarker));

    recorder.record({
      id: 'TC-RMD02-02',
      tool: 'staff_reminder_list(branch_id=<BA\'s own branch>) — direct call, own-branch inclusion',
      trigger: `[direct action, not chat] staff_reminder_list branch_id=${baBranchId}`,
      result: inBranchFound ? 'PASS' : 'FAIL',
      evidence: `in_branch_reminder_found=${inBranchFound}\n\n${JSON.stringify(rows.slice(0, 10)).slice(0, 500)}`,
    });
    recorder.record({
      id: 'TC-RMD02-03',
      tool: 'staff_reminder_list(branch_id=<BA\'s own branch>) — direct call, other-branch exclusion (negative)',
      trigger: `[direct action, not chat] staff_reminder_list branch_id=${baBranchId} (checking a DIFFERENT branch's row is absent)`,
      result: otherBranchLeaked ? 'FAIL' : 'PASS',
      evidence: `other_branch_reminder_leaked=${otherBranchLeaked}\n\n${JSON.stringify(rows.slice(0, 10)).slice(0, 500)}`,
    });

    expect(inBranchFound, 'the BA\'s own-branch reminder must be listed').toBe(true);
    expect(otherBranchLeaked, 'a different branch\'s reminder must never leak into the BA\'s branch-scoped list').toBe(
      false
    );
    await context.close();
  });
});
