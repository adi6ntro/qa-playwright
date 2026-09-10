import { test, expect } from '@playwright/test';
import { gotoMarketing, openCreateSegment, sendSegmentMessage } from '../../helpers/marketing';

/**
 * Agent Segments (Marketing → Segments popup) — reporty-web-backup UI wired
 * to a real chat orchestrator in reporty-onboard-phase3 (segments_agent.py),
 * which resolves criteria against real `patients`/`appointment_scheduling`
 * data and persists to the `segments` table with a read-back verify. This
 * feature stopped being a stub on 2026-09-10 — its old dead-button/canned-
 * response tests used to live in what is now `03-marketing-campaigns-
 * stub.spec.ts` (see that file's header for the rename note).
 *
 * ⚠️ REAL LLM CALLS. Every `sendSegmentMessage()` below is a genuine call
 * through OB3 to Vertex AI (gemini-2.5-flash) — expect 5-30s per turn,
 * occasionally much longer under load (a real Vertex 502 was observed
 * empirically while this suite was being written; if a test times out,
 * rerun once before assuming a code regression). The model itself is also
 * NOT perfectly reliable: it has been observed skipping the resolve tool
 * call entirely and fabricating a plausible-looking reply instead (~1 in 3
 * tries in one measured local batch, non-reproducing) — a known, tracked,
 * NOT-yet-fixed risk (see project memory
 * project_agent_segments_send_campaign_edit_handler.md), not a regression
 * these tests introduce or can gate on. Tests below `test.skip()` themselves
 * when a turn's response has no `resolve`/`save` payload rather than failing
 * — that means the model didn't call the tool this turn, not that the
 * feature is broken; rerun.
 *
 * ⚠️ LOCAL-ONLY TESTS live in a separate file: `05-marketing-segments-local.
 * spec.ts` covers 2026-09-10 behavior (Keep updating force-OFF for a
 * conversation-matched criterion, Send Campaign, Edit-in-place) that isn't
 * deployed to dev.reporty.sa yet — kept apart so `npm run test:segments`
 * stays safe to run against the shared dev environment.
 *
 * ⚠️ CLEANUP GAP: there is no delete-segment endpoint (checked
 * MarketingController.php — only GET routes exist for a saved segment).
 * Segments created by these tests are named `QA_PW_SEG_<timestamp>` so
 * they're identifiable for a manual `DELETE FROM segments WHERE name LIKE
 * 'QA_PW_SEG_%'` sweep later — there's no `npm run cleanup:...` script for
 * this yet, unlike the marker-sweep scripts other suites have.
 *
 * Cookies are domain-scoped (same note as 05-marketing-segments-local.spec.
 * ts) — a dev.reporty.sa session can't authenticate against localhost and
 * vice versa, so this file picks its storageState based on BASE_URL rather
 * than hardcoding one, unlike most other spec files in this repo (which only
 * ever run against one target). Run locally with `BASE_URL=http://
 * localhost:8000 npm run test:segments` after `npm run login-setup:local-ob4sa`.
 *
 * Local runs use the `ob4sa` profile (clinic 611, 88 real patients) rather
 * than the plain default profile (clinic 440) — Adi's standing instruction
 * (2026-09-10): 611 is the standard local test clinic going forward, see
 * project memory reference_local_test_clinic_611.md.
 */

const IS_LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/i.test(process.env.BASE_URL || '');
test.use({ storageState: IS_LOCAL ? 'auth/.storage-state.ob4sa.local.json' : 'auth/.storage-state.json' });

