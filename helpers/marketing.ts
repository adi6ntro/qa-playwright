import { Page, expect } from '@playwright/test';

/**
 * Selectors read from live source:
 * - resources/views/front/customer/Marketing/*.blade.php
 * - public/js/marketing/marketing.js
 */

export async function gotoMarketing(page: Page, tab: 'campaigns' | 'templates' | 'contacts' | 'segments' = 'templates') {
  await page.goto(`/customer/marketing?tab=${tab}`);
  await expect(page.locator(`#tab-${tab}`)).toBeVisible();
}

export async function openCreateTemplate(page: Page) {
  await page.locator('a', { hasText: '+ New Template' }).click();
  await expect(page.locator('#modal-choose-template')).toBeVisible();
  await page.locator('button', { hasText: '+ Create Template' }).click();
  await expect(page.locator('#modal-create-template')).toBeVisible();
}

export async function fillTemplateForm(page: Page, { name, body, category, language }: { name: string; body: string; category?: string; language?: string }) {
  await page.locator('#crt-name').fill(name);
  await page.locator('#crt-body').fill(body);
  if (category) await page.locator('#crt-category').selectOption(category);
  if (language) await page.locator('#crt-language').selectOption(language);
}

// ── Agent Segments (Marketing → Segments popup) ────────────────────────────
// segments_agent.py (reporty-onboard-phase3) is a real LLM call — every send
// below can take anywhere from a few seconds to ~20-30s, occasionally longer
// under Vertex load, so callers should give page.waitForResponse a generous
// timeout rather than relying on the global expect.timeout (15s).

export async function openCreateSegment(page: Page) {
  await page.locator('a', { hasText: '+ Create Segment' }).click();
  await expect(page.locator('#modal-create-segment')).toHaveClass(/open/);
}

/** Opens an existing segment's row "Edit" link — scoped by the segment's
 * current name so it targets the right row regardless of list order. */
export async function openEditSegment(page: Page, segmentName: string) {
  const row = page.locator('#tbl-segments-body tr', { hasText: segmentName });
  const [resp] = await Promise.all([
    page.waitForResponse((r) => /\/segments\/\d+$/.test(r.url()) && r.request().method() === 'GET'),
    row.locator('a', { hasText: 'Edit' }).click(),
  ]);
  await expect(page.locator('#modal-create-segment')).toHaveClass(/open/);
  return resp;
}

/** Opens an existing segment's row "Send Campaign" link — resolves that
 * segment's contacts (frozen → segment_frozen_members, dynamic → live OB3
 * resolve) and opens the bulk campaign modal with it pre-selected. */
export async function openSendCampaignForSegment(page: Page, segmentName: string) {
  const row = page.locator('#tbl-segments-body tr', { hasText: segmentName });
  const [resp] = await Promise.all([
    page.waitForResponse((r) => /\/segments\/\d+\/contacts$/.test(r.url()) && r.request().method() === 'GET'),
    row.locator('a', { hasText: 'Send Campaign' }).click(),
  ]);
  await expect(page.locator('#modal-bulk-campaign')).toHaveClass(/open/);
  return resp;
}

/** Fills the segment chat input and sends it, waiting for the real
 * POST /segments/chat round-trip (an actual LLM call) rather than a fixed
 * sleep. Returns the response so callers can also inspect its JSON body. */
export async function sendSegmentMessage(page: Page, text: string, timeout = 60_000) {
  await page.locator('#sgm-input').fill(text);
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/segments/chat') && r.request().method() === 'POST', { timeout }),
    page.locator('#sgm-send-btn').click(),
  ]);
  return resp;
}
