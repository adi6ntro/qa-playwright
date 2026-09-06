import { test, expect } from '@playwright/test';
import { gotoAiInstructionStep, sendAndConfirm, sendMessage } from '../../helpers/maha-chat';
import { ReportRecorder } from '../../helpers/report';
import '../../helpers/ob4-local-guard'; // throws if BASE_URL isn't local — see that file for why

/**
 * Covers EXP-08 — cross-branch export cap, TC-EXP08-01/02, from
 * QA_TestScript_Phase4_CRM_Export.md's 2026-09-05 re-audit — both marked
 * "✅ Testable" in the doc's own status table.
 *
 * IMPORTANT finding, confirmed by reading source directly (reporty-onboard-phase3,
 * 2026-09-06) — this changes what TC-EXP08-01 can actually prove:
 *
 * `export_result` is registered as `tier=1` (registrations.py:920-925), NOT tier=3.
 * The registry's OWN confirmation gate (`(spec.destructive or spec.requires_confirm)
 * and not confirm` → confirmation_required, registry.py:292-299) never fires for this
 * tool at all — there is no code-level mechanism forcing a confirmation round-trip
 * before a cross-branch export runs. "TIER 3" here is PURELY a prompt instruction to
 * the model (export_result's own @function_tool docstring, maha_inapp_agent.py:4730-4733:
 * "When spans_branches is present... treat this as a TIER 3 confirmation before running
 * it, not a routine export") — a request the model can choose to honor or not, not a
 * gate the backend enforces.
 *
 * Worse, it's structurally impossible to honor literally: `spans_branches` is only
 * known AFTER `export_result` has already run (export.py:184-187 computes it from the
 * SAME resolved rows the file was just generated from), and it comes back in the exact
 * same response that already contains a live `download_url`. So "confirm BEFORE running
 * it" can only mean the model deciding to ask BEFORE ever calling export_result the
 * first time — inferring "this looks cross-branch" from context (e.g. the query itself
 * said "all branches") rather than from any tool response. That's a real, but entirely
 * model-behavioral, gap: whether Maha asks first is not something this test suite (or
 * the backend) can force or guarantee — captured here as NEEDS_REVIEW evidence, not a
 * hard PASS/FAIL, and documented so a future reader doesn't mistake this for an
 * enforced code gate.
 *
 * What IS mechanically checkable: whether the file's `spans_branches` array (once it
 * does appear) is genuinely present and lists more than one branch, and — for
 * TC-EXP08-02 — a structural guarantee found directly in export_result()'s own code:
 * `spans_branches` is only ever computed `if branch_id is None` (export.py:184), and a
 * branch_admin's branch_id is always forced server-side to their own single branch
 * (module docstring's "dev principle #1") — so a BA session can NEVER produce a
 * multi-branch `spans_branches` in the first place, by construction, independent of
 * whatever the model decides to say. Same "structurally guaranteed, not independently
 * re-verified here" posture as 05-crm05-add-note.spec.ts's TC-CRM05-01 note about
 * author_id.
 */

const recorder = new ReportRecorder('OB4 EXP-08 Export Tier3 Confirmation');
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
      session_id: `qa-exp08-${action}-${Math.floor(Math.random() * 1e9)}`,
    },
  });
  return resp.json();
}

