import { test, expect } from '@playwright/test';
import { gotoAiInstructionStep, sendMessage } from '../../helpers/maha-chat';
import { ReportRecorder } from '../../helpers/report';
import '../../helpers/ob4-local-guard'; // throws if BASE_URL isn't local — see that file for why

/**
 * Covers EXP-05 `export_result`'s data-type/format coverage, TC-EXP05-01..04, from
 * QA_TestScript_Phase4_CRM_Export.md's 2026-09-05 re-audit. Per that doc's own
 * status table: TC-EXP05-01 is "✅ HANYA bagian 'kontak' yang testable sekarang",
 * TC-EXP05-02/03/04 are "⏳ Blocked (N/A saat ini)".
 *
 * Root cause of the 3 blocked cases, confirmed by reading inapp_agent/tools/export.py's
 * module docstring directly (reporty-onboard-phase3): `agent_set_refs` is written
 * ONLY by `resolve_segment_criteria()` (i.e. only `crm_search_contacts` produces a
 * set_ref today). `crm_aggregate` (analytics reports), `read_appointments`, and full
 * conversation transcripts are none of them wired to write a set_ref yet — so none of
 * TC-EXP05-02/03/04's preconditions ("run a query that produces an analytics/transcript
 * set_ref") can be prepared at all, real chat or otherwise. Additionally confirmed
 * directly in export_result()'s own code (export.py:110-115): `format == "docx"` is
 * special-cased to unsupported_format_for_data_type for EVERY data_type, not just the
 * ones the spec says shouldn't get it — docx has no renderer at all
 * (AgentExportController::render(), reporty-web-backup, only implements pdf/xlsx/csv).
 *
 * Capability gate: this suite introduces `TEST_EXPORT_CAPABILITY_ENABLED` for
 * `phase4Capabilities.export` (shared name with the sibling EXP-01..04 spec files).
 * Every export test ALSO needs `TEST_CRM_CAPABILITY_ENABLED=1` — the QA doc's own
 * "Precondition universal" note (line 1559) says so explicitly: every exportable
 * set_ref comes from `crm_search_contacts`, which lives under the `crm` capability
 * group, not `export`. Both must be on.
 *
 * Verification strategy (mirrors 05-crm05-add-note.spec.ts): one pass through the real
 * chat widget (NEEDS_REVIEW — reply wording/naturalness isn't mechanically checkable),
 * plus a second pass via `callAction()` — a direct POST to reporty-onboard-phase3's own
 * `POST /clinic/<id>/action` (registry.invoke(), bypasses the LLM/Laravel entirely) —
 * for a PASS/FAIL mechanical check. The envelope shape (`{success, data, error, event}`,
 * confirmed by reading inapp_agent/core/registry.py:217-412 directly) is used here:
 * `result.data` always holds the tool's own return dict, on both the success AND
 * business-error path, and `result.error` mirrors the tool's own `error` field either
 * way.
 *
 * "file opens without error" (the doc's own acceptance bar) is approximated here by:
 * fetching download_url via `page.request.get()` (an absolute, signed Laravel URL —
 * AgentExportController::download(), no auth needed beyond the signature) and checking
 * (a) HTTP 200 and (b) the response body's magic bytes match the requested format
 * (`%PDF` for pdf, `PK` zip signature for xlsx, `# ` metadata-comment prefix for csv —
 * the csv prefix is EXP-04's own AC#3, confirmed in AgentExportController::renderCsv()).
 * This can't prove the file's CONTENTS are semantically correct, but it is a real,
 * mechanical proxy for "downloadable and not corrupt" that a script can check.
 */

const recorder = new ReportRecorder('OB4 EXP-05 Export Report Types');
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

/**
 * Direct call to reporty-onboard-phase3's `POST /clinic/<id>/action` — same
 * registry.invoke() code path a real chat tool call uses, completely bypassing the
 * LLM and Laravel. See 05-crm05-add-note.spec.ts's own callAction() comment for the
 * full rationale (structured JSON over trusting a paraphrased chat reply, plus the
 * ability to force scenarios normal chat can't reliably reproduce).
 */
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
      session_id: `qa-exp05-${action}-${Math.floor(Math.random() * 1e9)}`,
    },
  });
  return resp.json();
}

// Broad, real filter matching the doc's own example ("belum booking sejak 1 Januari
// 2026") — one of the only 6 appointment-fact filters crm_search_contacts exposes
// (crm.py's search_contacts() signature), confirmed directly from source.
const SEARCH_PARAMS = { hasnt_booked_since: '2026-06-01', limit: 200 };