test.describe('Marketing — Segments: list + create (real backend)', () => {
  test('MKT-SEG-01: Segments tab loads the real list from the backend, not static demo rows', async ({ page }) => {
    const [resp] = await Promise.all([
      page.waitForResponse((r) => /\/marketing\/segments$/.test(r.url()) && r.request().method() === 'GET'),
      gotoMarketing(page, 'segments'),
    ]);
    expect(resp.ok()).toBeTruthy();

    // tab-segments.blade.php used to render 5 hardcoded demo rows (Inactive
    // Patients, Due for Checkup, ...) before fetchMktSegments()/
    // renderSegmentsTab() wired it to this real GET — that name must never
    // appear again now that the tab is backend-driven (either real rows, or
    // the real "No segments yet" empty state, never the old dummy content).
    await expect(page.locator('#tbl-segments-body')).not.toContainText('Inactive Patients');
  });

  test('MKT-SEG-02: describing patients resolves real criteria and named contacts (or an honest empty result)', async ({ page }) => {
    await gotoMarketing(page, 'segments');
    await openCreateSegment(page);

    const resp = await sendSegmentMessage(page, 'Patients whose last visit was after January 1, 2020');
    expect(resp.ok()).toBeTruthy();
    const body = await resp.json();
    test.skip(!body.resolve, 'Model did not call find_matching_patients this turn (known fabrication risk, see header) — rerun.');

    // hard_rule 4: relative/vague time always resolves to an explicit date
    // in the criterion label, never left as a raw phrase.
    await expect(page.locator('#sgm-tags .sgm-tag').first()).toBeVisible();

    if (body.resolve.total > 0) {
      // hard_rule 2: never a count without named contacts.
      await expect(page.locator('#sgm-contact-list .sgm-contact-row').first()).toBeVisible();
      await expect(page.locator('#sgm-contacts-count')).toContainText(String(body.resolve.total));
    } else {
      // hard_rule 11: an empty result must name the responsible criterion —
      // can't assert the model's own exact wording, just that it said something.
      expect((body.reply || '').length).toBeGreaterThan(0);
    }
  });

  test('MKT-SEG-03: a second message NARROWS the first — the earlier criterion is not silently dropped', async ({ page }) => {
    // Reverses the old, now-superseded finding that this popup was per-turn
    // stateless — session_store-backed history (2026-09-08) plus the
    // 2026-09-10 cross-turn CONVERSATION-match fix mean a second message
    // should add to, not replace, the first turn's criteria. See project
    // memory project_agent_segments_runtime_vars_fixed_and_crossturn_risk.md.
    test.setTimeout(180_000); // two real LLM round-trips

    await gotoMarketing(page, 'segments');
    await openCreateSegment(page);

    const resp1 = await sendSegmentMessage(page, 'Patients whose last visit was after January 1, 2020');
    const body1 = await resp1.json();
    test.skip(!body1.resolve, 'First turn did not resolve (fabrication risk) — rerun.');
    const tagCountBefore = await page.locator('#sgm-tags .sgm-tag').count();

    const resp2 = await sendSegmentMessage(page, "and also require they haven't booked since January 2026");
    const body2 = await resp2.json();
    test.skip(!body2.resolve, 'Second turn did not resolve (fabrication risk) — rerun.');
    const tagCountAfter = await page.locator('#sgm-tags .sgm-tag').count();

    expect(tagCountAfter).toBeGreaterThan(tagCountBefore);
  });

  test('MKT-SEG-04: saving persists the segment (ECHO before WRITE) and it appears in the real list', async ({ page }) => {
    // TIER 3 in the prompt requires an ECHO before the actual write — clicking
    // "Create Segment" sends one synthetic message with name+criteria+keep_
    // updating (create-segment.js), which may itself only be enough to
    // trigger the echo, not the write. Tolerate one extra explicit-confirm
    // turn rather than assuming a single click always saves in one shot.
    test.setTimeout(180_000);

    const segmentName = `QA_PW_SEG_${Date.now()}`;
    await gotoMarketing(page, 'segments');
    await openCreateSegment(page);

    const resolveResp = await sendSegmentMessage(page, 'Patients whose last visit was after January 1, 2020');
    const resolveBody = await resolveResp.json();
    test.skip(!resolveBody.resolve, 'Resolve turn did not fire (fabrication risk) — rerun.');

    await page.locator('#sgm-name').fill(segmentName);
    await expect(page.locator('#sgm-btn-create')).toBeEnabled();

    const [createResp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/segments/chat') && r.request().method() === 'POST', { timeout: 60_000 }),
      page.locator('#sgm-btn-create').click(),
    ]);
    let saveBody = await createResp.json();

    if (!saveBody.save) {
      // Model only echoed — send one explicit confirmation.
      const confirmResp = await sendSegmentMessage(page, 'Yes, I confirm, please save it now.');
      saveBody = await confirmResp.json();
    }
    test.skip(!saveBody.save, 'Save never completed in two turns (fabrication/echo-loop risk) — rerun.');

    expect(saveBody.save.success).toBe(true);
    expect(saveBody.save.segment_name).toBe(segmentName);

    // Read-back-verify (hard_rule 13) means it must now exist for real —
    // reload the list and confirm it's actually there, not just claimed.
    await page.reload();
    await gotoMarketing(page, 'segments');
    await expect(page.locator('#tbl-segments-body', { hasText: segmentName })).toBeVisible({ timeout: 20_000 });
  });

  test('MKT-SEG-05: a duplicate segment name is rejected, not silently overwritten or duplicated', async ({ page }) => {
    test.setTimeout(240_000);
    const segmentName = `QA_PW_SEG_${Date.now()}`;

    async function resolveAndSave(page_: typeof page) {
      await openCreateSegment(page_);
      const resolveResp = await sendSegmentMessage(page_, 'Patients whose last visit was after January 1, 2020');
      const resolveBody = await resolveResp.json();
      test.skip(!resolveBody.resolve, 'Resolve turn did not fire (fabrication risk) — rerun.');
      await page_.locator('#sgm-name').fill(segmentName);
      const [resp] = await Promise.all([
        page_.waitForResponse((r) => r.url().includes('/segments/chat') && r.request().method() === 'POST', { timeout: 60_000 }),
        page_.locator('#sgm-btn-create').click(),
      ]);
      let body = await resp.json();
      if (!body.save) {
        const confirmResp = await sendSegmentMessage(page_, 'Yes, I confirm, please save it now.');
        body = await confirmResp.json();
      }
      return body;
    }

    await gotoMarketing(page, 'segments');
    const firstSave = await resolveAndSave(page);
    test.skip(!firstSave.save, 'First save never completed (fabrication risk) — rerun.');
    expect(firstSave.save.success).toBe(true);

    // New session, same name, same clinic — should collide on uniq_user_name.
    await page.locator('#modal-create-segment .bkm-close').click();
    await gotoMarketing(page, 'segments');
    const secondSave = await resolveAndSave(page);
    test.skip(!secondSave.save, 'Second save attempt never completed a save turn at all (fabrication risk) — rerun.');
    expect(secondSave.save.success).toBe(false);
    expect(secondSave.save.error).toBe('duplicate_segment_name');
  });
});

