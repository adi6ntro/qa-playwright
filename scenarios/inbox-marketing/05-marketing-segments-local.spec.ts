import { test, expect } from '@playwright/test';
import {
  gotoMarketing,
  openCreateSegment,
  openEditSegment,
  openSendCampaignForSegment,
  sendSegmentMessage,
  waitForSegmentsListLoaded,
} from '../../helpers/marketing';

/**
 * Agent Segments — 2026-09-10 features (Keep updating force-OFF for a
 * conversation-matched criterion, Send Campaign, Edit-in-place) that are NOT
 * yet deployed to dev.reporty.sa — split out of `04-marketing-segments.
 * spec.ts` (which stays dev.reporty.sa-safe) the same way ob4-crm-export's
 * own local-only tests live apart from the rest.
 *
 * Softer than ob4-local-guard.ts's hard file-load throw on purpose: these
 * tests don't touch shared, restart-requiring service state (nothing here
 * disrupts dev.reporty.sa for other testers if run there by mistake) — they
 * just don't exist there YET. So each test below `test.skip()`s itself
 * individually when BASE_URL isn't local, rather than the whole file
 * refusing to load — once this ships to dev.reporty.sa, delete this guard
 * (or move these tests back into 04-marketing-segments.spec.ts) instead of
 * carrying it forward as permanent scaffolding.
 *
 * Run via `npm run test:segments-local` — requires reporty-web-backup's
 * `php artisan serve` AND reporty-onboard-phase3's `.venv/bin/python app.py`
 * (port 9559) both running locally, plus the `ob4sa` local storage-state
 * (`npm run login-setup:local-ob4sa`) — see README's OB4 section.
 *
 * ⚠️ REAL LLM CALLS + fabrication risk — see 04-marketing-segments.spec.ts's
 * header for the full explanation; the same `test.skip()`-on-no-resolve
 * pattern is used below for the same reason.
 *
 * ⚠️ CLEANUP GAP — same as 04-marketing-segments.spec.ts: no delete-segment
 * endpoint exists yet, so these also use the `QA_PW_SEG_...` naming
 * convention for a future manual/scripted sweep.
 *
 * ⚠️ Cookies are domain-scoped, same as the ob4-crm-export suite (see
 * README's OB4 section) — a dev.reporty.sa session can't authenticate
 * against localhost. `test.use` below hard-points this file at the `ob4sa`
 * local storage state (`npm run login-setup:local-ob4sa` produces `auth/
 * .storage-state.ob4sa.local.json` — clinic 611, 88 real patients, Adi's
 * standing instruction 2026-09-10 for local testing, NOT the plain default
 * profile's clinic 440 — see project memory reference_local_test_clinic_611
 * .md), unconditionally — meaning this file will error on a missing file if
 * run without that setup done first, not gracefully skip. That's deliberate:
 * `npm run test:segments-local` is the only supported entry point for this
 * file, same posture as ob4-crm-export's own local-only specs.
 */

test.use({ storageState: 'auth/.storage-state.ob4sa.local.json' });

const BASE_URL = process.env.BASE_URL || '';
const IS_LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/i.test(BASE_URL);
const SKIP_REASON = `BASE_URL is not local (got ${BASE_URL || '(unset — defaults to https://dev.reporty.sa)'}) — ` +
  'these 2026-09-10 features are not deployed there yet. Run `npm run test:segments-local`.';

