import type { Page } from '@playwright/test';
import {
  sendAndConfirm,
  getInstructionPanelState,
  gotoAiInstructionStep,
  type InstructionPanelState,
} from './maha-chat';

/**
 * Automates the "5-phase probe" methodology from
 * ../../reporty-onboard-phase3/QA_Prompt_BUG005_False_Success_Writes.md
 * against the real AI Instructions panel — the one write surface with a
 * confirmed, live DOM signal independent of anything Maha claims in chat
 * (see helpers/maha-chat.ts's getInstructionPanelState).
 *
 * Phase 2 (immediate read) is Maha's OWN chat read-back, per the runbook's
 * literal spec — it tests whether the agent's own read tool reflects its own
 * write, a different failure mode from replica lag. Phase 3 (delayed read)
 * bypasses Maha entirely: hard refresh, wait 10s, read the live panel. That's
 * the ground-truth signal the whole probe exists to get.
 *
 * Result-code precedence when a retry happens: RETRY_DUPLICATE/RETRY_SINGLE
 * (the Phase 5 duplicate-count verdict) is used as the FINAL code even if
 * Phase 3 already showed DELAYED_CONVERGENCE — the retry's duplicate-or-not
 * outcome is strictly more diagnostic (it's what actually happens when a real
 * user, unaware of the 10s convergence window, retries). FALSE_SUCCESS_LAG /
 * FALSE_SUCCESS_TRUE_FAIL are only the FINAL code for remove-type scenarios,
 * where "duplicate row" isn't a meaningful concept (see expectPresent=false
 * branch below).
 */

export type BugResultCode =
  | 'CLEAN'
  | 'FALSE_SUCCESS_LAG'
  | 'FALSE_SUCCESS_TRUE_FAIL'
  | 'RETRY_DUPLICATE'
  | 'RETRY_SINGLE'
  | 'UNABLE_TO_TEST';

export interface ScenarioRecord {
  id: string;
  tool: string;
  trigger: string;
  resultCode: BugResultCode;
  retryNeeded: boolean;
  duplicateOnRetry: 'Y' | 'N' | 'NA';
  convergenceDelayMs?: number;
  marker?: string; // lets a later scenario (T12) look up which marker to re-check
  evidence: string;
}

/** Runbook Phase 3, verbatim: hard-refresh, wait 10s, read the panel — no Maha involved. */
export async function phase3DelayedRead(page: Page): Promise<InstructionPanelState> {
  await page.reload();
  await gotoAiInstructionStep(page);
  await page.waitForTimeout(10_000);
  return getInstructionPanelState(page);
}

/**
 * Wizard step 0 ("social-media"), where the Instagram field lives —
 * confirmed against source, not guessed:
 *   - social-media.blade.php:2876-2878: `stepHashes[0] = 'social-media'`, and
 *     with NO hash present `currentStep` already defaults to 0 — so this is
 *     an even simpler case than gotoAiInstructionStep's step-2 navigation
 *     (no translated-caption fallback needed; loading the bare hash IS the
 *     default path the wizard's own init code takes).
 *   - social-media.blade.php:39: `<input id="instagram_connect" ...
 *     value="{{ $myClinic['instagram_link'] ?? '' }}">` — server-rendered on
 *     each full page load, which is exactly why a hard refresh (not a live
 *     DOM re-read) is what proves the DB value, matching this probe's Phase 3.
 */
export async function gotoSocialMediaStep(page: Page): Promise<void> {
  // Strategy 1: direct hash load. Per the wizard script, no hash present
  // should already default currentStep to 0 (social-media).
  await page.goto('/customer/my-clinic#social-media');
  let gotThere = await page
    .locator('#instagram_connect')
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (gotThere) return;

  // Strategy 2: click the real step-0 tab. Its caption IS translated
  // (`$translation['home/m-clinic/social-media'][...]`, unlike step 2's
  // hardcoded "AI Instruction"), so match by position instead of text —
  // `renderStepIndicators()` appends one `.wizard-tab` per step in the
  // fixed `steps` array order, so the first one is always step 0.
  await page
    .locator('#wizardSteps .wizard-tab')
    .first()
    .click()
    .catch(() => {});
  gotThere = await page
    .locator('#instagram_connect')
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);

  if (!gotThere) {
    throw new Error(
      'Could not reach the social-media wizard step (#instagram_connect never became visible), ' +
        'even after clicking the first #wizardSteps .wizard-tab. Either the markup changed since this ' +
        'was written (re-check social-media.blade.php around line 2870-2878 and the #instagram_connect ' +
        'input around line 39), or the account landed on an unexpected page (e.g. a relogin prompt — ' +
        'check auth/.storage-state.json is still fresh).'
    );
  }
}

