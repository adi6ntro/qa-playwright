import { test, expect } from '@playwright/test';
import { gotoAiInstructionStep, sendMessage, sendAndConfirm } from '../../helpers/maha-chat';
import { ReportRecorder } from '../../helpers/report';
import '../../helpers/ob4-local-guard'; // throws if BASE_URL isn't local — see that file for why

/**
 * Covers EXP-02 "set reference registry" timing, from
 * QA_TestScript_Phase4_CRM_Export.md (reporty-web-backup), TC-EXP02-01 .. TC-EXP02-03.
 *
 * TC-EXP02-01 is the doc's own "⏳ TIDAK BISA DIUJI SAAT INI" case: `crm_get_contact`
 * does not write a set_ref to `agent_set_refs` yet — confirmed directly against
 * inapp_agent/tools/crm.py's module docstring and registrations.py's Export section
 * comment ("Only crm_search_contacts-shaped set_refs are supported today (EXP-02's
 * registry isn't extended to the other read tools yet)") — only
 * `resolve_segment_criteria()` (used by crm_search_contacts) writes one. Recorded
 * UNABLE_TO_TEST, same pattern as 01-part3-runtime-context.spec.ts's TC-P3-06.
 *
 * TC-EXP02-02/03 are genuinely REAL and genuinely SLOW: `resolve_set_ref`'s freshness
 * window (inapp_agent/tools/segments.py:277, `ttl_minutes=30` default, enforced as
 * `created_at > NOW() - INTERVAL 30 MINUTE` in SQL — pure wall-clock, no way to fast-
 * forward it from outside the DB) means these tests must genuinely wait ~10 and ~31
 * real minutes. `test.setTimeout()` is bumped well past this file's other 180s tests
 * accordingly — do not run these two in a tight loop; run them deliberately.
 *
 * Verification strategy: a real crm_search_contacts call (via `callAction`, direct
 * `POST /clinic/<id>/action`, same registry.invoke() path a chat tool call uses — see
 * 05-crm05-add-note.spec.ts's callAction() comment) creates the set_ref and gives a
 * ground-truth row total; the chat flow (sendMessage/sendAndConfirm) captures a
 * realistic natural-language trigger for evidence; a second direct export_result call,
 * made only after the real wait, gives the actual PASS/FAIL verdict — this is the part
 * of the claim (row_count still exact, or the exact expired error code) a chat reply's
 * free-text wording can't reliably be asserted against.
 */

const recorder = new ReportRecorder('OB4 EXP-02 Export Timing');
test.afterAll(async () => {
  await recorder.writeTo('reports');
});

const EXPORT_CAPABILITY_SKIP_REASON =
  'Set TEST_EXPORT_CAPABILITY_ENABLED=1 only after manually enabling BOTH ' +
  '"phase4Capabilities": {"export": "*", "crm": "*"} (or this test clinic\'s id for each) ' +
  'in your LOCAL reporty-onboard-phase3 config.json and restarting app.py.';

const SEARCH_FILTER = { hasnt_booked_since: '2026-01-01' };
const SEARCH_TRIGGER = 'ابحثي عن المرضى الذين لم يحجزوا موعدًا منذ 1 يناير 2026';

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
      session_id: `qa-exp02-${action}-${Math.floor(Math.random() * 1e9)}`,
      branch_id: opts.branchId,
    },
  });
  return resp.json();
}

test.describe('TC-EXP02-01 — export single-record contact profile to PDF', () => {
  test('requires crm_get_contact to write a set_ref, which it does not do yet — not exercised', async () => {
    recorder.record({
      id: 'TC-EXP02-01',
      tool: 'export_result from a crm_get_contact (single-record) set_ref',
      trigger: '(manual only)',
      result: 'UNABLE_TO_TEST',
      evidence:
        'crm_get_contact (CRM-02) does not call resolve_segment_criteria() and does not write to agent_set_refs — ' +
        'confirmed 2026-09-06 directly against inapp_agent/tools/crm.py (get_contact()) and registrations.py\'s Export ' +
        'section comment ("Only crm_search_contacts-shaped set_refs are supported today"). There is no way to produce a ' +
        'single-record set_ref for export_result to consume right now, so this precondition genuinely cannot be set up. ' +
        'Save this test for when EXP-02\'s set_ref registry is extended to crm_get_contact (or another single-record read).',
    });
    test.skip(true, 'crm_get_contact does not produce a set_ref yet — see recorded evidence');
  });
});

