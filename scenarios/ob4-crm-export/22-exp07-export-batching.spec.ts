import { test, expect } from '@playwright/test';
import { gotoAiInstructionStep, sendMessage } from '../../helpers/maha-chat';
import { ReportRecorder } from '../../helpers/report';
import '../../helpers/ob4-local-guard'; // throws if BASE_URL isn't local — see that file for why

/**
 * Covers EXP-07 `export_result_batched`, TC-EXP07-01..03, from
 * QA_TestScript_Phase4_CRM_Export.md's 2026-09-05 re-audit — all 3 marked
 * "✅ Testable (query disesuaikan)" in the doc's own status table.
 *
 * IMPORTANT deviation from the source doc's own preconditions, found by reading
 * `export_result_batched()` directly (inapp_agent/tools/export.py, ~line 421):
 * the doc's preconditions ask for genuinely huge datasets ("set_ref besar (>10.000
 * baris)", "data lintas setahun") to justify batching. The CODE has no such
 * threshold at all — `export_result_batched` is a tool the model calls because the
 * OWNER explicitly asked to split the export (batch_by), not an automatic fallback
 * that only kicks in above some row count (that's `export_result`'s OWN row_limit_exceeded
 * path, a completely different code path — EXP-01, not EXP-07). It works identically on
 * a 5-row set or a 50,000-row set; `_partition_rows()` just groups whatever rows it's
 * given. So these tests use the SAME modest, real `hasnt_booked_since` filter as the
 * other EXP-0x specs rather than trying to manufacture artificial 10k+/whole-year
 * datasets — the doc's own "Setup / Precondition" size numbers describe a REALISTIC
 * production scenario, not a hard requirement the tool itself enforces.
 *
 * Mechanical checks used below (all read directly off export_result_batched()'s own
 * return shape, `{batches: [{download_url, filename, row_count, expires_at, label}],
 * total_rows}`, and `_export_endpoint()`'s filename convention
 * `{slug}_batch_{i}_of_{total}.{format}`, both confirmed from source, not guessed):
 *   - every batch's filename matches `_batch_<n>_of_<total>.<format>`
 *   - sum of each batch's row_count == the response's total_rows
 *   - batch_by="month" labels look like "YYYY-MM" or the literal "no_visit_date"
 *     bucket (_partition_rows()'s own key_fn for month)
 *
 * TC-EXP07-03 (unsupported batch_by combination) is tested via a DIRECT callAction
 * with an actually-invalid batch_by value ("branch_and_month") — the function's own
 * signature (`batch_by: str`) only ever accepts one of "branch"/"month"/"n_rows"
 * (SUPPORTED_BATCH_BY), so there is no way to even express "both at once" as a real
 * parameter; sending exactly that string is the direct, deterministic way to exercise
 * `unsupported_batch_by` without depending on how the model chooses to interpret an
 * ambiguous chat request.
 */

const recorder = new ReportRecorder('OB4 EXP-07 Export Batching');
test.afterAll(async () => {
  await recorder.writeTo('reports');
});

const CAPABILITY_SKIP_REASON =
  'Set TEST_EXPORT_CAPABILITY_ENABLED=1 AND TEST_CRM_CAPABILITY_ENABLED=1 only after manually enabling ' +
  '"phase4Capabilities": {"export": "*", "crm": "*"} (or this test clinic\'s id for each) in your LOCAL ' +
  'reporty-onboard-phase3 config.json and restarting app.py. Both are required — every exportable set_ref ' +
  'today comes from crm_search_contacts (crm capability), which export_result_batched (export capability) ' +
  'then acts on.';

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
      session_id: `qa-exp07-${action}-${Math.floor(Math.random() * 1e9)}`,
    },
  });
  return resp.json();
}

const SEARCH_PARAMS = { hasnt_booked_since: '2026-01-01', limit: 500 };

interface Batch {
  download_url?: string;
  filename?: string;
  row_count?: number;
  expires_at?: string;
  label?: string | null;
}

function filenamesFollowConvention(batches: Batch[], format: string): boolean {
  const total = batches.length;
  return batches.every((b, i) => {
    const expectedSuffix = `_batch_${i + 1}_of_${total}.${format}`;
    return typeof b.filename === 'string' && b.filename.endsWith(expectedSuffix);
  });
}