/** Reads the live Instagram field value — used for T5's Phase 3 ground-truth check. */
export async function readInstagramField(page: Page): Promise<string> {
  return page.locator('#instagram_connect').inputValue();
}

/**
 * Retargeting discount %, for T7. Confirmed against source:
 *   - Retarget.blade.php:224/306: `<a id="btn_settings" onclick="update()">`
 *     opens the settings overlay (two copies in the markup, desktop/mobile —
 *     `.first()` is enough, only one is ever actually visible/clickable).
 *   - modal-setting.blade.php:32: `<div id="setting-action" class="subscribe-overlay"
 *     style="display:none;...">` — the overlay `update()` shows via jQuery `.show()`.
 *   - modal-setting.blade.php:134-139: `<input id="discount" name="discount"
 *     value="{{ $retarget->discount ?? 0 }}">` — server-rendered ground truth.
 *     Its wrapper `#discount_input` (line 130) is itself `display:none` unless
 *     `is_discount` is checked — reading via `.inputValue()` still works on a
 *     hidden-but-attached input, which is all Phase 3 needs (no click required
 *     since the WRITE comes from Maha's chat tool, not from us driving the UI).
 */
export async function gotoRetargetSettings(page: Page): Promise<void> {
  await page.goto('/customer/retarget');
  await page.locator('#btn_settings').first().click();
  const gotThere = await page
    .locator('#discount')
    .waitFor({ state: 'attached', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!gotThere) {
    throw new Error(
      'Could not reach the retargeting settings panel (#discount never attached after clicking ' +
        '#btn_settings). Re-check Retarget.blade.php (button around line 224/306) and ' +
        'modal-setting.blade.php (#discount input around line 134-139).'
    );
  }
}

export async function readRetargetDiscount(page: Page): Promise<string> {
  return page.locator('#discount').inputValue();
}

/**
 * Report-branding "show mobile number" toggle, for T8. Confirmed against source:
 *   - myReport.blade.php:339: `<input type="checkbox" id="display_phone"
 *     onclick="checkContactMedia()" {{ ($template->display_phone ?? false) ? 'checked' : '' }}>`
 *   - Its wrapping `<div>` (line 338) has inline `style="display:none"` in the
 *     current markup, so it's not visibly clickable today — irrelevant here
 *     since only the checked STATE is read (ground truth after Maha's write),
 *     never clicked. `.isChecked()` reads the DOM property regardless of
 *     visibility.
 *   - Posted back as `display_phone` (0/1) to `POST /customer/my-report`
 *     (TemplateController::store, app/Http/Controllers/Front/TemplateController.php:233).
 */
export async function gotoMyReportSettings(page: Page): Promise<void> {
  await page.goto('/customer/my-report');
  const gotThere = await page
    .locator('#display_phone')
    .waitFor({ state: 'attached', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!gotThere) {
    throw new Error(
      'Could not reach the My Report settings page (#display_phone never attached). ' +
        'Re-check myReport.blade.php around line 339.'
    );
  }
}

export async function readDisplayPhoneChecked(page: Page): Promise<boolean> {
  return page.locator('#display_phone').isChecked();
}

/**
 * Deletion/absence phrases used ONLY for phase2's expectPresent=false check (see
 * runFivePhaseInstructionProbe below) — drawn from actual agent replies observed in
 * a real dev log (clinic 1352, 2026-08-04, BUG-005 QA run), not guessed. Covers the 3
 * languages this suite's replies are actually seen in.
 */
const ABSENCE_PHRASES = [
  // Arabic
  'لم تعد موجودة', 'تم حذفها', 'لا يوجد',
  // Indonesian
  'sudah tidak ada', 'sudah dihapus',
  // English
  'no longer exists', 'has been deleted', 'not found',
];

/**
 * Core probe for a single save/update/remove against the instructions list.
 *
 * @param marker          unique text fragment identifying this scenario's row
 *                         (e.g. "[BUG005_TEST_T1]")
 * @param expectPresent    true for save/update (row should EXIST after write),
 *                         false for remove (row should be GONE after write).
 *                         NOTE (T4 fix, 2026-08-06): for expectPresent=false, phase2's
 *                         check on the agent's CHAT REPLY is language-pattern-based
 *                         (see ABSENCE_PHRASES above), not pure marker-absence — a
 *                         correct "no longer exists / already deleted" reply
 *                         legitimately QUOTES the marker while confirming it's gone
 *                         (e.g. "`[MARKER]` لم تعد موجودة... تم حذفها"), so naive
 *                         substring absence misread that honest reply as a write
 *                         failure. Live-reproduced exactly this way (T4, clinic 1352,
 *                         2026-08-04) — a real backend write that succeeded in 8s was
 *                         reported as FALSE_SUCCESS_LAG purely because of this false
 *                         negative. Phase3 (real panel row text, checked below) has no
 *                         such negation framing — plain substring match stays correct
 *                         there, and for the expectPresent=true case in both phases.
 */
export async function runFivePhaseInstructionProbe(
  page: Page,
  opts: {
    id: string;
    tool: string;
    writeTrigger: string;
    readTrigger: string;
    marker: string;
    expectPresent: boolean;
  }
): Promise<ScenarioRecord> {
  const matches = (text: string) => text.includes(opts.marker);
  const impliesAbsence = (text: string) => ABSENCE_PHRASES.some((phrase) => text.includes(phrase));

  // Phase 1 — WRITE.
  const writeAt = Date.now();
  const { replies: writeReplies, confirmRoundsNeeded: writeConfirmRounds } = await sendAndConfirm(
    page,
    opts.writeTrigger
  );
  const writeReply = writeReplies[writeReplies.length - 1].text;

  // Phase 2 — IMMEDIATE READ (same-turn chat read-back, per runbook).
  const { replies: readReplies } = await sendAndConfirm(page, opts.readTrigger);
  const readReply = readReplies[readReplies.length - 1].text;
  const phase2Reflects = opts.expectPresent ? matches(readReply) : impliesAbsence(readReply);

  // Phase 3 — DELAYED READ (hard refresh + 10s, real panel, bypasses Maha).
  const phase3State = await phase3DelayedRead(page);
  const phase3HasRow = phase3State.rows.some((r) => matches(r.text));
  const phase3Reflects = opts.expectPresent ? phase3HasRow : !phase3HasRow;

  const baseEvidence = [
    `write_reply="${writeReply}"`,
    `write_confirm_rounds_needed=${writeConfirmRounds}`,
    `phase2_read_reply="${readReply}"`,
    `phase2_reflects_write=${phase2Reflects}`,
    `phase3_panel_after_refresh=[${phase3State.rows.map((r) => r.text).join(' | ')}]`,
    `phase3_reflects_write=${phase3Reflects}`,
  ];

  if (phase2Reflects && phase3Reflects) {
    return {
      id: opts.id,
      tool: opts.tool,
      trigger: opts.writeTrigger,
      resultCode: 'CLEAN',
      retryNeeded: false,
      duplicateOnRetry: 'NA',
      marker: opts.marker,
      evidence: baseEvidence.join(' | '),
    };
  }

  // Phase 4 — RETRY (phase 2 or phase 3 showed the write missing).
  const preRetryVerdict: BugResultCode = phase3Reflects ? 'FALSE_SUCCESS_LAG' : 'FALSE_SUCCESS_TRUE_FAIL';
  const retryAt = Date.now();
  const { replies: retryReplies, confirmRoundsNeeded: retryConfirmRounds } = await sendAndConfirm(
    page,
    opts.writeTrigger
  );
  const retryReply = retryReplies[retryReplies.length - 1].text;

  // Phase 5 — DUPLICATE CHECK (only meaningful for save/update, where a
  // second successful write would show up as a second row).
  const afterRetryState = await phase3DelayedRead(page);
  const matchCount = afterRetryState.rows.filter((r) => matches(r.text)).length;

  const resultCode: BugResultCode = opts.expectPresent
    ? matchCount >= 2
      ? 'RETRY_DUPLICATE'
      : 'RETRY_SINGLE'
    : preRetryVerdict; // remove-type: "duplicate row" doesn't apply, keep the phase2/3 classification

  const duplicateOnRetry: 'Y' | 'N' | 'NA' = opts.expectPresent ? (matchCount >= 2 ? 'Y' : 'N') : 'NA';

  return {
    id: opts.id,
    tool: opts.tool,
    trigger: opts.writeTrigger,
    resultCode,
    retryNeeded: true,
    duplicateOnRetry,
    convergenceDelayMs: phase3Reflects ? retryAt - writeAt : undefined,
    marker: opts.marker,
    evidence: [
      ...baseEvidence,
      `retry_gap_ms=${retryAt - writeAt}`,
      `retry_confirm_rounds_needed=${retryConfirmRounds}`,
      `retry_reply="${retryReply}"`,
      `after_retry_marker_count=${matchCount}`,
    ].join(' | '),
  };
}

/**
 * Deletes every row matching `marker` and keeps retrying until a hard-refresh
 * read confirms it's actually gone — cleanup is a write too, so it's subject
 * to the exact same intermittent-failure behavior this probe exists to catch
 * (observed convergence delays in real runs ranged 34s-120s; a single
 * delete-and-check, as T10/T11's cleanup used to do, left leftover markers
 * behind in 3 out of the last 3 runs and blocked the next run's baseline
 * check). Escalating wait between attempts mirrors that observed range.
 */
export async function deleteMarkerUntilGone(
  page: Page,
  marker: string,
  opts: { maxAttempts?: number } = {}
): Promise<{ success: boolean; attempts: number }> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const extraWaitMs = [0, 30_000, 60_000];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const state = await getInstructionPanelState(page);
    if (!state.rows.some((r) => r.text.includes(marker))) {
      return { success: true, attempts: attempt - 1 };
    }

    await sendAndConfirm(page, `احذفي القاعدة اللي فيها كلمة ${marker}`);
    await page.waitForTimeout(extraWaitMs[Math.min(attempt - 1, extraWaitMs.length - 1)]);

    const after = await phase3DelayedRead(page);
    if (!after.rows.some((r) => r.text.includes(marker))) {
      return { success: true, attempts: attempt };
    }
  }
  return { success: false, attempts: maxAttempts };
}

