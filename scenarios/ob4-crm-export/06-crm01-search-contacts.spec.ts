import { test, expect } from '@playwright/test';
import { gotoAiInstructionStep, sendMessage } from '../../helpers/maha-chat';
import { ReportRecorder } from '../../helpers/report';
import '../../helpers/ob4-local-guard'; // throws if BASE_URL isn't local — see that file for why

/**
 * Covers CRM-01 `crm_search_contacts` from QA_TestScript_Phase4_CRM_Export.md
 * (reporty-web-backup): TC-CRM01-STUB-01/02 (lines 594-629, "bisa dijalankan
 * sekarang") plus TC-CRM01-01..05 (lines 682-768, the full spec's promised
 * filter surface).
 *
 * Read directly against the live source (2026-09-06,
 * inapp_agent/tools/crm.py:107-140 + registrations.py:784-793) to confirm what's
 * real: `search_contacts()` only exposes 6 appointment-fact params —
 * last_visit_before, last_visit_after, booking_status, service, doctor,
 * hasnt_booked_since — all reusing `resolve_segment_criteria()`, the same
 * resolver backing Marketing's live Agent Segments chat. Per the module's own
 * docstring (crm.py:13-24) and the doc's own audit, NONE of name/phone/
 * language/tags/consent_state-as-filter/conversation-content/campaign-id
 * filtering is backed by any table or resolver criterion yet — TC-CRM01-01..05
 * each assume one of those unsupported filters, so all five are written as
 * UNABLE_TO_TEST stubs below (per Adi's 2026-09-05/06 status audit: "⏳ Blocked
 * (filter blm diekspos)"), not forced automation. Only STUB-01/02 get real
 * browser-driven tests.
 *
 * Envelope contract (confirmed by reading registry.invoke(), core/registry.py:217-
 * 411): every /clinic/<id>/action call returns {success, data, error, event} —
 * `data` is ALWAYS the tool's own raw return dict (even on a handled failure),
 * `error` is separately hoisted to the top level too. search_contacts() itself
 * has no "success" key of its own (segments.py:264-274's return has no such
 * key) — so a plain call with no error results in envelope-level
 * `success: true`, `data: {rows, total, criteria_labels,
 * filters_applied_summary, match_source, set_ref}`.
 */

const recorder = new ReportRecorder('OB4 CRM-01 Search Contacts');
test.afterAll(async () => {
  await recorder.writeTo('reports');
});

const CRM_CAPABILITY_SKIP_REASON =
  'Set TEST_CRM_CAPABILITY_ENABLED=1 only after manually enabling "phase4Capabilities": {"crm": "*"} ' +
  '(or this test clinic\'s id) in your LOCAL reporty-onboard-phase3 config.json and restarting app.py.';

