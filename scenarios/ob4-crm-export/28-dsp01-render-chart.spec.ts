import { test, expect } from '@playwright/test';
import { gotoAiInstructionStep, sendMessage } from '../../helpers/maha-chat';
import { ReportRecorder } from '../../helpers/report';
import '../../helpers/ob4-local-guard'; // throws if BASE_URL isn't local — see that file for why

/**
 * Covers DSP-01 (`render_chart`) from QA_TestScript_Phase4_CRM_Export.md,
 * TC-DSP01-01..04.
 *
 * IMPORTANT deviations from the doc, found while building this (2026-09-06, reading
 * inapp_agent/tools/charts.py and its registration directly):
 *
 * 1. `render_chart` does NOT read from `crm_aggregate` at all, despite the doc's own
 *    TC-DSP01-01/02 setup steps saying to run a crm_aggregate query first. It only
 *    accepts a `set_ref` shaped like `crm_search_contacts`'s output (via the SAME
 *    resolve_segment_criteria() resolver Agent Segments/CRM-01 use) — confirmed by
 *    charts.py's own docstring ("only works on crm_search_contacts-shaped set_refs")
 *    and by crm_aggregate()'s return shape (crm.py:754, `{success, value,
 *    definition_applied, period_summary}` — no `set_ref` key at all). Triggers below
 *    are built around crm_search_contacts (via its real filters:
 *    last_visit_before/after, hasnt_booked_since, booking_status, service, doctor),
 *    NOT "leads per month" aggregate phrasing the original doc used.
 * 2. `group_by` only supports "consent_state" or "month" (bucketing `last_visit`) —
 *    matches the task brief's own note, confirmed directly in charts.py's
 *    `_VALID_GROUP_BYS`. No branch/source grouping exists.
 * 3. The chat event only ever carries `{success, chart_id, rendered}` — never the
 *    actual labels/values (by design, per AC#1 "data never round-trips through the
 *    LLM"). The frontend (`public/js/facility/ai-instruction.js`) fetches the real
 *    chart_type/labels/values separately from `GET /customer/my-clinic/fo/chart/
 *    {chartId}` and renders into `<canvas id="fo-chart-{chartId}">` inside a
 *    `.fo-chart-card` element. Both the DOM (card appeared / didn't) and that Laravel
 *    endpoint (exact chart_type/labels, session-authenticated) are used below as
 *    mechanical, LLM-independent verification — much stronger than trusting chat
 *    reply wording for something that structurally never reaches the reply anyway.
 *
 * Every real TC pairs a realistic Arabic chat trigger (search, then "render as
 * <view>") with a direct callAction() proof that calls crm_search_contacts then
 * render_chart back-to-back, bypassing the LLM entirely — set_refs are persisted in
 * `agent_set_refs`, keyed by clinic_id with a 30-minute TTL, not by chat session, so
 * this bypass is fully valid (same mechanism 05-crm05/EXP tests already rely on).
 *
 * Capability gating: DSP-01 needs BOTH `crm` (to search contacts at all) AND `charts`
 * (to render) enabled for the test clinic — TEST_CRM_CAPABILITY_ENABLED=1 AND
 * TEST_CHARTS_CAPABILITY_ENABLED=1.
 */

const recorder = new ReportRecorder('OB4 DSP-01 Render Chart');
test.afterAll(async () => {
  await recorder.writeTo('reports');
});

const CHARTS_SKIP_REASON =
  'Set TEST_CRM_CAPABILITY_ENABLED=1 AND TEST_CHARTS_CAPABILITY_ENABLED=1 only after manually enabling ' +
  '"phase4Capabilities": {"crm": "*", "charts": "*"} (or this test clinic\'s id, for both keys) in your ' +
  'LOCAL reporty-onboard-phase3 config.json and restarting app.py. DSP-01 needs `crm` too because ' +
  'render_chart only ever consumes a crm_search_contacts-shaped set_ref.';