test.describe('TC-EXP05-01 — contact_list export to PDF/xlsx/CSV (the only testable data type today)', () => {
  test('crm_search_contacts set_ref exports cleanly to all 3 supported formats', async ({ browser }) => {
    // Bumped from 180_000 — live-reproduced 2026-09-07, 3x in a row: this test hangs
    // specifically on the LAST of 3 sequential real downloads (always csv, since it's
    // last in `formats`), never pdf/xlsx. Isolated with a direct curl to the exact same
    // download_url outside Playwright entirely: it succeeded in ~8.6s (real GCS
    // round-trip via AgentExportController::download()'s Storage::disk('gcs')-
    // >readStream(), not a broken endpoint). This points to the LOCAL single-threaded
    // `php artisan serve` dev server getting backed up by request #3 in one browser
    // context already carrying a full chat conversation's worth of polling/requests —
    // an environment/concurrency limitation, not a product bug. More headroom here is
    // a pragmatic accommodation, not a fix for a real defect.
    test.setTimeout(300_000);
    test.skip(capabilityGated(), CAPABILITY_SKIP_REASON);

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);
    expect(clinicId, 'window.FO.clinicId must be present on the AI Instruction step').toBeTruthy();

    // Part 1 — real chat pass, NEEDS_REVIEW (reply wording/naturalness isn't
    // mechanically checkable; the mechanical PASS/FAIL check is Part 2 below).
    const searchTrigger = 'ابحثي عن المرضى الذين لم يحجزوا موعدًا منذ 1 يونيو 2026';
    const searchReply = await sendMessage(page, searchTrigger);
    const pdfReply = await sendMessage(page, 'صدّري هذا إلى PDF');
    const xlsxReply = await sendMessage(page, 'صدّري هذا إلى Excel');
    const csvReply = await sendMessage(page, 'صدّري هذا إلى CSV');

    recorder.record({
      id: 'TC-EXP05-01-CHAT',
      tool: 'crm_search_contacts → export_result (pdf/xlsx/csv) — chat pass',
      trigger: `${searchTrigger} / صدّري هذا إلى PDF / Excel / CSV`,
      result: 'NEEDS_REVIEW',
      evidence:
        `search="${searchReply.text}"\npdf="${pdfReply.text}"\nxlsx="${xlsxReply.text}"\ncsv="${csvReply.text}"`,
    });

    // Part 2 — direct callAction pass, mechanical PASS/FAIL. Gets a fresh set_ref
    // straight from the JSON response (never parsed out of a chat bubble), then
    // exports it 3 times and fetches each real download_url.
    const searchResult = await callAction(page, clinicId, 'crm_search_contacts', SEARCH_PARAMS);
    const setRef: string | undefined = searchResult?.data?.set_ref;
    expect(setRef, 'crm_search_contacts must return a set_ref to export from').toBeTruthy();

    const formats: Array<{ format: 'pdf' | 'xlsx' | 'csv'; magicCheck: (buf: Buffer) => boolean }> = [
      { format: 'pdf', magicCheck: (buf) => buf.subarray(0, 4).toString('latin1') === '%PDF' },
      { format: 'xlsx', magicCheck: (buf) => buf.subarray(0, 2).toString('latin1') === 'PK' },
      { format: 'csv', magicCheck: (buf) => buf.subarray(0, 2).toString('latin1') === '# ' },
    ];

    const perFormatResults: string[] = [];
    let allOk = true;

    for (const { format, magicCheck } of formats) {
      const exportResult = await callAction(page, clinicId, 'export_result', {
        set_ref: setRef,
        format,
        causing_message: `[direct action, not chat] export_result format=${format}`,
      });
      const downloadUrl: string | undefined = exportResult?.data?.download_url;
      const exportOk = !!exportResult?.success && !!downloadUrl;

      let fetchOk = false;
      let magicOk = false;
      if (downloadUrl) {
        const fileResp = await page.request.get(downloadUrl);
        fetchOk = fileResp.status() === 200;
        if (fetchOk) {
          const body = await fileResp.body();
          magicOk = magicCheck(body);
        }
      }

      const ok = exportOk && fetchOk && magicOk;
      allOk = allOk && ok;
      perFormatResults.push(
        `format=${format} export_ok=${exportOk} fetch_ok=${fetchOk} magic_ok=${magicOk} ` +
          `error=${exportResult?.error} download_url=${downloadUrl ? '[present]' : '[absent]'}`
      );
    }

    recorder.record({
      id: 'TC-EXP05-01',
      tool: 'export_result(format=pdf|xlsx|csv) — direct action, downloaded + magic-byte checked',
      trigger: `[direct action, not chat] crm_search_contacts(${JSON.stringify(SEARCH_PARAMS)}) → export_result x3`,
      result: allOk ? 'PASS' : 'FAIL',
      evidence: perFormatResults.join('\n'),
    });
    expect(allOk, 'all 3 formats must export, download (HTTP 200), and match the expected file signature').toBe(true);
    await context.close();
  });
});

