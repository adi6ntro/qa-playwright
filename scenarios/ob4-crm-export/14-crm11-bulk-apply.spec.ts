import { test, expect } from '@playwright/test';
import { gotoAiInstructionStep, sendMessage, sendAndConfirm } from '../../helpers/maha-chat';
import { ReportRecorder } from '../../helpers/report';
import '../../helpers/ob4-local-guard'; // throws if BASE_URL isn't local — see that file for why

/**
 * Covers CRM-11 `crm_bulk_apply`, from QA_TestScript_Phase4_CRM_Export.md's
 * TC-CRM11-01..04 (lines 1402-1477). Per that doc's Wave 3 note (2026-09-05):
 * real (`crm.py:1031`), but 2 numbers differ from the original spec —
 * **batch cap is 2000, not 200** (confirmed directly against `_BULK_ROW_CAP`
 * in crm.py, ~line 1026), and **`is_reversible` is ALWAYS `false`** (no undo
 * infra exists at all). This file uses the code-confirmed values, not the
 * doc's original ones.
 *
 * IMPORTANT — no confirmed bulk-eligible dataset exists beyond a single
 * known contact (896, used by 05-crm05/13-crm10). Rather than assume a
 * specific contact set the doc's own examples name ("~40 kontak", "~150
 * kontak", "~2500 kontak"), every test below performs its OWN real
 * `crm_search_contacts` call first (via direct callAction, same pattern as
 * 05-crm05) to get a real `set_ref` scoped to whatever this clinic's actual
 * appointment data supports, then bulk-applies against exactly that —
 * surfacing the real count as evidence rather than assuming one.
 *
 * IMPORTANT — "staf Fatimah" substitution: TC-CRM11-02's doc precondition
 * names a specific staff account with no confirmed equivalent in this
 * environment. Every reassignment test below targets the clinic owner's OWN
 * id as assignee — crm_bulk_apply's set_responsible path validates assignee
 * via `id = %s AND (id = %s OR parent_user_id = %s)` (crm.py:1083), which the
 * owner assigning to themselves always satisfies — so this exercises the
 * real code path without depending on an unconfirmed staff account.
 *
 * IMPORTANT — TC-CRM11-03 (batching-cap negative): reading bulk_apply()'s
 * own code (crm.py:1063-1066) shows there is NO automatic cross-call
 * batching at all — exceeding `_BULK_ROW_CAP` (2000) makes the call return
 * `row_limit_exceeded` immediately, once, with nothing processed. The doc's
 * expected result ("Seluruh ~2500 kontak akhirnya tertag lintas batch") — an
 * eventual multi-batch completion — is NOT something this tool implements by
 * itself; at most a chat layer could choose to retry with a narrower filter,
 * which is an LLM-orchestration behavior, not a tool guarantee. This is
 * flagged as a real finding below, not silently assumed away.
 */

const recorder = new ReportRecorder('OB4 CRM-11 Bulk Apply');
test.afterAll(async () => {
  await recorder.writeTo('reports');
});

const CRM_CAPABILITY_SKIP_REASON =
  'Set TEST_CRM_CAPABILITY_ENABLED=1 only after manually enabling "phase4Capabilities": {"crm": "*"} ' +
  '(or this test clinic\'s id) in your LOCAL reporty-onboard-phase3 config.json and restarting app.py.';

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
      session_id: `qa-crm11-${action}-${Math.floor(Math.random() * 1e9)}`,
      branch_id: opts.branchId,
    },
  });
  return resp.json();
}

interface BulkResult {
  total?: number;
  processed?: number;
  changed?: number;
  already_correct?: number;
  failed?: Array<{ contact_id: unknown; reason: string }>;
  is_reversible?: boolean;
  success?: boolean;
  error?: string;
  row_count?: number;
  cap?: number;
}

