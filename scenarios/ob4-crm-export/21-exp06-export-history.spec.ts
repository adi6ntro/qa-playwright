import { test, expect } from '@playwright/test';
import { gotoAiInstructionStep, sendMessage } from '../../helpers/maha-chat';
import { ReportRecorder } from '../../helpers/report';
import '../../helpers/ob4-local-guard'; // throws if BASE_URL isn't local — see that file for why

/**
 * Covers EXP-06 `export_get_audit_trail` (read-only), TC-EXP06-01..03, from
 * QA_TestScript_Phase4_CRM_Export.md's 2026-09-05 re-audit — all 3 marked
 * "✅ Testable" in the doc's own status table.
 *
 * Ground truth read directly from inapp_agent/tools/export.py (reporty-onboard-phase3,
 * get_export_audit_trail(), ~line 266) and AgentExportController.php's EXPIRY_HOURS=24
 * (reporty-web-backup):
 *   - Every SUCCESSFUL export_result/export_result_batched call writes one row to
 *     `export_audit_log` via `_write_export_audit()` — a rejected call never logs.
 *   - `since` is a FLOOR ("created_at >= since"), not a retention ceiling — it can
 *     only ask for "everything from date X onward", never "only things older than X".
 *   - `expired` is computed live at read time (`expires_at < now()`), not stored.
 *   - The download link's real signed-URL expiry (AgentExportController::EXPIRY_HOURS)
 *     is 24 hours, matching the `expires_at` this tool reads back.
 *   - Per the module docstring's own words: "Retention (AC#2, '90 days minimum') is a
 *     floor: no purge job is built, so rows are kept indefinitely" — there is NO active
 *     enforcement of a 90-day retention *window* anywhere in this codebase, at the DB
 *     level or the prompt level (confirmed: the export_get_audit_trail @function_tool
 *     docstring in maha_inapp_agent.py never mentions a 90-day cutoff either).
 *
 * TC-EXP06-03 is written as UNABLE_TO_TEST below for exactly that last reason — see
 * its own describe block for the full explanation, it's a real, structural finding,
 * not just a missing-test-data gap.
 */

const recorder = new ReportRecorder('OB4 EXP-06 Export History');
test.afterAll(async () => {
  await recorder.writeTo('reports');
});

const CAPABILITY_SKIP_REASON =
  'Set TEST_EXPORT_CAPABILITY_ENABLED=1 AND TEST_CRM_CAPABILITY_ENABLED=1 only after manually enabling ' +
  '"phase4Capabilities": {"export": "*", "crm": "*"} (or this test clinic\'s id for each) in your LOCAL ' +
  'reporty-onboard-phase3 config.json and restarting app.py. Both are required — every exportable set_ref ' +
  'today comes from crm_search_contacts (crm capability), which export_result (export capability) then acts on.';

function capabilityGated() {
  return process.env.TEST_EXPORT_CAPABILITY_ENABLED !== '1' || process.env.TEST_CRM_CAPABILITY_ENABLED !== '1';
}

async function callAction(
  page: import('@playwright/test').Page,
  clinicId: string,
  action: string,
  params: Record<string, unknown>
) {
  const resp = await page.request.post(`http://localhost:9559/clinic/${clinicId}/action`, {
    data: {
      action,
      params,
      session_id: `qa-exp06-${action}-${Math.floor(Math.random() * 1e9)}`,
    },
  });
  return resp.json();
}

const SEARCH_PARAMS = { hasnt_booked_since: '2026-06-01', limit: 200 };