test.describe('TC-EXP05-02 — analytics report export to PDF/Docx — UNABLE_TO_TEST', () => {
  test('blocked: crm_aggregate does not write a set_ref, and docx has no renderer at all', async () => {
    recorder.record({
      id: 'TC-EXP05-02',
      tool: 'export_result(data_type=analytics, format=pdf|docx)',
      trigger: '(cannot be prepared — no analytics set_ref exists yet)',
      result: 'UNABLE_TO_TEST',
      evidence:
        'Two independent blockers, both confirmed by reading source directly (reporty-onboard-phase3, ' +
        '2026-09-06): (1) `crm_aggregate` (inapp_agent/tools/crm.py aggregate()) never calls ' +
        'resolve_segment_criteria()/writes to agent_set_refs — the ONLY producer of a set_ref today is ' +
        'crm_search_contacts (see export.py module docstring). There is no way to obtain an analytics-shaped ' +
        'set_ref to export from, real chat or direct action. (2) Even if one existed, docx export is not ' +
        'implemented for ANY data_type — export_result() (export.py:110-115) special-cases format=="docx" to ' +
        'unsupported_format_for_data_type unconditionally, and AgentExportController::render() ' +
        '(reporty-web-backup) only has pdf/xlsx/csv branches, no docx renderer exists in the codebase at all. ' +
        'Re-execute once crm_aggregate is extended to write a set_ref AND a docx renderer is built.',
    });
    test.skip(true, 'no analytics set_ref producer exists yet, and docx has no renderer at all — see evidence');
  });
});

test.describe('TC-EXP05-03 — analytics report export to Excel/CSV rejected — UNABLE_TO_TEST', () => {
  test('blocked: same crm_aggregate set_ref gap as TC-EXP05-02', async () => {
    recorder.record({
      id: 'TC-EXP05-03',
      tool: 'export_result(data_type=analytics, format=xlsx|csv) — expected rejection',
      trigger: '(cannot be prepared — no analytics set_ref exists yet)',
      result: 'UNABLE_TO_TEST',
      evidence:
        'Same root cause as TC-EXP05-02: crm_aggregate does not write a set_ref (confirmed via export.py\'s ' +
        'module docstring and a direct read of crm.py\'s aggregate()), so there is no analytics-shaped set_ref ' +
        'to attempt exporting (and have correctly rejected) in the first place. Unlike TC-EXP05-02, the ' +
        'REJECTION side is already correctly wired on the Laravel side: AgentExportController::FORMAT_TABLE ' +
        '(reporty-web-backup) already lists analytics => [\'pdf\'] only, so once crm_aggregate is extended to ' +
        'write a set_ref, this TC should just work with no format-table change needed — the only missing piece ' +
        'is the set_ref producer.',
    });
    test.skip(true, 'no analytics set_ref producer exists yet — see evidence');
  });
});

test.describe('TC-EXP05-04 — conversation transcript export to Excel rejected — UNABLE_TO_TEST', () => {
  test('blocked: full conversation transcripts do not write a set_ref either', async () => {
    recorder.record({
      id: 'TC-EXP05-04',
      tool: 'export_result(data_type=conversation_transcript, format=xlsx) — expected rejection',
      trigger: '(cannot be prepared — no transcript set_ref exists yet)',
      result: 'UNABLE_TO_TEST',
      evidence:
        'Same class of gap as TC-EXP05-02/03: nothing in reporty-onboard-phase3 today reads a full ' +
        'conversation transcript into a set_ref — crm_search_contacts (patients/contacts) is still the only ' +
        'producer (export.py module docstring, confirmed 2026-09-06). Re-execute once a transcript-reading ' +
        'tool is extended to write to agent_set_refs. Same FORMAT_TABLE caveat as TC-EXP05-03 applies: ' +
        'AgentExportController::FORMAT_TABLE already lists conversation_transcript => [\'pdf\'] only, so the ' +
        'expected xlsx rejection IS already correctly wired on the Laravel side — only the set_ref producer is ' +
        'missing.',
    });
    test.skip(true, 'no conversation-transcript set_ref producer exists yet — see evidence');
  });
});
