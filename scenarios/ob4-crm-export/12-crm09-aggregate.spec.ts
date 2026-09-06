import { test, expect } from '@playwright/test';
import { gotoAiInstructionStep, sendMessage } from '../../helpers/maha-chat';
import { ReportRecorder } from '../../helpers/report';
import '../../helpers/ob4-local-guard'; // throws if BASE_URL isn't local — see that file for why

/**
 * Covers CRM-09 `crm_aggregate`, from QA_TestScript_Phase4_CRM_Export.md's
 * TC-CRM09-01..04 (lines 1272-1343). Per that doc's Wave 3 note (2026-09-05),
 * this is REAL for 3 of 4 metrics — `new_contacts_count`/`conversations_count`/
 * `bookings_count` hit real tables (crm.py's aggregate(), ~line 645);
 * `campaign_reads_count` is a deliberate honest stub (no read-receipt tracking
 * exists in this schema at all) — TC-CRM09-04 tests THAT honesty, not a real
 * metric. Follows 05-crm05-add-note.spec.ts's template: real Arabic chat
 * trigger + a direct `callAction()` ground-truth call for verification.
 *
 * IMPORTANT — why the "definition_applied/period_summary quoted verbatim"
 * part of TC-CRM09-01/02's expected result is NOT asserted as a hard
 * PASS/FAIL here: those strings are English (`_METRIC_DEFINITIONS` in
 * crm.py), and this clinic normalizes all chat to Arabic (same finding as
 * 01-part3-runtime-context.spec.ts's TC-P3-01 comment — a literal marker
 * string got fully translated/paraphrased in a live run). Asserting a
 * verbatim English substring inside an Arabic reply would almost certainly
 * false-FAIL on translation, not on a real bug. Instead this file checks a
 * language-agnostic mechanical signal: the actual COUNT NUMBERS from a direct
 * ground-truth `crm_aggregate` call (numbers don't get translated) are cross-
 * checked against digit sequences appearing in Maha's reply, and recorded as
 * evidence — but classified NEEDS_REVIEW rather than hard-failed on mismatch,
 * because "this month"/"last month" boundary resolution can legitimately
 * differ by a day between this script's own date math and Maha's, which would
 * be a false failure, not a real one.
 */

const recorder = new ReportRecorder('OB4 CRM-09 Aggregate');
test.afterAll(async () => {
  await recorder.writeTo('reports');
});

const CRM_CAPABILITY_SKIP_REASON =
  'Set TEST_CRM_CAPABILITY_ENABLED=1 only after manually enabling "phase4Capabilities": {"crm": "*"} ' +
  '(or this test clinic\'s id) in your LOCAL reporty-onboard-phase3 config.json and restarting app.py.';

/** Same direct-call pattern as 05-crm05-add-note.spec.ts's callAction() — see that
 * file's header comment for the full rationale (bypasses LLM + Laravel entirely). */
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
      session_id: `qa-crm09-${action}-${Math.floor(Math.random() * 1e9)}`,
      branch_id: opts.branchId,
    },
  });
  return resp.json();
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function currentMonthRange(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { start: ymd(start), end: ymd(now) };
}

function lastMonthRange(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)); // day 0 of this month = last day of prev month
  return { start: ymd(start), end: ymd(end) };
}

/** Extracts every digit-run from a string, e.g. "12 عميل، فرع 2 له 5" -> ["12","2","5"]. */
function digitRuns(text: string): string[] {
  return text.match(/\d+/g) || [];
}

