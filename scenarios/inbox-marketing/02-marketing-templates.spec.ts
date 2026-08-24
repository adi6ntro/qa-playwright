import { test, expect } from '@playwright/test';
import { gotoMarketing, openCreateTemplate, fillTemplateForm } from '../../helpers/marketing';

/**
 * Covers docs/handover/QA_Checklist_Inbox_Marketing_WhatsApp.md Sections D-E
 * in reporty-web-backup — the parts of Marketing that are actually wired to
 * a backend (Templates CRUD, Contacts list). Campaigns/Segments are covered
 * separately in 03-marketing-campaigns-segments-stub.spec.ts because they're
 * expected to be UI-only right now.
 */

test.describe('Marketing — Templates', () => {
  test('templates tab loads existing templates', async ({ page }) => {
    await gotoMarketing(page, 'templates');
    // fetchMktTemplates() populates #tbl-templates-body on DOMContentLoaded
    await expect(page.locator('#tbl-templates-body tr').first()).toBeVisible({ timeout: 20_000 });
  });

  test('create template — name auto-normalizes and submit reaches approval modal', async ({ page }) => {
    await gotoMarketing(page, 'templates');
    await openCreateTemplate(page);

    // Unique name+body every run: Meta rejects resubmitting the same
    // name+content shortly after a prior create/delete of it (observed
    // empirically as error_subcode 2388023 — "similar content" family — when
    // this test reused a fixed literal name/body across repeated runs
    // against the shared sandbox). A fixed name is also just bad hygiene
    // for a test that runs against real, shared external state.
    const unique = Date.now();
    const rawName = `QA Test Template ${unique}!!`;
    const expectedName = `qa_test_template_${unique}`;
    await page.locator('#crt-name').fill(rawName);
    await expect(page.locator('#crt-name')).toHaveValue(expectedName);

    // Meta also rejects templates where a variable opens/closes the body, or
    // where variables are too dense relative to surrounding static text
    // (error subcodes 2388299 / 2388293 respectively — confirmed empirically
    // against the real sandbox, see checklist doc Section D note). Keep this
    // body generously wrapped in static text so the test exercises the happy
    // path, not Meta's template-quality rejection path.
    const bodyText = `Hi {{1}}, this is a friendly reminder (ref ${unique}) that your appointment at our clinic is scheduled for {{2}}. Please arrive 10 minutes early. Thank you!`;
    await page.locator('#crt-body').fill(bodyText);
    await expect(page.locator('#crt-examples-wrap')).toBeVisible();
    await expect(page.locator('#crt-examples-inputs input')).toHaveCount(2);
    await page.locator('#crt-examples-inputs input').nth(0).fill('Ahmad');
    await page.locator('#crt-examples-inputs input').nth(1).fill('Monday, 10 AM');

    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/templates') && r.request().method() === 'POST'),
      page.locator('.crt-btn-submit', { hasText: 'Submit for approval' }).click(),
    ]);
    expect(resp.ok()).toBeTruthy();
    await expect(page.locator('#modal-submitted-approval')).toHaveClass(/open/);

    // Clean up — this suite shouldn't leave junk templates in the shared
    // sandbox behind for other testers.
    const csrf = await page.evaluate(() => (window as any).MKT_CONFIG?.csrf);
    await page.request.delete(`/customer/marketing/templates/${encodeURIComponent(expectedName)}`, {
      headers: { 'X-CSRF-TOKEN': csrf },
    });
  });

  test('delete confirmation prompt appears before deleting', async ({ page }) => {
    await gotoMarketing(page, 'templates');
    await expect(page.locator('#tbl-templates-body tr').first()).toBeVisible({ timeout: 20_000 });

    page.once('dialog', async (dialog) => {
      expect(dialog.message()).toContain('permanent');
      await dialog.dismiss(); // don't actually delete real sandbox data in this smoke test
    });
    await page.locator('.mkt-action-grey', { hasText: 'Delete' }).first().click();
  });

  test('search filters the templates table client-side', async ({ page }) => {
    await gotoMarketing(page, 'templates');
    await expect(page.locator('#tbl-templates-body tr').first()).toBeVisible({ timeout: 20_000 });
    const totalRows = await page.locator('#tbl-templates-body tr').count();

    await page.locator('#template-search').fill('zzz_no_template_should_match_zzz');
    const visibleAfter = await page.locator('#tbl-templates-body tr:visible').count();
    expect(visibleAfter).toBe(0);
    expect(totalRows).toBeGreaterThan(0); // sanity: there was something to filter
  });
});

test.describe('Marketing — Contacts', () => {
  test('contacts tab loads and "Open chat" links to Inbox', async ({ page }) => {
    await gotoMarketing(page, 'contacts');
    await expect(page.locator('#tbl-contacts-body tr').first()).toBeVisible({ timeout: 20_000 });

    const firstLink = page.locator('#tbl-contacts-body a', { hasText: 'Open chat' }).first();
    const href = await firstLink.getAttribute('href');
    expect(href).toMatch(/^\/customer\/inbox#/);
  });
});
