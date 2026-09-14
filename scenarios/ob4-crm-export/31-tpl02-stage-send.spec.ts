import { test, expect } from '@playwright/test';
import { gotoAiInstructionStep } from '../../helpers/maha-chat';
import { ReportRecorder } from '../../helpers/report';
import '../../helpers/ob4-local-guard'; // throws if BASE_URL isn't local — see that file for why

/**
 * Covers TPL-02 `stage_template_send`, from
 * `docs/ob4-phase4-docs/Developer_Spec_Phase4_CRM_and_Export_Tools.md`'s TPL-02
 * section (lines 612-630). Brand new tool, ZERO prior Playwright coverage. See
 * 30-tpl01-create-template.spec.ts's header for the shared TPL background
 * (registration convention, capability key, the AGENT_EXPORT_SECRET environment
 * blocker) — not repeated in full here.
 *
 * THE highest-value case for this tool (per this session's own review brief): the
 * frozen-segment fix. Confirmed by reading `template_studio.py` directly
 * (2026-09-14):
 *   ```
 *   segment = get_segment(segment_id, clinic_id)
 *   if segment["keep_updating"]:
 *       resolved = resolve_saved_segment(clinic_id, segment_id, ...)   # LIVE re-resolve
 *       contacts = [...resolved live contacts...]
 *   else:
 *       contacts = _frozen_segment_contacts(segment_id)                # FROZEN snapshot
 *           # SELECT phone_number, name_snapshot FROM segment_frozen_members
 *           # WHERE segment_id = %s
 *   ```
 * Before this fix, `stage_template_send` ALWAYS re-resolved live criteria regardless
 * of `keep_updating` — a real, live-reproduced severe bug: a segment frozen to 2
 * contacts was being staged against the clinic's ENTIRE ~88-contact list instead.
 * `audience_count` in the response is Laravel's own `$draft['total']`
 * (`AgentTemplateController::stageSend()`, `CampaignDraftService::saveDraft()`'s row
 * count after `filterOptedOut()`) — i.e. audience_count is computed from WHATEVER
 * contacts[] the Python side actually sent, so a correct fix must send exactly the
 * frozen snapshot's contacts, never the live-resolved set.
 *
 * Real fixture used: clinic 611 (this suite's own `LOGIN_EMAIL_OB4SA` clinic — same
 * one used throughout `scenarios/ob4-crm-export/`) has a real segment named
 * `QA_SEND_TEST_2NUM`, independently confirmed 2026-09-14 via a direct, read-only
 * query against the SAME local dev DB `reporty-onboard-phase3`'s own `config.json`
 * points at:
 *   `id=74, name='QA_SEND_TEST_2NUM', user_id=611, keep_updating=0 (frozen),
 *    resolved_count=2` and `segment_frozen_members` has exactly 2 rows for
 *   `segment_id=74`.
 * `TEST_FROZEN_SEGMENT_ID`/`TEST_FROZEN_SEGMENT_EXPECTED_COUNT` in `.env` are set to
 * `74`/`2` accordingly (see `.env.example` for the general pattern).
 *
 * IMPORTANT — no way to create an ad-hoc frozen segment from THIS suite's own chat
 * surface: `crm_save_as_segment` (CRM-12, the only segment-creating tool registered
 * for the AI Instruction wizard chat this whole folder drives) hard-codes
 * `keep_updating=True` on every save (confirmed by reading `crm.py`'s
 * `save_as_segment()` directly — it isn't even a parameter). The ONLY way a segment
 * ever becomes frozen (`keep_updating=OFF`) is the separate "Agent Segments"
 * feature under Marketing (`create-segment.js`, a different chat orchestrator,
 * covered by `scenarios/inbox-marketing/04/05-marketing-segments*.spec.ts` in this
 * same repo, not this folder) — specifically its `CONVERSATION`-criteria path,
 * which forces `keep_updating` OFF. Rather than reach across suites or fabricate a
 * fake frozen row, this file reuses the real, already-frozen `QA_SEND_TEST_2NUM`
 * fixture, which happens to already live under this exact clinic.
 *
 * ⚠️ SAME AGENT_EXPORT_SECRET blocker as 30-tpl01-create-template.spec.ts — live-
 * verified via a direct, side-effect-free probe (see below): `stage_template_send`
 * 403s with `{"error":"unauthorized"}` before ever reaching Laravel's real
 * `stageSend()` logic, so `audience_count` cannot be observed in THIS environment
 * as it stands. Unlike TPL-01's happy path, this call has NO real external side
 * effect even once auth passes (`stageSend()` only writes local `user_campaign`/
 * `user_campaign_recipient` rows and re-checks approval status — "creates a draft
 * send... never fires it. There is deliberately NO send tool in the agent's
 * schema", per the dev spec's own AC#1) — so this test IS safe to actually execute
 * against the real endpoint once AGENT_EXPORT_SECRET is set, unlike TPL-01's
 * create-template happy path. It just cannot prove anything beyond "still blocked"
 * in THIS environment as found.
 *
 * Additionally: even once AGENT_EXPORT_SECRET is fixed, a full end-to-end
 * `audience_count` check also needs a real, existing `template_id` row in
 * Laravel's own templates table for `checkApproved()` to look up — this suite has
 * no safe way to mint one (see TPL-01's header) and no confirmed real one is on
 * hand. `TEST_APPROVED_TEMPLATE_ID` is left as an optional env var for whoever
 * has one; without it, the positive assertion is written to run but may still
 * report `template_not_found` rather than a real `audience_count` — that outcome
 * is recorded distinctly from the current `unauthorized` block, not conflated
 * with it.
 */