test.describe('Marketing — Segments: keep_updating, Send Campaign, Edit (LOCAL-ONLY, 2026-09-10 features)', () => {
  test('MKT-SEG-06: a conversation-matched criterion forces Keep updating OFF, even if the owner asked for ON', async ({ page }) => {
    test.skip(!IS_LOCAL, SKIP_REASON);
    // Needs the clinic to actually have WhatsApp chat history in GCS that
    // plausibly mentions something searchable — clinic 611's real chat
    // history is just QA greetings ("Pasien menyapa dengan kata 'halo'"),
    // no topical content, so this would otherwise always skip. Seeded a
    // dedicated QA fixture for this (2026-09-10, dev env only): patient
    // "QA_TEST_conversation_whitening" (patients.id=959, phone
    // 6281999888777) under user_id=611, a matching `log_patient_interaction`
    // row whose summary explicitly mentions whitening, and a GCS blob at
    // `dev/history_full/611/patient_6281999888777.json` (content is a plain
    // marker note — search_conversation_content only reads the blob's own
    // existence/mtime for bounding; the actual summary text it returns comes
    // from MySQL). Still skips honestly (not a false pass) if this fixture
    // is ever removed or the search genuinely finds nothing.
    test.setTimeout(180_000);
    const segmentName = `QA_PW_SEG_CONV_${Date.now()}`;

    await gotoMarketing(page, 'segments');
    await openCreateSegment(page);

    const searchResp = await sendSegmentMessage(page, 'Find patients who asked about whitening in their chats', 90_000);
    const searchBody = await searchResp.json();
    test.skip(
      !searchBody.resolve || searchBody.resolve.total === 0,
      'No conversation-matched candidates in this environment/clinic — cannot exercise this rule without real chat history.'
    );

    await page.locator('#sgm-name').fill(segmentName);
    await page.locator('#sgm-keep-updating').check(); // explicitly request ON
    const [saveResp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/segments/chat') && r.request().method() === 'POST', { timeout: 60_000 }),
      page.locator('#sgm-btn-create').click(),
    ]);
    let saveBody = await saveResp.json();
    if (!saveBody.save) {
      const confirmResp = await sendSegmentMessage(page, 'Yes, I confirm, please save it now, Keep updating ON.');
      saveBody = await confirmResp.json();
    }
    test.skip(!saveBody.save, 'Save never completed (fabrication risk) — rerun.');

    // save_segment() in segments.py forces this regardless of the ON request
    // and the UI toggle — 2026-09-10 decision (Adi): re-judging conversation
    // content on every future campaign send is unsafe to run unattended.
    expect(saveBody.save.keep_updating).toBe(false);
    expect(saveBody.save.keep_updating_forced_off).toBe(true);
  });

  test('MKT-SEG-07: "Send Campaign" resolves the segment\'s contacts and pre-selects it as the bulk-campaign audience', async ({ page }) => {
    test.skip(!IS_LOCAL, SKIP_REASON);
    test.setTimeout(180_000);
    const segmentName = `QA_PW_SEG_SEND_${Date.now()}`;

    await gotoMarketing(page, 'segments');
    await openCreateSegment(page);
    const resolveResp = await sendSegmentMessage(page, 'Patients whose last visit was after January 1, 2020');
    const resolveBody = await resolveResp.json();
    test.skip(!resolveBody.resolve, 'Resolve turn did not fire (fabrication risk) — rerun.');
    await page.locator('#sgm-name').fill(segmentName);
    const [createResp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/segments/chat') && r.request().method() === 'POST', { timeout: 60_000 }),
      page.locator('#sgm-btn-create').click(),
    ]);
    let saveBody = await createResp.json();
    if (!saveBody.save) {
      const confirmResp = await sendSegmentMessage(page, 'Yes, I confirm, please save it now.');
      saveBody = await confirmResp.json();
    }
    test.skip(!saveBody.save, 'Save never completed (fabrication risk) — rerun.');

    await page.reload();
    await gotoMarketing(page, 'segments');
    await expect(page.locator('#tbl-segments-body', { hasText: segmentName })).toBeVisible({ timeout: 20_000 });

    const contactsResp = await openSendCampaignForSegment(page, segmentName);
    expect(contactsResp.ok()).toBeTruthy();
    const contactsBody = await contactsResp.json();

    // The segment audience option lives on Step 3 (Audience) of the bulk
    // wizard, not Step 1 (Template) where openBulkModalForSegment() opens —
    // that's the real, correct flow (a segment still needs a template chosen
    // before its audience is confirmed), so it's genuinely not `visible` yet
    // here. Check the underlying state directly instead of requiring a full
    // template-creation walk through Steps 1-2 just to prove pre-selection —
    // toHaveClass/toContainText read the element's actual attributes/content
    // without needing it on-screen; only toBeVisible() needs that (and was
    // the wrong check here, live-caught 2026-09-10).
    const segOption = page.locator('.bkm-radio-option', { has: page.locator('#bkm-segment-name') });
    await expect(segOption).toHaveClass(/selected/);
    await expect(page.locator('#bkm-segment-name')).toContainText(segmentName);

    const bkmState = await page.evaluate(() => ({
      audience: (window as any)._bkmAudience,
      segmentName: (window as any)._bkmSegmentName,
      contactCount: ((window as any)._bkmSegmentContacts || []).length,
    }));
    expect(bkmState.audience).toBe('segment');
    expect(bkmState.segmentName).toBe(segmentName);
    expect(bkmState.contactCount).toBe((contactsBody.contacts || []).length);
  });

  test('MKT-SEG-08: "Edit" updates the segment in place — same row, not a duplicate', async ({ page }) => {
    test.skip(!IS_LOCAL, SKIP_REASON);
    test.setTimeout(240_000);
    const segmentName = `QA_PW_SEG_EDIT_${Date.now()}`;
    const editedName = `${segmentName}_edited`;

    await gotoMarketing(page, 'segments');
    await openCreateSegment(page);
    const resolveResp = await sendSegmentMessage(page, 'Patients whose last visit was after January 1, 2020');
    const resolveBody = await resolveResp.json();
    test.skip(!resolveBody.resolve, 'Resolve turn did not fire (fabrication risk) — rerun.');
    await page.locator('#sgm-name').fill(segmentName);
    const [createResp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/segments/chat') && r.request().method() === 'POST', { timeout: 60_000 }),
      page.locator('#sgm-btn-create').click(),
    ]);
    let saveBody = await createResp.json();
    if (!saveBody.save) {
      const confirmResp = await sendSegmentMessage(page, 'Yes, I confirm, please save it now.');
      saveBody = await confirmResp.json();
    }
    test.skip(!saveBody.save, 'Initial save never completed (fabrication risk) — rerun.');

    await page.reload();
    await gotoMarketing(page, 'segments');
    await waitForSegmentsListLoaded(page);
    const rowCountBefore = await page.locator('#tbl-segments-body tr').count();

    await openEditSegment(page, segmentName);
    await expect(page.locator('#sgm-title')).toHaveText('Edit Segment');
    // Pre-seeded context bubble (client-rendered, not sent to the LLM) shows
    // the OLD criteria before any new message is sent.
    await expect(page.locator('#sgm-chat')).toContainText('Editing');

    const editResolveResp = await sendSegmentMessage(page, 'Patients whose last visit was after January 1, 2024');
    const editResolveBody = await editResolveResp.json();
    test.skip(!editResolveBody.resolve, 'Edit-session resolve did not fire (fabrication risk) — rerun.');

    await page.locator('#sgm-name').fill(editedName);
    const [editSaveResp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/segments/chat') && r.request().method() === 'POST', { timeout: 60_000 }),
      page.locator('#sgm-btn-create').click(),
    ]);
    let editSaveBody = await editSaveResp.json();
    if (!editSaveBody.save) {
      const confirmResp = await sendSegmentMessage(page, 'Yes, I confirm, please save it now.');
      editSaveBody = await confirmResp.json();
    }
    test.skip(!editSaveBody.save, 'Edit save never completed (fabrication risk) — rerun.');

    expect(editSaveBody.save.success).toBe(true);
    expect(editSaveBody.save.segment_name).toBe(editedName);

    // The proof this was an UPDATE, not a duplicate INSERT: the list has the
    // SAME number of rows as before, now showing the new name, and the old
    // name is gone entirely (not present as a leftover second row).
    await page.reload();
    await gotoMarketing(page, 'segments');
    await expect(page.locator('#tbl-segments-body', { hasText: editedName })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#tbl-segments-body', { hasText: segmentName, hasNotText: editedName })).toHaveCount(0);
    await waitForSegmentsListLoaded(page);
    const rowCountAfter = await page.locator('#tbl-segments-body tr').count();
    expect(rowCountAfter).toBe(rowCountBefore);
  });

  test('MKT-SEG-09: Edit modal shows the full contact list, list↔edit count matches, and "Preview all" un-truncates the chat sample (2026-09-12 fixes)', async ({ page }) => {
    test.skip(!IS_LOCAL, SKIP_REASON);
    test.setTimeout(240_000);
    const segmentName = `QA_PW_SEG_FULLIST_${Date.now()}`;

    // Same broad criteria as MKT-SEG-07/08 — known to resolve well over the
    // chat sample's 5-row cap in clinic 611 (~83 in earlier manual testing),
    // which is exactly what's needed to exercise "Preview all" meaningfully.
    await gotoMarketing(page, 'segments');
    await openCreateSegment(page);
    const resolveResp = await sendSegmentMessage(page, 'Patients whose last visit was after January 1, 2020');
    const resolveBody = await resolveResp.json();
    test.skip(!resolveBody.resolve, 'Resolve turn did not fire (fabrication risk) — rerun.');
    const resolve = resolveBody.resolve;
    test.skip(
      !(resolve.set_ref && resolve.total > (resolve.rows || []).length),
      `Resolved total (${resolve.total}) doesn't exceed the sample size — "Preview all" wouldn't appear, nothing to exercise.`
    );

    // Bug #2 (2026-09-12): find_matching_patients caps `rows` at 5 regardless
    // of `total` — "Preview all" was dead markup with no id/handler at all
    // before this fix, so the button not existing/appearing is exactly the
    // regression this guards against.
    const previewBtn = page.locator('#sgm-btn-preview');
    await expect(previewBtn).toBeVisible();
    const sampleRowCount = await page.locator('#sgm-contact-list .sgm-contact-row').count();
    expect(sampleRowCount).toBe((resolve.rows || []).length);
    expect(sampleRowCount).toBeLessThan(resolve.total);

    const [previewResp] = await Promise.all([
      page.waitForResponse((r) => /\/segments\/preview\/[^/?]+$/.test(r.url()) && r.request().method() === 'GET'),
      previewBtn.click(),
    ]);
    expect(previewResp.ok()).toBeTruthy();
    const previewBody = await previewResp.json();
    expect(previewBody.total).toBe(resolve.total);
    await expect(page.locator('#sgm-contact-list .sgm-contact-row')).toHaveCount(resolve.total);
    await expect(previewBtn).toBeHidden();

    // Save it, then compare list↔edit-modal counts.
    await page.locator('#sgm-name').fill(segmentName);
    const [createResp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/segments/chat') && r.request().method() === 'POST', { timeout: 60_000 }),
      page.locator('#sgm-btn-create').click(),
    ]);
    let saveBody = await createResp.json();
    if (!saveBody.save) {
      const confirmResp = await sendSegmentMessage(page, 'Yes, I confirm, please save it now.');
      saveBody = await confirmResp.json();
    }
    test.skip(!saveBody.save, 'Save never completed (fabrication risk) — rerun.');

    await page.reload();
    await gotoMarketing(page, 'segments');
    await expect(page.locator('#tbl-segments-body', { hasText: segmentName })).toBeVisible({ timeout: 20_000 });

    // Bug #3 (2026-09-12): the list's count came from `segments.resolved_count`
    // — a snapshot written once at save time and never refreshed afterward
    // (confirmed: nothing in either repo's cron/scheduler touches that
    // column) — so it could silently drift from live membership. Reading it
    // straight from MKT_SEGMENTS (not scraping DOM text) since the row markup
    // has no stable selector for the count cell (marketing.js's
    // renderSegmentsTab just emits a bare `.font-bold` td).
    const listedSegment = await page.evaluate((name) => {
      const list = (window as any).MKT_SEGMENTS || [];
      return list.find((s: any) => s.name === name);
    }, segmentName);
    expect(listedSegment).toBeTruthy();

    // Bug #1 (2026-09-12): openEditSegment() only ever fetched segmentDetail
    // (criteria/keep_updating) — the contact list stayed empty under a
    // correct-looking count. Now it also fetches segmentContacts(), which for
    // a keep_updating=ON segment re-resolves live (same call the list's own
    // count now uses, per the Bug #3 fix), so these two numbers must agree.
    const { contactsResp } = await openEditSegment(page, segmentName);
    const contactsBody = await contactsResp.json();
    expect(listedSegment.contact_count).toBe(contactsBody.total);
    expect(contactsBody.total).toBeGreaterThan(5); // needed for the sample/expand check below to mean anything
    await expect(page.locator('#sgm-contacts-count')).toContainText(String(contactsBody.total));

    // Follow-up (2026-09-12, same day): showing all of segmentContacts()'s
    // (already-unpaginated) rows immediately on open was overwhelming for a
    // large segment — now Edit shows a 5-row sample too, with "Preview all"
    // expanding it. Unlike the chat-resolve flow, the expand is local (the
    // full list is already in memory from the fetch above) — clicking it
    // must NOT fire a second network request.
    await expect(page.locator('#sgm-contact-list .sgm-contact-row')).toHaveCount(5);
    await expect(previewBtn).toBeVisible();

    let secondRequestFired = false;
    const onRequest = (r: import('@playwright/test').Request) => {
      if (/\/segments\/(preview|\d+\/contacts)\//.test(r.url()) || /\/segments\/\d+\/contacts$/.test(r.url())) secondRequestFired = true;
    };
    page.on('request', onRequest);
    await previewBtn.click();
    await expect(page.locator('#sgm-contact-list .sgm-contact-row')).toHaveCount(contactsBody.total);
    await expect(previewBtn).toBeHidden();
    page.off('request', onRequest);
    expect(secondRequestFired).toBe(false);

    // Negative case for MKT-SEG-12's warning check: a structured-only
    // segment (no conversation_content_matched criterion) must NOT show it.
    await expect(page.locator('#sgm-warning')).toBeHidden();
  });

  // MKT-SEG-10/11 below deliberately never touch the bulk-campaign wizard —
  // see 03-marketing-campaigns-stub.spec.ts's safety note: every wizard
  // button past Step 1 shares `.bkm-btn-next`, and bkmGetContacts() falls
  // back to a hardcoded list with real phone numbers, so anything beyond
  // Step 1 there is manual-only. These stay entirely inside the Segments
  // modal instead.

  test('MKT-SEG-10: "Preview all" with an expired/invalid set_ref shows an error and recovers, without corrupting the visible sample', async ({ page }) => {
    test.skip(!IS_LOCAL, SKIP_REASON);
    test.setTimeout(120_000);

    await gotoMarketing(page, 'segments');
    await openCreateSegment(page);
    const resolveResp = await sendSegmentMessage(page, 'Patients whose last visit was after January 1, 2020');
    const resolveBody = await resolveResp.json();
    test.skip(!resolveBody.resolve, 'Resolve turn did not fire (fabrication risk) — rerun.');
    const resolve = resolveBody.resolve;
    test.skip(
      !(resolve.set_ref && resolve.total > (resolve.rows || []).length),
      `Resolved total (${resolve.total}) doesn't exceed the sample size — "Preview all" wouldn't appear, nothing to exercise.`
    );

    const previewBtn = page.locator('#sgm-btn-preview');
    await expect(previewBtn).toBeVisible();
    const sampleCountBefore = await page.locator('#sgm-contact-list .sgm-contact-row').count();

    // Simulates the real 30-minute agent_set_refs TTL expiry (resolve_set_ref
    // returns None for an unknown/expired id) without an actual 30-min wait —
    // corrupt only the client-held set_ref, nothing else about the page state.
    await page.evaluate(() => { (window as any)._sgmLastResolve.set_ref = 'expired-or-bogus-set-ref'; });

    const [previewResp] = await Promise.all([
      page.waitForResponse((r) => /\/segments\/preview\/[^/?]+$/.test(r.url()) && r.request().method() === 'GET'),
      previewBtn.click(),
    ]);
    expect(previewResp.ok()).toBeFalsy();

    await expect(page.locator('#bkm-snackbar')).toContainText('Could not load the full list');
    await expect(previewBtn).toBeEnabled();
    await expect(previewBtn).toHaveText('Preview all');
    // A failed preview must never blank out or partially overwrite the
    // 5-row sample that was already working.
    await expect(page.locator('#sgm-contact-list .sgm-contact-row')).toHaveCount(sampleCountBefore);
  });

  test('MKT-SEG-11: a criteria description matching 0 patients shows an honest empty result, not a crash', async ({ page }) => {
    test.skip(!IS_LOCAL, SKIP_REASON);
    test.setTimeout(120_000);

    await gotoMarketing(page, 'segments');
    await openCreateSegment(page);
    const resolveResp = await sendSegmentMessage(page, 'Patients whose last visit was after January 1, 2099');
    const resolveBody = await resolveResp.json();
    test.skip(!resolveBody.resolve, 'Resolve turn did not fire (fabrication risk) — rerun.');
    test.skip(
      resolveBody.resolve.total !== 0,
      `Criteria matched ${resolveBody.resolve.total} patients instead of 0 — pick a further-future date and rerun.`
    );

    await expect(page.locator('#sgm-contacts-count')).toContainText('0 contacts suggested');
    await expect(page.locator('#sgm-contact-list .sgm-contact-row')).toHaveCount(0);
    // Nothing to preview when the sample already IS the full (empty) result.
    await expect(page.locator('#sgm-btn-preview')).toBeHidden();
    // The rest of the modal must stay usable, not stuck/broken by a
    // zero-row result — observed actual behavior: save is NOT blocked on a
    // 0-contact resolve (no code path disables it for total===0), which this
    // asserts as current behavior rather than a should/shouldn't.
    await expect(page.locator('#sgm-name-row')).toBeVisible();
    await expect(page.locator('#sgm-btn-create')).toBeEnabled();
  });

  test('MKT-SEG-12: Edit modal shows the conversation-match accuracy warning for a saved conversation-criteria segment (2026-09-12)', async ({ page }) => {
    test.skip(!IS_LOCAL, SKIP_REASON);
    test.setTimeout(60_000);

    // Reuses whatever QA_PW_SEG_CONV_* segment already exists from earlier
    // MKT-SEG-06 runs, rather than creating a new one via chat — this is
    // purely about openEditSegment()'s own rendering, no LLM call needed.
    // Every one of these is always frozen (conversation criteria forces
    // keep_updating=False, see MKT-SEG-06), so this also exercises the
    // warning specifically in the keep_updating=OFF/Edit path.
    await gotoMarketing(page, 'segments');
    await waitForSegmentsListLoaded(page);
    const conversationSegment = await page.evaluate(() => {
      const list = (window as any).MKT_SEGMENTS || [];
      return list.find((s: any) => /QA_PW_SEG_CONV_/.test(s.name));
    });
    test.skip(!conversationSegment, 'No existing conversation-criteria segment in this environment to edit — run MKT-SEG-06 first.');

    await openEditSegment(page, conversationSegment.name);
    await expect(page.locator('#sgm-warning')).toBeVisible();
    await expect(page.locator('#sgm-warning')).toContainText('matched on conversation content');
  });
});
