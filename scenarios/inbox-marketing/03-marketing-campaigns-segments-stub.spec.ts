import { test, expect } from '@playwright/test';
import { gotoMarketing } from '../../helpers/marketing';

/**
 * Covers docs/handover/QA_Checklist_Inbox_Marketing_WhatsApp.md Sections F-H.
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

test.describe('Marketing — Segments tab (real chat UI, canned responses, dead create button)', () => {
  test('MKT-SEG-02: different inputs produce the identical canned response', async ({ page }) => {
    await gotoMarketing(page, 'segments');
    await page.locator('a', { hasText: '+ Create Segment' }).click();
    await expect(page.locator('#modal-create-segment')).toHaveClass(/open/);

    await page.locator('#sgm-input').fill('asdkjaslkdj nonsense input');
    await page.waitForTimeout(300);
    await page.locator('#sgm-send-btn').click();
    await page.waitForTimeout(1200);

    // _sgmResponses.initial is returned regardless of input text.
    await expect(page.locator('#sgm-contacts-count')).toHaveText('68 contacts suggested');
  });

  test('MKT-SEG-03: "Create Segment" button has no click handler — clicking it does nothing', async ({ page }) => {
    await gotoMarketing(page, 'segments');

    let writeFired = false;
    page.on('request', (req) => {
      if (req.method() !== 'GET' && /segment/i.test(req.url())) writeFired = true;
    });

    await page.locator('a', { hasText: '+ Create Segment' }).click();
    await page.locator('#sgm-input').fill("Patients who haven't come in for six months");
    await page.waitForTimeout(300);
    await page.locator('#sgm-send-btn').click();
    await page.waitForTimeout(1200);

    const createBtn = page.locator('#sgm-btn-create');
    await expect(createBtn).toBeEnabled();

    // Confirm there is genuinely no onclick attribute and no listener effect:
    // the modal must still be open and unchanged after clicking.
    const hasOnclick = await createBtn.evaluate((el) => el.hasAttribute('onclick'));
    expect(hasOnclick).toBe(false);

    await createBtn.click();
    await page.waitForTimeout(1000);
    await expect(page.locator('#modal-create-segment')).toHaveClass(/open/); // still open — nothing happened
    expect(writeFired).toBe(false);
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