test.describe('TC-EXP02-02 — export still succeeds ~10 minutes after the search that created the set_ref', () => {
  test('set_ref resolves and row_count is unchanged ~10 minutes later (proves the >=30min TTL floor)', async ({ browser }) => {
    // Deliberately far beyond this suite's usual 180s ceiling: TC-EXP02-02's own
    // precondition is a genuine ~10 minute real-time gap with the chat session left
    // open/idle — resolve_set_ref's TTL is wall-clock SQL (`NOW() - INTERVAL 30
    // MINUTE`), not something a shorter wait or a mocked clock can substitute for.
    test.setTimeout(15 * 60_000);
    test.skip(process.env.TEST_EXPORT_CAPABILITY_ENABLED !== '1', EXPORT_CAPABILITY_SKIP_REASON);

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);
    expect(clinicId, 'window.FO.clinicId must be present on the AI Instruction step').toBeTruthy();

    // Chat search — keeps the session genuinely open/idle for the wait below, matching
    // the doc's own precondition ("sesi chat tetap sama, tidak ditutup/reload").
    const searchReply = await sendMessage(page, SEARCH_TRIGGER);

    const directSearch = await callAction(page, clinicId, 'crm_search_contacts', { ...SEARCH_FILTER, limit: 10 });
    const setRef: string | undefined = directSearch?.data?.set_ref;
    const actualTotal: number | undefined = directSearch?.data?.total;
    test.skip(
      !setRef || !actualTotal,
      'no matching contacts for this filter in real test-clinic data — adjust the filter or seed data'
    );

    // The actual ~10 minute idle gap TC-EXP02-02 requires.
    await page.waitForTimeout(10 * 60_000);

    const exportTrigger = 'صدّري نتيجة البحث اللي سويناه قبل شوي إلى إكسل';
    const { replies, confirmRoundsNeeded } = await sendAndConfirm(page, exportTrigger);
    const chatExportReply = replies[replies.length - 1];

    const directExport = await callAction(page, clinicId, 'export_result', {
      set_ref: setRef,
      format: 'xlsx',
      causing_message: exportTrigger,
    });
    const rowCountMatches = directExport?.data?.row_count === actualTotal;

    recorder.record({
      id: 'TC-EXP02-02',
      tool: 'export_result — set_ref still resolves ~10 min after creation (resolve_set_ref default ttl_minutes=30)',
      trigger: `${SEARCH_TRIGGER} ... [~10 min real wait] ... ${exportTrigger}`,
      result: directExport?.success && rowCountMatches ? 'PASS' : 'FAIL',
      evidence:
        `chat_search_reply="${searchReply.text}"\nchat_export_reply="${chatExportReply.text}" (confirm rounds: ${confirmRoundsNeeded})\n\n` +
        `set_ref=${setRef} created ~10min before the export attempt. search_total=${actualTotal}\n` +
        `[direct action] export_result -> success=${directExport?.success} row_count=${directExport?.data?.row_count} error=${directExport?.data?.error}\n\n` +
        `[Manual cross-check suggested] confirm the downloaded file's row count and data match the original search, not a fresh re-query.`,
    });
    expect(directExport?.success, 'export_result must still succeed ~10 minutes after the set_ref was created').toBe(true);
    expect(
      rowCountMatches,
      `row_count (${directExport?.data?.row_count}) must match the original search's total (${actualTotal}), not a fresh re-query`
    ).toBe(true);
    await context.close();
  });
});

test.describe('TC-EXP02-03 — export is rejected >30 minutes after the search (set_ref expired)', () => {
  test('set_ref no longer resolves after ~31 minutes; no stale download_url is produced', async ({ browser }) => {
    // See TC-EXP02-02's comment on why this can't be shortened or mocked — this one
    // needs to cross the 30-minute TTL boundary for real.
    test.setTimeout(40 * 60_000);
    test.skip(process.env.TEST_EXPORT_CAPABILITY_ENABLED !== '1', EXPORT_CAPABILITY_SKIP_REASON);

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);
    expect(clinicId).toBeTruthy();

    const searchReply = await sendMessage(page, SEARCH_TRIGGER);

    const directSearch = await callAction(page, clinicId, 'crm_search_contacts', { ...SEARCH_FILTER, limit: 10 });
    const setRef: string | undefined = directSearch?.data?.set_ref;
    test.skip(!setRef, 'no matching contacts for this filter in real test-clinic data');

    // Past the 30-minute TTL boundary — 31 minutes to give a safety margin against
    // clock/query latency without needlessly padding the wait much further.
    await page.waitForTimeout(31 * 60_000);

    const exportTrigger = 'صدّري نتيجة البحث اللي سويناه قبل شوي';
    const chatExportReply = await sendMessage(page, exportTrigger);
    // Deliberately plain sendMessage: an expired set_ref should be told to the owner
    // directly, never raise (or wait on) a confirmation prompt.
    const chatMentionsResearch = /(ابحث|بحث من جديد|منتهي|صلاحي|expired)/i.test(chatExportReply.text);

    const directExport = await callAction(page, clinicId, 'export_result', {
      set_ref: setRef,
      format: 'xlsx',
      causing_message: exportTrigger,
    });
    const expiredCorrectly = directExport?.data?.error === 'set_ref_not_found_or_expired';
    const noDownloadUrl = !directExport?.data?.download_url;

    recorder.record({
      id: 'TC-EXP02-03',
      tool: 'export_result — set_ref expiry after >30 min (resolve_set_ref default ttl_minutes=30)',
      trigger: `${SEARCH_TRIGGER} ... [~31 min real wait] ... ${exportTrigger}`,
      result: expiredCorrectly && noDownloadUrl ? 'PASS' : 'FAIL',
      evidence:
        `chat_search_reply="${searchReply.text}"\nchat_export_reply="${chatExportReply.text}" (mentions re-search/expiry: ${chatMentionsResearch})\n\n` +
        `[direct action] export_result -> error=${directExport?.data?.error} download_url=${directExport?.data?.download_url}`,
    });
    expect(expiredCorrectly, 'export_result must reject an expired set_ref with set_ref_not_found_or_expired').toBe(true);
    expect(noDownloadUrl, 'an expired set_ref must never produce a download_url').toBe(true);
    await context.close();
  });
});