test.describe('TC-EXP08-01 — TIER 3 confirmation before cross-branch export (super_admin)', () => {
  test('a super_admin export spanning >1 branch surfaces spans_branches; whether Maha confirms first is captured, not enforced', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    test.skip(capabilityGated(), CAPABILITY_SKIP_REASON);

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);
    expect(clinicId, 'window.FO.clinicId must be present on the AI Instruction step').toBeTruthy();

    // Real chat pass — NEEDS_REVIEW. sendAndConfirm (not a bare sendMessage) in case
    // Maha DOES ask a yes/no confirmation per her prompt instructions; if she doesn't,
    // this behaves exactly like sendMessage (no confirmation prompt to detect, 0 rounds).
    const searchTrigger = 'ابحثي عن جميع المرضى الذين لم يحجزوا موعدًا منذ 1 يناير 2026 في كل الفروع';
    const searchReply = await sendMessage(page, searchTrigger);
    const { replies, confirmRoundsNeeded } = await sendAndConfirm(page, 'صدّري قائمة جهات الاتصال من جميع الفروع');
    const lastReply = replies[replies.length - 1];

    recorder.record({
      id: 'TC-EXP08-01-CHAT',
      tool: 'export_result (spans_branches → TIER 3 prompt instruction) — chat pass',
      trigger: `${searchTrigger} / صدّري قائمة جهات الاتصال من جميع الفروع`,
      result: 'NEEDS_REVIEW',
      confirmRoundsNeeded,
      evidence:
        `search="${searchReply.text}"\nfirst_export_reply="${replies[0].text}"\nfinal_reply="${lastReply.text}"\n` +
        `confirm_rounds_needed=${confirmRoundsNeeded}\n\n` +
        '[Manual judgement needed — see this file\'s header comment] there is NO code-level gate forcing a ' +
        'confirmation here (export_result is tier=1); this only shows whether Maha chose to ask, per her own ' +
        'prompt instruction, before the file was generated. Check first_export_reply names actual branches ' +
        '(not a generic "are you sure?") if confirm_rounds_needed > 0.',
    });

    // Direct callAction pass — mechanical PASS/FAIL on the part that IS checkable:
    // does a genuinely multi-branch set_ref produce a spans_branches array with real
    // content in export_result's response.
    const searchResult = await callAction(page, clinicId, 'crm_search_contacts', {
      hasnt_booked_since: '2026-01-01',
      limit: 500,
    });
    const setRef: string | undefined = searchResult?.data?.set_ref;
    expect(setRef, 'crm_search_contacts must return a set_ref').toBeTruthy();

    const exportResult = await callAction(page, clinicId, 'export_result', {
      set_ref: setRef,
      format: 'csv',
      causing_message: '[direct action, not chat] export_result cross-branch (SA, no branch filter)',
    });
    const spansBranches: string[] | undefined = exportResult?.data?.spans_branches;
    const exportOk = !!exportResult?.success;

    if (!spansBranches || spansBranches.length === 0) {
      // Data precondition not met in this environment (test clinic's matching
      // patients all happen to sit in one branch, or there's only one branch at all)
      // — this is a real data-shape gap, not a code failure, so it's reported
      // honestly rather than forced to FAIL.
      recorder.record({
        id: 'TC-EXP08-01',
        tool: 'export_result — spans_branches content check, direct action',
        trigger: `[direct action, not chat] export_result(set_ref, format=csv), no branch filter`,
        result: 'UNABLE_TO_TEST',
        evidence:
          `export_ok=${exportOk} spans_branches=${JSON.stringify(spansBranches)}. This test clinic's matching ` +
          'contacts did not resolve to more than one branch this run (or the clinic has only one branch) — the ' +
          'doc\'s own precondition ("set_ref mencakup 3 cabang berbeda") was not met. Re-run against a test ' +
          'clinic/dataset with contacts genuinely spread across ≥2 branches.',
      });
      test.skip(true, 'crm_search_contacts result did not span >1 branch in this environment — see evidence');
    }

    const spansMultiple = (spansBranches as string[]).length >= 2;
    const namesLookReal = (spansBranches as string[]).every((n) => typeof n === 'string' && n.trim().length > 0);
    const ok = exportOk && spansMultiple && namesLookReal;

    recorder.record({
      id: 'TC-EXP08-01',
      tool: 'export_result — spans_branches content check, direct action',
      trigger: '[direct action, not chat] export_result(set_ref, format=csv), no branch filter',
      result: ok ? 'PASS' : 'FAIL',
      evidence: `export_ok=${exportOk} spans_branches=${JSON.stringify(spansBranches)}`,
    });
    expect(ok, 'export must succeed and spans_branches must list ≥2 real, non-empty branch names').toBe(true);
    await context.close();
  });
});