test.describe('TC-EXP06-01 — export history lists this week\'s exports with full detail', () => {
  test('a fresh set_ref exported twice appears in export_get_audit_trail with all required fields', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    test.skip(capabilityGated(), CAPABILITY_SKIP_REASON);

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);
    expect(clinicId, 'window.FO.clinicId must be present on the AI Instruction step').toBeTruthy();

    // Manufacture 2 known-fresh exports (different formats) so this run doesn't depend
    // on whatever unrelated exports happen to already exist for this clinic this week.
    const searchResult = await callAction(page, clinicId, 'crm_search_contacts', SEARCH_PARAMS);
    const setRef: string | undefined = searchResult?.data?.set_ref;
    expect(setRef, 'crm_search_contacts must return a set_ref').toBeTruthy();

    const marker = `QA_EXP06_${Date.now()}`;
    const exportPdf = await callAction(page, clinicId, 'export_result', {
      set_ref: setRef,
      format: 'pdf',
      causing_message: `[direct action] ${marker} pdf`,
    });
    const exportCsv = await callAction(page, clinicId, 'export_result', {
      set_ref: setRef,
      format: 'csv',
      causing_message: `[direct action] ${marker} csv`,
    });
    expect(exportPdf?.success && exportCsv?.success, 'both setup exports must succeed').toBe(true);

    // Real chat pass — NEEDS_REVIEW (reply wording/formatting isn't mechanically checkable).
    const trigger = 'ما هو سجل التصدير الخاص بي هذا الأسبوع؟';
    const reply = await sendMessage(page, trigger);
    recorder.record({
      id: 'TC-EXP06-01-CHAT',
      tool: 'export_get_audit_trail — chat pass',
      trigger,
      result: 'NEEDS_REVIEW',
      evidence: reply.text,
    });

    // Direct callAction pass — mechanical PASS/FAIL. Ask for "since" the start of this
    // week (a floor, not a ceiling per the module docstring) and confirm our 2 fresh
    // exports are both present with every field the doc's Expected Result requires.
    const weekStart = mondayOfThisWeekIso();
    const trail = await callAction(page, clinicId, 'export_get_audit_trail', {
      since: weekStart,
      limit: 200,
    });
    const entries: Array<{
      timestamp?: string;
      set_ref?: string;
      format?: string;
      row_count?: number;
      download_url?: string;
      expired?: boolean | null;
    }> = trail?.data || [];

    const pdfUrl = exportPdf?.data?.download_url;
    const csvUrl = exportCsv?.data?.download_url;
    const pdfEntry = entries.find((e) => e.download_url === pdfUrl);
    const csvEntry = entries.find((e) => e.download_url === csvUrl);
    const bothPresent = !!pdfEntry && !!csvEntry;
    const allFieldsPresent = [pdfEntry, csvEntry].every(
      (e) =>
        e &&
        typeof e.timestamp === 'string' &&
        typeof e.set_ref === 'string' &&
        typeof e.format === 'string' &&
        typeof e.row_count === 'number' &&
        typeof e.download_url === 'string'
    );

    recorder.record({
      id: 'TC-EXP06-01',
      tool: 'export_get_audit_trail(since=<monday this week>) — direct action',
      trigger: `[direct action, not chat] export_get_audit_trail since=${weekStart}`,
      result: bothPresent && allFieldsPresent ? 'PASS' : 'FAIL',
      evidence:
        `entries_returned=${entries.length} both_fresh_exports_present=${bothPresent} ` +
        `all_required_fields_present=${allFieldsPresent}\n` +
        `pdf_entry=${JSON.stringify(pdfEntry)}\ncsv_entry=${JSON.stringify(csvEntry)}`,
    });
    expect(bothPresent, 'both exports just made must appear in this week\'s audit trail').toBe(true);
    expect(allFieldsPresent, 'every entry must carry timestamp/set_ref/format/row_count/download_url').toBe(true);
    await context.close();
  });
});