function capabilityGate() {
  test.skip(
    process.env.TEST_CRM_CAPABILITY_ENABLED !== '1' || process.env.TEST_CHARTS_CAPABILITY_ENABLED !== '1',
    CHARTS_SKIP_REASON
  );
}

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
      session_id: `qa-dsp01-${action}-${Math.floor(Math.random() * 1e9)}`,
      branch_id: opts.branchId,
    },
  });
  return resp.json();
}

/** Reads the Laravel-side chart data endpoint the real frontend uses — session-authenticated. */
async function fetchChartData(page: import('@playwright/test').Page, chartId: string) {
  const resp = await page.request.get(`/customer/my-clinic/fo/chart/${chartId}`);
  return resp.json();
}

async function chartCardCount(page: import('@playwright/test').Page): Promise<number> {
  return page.locator('.fo-chart-card').count();
}

/** Extracts the chart_id from the most recently appended `.fo-chart-card canvas` element's id. */
async function latestChartId(page: import('@playwright/test').Page): Promise<string | null> {
  const canvases = page.locator('.fo-chart-card canvas');
  const count = await canvases.count();
  if (count === 0) return null;
  const id = await canvases.nth(count - 1).getAttribute('id');
  return id ? id.replace(/^fo-chart-/, '') : null;
}

test.describe('TC-DSP01-01 — bar chart, group_by=month', () => {
  test('backend proof: crm_search_contacts set_ref renders a real bar chart', async ({ browser }) => {
    test.setTimeout(60_000);
    capabilityGate();

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);

    const search = await callAction(page, clinicId, 'crm_search_contacts', {
      hasnt_booked_since: '2026-06-01',
      limit: 500,
    });
    expect(search?.data?.set_ref, 'crm_search_contacts must return a set_ref to chart from').toBeTruthy();

    const chart = await callAction(page, clinicId, 'render_chart', {
      set_ref: search.data.set_ref,
      view: 'bar',
      group_by: 'month',
    });
    expect(chart?.success, 'render_chart must succeed for a bar chart').toBe(true);
    expect(chart?.data?.rendered).toBe(true);

    const chartData = await fetchChartData(page, chart.data.chart_id);

    recorder.record({
      id: 'TC-DSP01-01-BACKEND',
      tool: 'crm_search_contacts → render_chart(view=bar, group_by=month) — direct calls, bypasses the LLM',
      trigger: '[direct action, not chat] crm_search_contacts(hasnt_booked_since=2026-06-01) → render_chart(bar, month)',
      result: chartData?.success && chartData?.chart_type === 'bar' && Array.isArray(chartData?.labels) ? 'PASS' : 'FAIL',
      evidence: JSON.stringify({ chart, chartData }).slice(0, 700),
    });
    expect(chartData?.chart_type, 'foChartData must report chart_type=bar').toBe('bar');
    await context.close();
  });

  test('chat: search then ask for a bar chart, a real chart widget appears', async ({ browser }) => {
    test.setTimeout(180_000);
    capabilityGate();

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);

    await sendMessage(page, 'أرني جهات الاتصال التي لم يتم حجز موعد لهم منذ 2026-06-01');
    const before = await chartCardCount(page);
    const reply = await sendMessage(page, 'اعرضي هذه النتائج على شكل مخطط أعمدة حسب الشهر');
    const after = await chartCardCount(page);
    const cardAppeared = after > before;
    const chartId = cardAppeared ? await latestChartId(page) : null;
    const chartData = chartId ? await fetchChartData(page, chartId) : null;

    recorder.record({
      id: 'TC-DSP01-01',
      tool: 'render_chart via real chat — verified via DOM (.fo-chart-card) + GET /fo/chart/{id}',
      trigger: 'اعرضي هذه النتائج على شكل مخطط أعمدة حسب الشهر',
      result: cardAppeared && chartData?.success ? 'PASS' : 'FAIL',
      evidence: `reply="${reply.text}"\ncard_appeared=${cardAppeared} chart_id=${chartId} ${JSON.stringify(chartData)}`,
    });
    expect(cardAppeared, 'a chart widget (.fo-chart-card) must actually appear in the chat').toBe(true);
    await context.close();
  });
});

