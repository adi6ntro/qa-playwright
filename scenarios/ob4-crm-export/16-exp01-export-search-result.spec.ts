import { test, expect } from '@playwright/test';
import { gotoAiInstructionStep, sendMessage, sendAndConfirm } from '../../helpers/maha-chat';
import { ReportRecorder } from '../../helpers/report';
import '../../helpers/ob4-local-guard'; // throws if BASE_URL isn't local — see that file for why

/**
 * Covers EXP-01 `export_result`, from QA_TestScript_Phase4_CRM_Export.md's Part 2 —
 * Export Tool Surface (reporty-web-backup), TC-EXP01-01 .. TC-EXP01-04. Per that doc's
 * 2026-09-05 re-audit note, `export_result` is REAL (not a stub) but narrower than the
 * dev spec in two confirmed ways (read directly from inapp_agent/tools/export.py,
 * 2026-09-06):
 *   1. Only `crm_search_contacts`-shaped set_refs exist today — `agent_set_refs` is
 *      written exclusively by `resolve_segment_criteria()` (segments.py), which
 *      `crm_search_contacts` reuses. Every export test below therefore does its own
 *      real `crm_search_contacts` call first to get a legitimate set_ref, rather than
 *      assuming a fixed fake one exists.
 *   2. docx is not implemented at all (export.py: `if format == "docx": return
 *      {"success": False, "error": "unsupported_format_for_data_type", ...}`) — not
 *      merely "unsupported for this data type", every data type hits the same wall.
 *
 * Precondition (doc's own note, Part 2 header): needs BOTH the `export` AND `crm`
 * capabilities enabled for this test clinic (`crm_search_contacts` lives under `crm`,
 * confirmed in registrations.py's CRM section and 05-crm05-add-note.spec.ts's header
 * comment) — a single new env var gates this whole file, see EXPORT_CAPABILITY_SKIP_REASON.
 *
 * See 01-part3-runtime-context.spec.ts's header comment for why this targets the AI
 * Instruction wizard chat (#fo-ai-chat-input), not the doc's named (actually disabled)
 * "My Clinic AI" widget.
 *
 * Verification strategy, same posture as 05-crm05-add-note.spec.ts: a realistic Arabic
 * chat trigger for the natural-language flow (evidence captured, human/LLM-reviewable),
 * PLUS a direct `POST /clinic/<id>/action` call (bypasses the LLM entirely, same
 * registry.invoke() code path a chat tool call uses — see that file's `callAction()`
 * comment) to get a structured JSON verdict on the doc's actual checkable claims
 * (exact row_count, exact error code, exact available_options list) that a chat reply's
 * free-text wording can't reliably be asserted against. Deep FILE-content checks this
 * suite has no library for (parsing a real .xlsx/.pdf) are recorded NEEDS_REVIEW with
 * the download_url and exactly what a human should look for.
 *
 * Row-count ground truth: rather than assume the doc's own illustrative "25 baris" (this
 * is real dev-clinic data, not a fixture), each test reads the ACTUAL total straight off
 * its own crm_search_contacts call and checks export_result's row_count against that —
 * an internal-consistency check, not a magic number.
 */

const recorder = new ReportRecorder('OB4 EXP-01 Export Search Result');
test.afterAll(async () => {
  await recorder.writeTo('reports');
});

const EXPORT_CAPABILITY_SKIP_REASON =
  'Set TEST_EXPORT_CAPABILITY_ENABLED=1 only after manually enabling BOTH ' +
  '"phase4Capabilities": {"export": "*", "crm": "*"} (or this test clinic\'s id for each) ' +
  'in your LOCAL reporty-onboard-phase3 config.json and restarting app.py — export_result ' +
  'can only export a crm_search_contacts result today, so crm must be on too.';

// Same appointment-fact filter as the source doc's own examples throughout Part 2.
const SEARCH_FILTER = { hasnt_booked_since: '2026-06-01' };
const SEARCH_TRIGGER = 'ابحثي عن المرضى الذين لم يحجزوا موعدًا منذ 1 يونيو 2026';