/**
 * T10 — rapid-fire stress probe: fires N saves back-to-back (no settling
 * time between them, unlike the sequential probe above), then runs Phase 3/4/5
 * collectively across all markers, per the runbook's own instruction
 * ("Then run all 5 phases collectively").
 */
export async function runRapidFireProbe(
  page: Page,
  opts: { id: string; tool: string; markers: string[]; writeTriggers: string[] }
): Promise<ScenarioRecord> {
  const writeAt = Date.now();
  const claims: string[] = [];
  const confirmRounds: number[] = [];
  for (const trigger of opts.writeTriggers) {
    const { replies, confirmRoundsNeeded } = await sendAndConfirm(page, trigger);
    claims.push(replies[replies.length - 1].text);
    confirmRounds.push(confirmRoundsNeeded);
  }
  const confirmRoundsNote = opts.markers
    .map((m, i) => `${m}:${confirmRounds[i]}`)
    .join(', ');

  const phase3State = await phase3DelayedRead(page);
  const persisted = opts.markers.filter((m) => phase3State.rows.some((r) => r.text.includes(m)));
  const allPersisted = persisted.length === opts.markers.length;

  if (allPersisted) {
    return {
      id: opts.id,
      tool: opts.tool,
      trigger: opts.writeTriggers.join(' ; '),
      resultCode: 'CLEAN',
      retryNeeded: false,
      duplicateOnRetry: 'NA',
      marker: opts.markers.join(','),
      evidence: `all ${opts.markers.length} rapid-fire saves persisted after hard refresh. confirm_rounds_needed=[${confirmRoundsNote}] claims=${claims.join(' || ')}`,
    };
  }

  // Retry only the ones that didn't stick.
  const missing = opts.markers.filter((m) => !persisted.includes(m));
  const retryAt = Date.now();
  const retryConfirmRounds: Record<string, number> = {};
  for (const m of missing) {
    const idx = opts.markers.indexOf(m);
    const { confirmRoundsNeeded } = await sendAndConfirm(page, opts.writeTriggers[idx]);
    retryConfirmRounds[m] = confirmRoundsNeeded;
  }
  const afterRetryState = await phase3DelayedRead(page);
  const dupCounts = opts.markers.map((m) => afterRetryState.rows.filter((r) => r.text.includes(m)).length);
  const anyDuplicate = dupCounts.some((c) => c >= 2);
  const stillMissing = dupCounts.some((c) => c === 0);

  return {
    id: opts.id,
    tool: opts.tool,
    trigger: opts.writeTriggers.join(' ; '),
    resultCode: anyDuplicate ? 'RETRY_DUPLICATE' : stillMissing ? 'FALSE_SUCCESS_TRUE_FAIL' : 'RETRY_SINGLE',
    retryNeeded: true,
    duplicateOnRetry: anyDuplicate ? 'Y' : 'N',
    marker: opts.markers.join(','),
    evidence:
      `initial_persisted=${persisted.length}/${opts.markers.length} (${persisted.join(', ')}) | ` +
      `confirm_rounds_needed=[${confirmRoundsNote}] | claims=${claims.join(' || ')} | retry_gap_ms=${retryAt - writeAt} | ` +
      `retry_confirm_rounds=${JSON.stringify(retryConfirmRounds)} | ` +
      `after_retry_counts=${opts.markers.map((m, i) => `${m}:${dupCounts[i]}`).join(', ')}`,
  };
}