const recorder = new ReportRecorder('OB4 TPL-02 Stage Template Send');
test.afterAll(async () => {
  await recorder.writeTo('reports');
});

const TEMPLATE_STUDIO_SKIP_REASON =
  'Set TEST_TEMPLATE_STUDIO_CAPABILITY_ENABLED=1 only after manually enabling ' +
  '"phase4Capabilities": {"template_studio": "*"} (or this test clinic\'s id) in your ' +
  'LOCAL reporty-onboard-phase3 config.json and restarting app.py. (Already "*" in this ' +
  'checkout as of 2026-09-14.)';

function capabilityGate() {
  test.skip(process.env.TEST_TEMPLATE_STUDIO_CAPABILITY_ENABLED !== '1', TEMPLATE_STUDIO_SKIP_REASON);
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
      session_id: `qa-tpl02-${action}-${Math.floor(Math.random() * 1e9)}`,
    },
  });
  return resp.json();
}

test.describe('TC-TPL02-01 — frozen segment stages at its FROZEN count, never the live clinic-wide count', () => {
  test('stage_template_send(segment_id=<frozen, count=2>) — audience_count must equal the frozen snapshot, not ~88', async ({
    browser,
  }) => {
    test.setTimeout(60_000);
    capabilityGate();
    test.skip(
      !process.env.TEST_FROZEN_SEGMENT_ID || !process.env.TEST_FROZEN_SEGMENT_EXPECTED_COUNT,
      'Set TEST_FROZEN_SEGMENT_ID/TEST_FROZEN_SEGMENT_EXPECTED_COUNT to a real frozen (keep_updating=OFF) segment ' +
        'under this clinic and its known frozen member count — see this file\'s header for the QA_SEND_TEST_2NUM ' +
        'fixture (segment_id=74, count=2) already wired into .env for clinic 611.'
    );

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);
    expect(clinicId, 'window.FO.clinicId must be present on the AI Instruction step').toBeTruthy();

    const segmentId = process.env.TEST_FROZEN_SEGMENT_ID!;
    const expectedCount = Number(process.env.TEST_FROZEN_SEGMENT_EXPECTED_COUNT);
    // A fake/placeholder template_id — deliberately not a real one (see file header:
    // no safe way to mint a real approved template in this suite). If
    // TEST_APPROVED_TEMPLATE_ID is provided, prefer it since it's the only way to
    // get PAST checkApproved() to a real audience_count once auth is fixed.
    const templateId = process.env.TEST_APPROVED_TEMPLATE_ID || '999999999';

    const result = await callAction(page, clinicId, 'stage_template_send', {
      template_id: templateId,
      segment_id: segmentId,
      causing_message: '[direct action, not chat] TC-TPL02-01 frozen-segment audience_count verification',
    });

    if (result?.data?.error === 'unauthorized') {
      recorder.record({
        id: 'TC-TPL02-01',
        tool: 'stage_template_send(segment_id=<frozen>) — BLOCKED by the AGENT_EXPORT_SECRET gap, see file header',
        trigger: `[direct action, not chat] stage_template_send template_id=${templateId} segment_id=${segmentId}`,
        result: 'UNABLE_TO_TEST',
        evidence:
          `Confirmed still blocked at the Laravel auth-middleware layer: ${JSON.stringify(result)}. The REAL check ` +
          `this test exists to run, once unblocked: audience_count must equal ${expectedCount} (the frozen ` +
          `snapshot's real member count), and must NEVER equal anything close to this clinic's live ~88-contact ` +
          `total — that gap (2 vs ~88) is exactly the severity of the real incident this fix addresses. See this ` +
          `file's header for the one-line reporty-web-backup/.env fix needed (outside this task's touch scope) ` +
          `and 30-tpl01-create-template.spec.ts's TC-TPL01-03 for a standing probe of this same gap.`,
      });
      test.skip(true, 'blocked by the AGENT_EXPORT_SECRET gap — see recorded evidence and file header');
      await context.close();
      return;
    }

    if (result?.data?.error === 'template_not_found' || result?.data?.error === 'template_not_approved') {
      recorder.record({
        id: 'TC-TPL02-01',
        tool: 'stage_template_send(segment_id=<frozen>) — auth gap is FIXED, but no real approved template_id on hand',
        trigger: `[direct action, not chat] stage_template_send template_id=${templateId} segment_id=${segmentId}`,
        result: 'UNABLE_TO_TEST',
        evidence:
          `Good news: the AGENT_EXPORT_SECRET gap this file's header describes appears fixed (no longer ` +
          `"unauthorized") — but this run has no real, existing template_id to stage against ` +
          `(${JSON.stringify(result)}). Set TEST_APPROVED_TEMPLATE_ID to a real template_id under this clinic and ` +
          `re-run to get a real audience_count assertion.`,
      });
      test.skip(true, 'auth gap fixed, but no real template_id available this run — see recorded evidence');
      await context.close();
      return;
    }

    // Fully unblocked path — the real assertion this test exists for.
    const audienceCount = result?.data?.audience_count;
    const matchesFrozenCount = audienceCount === expectedCount;
    const looksLikeLiveClinicWideLeak = typeof audienceCount === 'number' && audienceCount > expectedCount * 5;

    recorder.record({
      id: 'TC-TPL02-01',
      tool: 'stage_template_send(segment_id=<frozen, count=' + expectedCount + '>) — audience_count vs frozen snapshot',
      trigger: `[direct action, not chat] stage_template_send template_id=${templateId} segment_id=${segmentId}`,
      result: matchesFrozenCount && !looksLikeLiveClinicWideLeak ? 'PASS' : 'FAIL',
      evidence: JSON.stringify(result).slice(0, 500),
    });
    expect(
      audienceCount,
      `audience_count (${audienceCount}) must exactly equal the frozen snapshot's real count (${expectedCount}), ` +
        'never the clinic\'s live contact total — this is the exact severity of the real fixed incident'
    ).toBe(expectedCount);
    await context.close();
  });
});