/**
 * Calls a registered tool directly via reporty-onboard-phase3's own
 * `POST /clinic/<id>/action` endpoint (registry.invoke(), same code path a chat tool
 * call uses) — same helper/rationale as 05-crm05-add-note.spec.ts. Response envelope is
 * always `{success, data, error, event}` (app.py's Action resource docstring,
 * confirmed 2026-09-06) — `data` holds the tool function's own return value verbatim,
 * even on a tool-level failure (e.g. export_result's `{"success": False, "error": ...}`
 * ends up as `{success: false, data: {success:false, error:...}, error: "..."}`).
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
      session_id: `qa-exp01-${action}-${Math.floor(Math.random() * 1e9)}`,
      branch_id: opts.branchId,
    },
  });
  return resp.json();
}

test.describe('TC-EXP01-01 — export search result to Excel, exact row count', () => {
  test('export_result(format=xlsx) row_count exactly matches the search that produced its set_ref', async ({ browser }) => {
    test.setTimeout(180_000);
    test.skip(process.env.TEST_EXPORT_CAPABILITY_ENABLED !== '1', EXPORT_CAPABILITY_SKIP_REASON);

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);
    expect(clinicId, 'window.FO.clinicId must be present on the AI Instruction step').toBeTruthy();

    // Real chat flow first, matching the doc's own steps 3-4 (search, then "export this
    // to Excel" in the same conversation) — captured for NEEDS_REVIEW-style evidence.
    const searchReply = await sendMessage(page, SEARCH_TRIGGER);
    const exportTrigger = 'صدّري نتيجة هذا البحث إلى إكسل';
    const { replies, confirmRoundsNeeded } = await sendAndConfirm(page, exportTrigger);
    const exportReply = replies[replies.length - 1];

    // Direct, structured re-verification: independent crm_search_contacts call for a
    // fresh set_ref + ground-truth total, then export_result against THAT set_ref.
    const directSearch = await callAction(page, clinicId, 'crm_search_contacts', { ...SEARCH_FILTER, limit: 10 });
    const actualTotal: number | undefined = directSearch?.data?.total;
    const setRef: string | undefined = directSearch?.data?.set_ref;
    test.skip(
      !setRef || !actualTotal,
      `no matching contacts for hasnt_booked_since=${SEARCH_FILTER.hasnt_booked_since} in real test-clinic data ` +
        '(total=0) — adjust the filter or seed data before this test can run meaningfully.'
    );

    const directExport = await callAction(page, clinicId, 'export_result', {
      set_ref: setRef,
      format: 'xlsx',
      causing_message: exportTrigger,
    });
    const rowCountMatches = directExport?.data?.row_count === actualTotal;
    const downloadUrl: string | undefined = directExport?.data?.download_url;

    recorder.record({
      id: 'TC-EXP01-01',
      tool: 'export_result(format=xlsx) — row_count vs crm_search_contacts.total (direct action call, not chat)',
      trigger: `${SEARCH_TRIGGER} / ${exportTrigger}`,
      result: directExport?.success && rowCountMatches && !!downloadUrl ? 'PASS' : 'FAIL',
      evidence:
        `chat_search_reply="${searchReply.text}"\nchat_export_reply="${exportReply.text}" (confirm rounds: ${confirmRoundsNeeded})\n\n` +
        `[direct action] crm_search_contacts.total=${actualTotal} set_ref=${setRef}\n` +
        `[direct action] export_result -> success=${directExport?.success} row_count=${directExport?.data?.row_count} ` +
        `download_url_present=${!!downloadUrl} expires_at=${directExport?.data?.expires_at} filename=${directExport?.data?.filename}\n\n` +
        `[Manual cross-check still needed] download ${downloadUrl || '(no url)'} and confirm the file's data rows are ` +
        `IDENTICAL to what the chat displayed at the search step (not a fresh re-query), and that the filename is descriptive.`,
    });
    expect(directExport?.success, 'export_result must succeed for a fresh, valid set_ref').toBe(true);
    expect(
      rowCountMatches,
      `export_result's row_count (${directExport?.data?.row_count}) must exactly match the search total (${actualTotal})`
    ).toBe(true);
    expect(downloadUrl, 'a successful export must return a download_url').toBeTruthy();
    await context.close();
  });
});

test.describe('TC-EXP01-02 — export to PDF with automatic metadata header', () => {
  test('export_result(format=pdf) succeeds from the same set_ref; header field content needs manual review', async ({ browser }) => {
    test.setTimeout(180_000);
    test.skip(process.env.TEST_EXPORT_CAPABILITY_ENABLED !== '1', EXPORT_CAPABILITY_SKIP_REASON);

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);
    expect(clinicId).toBeTruthy();

    const searchReply = await sendMessage(page, SEARCH_TRIGGER);
    const exportTrigger = 'صدّري اللي طلعناه قبل شوي كملف PDF كمان';
    const { replies, confirmRoundsNeeded } = await sendAndConfirm(page, exportTrigger);
    const exportReply = replies[replies.length - 1];

    const directSearch = await callAction(page, clinicId, 'crm_search_contacts', { ...SEARCH_FILTER, limit: 10 });
    const setRef: string | undefined = directSearch?.data?.set_ref;
    test.skip(!setRef || !directSearch?.data?.total, 'no matching contacts for this filter in real test-clinic data');

    const directExport = await callAction(page, clinicId, 'export_result', {
      set_ref: setRef,
      format: 'pdf',
      causing_message: exportTrigger,
    });
    const downloadUrl: string | undefined = directExport?.data?.download_url;

    // _build_metadata() (export.py) computes title/definition_applied/period_summary/
    // branch_scope/owner_name/timestamp server-side and sends them to Laravel to embed
    // in the file — none of those fields come back in export_result's own JSON response,
    // so the doc's actual assertion (the PDF's rendered header) can only be judged by
    // opening the file. This suite has no PDF-parsing library and isn't adding one
    // (task constraint: don't touch package.json) — recorded NEEDS_REVIEW on purpose.
    recorder.record({
      id: 'TC-EXP01-02',
      tool: 'export_result(format=pdf) — automatic metadata header (title/definition/period/scope/owner/timestamp)',
      trigger: `${SEARCH_TRIGGER} / ${exportTrigger}`,
      result: 'NEEDS_REVIEW',
      evidence:
        `chat_export_reply="${exportReply.text}" (confirm rounds: ${confirmRoundsNeeded})\n` +
        `direct export_result -> success=${directExport?.success} download_url_present=${!!downloadUrl}\n\n` +
        `[Manual cross-check needed — this is the actual assertion] open ${downloadUrl || '(no url)'} and confirm the header ` +
        `contains title, definition_applied, period_summary, branch_scope, owner_name and timestamp, all present WITHOUT the ` +
        `owner having asked for them explicitly (chat trigger above never mentions metadata).`,
    });
    expect(directExport?.success, 'export_result(format=pdf) must succeed from the same set_ref used for xlsx').toBe(true);
    expect(downloadUrl, 'a successful PDF export must return a download_url').toBeTruthy();
    await context.close();
  });
});

test.describe('TC-EXP01-03 — export to Word/Docx is rejected (docx not implemented at all)', () => {
  test('export_result(format=docx) is rejected with unsupported_format_for_data_type, no file produced', async ({ browser }) => {
    test.setTimeout(180_000);
    test.skip(process.env.TEST_EXPORT_CAPABILITY_ENABLED !== '1', EXPORT_CAPABILITY_SKIP_REASON);

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);
    expect(clinicId).toBeTruthy();

    const searchReply = await sendMessage(page, SEARCH_TRIGGER);
    const exportTrigger = 'صدّري هذه النتيجة إلى Word';
    const chatExportReply = await sendMessage(page, exportTrigger);
    // Deliberately plain sendMessage (not sendAndConfirm): a hard-rejected format should
    // never even raise a confirmation prompt in the first place.
    const chatOffersRealFormat = /pdf|excel|إكسل|csv/i.test(chatExportReply.text);
    const chatClaimsWordSuccess = /(word|docx).*(تم|نجح|جاهز|✅)/i.test(chatExportReply.text);

    const directSearch = await callAction(page, clinicId, 'crm_search_contacts', { ...SEARCH_FILTER, limit: 10 });
    const setRef: string | undefined = directSearch?.data?.set_ref;
    test.skip(!setRef, 'no matching contacts for this filter in real test-clinic data');

    const directExport = await callAction(page, clinicId, 'export_result', {
      set_ref: setRef,
      format: 'docx',
      causing_message: exportTrigger,
    });
    const rejectedCorrectly = directExport?.data?.error === 'unsupported_format_for_data_type';
    const noDownloadUrl = !directExport?.data?.download_url;

    recorder.record({
      id: 'TC-EXP01-03',
      tool: 'export_result(format=docx) — rejection (docx unimplemented for every data_type, export.py: `if format == "docx": return {"success": False, "error": "unsupported_format_for_data_type", ...}`)',
      trigger: `${SEARCH_TRIGGER} / ${exportTrigger}`,
      result: rejectedCorrectly && noDownloadUrl ? 'PASS' : 'FAIL',
      evidence:
        `chat_export_reply="${chatExportReply.text}" (offers a real format: ${chatOffersRealFormat}, claims Word success: ${chatClaimsWordSuccess})\n` +
        `[direct action] export_result(format=docx) -> error=${directExport?.data?.error} supported_formats=${JSON.stringify(directExport?.data?.supported_formats)} download_url=${directExport?.data?.download_url}\n\n` +
        `[Manual cross-check suggested] confirm the chat reply's wording is honest — "not implemented yet", not "not the default" — and doesn't imply Word ever worked.`,
    });
    expect(rejectedCorrectly, 'format=docx must reject with unsupported_format_for_data_type').toBe(true);
    expect(noDownloadUrl, 'a rejected docx export must never produce a download_url').toBe(true);
    expect(chatClaimsWordSuccess, 'the chat reply must never claim the Word export succeeded').toBe(false);
    await context.close();
  });
});

test.describe('TC-EXP01-04 — export >10,000 rows is a hard error with real fallback options', () => {
  test('export_result row_limit_exceeded includes available_options; data is never silently truncated', async ({ browser }) => {
    test.setTimeout(180_000);
    test.skip(process.env.TEST_EXPORT_CAPABILITY_ENABLED !== '1', EXPORT_CAPABILITY_SKIP_REASON);

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);
    expect(clinicId).toBeTruthy();

    // Broadest realistic filter available on crm_search_contacts today (see
    // inapp_agent/tools/crm.py's search_contacts docstring — no name/tag/generic filter
    // exists, only appointment-fact ones): "hasn't booked since tomorrow" matches every
    // patient with any appointment history who hasn't ALSO booked something in the
    // future — the most inclusive real query this tool can express, deliberately chosen
    // to maximize the chance of tripping the 10,000 row cap with real data (still very
    // unlikely on a dev/test clinic — the doc's own note says to coordinate with dev to
    // seed dummy data if real data isn't big enough; this test detects that condition at
    // runtime instead of assuming it).
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const broadTrigger = `صدّري كل جهات الاتصال التي لم تحجز موعدًا منذ الغد إلى CSV`;

    const directSearch = await callAction(page, clinicId, 'crm_search_contacts', {
      hasnt_booked_since: tomorrow,
      limit: 1,
    });
    const actualTotal: number | undefined = directSearch?.data?.total;
    const setRef: string | undefined = directSearch?.data?.set_ref;

    if (!setRef || !actualTotal || actualTotal <= 10000) {
      recorder.record({
        id: 'TC-EXP01-04',
        tool: 'export_result — row_limit_exceeded (10,000 row hard cap, export.py ROW_CAP)',
        trigger: broadTrigger,
        result: 'UNABLE_TO_TEST',
        evidence:
          `The broadest real filter this tool supports (hasnt_booked_since=${tomorrow}) only matched ${actualTotal ?? 0} ` +
          'rows in this test clinic\'s real data — below the 10,000-row cap, so the row_limit_exceeded path cannot be ' +
          'triggered honestly right now. Per the doc\'s own precondition note: coordinate with dev to seed enough dummy ' +
          'patient/appointment data in the test clinic (or point BASE_URL/the test clinic at an environment that already ' +
          'has >10,000 matching patients), then re-run this test — it will automatically exercise the real assertions below ' +
          'once actualTotal > 10000.',
      });
      test.skip(true, 'test-clinic data has fewer than 10,000 matching rows for any supported filter — see recorded evidence');
      await context.close();
      return;
    }

    const chatReply = await sendMessage(page, broadTrigger);
    const chatNeverClaimsSuccess = !/(✅|تم التصدير|تم الإنشاء بنجاح)/i.test(chatReply.text);

    const directExport = await callAction(page, clinicId, 'export_result', {
      set_ref: setRef,
      format: 'csv',
      causing_message: broadTrigger,
    });
    const gotRowLimitError = directExport?.data?.error === 'row_limit_exceeded';
    const options: string[] = directExport?.data?.available_options || [];
    // format='csv' in the request above, so export.py's own logic never adds 'csv' to
    // options (it's only offered when the ORIGINAL requested format wasn't already csv)
    // — the real fallback list to expect here is just the batch_by_* trio, present only
    // when actualTotal is still within BATCHED_TOTAL_ROW_CAP (50,000).
    const expectedBatchOptions = actualTotal <= 50000
      ? ['batch_by_branch', 'batch_by_month', 'batch_by_n_rows']
      : [];
    const hasBatchOptions = expectedBatchOptions.every((o) => options.includes(o));

    recorder.record({
      id: 'TC-EXP01-04',
      tool: 'export_result — row_limit_exceeded + available_options (direct action call), actualTotal=' + actualTotal,
      trigger: broadTrigger,
      result: gotRowLimitError && hasBatchOptions ? 'PASS' : 'FAIL',
      evidence:
        `chat_reply="${chatReply.text}" (never claims success: ${chatNeverClaimsSuccess})\n` +
        `[direct action] export_result -> error=${directExport?.data?.error} row_count=${directExport?.data?.row_count} ` +
        `cap=${directExport?.data?.cap} available_options=${JSON.stringify(options)}\n` +
        `expected batch options (actualTotal<=50000: ${actualTotal <= 50000}): ${JSON.stringify(expectedBatchOptions)}`,
    });
    expect(gotRowLimitError, 'export_result must reject with row_limit_exceeded above 10,000 rows').toBe(true);
    expect(chatNeverClaimsSuccess, 'chat reply must never claim a silent truncated success').toBe(true);
    expect(hasBatchOptions, `available_options must include the expected batch_by_* fallbacks: ${JSON.stringify(expectedBatchOptions)}`).toBe(true);
    await context.close();
  });
});