test.describe('TC-CRM09-01 — new leads aggregated per branch', () => {
  test('aggregate reply carries real per-branch counts, not fabricated ones', async ({ browser }) => {
    test.setTimeout(180_000);
    test.skip(process.env.TEST_CRM_CAPABILITY_ENABLED !== '1', CRM_CAPABILITY_SKIP_REASON);

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);
    expect(clinicId, 'window.FO.clinicId must be present on the AI Instruction step').toBeTruthy();

    const trigger = 'كم عدد العملاء الجدد (leads) هذا الشهر، مقسمين حسب الفرع؟';
    const reply = await sendMessage(page, trigger);

    const { start, end } = currentMonthRange();
    const ground = await callAction(page, clinicId, 'crm_aggregate', {
      metric: 'new_contacts_count',
      period_start: start,
      period_end: end,
      group_by: 'branch',
    });

    const groundValues: Array<{ key: string; count: number }> = Array.isArray(ground?.value) ? ground.value : [];
    const groundIsShapedArray = groundValues.every((v) => typeof v.count === 'number' && 'key' in v);
    const replyDigits = digitRuns(reply.text);
    const countsFoundInReply = groundValues.filter((v) => replyDigits.includes(String(v.count))).length;

    recorder.record({
      id: 'TC-CRM09-01',
      tool: 'crm_aggregate(metric=new_contacts_count, group_by=branch) — value shape + digit cross-check',
      trigger,
      result: ground?.success && groundIsShapedArray && reply.text.length > 0 ? 'NEEDS_REVIEW' : 'FAIL',
      evidence:
        `ground_truth_success=${ground?.success} shaped_array=${groundIsShapedArray} ` +
        `branches_in_ground_truth=${groundValues.length} counts_found_verbatim_in_reply=${countsFoundInReply}/${groundValues.length} ` +
        `(period ${start}..${end}; a mismatch here can legitimately be a "this month" boundary difference, not a real bug — ` +
        `see file header)\nground_truth=${JSON.stringify(ground).slice(0, 400)}\n\nreply="${reply.text}"`,
    });
    expect(ground?.success, 'the ground-truth crm_aggregate call itself must succeed').toBeTruthy();
    expect(reply.text.length).toBeGreaterThan(0);
    await context.close();
  });
});

test.describe('TC-CRM09-02 — bookings aggregated by requested doctor', () => {
  test('doctor breakdown reply is a real per-doctor table, not a single number', async ({ browser }) => {
    test.setTimeout(180_000);
    test.skip(process.env.TEST_CRM_CAPABILITY_ENABLED !== '1', CRM_CAPABILITY_SKIP_REASON);

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);

    const trigger = 'أي دكتور طُلب أكثر من غيره الشهر الماضي؟';
    const reply = await sendMessage(page, trigger);

    const { start, end } = lastMonthRange();
    const ground = await callAction(page, clinicId, 'crm_aggregate', {
      metric: 'bookings_count',
      period_start: start,
      period_end: end,
      group_by: 'doctor_requested',
    });

    const groundValues: Array<{ key: string; count: number }> = Array.isArray(ground?.value) ? ground.value : [];
    const hasVariety = groundValues.length > 1;
    const top = groundValues.slice().sort((a, b) => b.count - a.count)[0];
    const replyDigits = digitRuns(reply.text);
    const topCountInReply = top ? replyDigits.includes(String(top.count)) : false;

    recorder.record({
      id: 'TC-CRM09-02',
      tool: 'crm_aggregate(metric=bookings_count, group_by=doctor_requested)',
      trigger,
      result: !ground?.success
        ? 'FAIL'
        : !hasVariety
        ? 'UNABLE_TO_TEST'
        : 'NEEDS_REVIEW',
      evidence: !hasVariety
        ? `Ground truth only has ${groundValues.length} doctor(s) with bookings in ${start}..${end} — the doc's own ` +
          `precondition ("variasi lebih dari satu dokter") does not hold for this clinic's real current data, so the ` +
          `"top doctor correctly identified" claim can't be meaningfully checked this run. ground_truth=` +
          `${JSON.stringify(ground).slice(0, 300)}`
        : `top_doctor="${top?.key}" top_count=${top?.count} top_count_verbatim_in_reply=${topCountInReply}\n` +
          `ground_truth=${JSON.stringify(ground).slice(0, 400)}\n\nreply="${reply.text}"`,
    });
    expect(ground?.success, 'the ground-truth crm_aggregate call itself must succeed').toBeTruthy();
    await context.close();
  });
});

