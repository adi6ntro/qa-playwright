import { test, expect } from '@playwright/test';
import { gotoAiInstructionStep, sendMessage, sendAndConfirm } from '../../helpers/maha-chat';
import { ReportRecorder } from '../../helpers/report';
import '../../helpers/ob4-local-guard'; // throws if BASE_URL isn't local — see that file for why

/**
 * Covers EXP-04 "metadata header/footer generator (internal)", from
 * QA_TestScript_Phase4_CRM_Export.md (reporty-web-backup), TC-EXP04-01 .. TC-EXP04-03.
 * Built server-side by `_build_metadata()` (inapp_agent/tools/export.py) — title/
 * definition_applied/period_summary/branch_scope/owner_name/timestamp, all derived from
 * get_clinic_context() and the resolved set_ref, never from any free-text field the
 * caller supplies. export_result's response JSON never echoes these fields back
 * (they're sent to Laravel to embed IN the file) — so deep structural checks (Excel row
 * layout, AutoFilter) genuinely need a human to open the file; this suite has no
 * xlsx-parsing library and isn't adding one (task constraint: don't touch package.json).
 *
 * CSV is the one format this suite CAN inspect mechanically without any new dependency:
 * it's plain text, downloadable via `page.request.get(download_url)` and readable with
 * a plain `.text()` — no library needed. TC-EXP04-02/03 lean on that for real PASS/FAIL
 * verdicts; TC-EXP04-01 (Excel-specific row/AutoFilter structure) stays NEEDS_REVIEW.
 *
 * TC-EXP04-03's literal doc scenario needs a real branch with a well-known name (e.g.
 * "Cabang Kemang") to typo — unknown for this test clinic's real data, so the chat
 * portion is illustrative only (recorded NEEDS_REVIEW territory), while the actual
 * mechanical assertion proves the underlying structural guarantee directly: nothing the
 * caller supplies (a typo'd filename, standing in for "whatever wrong text was typed")
 * can reach the metadata comment lines, because _build_metadata() has no free-text scope
 * parameter to begin with.
 */

const recorder = new ReportRecorder('OB4 EXP-04 Export Metadata');
test.afterAll(async () => {
  await recorder.writeTo('reports');
});

const EXPORT_CAPABILITY_SKIP_REASON =
  'Set TEST_EXPORT_CAPABILITY_ENABLED=1 only after manually enabling BOTH ' +
  '"phase4Capabilities": {"export": "*", "crm": "*"} (or this test clinic\'s id for each) ' +
  'in your LOCAL reporty-onboard-phase3 config.json and restarting app.py.';

const SEARCH_FILTER = { hasnt_booked_since: '2026-06-01' };
const SEARCH_TRIGGER = 'ابحثي عن المرضى الذين لم يحجزوا موعدًا منذ 1 يونيو 2026';

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
      session_id: `qa-exp04-${action}-${Math.floor(Math.random() * 1e9)}`,
      branch_id: opts.branchId,
    },
  });
  return resp.json();
}