test.describe('TC-DSP01-02 — line chart from the same monthly-trend data', () => {
  test('backend proof: same set_ref, view=line', async ({ browser }) => {
    test.setTimeout(60_000);
    capabilityGate();

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);

    const search = await callAction(page, clinicId, 'crm_search_contacts', {
      hasnt_booked_since: '2026-06-01',
      limit: 500,
    });
    expect(search?.data?.set_ref).toBeTruthy();

    const chart = await callAction(page, clinicId, 'render_chart', {
      set_ref: search.data.set_ref,
      view: 'line',
      group_by: 'month',
    });
    const chartData = chart?.success ? await fetchChartData(page, chart.data.chart_id) : null;

    recorder.record({
      id: 'TC-DSP01-02-BACKEND',
      tool: 'crm_search_contacts → render_chart(view=line, group_by=month) — direct calls',
      trigger: '[direct action, not chat] render_chart(line, month)',
      result: chartData?.success && chartData?.chart_type === 'line' ? 'PASS' : 'FAIL',
      evidence: JSON.stringify({ chart, chartData }).slice(0, 700),
    });
    expect(chartData?.chart_type).toBe('line');
    await context.close();
  });

  test('chat: search then ask for a line chart, using the same set_ref\'s data as the prior table', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    capabilityGate();

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);

    await sendMessage(page, 'أرني اتجاه عدد جهات الاتصال حسب آخر زيارة خلال آخر 6 أشهر');
    const before = await chartCardCount(page);
    const reply = await sendMessage(page, 'اعرضيها الآن كخط بياني (line chart)');
    const after = await chartCardCount(page);
    const cardAppeared = after > before;
    const chartId = cardAppeared ? await latestChartId(page) : null;
    const chartData = chartId ? await fetchChartData(page, chartId) : null;

    recorder.record({
      id: 'TC-DSP01-02',
      tool: 'render_chart via real chat (line) — verified via DOM + GET /fo/chart/{id}',
      trigger: 'اعرضيها الآن كخط بياني (line chart)',
      result: cardAppeared && chartData?.success ? 'PASS' : 'FAIL',
      evidence: `reply="${reply.text}"\ncard_appeared=${cardAppeared} chart_id=${chartId} ${JSON.stringify(chartData)}`,
    });
    expect(cardAppeared, 'a chart widget must appear for the line-chart request too').toBe(true);
    await context.close();
  });
});

