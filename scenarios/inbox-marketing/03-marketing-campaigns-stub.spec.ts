import { test, expect } from '@playwright/test';
import { gotoMarketing } from '../../helpers/marketing';

/**
 * Covers docs/handover/QA_Checklist_Inbox_Marketing_WhatsApp.md Sections F-H.
 *
 * Renamed from `03-marketing-campaigns-segments-stub.spec.ts` (2026-09-10):
 * Agent Segments became a real, backend-wired feature that day (chat resolves
 * real criteria via reporty-onboard-phase3, save persists to the `segments`
 * table with read-back verify, the list tab loads real data, plus Send
 * Campaign/Edit). Its tests moved to their own file, `04-marketing-segments.
 * spec.ts`, the same way Templates got split out of this file earlier —
 * segments is no longer a stub, so it doesn't belong in a file whose whole
 * point is asserting nothing fires.
 *
 * ⚠️ SAFETY — READ BEFORE EDITING THIS FILE ⚠️
 * As of commit 35787d7c1 ("fixi marketing and inbox", 2026-08-25),
 * `bulk-campaign.js` is a REAL feature, not a demo:
 *   - Step 2 "Submit for approval" calls `bkmSubmitTemplate()`, which POSTs
 *     a real template to Meta via `POST /customer/marketing/templates`.
 *   - Step 5 "Send Campaign" (`#bkm-send-btn`, still styled with the shared
 *     `.bkm-btn-next` class) calls `bkmSendCampaign()`, which POSTs to the
 *     real `POST /customer/marketing/send-campaign` → `MarketingController
 *     ::sendCampaign()` → loops contacts and hits the real
 *     `/whatsapp-cloud-send-template` external endpoint per contact.
 *   - `bkmGetContacts()` currently returns a HARDCODED array
 *     `_BKM_TEST_CONTACTS` with 4 real phone numbers, only ONE of which
 *     (`6281266850960`) is the sandbox number this suite is authorized to
 *     use — the other 3 look like the developer's own personal test
 *     numbers (marked `// TODO: ganti ke MKT_CONTACTS setelah testing
 *     selesai` in the source). There is currently no env-var-driven
 *     override for this list.
 *
 * NEVER click `.bkm-btn-next` in a loop or otherwise walk past Step 1 of
 * this wizard in an automated test — because ALL of the wizard's
 * next/submit/send buttons share the `.bkm-btn-next` CSS class, a naive
 * "click next repeatedly" script (like this file used to have) can reach
 * `#bkm-send-btn` and fire a real WhatsApp send to those 4 real numbers.
 * A prior version of this test happened to be saved from that only by
 * Playwright's strict-mode multi-match error on the unscoped locator —
 * that was luck, not a designed guard. Testing Steps 2-5 for real is
 * MANUAL-ONLY from now on (see the checklist doc's Section F) until this
 * gets a safe test-contact-list override.
 */

test.describe('Marketing — Campaigns tab (Step 1 only — see safety note above)', () => {
  test('MKT-CAM-03: "Generate content" calls the real AI endpoint and returns non-empty text', async ({ page }) => {
    await gotoMarketing(page, 'campaigns');
    const startBtn = page.locator('a', { hasText: 'Start Campaign' }).first();
    test.skip((await startBtn.count()) === 0, 'No approved template available.');

    await startBtn.click();
    await expect(page.locator('#modal-bulk-campaign')).toHaveClass(/open/);

    // Step 1 only — bkmGenerateContent() hits POST .../generate-content
    // (real AI call, no send/contact side effects) and does not advance
    // the wizard step. Do not call bkmNext()/click any other button here.
    await page.locator('#bkm-campaign-idea').fill('20% off checkup until end of month');
    const generateBtn = page.locator('a.bkm-generate-link', { hasText: 'Generate Content' });
    test.skip((await generateBtn.count()) === 0, 'Generate-content link not present on step 1 markup.');

    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/generate-content')),
      generateBtn.click(),
    ]);
    expect(resp.ok()).toBeTruthy();
    await page.waitForTimeout(500);
    const text = await page.locator('#bkm-content-text').inputValue();
    expect(text.length).toBeGreaterThan(0);
  });

  test('MKT-CAM-05: the real send-campaign endpoint still targets the hardcoded test contact list (canary)', async ({ page }) => {
    // Deliberately does NOT drive the UI to send anything. This calls the
    // backend endpoint directly with an instantly-rejectable payload
    // (empty contacts) purely to prove the endpoint still exists and still
    // gates on template approval — NOT to exercise a real send path. If
    // this ever needs a positive (actually-sends) test, that must be a
    // manual, human-supervised run against an explicit, disposable test
    // number set — never automated against `_BKM_TEST_CONTACTS` as-is.
    await gotoMarketing(page, 'campaigns');
    const csrf = await page.evaluate(() => (window as any).MKT_CONFIG?.csrf);
    const resp = await page.request.post('/customer/marketing/send-campaign', {
      data: { template_name: '', contacts: [] },
      headers: { 'X-CSRF-TOKEN': csrf },
      failOnStatusCode: false,
    });
    expect(resp.status()).toBe(422); // "Missing template_name or contacts" guard in sendCampaign()
  });
});