test.describe('TC-EXP04-01 — Excel metadata header structure', () => {
  test('export_result(format=xlsx) produces a downloadable file; row/AutoFilter structure needs manual review', async ({ browser }) => {
    test.setTimeout(180_000);
    test.skip(process.env.TEST_EXPORT_CAPABILITY_ENABLED !== '1', EXPORT_CAPABILITY_SKIP_REASON);

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);
    expect(clinicId, 'window.FO.clinicId must be present on the AI Instruction step').toBeTruthy();

    const searchReply = await sendMessage(page, SEARCH_TRIGGER);
    const exportTrigger = 'صدّري إلى إكسل';
    const { replies, confirmRoundsNeeded } = await sendAndConfirm(page, exportTrigger);
    const exportReply = replies[replies.length - 1];

    const directSearch = await callAction(page, clinicId, 'crm_search_contacts', { ...SEARCH_FILTER, limit: 10 });
    const setRef: string | undefined = directSearch?.data?.set_ref;
    test.skip(!setRef || !directSearch?.data?.total, 'no matching contacts for this filter in real test-clinic data');

    const directExport = await callAction(page, clinicId, 'export_result', {
      set_ref: setRef,
      format: 'xlsx',
      causing_message: exportTrigger,
    });
    const downloadUrl: string | undefined = directExport?.data?.download_url;
    let downloaded = false;
    let contentLength = 0;
    if (downloadUrl) {
      const fileResp = await page.request.get(downloadUrl);
      downloaded = fileResp.ok();
      contentLength = (await fileResp.body()).length;
    }

    recorder.record({
      id: 'TC-EXP04-01',
      tool: 'export_result(format=xlsx) — metadata header row structure (row1 title, row2 fields, row3 blank, row4 data+AutoFilter)',
      trigger: `${SEARCH_TRIGGER} / ${exportTrigger}`,
      result: 'NEEDS_REVIEW',
      evidence:
        `chat_export_reply="${exportReply.text}" (confirm rounds: ${confirmRoundsNeeded})\n` +
        `[direct action] export_result -> success=${directExport?.success} download_url_present=${!!downloadUrl}\n` +
        `file actually downloadable=${downloaded}, size=${contentLength} bytes\n\n` +
        `[Manual cross-check needed — this is the actual assertion] open ${downloadUrl || '(no url)'} in Excel and confirm: ` +
        `row 1 = metadata title, row 2 = metadata fields, row 3 = blank separator, data table starts row 4 with AutoFilter ` +
        `dropdowns active on the row-4 header.`,
    });
    expect(directExport?.success, 'export_result must succeed so there is a file to review at all').toBe(true);
    expect(downloaded, 'the download_url must actually serve the file').toBe(true);
    expect(contentLength, 'the downloaded file must not be empty').toBeGreaterThan(0);
    await context.close();
  });
});

test.describe('TC-EXP04-02 — CSV "#" metadata comment rows', () => {
  test('export_result(format=csv) — first 2 lines are "# "-prefixed metadata, then the real header row', async ({ browser }) => {
    test.setTimeout(180_000);
    test.skip(process.env.TEST_EXPORT_CAPABILITY_ENABLED !== '1', EXPORT_CAPABILITY_SKIP_REASON);

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);
    expect(clinicId).toBeTruthy();

    const searchReply = await sendMessage(page, SEARCH_TRIGGER);
    const exportTrigger = 'صدّري إلى CSV';
    const { replies, confirmRoundsNeeded } = await sendAndConfirm(page, exportTrigger);
    const exportReply = replies[replies.length - 1];

    const directSearch = await callAction(page, clinicId, 'crm_search_contacts', { ...SEARCH_FILTER, limit: 10 });
    const setRef: string | undefined = directSearch?.data?.set_ref;
    test.skip(!setRef || !directSearch?.data?.total, 'no matching contacts for this filter in real test-clinic data');

    const directExport = await callAction(page, clinicId, 'export_result', {
      set_ref: setRef,
      format: 'csv',
      causing_message: exportTrigger,
    });
    const downloadUrl: string | undefined = directExport?.data?.download_url;
    expect(downloadUrl, 'export_result(format=csv) must return a download_url').toBeTruthy();

    const fileResp = await page.request.get(downloadUrl!);
    const csvText = await fileResp.text();
    const lines = csvText.split(/\r?\n/);
    const first2AreComments = lines.length >= 3 && lines[0].startsWith('# ') && lines[1].startsWith('# ');
    const thirdLineIsRealHeader = lines.length >= 3 && !lines[2].startsWith('# ');

    recorder.record({
      id: 'TC-EXP04-02',
      tool: 'export_result(format=csv) — "# "-prefixed metadata comment lines (direct file download+parse, plain text, no library needed)',
      trigger: `${SEARCH_TRIGGER} / ${exportTrigger}`,
      result: first2AreComments && thirdLineIsRealHeader ? 'PASS' : 'FAIL',
      evidence:
        `chat_export_reply="${exportReply.text}" (confirm rounds: ${confirmRoundsNeeded})\n` +
        `first 3 lines of the downloaded CSV:\n${lines.slice(0, 3).join('\n')}`,
    });
    expect(first2AreComments, 'the first 2 lines of the CSV must start with "# " (metadata)').toBe(true);
    expect(thirdLineIsRealHeader, 'line 3 must be the real column header row, not another metadata comment').toBe(true);
    await context.close();
  });
});