test.describe('TC-DSP01-03 — pie chart rejected above 6 slices (premise-checked)', () => {
  test('backend proof: pie is rejected IF the data actually spans more than 6 month-buckets', async ({ browser }) => {
    test.setTimeout(60_000);
    capabilityGate();

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);

    const search = await callAction(page, clinicId, 'crm_search_contacts', {
      hasnt_booked_since: '2020-01-01', // as broad as this filter allows, to maximize month spread
      limit: 500,
    });
    expect(search?.data?.set_ref).toBeTruthy();

    // Probe the actual slice count via a bar chart first (bar has no cap) — this is
    // the doc's own acknowledged risk (TC-DSP01-03's setup note: ">6 bulan... otomatis
    // >6 slice", assuming the dev data spans that many distinct months). Don't assume;
    // check, same discipline as 07-expected-text-mismatch.spec.ts's drift-premise check.
    const probeChart = await callAction(page, clinicId, 'render_chart', {
      set_ref: search.data.set_ref,
      view: 'bar',
      group_by: 'month',
    });
    const probeData = probeChart?.success ? await fetchChartData(page, probeChart.data.chart_id) : null;
    const sliceCount = Array.isArray(probeData?.labels) ? probeData.labels.length : 0;

    if (sliceCount <= 6) {
      recorder.record({
        id: 'TC-DSP01-03-BACKEND',
        tool: 'render_chart(view=pie) — premise check',
        trigger: '[direct action, not chat] probe via bar chart to count month-buckets before testing pie',
        result: 'NEEDS_REVIEW',
        evidence:
          `Premise did not hold: this test clinic's data only spans ${sliceCount} distinct month-bucket(s) ` +
          `for the broadest available filter (hasnt_booked_since=2020-01-01) — not enough to exercise the ` +
          '>6-slices-for-pie cap. A pie chart with this data is EXPECTED to succeed per the code (no bug) — ' +
          'this environment simply cannot exercise the rejection branch. Re-run once dev data spans more months, ' +
          'or seed >6 months of last_visit spread for this test clinic specifically.',
      });
      test.skip(true, `premise did not hold — only ${sliceCount} month-bucket(s) available, need >6`);
      await context.close();
      return;
    }

    const pieChart = await callAction(page, clinicId, 'render_chart', {
      set_ref: search.data.set_ref,
      view: 'pie',
      group_by: 'month',
    });

    recorder.record({
      id: 'TC-DSP01-03-BACKEND',
      tool: 'render_chart(view=pie, group_by=month) — direct call, premise confirmed',
      trigger: `[direct action, not chat] render_chart(pie, month) with ${sliceCount} month-buckets available`,
      result: pieChart?.error === 'too_many_slices_for_pie' && pieChart?.slice_count === sliceCount ? 'PASS' : 'FAIL',
      evidence: JSON.stringify({ sliceCount, pieChart }),
    });
    expect(pieChart?.error).toBe('too_many_slices_for_pie');
    await context.close();
  });

  test('chat: pie chart request over the same broad data, real chart widget must NOT appear', async ({ browser }) => {
    test.setTimeout(180_000);
    capabilityGate();

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);

    await sendMessage(page, 'أرني جهات الاتصال التي لم يتم حجز موعد لهم منذ 2020-01-01 مصنّفة حسب الشهر');
    const before = await chartCardCount(page);
    const reply = await sendMessage(page, 'تمام، اعرضي هذه البيانات كمخطط دائري (pie chart)');
    const after = await chartCardCount(page);
    const cardAppeared = after > before;

    recorder.record({
      id: 'TC-DSP01-03',
      tool: 'render_chart via real chat (pie, rejection path) — verified via DOM (no new .fo-chart-card)',
      trigger: 'تمام، اعرضي هذه البيانات كمخطط دائري (pie chart)',
      result: cardAppeared ? 'FAIL' : 'NEEDS_REVIEW',
      evidence:
        `reply="${reply.text}"\ncard_appeared=${cardAppeared} — a chart_rendered event only ever appends a card ` +
        `when rendered=true (ai-instruction.js), so if it appeared here the pie either had <=6 slices in THIS ` +
        `session's data (correct behavior, not a bug — see the paired backend-proof test's premise check) or ` +
        `Maha fell back to bar/line on its own without saying so clearly. NEEDS_REVIEW when no card appeared, ` +
        'since that reply\'s wording (fallback offered?) still needs a human read.',
    });
    await context.close();
  });
});

test.describe('TC-DSP01-04 — chart requested with no underlying data', () => {
  test('backend proof: an unknown/expired set_ref is rejected cleanly', async ({ browser }) => {
    test.setTimeout(60_000);
    capabilityGate();

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);

    const chart = await callAction(page, clinicId, 'render_chart', {
      set_ref: '00000000-0000-0000-0000-000000000000',
      view: 'bar',
    });

    recorder.record({
      id: 'TC-DSP01-04-BACKEND',
      tool: 'render_chart(set_ref=<nonexistent>) — direct call, no prior query in scope',
      trigger: '[direct action, not chat] render_chart with a set_ref that was never created',
      result: chart?.error === 'set_ref_not_found_or_expired' && chart?.success !== true ? 'PASS' : 'FAIL',
      evidence: JSON.stringify(chart),
    });
    expect(chart?.error).toBe('set_ref_not_found_or_expired');
    await context.close();
  });

  test('chat: fresh session, chart request with no prior query — no chart widget renders', async ({ browser }) => {
    test.setTimeout(180_000);
    capabilityGate();

    // Deliberately a brand-new context/session — no crm_search_contacts (or anything
    // else) run beforehand, matching the doc's precondition ("mulai sesi chat
    // baru/bersih").
    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);

    const before = await chartCardCount(page);
    const reply = await sendMessage(page, 'اعمل لي رسم بياني من فضلك');
    const after = await chartCardCount(page);
    const cardAppeared = after > before;

    recorder.record({
      id: 'TC-DSP01-04',
      tool: 'render_chart via real chat, no prior data — verified via DOM (no .fo-chart-card)',
      trigger: 'اعمل لي رسم بياني من فضلك',
      result: cardAppeared ? 'FAIL' : 'NEEDS_REVIEW',
      evidence:
        `reply="${reply.text}"\ncard_appeared=${cardAppeared} — expect Maha to ask for a data query first, ` +
        'rather than attempting to chart nothing; wording itself needs a human read.',
    });
    expect(cardAppeared, 'no chart widget should render when there is no underlying data query in scope').toBe(false);
    await context.close();
  });
});