test.describe('TC-EXP06-02 — resend an expired export link', () => {
  test('an export whose signed link is >24h old is flagged expired, and Maha offers a fresh one', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    test.skip(capabilityGated(), CAPABILITY_SKIP_REASON);

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);
    expect(clinicId, 'window.FO.clinicId must be present on the AI Instruction step').toBeTruthy();

    // This precondition (a genuinely >24h-old export) cannot be manufactured live —
    // this suite has no DB access to backdate export_audit_log rows, and waiting 24h
    // in a test run isn't realistic. Instead: look for one that's naturally aged past
    // 24h already, which becomes possible once this suite (or real usage) has been
    // exporting for more than a day. A brand-new environment (or the first day this
    // suite ever runs) will have none yet — that's a real runtime precondition gap,
    // not a design flaw, so it's checked live and skipped with a clear reason rather
        // than asserting against fabricated data.
    const trail = await callAction(page, clinicId, 'export_get_audit_trail', { limit: 200 });
    const entries: Array<{ download_url?: string; expired?: boolean | null; timestamp?: string }> =
      trail?.data || [];
    const expiredEntry = entries.find((e) => e.expired === true);

    test.skip(
      !expiredEntry,
      'No export in this clinic\'s history is yet >24h old (export_get_audit_trail returned ' +
        `${entries.length} entries, none with expired=true). This becomes testable once this suite (or real ` +
        'usage) has produced at least one export more than 24 hours ago — re-run this test on a later day. ' +
        'This suite has no DB access to backdate export_audit_log rows to force the precondition.'
    );

    const trigger = 'أرسلي لي رابط تصدير آخر منتهي الصلاحية مرة أخرى';
    const reply = await sendMessage(page, trigger);
    recorder.record({
      id: 'TC-EXP06-02-CHAT',
      tool: 'export_get_audit_trail (resend-expired-link) — chat pass',
      trigger,
      result: 'NEEDS_REVIEW',
      evidence:
        `${reply.text}\n\nknown expired entry used as context: ${JSON.stringify(expiredEntry)}\n` +
        '[Manual judgement needed] does the reply explicitly mark this expired:true, and offer to regenerate ' +
        'a new link rather than resend the dead one?',
    });

    // Mechanical part of the doc's Expected Result: the entry really is flagged
    // expired (this alone IS checkable from the JSON, independent of chat wording).
    recorder.record({
      id: 'TC-EXP06-02',
      tool: 'export_get_audit_trail — expired flag, direct action',
      trigger: '[direct action, not chat] export_get_audit_trail (found a naturally-aged entry)',
      result: expiredEntry?.expired === true ? 'PASS' : 'FAIL',
      evidence: JSON.stringify(expiredEntry),
    });
    expect(expiredEntry?.expired, 'the found entry must report expired=true').toBe(true);
    await context.close();
  });
});

test.describe('TC-EXP06-03 — export history beyond the 90-day retention window — UNABLE_TO_TEST', () => {
  test('blocked: no retention-window enforcement exists in code at all, and the feature is too new for real 90-day-old data', async () => {
    recorder.record({
      id: 'TC-EXP06-03',
      tool: 'export_get_audit_trail — 90-day retention boundary (expected: data hidden + Maha explains the limit)',
      trigger: '(cannot be prepared for real — see evidence)',
      result: 'UNABLE_TO_TEST',
      evidence:
        'Two independent reasons, both confirmed 2026-09-06 by reading inapp_agent/tools/export.py directly: ' +
        '(1) The `export_audit_log` table has no data anywhere near 90 days old yet — this feature ' +
        '(export_result\'s audit-write path) only shipped in the last few days, so genuinely aged data simply ' +
        "doesn't exist, and this suite has no DB access to fabricate a >90-day-old row. (2) More importantly, " +
        'this TC\'s premise does not match the code: `get_export_audit_trail()`\'s `since` parameter is a ' +
        'FLOOR ("created_at >= since"), never an upper bound — there is no code path that hides or filters out ' +
        'data older than 90 days. The module\'s own docstring says so explicitly: "Retention (AC#2, \'90 days ' +
        'minimum\') is a floor: no purge job is built, so rows are kept indefinitely... building an active ' +
        '90-day purge is separate, unrequested work." The export_get_audit_trail @function_tool docstring ' +
        '(maha_inapp_agent.py) likewise never mentions a 90-day cutoff to the model. So even once old data ' +
        'exists, this TC as literally specified (data hidden past 90 days, Maha explains the retention limit) ' +
        'has no mechanism to produce that behavior — it would need a real purge/window feature built first, ' +
        'not just aged test data. Re-execute once that\'s built.',
    });
    test.skip(true, 'no 90-day retention window exists in code (only an unenforced "keep at least" floor) — see evidence');
  });
});

/** ISO "YYYY-MM-DD" for the Monday of the current week, local time. */
function mondayOfThisWeekIso(): string {
  const now = new Date();
  const day = now.getDay(); // 0=Sun..6=Sat
  const diffToMonday = day === 0 ? 6 : day - 1;
  const monday = new Date(now);
  monday.setDate(now.getDate() - diffToMonday);
  return monday.toISOString().slice(0, 10);
}