test.describe('TC-EXP07-01 — batch export split by branch', () => {
  test('export_result_batched(batch_by=branch) produces one correctly-labeled file per branch', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    test.skip(capabilityGated(), CAPABILITY_SKIP_REASON);

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);
    expect(clinicId, 'window.FO.clinicId must be present on the AI Instruction step').toBeTruthy();

    // Real chat pass — NEEDS_REVIEW (reply wording isn't mechanically checkable).
    const searchTrigger = 'ابحثي عن جميع المرضى الذين لم يحجزوا موعدًا منذ 1 يناير 2026 في كل الفروع';
    const searchReply = await sendMessage(page, searchTrigger);
    const batchReply = await sendMessage(page, 'صدّري هذا مقسمًا حسب الفرع');
    recorder.record({
      id: 'TC-EXP07-01-CHAT',
      tool: 'export_result_batched(batch_by=branch) — chat pass',
      trigger: `${searchTrigger} / صدّري هذا مقسمًا حسب الفرع`,
      result: 'NEEDS_REVIEW',
      evidence: `search="${searchReply.text}"\nbatch="${batchReply.text}"`,
    });

    // Direct callAction pass — mechanical PASS/FAIL.
    const searchResult = await callAction(page, clinicId, 'crm_search_contacts', SEARCH_PARAMS);
    const setRef: string | undefined = searchResult?.data?.set_ref;
    expect(setRef, 'crm_search_contacts must return a set_ref').toBeTruthy();

    const batchResult = await callAction(page, clinicId, 'export_result_batched', {
      set_ref: setRef,
      format: 'csv',
      batch_by: 'branch',
      causing_message: '[direct action, not chat] export_result_batched batch_by=branch',
    });
    const batches: Batch[] = batchResult?.data?.batches || [];
    const totalRows: number | undefined = batchResult?.data?.total_rows;

    const hasBatches = batches.length > 0;
    const rowsSumMatch = hasBatches && batches.reduce((sum, b) => sum + (b.row_count || 0), 0) === totalRows;
    const filenamesOk = hasBatches && filenamesFollowConvention(batches, 'csv');
    const labelsPresent = hasBatches && batches.every((b) => typeof b.label === 'string' && b.label.length > 0);

    const ok = hasBatches && rowsSumMatch && filenamesOk && labelsPresent;
    recorder.record({
      id: 'TC-EXP07-01',
      tool: 'export_result_batched(batch_by=branch) — direct action',
      trigger: `[direct action, not chat] export_result_batched(set_ref, format=csv, batch_by=branch)`,
      result: ok ? 'PASS' : 'FAIL',
      evidence:
        `success=${!!batchResult?.success} error=${batchResult?.error} batch_count=${batches.length} ` +
        `total_rows=${totalRows} rows_sum_match=${rowsSumMatch} filenames_ok=${filenamesOk} ` +
        `labels_present=${labelsPresent}\nlabels=${JSON.stringify(batches.map((b) => b.label))}`,
    });
    expect(hasBatches, 'at least one batch file must be produced').toBe(true);
    expect(rowsSumMatch, 'sum of every batch\'s row_count must equal total_rows').toBe(true);
    expect(filenamesOk, 'every filename must follow the _batch_<n>_of_<total>.<format> convention').toBe(true);
    await context.close();
  });
});

test.describe('TC-EXP07-02 — batch export split by month', () => {
  test('export_result_batched(batch_by=month) produces one file per last_visit month, rows sum to total', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    test.skip(capabilityGated(), CAPABILITY_SKIP_REASON);

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);
    expect(clinicId, 'window.FO.clinicId must be present on the AI Instruction step').toBeTruthy();

    // Real chat pass — NEEDS_REVIEW.
    const searchTrigger = 'ابحثي عن المرضى الذين كانت آخر زيارة لهم قبل 31 ديسمبر 2026';
    const searchReply = await sendMessage(page, searchTrigger);
    const batchReply = await sendMessage(page, 'صدّري هذا مقسمًا حسب الشهر');
    recorder.record({
      id: 'TC-EXP07-02-CHAT',
      tool: 'export_result_batched(batch_by=month) — chat pass',
      trigger: `${searchTrigger} / صدّري هذا مقسمًا حسب الشهر`,
      result: 'NEEDS_REVIEW',
      evidence: `search="${searchReply.text}"\nbatch="${batchReply.text}"`,
    });

    // Direct callAction pass — mechanical PASS/FAIL. last_visit_before is a wide date
    // so this genuinely spans multiple last-visit months if the test clinic's data does.
    const searchResult = await callAction(page, clinicId, 'crm_search_contacts', {
      last_visit_before: '2026-12-31',
      limit: 500,
    });
    const setRef: string | undefined = searchResult?.data?.set_ref;
    expect(setRef, 'crm_search_contacts must return a set_ref').toBeTruthy();

    const batchResult = await callAction(page, clinicId, 'export_result_batched', {
      set_ref: setRef,
      format: 'csv',
      batch_by: 'month',
      causing_message: '[direct action, not chat] export_result_batched batch_by=month',
    });
    const batches: Batch[] = batchResult?.data?.batches || [];
    const totalRows: number | undefined = batchResult?.data?.total_rows;

    const hasBatches = batches.length > 0;
    const rowsSumMatch = hasBatches && batches.reduce((sum, b) => sum + (b.row_count || 0), 0) === totalRows;
    const filenamesOk = hasBatches && filenamesFollowConvention(batches, 'csv');
    // _partition_rows()'s month key_fn: r["last_visit"][:7] ("YYYY-MM") or the literal
    // "no_visit_date" bucket for a null last_visit — confirmed from source.
    const labelsLookLikeMonths =
      hasBatches &&
      batches.every((b) => typeof b.label === 'string' && (/^\d{4}-\d{2}$/.test(b.label) || b.label === 'no_visit_date'));

    const ok = hasBatches && rowsSumMatch && filenamesOk && labelsLookLikeMonths;
    recorder.record({
      id: 'TC-EXP07-02',
      tool: 'export_result_batched(batch_by=month) — direct action',
      trigger: '[direct action, not chat] export_result_batched(set_ref, format=csv, batch_by=month)',
      result: ok ? 'PASS' : 'FAIL',
      evidence:
        `success=${!!batchResult?.success} error=${batchResult?.error} batch_count=${batches.length} ` +
        `total_rows=${totalRows} rows_sum_match=${rowsSumMatch} filenames_ok=${filenamesOk} ` +
        `labels_look_like_months=${labelsLookLikeMonths}\nlabels=${JSON.stringify(batches.map((b) => b.label))}`,
    });
    expect(hasBatches, 'at least one batch file must be produced').toBe(true);
    expect(rowsSumMatch, 'sum of every batch\'s row_count must equal total_rows (doc\'s own acceptance bar)').toBe(
      true
    );
    await context.close();
  });
});