/**
 * TC-DSP01-05 — added 2026-09-14. `render_chart` was extended from
 * `contact_list`-only to 5 chartable kinds (contact_list, appointment_list,
 * staff_list, campaign_list, analytics — confirmed via charts.py's
 * `_GROUP_BY_BY_KIND`/`_DEFAULT_GROUP_BY` dicts, 2026-09-14); the other 4 kinds
 * (instruction_list, contact_card, doctor_card, retargeting_settings) are
 * permanently rejected with `unsupported_data_type_for_chart` (charts.py's
 * fall-through `else` branch) since they have no groupable dimension. Everything
 * above this comment only ever charts `contact_list`.
 *
 * Same minting constraint as this session's EXP-01-KINDS additions
 * (16-exp01-export-search-result.spec.ts): a non-contact_list set_ref is only
 * ever produced by `_inv()`'s side-effect minting inside the real chat
 * orchestrator (maha_inapp_agent.py:3464-3500) — the direct-call
 * `crm_search_contacts → render_chart` "backend proof" pattern the rest of this
 * file uses cannot apply here, since `read_appointments` called via the direct
 * `POST /clinic/<id>/action` endpoint (`registry.invoke()`, bypasses `_inv()`)
 * mints nothing. This test is chat-only, same two-turn shape (list, then "chart
 * this") as TC-DSP01-01/02's own chat sub-tests, with the same DOM +
 * `GET /fo/chart/{id}` verification.
 */
test.describe('TC-DSP01-05 — appointment_list chart, group_by=status (new kind, 2026-09-14)', () => {
  test('chat: list today\'s appointments, then chart them by status — a real chart widget appears', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    capabilityGate();

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);

    const listTrigger = 'أرني مواعيد اليوم';
    const listReply = await sendMessage(page, listTrigger);
    const before = await chartCardCount(page);
    const chartTrigger = 'اعرضي هذه المواعيد كمخطط أعمدة حسب الحالة (status)';
    const chartReply = await sendMessage(page, chartTrigger);
    const after = await chartCardCount(page);
    const cardAppeared = after > before;
    const chartId = cardAppeared ? await latestChartId(page) : null;
    const chartData = chartId ? await fetchChartData(page, chartId) : null;

    recorder.record({
      id: 'TC-DSP01-05',
      tool: 'render_chart(kind=appointment_list, group_by=status) via real chat — verified via DOM + GET /fo/chart/{id}',
      trigger: `${listTrigger} / ${chartTrigger}`,
      result: cardAppeared && chartData?.success ? 'PASS' : 'FAIL',
      evidence:
        `listReply="${listReply.text}"\nchartReply="${chartReply.text}"\n` +
        `card_appeared=${cardAppeared} chart_id=${chartId} ${JSON.stringify(chartData)}\n\n` +
        `[Note] If today's real appointment data is empty, render_chart may still succeed with an empty/flat ` +
        `chart (charts.py has no "no data" special case beyond the set_ref existing) — a card appearing at all, ` +
        `backed by a real chart_type from the Laravel endpoint, is still valid evidence the new kind wires up.`,
    });
    expect(cardAppeared, 'a chart widget must appear for an appointment_list chart request too').toBe(true);
    await context.close();
  });
});