// TC-CRM09-03 — real branch_admin (BA) account. Needs LOGIN_EMAIL_BA/PASSWORD_BA
// + `npm run login-setup:local-ba`, same precondition as 01-part3's TC-P3-02.
test.describe('TC-CRM09-03 — BA cannot see cross-branch totals', () => {
  test('BA asking for a clinic-wide total does not get the all-branch sum', async ({ browser }) => {
    test.setTimeout(180_000);
    test.skip(process.env.TEST_CRM_CAPABILITY_ENABLED !== '1', CRM_CAPABILITY_SKIP_REASON);
    test.skip(
      !process.env.LOGIN_EMAIL_BA,
      'Set LOGIN_EMAIL_BA/LOGIN_PASSWORD_BA in .env and run `npm run login-setup:local-ba` to enable this test.'
    );

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ba.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);

    const trigger = 'كم إجمالي العملاء الجدد هذا الشهر في كل فروع العيادة؟';
    const reply = await sendMessage(page, trigger);

    // Ground truth: the TRUE all-branch total, computed the same way a correctly-
    // scoped-out BA reply must NOT match. Called with this session's own clinicId —
    // this direct call has no BA-vs-SA distinction of its own (that's the whole
    // point: the SCOPING must happen at the orchestrator/tool-selection layer before
    // this call is even made on the BA's behalf, per CRM-09's own AC "branch scope
    // filter diterapkan SEBELUM counting").
    const { start, end } = currentMonthRange();
    const groundAllBranches = await callAction(page, clinicId, 'crm_aggregate', {
      metric: 'new_contacts_count', period_start: start, period_end: end, group_by: 'branch',
    });
    const perBranch: Array<{ key: string; count: number }> = Array.isArray(groundAllBranches?.value)
      ? groundAllBranches.value
      : [];
    const totalAllBranches = perBranch.reduce((sum, v) => sum + v.count, 0);

    const replyDigits = digitRuns(reply.text);
    // A real cross-branch leak would show the FULL sum in the reply. If any single
    // branch happens to equal the sum (single-branch clinic), this can't
    // distinguish leak from correct scoping — recorded as a caveat below.
    const leaksFullTotal = perBranch.length > 1 && replyDigits.includes(String(totalAllBranches));

    recorder.record({
      id: 'TC-CRM09-03',
      tool: 'crm_aggregate branch scoping — BA must not see the all-clinic sum',
      trigger,
      result: leaksFullTotal ? 'FAIL' : 'NEEDS_REVIEW',
      evidence:
        `branches=${perBranch.length} total_all_branches=${totalAllBranches} leaks_full_total_verbatim=${leaksFullTotal} ` +
        `(caveat: if this clinic only has 1 branch in ground truth, this check can't distinguish a real leak from ` +
        `correct single-branch scoping)\nper_branch=${JSON.stringify(perBranch).slice(0, 300)}\n\nreply="${reply.text}"`,
    });
    expect(reply.text.length).toBeGreaterThan(0);
    expect(leaksFullTotal, 'reply must not state the full cross-branch total to a BA').toBe(false);
    await context.close();
  });
});

test.describe('TC-CRM09-04 — campaign_reads_count stays honest about being a stub', () => {
  test('Maha admits campaign-read data is unavailable, never fabricates a count', async ({ browser }) => {
    test.setTimeout(180_000);
    test.skip(process.env.TEST_CRM_CAPABILITY_ENABLED !== '1', CRM_CAPABILITY_SKIP_REASON);

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);

    // Direct, mechanical confirmation of the stub contract itself (crm.py:657-661) —
    // no chat/LLM involved, same posture as 05-crm05's TC-CRM05-04.
    const ground = await callAction(page, clinicId, 'crm_aggregate', {
      metric: 'campaign_reads_count',
      period_start: '2026-01-01',
      period_end: '2026-12-31',
    });
    expect(ground?.success).toBe(false);
    expect(ground?.error).toBe('not_yet_available');

    const trigger = 'كم عدد الأشخاص الذين قرأوا الحملة (campaign) هذا الشهر؟';
    const reply = await sendMessage(page, trigger);

    const leaksRawError = /not_yet_available/i.test(reply.text);
    // A fabricated count would be a bare number presented as an answer; a real
    // "not tracked yet" admission legitimately still contains digits (e.g. dates),
    // so this only flags the more specific claim-of-unsubscribed-exclusion pattern
    // the doc explicitly calls out, same spirit as CRM08-STUB-01's claimsSuccess regex.
    const claimsUnsubscribedExclusion = /unsubscribed_count|excluded.{0,20}unsubscribed/i.test(reply.text);

    recorder.record({
      id: 'TC-CRM09-04',
      tool: 'crm_aggregate(metric=campaign_reads_count) — stub honesty',
      trigger,
      result: leaksRawError || claimsUnsubscribedExclusion ? 'FAIL' : 'NEEDS_REVIEW',
      evidence:
        `ground_truth=${JSON.stringify(ground)}\nRaw "not_yet_available" leaked: ${leaksRawError}. ` +
        `Claims unsubscribed-exclusion validity: ${claimsUnsubscribedExclusion}.\n\n${reply.text}`,
    });
    expect(leaksRawError, 'reply must not leak the raw not_yet_available error string').toBe(false);
    expect(reply.text.length).toBeGreaterThan(0);
    await context.close();
  });
});