/**
 * Same direct-call helper as 05-crm05-add-note.spec.ts — POSTs straight to
 * reporty-onboard-phase3's own POST /clinic/<id>/action (registry.invoke(),
 * same code path a chat tool call uses), bypassing the LLM/Laravel entirely.
 * Used here to isolate whether the RESOLVER itself returns a well-shaped
 * result, independent of whatever date/filter the LLM parsed out of the
 * Arabic trigger.
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
      session_id: `qa-crm01-${action}-${Math.floor(Math.random() * 1e9)}`,
      branch_id: opts.branchId,
    },
  });
  return resp.json();
}

test.describe('TC-CRM01-STUB-01 — appointment-fact search (hasnt_booked_since) returns a real, well-shaped result', () => {
  test('crm_search_contacts returns rows/total/filters_applied_summary/set_ref, no error/crash', async ({ browser }) => {
    test.setTimeout(180_000);
    test.skip(process.env.TEST_CRM_CAPABILITY_ENABLED !== '1', CRM_CAPABILITY_SKIP_REASON);

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);
    expect(clinicId, 'window.FO.clinicId must be present on the AI Instruction step').toBeTruthy();

    const trigger = 'من الذين لم يحجزوا أي موعد منذ 2026-01-01؟';
    const reply = await sendMessage(page, trigger);

    // Direct-call cross-check with the equivalent explicit param — isolates the
    // resolver's own contract from the LLM's own date-parsing step.
    const direct = await callAction(page, clinicId, 'crm_search_contacts', { hasnt_booked_since: '2026-01-01' });
    const data = direct?.data || {};
    const rows: Array<{ patient_id?: unknown; name?: unknown }> = data.rows || [];
    const rowsWellShaped = rows.every((r) => 'patient_id' in r && 'name' in r);
    const hasFiltersSummary = typeof data.filters_applied_summary === 'string' && data.filters_applied_summary.length > 0;
    const hasSetRef = typeof data.set_ref === 'string' && data.set_ref.length > 0;
    const hasTotal = typeof data.total === 'number';

    const ok = direct?.success === true && hasFiltersSummary && hasSetRef && hasTotal && rowsWellShaped;

    recorder.record({
      id: 'TC-CRM01-STUB-01',
      tool: 'crm_search_contacts(hasnt_booked_since) — real resolver-backed search, crm.py:107/segments.py:264-274',
      trigger,
      result: ok ? 'PASS' : 'FAIL',
      evidence:
        `chat_reply="${reply.text}"\n\n` +
        `direct_call: success=${direct?.success} rows_count=${rows.length} total=${data.total} ` +
        `filters_applied_summary="${data.filters_applied_summary}" set_ref_present=${hasSetRef} rows_well_shaped=${rowsWellShaped}\n\n` +
        `${JSON.stringify(direct).slice(0, 600)}\n\n` +
        `[Manual cross-check still needed] whether the CHAT reply's rows actually match real patients/` +
        `appointment_scheduling data for this clinic (this run doesn't assert on data volume/content, only ` +
        `on the contract shape, since no fixture data volume is guaranteed here) — see this file's precondition ` +
        `note (BackfillPatients). Also not exercised here: the doc's 3rd expected-result bullet (an unsupported ` +
        'filter request, e.g. "tag VIP", must not be silently fabricated) — that is TC-CRM01-02/03\'s own territory, both blocked below.',
    });
    expect(ok, 'crm_search_contacts must return the full {rows,total,filters_applied_summary,set_ref} contract with no error').toBe(true);
    expect(reply.text.length).toBeGreaterThan(0);
    await context.close();
  });
});

test.describe('TC-CRM01-STUB-02 — with `crm` off (default today), no regression', () => {
  test('contact-search-like chat behaves like plain Phase 3 — no crm_search_contacts involvement', async ({ browser }) => {
    test.setTimeout(180_000);
    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);

    const trigger = 'من هم المرضى الذين لم يحجزوا موعدًا بعد؟';
    const reply = await sendMessage(page, trigger);

    recorder.record({
      id: 'TC-CRM01-STUB-02',
      tool: 'select_tools() — crm_search_contacts should not be in schema',
      trigger,
      result: 'NEEDS_REVIEW',
      evidence:
        `${reply.text}\n\n[Manual cross-check needed — this is the actual assertion] add a temporary ` +
        `logger.info("tools for clinic %s: %s", clinic_id, [t['name'] for t in tools]) after the ` +
        `select_tools() call in inapp_agent/orchestrators/maha_inapp_agent.py (~line 4796 per ` +
        `QA_TestScript_Phase4_CRM_Export.md line 617), restart your local app.py, re-run, and confirm ` +
        `crm_search_contacts never appears in the logged tool list.`,
    });
    expect(reply.text.length).toBeGreaterThan(0);
    await context.close();
  });
});

// ── TC-CRM01-01..05 — all "⏳ Blocked (filter blm diekspos)" per the doc's own
// 2026-09-05/06 status audit. Each needs a filter crm_search_contacts does not
// expose (confirmed by direct read of crm.py:107-140 above) — writing a
// browser test around these would force a fake premise onto a tool that
// honestly refuses to accept params it can't back, so each is recorded as a
// manual/blocked stub instead, same posture as 01-part3-runtime-context.spec.ts's
// TC-P3-06.

test.describe('TC-CRM01-01 — contacted-this-week-but-not-booked search', () => {
  test('blocked — no "recently contacted via Inbox/WhatsApp" filter exists in crm_search_contacts', async () => {
    recorder.record({
      id: 'TC-CRM01-01',
      tool: 'crm_search_contacts',
      trigger: '(manual only)',
      result: 'UNABLE_TO_TEST',
      evidence:
        'This TC needs a filter for "contacted us in the last N days via Inbox/WhatsApp" — ' +
        'crm_search_contacts (inapp_agent/tools/crm.py:107-140, confirmed by direct read 2026-09-06) only ' +
        'exposes last_visit_before/after, booking_status, service, doctor, hasnt_booked_since — all ' +
        'appointment-fact criteria. There is no first_contact/last_message-date criterion backed by any ' +
        "table yet (per the module's own docstring, crm.py:19-24). What IS testable today with this tool " +
        'is TC-CRM01-STUB-01 (this file, hasnt_booked_since exercised for real). Also untestable as a ' +
        'follow-on within this same TC: the "export ke excel" set_ref continuation — needs a working ' +
        'export_result tool call chained after a real search, not exercised here since the search itself ' +
        "can't be constructed. Needs: a criterion resolver + search_contacts() param backed by " +
        'cases_whatsapp/inbox activity before this TC can run for real.',
    });
    test.skip(true, 'filter not exposed yet — see evidence');
  });
});

test.describe('TC-CRM01-02 — pagination of a tag-filtered search', () => {
  test('blocked — no tag filter exists in crm_search_contacts', async () => {
    recorder.record({
      id: 'TC-CRM01-02',
      tool: 'crm_search_contacts',
      trigger: '(manual only)',
      result: 'UNABLE_TO_TEST',
      evidence:
        'This TC needs a "tag" filter (search contacts with tag \'hot lead\') to even construct the trigger ' +
        'message — crm_search_contacts\'s exposed params (last_visit_before/after, booking_status, service, ' +
        'doctor, hasnt_booked_since; crm.py:107-140) have no tag criterion, and CRITERION_RESOLVERS in ' +
        'segments.py has no tag-kind entry either. Note: the underlying tags/patient_tag tables DO exist and ' +
        'ARE real (crm_update_contact\'s tags_add/tags_remove, crm.py:484-498) — only the search-by-tag path ' +
        "is missing, not the tag data model itself. What IS testable today is TC-CRM01-STUB-01 (hasnt_booked_" +
        'since). Needs: a tags-kind criterion added to CRITERION_RESOLVERS + exposed as a search_contacts() ' +
        'param before this TC can run for real.',
    });
    test.skip(true, 'filter not exposed yet — see evidence');
  });
});

test.describe('TC-CRM01-03 — branch-scope enforcement on a tag-filtered cross-branch search', () => {
  test('blocked — same missing tag filter as TC-CRM01-02, needed to construct this TC\'s own trigger', async () => {
    recorder.record({
      id: 'TC-CRM01-03',
      tool: 'crm_search_contacts',
      trigger: '(manual only)',
      result: 'UNABLE_TO_TEST',
      evidence:
        'Same root gap as TC-CRM01-02 — this TC\'s trigger ("cari kontak dengan tag \'hot lead\' di semua ' +
        'cabang") depends on a tag filter that crm_search_contacts does not expose (crm.py:107-140). Worth ' +
        'noting separately: the branch-scope ENFORCEMENT mechanism itself (branch_id param, _fetch_scoped_' +
        'patient-equivalent checks) is real and independently testable via other tools — see TC-CRM02-03 in ' +
        '07-crm02-get-contact.spec.ts, which exercises the same branch_admin/managed_branch_ids boundary ' +
        'using crm_get_contact instead, since that tool\'s filters ARE usable today. This TC specifically, as ' +
        'written in the doc (tag-filter + cross-branch), stays blocked until a tag criterion exists.',
    });
    test.skip(true, 'filter not exposed yet — see evidence');
  });
});

test.describe('TC-CRM01-04 — conversation-content matching with disclosure', () => {
  test('blocked — conversation criterion exists but is not wired to crm_search_contacts', async () => {
    recorder.record({
      id: 'TC-CRM01-04',
      tool: 'crm_search_contacts',
      trigger: '(manual only)',
      result: 'UNABLE_TO_TEST',
      evidence:
        'Still blocked, but the reason changed as of 2026-09-08 (Agent Segments CONVERSATION criteria work) — ' +
        're-confirmed by direct read 2026-09-10. The 2026-09-06 claim that "no criterion type resolves against ' +
        'message/conversation content at all today" is now FALSE: segments.py CRITERION_RESOLVERS has a real, ' +
        'wired `conversation_content_matched` entry (segments.py:66-77, kind="conversation" in CRITERION_KIND) ' +
        '— NOT dead code, it genuinely filters `p.id IN (patient_ids)`. What actually keeps this TC blocked: ' +
        'that resolver criterion takes a pre-computed `patient_ids` list, not free text — the SEMANTIC search ' +
        'over conversation content itself lives in a separate function, ' +
        '`conversation_search.search_conversation_content()` (new tool built alongside this fix), which is ' +
        'imported ONLY by `segments_agent.py` (Marketing\'s Agent Segments orchestrator) — confirmed via ' +
        '`grep -rn conversation_search` across the whole Python codebase, zero references from ' +
        '`maha_inapp_agent.py` or `registrations.py`. So conversation-content matching is real and reachable ' +
        'today, just exclusively through Agent Segments\' own chat, not through any Phase 4/Maha tool — ' +
        '`crm_search_contacts` (crm.py:107-136) still has no `conversation_query`/`patient_ids` param and no ' +
        'way to invoke the search step itself. Needs: crm_search_contacts (or a new CRM tool) to expose a way ' +
        'to trigger conversation search and pass its result into this already-working resolver criterion — ' +
        'the SQL-side plumbing is no longer the gap, only the Phase-4-tool-surface wiring is.',
    });
    test.skip(true, 'not wired to crm_search_contacts yet — see evidence');
  });
});

test.describe('TC-CRM01-05 — search by contact name, not found', () => {
  test('blocked — no name filter exists in crm_search_contacts', async () => {
    recorder.record({
      id: 'TC-CRM01-05',
      tool: 'crm_search_contacts',
      trigger: '(manual only)',
      result: 'UNABLE_TO_TEST',
      evidence:
        'This TC needs a name filter ("cari kontak bernama \'Zzzzz_TidakAda_12345\'") — confirmed by direct ' +
        'read (crm.py:107-109) that search_contacts()\'s full param list is exactly last_visit_before, ' +
        'last_visit_after, booking_status, service, doctor, hasnt_booked_since, limit, offset — no name/phone ' +
        'parameter anywhere. The empty-result honesty behavior this TC actually wants to check (0 rows, no ' +
        'crash, filters_applied_summary still populated) IS already exercised structurally by TC-CRM01-STUB-01 ' +
        'above whenever the hasnt_booked_since date happens to match zero real contacts — but this TC ' +
        'specifically needs a NAME filter to exist first. Needs: a name/phone criterion added to ' +
        'CRITERION_RESOLVERS + exposed as a search_contacts() param.',
    });
    test.skip(true, 'filter not exposed yet — see evidence');
  });
});
