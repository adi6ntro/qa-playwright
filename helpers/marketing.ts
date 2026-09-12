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

/** Waits for the Segments tab's own list fetch (fetchMktSegments() in
 * marketing.js) to actually finish populating `window.MKT_SEGMENTS`, rather
 * than the tab container merely being visible — `gotoMarketing()` only
 * confirms `#tab-segments` is on screen, which happens before that XHR
 * resolves. A row count read right after `gotoMarketing()` with no further
 * wait can catch the transient "No segments yet" placeholder row (rendered
 * whenever `MKT_SEGMENTS` is still `[]`) instead of the real list — live-
 * caught 2026-09-12 in MKT-SEG-08 once clinic 611 had enough segments for the
 * fetch to take a moment. Clinic 611 always has at least one real segment in
 * practice, so `.length > 0` is a safe wait condition here. */
export async function waitForSegmentsListLoaded(page: Page) {
  await page.waitForFunction(() => Array.isArray((window as any).MKT_SEGMENTS) && (window as any).MKT_SEGMENTS.length > 0);
}

/** Opens an existing segment's row "Edit" link — scoped by the segment's
 * current name so it targets the right row regardless of list order.
 * `openEditSegment()` (create-segment.js) fires two independent GETs — plain
 * segment detail (criteria/keep_updating) AND `/contacts` (the member list,
 * wired 2026-09-12 — previously the edit modal never fetched this at all, so
 * it showed a count with an empty list beneath it). Both are awaited here so
 * a caller asserting on the modal's rendered contact list never races either
 * request. Returns `{ detailResp, contactsResp }` — MKT-SEG-08 (pre-2026-09-12)
 * ignores the return value entirely, so widening it here is safe. */
export async function openEditSegment(page: Page, segmentName: string) {
  const row = page.locator('#tbl-segments-body tr', { hasText: segmentName });
  const [detailResp, contactsResp] = await Promise.all([
    page.waitForResponse((r) => /\/segments\/\d+$/.test(r.url()) && r.request().method() === 'GET'),
    page.waitForResponse((r) => /\/segments\/\d+\/contacts$/.test(r.url()) && r.request().method() === 'GET'),
    row.locator('a', { hasText: 'Edit' }).click(),
  ]);
  await expect(page.locator('#modal-create-segment')).toHaveClass(/open/);
  return { detailResp, contactsResp };
}

/** Clicks a segment row's "Send Campaign" link. As of 2026-09-13 this just
 * switches to the Campaigns tab (switchTab('campaigns') in marketing.blade.php)
 * rather than opening the bulk-campaign wizard directly with this segment
 * pre-selected — that pre-select shortcut (bulk-campaign.js's
 * openBulkModalForSegment) is unused now, kept only for a possible future
 * "send straight from Segments" flow. Picking a segment as a campaign's
 * audience is now a generic picker inside the Campaigns tab's own wizard —
 * see `bkmSelectSegmentFromPicker` covered by MKT-CAM-06 in
 * 03-marketing-campaigns-stub.spec.ts (or wherever that test lives). */
export async function clickSendCampaignForSegment(page: Page, segmentName: string) {
  const row = page.locator('#tbl-segments-body tr', { hasText: segmentName });
  await row.locator('a', { hasText: 'Send Campaign' }).click();
  await expect(page.locator('#tab-campaigns')).toHaveClass(/active/);
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