test.describe('TC-CRM11-01 — bulk tag returns a real per-row result, not a bare summary', () => {
  test('add_tag over a real set_ref returns processed/changed/already_correct/failed shaped correctly', async ({ browser }) => {
    test.setTimeout(180_000);
    test.skip(process.env.TEST_CRM_CAPABILITY_ENABLED !== '1', CRM_CAPABILITY_SKIP_REASON);

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);
    expect(clinicId, 'window.FO.clinicId must be present on the AI Instruction step').toBeTruthy();

    // Real chat flow, same conversation (search then bulk-tag "these"), captured for
    // NEEDS_REVIEW wording review — Maha resolves "these contacts" from its own
    // just-made tool call's set_ref, same in-context resolution 05-crm05's header
    // comment documents as the only way contact reference works today.
    const searchTrigger = 'ابحثي لي عن المرضى الذين لم يحجزوا موعدًا منذ 1 يناير 2026';
    const searchReply = await sendMessage(page, searchTrigger);
    const bulkTrigger = "صنّفي كل هؤلاء المرضى بتصنيف 'hot lead'";
    const { replies: bulkReplies, confirmRoundsNeeded } = await sendAndConfirm(page, bulkTrigger);
    const bulkReply = bulkReplies[bulkReplies.length - 1];

    // Ground truth: an independent search + bulk_apply via direct callAction, so the
    // per-row CONTRACT (not the chat wording) gets a hard mechanical check.
    const search = await callAction(page, clinicId, 'crm_search_contacts', {
      hasnt_booked_since: '2026-06-01',
      limit: 1,
    });
    const total: number = search?.data?.total ?? 0;

    if (total === 0) {
      recorder.record({
        id: 'TC-CRM11-01',
        tool: 'crm_bulk_apply(operation=add_tag)',
        trigger: searchTrigger,
        result: 'UNABLE_TO_TEST',
        evidence: `crm_search_contacts(hasnt_booked_since=2026-06-01) returned 0 real contacts this run — nothing to bulk-apply to. search=${JSON.stringify(search).slice(0, 300)}`,
      });
      test.skip(true, 'no real matching contacts this run — see recorded evidence');
      return;
    }

    const bulk: BulkResult = (await callAction(page, clinicId, 'crm_bulk_apply', {
      set_ref: search.data.set_ref,
      operation: 'add_tag',
      parameters: { tag: 'QA_CRM11_HOTLEAD' },
      causing_message: '[direct action, ground truth] TC-CRM11-01 bulk tag verification',
    })).data;

    const shapeOk =
      typeof bulk.total === 'number' &&
      typeof bulk.processed === 'number' &&
      typeof bulk.changed === 'number' &&
      typeof bulk.already_correct === 'number' &&
      Array.isArray(bulk.failed) &&
      bulk.is_reversible === false;
    const totalMatches = bulk.total === total;
    const rowsAccountedFor = shapeOk && (bulk.changed! + bulk.already_correct! + bulk.failed!.length) === bulk.processed;

    recorder.record({
      id: 'TC-CRM11-01',
      tool: 'crm_bulk_apply(operation=add_tag) — per-row result contract (chat + direct-call ground truth)',
      trigger: `${searchTrigger} / ${bulkTrigger}`,
      result: shapeOk && totalMatches && rowsAccountedFor ? 'PASS' : 'FAIL',
      confirmRoundsNeeded,
      evidence:
        `real_contact_count=${total} shape_ok=${shapeOk} total_matches=${totalMatches} rows_accounted_for=${rowsAccountedFor}\n` +
        `bulk_result=${JSON.stringify(bulk).slice(0, 400)}\n\n` +
        `chat: searchReply="${searchReply.text}"\nbulkReply="${bulkReply.text}"`,
    });
    expect(shapeOk, 'response must carry total/processed/changed/already_correct/failed[]/is_reversible').toBe(true);
    expect(totalMatches, "bulk_apply's total must match the real search count").toBe(true);
    expect(rowsAccountedFor, 'changed + already_correct + failed.length must equal processed').toBe(true);
    await context.close();
  });
});