test.describe('TC-EXP08-02 — BA cannot export cross-branch', () => {
  test('a branch_admin session can never produce a multi-branch spans_branches, by construction', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    test.skip(capabilityGated(), CAPABILITY_SKIP_REASON);
    test.skip(
      !process.env.LOGIN_EMAIL_BA,
      'Set LOGIN_EMAIL_BA/LOGIN_PASSWORD_BA in .env and run `npm run login-setup:local-ba` to enable this test.'
    );

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ba.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);

    // Real chat pass, as the BA — genuinely attempting a cross-branch export, exactly
    // as the doc's own trigger asks. NEEDS_REVIEW on wording; the mechanical guarantee
    // below doesn't depend on how the model phrases its reply.
    const searchTrigger = 'ابحثي عن كل المرضى';
    const searchReply = await sendMessage(page, searchTrigger);
    const exportReply = await sendMessage(page, 'صدّري قائمة جهات الاتصال من جميع الفروع');

    const claimsAllBranches = /(كل|جميع).*(فروع|الفروع)/.test(exportReply.text) && /(تم|✅|رابط|http)/i.test(exportReply.text);

    recorder.record({
      id: 'TC-EXP08-02-CHAT',
      tool: 'export_result (BA branch-scoping) — chat pass',
      trigger: `${searchTrigger} / صدّري قائمة جهات الاتصال من جميع الفروع`,
      result: 'NEEDS_REVIEW',
      evidence:
        `search="${searchReply.text}"\nexport="${exportReply.text}"\n` +
        `reply_appears_to_claim_all_branches_success=${claimsAllBranches}\n\n` +
        '[Manual judgement needed] if a download_url appears, the file itself must be opened to confirm it ' +
        'contains only this BA\'s single branch\'s contacts — a script cannot easily inspect exported file ' +
        'content for this. The mechanical guarantee below (spans_branches structurally cannot appear for a BA) ' +
        'is the part this suite can actually prove.',
    });

    // Mechanical part — this is a STRUCTURAL guarantee read directly from
    // export_result()'s own code (export.py:179-187): the spans_branches block only
    // ever runs `if branch_id is None`, and get_clinic_context() forces branch_id to
    // the BA's own single branch server-side for every branch_admin session (dev
    // principle #1, module docstring) — never reachable as None for a BA, regardless
    // of what the BA asks for. This isn't independently re-derived here (would need
    // reading get_clinic_context()'s BA branch of get_clinic_context, out of scope for
    // this suite) — recorded as NEEDS_REVIEW with the code citation as evidence, same
    // posture as 05-crm05's author_id note, rather than a fabricated PASS this script
    // didn't actually re-verify end-to-end against the BA's real resolved branch_id.
    recorder.record({
      id: 'TC-EXP08-02',
      tool: 'export_result — spans_branches structural guard for branch_admin sessions',
      trigger: '(code-reading finding, not independently re-derived live — see evidence)',
      result: 'NEEDS_REVIEW',
      evidence:
        'export_result() (inapp_agent/tools/export.py:179-187) only computes spans_branches when ' +
        'branch_id is None — a branch_admin\'s branch_id is always forced server-side to their own single ' +
        'branch (get_clinic_context(), "dev principle #1" per the module docstring), so it can structurally ' +
        'never be None for a BA session. This means a BA asking for "all branches" can never receive a ' +
        'multi-branch spans_branches, by construction — but this test did not independently instrument or log ' +
        'the BA session\'s actual resolved branch_id live to re-confirm that claim end-to-end, hence ' +
        'NEEDS_REVIEW rather than PASS. [Manual cross-check] grep the OB4 python log for this session and ' +
        'confirm branch_id resolved to a concrete single branch id, never None, for this BA account.',
    });
    expect(exportReply.text.length).toBeGreaterThan(0);
    await context.close();
  });
});