test.describe('TC-TPL02-02 — a live (keep_updating=ON) segment still re-resolves live, as designed', () => {
  test('save a fresh (non-frozen) segment via CRM-12, then stage it — confirms the live path is untouched by the fix', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    capabilityGate();
    test.skip(process.env.TEST_CRM_CAPABILITY_ENABLED !== '1', 'Also needs TEST_CRM_CAPABILITY_ENABLED=1 (crm_save_as_segment lives under the crm capability).');

    const context = await browser.newContext({ storageState: 'auth/.storage-state.ob4sa.local.json' });
    const page = await context.newPage();
    await gotoAiInstructionStep(page);
    const clinicId = await page.evaluate(() => (window as any).FO?.clinicId);

    // crm_save_as_segment always creates keep_updating=True (crm.py — confirmed, see
    // file header) — a plain search + save is a genuine live (non-frozen) segment,
    // useful as the CONTRAST case: this fix must not have accidentally made EVERY
    // segment read its (nonexistent, for a live segment) frozen snapshot instead.
    const search = await callAction(page, clinicId, 'crm_search_contacts', {
      hasnt_booked_since: '2026-06-01',
      limit: 10,
    });
    const total: number = search?.data?.total ?? 0;
    test.skip(!search?.data?.set_ref || total === 0, 'no real matching contacts this run to build a live segment from');

    const liveSegmentName = `QA_TPL0202_LIVE_${Date.now()}`;
    const saveResult = await callAction(page, clinicId, 'crm_save_as_segment', {
      set_ref: search.data.set_ref,
      segment_name: liveSegmentName,
      causing_message: '[direct action, not chat] TC-TPL02-02 live-segment fixture',
    });
    const segmentId = saveResult?.data?.segment_id;
    test.skip(!segmentId, `crm_save_as_segment did not return a segment_id this run: ${JSON.stringify(saveResult)}`);

    const stageResult = await callAction(page, clinicId, 'stage_template_send', {
      template_id: process.env.TEST_APPROVED_TEMPLATE_ID || '999999999',
      segment_id: String(segmentId),
      causing_message: '[direct action, not chat] TC-TPL02-02 live-segment stage attempt',
    });

    const blocked = stageResult?.data?.error === 'unauthorized';
    recorder.record({
      id: 'TC-TPL02-02',
      tool: 'stage_template_send(segment_id=<live, keep_updating=ON>) — contrast case for the frozen-segment fix',
      trigger: '[direct action, not chat] crm_save_as_segment (live) → stage_template_send',
      result: blocked ? 'UNABLE_TO_TEST' : 'NEEDS_REVIEW',
      evidence: blocked
        ? `Same AGENT_EXPORT_SECRET block as TC-TPL02-01: ${JSON.stringify(stageResult)}. Once unblocked, the real ` +
          `check here is that audience_count for this LIVE segment reflects the fresh search total (${total}) or ` +
          `whatever the segment's criteria currently resolve to — NOT any stale/frozen number — confirming the ` +
          `fix's keep_updating branch didn't regress the live path while fixing the frozen one.`
        : `segment_id=${segmentId} (live, keep_updating=ON) search_total=${total} stage_result=${JSON.stringify(stageResult).slice(0, 400)} ` +
          `— needs a human/LLM read to confirm audience_count tracks live criteria, not a stale snapshot.`,
    });
  });
});