test.describe('TC-EXP07-03 — unsupported batch_by combination is rejected, no silent fallback', () => {
  test('a combined batch_by value is rejected with unsupported_batch_by, naming the 3 real options', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    test.skip(capabilityGated(), CAPABILITY_SKIP_REASON);

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);
    expect(clinicId, 'window.FO.clinicId must be present on the AI Instruction step').toBeTruthy();

    const searchResult = await callAction(page, clinicId, 'crm_search_contacts', SEARCH_PARAMS);
    const setRef: string | undefined = searchResult?.data?.set_ref;
    expect(setRef, 'crm_search_contacts must return a set_ref').toBeTruthy();

    // Direct callAction, deterministic negative check — export_result_batched's own
    // signature only ever accepts ONE batch_by string (SUPPORTED_BATCH_BY =
    // ("branch", "month", "n_rows")); there's no way to even express "both at once" as
    // a real parameter, so sending exactly that invalid combination string is the
    // cleanest way to exercise this rejection without depending on how the model
    // chooses to interpret an ambiguous request.
    const badResult = await callAction(page, clinicId, 'export_result_batched', {
      set_ref: setRef,
      format: 'csv',
      batch_by: 'branch_and_month',
      causing_message: '[direct action, not chat] export_result_batched batch_by=branch_and_month (invalid)',
    });
    const rejectedCorrectly =
      badResult?.error === 'unsupported_batch_by' &&
      Array.isArray(badResult?.data?.supported_batch_by) &&
      ['branch', 'month', 'n_rows'].every((v) => badResult.data.supported_batch_by.includes(v));

    recorder.record({
      id: 'TC-EXP07-03-DIRECT',
      tool: 'export_result_batched(batch_by=<invalid combination>) — direct action, deterministic',
      trigger: '[direct action, not chat] export_result_batched batch_by="branch_and_month"',
      result: rejectedCorrectly ? 'PASS' : 'FAIL',
      evidence: JSON.stringify(badResult),
    });
    expect(rejectedCorrectly, 'must reject with unsupported_batch_by and name branch/month/n_rows').toBe(true);

    // Real chat pass — the model has to translate an ambiguous natural-language
    // request ("split by branch AND month at once") into a tool call itself. Whether
    // it silently picks one option instead of asking/rejecting is genuinely
    // model-dependent, so this half stays NEEDS_REVIEW — but a bare mechanical check
    // (no download link appears in the reply) is still worth capturing.
    const trigger = 'صدّري هذا مقسمًا حسب الفرع والشهر معًا';
    const reply = await sendMessage(page, trigger);
    const looksLikeItProducedAFile = /https?:\/\/\S+\.(csv|pdf|xlsx)/i.test(reply.text);

    recorder.record({
      id: 'TC-EXP07-03-CHAT',
      tool: 'export_result_batched(batch_by=<ambiguous combo>) — chat pass',
      trigger,
      result: looksLikeItProducedAFile ? 'FAIL' : 'NEEDS_REVIEW',
      evidence:
        `looks_like_a_file_link_was_produced=${looksLikeItProducedAFile}\n${reply.text}\n\n` +
        '[Manual judgement still needed] does the reply clearly name the 3 valid batch_by options ' +
        '(branch/month/n_rows) rather than silently picking one on the owner\'s behalf?',
    });
    await context.close();
  });
});
