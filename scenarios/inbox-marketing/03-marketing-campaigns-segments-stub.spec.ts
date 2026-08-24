import { test, expect } from '@playwright/test';
import { gotoMarketing } from '../../helpers/marketing';

/**
 * Covers docs/handover/QA_Checklist_Inbox_Marketing_WhatsApp.md Sections F-H.
 *
 * These are NOT bug reports — they document the current, expected-stub
 * state confirmed by reading the source (bulk-campaign.js / create-segment.js
 * are not <script>-included by marketing.blade.php, and there's no route
 * for customer/my-clinic/wa-numbers). If any assertion in this file starts
 * FAILING, that means the stub has become real — stop and tell Adi before
 * assuming it's safe to test further (it may now send to real numbers).
 */

test.describe('Marketing — Campaigns tab (expected shell only)', () => {
  test('"Start Campaign" opens the modal but fires no send request', async ({ page }) => {
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
    await page.waitForTimeout(1500);

    expect(sendFired).toBe(false); // bulk-campaign.js is not loaded — nothing should fire
  });
});

test.describe('Marketing — Segments tab (expected shell only)', () => {
  test('create-segment UI works but saves nothing server-side', async ({ page }) => {
    await gotoMarketing(page, 'segments');

    let writeFired = false;
    page.on('request', (req) => {
      if (req.method() !== 'GET' && /segment/i.test(req.url())) writeFired = true;
    });

    await page.locator('a', { hasText: '+ Create Segment' }).click();
    await expect(page.locator('#modal-create-segment')).toHaveClass(/open/);

    await page.locator('#sgm-input').fill("Patients who haven't come in for six months");
    // sgm-send-btn is only enabled by sgmInputChange(this) once text is present
    await page.waitForTimeout(300);
    const sendBtn = page.locator('#sgm-send-btn');
    if (await sendBtn.isEnabled()) await sendBtn.click();

    await page.waitForTimeout(1500);
    expect(writeFired).toBe(false); // create-segment.js is not loaded — this is client-side only
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