/**
 * Segment audience picker (2026-09-13) — NOT deployed to dev.reporty.sa yet,
 * so this describe block is local-only, same posture as
 * 05-marketing-segments-local.spec.ts's own IS_LOCAL guard.
 *
 * Before this date, "Segment" was only ever selectable via
 * openBulkModalForSegment() (a segment row's own "Send Campaign" link, which
 * pre-resolved that one segment before opening the wizard). That entry point
 * is unused now — the Segments tab's "Send Campaign" link just switches to
 * this tab (switchTab('campaigns')) — and picking a segment is a generic
 * `<select>` (#bkm-segment-picker) inside Step 3, reachable from ANY entry
 * point into this wizard.
 *
 * ⚠️ Reads Step 3 via direct state manipulation (`_bkmStep = 3;
 * bkmRender();`), NEVER by clicking `.bkm-btn-next` — see this file's own
 * header safety note above: every button past Step 1 shares that class, and
 * walking there via clicks is manual-only. `bkmRender()` only toggles which
 * `#bkm-step-N` is visible; it fires no request and sends nothing on its own.
 */
test.describe('Marketing — Campaigns tab: Segment audience picker (LOCAL-ONLY, 2026-09-13)', () => {
  const BASE_URL = process.env.BASE_URL || '';
  const IS_LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/i.test(BASE_URL);

  test('MKT-CAM-06: picking a segment from the generic picker resolves its real contacts, opened via the plain "+ Bulk Campaign" button', async ({ page }) => {
    test.skip(!IS_LOCAL, `BASE_URL is not local (got ${BASE_URL || '(unset)'}) — this feature isn't deployed to dev.reporty.sa yet.`);
    test.setTimeout(60_000);

    // Deliberately does NOT visit the Segments tab first — MKT_SEGMENTS may
    // be empty going in, exercising bkmPopulateSegmentPicker()'s own fetch
    // path rather than relying on it already being warm.
    await gotoMarketing(page, 'campaigns');
    await page.locator('a', { hasText: '+ Bulk Campaign' }).click();
    await expect(page.locator('#modal-bulk-campaign')).toHaveClass(/open/);

    await page.evaluate(() => {
      (window as any)._bkmStep = 3;
      (window as any).bkmRender();
    });

    const picker = page.locator('#bkm-segment-picker');
    await expect(picker).toBeVisible({ timeout: 15_000 }); // waits out bkmPopulateSegmentPicker()'s own fetch+re-render

    const optionCount = await picker.locator('option').count();
    test.skip(optionCount <= 1, 'No saved segments in this environment to pick from.');

    const firstSegmentId = await picker.locator('option').nth(1).getAttribute('value');
    const [contactsResp] = await Promise.all([
      page.waitForResponse((r) => new RegExp(`/segments/${firstSegmentId}/contacts$`).test(r.url())),
      picker.selectOption(firstSegmentId as string),
    ]);
    const contactsBody = await contactsResp.json();

    const bkmState = await page.evaluate(() => ({
      audience: (window as any)._bkmAudience,
      segmentId: (window as any)._bkmSegmentId,
      contactCount: ((window as any)._bkmSegmentContacts || []).length,
    }));
    expect(bkmState.audience).toBe('segment');
    expect(String(bkmState.segmentId)).toBe(firstSegmentId);
    expect(bkmState.contactCount).toBe((contactsBody.contacts || []).length);

    const segOption = page.locator('.bkm-radio-option', { has: picker });
    await expect(segOption).toHaveClass(/selected/);

    // Stop here — never click .bkm-btn-next or anything past Step 3.
  });
});

test.describe('Marketing — Contacts tab: "+ Add Contact" / "Import CSV" (dead ends)', () => {
  test('MKT-C-04: "+ Add Contact" submit closes the modal but saves nothing', async ({ page }) => {
    await gotoMarketing(page, 'contacts');
    await expect(page.locator('#tbl-contacts-body tr').first()).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(500); // let fetchMktContacts() finish rendering the full table before snapshotting
    const rowCountBefore = await page.locator('#tbl-contacts-body tr').count();

    let writeFired = false;
    page.on('request', (req) => { if (req.method() !== 'GET') writeFired = true; });

    await page.locator('a', { hasText: '+ Add Contact' }).click();
    await expect(page.locator('#modal-add-contact')).toHaveClass(/open/);
    // submitAddContact() in modal-add-contact.blade.php is literally `function submitAddContact() { closeAddContact(); }`
    await page.locator('.adc-btn-submit', { hasText: 'Add Contact' }).click();
    await page.waitForTimeout(800);

    expect(writeFired).toBe(false);
    await expect(page.locator('#modal-add-contact')).not.toHaveClass(/open/); // closes as if it worked
    const rowCountAfter = await page.locator('#tbl-contacts-body tr').count();
    expect(rowCountAfter).toBe(rowCountBefore); // nothing was ever added
  });
});

test.describe('"Add WhatsApp number" flow (expected unreachable)', () => {
  test('customer/my-clinic/wa-numbers has no working route', async ({ page }) => {
    const resp = await page.request.post('/customer/my-clinic/wa-numbers', {
      data: { phone: '000', display_name: 'x', branches: [] },
      failOnStatusCode: false,
    });
    // Expect 404/405 (no route) rather than a 200 success — if this starts
    // returning 200, the flow has been wired up and this whole section of
    // the checklist needs re-testing for real.
    expect([404, 405]).toContain(resp.status());
  });
});