test.describe('TC-CRM11-02 — bulk ownership reassignment, is_reversible always false', () => {
  test('reassigning ownership over a real set_ref applies for real and never offers undo', async ({ browser }) => {
    test.setTimeout(180_000);
    test.skip(process.env.TEST_CRM_CAPABILITY_ENABLED !== '1', CRM_CAPABILITY_SKIP_REASON);

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);

    const searchTrigger = 'ابحثي لي عن المرضى الذين لم يحجزوا موعدًا منذ 1 يناير 2026';
    const searchReply = await sendMessage(page, searchTrigger);
    // "to me" (the clinic owner) rather than a named staff — see file header.
    const bulkTrigger = 'انقلي مسؤولية كل هؤلاء المرضى إليّ أنا (صاحب العيادة)';
    const { replies: bulkReplies, confirmRoundsNeeded } = await sendAndConfirm(page, bulkTrigger);
    const bulkReply = bulkReplies[bulkReplies.length - 1];
    // Signal only, not a verdict: a bare keyword hit can't tell "you can undo this"
    // apart from "this is NOT reversible" (غير قابل للتراجع) — same word, opposite
    // meaning. Only flags for NEEDS_REVIEW; never fails the test on its own (see
    // helpers/report.ts's PASS/FAIL/NEEDS_REVIEW convention).
    const mentionsUndoKeyword = /(تراجع|إلغاء|undo)/i.test(bulkReply.text);

    const search = await callAction(page, clinicId, 'crm_search_contacts', {
      hasnt_booked_since: '2026-06-01',
      limit: 1,
    });
    const total: number = search?.data?.total ?? 0;

    if (total === 0) {
      recorder.record({
        id: 'TC-CRM11-02',
        tool: 'crm_bulk_apply(operation=set_responsible)',
        trigger: searchTrigger,
        result: 'UNABLE_TO_TEST',
        evidence: `crm_search_contacts(hasnt_booked_since=2026-06-01) returned 0 real contacts this run. search=${JSON.stringify(search).slice(0, 300)}`,
      });
      test.skip(true, 'no real matching contacts this run — see recorded evidence');
      return;
    }

    const bulk: BulkResult = (await callAction(page, clinicId, 'crm_bulk_apply', {
      set_ref: search.data.set_ref,
      operation: 'set_responsible',
      parameters: { assignee_id: String(clinicId) },
      causing_message: '[direct action, ground truth] TC-CRM11-02 bulk reassign verification',
    })).data;

    const isReversibleFalse = bulk.is_reversible === false;
    const applied = (bulk.changed ?? 0) + (bulk.already_correct ?? 0) === total && (bulk.failed?.length ?? 1) === 0;

    recorder.record({
      id: 'TC-CRM11-02',
      tool: 'crm_bulk_apply(operation=set_responsible) — is_reversible always false, real ownership change applied',
      trigger: `${searchTrigger} / ${bulkTrigger}`,
      result: !isReversibleFalse || !applied ? 'FAIL' : mentionsUndoKeyword ? 'NEEDS_REVIEW' : 'PASS',
      confirmRoundsNeeded,
      evidence:
        `real_contact_count=${total} is_reversible_false=${isReversibleFalse} fully_applied=${applied} ` +
        `mentions_undo_keyword=${mentionsUndoKeyword} (NEEDS_REVIEW when true — could be a false positive from ` +
        `a negation like "غير قابل للتراجع" i.e. "not reversible", see comment above)\n` +
        `bulk_result=${JSON.stringify(bulk).slice(0, 400)}\n\n` +
        `chat: searchReply="${searchReply.text}"\nbulkReply="${bulkReply.text}"`,
    });
    expect(isReversibleFalse, 'is_reversible must always be false — no undo infra exists yet').toBe(true);
    expect(applied, 'ownership must actually be reassigned for every real row, per-row').toBe(true);
    await context.close();
  });
});

test.describe('TC-CRM11-03 — batching cap: 2000, not 200 — must be announced, never silently partial', () => {
  test('exceeding the real row cap rejects explicitly with the cap value, not silent partial processing', async ({ browser }) => {
    test.setTimeout(180_000);
    test.skip(process.env.TEST_CRM_CAPABILITY_ENABLED !== '1', CRM_CAPABILITY_SKIP_REASON);

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);

    // Widest realistic net this clinic's real data can give us: "hasn't booked
    // since 2030" matches essentially every contact with any appointment history,
    // since nobody has booked in the future yet.
    const search = await callAction(page, clinicId, 'crm_search_contacts', {
      hasnt_booked_since: '2030-01-01',
      limit: 1,
    });
    const total: number = search?.data?.total ?? 0;
    const CAP = 2000;

    if (total <= CAP) {
      recorder.record({
        id: 'TC-CRM11-03',
        tool: 'crm_bulk_apply — row_limit_exceeded cap (code-confirmed cap=2000, not 200)',
        trigger: '(setup only — insufficient real data to exceed the cap)',
        result: 'UNABLE_TO_TEST',
        evidence:
          `This clinic's widest real contact count is ${total}, which does not exceed the real cap (${CAP}) — cannot ` +
          `trigger row_limit_exceeded with real data this run. IMPORTANT FINDING regardless of data volume: reading ` +
          `crm.py's bulk_apply() directly (line 1063-1066) shows exceeding the cap returns {success:false, ` +
          `error:"row_limit_exceeded", row_count, cap:2000} IMMEDIATELY, with NOTHING processed — there is no code ` +
          `path that automatically continues across multiple batches to eventually cover the whole set. The doc's ` +
          `own expected result ("Seluruh ~2500 kontak akhirnya tertag lintas batch") describes behavior this tool ` +
          `does not implement by itself; at most a chat-orchestration layer could choose to retry with a narrower ` +
          `filter, which is unverified LLM behavior, not a tool guarantee. Retest this once real data or a narrower ` +
          `cap-adjacent dataset is available.`,
      });
      test.skip(true, 'insufficient real data to exceed the row cap this run — see recorded evidence/finding');
      return;
    }

    const bulk: BulkResult = (await callAction(page, clinicId, 'crm_bulk_apply', {
      set_ref: search.data.set_ref,
      operation: 'add_tag',
      parameters: { tag: 'QA_CRM11_CAPTEST' },
      causing_message: '[direct action, ground truth] TC-CRM11-03 cap verification',
    })).data;

    const rejectedWithCap = bulk.success === false && bulk.error === 'row_limit_exceeded' && bulk.cap === CAP && (bulk.row_count ?? 0) > CAP;

    recorder.record({
      id: 'TC-CRM11-03',
      tool: 'crm_bulk_apply — row_limit_exceeded cap (code-confirmed cap=2000, not 200)',
      trigger: '(direct action, not chat)',
      result: rejectedWithCap ? 'PASS' : 'FAIL',
      evidence: `real_row_count=${total} bulk_result=${JSON.stringify(bulk).slice(0, 400)}`,
    });
    expect(rejectedWithCap, 'exceeding 2000 rows must reject explicitly with row_limit_exceeded/cap=2000').toBe(true);
    await context.close();
  });
});

