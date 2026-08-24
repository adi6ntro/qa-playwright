import { test, expect } from '@playwright/test';
import { gotoMarketing } from '../../helpers/marketing';

/**
 * Covers docs/handover/QA_Checklist_Inbox_Marketing_WhatsApp.md Sections F-H
 * (MKT-CAM-*, MKT-SEG-*, MKT-C-04/05, WA-NUM-*).
 *
 * These are NOT bug reports about missing wiring — they document real,
 * loaded, fully-clickable UI (bulk-campaign.js / create-segment.js / the
 * Add-Contact modal's own inline script ARE all loaded, confirmed by reading
 * every one of them start to finish) that simply never calls a backend, or
 * in Segments' case has a primary action button with literally no click
 * handler anywhere in the codebase. See the checklist doc's "Known
 * limitations" table for the exact file/line evidence behind each claim.
 *
 * If any assertion in this file starts FAILING, that means the behavior
 * described above has changed — stop and tell Adi before assuming it's safe
 * to test further (a wired campaign/segment send could now reach real
 * numbers/contacts).
 */

test.describe('Marketing — Campaigns tab (real wizard UI, simulated backend)', () => {
  test('MKT-CAM-04: completing the 5-step wizard fires no send request', async ({ page }) => {
    await gotoMarketing(page, 'campaigns');
    await expect(page.locator('#tbl-campaigns-body tr').first()).toBeVisible({ timeout: 20_000 });

    const startBtn = page.locator('a', { hasText: 'Start Campaign' }).first();
    test.skip((await startBtn.count()) === 0, 'No approved template available to open the campaign modal with.');

    let sendFired = false;
    page.on('request', (req) => {
      const url = req.url();
      if (/campaign|bulk|send/i.test(url) && req.method() !== 'GET') sendFired = true;
    });

    await startBtn.click();
    await expect(page.locator('#modal-bulk-campaign')).toHaveClass(/open/);

    // Walk all 5 steps via the real bkmNext()-driven wizard, exactly as a
    // user would, then click whatever the step-5 primary button is.
    for (let i = 0; i < 4; i++) {
      await page.locator('.bkm-btn-next').click();
      await page.waitForTimeout(200);
    }
    await page.locator('.bkm-btn-next').click(); // step 5's "Submit for approval" — bkmNext() no-ops here
    await page.waitForTimeout(1000);

    expect(sendFired).toBe(false); // confirmed: bkmNext() has no send path on any step, including the last
  });

  test('MKT-CAM-03: "Generate content" always returns the same canned text', async ({ page }) => {
    await gotoMarketing(page, 'campaigns');
    const startBtn = page.locator('a', { hasText: 'Start Campaign' }).first();
    test.skip((await startBtn.count()) === 0, 'No approved template available.');

    await startBtn.click();
    await expect(page.locator('#modal-bulk-campaign')).toHaveClass(/open/);

    const generateBtn = page.locator('button', { hasText: 'Generate' }).first();
    test.skip((await generateBtn.count()) === 0, 'Generate-content button not present on step 1 markup.');

    await generateBtn.click();
    await page.waitForTimeout(1500); // bkmGenerateContent()'s hardcoded 1s setTimeout
    const first = await page.locator('#bkm-content-text').inputValue();
    expect(first).toContain('20% off your dental checkup'); // the literal hardcoded string in bulk-campaign.js
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