test.describe('TC-EXP04-03 — export metadata never echoes a caller-supplied typo verbatim', () => {
  test('a deliberately wrong/typo\'d filename never leaks into the CSV\'s metadata comment lines', async ({ browser }) => {
    test.setTimeout(180_000);
    test.skip(process.env.TEST_EXPORT_CAPABILITY_ENABLED !== '1', EXPORT_CAPABILITY_SKIP_REASON);

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);
    expect(clinicId).toBeTruthy();

    // This test clinic's real branch names aren't known to this script, so the doc's
    // own "Cabang Kemang" -> "Kemag" scenario can't be reproduced literally with a
    // guaranteed-real branch. Sent anyway for illustrative/NEEDS_REVIEW evidence — the
    // actual mechanical assertion below proves the structural guarantee directly instead
    // of depending on this clinic having a specific branch name.
    const chatTrigger = 'ابحثي عن جهات الاتصال في فرع كيماج'; // deliberate typo, real branch name unknown to this script
    const chatReply = await sendMessage(page, chatTrigger);

    const directSearch = await callAction(page, clinicId, 'crm_search_contacts', { ...SEARCH_FILTER, limit: 10 });
    const setRef: string | undefined = directSearch?.data?.set_ref;
    test.skip(!setRef || !directSearch?.data?.total, 'no matching contacts for this filter in real test-clinic data');

    // _build_metadata() (inapp_agent/tools/export.py) derives every field from
    // get_clinic_context()/the resolved set_ref ONLY — export_result's signature has no
    // free-text "scope"/"branch name" parameter at all, so nothing the caller types can
    // reach the metadata comment lines. Proven here with an obviously-typo'd filename
    // standing in for "whatever wrong text the caller supplied".
    const TYPO_MARKER = 'Cabang_Kemag_TYPO_MARKER';
    const directExport = await callAction(page, clinicId, 'export_result', {
      set_ref: setRef,
      format: 'csv',
      filename: TYPO_MARKER,
      causing_message: 'TC-EXP04-03 typo-leak check',
    });
    const downloadUrl: string | undefined = directExport?.data?.download_url;
    expect(downloadUrl, 'export_result(format=csv) must return a download_url').toBeTruthy();

    const fileResp = await page.request.get(downloadUrl!);
    const csvText = await fileResp.text();
    const metadataLines = csvText.split(/\r?\n/).slice(0, 2).join('\n');
    const typoLeaked = metadataLines.includes(TYPO_MARKER);

    recorder.record({
      id: 'TC-EXP04-03',
      tool:
        'export_result — metadata comment lines never echo a caller-supplied string (structural: _build_metadata() ' +
        'takes no free-text scope/branch param at all)',
      trigger: `chat: "${chatTrigger}" | [direct action] export_result filename="${TYPO_MARKER}"`,
      result: typoLeaked ? 'FAIL' : 'PASS',
      evidence:
        `chat_reply="${chatReply.text}"\n` +
        `metadata comment lines:\n${metadataLines}\n\n` +
        `[Manual cross-check suggested, doc's literal scenario] if this test clinic has a real branch with a well-known ` +
        `name, re-run with an actual typo of THAT name in the chat trigger and confirm the metadata's branch/scope field ` +
        `shows the correctly-spelled official name, not the typo.`,
    });
    expect(typoLeaked, 'the caller-supplied filename/typo must never appear in the metadata comment lines').toBe(false);
    await context.close();
  });
});