test.describe('TC-CRM11-05 — a non-contact_list set_ref is rejected cleanly, never misapplied clinic-wide', () => {
  /**
   * REAL LIVE INCIDENT this test guards against (found during the 2026-09-14 tool
   * review, reproduced against real dev data): before this fix, `agent_set_refs`
   * gained a `kind` column (contact_list/appointment_list/staff_list/etc — see
   * export.py/charts.py's own headers) but `bulk_apply()` (crm.py:1426-1427, current
   * code) was never updated to check it. Passing a NON-contact_list set_ref (e.g. one
   * minted from `list_doctors`, kind=`staff_list`) fell through to
   * `resolve_segment_criteria()` with that kind's payload — for `staff_list` the
   * payload is literally `{}`, which iterates to ZERO criteria, which
   * `resolve_segment_criteria()` treats as "match everything" — i.e. bulk_apply
   * silently applied to the clinic's WHOLE unscoped contact list. Live-reproduced:
   * a `staff_list` set_ref passed to bulk_apply wrote a note to 90 real contacts.
   * The fix (crm.py:1426-1427, confirmed by reading current source):
   *   `if resolved_ref.get("kind", "contact_list") != "contact_list": return
   *   {"success": False, "error": "unsupported_data_type_for_bulk_apply"}`
   *
   * IMPORTANT — minting mechanism: reading `maha_inapp_agent.py` directly (2026-09-14)
   * shows the `kind` column is ONLY ever written by `write_kinded_set_ref()`, called
   * exclusively from `_inv()` (maha_inapp_agent.py:3497) — the chat orchestrator's
   * OWN tool-call wrapper. The generic `registry.invoke()` used by this suite's
   * `callAction()` helper (same `POST /clinic/<id>/action` every other direct-call
   * test in this file uses) does NOT go through `_inv()` — confirmed by reading
   * `app.py`'s `Action` resource, which calls `registry.invoke()` directly. So there
   * is NO way to mint a `staff_list`/other-kind set_ref via a direct action call —
   * this test MUST go through the real chat/LLM path (list_doctors, then a bulk-tag
   * request in the same session) to produce one at all. This is a deliberate
   * deviation from this file's usual "direct call for ground truth" pattern, forced
   * by how the kind-minting side effect is actually wired.
   *
   * Mechanical verification, independent of the LLM's exact wording or even whether
   * it attempts the tool call at all: TEST_CONTACT_ID (a real, tracked contact under
   * this clinic) must NEVER end up carrying the QA marker tag as a side effect of a
   * "list doctors" + "tag all of these" combo — that is exactly the shape of the real
   * incident (contacts that were never the intended target getting bulk-mutated).
   * This is the load-bearing assertion; the chat reply text is captured as
   * NEEDS_REVIEW-grade evidence only.
   */
  test('listing doctors then bulk-tagging "these" must never mutate real contacts', async ({ browser }) => {
    test.setTimeout(180_000);
    test.skip(process.env.TEST_CRM_CAPABILITY_ENABLED !== '1', CRM_CAPABILITY_SKIP_REASON);
    test.skip(
      !process.env.TEST_CONTACT_ID,
      'Set TEST_CONTACT_ID to a real numeric contact_id under this clinic — used as the ' +
        '"canary" contact that must never pick up the QA marker tag from a kind-mismatched bulk_apply.'
    );

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);
    expect(clinicId).toBeTruthy();

    const canaryId = process.env.TEST_CONTACT_ID!;
    const before = await callAction(page, clinicId, 'crm_get_contact', { contact_id: canaryId });
    const beforeTags: string[] = before?.data?.tags || [];

    const marker = `QA_CRM11_KINDMISMATCH_${Date.now()}`;
    const listTrigger = 'اعرضي لي قائمة الأطباء في العيادة';
    const listReply = await sendMessage(page, listTrigger);
    const bulkTrigger = `صنّفي كل نتائج القائمة السابقة بالتصنيف '${marker}'`;
    const { replies, confirmRoundsNeeded } = await sendAndConfirm(page, bulkTrigger);
    const bulkReply = replies[replies.length - 1];

    const after = await callAction(page, clinicId, 'crm_get_contact', { contact_id: canaryId });
    const afterTags: string[] = after?.data?.tags || [];
    const canaryGotTagged = !beforeTags.includes(marker) && afterTags.includes(marker);

    // Secondary, weaker signal (LLM wording, not asserted): does the reply claim a
    // bulk change actually happened over "these" doctors at all?
    const claimsChanged = /(تم تصنيف|تم تحديث|تم تطبيق|✅)/i.test(bulkReply.text);

    recorder.record({
      id: 'TC-CRM11-05',
      tool: 'crm_bulk_apply — non-contact_list (staff_list) set_ref rejection, real-chat-only repro of a live incident',
      trigger: `${listTrigger} / ${bulkTrigger}`,
      result: canaryGotTagged ? 'FAIL' : 'PASS',
      confirmRoundsNeeded,
      evidence:
        `canary_contact_id=${canaryId} before_tags=${JSON.stringify(beforeTags)} after_tags=${JSON.stringify(afterTags)} ` +
        `canary_got_tagged=${canaryGotTagged} chat_claims_changed=${claimsChanged}\n\n` +
        `chat: listReply="${listReply.text}"\nbulkReply="${bulkReply.text}"\n\n` +
        `[Note] Whether Maha actually attempted crm_bulk_apply with the staff_list set_ref (vs. declining, or ` +
        `re-running a fresh crm_search_contacts of its own) is not independently observable without a tool-call ` +
        `log — same limitation as 01-part3-runtime-context.spec.ts's TC-P3-02. The assertion below holds either way: ` +
        `an unrelated real contact must never get mutated by this combo.`,
    });
    expect(
      canaryGotTagged,
      'a real, unrelated contact must never be mutated as a side effect of bulk-tagging a staff_list result — ' +
        'this is the exact shape of the live 90-contact incident this fix guards against'
    ).toBe(false);
    await context.close();
  });
});

test.describe('TC-CRM11-04 — stale/expired set_ref is rejected, no data changed', () => {
  test('a fabricated/unknown set_ref is rejected with set_ref_not_found_or_expired — direct call, no chat/LLM involved', async ({ browser }) => {
    test.setTimeout(60_000);
    test.skip(process.env.TEST_CRM_CAPABILITY_ENABLED !== '1', CRM_CAPABILITY_SKIP_REASON);

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page); // only to resolve window.FO.clinicId cheaply — no chat sent
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);

    // resolve_set_ref() (segments.py:277) looks up `id = %s AND user_id = %s AND
    // created_at > NOW() - INTERVAL 30 MINUTE` — a never-inserted random UUID hits
    // the exact same "no row" path a genuinely-expired (>30min-old) row would, so
    // this doesn't need to actually wait 30 minutes to exercise the real rejection
    // code path. bulk_apply() returns this error BEFORE any patient_tag/patients
    // write is attempted (crm.py:1055-1057) — control-flow-guaranteed no data
    // changes, same posture as 05-crm05's TC-CRM05-04 causing_message check.
    const fakeSetRef = `00000000-0000-4000-8000-${Date.now()}`.slice(0, 36);
    const result: BulkResult = await callAction(page, clinicId, 'crm_bulk_apply', {
      set_ref: fakeSetRef,
      operation: 'add_tag',
      parameters: { tag: 'should_never_apply' },
      causing_message: '[direct action, not chat] TC-CRM11-04 stale set_ref rejection',
    });

    recorder.record({
      id: 'TC-CRM11-04',
      tool: 'crm_bulk_apply(set_ref=<fabricated/expired>) — direct call, bypasses the LLM entirely',
      trigger: '[direct action, not chat] crm_bulk_apply set_ref=<never-issued>',
      result: result?.error === 'set_ref_not_found_or_expired' ? 'PASS' : 'FAIL',
      evidence: JSON.stringify(result),
    });
    expect(result?.error, 'must reject with set_ref_not_found_or_expired').toBe('set_ref_not_found_or_expired');
    await context.close();
  });
});
